import { Router } from 'express';
import { pool } from '../db.js';
import * as distributions from '../distributions.js';
import { auditAction, sameNames } from '../audit.js';
import { auth, handle, notFound } from '../http/session.js';
import { Refusal, batchInput, isPaged, pageParams, runBatch } from '../lists.js';
import { CATALOG_OS } from '../os.js';

export const router = Router();

router.get('/api/distributions', auth, handle(async (req, res) => {
  if (isPaged(req)) return res.json(await distributions.list(pageParams(req)));
  const { rows } = await pool.query('SELECT os, version, url, hash FROM distribution ORDER BY os, version');
  res.json(rows);
}));
router.get('/api/distributions/os', auth, (_req, res) => res.json(CATALOG_OS));
router.post('/api/distributions/batch', auth, auditAction('distribution_deleted', { names: sameNames }), handle(async (req, res) => {
  const { ids } = batchInput(req.body, ['delete'], (x) => distributions.KEY_RE.test(String(x)));
  res.json(await runBatch(ids, async (key) => {
    if (!(await distributions.remove(key))) throw new Refusal(`« ${key} » : introuvable`);
    return key;
  }));
}));
router.post('/api/distributions', auth,
  auditAction('distribution_created', { target: (req) => `${req.body?.os}/${req.body?.version}` }), handle(async (req, res) => res.status(201).json(await distributions.create(req.body || {}))));
router.put('/api/distributions/:os/:version', auth,
  auditAction('distribution_modified', { target: (req) => `${req.params.os}/${req.params.version}` }), handle(async (req, res) => {
  const d = await distributions.update(`${req.params.os}/${req.params.version}`, req.body || {});
  if (!d) return notFound(res);
  res.json(d);
}));
