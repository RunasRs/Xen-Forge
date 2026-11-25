import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { FILES_DIR, readTree, zip } from '../archive.js';
import { pool } from '../db.js';
import { auditAction, batchEvent, namesFrom } from '../audit.js';
import { auth, currentSession, handle, notFound } from '../http/session.js';
import { cancel, enqueue, jobDir } from '../jobs.js';
import { Refusal, batchInput, isPaged, likePattern, orderBy, pageParams, pagedRows, runBatch } from '../lists.js';
import { ansibleJobDir, cancelAnsible, enqueueAnsible } from '../ansible/jobs.js';
import { cancelTofu, enqueueTofu, tofuJobDir } from '../tofu/jobs.js';
import { stripAnsi } from '../runner.js';
import { tofuStateSummary } from '../tofu/state.js';
import { UUID_RE, ValidationError } from '../validation.js';

export const router = Router();

const ACTIVE = ['queued', 'running'];

const STATUS_LABELS = { queued: 'en attente', running: 'en cours', success: 'réussi', failed: 'échec', cancelled: 'annulé' };
const STATUS_FILTERS = { active: ACTIVE, success: ['success'], failed: ['failed'], cancelled: ['cancelled'] };
const statusFilter = (status) => (Object.hasOwn(STATUS_FILTERS, status) ? STATUS_FILTERS[status] : null);
const labelMatches = (labels, term) => Object.entries(labels)
  .filter(([, label]) => label.toLowerCase().includes(term.toLowerCase())).map(([value]) => value);

const LOG_POLL_MS = 700;

function streamJobLog(table, req, res) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const decoder = new StringDecoder('utf8');
  let offset = 0;
  let closed = false;
  let failing = false;
  req.on('close', () => { closed = true; });
  const readNewBytes = (file, size) => {
    const buffer = Buffer.alloc(size - offset);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
    offset = size;
    return decoder.write(buffer);
  };
  const tick = async () => {
    if (closed) return undefined;
    try {
      if (!(await currentSession(req))) return res.end();
      const { rows } = await pool.query(`SELECT status, log_path FROM ${table} WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.end();
      const file = rows[0].log_path && fs.existsSync(rows[0].log_path) ? rows[0].log_path : null;
      const size = file ? fs.statSync(file).size : 0;
      if (size > offset) res.write(`data: ${JSON.stringify(readNewBytes(file, size))}\n\n`);
      if (!ACTIVE.includes(rows[0].status)) {
        res.write(`event: end\ndata: ${rows[0].status}\n\n`);
        return res.end();
      }
      failing = false;
    } catch (e) {
      if (!failing) console.error(`${table} ${req.params.id} : journal en direct indisponible :`, e.message);
      failing = true;
    }
    setTimeout(tick, LOG_POLL_MS);
    return undefined;
  };
  return tick();
}

function archiveEntries(job, jobDirectory, archiveFiles) {
  const filesDir = path.join(jobDirectory, FILES_DIR);
  const files = fs.existsSync(filesDir) ? readTree(filesDir) : [];
  const vars = Object.entries(job.vars_snapshot || {})
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  return [
    ...(job.log_path && fs.existsSync(job.log_path) ? [['job.log', stripAnsi(fs.readFileSync(job.log_path, 'utf8'))]] : []),
    ...files,
    ['variables.txt', `${vars}\n`],
    ...(archiveFiles ? archiveFiles(job) : []),
  ];
}

const ENGINES = { jobs: 'packer', tofu_jobs: 'tofu', ansible_jobs: 'ansible' };

function jobRoutes(base, { table, profiles, actions, columns, searchCols, sortCols, enqueueJob, cancelJob, canLaunch, logName, dir, archiveFiles }) {
  const engine = ENGINES[table];
  const profileNames = namesFrom(`SELECT id, name FROM ${profiles} WHERE id::text = ANY($1)`);
  const jobNames = namesFrom(`SELECT id, concat_ws(' · ', vars_snapshot->>'profile', action, to_char(created_at, 'YYYY-MM-DD HH24:MI')) AS name
    FROM ${table} WHERE id::text = ANY($1)`);
  const launchEvent = (req) => `${engine}_${Object.hasOwn(actions, req.body?.action) ? req.body.action : 'job'}_launched`;
  const jobAudit = (verb, extra = {}) => auditAction(`${engine}_job_${verb}`, { names: jobNames, ...extra });
  const withJob = (handler) => handle(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return notFound(res);
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    return rows[0] ? handler(rows[0], req, res) : notFound(res);
  });
  const listColumns = `id, profile_id, action, status, exit_code, created_at, started_at, finished_at,
    vars_snapshot->>'profile' AS profile, ${columns}`;

  router.get(base, auth, handle(async (req, res) => {
    if (!isPaged(req)) {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const { rows } = await pool.query(`SELECT ${listColumns} FROM ${table} ORDER BY created_at DESC LIMIT $1`, [limit]);
      return res.json(rows);
    }
    const paging = pageParams(req);
    const { limit, offset, search } = paging;
    const where = [];
    const params = [];
    if (search) {
      params.push(likePattern(search), labelMatches(STATUS_LABELS, search), labelMatches(actions, search));
      where.push(`(${['vars_snapshot->>\'profile\'', ...searchCols].map((c) => `${c} ILIKE $1`).join(' OR ')}
        OR status = ANY($2) OR action = ANY($3))`);
    }
    const statuses = statusFilter(req.query.status);
    const filtered = statuses ? [...where, `status = ANY($${params.length + 1})`] : where;
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [page, { rows: byStatus }] = await Promise.all([
      pagedRows({ from: table, select: listColumns, where: filtered, params: statuses ? [...params, statuses] : params,
        order: orderBy(paging, { status: 'status', job: "vars_snapshot->>'profile'", duration: 'finished_at - started_at', created: 'created_at', ...sortCols },
          'created_at DESC'), limit, offset }),
      pool.query(`SELECT status, count(*)::int AS n FROM ${table} ${w} GROUP BY status`, params),
    ]);
    res.json({ ...page, counts: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) });
  }));

  let launching = Promise.resolve();
  const launchOne = (profileId, action, launcher = null) => {
    const run = launching.then(async () => {
      const { rows } = await pool.query(`SELECT * FROM ${profiles} WHERE id = $1`, [profileId]);
      const profile = rows[0];
      if (!profile) throw new Refusal('Profil introuvable');
      const { rows: busy } = await pool.query(
        `SELECT 1 FROM ${table} WHERE profile_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [profileId]);
      if (busy.length) throw new Refusal(`« ${profile.name} » : un job est déjà en attente ou en cours`);
      const refusal = canLaunch ? await canLaunch(profile, action) : null;
      if (refusal) throw new Refusal(`« ${profile.name} » : ${refusal}`);
      return enqueueJob(profile, action, launcher);
    });
    launching = run.catch(() => {});
    return run;
  };
  const checkAction = (action) => {
    if (!Object.hasOwn(actions, action)) throw new ValidationError('Action invalide');
    return action;
  };

  router.post(base, auth, auditAction(launchEvent, { names: profileNames, ids: (req) => [req.body?.profileId],
    details: (_req, job) => ({ job: job?.id }) }), handle(async (req, res) => {
    const { profileId, action } = req.body || {};
    checkAction(action);
    if (!UUID_RE.test(String(profileId))) throw new ValidationError('Profil invalide');
    try {
      res.status(201).json(await launchOne(profileId, action, { user: req.user, ip: req.ip }));
    } catch (e) {
      if (e instanceof Refusal) return res.status(409).json({ error: e.message });
      throw e;
    }
  }));

  router.post(`${base}/launch`, auth, auditAction(launchEvent, { names: profileNames }), handle(async (req, res) => {
    const { ids } = batchInput(req.body, Object.keys(actions));
    const action = checkAction(req.body.action);
    res.json(await runBatch(ids, async (pid) => (await launchOne(pid, action, { user: req.user, ip: req.ip })).id));
  }));

  router.post(`${base}/batch`, auth, auditAction(batchEvent(`${engine}_job`), { names: jobNames }), handle(async (req, res) => {
    const { action, ids } = batchInput(req.body, ['cancel', 'delete']);
    res.json(await runBatch(ids, async (jid) => {
      const { rows } = await pool.query(`SELECT id, status FROM ${table} WHERE id = $1`, [jid]);
      if (!rows[0]) throw new Refusal('Job introuvable');
      const isActive = ACTIVE.includes(rows[0].status);
      if (action === 'cancel') {
        if (!isActive) throw new Refusal('Job déjà terminé');
        if (!(await cancelJob(jid))) throw new Refusal('Annulation impossible');
        return jid;
      }
      if (isActive) throw new Refusal('Job en attente ou en cours : l\'annuler avant de le supprimer');
      const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id = $1 AND status <> ALL($2)`, [jid, ACTIVE]);
      if (!rowCount) throw new Refusal('Job relancé entre-temps');
      fs.rmSync(dir(jid), { recursive: true, force: true });
      return jid;
    }));
  }));

  router.post(`${base}/:id/clone`, auth, jobAudit('relaunched', { details: (_req, job) => ({ job: job?.id }) }), withJob(async (job, req, res) => {
    if (!job.profile_id) return res.status(409).json({ error: 'Profil supprimé : relance impossible' });
    try {
      res.status(201).json(await launchOne(job.profile_id, job.action, { user: req.user, ip: req.ip }));
    } catch (e) {
      if (e instanceof Refusal) return res.status(409).json({ error: e.message });
      throw e;
    }
  }));

  router.get(`${base}/:id`, auth, handle(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return notFound(res);
    const { rows } = await pool.query(`SELECT ${listColumns} FROM ${table} WHERE id = $1`, [req.params.id]);
    return rows[0] ? res.json(rows[0]) : notFound(res);
  }));

  router.post(`${base}/:id/cancel`, auth, jobAudit('cancelled', { details: (_req, r) => ({ cancelled: r?.ok }) }), withJob(async (job, _req, res) => res.json({ ok: await cancelJob(job.id) })));

  router.get(`${base}/:id/log`, auth, jobAudit('log_downloaded'), withJob((job, _req, res) => {
    if (!job.log_path || !fs.existsSync(job.log_path)) return res.status(404).json({ error: 'Pas de log' });
    res.set('Content-Disposition', `attachment; filename="${logName}-${job.id}.log"`);
    res.type('text/plain').send(stripAnsi(fs.readFileSync(job.log_path, 'utf8')));
  }));

  router.get(`${base}/:id/archive`, auth, jobAudit('archive_downloaded'), withJob((job, _req, res) => {
    res.set('Content-Disposition', `attachment; filename="${logName}-${job.id}.zip"`);
    res.type('application/zip').send(zip(archiveEntries(job, dir(job.id), archiveFiles)));
  }));

  router.get(`${base}/:id/logs`, auth, (req, res) => streamJobLog(table, req, res));

  return launchOne;
}

export const launchPackerJob = jobRoutes('/api/jobs', {
  table: 'jobs', profiles: 'profiles', actions: { validate: 'validation', build: 'construction' },
  columns: "vars_snapshot->>'vm_name' AS vm_name", searchCols: ["vars_snapshot->>'vm_name'"], sortCols: { vm: "vars_snapshot->>'vm_name'" },
  enqueueJob: (profile, action, launcher) => enqueue(profile, action, launcher),
  cancelJob: cancel, logName: 'job', dir: jobDir,
});

export const launchTofuJob = jobRoutes('/api/tofu/jobs', {
  table: 'tofu_jobs', profiles: 'tofu_profiles', actions: { plan: 'validation', apply: 'construction', import: 'import', destroy: 'destruction' },
  columns: "vars_snapshot->>'vm_name' AS vm_name", searchCols: ["vars_snapshot->>'vm_name'"], sortCols: { vm: "vars_snapshot->>'vm_name'" },
  enqueueJob: (profile, action) => enqueueTofu(profile, action),
  canLaunch: async (profile, action) => {
    if (action !== 'destroy' && action !== 'import') return null;
    const st = await tofuStateSummary(profile.id, { fresh: true }).catch(() => null);
    if (action === 'import') {
      if (!profile.vars?.vm_uuid) return 'import réservé aux profils créés par « Importer une VM »';
      return st?.resources ? 'VM déjà gérée par le profil : rien à importer' : null;
    }
    return st?.resources ? null : 'aucune VM déployée à détruire';
  },
  cancelJob: cancelTofu, logName: 'tofu-job', dir: tofuJobDir,
});

export const launchAnsibleJob = jobRoutes('/api/ansible/jobs', {
  table: 'ansible_jobs', profiles: 'ansible_profiles', actions: { ping: 'test de connexion', check: 'vérification', apply: 'application' },
  columns: "jsonb_array_length(COALESCE(vars_snapshot->'targets', '[]'::jsonb)) AS target_count", searchCols: [],
  sortCols: { targets: "jsonb_array_length(COALESCE(vars_snapshot->'targets', '[]'::jsonb))" },
  enqueueJob: (profile, action) => enqueueAnsible(profile, action),
  canLaunch: async (profile) => (profile.vars?.targets?.length ? null : 'aucune cible : ajouter un serveur dans l\'onglet Cibles'),
  cancelJob: cancelAnsible, logName: 'ansible-job', dir: ansibleJobDir,
  archiveFiles: (job) => (job.recap ? [['recapitulatif.json', `${JSON.stringify(job.recap, null, 2)}\n`]] : []),
});
