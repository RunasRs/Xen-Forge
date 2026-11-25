import { Router } from 'express';
import { pool } from '../db.js';
import { auditAction, batchEvent, namesFrom } from '../audit.js';
import { auth, handle } from '../http/session.js';
import { Refusal, batchInput, groupedRows, orderBy, pageParams, runBatch, usageOrder, usageWindow } from '../lists.js';
import * as certificates from '../certificates.js';
import { certificateUsers, usersLabel } from '../usage.js';

export const router = Router();

const names = namesFrom('SELECT id, name FROM certificate_entries WHERE id::text = ANY($1)');
const CERT_TYPE_LABEL = "CASE type WHEN 'cert_key' THEN 'x.509' WHEN 'pkcs12' THEN 'pkcs12' ELSE 'ca' END";

router.get('/api/certificates', auth, handle(async (req, res) => {
  if (req.query.all !== undefined) {
    const { rows } = await pool.query(`SELECT ${certificates.publicColumns} FROM certificate_entries ORDER BY name`);
    return res.json(rows);
  }
  const params = pageParams(req);
  const { search } = params;
  const page = await groupedRows(req.query.status, { from: 'certificate_entries', select: certificates.publicColumns,
    groups: { valid: 'not_after IS NULL OR not_after >= now()', expired: 'not_after < now()' },
    search, searchCols: ['name', 'subject', 'issuer', CERT_TYPE_LABEL],
    order: orderBy(params, { name: 'name', type: CERT_TYPE_LABEL, expires: 'not_after', active: 'is_active', updated: 'updated_at' }, 'name'),
    ...usageWindow(params) });
  const usedBy = await certificateUsers();
  return res.json({ ...page, rows: usageOrder(page.rows.map((r) => ({ ...r, used_by: usedBy(r.id) })), params) });
}));
router.post('/api/certificates/batch', auth, auditAction(batchEvent('certificate'), { names }), handle(async (req, res) => {
  const { action, ids } = batchInput(req.body, ['enable', 'disable', 'delete']);
  const usedBy = await certificateUsers();
  res.json(await runBatch(ids, async (id) => {
    const users = action === 'enable' ? [] : usedBy(id);
    if (action === 'delete' && users.length) throw new Refusal(`certificat utilisé par ${usersLabel(users)}`);
    if (action === 'disable' && users.length && req.body?.confirm !== true) throw new Refusal(`certificat utilisé par ${usersLabel(users)}`);
    if (action === 'delete') await certificates.remove(id);
    else await certificates.update(id, { is_active: action === 'enable' });
    return id;
  }));
}));
router.get('/api/certificates/:id', auth, handle(async (req, res) => res.json(await certificates.details(req.params.id))));
router.post('/api/certificates', auth, auditAction('certificate_created', { details: (_req, entry) => ({ type: entry?.type }) }),
  handle(async (req, res) => res.status(201).json(await certificates.create(req.body || {}))));
router.put('/api/certificates/:id', auth, auditAction('certificate_modified', { names }), handle(async (req, res) => res.json(await certificates.update(req.params.id, req.body || {}))));
