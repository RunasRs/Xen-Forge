import fs from 'node:fs';
import { getSetting, pool, setSetting } from './db.js';
import { jobDir } from './jobs.js';
import { tofuJobDir } from './tofu/jobs.js';
import { ansibleJobDir } from './ansible/jobs.js';
import { ValidationError } from './validation.js';

const RETENTION_KEY = 'jobs_retention_days';
const RETENTION_LIMITS = { min: 0, max: 3650, default: 60 };
const PURGE_INTERVAL_MS = 3600 * 1000;
const ACTIVE = ['queued', 'running'];
const ENGINES = [
  ['packer', 'jobs', jobDir],
  ['tofu', 'tofu_jobs', tofuJobDir],
  ['ansible', 'ansible_jobs', ansibleJobDir],
];

const validDays = (days) => Number.isInteger(days) && days >= RETENTION_LIMITS.min && days <= RETENTION_LIMITS.max;

export async function getJobRetention() {
  const stored = await getSetting(RETENTION_KEY);
  const days = stored == null || stored === '' ? NaN : Number(stored);
  return { retentionDays: validDays(days) ? days : RETENTION_LIMITS.default };
}

export async function setJobRetention(body = {}) {
  const days = body.retentionDays;
  if (!validDays(days)) {
    throw new ValidationError(`Durée de conservation : nombre entier de jours entre ${RETENTION_LIMITS.min} (jamais) et ${RETENTION_LIMITS.max}`);
  }
  await setSetting(RETENTION_KEY, String(days));
  purgeJobs().catch((e) => console.error('historique des jobs : purge impossible :', e.message));
  return getJobRetention();
}

async function purgeJobs() {
  const { retentionDays } = await getJobRetention();
  if (!retentionDays) return;
  for (const [engine, table, dir] of ENGINES) {
    const { rows } = await pool.query(
      `DELETE FROM ${table} WHERE status <> ALL($1) AND COALESCE(finished_at, created_at) < now() - make_interval(days => $2) RETURNING id`,
      [ACTIVE, retentionDays],
    );
    for (const { id } of rows) {
      try {
        fs.rmSync(dir(id), { recursive: true, force: true });
      } catch (e) {
        console.error(`historique des jobs ${engine} : dossier ${id} non supprimé :`, e.message);
      }
    }
    if (rows.length) console.log(`historique des jobs ${engine} : ${rows.length} job(s) de plus de ${retentionDays} jour${retentionDays > 1 ? 's' : ''} supprimé(s)`);
  }
}

export function startJobPurge() {
  const run = () => purgeJobs().catch((e) => console.error('historique des jobs : purge impossible :', e.message));
  run();
  return setInterval(run, PURGE_INTERVAL_MS);
}
