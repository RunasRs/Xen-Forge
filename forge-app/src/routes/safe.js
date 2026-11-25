import { Router } from 'express';
import { auditAction, batchEvent, createEvent, namesFrom } from '../audit.js';
import { auth, handle } from '../http/session.js';
import { Refusal, batchInput, groupedRows, isPaged, orderBy, pageParams, runBatch, usageOrder, usageWindow } from '../lists.js';
import * as safe from '../safe.js';
import { usersLabel, vaultUsers } from '../usage.js';

export const router = Router();

const names = namesFrom('SELECT id, name FROM safe_entries WHERE id::text = ANY($1)');
const SAFE_TYPE_LABEL = "CASE type WHEN 'password' THEN 'mot de passe' WHEN 'ssh_key' THEN 'clé ssh' ELSE 'clé de produit' END";

router.get('/api/safe', auth, handle(async (req, res) => {
  if (!isPaged(req)) return res.json(await safe.list());
  const params = pageParams(req);
  const { search } = params;
  const page = await groupedRows(req.query.status, { from: 'safe_entries', select: 'id, name, type, username, public_key, is_active, created_at, updated_at',
    groups: { password: "type = 'password'", product_key: "type = 'product_key'", ssh_key: "type = 'ssh_key'" },
    search, searchCols: ['name', 'username', SAFE_TYPE_LABEL],
    order: orderBy(params, { name: 'name', username: 'username', type: SAFE_TYPE_LABEL, active: 'is_active', updated: 'updated_at' }, 'name, type'),
    ...usageWindow(params) });
  const usedBy = await vaultUsers();
  res.json({ ...page, rows: usageOrder(page.rows.map((r) => ({ ...r, used_by: usedBy(r.id) })), params) });
}));
router.post('/api/safe/batch', auth, auditAction(batchEvent('safe'), { names }), handle(async (req, res) => {
  const { action, ids } = batchInput(req.body, ['enable', 'disable', 'delete']);
  const usedBy = await vaultUsers();
  res.json(await runBatch(ids, async (sid) => {
    const users = action === 'enable' ? [] : usedBy(sid);
    if (action === 'delete' && users.length) throw new Refusal(`entrée utilisée par ${usersLabel(users)}`);
    if (action === 'disable' && users.length && req.body?.confirm !== true) throw new Refusal(`entrée utilisée par ${usersLabel(users)}`);
    if (action === 'delete') await safe.remove(sid);
    else await safe.update(sid, { is_active: action === 'enable' });
    return sid;
  }));
}));
router.post('/api/safe', auth, auditAction(createEvent('safe'), { names }), handle(async (req, res) => res.status(201).json(await safe.create(req.body || {}))));
router.post('/api/safe/generate', auth, auditAction('safe_keypair_generated'), handle(async (_req, res) => res.json(safe.generateKeypair())));
router.put('/api/safe/:id', auth, auditAction('safe_modified', { names }), handle(async (req, res) => res.json(await safe.update(req.params.id, req.body || {}))));
router.post('/api/safe/:id/reveal', auth, auditAction('safe_revealed', { names }), handle(async (req, res) => {
  res.json(await safe.reveal(req.params.id));
}));
