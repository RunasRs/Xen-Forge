import { Router } from 'express';
import { pool } from '../db.js';
import { auditAction, batchEvent, createEvent, namesFrom } from '../audit.js';
import { auth, handle, notFound } from '../http/session.js';
import { Refusal, batchInput, copyName, orderBy, pageParams, pagedRows, runBatch } from '../lists.js';
import { SCHEDULE_KINDS, checkScheduledProfile, cleanSchedule, nextOccurrence } from '../schedules.js';
import { UUID_RE, ValidationError } from '../validation.js';

export const router = Router();

function scheduleRoutes(base, { table, engine, profiles, jobs, actions = null }, { existingTemplate }) {
  const prefix = `${engine}_schedule`;
  const names = namesFrom(`SELECT id, name FROM ${table} WHERE id::text = ANY($1)`);
  const FROM = `${table} s JOIN ${profiles} p ON p.id = s.profile_id LEFT JOIN ${jobs} j ON j.id = s.last_job_id`;
  const existing = existingTemplate ? "p.vars->>'existing_template'" : 'NULL';
  const COLUMNS = `s.id, s.name, s.profile_id, p.name AS profile_name, ${existing} AS existing_template, s.action, s.mode,
    to_char(s.run_date, 'YYYY-MM-DD') AS run_date, to_char(s.run_time, 'HH24:MI') AS run_time, s.weekdays, s.weeks, s.timezone,
    s.enabled, s.next_run_at, s.last_run_at, s.last_outcome, s.created_at, s.updated_at,
    EXISTS (SELECT 1 FROM ${jobs} b WHERE b.profile_id = s.profile_id AND b.status IN ('queued', 'running')) AS busy,
    CASE WHEN j.id IS NULL THEN NULL
      ELSE json_build_object('id', j.id, 'action', j.action, 'status', j.status, 'created_at', j.created_at) END AS "lastJob"`;

  const load = async (id) => (UUID_RE.test(id)
    ? (await pool.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.id = $1`, [id])).rows[0]
    : null);

  async function save(sql, params) {
    try {
      const { rows } = await pool.query(sql, params);
      return load(rows[0].id);
    } catch (e) {
      if (e.code === '23505') throw new ValidationError('Une planification porte déjà ce nom');
      if (e.code === '23503') throw new ValidationError('Profil introuvable');
      throw e;
    }
  }

  router.get(base, auth, handle(async (req, res) => {
    const params = pageParams(req);
    const { limit, offset, search } = params;
    const page = await pagedRows({ from: FROM, select: COLUMNS, search, searchCols: ['s.name', 'p.name'],
      order: orderBy(params, { name: 's.name', profile: 'p.name', task: 's.action', program: 'ROW(s.mode, s.run_date, s.run_time)',
        active: 's.enabled', next: 's.next_run_at', last: 's.last_run_at' }, 's.name'), limit, offset });
    const { rows: [planned] } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE enabled AND next_run_at IS NOT NULL`);
    res.json({ ...page, planned: planned.n });
  }));

  router.get(`${base}/profiles`, auth, handle(async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, name, ${existingTemplate ? "vars->>'existing_template'" : 'NULL'} AS existing_template FROM ${profiles} ORDER BY name`);
    res.json(rows);
  }));

  router.get(`${base}/:id/clone`, auth, handle(async (req, res) => {
    const cur = await load(req.params.id);
    if (!cur) return notFound(res);
    return res.json({ ...cur, id: undefined, name: await copyName(table, 'name', cur.name), copy_from: cur.id });
  }));

  router.post(base, auth, auditAction(createEvent(prefix), { names }), handle(async (req, res) => {
    const s = cleanSchedule(req.body, actions);
    await checkScheduledProfile(s, profiles);
    res.status(201).json(await save(`INSERT INTO ${table} (name, profile_id, mode, run_date, weekdays, weeks, run_time, timezone, next_run_at, action)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [s.name, s.profile_id, s.mode, s.run_date, s.weekdays, s.weeks, s.run_time, s.timezone, s.next_run_at, s.action]));
  }));

  router.put(`${base}/:id`, auth, auditAction(`${prefix}_modified`, { names }), handle(async (req, res) => {
    if (!(await load(req.params.id))) return notFound(res);
    const s = cleanSchedule(req.body, actions);
    await checkScheduledProfile(s, profiles);
    return res.json(await save(`UPDATE ${table} SET name = $2, profile_id = $3, mode = $4, run_date = $5, weekdays = $6, weeks = $7,
      run_time = $8, timezone = $9, next_run_at = $10, action = $11, last_outcome = NULL, updated_at = now() WHERE id = $1 RETURNING id`,
    [req.params.id, s.name, s.profile_id, s.mode, s.run_date, s.weekdays, s.weeks, s.run_time, s.timezone, s.next_run_at, s.action]));
  }));

  router.post(`${base}/batch`, auth, auditAction(batchEvent(prefix), { names }), handle(async (req, res) => {
    const { action, ids } = batchInput(req.body, ['enable', 'disable', 'delete']);
    res.json(await runBatch(ids, async (id) => {
      if (action === 'delete') {
        const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        if (!rowCount) throw new Refusal('Planification introuvable');
        return id;
      }
      const cur = await load(id);
      if (!cur) throw new Refusal('Planification introuvable');
      if (action === 'disable') {
        if (!cur.enabled) throw new Refusal('Planification déjà désactivée');
        if (!cur.next_run_at) throw new Refusal('Planification terminée');
        await pool.query(`UPDATE ${table} SET enabled = false, updated_at = now() WHERE id = $1`, [id]);
        return id;
      }
      if (cur.enabled) throw new Refusal('Planification déjà activée');
      const next = nextOccurrence(cur);
      if (!next) throw new Refusal('Date et heure déjà passées : modifier la planification');
      await pool.query(`UPDATE ${table} SET enabled = true, next_run_at = $2, updated_at = now() WHERE id = $1`, [id, next]);
      return id;
    }));
  }));
}

scheduleRoutes('/api/schedules', SCHEDULE_KINDS.packer, { existingTemplate: true });
scheduleRoutes('/api/ansible/schedules', SCHEDULE_KINDS.ansible, { existingTemplate: false });
scheduleRoutes('/api/tofu/schedules', SCHEDULE_KINDS.tofu, { existingTemplate: false });
