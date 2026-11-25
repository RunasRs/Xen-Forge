import { Router } from 'express';
import { pool } from '../db.js';
import { auditAction, createEvent, namesFrom, sameNames } from '../audit.js';
import { auth, handle, notFound } from '../http/session.js';
import { Refusal, batchInput, runBatch } from '../lists.js';
import { tofuStateSummary } from '../tofu/state.js';
import { UUID_RE, ValidationError } from '../validation.js';
import {
  brickNameOf, catalogueStatus, checkBrickText, checkStepValues, cloneDraft, createBrick, getBrick, isForgeBrick, listBricks, parseBrickId,
  removeBrick, resolveStepBrick, updateBrick,
} from '../ansible/catalogue.js';
import { knownHostToken, targetAddress } from '../ansible/jobs.js';
import { guidedPlaybook } from '../ansible/playbook.js';
import { validateAnsibleProfile } from '../ansible/variables.js';

export const router = Router();

const profileNames = namesFrom('SELECT id, name FROM ansible_profiles WHERE id::text = ANY($1)');

const isBrickId = (id) => {
  try {
    parseBrickId(id);
    return true;
  } catch {
    return false;
  }
};

async function guidedProfiles() {
  const { rows } = await pool.query("SELECT id, name, vars FROM ansible_profiles WHERE vars->>'config_type' = 'guided' ORDER BY name");
  return rows;
}

const usedBy = (profiles, id) => profiles.filter((p) => (p.vars.steps || []).some((s) => s.brick === id)).map((p) => p.name);

const publicBrick = (b, profiles, { withYaml = false } = {}) => ({
  id: b.id, origin: b.origin, os: b.os, file: b.file, name: b.name, description: b.description, parameters: b.parameters,
  error: b.error, used_by: usedBy(profiles, b.id), ...(withYaml ? { yaml: b.yaml } : {}),
});

function brickParam(req) {
  const id = String(req.query.id || req.body?.id || '');
  parseBrickId(id);
  return id;
}

router.get('/api/ansible/catalogue', auth, handle(async (_req, res) => {
  const profiles = await guidedProfiles();
  res.json({ status: catalogueStatus(), rows: listBricks().map((b) => publicBrick(b, profiles)) });
}));

router.get('/api/ansible/catalogue/brick', auth, handle(async (req, res) => {
  const brick = getBrick(brickParam(req));
  if (!brick) return notFound(res);
  return res.json(publicBrick(brick, await guidedProfiles(), { withYaml: true }));
}));

router.get('/api/ansible/catalogue/clone', auth, handle(async (req, res) => {
  res.json(cloneDraft(brickParam(req)));
}));

router.get('/api/ansible/catalogue/export', auth, auditAction('ansible_brick_exported', { target: (req) => String(req.query.id || '') }), handle(async (req, res) => {
  const brick = getBrick(brickParam(req));
  if (!brick) return notFound(res);
  res.set('Content-Disposition', `attachment; filename="${brick.file}.yml"`);
  return res.type('application/yaml').send(brick.yaml);
}));

router.post('/api/ansible/catalogue/check', auth,
  auditAction('ansible_brick_checked', { target: (req) => brickNameOf(req.body?.yaml), details: (_req, b) => ({ os: b?.os }) }), handle(async (req, res) => {
  const os = ['linux', 'windows'].includes(req.body?.os) ? req.body.os : undefined;
  const { name, os: brickOs, description, parameters } = checkBrickText(String(req.body?.yaml ?? ''), os);
  res.json({ name, os: brickOs, description, parameters });
}));

router.post('/api/ansible/catalogue', auth, auditAction(createEvent('ansible_brick'), { names: sameNames, target: (req) => req.body?.id }), handle(async (req, res) => {
  const brick = createBrick(brickParam(req), String(req.body?.yaml ?? ''));
  res.status(201).json(publicBrick(brick, []));
}));

router.put('/api/ansible/catalogue', auth, auditAction('ansible_brick_modified', { target: (req) => req.body?.id,
  details: (req) => (req.body?.new_id && req.body.new_id !== req.body.id ? { renamed_to: req.body.new_id } : null) }), handle(async (req, res) => {
  const id = brickParam(req);
  const newId = String(req.body?.new_id || id);
  if (isForgeBrick(id)) throw new ValidationError('Brique Forge en lecture seule : la cloner pour la modifier');
  const profiles = await guidedProfiles();
  const users = usedBy(profiles, id);
  if (users.length && req.body?.confirm !== true) {
    return res.status(409).json({ error: 'Brique utilisée par des profils', used_by: users, confirm: true });
  }
  const brick = updateBrick(id, newId, String(req.body?.yaml ?? ''));
  if (brick.id !== id) {
    for (const p of profiles.filter((x) => (x.vars.steps || []).some((s) => s.brick === id))) {
      const steps = p.vars.steps.map((s) => (s.brick === id ? { ...s, brick: brick.id } : s));
      await pool.query('UPDATE ansible_profiles SET vars = $2, updated_at = now() WHERE id = $1', [p.id, { ...p.vars, steps }]);
    }
  }
  return res.json(publicBrick(brick, await guidedProfiles()));
}));

router.post('/api/ansible/catalogue/batch', auth, auditAction('ansible_brick_deleted', { names: sameNames }), handle(async (req, res) => {
  const { ids } = batchInput(req.body, ['delete'], isBrickId);
  const profiles = await guidedProfiles();
  res.json(await runBatch(ids, async (id) => {
    if (isForgeBrick(id)) throw new Refusal('Brique Forge : suppression impossible');
    const users = usedBy(profiles, id);
    if (users.length) throw new Refusal(`Utilisée par ${users.map((n) => `« ${n} »`).join(', ')} : retirer l'étape de ces profils d'abord`);
    removeBrick(id);
    return id;
  }));
}));

router.get('/api/ansible/vms', auth, handle(async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name, vars FROM tofu_profiles ORDER BY name');
  const vms = await Promise.all(rows.map(async (p) => {
    const st = await tofuStateSummary(p.id).catch(() => null);
    return {
      id: p.id,
      profile: p.name,
      vm_name: st?.vm?.name || p.vars?.vm_name || '',
      os_type: p.vars?.os_type || 'linux',
      deployed: (st?.resources || 0) > 0,
      ipv4: st?.vm?.ipv4?.[0] || p.vars?.network_static_ip || '',
      safe_entry_id: p.vars?.safe_entry_id || '',
    };
  }));
  res.json(vms);
}));

function enabledSteps(vars) {
  return (vars.steps || []).filter((s) => s.enabled).map((s) => {
    const brick = resolveStepBrick(s, vars.os_type, 'Étape');
    return { brick, values: checkStepValues(brick, s.values, `Étape (${brick.name})`) };
  });
}

router.post('/api/ansible/preview', auth,
  auditAction('ansible_playbook_previewed', { target: (req) => String(req.body?.name || '').trim() || null }), handle(async (req, res) => {
  const vars = await validateAnsibleProfile(req.body?.vars);
  const name = String(req.body?.name || '').trim() || 'Profil Ansible';
  res.json({ playbook: vars.config_type === 'yaml' ? vars.playbook : guidedPlaybook({ name, os: vars.os_type, steps: enabledSteps(vars) }) });
}));

async function loadProfile(id) {
  if (!UUID_RE.test(String(id))) return null;
  const { rows } = await pool.query('SELECT * FROM ansible_profiles WHERE id = $1', [id]);
  return rows[0] || null;
}

async function freeName(base) {
  for (let n = 1; n < 100; n += 1) {
    const suffix = n === 1 ? ' (YAML)' : ` (YAML ${n})`;
    const candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    const { rowCount } = await pool.query('SELECT 1 FROM ansible_profiles WHERE name = $1', [candidate]);
    if (!rowCount) return candidate;
  }
  throw new ValidationError('Impossible de trouver un nom libre pour le profil converti');
}

router.post('/api/ansible/profiles/:id/convert', auth,
  auditAction('ansible_profile_converted', { names: profileNames, details: (_req, p) => ({ new_profile: p?.name }) }), handle(async (req, res) => {
  const profile = await loadProfile(req.params.id);
  if (!profile) return notFound(res);
  if (profile.vars.config_type !== 'guided') throw new ValidationError('Seul un profil à étapes guidées se convertit en YAML');
  const playbook = guidedPlaybook({ name: profile.name, os: profile.vars.os_type, steps: enabledSteps(profile.vars) });
  const { steps: _steps, ...rest } = profile.vars;
  const vars = await validateAnsibleProfile({ ...rest, config_type: 'yaml', playbook });
  const { rows } = await pool.query(
    'INSERT INTO ansible_profiles (name, description, vars) VALUES ($1, $2, $3) RETURNING id, name',
    [await freeName(profile.name), profile.description, vars]);
  return res.status(201).json(rows[0]);
}));

router.post('/api/ansible/profiles/:id/known-hosts/reset', auth,
  auditAction('ansible_known_hosts_reset', { names: profileNames, details: (_req, r) => ({ removed: r?.removed }) }), handle(async (req, res) => {
  const profile = await loadProfile(req.params.id);
  if (!profile) return notFound(res);
  const tokens = [];
  const skipped = [];
  for (const t of (profile.vars.targets || []).filter((x) => x.connection === 'ssh')) {
    try {
      tokens.push(knownHostToken(await targetAddress(t), t.port));
    } catch (e) {
      skipped.push(e.message);
    }
  }
  const { rowCount } = tokens.length
    ? await pool.query('DELETE FROM ansible_known_hosts WHERE host = ANY($1)', [tokens])
    : { rowCount: 0 };
  return res.json({ removed: rowCount, skipped });
}));
