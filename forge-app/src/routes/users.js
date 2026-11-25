import { Router } from 'express';
import { auditAction, batchEvent, namesFrom } from '../audit.js';
import { auth, handle, notFound } from '../http/session.js';
import { Refusal, batchInput, orderBy, pageParams, pagedRows, runBatch } from '../lists.js';
import * as devices from '../devices.js';
import { closeLocalSessions } from '../sessions.js';
import * as totp from '../totp.js';
import * as users from '../users.js';

export const router = Router();

const names = namesFrom('SELECT id, username AS name FROM local_users WHERE id::text = ANY($1)');

router.get('/api/users', auth, handle(async (req, res) => {
  const params = pageParams(req);
  const { limit, offset, search } = params;
  res.json(await pagedRows({ from: 'local_users', select: `id, username, is_active, must_change_password, created_at, updated_at,
      EXISTS (SELECT 1 FROM totp_users t WHERE t.username = local_users.username AND t.user_type = 'local' AND t.totp_verified) AS totp_configured,
      (SELECT t.totp_created_at FROM totp_users t WHERE t.username = local_users.username AND t.user_type = 'local' AND t.totp_verified) AS totp_since`,
    search, searchCols: ['username'], limit, offset,
    order: orderBy(params, { username: 'username', active: 'is_active', password: 'must_change_password', totp: 'totp_configured', created: 'created_at' }, 'username') }));
}));
router.post('/api/users/batch', auth, auditAction(batchEvent('user'), { names }), handle(async (req, res) => {
  const { action, ids } = batchInput(req.body, ['enable', 'disable', 'delete', 'totp-reset']);
  res.json(await runBatch(ids, async (uid) => {
    const entry = await users.get(uid);
    if (!entry) throw new Refusal('Administrateur introuvable');
    if (action === 'totp-reset') {
      await totp.resetUser(entry.username, 'local');
      await devices.revoke(devices.accountOf(entry.username, 'local'));
      await totp.openEnrollment(entry.username, 'local');
      await closeLocalSessions(entry.username);
      return uid;
    }
    if (entry.username === req.user && action !== 'enable') {
      throw new Refusal(`« ${entry.username} » : impossible de désactiver ou supprimer votre propre compte`);
    }
    try {
      if (action === 'delete') await users.remove(uid);
      else await users.update(uid, { is_active: action === 'enable' });
    } catch (e) {
      throw new Refusal(`« ${entry.username} » : ${e.message}`);
    }
    return uid;
  }));
}));
router.post('/api/users', auth, auditAction('user_created'), handle(async (req, res) => res.status(201).json(await users.create(req.body || {}))));
router.put('/api/users/:id', auth, auditAction('user_modified', { names,
  details: (req) => ({ must_change_password: req.body?.must_change_password }) }), handle(async (req, res) => {
  const entry = await users.get(req.params.id);
  if (!entry) return notFound(res);
  const b = req.body || {};
  if ('username' in b && String(b.username).trim() !== entry.username) {
    return res.status(400).json({ error: "L'identifiant d'un administrateur ne peut pas être modifié" });
  }
  res.json(await users.update(req.params.id, { must_change_password: b.must_change_password }));
}));
