import https from 'node:https';
import WebSocket from 'ws';
import { connectionCa, tlsOptions } from '../certificates.js';
import { getSetting, setSetting, deleteSetting, pool } from '../db.js';
import { ValidationError, normalizeHost, splitHost } from '../validation.js';
import { TLS_ERRORS } from '../xcp.js';

const XO_KEYS = ['xo_host', 'xo_username', 'xo_password', 'xo_insecure', 'xo_ca_id'];
const XO_LABEL = 'Xen Orchestra';

async function readXo() {
  const [host, user, pass, insecure, caId] = await Promise.all(XO_KEYS.map(getSetting));
  const skip = insecure === 'true';
  return { host, user, pass, insecure: skip, caId: skip ? null : caId || null };
}

export async function getXoSettings() {
  const { host, user, pass, insecure, caId } = await readXo();
  const ca = caId ? (await pool.query('SELECT name FROM certificate_entries WHERE id = $1', [caId])).rows[0] : null;
  return {
    xo_host: host || '',
    xo_username: user || '',
    xo_password_set: !!pass,
    xo_insecure: insecure,
    xo_ca_id: caId || '',
    xo_ca_name: ca?.name || '',
  };
}

export async function xoCreds() {
  const { host, user, pass, insecure, caId } = await readXo();
  if (!host || !user || !pass) {
    throw new ValidationError('Connexion Xen Orchestra non renseignée (Infrastructure > Connecteurs)');
  }
  const ca = await connectionCa(caId, XO_LABEL);
  return { host, user, pass, insecure, ca: ca?.pem, caName: ca?.name };
}

export const xoProviderEnv = ({ host, user, pass, insecure }, caFile) => ({
  XOA_URL: `wss://${host}`,
  XOA_USER: user,
  XOA_PASSWORD: pass,
  XOA_INSECURE: insecure ? 'true' : 'false',
  ...(caFile ? { SSL_CERT_FILE: caFile } : {}),
});

function request(creds, { method = 'GET', path, headers = {}, body }) {
  const { hostname, port } = splitHost(creds.host);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname, port, method, path, headers,
      ...tlsOptions(creds), timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('timeout', () => r.destroy(new Error('délai dépassé')));
    r.on('error', reject);
    r.end(body);
  });
}

async function signIn(creds) {
  const form = new URLSearchParams({ username: creds.user, password: creds.pass }).toString();
  let res;
  try {
    res = await request(creds, {
      method: 'POST',
      path: '/signin/local',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
      body: form,
    });
  } catch (e) {
    if (e.code === 'EHOSTUNREACH') throw new Error('Xen Orchestra : Hôte inaccessible');
    const tls = TLS_ERRORS[e.code] || /certificate|self[- ]signed|altnames/i.test(e.message);
    const hint = creds.ca ? 'certificat non émis par l\'autorité choisie ou nom différent'
      : 'choisir l\'autorité de certification de Xen Orchestra, ou désactiver « Vérifier le certificat »';
    throw new Error(`Xen Orchestra injoignable : ${TLS_ERRORS[e.code] || e.message}${tls ? ` (${hint})` : ''}`);
  }
  const token = (res.headers['set-cookie'] || []).map((c) => c.match(/^token=([^;]+)/)?.[1]).find(Boolean);
  if (!token) {
    if (/signin-otp/.test(res.headers.location || '')) {
      throw new Error('Le compte Xen Orchestra a l\'OTP activé : utiliser un compte de service sans OTP');
    }
    throw new Error("Xen Orchestra : Nom d'utilisateur ou mot de passe incorrect.");
  }
  return token;
}

const restGet = (creds, token, path) => request(creds, { path, headers: { Cookie: `token=${token}` } })
  .then((r) => {
    if (r.status !== 200) throw new Error(`Xen Orchestra : ${path} (HTTP ${r.status})`);
    return JSON.parse(r.body);
  });

export async function testXo(creds) {
  const token = await signIn(creds);
  const pools = await restGet(creds, token, '/rest/v0/pools?fields=name_label,id').catch(() => []);
  return pools.map((p) => p.name_label || p.id).filter(Boolean);
}

let xoState = { state: 'unconfigured' };
let xoToken = null;
let xoTokenFor = '';
let xoChecking = null;

async function runXoCheck() {
  const { host, user, pass, insecure, caId } = await readXo();
  if (!host || !user || !pass) {
    xoToken = null;
    xoState = { state: 'unconfigured' };
    return;
  }
  const key = JSON.stringify([host, user, pass, insecure, caId]);
  if (key !== xoTokenFor) { xoToken = null; xoTokenFor = key; }
  try {
    const creds = { host, user, pass, insecure, ca: (await connectionCa(caId, XO_LABEL))?.pem };
    const ping = async () => {
      xoToken ||= await signIn(creds);
      return request(creds, { path: '/rest/v0/pools?fields=id', headers: { Cookie: `token=${xoToken}` } });
    };
    let r = await ping();
    if (r.status === 401) { xoToken = null; r = await ping(); }
    if (r.status !== 200) throw new Error(`API REST : HTTP ${r.status}`);
    xoState = { state: 'ok', host, checked_at: new Date() };
  } catch (e) {
    xoState = { state: 'down', host, error: e.message, checked_at: new Date() };
  }
}

export async function refreshXoStatus({ fresh = false } = {}) {
  if (fresh && xoChecking) await xoChecking;
  xoChecking ||= runXoCheck().catch((e) => { xoState = { state: 'down', error: e.message, checked_at: new Date() }; })
    .finally(() => { xoChecking = null; });
  return xoChecking;
}

export const xoStatus = () => xoState;

export function startXoRefresh() {
  const every = Math.max(15, Number(process.env.XO_STATUS_REFRESH_SECONDS) || 60) * 1000;
  refreshXoStatus();
  return setInterval(refreshXoStatus, every);
}

export async function listXoSubjects() {
  const creds = await xoCreds();
  const token = await signIn(creds);
  const [users, groups] = await Promise.all([
    restGet(creds, token, '/rest/v0/users?fields=id,name,email,permission'),
    restGet(creds, token, '/rest/v0/groups?fields=id,name'),
  ]);
  return [
    ...users.map((u) => ({ id: u.id, type: 'user', name: u.name || u.email, meta: u.permission === 'admin' ? 'admin XO' : '' })),
    ...groups.map((g) => ({ id: g.id, type: 'group', name: g.name, meta: '' })),
  ].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

const RPC_TIMEOUT_MS = 15000;
async function withXoRpc(fn) {
  const creds = await xoCreds();
  const ws = new WebSocket(`wss://${creds.host}/api/`, { ...tlsOptions(creds), handshakeTimeout: RPC_TIMEOUT_MS });
  const pending = new Map();
  let lastId = 0;
  const failAll = (e) => { pending.forEach(({ reject }) => reject(e)); pending.clear(); };
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`Xen Orchestra : ${msg.error.message || 'erreur JSON-RPC'}`));
    else p.resolve(msg.result);
  });
  ws.on('error', failAll);
  ws.on('close', () => failAll(new Error('Xen Orchestra : connexion JSON-RPC fermée')));
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++lastId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Xen Orchestra : ${method} sans réponse`));
    }, RPC_TIMEOUT_MS);
    const done = (f) => (v) => { clearTimeout(timer); f(v); };
    pending.set(id, { resolve: done(resolve), reject: done(reject) });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', (e) => reject(new Error(`Xen Orchestra injoignable (JSON-RPC) : ${e.message}`)));
    });
    await call('session.signIn', { username: creds.user, password: creds.pass });
    return await fn(call);
  } finally {
    ws.removeAllListeners('close');
    ws.close();
  }
}

export async function getResourceSet(name) {
  const sets = (await withXoRpc((call) => call('resourceSet.getAll'))).filter((r) => r.name === name);
  if (sets.length !== 1) {
    throw new Error(`Groupe self-service « ${name} » ${sets.length ? 'ambigu (plusieurs groupes de ce nom)' : 'introuvable dans Xen Orchestra'}`);
  }
  return { id: sets[0].id, tags: sets[0].tags || [] };
}

export async function saveXoSettings(input = {}) {
  const host = normalizeHost(input.xo_host, 'Xen Orchestra');
  const user = String(input.xo_username || '').trim();
  if (!user || user.length > 255) throw new ValidationError('Compte Xen Orchestra obligatoire');
  const pass = String(input.xo_password || '') || await getSetting('xo_password');
  if (!pass) throw new ValidationError('Mot de passe Xen Orchestra obligatoire');
  const insecure = input.xo_insecure === true || input.xo_insecure === 'true';
  const ca = insecure ? null : await connectionCa(input.xo_ca_id, XO_LABEL);
  const pools = await testXo({ host, user, pass, insecure, ca: ca?.pem });
  await setSetting('xo_host', host);
  await setSetting('xo_username', user);
  await setSetting('xo_password', pass, true);
  await setSetting('xo_insecure', String(insecure));
  if (ca) await setSetting('xo_ca_id', ca.id);
  else await deleteSetting('xo_ca_id');
  return { pools };
}

export async function deleteXoSettings() {
  await Promise.all(XO_KEYS.map(deleteSetting));
}
