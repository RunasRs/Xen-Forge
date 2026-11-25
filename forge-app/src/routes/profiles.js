import { Router } from 'express';
import { pool } from '../db.js';
import { auditAction, createEvent, namesFrom } from '../audit.js';
import { auth, handle, notFound } from '../http/session.js';
import { Refusal, batchInput, copyName, groupedRows, orderBy, pageParams, pagedRows, runBatch } from '../lists.js';
import { ansibleUpdateRefusal, validateAnsibleProfile } from '../ansible/variables.js';
import { windowsAccountRefusal } from '../safe.js';
import { dropTofuState, tofuStateSummary } from '../tofu/state.js';
import { deployedUpdateRefusal, validateTofuProfile } from '../tofu/variables.js';
import { listImportableVms, readVmForImport } from '../tofu/importvm.js';
import { enqueueTofu } from '../tofu/jobs.js';
import { UUID_RE, ValidationError } from '../validation.js';
import { validateProfile } from '../variables.js';

export const router = Router();

function profileName(body) {
  const name = String(body?.name || '').trim();
  if (!name || name.length > 100) throw new ValidationError('Nom du profil obligatoire (100 caractères max)');
  return name;
}

function profileDescription(body) {
  const d = String(body?.description ?? '').trim();
  if (d.length > 500) throw new ValidationError('Description trop longue (500 caractères max)');
  return d || null;
}

async function flagInvalidSafeEntries(profiles) {
  if (!profiles.some((p) => p.vars?.safe_entry_id)) return profiles;
  const { rows } = await pool.query('SELECT id FROM safe_entries WHERE is_active');
  const active = new Set(rows.map((r) => r.id));
  return profiles.map((p) => {
    const id = p.vars?.safe_entry_id;
    if (!id || active.has(id)) return p;
    const { safe_entry_id: _removed, ...vars } = p.vars;
    return { ...p, vars };
  });
}

const publicProfile = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  vars: p.vars,
  created_at: p.created_at,
  updated_at: p.updated_at,
});

const VM_NAME_MAX = { profiles: 63, tofu_profiles: 128 };
const copyVmName = (vm, max) => (vm ? `${String(vm).slice(0, max - 6)}-copie` : vm);
const withoutImport = ({ imported, vm_mac: _m, vm_uuid: _u, ...vars }) => {
  if (imported === 'true') delete vars.destroy_cloud_config;
  return vars;
};

const ENGINES = { profiles: 'packer', tofu_profiles: 'tofu', ansible_profiles: 'ansible' };

function profileRoutes(base, table, { jobs, validate, toPublic, beforeUpdate, checkAccount, beforeDelete, afterDelete, searchCols, sortCols, groups }) {
  const prefix = `${ENGINES[table]}_profile`;
  const names = namesFrom(`SELECT id, name FROM ${table} WHERE id::text = ANY($1)`);
  const load = async (id) => (UUID_RE.test(id)
    ? (await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0]
    : null);
  const present = async (rows) => {
    const ids = [rows.map((r) => r.id)];
    const [{ rows: busy }, { rows: last }] = await Promise.all([
      pool.query(`SELECT DISTINCT ON (profile_id) profile_id, action, status FROM ${jobs}
        WHERE status IN ('queued', 'running') AND profile_id = ANY($1::uuid[])
        ORDER BY profile_id, created_at DESC`, ids),
      pool.query(`SELECT DISTINCT ON (profile_id) profile_id, id, action, status, created_at FROM ${jobs}
        WHERE profile_id = ANY($1::uuid[]) ORDER BY profile_id, created_at DESC`, ids),
    ]);
    const active = new Map(busy.map((r) => [r.profile_id, { action: r.action, status: r.status }]));
    const lastJob = new Map(last.map(({ profile_id: pid, ...j }) => [pid, j]));
    const out = await Promise.all(rows.map(async (r) => ({
      ...(await toPublic(r)), busy: active.has(r.id), activeJob: active.get(r.id) || null, lastJob: lastJob.get(r.id) || null })));
    return flagInvalidSafeEntries(out);
  };
  const save = async (res, status, sql, params) => {
    try {
      const { rows } = await pool.query(sql, params);
      res.status(status).json((await present(rows))[0]);
    } catch (e) {
      if (e.code === '23505') throw new ValidationError('Un profil porte déjà ce nom');
      throw e;
    }
  };

  router.get(base, auth, handle(async (req, res) => {
    const params = pageParams(req);
    const { limit, offset, search } = params;
    const query = { from: table, search, searchCols: ['name', 'description', ...searchCols],
      order: orderBy(params, { name: 'name', description: 'description', ...sortCols,
        last_job: `(SELECT max(created_at) FROM ${jobs} j WHERE j.profile_id = ${table}.id)` }, 'name'), limit, offset };
    const page = groups ? await groupedRows(req.query.status, { ...query, ...(await groups()) }) : await pagedRows(query);
    const { rows: [busy] } = await pool.query(`SELECT count(DISTINCT profile_id)::int AS n,
      count(DISTINCT profile_id) FILTER (WHERE status = 'running')::int AS running FROM ${jobs}
      WHERE status IN ('queued', 'running') AND profile_id IS NOT NULL`);
    res.json({ rows: await present(page.rows), total: page.total, counts: page.counts, active: busy.n, running: busy.running });
  }));
  const remove = async (id) => {
    const { rows: busy } = await pool.query(
      `SELECT 1 FROM ${jobs} WHERE profile_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [id]);
    if (busy.length) throw new Refusal('Un job est en cours sur ce profil : attendre sa fin ou l\'annuler');
    if (beforeDelete) {
      const refusal = await beforeDelete(id);
      if (refusal) throw new Refusal(refusal);
    }
    const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    if (!rowCount) throw new Refusal('Profil introuvable');
    if (afterDelete) await afterDelete(id);
    return id;
  };
  router.post(`${base}/batch`, auth, auditAction(`${prefix}_deleted`, { names }), handle(async (req, res) => {
    const { ids } = batchInput(req.body, ['delete']);
    res.json(await runBatch(ids, remove));
  }));
  router.get(`${base}/:id/clone`, auth, handle(async (req, res) => {
    const cur = await load(req.params.id);
    if (!cur) return notFound(res);
    const [draft] = await flagInvalidSafeEntries([{
      name: await copyName(table, 'name', cur.name),
      description: cur.description,
      vars: { ...withoutImport(cur.vars || {}), ...(cur.vars?.vm_name ? { vm_name: copyVmName(cur.vars.vm_name, VM_NAME_MAX[table] || 63) } : {}) },
    }]);
    res.json({ ...draft, copy_from: cur.id });
  }));
  router.post(base, auth, auditAction(createEvent(prefix), { names }), handle(async (req, res) => {
    const name = profileName(req.body);
    const vars = await validate(req.body?.vars);
    const accountRefusal = checkAccount ? await checkAccount(vars) : null;
    if (accountRefusal) throw new ValidationError(accountRefusal);
    await save(res, 201, `INSERT INTO ${table} (name, description, vars) VALUES ($1, $2, $3) RETURNING *`,
      [name, profileDescription(req.body), vars]);
  }));
  router.put(`${base}/:id`, auth, auditAction(`${prefix}_modified`, { names }), handle(async (req, res) => {
    const cur = await load(req.params.id);
    if (!cur) return notFound(res);
    const name = profileName(req.body);
    const vars = await validate(req.body?.vars);
    const refusal = beforeUpdate ? await beforeUpdate(cur, vars) : null;
    if (refusal) throw new ValidationError(refusal);
    const accountRefusal = checkAccount ? await checkAccount(vars, cur) : null;
    if (accountRefusal) throw new ValidationError(accountRefusal);
    await save(res, 200, `UPDATE ${table} SET name = $2, description = $3, vars = $4, updated_at = now()
      WHERE id = $1 RETURNING *`, [cur.id, name, profileDescription(req.body), vars]);
  }));
}

profileRoutes('/api/profiles', 'profiles', {
  jobs: 'jobs',
  validate: validateProfile,
  searchCols: ["vars->>'vm_name'"],
  sortCols: { validated: 'validated_at', built: 'built_at', template: "vars->>'vm_name'" },
  beforeDelete: async (id) => {
    const { rows } = await pool.query('SELECT name FROM schedules WHERE profile_id = $1 ORDER BY name LIMIT 1', [id]);
    return rows[0] ? `Profil utilisé par la planification « ${rows[0].name} » : la supprimer ou changer son profil d'abord` : null;
  },
  toPublic: (p) => ({ ...publicProfile(p), validated_at: p.validated_at, built_at: p.built_at }),
});

profileRoutes('/api/tofu/profiles', 'tofu_profiles', {
  jobs: 'tofu_jobs',
  validate: validateTofuProfile,
  searchCols: ["vars->>'vm_name'", "vars->>'source_template'"],
  sortCols: { validated: 'planned_at', built: 'applied_at', vm: "vars->>'vm_name'", source: "vars->>'source_template'" },
  groups: async () => {
    const { rows } = await pool.query('SELECT id FROM tofu_profiles');
    const states = await Promise.all(rows.map((r) => tofuStateSummary(r.id).catch(() => null)));
    const deployed = rows.filter((_, i) => states[i]?.resources > 0).map((r) => r.id);
    return { params: [deployed], groups: { deployed: 'id = ANY($1::uuid[])', undeployed: 'NOT (id = ANY($1::uuid[]))' } };
  },
  beforeDelete: async (id) => {
    const { rows } = await pool.query('SELECT name FROM tofu_schedules WHERE profile_id = $1 ORDER BY name LIMIT 1', [id]);
    return rows[0] ? `Profil utilisé par la planification « ${rows[0].name} » : la supprimer ou changer son profil d'abord` : null;
  },
  toPublic: async (p) => ({
    ...publicProfile(p),
    planned_at: p.planned_at,
    applied_at: p.applied_at,
    destroyed_at: p.destroyed_at,
    state: await tofuStateSummary(p.id).catch(() => null),
  }),
  beforeUpdate: async (cur, vars) => {
    const st = await tofuStateSummary(cur.id, { fresh: true });
    if (!st?.resources) return null;
    const vm = st.vm || { name: cur.vars.vm_name };
    if (vm.share && vars.resource_set && vars.resource_set_share !== 'true') {
      return `VM « ${vm.name} » déployée et partagée avec son groupe self-service : retirer le partage impose de retirer aussi le groupe, ou de détruire puis redéployer la VM`;
    }
    const { rows } = await pool.query(`SELECT vars_snapshot FROM tofu_jobs WHERE profile_id = $1 AND action IN ('apply', 'import')
      AND status = 'success' ORDER BY finished_at DESC LIMIT 1`, [cur.id]);
    return deployedUpdateRefusal({ cur: cur.vars, deployed: rows[0]?.vars_snapshot || cur.vars, next: vars, vmName: vm.name });
  },
  checkAccount: async (vars, cur) => {
    if (vars.os_type !== 'windows' || vars.cloud_init_yaml) return null;
    if (cur && (await tofuStateSummary(cur.id, { fresh: true }))?.resources) return null;
    return windowsAccountRefusal(vars.safe_entry_id);
  },
  afterDelete: dropTofuState,
});

profileRoutes('/api/ansible/profiles', 'ansible_profiles', {
  jobs: 'ansible_jobs',
  validate: validateAnsibleProfile,
  searchCols: ["vars->>'os_type'"],
  sortCols: {
    validated: 'checked_at', built: 'applied_at', os: "vars->>'os_type'", config: "vars->>'config_type'",
    steps: "CASE WHEN vars->>'config_type' = 'guided' AND jsonb_typeof(vars->'steps') = 'array' THEN jsonb_array_length(vars->'steps') END",
    targets: "(SELECT string_agg(t->>'name', ', ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(vars->'targets') = 'array' THEN vars->'targets' ELSE '[]'::jsonb END) t)",
  },
  toPublic: (p) => ({ ...publicProfile(p), checked_at: p.checked_at, applied_at: p.applied_at }),
  beforeUpdate: (cur, vars) => ansibleUpdateRefusal(cur.vars, vars),
  beforeDelete: async (id) => {
    const { rows } = await pool.query('SELECT name FROM ansible_schedules WHERE profile_id = $1 ORDER BY name LIMIT 1', [id]);
    return rows[0] ? `Profil utilisé par la planification « ${rows[0].name} » : la supprimer ou changer son profil d'abord` : null;
  },
});

router.get('/api/tofu/importable-vms', auth, handle(async (_req, res) => res.json(await listImportableVms())));

router.post('/api/tofu/profiles/import', auth, auditAction('tofu_vm_imported', {
  target: (req, r) => r?.profile?.name || req.body?.name,
  details: (req, r) => ({ vm_uuid: String(req.body?.vm_id || '').slice(0, 36), job: r?.job?.id }) }), handle(async (req, res) => {
  const name = profileName(req.body);
  const vmId = String(req.body?.vm_id || '').trim();
  if (!UUID_RE.test(vmId)) throw new ValidationError('UUID de la VM invalide');
  const { vars: read, detected } = await readVmForImport(vmId);
  const vars = validateTofuProfile({
    ...read,
    os_type: req.body?.os_type || detected.os_type,
    source_template: String(req.body?.source_template || detected.source_template || '').trim(),
    safe_entry_id: req.body?.safe_entry_id,
  });
  if (vars.os_type === 'windows') {
    const refusal = await windowsAccountRefusal(vars.safe_entry_id);
    if (refusal) throw new ValidationError(refusal);
  }
  let profile;
  try {
    ({ rows: [profile] } = await pool.query('INSERT INTO tofu_profiles (name, description, vars) VALUES ($1, $2, $3) RETURNING *',
      [name, profileDescription(req.body), vars]));
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('Un profil porte déjà ce nom');
    throw e;
  }
  const job = await enqueueTofu(profile, 'import');
  res.status(201).json({ profile: { id: profile.id, name: profile.name, vars: profile.vars }, job: { id: job.id } });
}));
