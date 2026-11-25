import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool } from './db.js';
import { connectionCa, tlsOptions } from './certificates.js';
import { decrypt, encrypt } from './crypto.js';
import { ValidationError, normalizeHost, splitHost } from './validation.js';

export const TLS_ERRORS = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Impossible de vérifier le premier certificat.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Certificat auto-signé.',
  SELF_SIGNED_CERT_IN_CHAIN: 'Certificat auto-signé dans la chaîne.',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'Émetteur du certificat inconnu.',
  CERT_HAS_EXPIRED: 'Certificat expiré.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'Le nom ou l\'adresse de l\'hôte ne figure pas dans le certificat.',
};

function xapiCall(conn, method, params) {
  const { hostname, port } = splitHost(conn.host);
  return new Promise((resolve, reject) => {
    if (conn.caError) {
      reject(new Error(conn.caError));
      return;
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = https.request(
      {
        hostname, port, path: '/jsonrpc', method: 'POST', ...tlsOptions(conn), timeout: 8000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (resp) => {
        let data = '';
        resp.on('data', (d) => (data += d));
        resp.on('end', () => {
          let j;
          try {
            j = JSON.parse(data);
          } catch {
            reject(Object.assign(new Error(`Réponse inattendue (HTTP ${resp.statusCode})`), { httpStatus: resp.statusCode }));
            return;
          }
          if (!j.error) {
            resolve(j.result);
            return;
          }
          const code = String(j.error.message || j.error.code || 'XAPI_ERROR');
          const params = [].concat(j.error.data ?? []).map(String);
          const err = new Error(params.length ? `${code} ${params.join(' ')}` : code);
          err.xapi = { code, params };
          reject(err);
        });
      },
    );
    r.on('timeout', () => r.destroy(new Error('Délai dépassé')));
    r.on('error', (e) => reject(TLS_ERRORS[e.code] || /certificate|self[- ]signed|altnames/i.test(e.message)
      ? Object.assign(new Error(`${TLS_ERRORS[e.code] || e.message} (${conn.ca ? 'certificat non émis par l\'autorité choisie ou nom différent' : 'choisir l\'autorité de certification de l\'hôte, ou désactiver « Vérifier le certificat »'})`), { code: e.code })
      : e));
    r.end(body);
  });
}

export const NULL_REF = 'OpaqueRef:NULL';
const TASK_POLL_MS = 5000;

export async function waitXapiTask(call, task, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await call('task.get_status', task);
    if (status === 'success') {
      await call('task.destroy', task).catch(() => {});
      return;
    }
    if (status !== 'pending') throw new Error(`${label} : ${(await call('task.get_error_info', task)).join(' ')}`);
    await sleep(TASK_POLL_MS);
  }
  throw new Error(`${label} : pas de réponse après ${timeoutMs / 60000} min`);
}

const xapiLogin = (conn) => xapiCall(conn, 'session.login_with_password', [conn.user, conn.pass, '1.0', 'xen-forge']);

const isSlaveError = (e) => e.xapi?.code === 'HOST_IS_SLAVE' || /HOST_IS_SLAVE/.test(e.message);
const slaveMaster = (e) => e.xapi?.params?.find((x) => x && x !== 'HOST_IS_SLAVE')
  || e.message.match(/HOST_IS_SLAVE\W+([\w.:-]+)/)?.[1] || null;

const PROBE_ERRORS = { EHOSTUNREACH: 'Hôte inaccessible' };
const BAD_CREDENTIALS = "Nom d'utilisateur ou mot de passe incorrect.";

async function probeHost(conn) {
  try {
    const session = await xapiLogin(conn);
    const call = (method, ...args) => xapiCall(conn, method, [session, ...args]);
    try {
      const [p] = Object.values(await call('pool.get_all_records'));
      const master = p ? await call('host.get_record', p.master) : null;
      const sv = master?.software_version || {};
      return {
        role: 'master',
        pool: p?.name_label || '',
        version: [sv.product_brand || 'XCP-ng', sv.product_version].filter(Boolean).join(' '),
      };
    } finally {
      await call('session.logout').catch(() => {});
    }
  } catch (e) {
    if (isSlaveError(e)) return { role: 'member', reportedMaster: slaveMaster(e) };
    if (e.xapi?.code === 'SESSION_AUTHENTICATION_FAILED' || (e.httpStatus >= 300 && e.httpStatus < 400)) {
      return { role: 'auth_failed', error: BAD_CREDENTIALS };
    }
    if (e.xapi) return { role: 'auth_failed', error: e.message };
    return { role: 'unreachable', error: PROBE_ERRORS[e.code] || e.message };
  }
}

const HOSTS_WITH_CA = `SELECT h.*, c.name AS ca_name, c.type AS ca_type, c.certificate AS ca_pem, c.is_active AS ca_active
  FROM xcp_hosts h LEFT JOIN certificate_entries c ON c.id = h.ca_certificate_id`;

export async function listHosts() {
  const { rows } = await pool.query(`${HOSTS_WITH_CA} ORDER BY h.created_at`);
  return rows.map((r) => ({
    id: r.id, host: r.host, username: r.username, insecure: r.insecure, ca_certificate_id: r.ca_certificate_id, ca_name: r.ca_name,
    role: r.role, reported_master: r.reported_master, last_error: r.last_error, checked_at: r.checked_at,
  }));
}

function caState(row) {
  if (row.insecure || !row.ca_certificate_id) return {};
  if (row.ca_type !== 'ca') return { caError: `${row.host} : autorité de certification introuvable (Sécurité > Certificats)` };
  if (!row.ca_active) return { caError: `${row.host} : autorité de certification « ${row.ca_name} » désactivée (Sécurité > Certificats)` };
  return { ca: row.ca_pem };
}

const toConn = (row) => ({
  id: row.id, host: row.host, user: row.username, pass: decrypt(row.password), insecure: row.insecure, ...caState(row),
});

export async function saveHost(id, input = {}) {
  const host = normalizeHost(input.host, 'Hôte XCP-ng');
  const user = String(input.username || '').trim();
  if (!user || user.length > 100) throw new ValidationError('Compte XCP-ng obligatoire');
  const existing = id ? (await pool.query('SELECT * FROM xcp_hosts WHERE id = $1', [id])).rows[0] : null;
  if (id && !existing) throw new ValidationError('Hôte introuvable');
  const pass = String(input.password || '') || (existing ? decrypt(existing.password) : '');
  if (!pass) throw new ValidationError('Mot de passe XCP-ng obligatoire');
  if (pass.length > 256) throw new ValidationError('Mot de passe XCP-ng invalide');
  const insecure = input.insecure === true || input.insecure === 'true';
  const ca = insecure ? null : await connectionCa(input.ca_certificate_id, `Hôte ${host}`);

  const probe = await probeHost({ host, user, pass, insecure, ca: ca?.pem });
  if (probe.role === 'unreachable' || probe.role === 'auth_failed') throw new ProbeError(`${host} : ${probe.error}`);

  const values = [host, user, encrypt(pass), insecure, ca?.id || null];
  try {
    if (existing) {
      await pool.query(`UPDATE xcp_hosts SET host = $2, username = $3, password = $4, insecure = $5, ca_certificate_id = $6,
        updated_at = now() WHERE id = $1`, [id, ...values]);
    } else {
      await pool.query('INSERT INTO xcp_hosts (host, username, password, insecure, ca_certificate_id) VALUES ($1, $2, $3, $4, $5)', values);
    }
  } catch (e) {
    if (e.code === '23505') throw new ValidationError(`L'hôte ${host} est déjà enregistré`);
    throw e;
  }
  await detectMaster();
  return probe;
}

export async function deleteHosts(ids) {
  const { rows } = await pool.query('DELETE FROM xcp_hosts WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);
  if (rows.length) detectAfterChange();
  return rows.map((r) => r.id);
}

export async function testHost(id) {
  const { rows } = await pool.query(`${HOSTS_WITH_CA} WHERE h.id = $1`, [id]);
  if (!rows[0]) throw new ValidationError('Hôte introuvable');
  return probeHost(toConn(rows[0]));
}

export class ProbeError extends Error {}

let detecting = null;
export function detectMaster() {
  detecting ||= runDetection().finally(() => { detecting = null; });
  return detecting;
}

function detectAfterChange() {
  const running = detecting ? detecting.catch(() => {}) : Promise.resolve();
  running.then(detectMaster).catch((e) => console.error('détection du maître XCP-ng :', e.message));
}

const hostnameOf = (host) => splitHost(host).hostname.toLowerCase();

async function runDetection() {
  const { rows } = await pool.query(`${HOSTS_WITH_CA} ORDER BY h.created_at`);
  const probes = await Promise.all(rows.map((r) => probeHost(toConn(r))));
  const masters = rows.filter((_r, i) => probes[i].role === 'master');
  const reported = new Set(probes.map((p) => p.reportedMaster).filter(Boolean).map((a) => a.toLowerCase()));
  const master = masters.find((r) => reported.has(hostnameOf(r.host))) || masters[0] || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE xcp_hosts SET role = 'unknown' WHERE role = 'master'");
    for (const [i, r] of rows.entries()) {
      const p = probes[i];
      let { role } = p;
      let error = p.error || null;
      if (role === 'master' && r.id !== master.id) {
        role = 'unknown';
        error = `Session ouverte mais ${master.host} est retenu comme maître : hôte d'un autre pool ?`;
      }
      if (role === 'member' && p.reportedMaster && !rows.some((x) => hostnameOf(x.host) === p.reportedMaster.toLowerCase())) {
        error = `Maître annoncé ${p.reportedMaster} non enregistré : l'ajouter avec ses identifiants`;
      }
      await client.query(`UPDATE xcp_hosts SET role = $2, reported_master = $3, last_error = $4, checked_at = now()
        WHERE id = $1`, [r.id, role === 'master' ? 'unknown' : role, p.reportedMaster || null, error]);
    }
    if (master) await client.query("UPDATE xcp_hosts SET role = 'master' WHERE id = $1", [master.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function xcpStatus() {
  const { rows } = await pool.query('SELECT host, role, last_error, checked_at FROM xcp_hosts ORDER BY created_at');
  if (!rows.length) return { state: 'unconfigured' };
  const checkedAt = rows.map((r) => r.checked_at).filter(Boolean).sort((a, b) => b - a)[0] || null;
  const issues = rows.filter((r) => r.role !== 'master' && (r.last_error || r.role === 'unreachable' || r.role === 'auth_failed'))
    .map((r) => `${r.host} : ${r.last_error || (r.role === 'auth_failed' ? 'identifiants refusés' : 'injoignable')}`);
  const master = rows.find((r) => r.role === 'master');
  if (master) return { state: 'ok', host: master.host, checked_at: checkedAt, issues };
  return { state: 'down', error: issues[0] || 'Aucun maître joignable parmi les hôtes enregistrés', checked_at: checkedAt, issues };
}

export function startMasterRefresh() {
  const every = Math.max(15, Number(process.env.XCP_MASTER_REFRESH_SECONDS) || 60) * 1000;
  const tick = () => detectMaster().catch((e) => console.error('détection du maître XCP-ng :', e.message));
  tick();
  return setInterval(tick, every);
}

async function xcpCreds() {
  const find = async () => (await pool.query(`${HOSTS_WITH_CA} WHERE h.role = 'master'`)).rows[0];
  let row = await find();
  if (!row) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM xcp_hosts');
    if (!rows[0].n) throw new ValidationError('Aucun résultat.');
    await detectMaster();
    row = await find();
  }
  if (!row) throw new ValidationError('Aucun maître XCP-ng joignable parmi les hôtes enregistrés (Infrastructure > Connecteurs)');
  return toConn(row);
}

async function masterSession() {
  let creds = await xcpCreds();
  try {
    return { creds, session: await xapiLogin(creds) };
  } catch (e) {
    if (!isSlaveError(e)) throw e;
    await detectMaster();
    creds = await xcpCreds();
    return { creds, session: await xapiLogin(creds) };
  }
}

export async function withMaster(fn) {
  const { creds, session } = await masterSession();
  try {
    return await fn((method, ...params) => xapiCall(creds, method, [session, ...params]), { creds, session });
  } finally {
    await xapiCall(creds, 'session.logout', [session]).catch(() => {});
  }
}

export const srFinder = (records) => {
  const all = Object.entries(records).map(([$ref, s]) => ({ ...s, $ref }));
  const find = (uuid, label) => {
    const sr = all.find((s) => s.uuid === uuid);
    if (!sr) throw new Error(`${label} : SR ${uuid || '(aucun)'} introuvable sur XCP-ng, le choisir à nouveau dans le profil`);
    return sr;
  };
  find.sameName = (sr) => all.filter((s) => s.name_label === sr.name_label).length;
  return find;
};
