import { Client, InvalidCredentialsError, ResultCodeError } from 'ldapts';
import tls from 'node:tls';
import { pool } from './db.js';
import { connectionCa } from './certificates.js';
import { encrypt, decrypt } from './crypto.js';
import { accountOf, revoke as revokeDevices } from './devices.js';
import { openEnrollment } from './totp.js';
import { closeDomainSession, closeDomainSessions } from './sessions.js';
import { ValidationError } from './validation.js';
import { Refusal } from './lists.js';

const PASSWORD_MASK = '*************';
const ATTR_SAFE = /^[a-zA-Z0-9_-]{1,64}$/;
const HOST_SAFE = /^[a-zA-Z0-9._-]{1,253}$|^\[[0-9a-fA-F:]+\]$/;
const DNS_NAME = /^(?=.{1,253}$)[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/;
const MAX_GROUP_DEPTH = 10;
const TIMEOUT_MS = 5000;
const SEARCH_LIMIT = 5;
const UNREADABLE_GROUP_CODES = [32, 50];
const ACCOUNT_DISABLED = 2;
const MAX_DN_LENGTH = 1024;
const GROUP_OBJECTS = '(|(objectClass=group)(objectClass=groupOfNames)(objectClass=posixGroup))';

const escFilter = (v) => String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const norm = (v) => String(v ?? '').trim().toLowerCase();
const dnKey = (dn) => norm(dn).replace(/\s*,\s*/g, ',');
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function ldapHost(value) {
  let host = String(value ?? '').trim().replace(/^ldaps?:\/\//i, '').split(/[/?#]/)[0];
  if (/^[^:\]]+:\d+$/.test(host)) host = host.split(':')[0];
  return host;
}

const CA_LABEL = 'Connecteur LDAP';
const CONFIGS_WITH_CA = `SELECT l.*, c.name AS ca_name, c.type AS ca_type, c.certificate AS ca_pem, c.is_active AS ca_active,
    c.not_after AS ca_not_after
  FROM ldap_configs l LEFT JOIN certificate_entries c ON c.id = l.ca_certificate_id`;

function caState(r) {
  if (!r.tls || !r.ca_certificate_id) return { ca_pem: null, ca_error: null };
  if (r.ca_type !== 'ca') return { ca_pem: null, ca_error: `${CA_LABEL} : autorité de certification introuvable (Sécurité > Certificats)` };
  if (!r.ca_active) return { ca_pem: null, ca_error: `${CA_LABEL} : autorité de certification « ${r.ca_name} » désactivée (Sécurité > Certificats)` };
  return { ca_pem: r.ca_pem, ca_error: null };
}

function validateInput(input, existing) {
  const out = {
    domain: String(input.domain ?? existing?.domain ?? '').trim(),
    server: ldapHost(input.server ?? existing?.server),
    tls_name: existing?.tls_name || '',
    bind_dn: String(input.bind_dn ?? existing?.bind_dn ?? '').trim(),
    base_dn: String(input.base_dn ?? existing?.base_dn ?? '').trim(),
    attribute: String(input.attribute ?? existing?.attribute ?? 'sAMAccountName').trim(),
    tls: Boolean(input.tls ?? existing?.tls),
    ldaps: Boolean(input.ldaps ?? existing?.ldaps),
    enabled: Boolean(input.enabled ?? existing?.enabled ?? true),
  };
  if (!out.domain || out.domain.length > 100) throw new ValidationError('Domaine obligatoire (100 caractères max)');
  if (!HOST_SAFE.test(out.server)) throw new ValidationError('Serveur LDAP invalide');
  if (!out.base_dn) throw new ValidationError('DN de base obligatoire');
  if (!ATTR_SAFE.test(out.attribute)) throw new ValidationError('Attribut de recherche invalide');
  if (!out.tls) {
    out.ldaps = false;
    out.tls_name = '';
  }
  return out;
}

const toApi = (r) => ({
  id: r.id,
  domain: r.domain,
  server: r.server,
  tls_name: r.tls_name || '',
  bind_dn: r.bind_dn || '',
  bind_password_set: Boolean(r.bind_password),
  base_dn: r.base_dn,
  attribute: r.attribute,
  tls: r.tls,
  ldaps: r.ldaps,
  ca_certificate_id: r.tls ? r.ca_certificate_id || '' : '',
  ca_name: r.tls && r.ca_certificate_id ? r.ca_name || '' : '',
  ca_active: r.ca_active !== false,
  ca_not_after: r.tls && r.ca_certificate_id ? r.ca_not_after : null,
  enabled: r.enabled,
});

export async function listConfigs() {
  const { rows } = await pool.query(`${CONFIGS_WITH_CA} ORDER BY l.domain`);
  return rows.map(toApi);
}

const chosenCaId = (input, stored) => (Object.hasOwn(input, 'ca_certificate_id')
  ? String(input.ca_certificate_id || '') : stored?.ca_certificate_id || '');

async function applyCertificate(input, existing, out) {
  const caId = out.tls ? chosenCaId(input, existing) : '';
  if (out.tls && !caId) {
    throw new ValidationError('Autorité de certification obligatoire avec TLS : l\'importer dans Sécurité > Certificats (type CA) puis la choisir');
  }
  const ca = out.tls ? await connectionCa(caId, CA_LABEL) : null;
  out.ca_certificate_id = ca?.id || null;
  out.ca_pem = ca?.pem || null;
  out.ca_error = null;
}

export async function saveConfig(id, input) {
  const existing = id ? (await pool.query(`${CONFIGS_WITH_CA} WHERE l.id = $1`, [id])).rows[0] : null;
  if (id && !existing) return null;
  if (!id && (await pool.query('SELECT 1 FROM ldap_configs LIMIT 1')).rowCount) {
    throw new ValidationError('Un connecteur LDAP est déjà configuré');
  }
  const out = validateInput(input, existing);
  assertPasswordMayFollow(existing, out, input);
  await applyCertificate(input, existing, out);
  if (out.tls) out.tls_name = await learnTlsName(out);
  const pwd = typeof input.bind_password === 'string' ? input.bind_password : '';
  out.bind_password = pwd && pwd !== PASSWORD_MASK ? encrypt(pwd) : existing?.bind_password ?? null;
  const cols = ['domain', 'server', 'tls_name', 'bind_dn', 'bind_password', 'base_dn', 'attribute', 'tls', 'ldaps',
    'ca_certificate_id', 'enabled'];
  const vals = cols.map((c) => out[c] || (typeof out[c] === 'boolean' ? out[c] : null));
  try {
    const sql = existing
      ? `UPDATE ldap_configs SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`
      : `INSERT INTO ldap_configs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
    const { rows } = await pool.query(sql, existing ? [...vals, id] : vals);
    if (existing && (!rows[0].enabled || norm(rows[0].domain) !== norm(existing.domain))) await closeDomainSessions(existing.domain);
    return toApi((await pool.query(`${CONFIGS_WITH_CA} WHERE l.id = $1`, [rows[0].id])).rows[0]);
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('Ce domaine existe déjà');
    throw e;
  }
}

export async function deleteConfig(id) {
  const { rows } = await pool.query('DELETE FROM ldap_configs WHERE id = $1 RETURNING domain', [id]);
  if (rows[0]) await closeDomainSessions(rows[0].domain);
  return rows.length > 0;
}

const certificateChanges = (input, stored) => chosenCaId(input, stored) !== (stored.ca_certificate_id || '');

function assertPasswordMayFollow(stored, cfg, input) {
  if (!stored?.bind_password || newBindPassword(input)) return;
  if (cfg.server !== stored.server || (stored.tls && !cfg.tls) || certificateChanges(input, stored)) {
    throw new ValidationError('Serveur, chiffrement ou certificat modifié : ressaisir le mot de passe de liaison');
  }
}

const newBindPassword = (input) => (typeof input.bind_password === 'string' && input.bind_password !== PASSWORD_MASK ? input.bind_password : '');

export const hasEnabledConfig = async () =>
  (await pool.query('SELECT 1 FROM ldap_configs WHERE enabled LIMIT 1')).rowCount > 0;

async function loadConfig(id) {
  const { rows } = id
    ? await pool.query(`${CONFIGS_WITH_CA} WHERE l.id = $1`, [id])
    : await pool.query(`${CONFIGS_WITH_CA} WHERE l.enabled ORDER BY l.id LIMIT 1`);
  const r = rows[0];
  if (!r) return null;
  return { ...r, ...caState(r), bind_password: r.bind_password ? decrypt(r.bind_password) : '' };
}

function tlsOptions(cfg) {
  const o = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  if (cfg.ca_pem) o.ca = [Buffer.from(cfg.ca_pem)];
  if (cfg.learn) {
    o.checkServerIdentity = (_host, cert) => {
      const name = certName(cfg.server, cert);
      if (name == null) return new Error('le certificat du serveur ne porte aucun nom DNS');
      cfg.tls_name = name;
      return undefined;
    };
  } else if (cfg.tls_name) {
    o.servername = cfg.tls_name;
    o.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(cfg.tls_name, cert);
  }
  return o;
}

function certName(server, cert) {
  if (!tls.checkServerIdentity(server, cert)) return '';
  const dns = String(cert.subjectaltname || '').split(', ').filter((x) => x.startsWith('DNS:')).map((x) => x.slice(4));
  const name = dns.find((n) => !n.includes('*')) || cert.subject?.CN;
  return name && DNS_NAME.test(name) ? name.toLowerCase() : null;
}

async function learnTlsName(cfg) {
  const probe = { ...cfg, bind_dn: '', learn: true, tls_name: '' };
  try {
    closeQuiet(await open(probe));
  } catch (e) {
    throw new ValidationError(`Connexion TLS au serveur impossible : ${e.message}`);
  }
  return probe.tls_name;
}

function tlsError(e, cfg) {
  if (e instanceof InvalidCredentialsError) return new Error('compte de liaison ou mot de passe refusé par le serveur');
  if (e instanceof ResultCodeError) return new Error(`refus du serveur (${e.name}, code ${e.code})`);
  const name = cfg.tls_name || cfg.server;
  const alt = /cert's altnames: (.*)$/.exec(e.message || '')?.[1]?.split(', ').filter((x) => x.startsWith('DNS:') || x.startsWith('IP Address:'))
    .map((x) => x.replace(/^(DNS|IP Address):/, '')).join(', ');
  switch (e.code) {
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return new Error(`le certificat du serveur est valable pour ${alt || 'un autre nom'}, pas pour ${name} : `
        + `renseignez ${alt ? `« ${alt.split(', ')[0]} » ` : ''}dans « Nom du certificat »`);
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return new Error(cfg.ca_pem
        ? 'certificat du serveur non émis par l\'autorité de certification choisie'
        : 'autorité de certification inconnue : choisissez l\'autorité qui a émis le certificat du serveur (Sécurité > Certificats, type CA)');
    case 'CERT_HAS_EXPIRED':
      return new Error('le certificat du serveur a expiré');
    default:
      return e;
  }
}

async function search(client, base, opts) {
  const { searchEntries } = await client.search(base, opts);
  return searchEntries.map(({ dn, ...attrs }) => ({
    dn,
    attrs: Object.fromEntries(Object.entries(attrs).map(([name, values]) => [name, arr(values)])),
  }));
}

async function readRootDse(client) {
  try {
    await client.search('', { scope: 'base', attributes: ['1.1'] });
  } catch (e) {
    if (!(e instanceof ResultCodeError)) throw e;
  }
}

async function open(cfg) {
  if (cfg.tls && cfg.ca_error) throw new Error(cfg.ca_error);
  const useLdaps = cfg.tls && cfg.ldaps;
  const client = new Client({
    url: `${useLdaps ? 'ldaps' : 'ldap'}://${cfg.server}:${useLdaps ? 636 : 389}`,
    timeout: TIMEOUT_MS,
    connectTimeout: TIMEOUT_MS,
    strictDN: false,
    ...(useLdaps ? { tlsOptions: tlsOptions(cfg) } : {}),
  });
  try {
    if (cfg.tls && !cfg.ldaps) await client.startTLS(tlsOptions(cfg));
    if (cfg.bind_dn) await client.bind(cfg.bind_dn, cfg.bind_password || '');
    else await readRootDse(client);
    return client;
  } catch (e) {
    closeQuiet(client);
    throw tlsError(e, cfg);
  }
}

const closeQuiet = (client) => { client?.unbind().catch(() => {}); };

export async function testConnection(id, overrides = null) {
  const stored = id ? await loadConfig(id) : null;
  if (id && !stored) throw new ValidationError('Configuration introuvable');
  const cfg = overrides ? { ...validateInput(overrides, stored), bind_password: stored?.bind_password } : stored;
  if (overrides) {
    assertPasswordMayFollow(stored, cfg, overrides);
    await applyCertificate(overrides, stored, cfg);
    if (overrides.bind_password && overrides.bind_password !== PASSWORD_MASK) cfg.bind_password = overrides.bind_password;
  }
  if (!cfg) throw new ValidationError('Configuration requise');
  if (cfg.tls && (overrides || !cfg.tls_name)) cfg.learn = true;
  let client;
  let link;
  try {
    client = await open(cfg);
    link = observedLink(client);
  } finally {
    closeQuiet(client);
  }
  const expected = cfg.tls ? (cfg.ldaps ? 'ldaps' : 'starttls') : 'ldap';
  if (link.protocol !== expected) {
    throw new Error(`protocole négocié (${link.protocol.toUpperCase()}) différent du protocole choisi (${expected.toUpperCase()})`);
  }
  return { ...link, tls_name: cfg.tls ? cfg.tls_name || cfg.server : null };
}

function observedLink(client) {
  const socket = client.socket;
  const encrypted = Boolean(socket?.encrypted);
  const protocol = client.startTLSUpgraded ? 'starttls' : encrypted ? 'ldaps' : 'ldap';
  return {
    protocol,
    port: socket?.remotePort || client.port || null,
    tls_version: encrypted ? socket.getProtocol?.() || null : null,
  };
}

const STATUS_TTL_MS = 30000;
let ldapState = { state: 'unconfigured' };
let ldapCheckedAt = 0;
let ldapStale = true;
let ldapChecking = null;

async function runLdapCheck() {
  ldapStale = false;
  const { rows } = await pool.query('SELECT id, server, enabled FROM ldap_configs ORDER BY enabled DESC, domain LIMIT 1');
  const r = rows[0];
  if (!r) ldapState = { state: 'unconfigured' };
  else if (!r.enabled) ldapState = { state: 'disabled', server: r.server };
  else {
    try {
      await testConnection(r.id);
      ldapState = { state: 'ok', server: r.server, checked_at: new Date() };
    } catch (e) {
      ldapState = { state: 'down', server: r.server, error: e.message, checked_at: new Date() };
    }
  }
  ldapCheckedAt = Date.now();
}

export function invalidateLdapStatus() {
  ldapStale = true;
}

export async function ldapStatus() {
  if (ldapChecking) await ldapChecking;
  if (ldapStale || Date.now() - ldapCheckedAt > STATUS_TTL_MS) {
    ldapChecking ||= runLdapCheck()
      .catch((e) => { ldapState = { state: 'down', error: e.message, checked_at: new Date() }; ldapCheckedAt = Date.now(); })
      .finally(() => { ldapChecking = null; });
    await ldapChecking;
  }
  return ldapState;
}

const personFilter = (attr, login) =>
  `(&(|(objectClass=user)(objectClass=inetOrgPerson)(objectClass=posixAccount))(${attr}=${escFilter(login)}))`;

async function findUser(client, cfg, login) {
  const entries = await search(client, cfg.base_dn, {
    filter: personFilter(cfg.attribute, login),
    scope: 'sub',
    sizeLimit: 2,
    attributes: [cfg.attribute, 'memberOf', 'userAccountControl'],
  });
  if (entries.length !== 1) return null;
  const e = entries[0];
  return {
    dn: e.dn,
    username: e.attrs[cfg.attribute]?.[0] || login,
    memberOf: arr(e.attrs.memberOf),
    disabled: (Number(e.attrs.userAccountControl?.[0]) & ACCOUNT_DISABLED) !== 0,
  };
}

async function groupDnsRecursive(client, directDns) {
  const seen = new Set();
  const walk = async (dn, depth) => {
    const key = dnKey(dn);
    if (!key || seen.has(key) || depth >= MAX_GROUP_DEPTH) return;
    seen.add(key);
    try {
      const [g] = await search(client, dn, { filter: '(objectClass=*)', scope: 'base', attributes: ['memberOf'] });
      for (const p of arr(g?.attrs.memberOf)) await walk(p, depth + 1);
    } catch (e) {
      if (!UNREADABLE_GROUP_CODES.includes(e.code)) throw e;
    }
  };
  for (const dn of directDns) await walk(dn, 0);
  return seen;
}

async function uniqueGroupDn(client, cfg, name) {
  try {
    const entries = await search(client, cfg.base_dn, {
      filter: `(&${GROUP_OBJECTS}(cn=${escFilter(name)}))`, scope: 'sub', sizeLimit: 2, attributes: ['cn'],
    });
    return entries.length === 1 ? entries[0].dn : null;
  } catch (e) {
    if (e?.name === 'SizeLimitExceededError') return null;
    throw e;
  }
}

async function ruleGroupDn(client, cfg, rule) {
  if (rule.dn) return rule.dn;
  const dn = await uniqueGroupDn(client, cfg, rule.name);
  if (!dn) {
    console.warn(`LDAP: règle de groupe « ${rule.name} » ignorée : aucun groupe ou plusieurs groupes portent ce nom`);
    return null;
  }
  await pool.query('UPDATE ldap_admins SET dn = $2 WHERE id = $1 AND dn IS NULL', [rule.id, dn]);
  return dn;
}

async function isDomainAdmin(client, cfg, user) {
  const { rows } = await pool.query('SELECT id, kind, name, dn, enabled FROM ldap_admins WHERE config_id = $1', [cfg.id]);
  const own = rows.find((r) => r.kind === 'user' && norm(r.name) === norm(user.username));
  if (own) return { allowed: own.enabled, group: null };
  const groups = rows.filter((r) => r.kind === 'group' && r.enabled);
  if (!groups.length) return { allowed: false, group: null };
  const mine = await groupDnsRecursive(client, user.memberOf);
  for (const rule of groups) {
    const dn = await ruleGroupDn(client, cfg, rule);
    if (dn && mine.has(dnKey(dn))) return { allowed: true, group: rule.name };
  }
  return { allowed: false, group: null };
}

const GRANT_TTL_MS = 15 * 60 * 1000;
const grants = new Map();

function noteGrant(username, domain, group) {
  const now = Date.now();
  for (const [k, g] of grants) if (now - g.at > GRANT_TTL_MS) grants.delete(k);
  grants.set(norm(domainLogin(username, domain)), { group, at: now });
}

async function saveGroup(cfg, username, group) {
  await pool.query('UPDATE ldap_accounts SET via_group = $3 WHERE config_id = $1 AND lower(username) = lower($2)',
    [cfg.id, username, group]);
}

export async function authenticate(login, password) {
  if (typeof login !== 'string' || typeof password !== 'string' || !login || !password || login.length > 256 || password.length > 512) return null;
  const cfg = await loadConfig();
  if (!cfg) return null;
  let client;
  try {
    client = await open(cfg);
    const user = await findUser(client, cfg, login);
    if (!user || norm(user.username) !== norm(login)) return null;
    const { allowed, group } = await isDomainAdmin(client, cfg, user);
    await client.bind(user.dn, password);
    if (!allowed) return null;
    noteGrant(user.username, cfg.domain, group);
    return { username: user.username, domain: cfg.domain };
  } catch (e) {
    if (e?.name !== 'InvalidCredentialsError') console.error('LDAP:', e.message);
    return null;
  } finally {
    closeQuiet(client);
  }
}

export async function stillAuthorized(login) {
  const at = login.lastIndexOf('@');
  const name = login.slice(0, at);
  const cfg = await loadConfig();
  if (!cfg || norm(cfg.domain) !== norm(login.slice(at + 1))) return false;
  let client;
  try {
    client = await open(cfg);
    const user = await findUser(client, cfg, name);
    if (!user || norm(user.username) !== norm(name) || user.disabled) return false;
    const { allowed, group } = await isDomainAdmin(client, cfg, user);
    if (allowed) await saveGroup(cfg, user.username, group);
    return allowed;
  } catch (e) {
    console.error('LDAP (revérification de session) :', e.message);
    return null;
  } finally {
    closeQuiet(client);
  }
}

export const hasLoggedIn = async (login) => {
  const at = login.lastIndexOf('@');
  return (await pool.query(`
    SELECT 1 FROM ldap_accounts a JOIN ldap_configs c ON c.id = a.config_id
    WHERE lower(c.domain) = lower($2) AND lower(a.username) = lower($1)`, [login.slice(0, at), login.slice(at + 1)])).rowCount > 0;
};

export async function searchDirectory(kind, term) {
  const cfg = await loadConfig();
  if (!cfg) throw new ValidationError('Aucun domaine LDAP activé');
  const t = escFilter(String(term || '').trim());
  if (!t) return { items: [], truncated: false };
  const isUser = kind === 'user';
  const attr = isUser ? cfg.attribute : 'cn';
  const objects = isUser ? '(|(objectClass=user)(objectClass=inetOrgPerson)(objectClass=posixAccount))' : GROUP_OBJECTS;
  let client;
  try {
    client = await open(cfg);
    const entries = await search(client, cfg.base_dn, {
      filter: `(&${objects}(${attr}=${t}*))`, scope: 'sub', sizeLimit: SEARCH_LIMIT + 1, attributes: [attr],
    });
    const shown = entries.slice(0, SEARCH_LIMIT).filter((e) => e.attrs[attr]?.[0]);
    const items = isUser
      ? [...new Set(shown.map((e) => e.attrs[attr][0]))].map((n) => ({ name: n, value: n }))
      : shown.map((e) => ({ name: e.attrs.cn[0], value: e.dn, detail: e.dn }));
    return { items: items.sort((a, b) => a.name.localeCompare(b.name)), truncated: entries.length > SEARCH_LIMIT };
  } catch (e) {
    throw new ValidationError(`Recherche LDAP impossible : ${e.message}`);
  } finally {
    closeQuiet(client);
  }
}

const shownConfig = async () =>
  (await pool.query('SELECT id, domain FROM ldap_configs ORDER BY enabled DESC, id LIMIT 1')).rows[0] || null;

const domainLogin = (name, domain) => `${name}@${domain}`;

export async function listAdmins() {
  const cfg = await shownConfig();
  if (!cfg) return [];
  const [rules, accounts, keys] = await Promise.all([
    pool.query('SELECT id, kind, name, dn, enabled FROM ldap_admins WHERE config_id = $1 ORDER BY kind, name', [cfg.id]),
    pool.query('SELECT id, username, last_login_at, via_group FROM ldap_accounts WHERE config_id = $1 ORDER BY lower(username)', [cfg.id]),
    pool.query("SELECT lower(username) AS login, totp_created_at FROM totp_users WHERE user_type = 'domain' AND totp_verified"),
  ]);
  const totp = new Map(keys.rows.map((k) => [k.login, k.totp_created_at]));
  const totpOf = (name) => totp.get(norm(domainLogin(name, cfg.domain))) || null;
  const seen = new Map(accounts.rows.map((a) => [norm(a.username), a]));
  const ruled = new Set(rules.rows.filter((r) => r.kind === 'user').map((r) => norm(r.name)));
  return [
    ...rules.rows.map((r) => ({
      id: `r${r.id}`, kind: r.kind, name: r.name, dn: r.dn || null, enabled: r.enabled,
      last_login: (r.kind === 'user' && seen.get(norm(r.name))?.last_login_at) || null,
      totp_configured: r.kind === 'user' && Boolean(totpOf(r.name)),
      totp_since: r.kind === 'user' ? totpOf(r.name) : null,
    })),
    ...accounts.rows.filter((a) => !ruled.has(norm(a.username))).map((a) => ({
      id: `m${a.id}`, kind: 'member', name: a.username, group: a.via_group || null, enabled: true, last_login: a.last_login_at,
      totp_configured: Boolean(totpOf(a.username)), totp_since: totpOf(a.username),
    })),
  ];
}

async function groupRuleFromDn(client, cfg, dn) {
  const base = dnKey(cfg.base_dn);
  if (!dnKey(dn).endsWith(`,${base}`)) throw new ValidationError(`« ${dn} » : hors du DN de base`);
  let entries;
  try {
    entries = await search(client, dn, { filter: GROUP_OBJECTS, scope: 'base', attributes: ['cn'] });
  } catch {
    entries = [];
  }
  if (entries.length !== 1 || !entries[0].attrs.cn?.[0]) throw new ValidationError(`« ${dn} » : groupe introuvable dans l'annuaire`);
  return { name: entries[0].attrs.cn[0], dn: entries[0].dn };
}

export async function addAdmins(kind, values) {
  if (!['user', 'group'].includes(kind)) throw new ValidationError('Type invalide');
  const list = [...new Set(arr(values).map((n) => String(n).trim()).filter(Boolean))].slice(0, 100);
  if (!list.length || list.some((n) => n.length > (kind === 'group' ? MAX_DN_LENGTH : 256))) throw new ValidationError('Aucun nom valide');
  const shown = await shownConfig();
  if (!shown) throw new ValidationError('Aucun connecteur LDAP configuré');
  if (kind === 'user') {
    for (const n of list) {
      await pool.query("INSERT INTO ldap_admins (config_id, kind, name) VALUES ($1, 'user', $2) ON CONFLICT DO NOTHING", [shown.id, n]);
      await openEnrollment(domainLogin(n, shown.domain), 'domain');
    }
    return;
  }
  const cfg = await loadConfig(shown.id);
  let client;
  try {
    try {
      client = await open(cfg);
    } catch (e) {
      throw new ValidationError(`Annuaire injoignable : ${e.message}`);
    }
    const rules = [];
    for (const dn of list) rules.push(await groupRuleFromDn(client, cfg, dn));
    for (const g of rules) {
      const { rows } = await pool.query("SELECT id, dn FROM ldap_admins WHERE kind = 'group' AND name = $1", [g.name]);
      if (rows[0]?.dn && dnKey(rows[0].dn) !== dnKey(g.dn)) {
        throw new ValidationError(`Un autre groupe nommé « ${g.name} » est déjà autorisé (${rows[0].dn})`);
      }
      if (rows[0]) await pool.query('UPDATE ldap_admins SET dn = $2 WHERE id = $1', [rows[0].id, g.dn]);
      else await pool.query("INSERT INTO ldap_admins (config_id, kind, name, dn) VALUES ($1, 'group', $2, $3)", [cfg.id, g.name, g.dn]);
    }
  } finally {
    closeQuiet(client);
  }
}

export const ADMIN_ROW_ID = /^[rm][1-9]\d{0,9}$/;

export async function adminAction(rowId, action) {
  const cfg = await shownConfig();
  if (!cfg) throw new Refusal('Aucun connecteur LDAP configuré');
  const id = Number(rowId.slice(1));
  const isRule = rowId[0] === 'r';
  const target = (await pool.query(isRule
    ? 'SELECT id, kind, name FROM ldap_admins WHERE id = $1 AND config_id = $2'
    : "SELECT id, 'member' AS kind, username AS name FROM ldap_accounts WHERE id = $1 AND config_id = $2", [id, cfg.id])).rows[0];
  if (!target) throw new Refusal(isRule ? 'Règle introuvable' : 'Compte introuvable');
  const { name } = target;
  const isGroup = target.kind === 'group';
  const login = domainLogin(name, cfg.domain);
  const dropKey = async () => (await pool.query(
    "DELETE FROM totp_users WHERE user_type = 'domain' AND lower(username) = lower($1)", [login])).rowCount;
  const closeAccount = async () => {
    await revokeDevices(accountOf(name, 'domain'));
    await closeDomainSession(login);
  };
  const forgetAccount = async () => {
    await pool.query('DELETE FROM ldap_accounts WHERE config_id = $1 AND lower(username) = lower($2)', [cfg.id, name]);
    await dropKey();
    await closeAccount();
  };
  if (isGroup && action === 'totp-reset') {
    throw new Refusal(`« ${name} » : action sans objet pour un groupe`);
  }
  if (action === 'enable') {
    if (!isRule) throw new Refusal(`« ${name} » : accès donné par un groupe, déjà actif`);
    await pool.query('UPDATE ldap_admins SET enabled = TRUE WHERE id = $1', [id]);
  } else if (action === 'disable') {
    if (isRule) await pool.query('UPDATE ldap_admins SET enabled = FALSE WHERE id = $1', [id]);
    else {
      await pool.query(`INSERT INTO ldap_admins (config_id, kind, name, enabled) VALUES ($1, 'user', $2, FALSE)
        ON CONFLICT (kind, name) DO UPDATE SET enabled = FALSE`, [cfg.id, name]);
    }
    if (isGroup) await closeDomainSessions(cfg.domain);
    else await closeAccount();
  } else if (action === 'totp-reset') {
    await dropKey();
    await openEnrollment(login, 'domain');
    await closeAccount();
  } else if (action === 'delete') {
    if (isRule) await pool.query('DELETE FROM ldap_admins WHERE id = $1', [id]);
    if (isGroup) await closeDomainSessions(cfg.domain);
    else await forgetAccount();
  }
  return rowId;
}

export async function domainSessionValid(login) {
  const at = login.lastIndexOf('@');
  if (at <= 0) return false;
  const { rows } = await pool.query(`
    SELECT 1 FROM ldap_accounts a
    JOIN ldap_configs c ON c.id = a.config_id
    WHERE c.enabled AND lower(c.domain) = lower($2) AND lower(a.username) = lower($1)
      AND NOT EXISTS (
        SELECT 1 FROM ldap_admins r
        WHERE r.config_id = c.id AND r.kind = 'user' AND NOT r.enabled AND lower(r.name) = lower($1))`,
  [login.slice(0, at), login.slice(at + 1)]);
  return rows.length > 0;
}

export async function recordLogin(username, domain) {
  const key = norm(domainLogin(username, domain));
  const grant = grants.get(key);
  grants.delete(key);
  const known = Boolean(grant);
  await pool.query(`
    INSERT INTO ldap_accounts (config_id, username, last_login_at, via_group)
    SELECT id, $1, now(), $3 FROM ldap_configs WHERE lower(domain) = lower($2)
    ON CONFLICT (config_id, (lower(username))) DO UPDATE SET username = EXCLUDED.username, last_login_at = now(),
      via_group = CASE WHEN $4 THEN EXCLUDED.via_group ELSE ldap_accounts.via_group END`,
  [username, domain, grant?.group ?? null, known]);
}
