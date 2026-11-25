import { Router } from 'express';
import { auditAction, getAuditSettings, listAudit, setAuditSettings } from '../audit.js';
import { auth, handle } from '../http/session.js';
import { getJobRetention, setJobRetention } from '../jobretention.js';

export const router = Router();

router.get('/api/audit', auth, handle(async (req, res) => res.json(await listAudit(req))));
router.get('/api/audit/settings', auth, handle(async (_req, res) => res.json(await getAuditSettings())));
router.put('/api/audit/settings', auth, auditAction('audit_retention_modified', {
  context: async () => ({ from: (await getAuditSettings()).retentionDays }),
  details: (_req, s) => ({ to: s?.retentionDays }) }), handle(async (req, res) => res.json(await setAuditSettings(req.body || {}))));
router.get('/api/settings/jobs', auth, handle(async (_req, res) => res.json(await getJobRetention())));
router.put('/api/settings/jobs', auth, auditAction('jobs_retention_modified', {
  context: async () => ({ from: (await getJobRetention()).retentionDays }),
  details: (_req, s) => ({ to: s?.retentionDays }) }), handle(async (req, res) => res.json(await setJobRetention(req.body || {}))));
