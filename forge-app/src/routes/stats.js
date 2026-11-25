import { Router } from 'express';
import { pool } from '../db.js';
import { ansibleRunnerStatus } from '../ansible/jobs.js';
import { auth, handle } from '../http/session.js';
import { tofuStateSummary } from '../tofu/state.js';
import { xoStatus } from '../tofu/xo.js';
import { xcpStatus } from '../xcp.js';

export const router = Router();

const STATS_DAYS = 14;
async function engineStats({ jobsTable, profilesTable, schedulesTable, mainAction, tz }) {
  const inWindow = `created_at >= now() - interval '${STATS_DAYS} days'`;
  const [{ rows: [live] }, { rows: [p] }, { rows: [recent] }, { rows: [avg] }, { rows: activity }, { rows: [sched] }] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE status = 'running')::int AS running,
                       count(*) FILTER (WHERE status = 'queued')::int AS queued
                FROM ${jobsTable} WHERE status IN ('running', 'queued')`),
    pool.query(`SELECT count(*)::int AS n FROM ${profilesTable}`),
    pool.query(`SELECT count(*) FILTER (WHERE status = 'success')::int AS success,
                       count(*) FILTER (WHERE status = 'failed')::int AS failed
                FROM ${jobsTable} WHERE ${inWindow}`),
    pool.query(`SELECT round(avg(extract(epoch FROM finished_at - started_at)))::int AS seconds, count(*)::int AS n
                FROM ${jobsTable} WHERE status = 'success' AND action = $1 AND started_at IS NOT NULL AND ${inWindow}`, [mainAction]),
    pool.query(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
                       count(j.id) FILTER (WHERE j.status = 'success')::int AS success,
                       count(j.id) FILTER (WHERE j.status = 'failed')::int AS failed,
                       count(j.id) FILTER (WHERE j.status = 'cancelled')::int AS cancelled,
                       count(j.id) FILTER (WHERE j.status IN ('queued', 'running'))::int AS active
                FROM generate_series((now() AT TIME ZONE $1)::date - ${STATS_DAYS - 1}, (now() AT TIME ZONE $1)::date, interval '1 day') AS d
                LEFT JOIN ${jobsTable} j ON (j.created_at AT TIME ZONE $1)::date = d::date
                GROUP BY d ORDER BY d`, [tz]),
    pool.query(`SELECT count(*)::int AS active, min(next_run_at) AS next_run_at
                FROM ${schedulesTable} WHERE enabled AND next_run_at IS NOT NULL`),
  ]);
  return {
    profiles: p.n,
    running: live.running,
    queued: live.queued,
    window_days: STATS_DAYS,
    recent,
    avg_seconds: avg.n ? avg.seconds : null,
    avg_count: avg.n,
    activity,
    schedules: { active: sched.active, next_run_at: sched.next_run_at },
  };
}

const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));
const statsTimeZone = (tz) => (typeof tz === 'string' && TIME_ZONES.has(tz) ? tz : 'UTC');

router.get('/api/stats', auth, handle(async (req, res) => {
  const tz = statsTimeZone(req.query.tz);
  const [packer, tofu, ansible, { rows: tofuProfiles }, { rows: [built] }, { rows: [applied] }] = await Promise.all([
    engineStats({ jobsTable: 'jobs', profilesTable: 'profiles', schedulesTable: 'schedules', mainAction: 'build', tz }),
    engineStats({ jobsTable: 'tofu_jobs', profilesTable: 'tofu_profiles', schedulesTable: 'tofu_schedules', mainAction: 'apply', tz }),
    engineStats({ jobsTable: 'ansible_jobs', profilesTable: 'ansible_profiles', schedulesTable: 'ansible_schedules', mainAction: 'apply', tz }),
    pool.query('SELECT id FROM tofu_profiles'),
    pool.query(`SELECT count(DISTINCT profile_id)::int AS n FROM jobs
                WHERE action = 'build' AND status = 'success' AND profile_id IS NOT NULL`),
    pool.query('SELECT count(*)::int AS n FROM ansible_profiles WHERE applied_at IS NOT NULL'),
  ]);
  packer.built = built.n;
  packer.infra = await xcpStatus().catch((e) => ({ state: 'down', error: e.message }));
  tofu.infra = xoStatus();
  const states = await Promise.all(tofuProfiles.map((r) => tofuStateSummary(r.id).catch(() => null)));
  tofu.deployed = states.filter((st) => (st?.resources || 0) > 0).length;
  ansible.applied = applied.n;
  ansible.infra = ansibleRunnerStatus();
  res.json({ packer, tofu, ansible });
}));
