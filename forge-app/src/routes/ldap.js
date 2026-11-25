import { Router } from 'express';
import { auditAction, batchEvent, namesFrom } from '../audit.js';
import { pool } from '../db.js';
import { auth, handle, notFound } from '../http/session.js';
import { Refusal, batchInput, runBatch } from '../lists.js';
import * as ldap from '../ldap.js';
import { ValidationError } from '../validation.js';

export const router = Router();

const domainNames = namesFrom('SELECT id, domain AS name FROM ldap_configs WHERE id::text = ANY($1)');
async function adminNames(ids) {
  const of = (prefix) => ids.filter((x) => x[0] === prefix).map((x) => x.slice(1));
  const [rules, members] = await Promise.all([
    pool.query("SELECT 'r' || id AS id, name FROM ldap_admins WHERE id::text = ANY($1)", [of('r')]),
    pool.query("SELECT 'm' || id AS id, username AS name FROM ldap_accounts WHERE id::text = ANY($1)", [of('m')]),
  ]);
  return new Map([...rules.rows, ...members.rows].map((r) => [r.id, r.name]));
}

const id = (req) => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : null);
router.get('/api/ldap/configs', auth, handle(async (_req, res) => res.json(await ldap.listConfigs())));
router.get('/api/ldap/status', auth, handle(async (_req, res) => res.json(await ldap.ldapStatus())));
router.post('/api/ldap/configs', auth, auditAction('ldap_domain_created'), handle(async (req, res) => {
  const saved = await ldap.saveConfig(null, req.body || {});
  ldap.invalidateLdapStatus();
  res.status(201).json(saved);
}));
router.put('/api/ldap/configs/:id', auth, auditAction('ldap_domain_modified', { names: domainNames }), handle(async (req, res) => {
  const saved = id(req) && (await ldap.saveConfig(id(req), req.body || {}));
  ldap.invalidateLdapStatus();
  saved ? res.json(saved) : notFound(res);
}));
const isIntId = (x) => Number.isInteger(x) && x > 0;
router.post('/api/ldap/configs/batch', auth, auditAction('ldap_domain_deleted', { names: domainNames }), handle(async (req, res) => {
  const { ids } = batchInput(req.body, ['delete'], isIntId);
  const result = await runBatch(ids, async (cid) => {
    if (!(await ldap.deleteConfig(cid))) throw new Refusal('Domaine introuvable');
    return cid;
  });
  ldap.invalidateLdapStatus();
  res.json(result);
}));
router.post('/api/ldap/test', auth, auditAction('ldap_domain_tested', { names: domainNames,
  ids: (req) => (req.body?.id ? [req.body.id] : []), target: (req) => req.body?.domain }), handle(async (req, res) => {
  const { id: cid = null, ...overrides } = req.body || {};
  ldap.invalidateLdapStatus();
  try {
    res.json({ ok: true, ...(await ldap.testConnection(cid, Object.keys(overrides).length ? overrides : null)) });
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    res.status(502).json({ error: `Connexion LDAP échouée : ${e.message}` });
  }
}));
router.get('/api/ldap/search', auth, handle(async (req, res) => {
  res.json(await ldap.searchDirectory(req.query.kind === 'group' ? 'group' : 'user', req.query.q));
}));
router.get('/api/ldap/admins', auth, handle(async (_req, res) => res.json(await ldap.listAdmins())));
router.post('/api/ldap/admins', auth, auditAction('ldap_admin_added', {
  target: (req) => (Array.isArray(req.body?.names) ? req.body.names.slice(0, 100).join(', ') : null), details: (req) => ({ kind: String(req.body?.kind ?? '').slice(0, 10) }) }), handle(async (req, res) => {
  await ldap.addAdmins(req.body?.kind, req.body?.names);
  res.status(201).json(await ldap.listAdmins());
}));
router.post('/api/ldap/admins/batch', auth, auditAction(batchEvent('ldap_admin'), { names: adminNames }), handle(async (req, res) => {
  const { action, ids } = batchInput(req.body, ['enable', 'disable', 'delete', 'totp-reset'], (x) => ldap.ADMIN_ROW_ID.test(String(x)));
  res.json(await runBatch(ids, (rid) => ldap.adminAction(rid, action)));
}));
