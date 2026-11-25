import { pool } from './db.js';
import { audit } from './audit.js';
import { Refusal } from './lists.js';
import { UUID_RE, ValidationError } from './validation.js';

const TICK_MS = 20 * 1000;
const MISSED_TOLERANCE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const SEARCH_DAYS = 70;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const SCHEDULE_KINDS = {
  packer: { engine: 'packer', table: 'schedules', profiles: 'profiles', jobs: 'jobs', action: 'build' },
  ansible: { engine: 'ansible', table: 'ansible_schedules', profiles: 'ansible_profiles', jobs: 'ansible_jobs', action: 'apply' },
  tofu: { engine: 'tofu', table: 'tofu_schedules', profiles: 'tofu_profiles', jobs: 'tofu_jobs', action: 'apply', actions: ['apply', 'destroy'] },
};

function localParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function offsetAt(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = wall - offsetAt(wall - DAY_MS, timeZone);
  const after = wall - offsetAt(wall + DAY_MS, timeZone);
  const exact = [Math.min(before, after), Math.max(before, after)].find((ms) => ms + offsetAt(ms, timeZone) === wall);
  return exact ?? before;
}

const timeOf = (value) => String(value).split(':').map(Number);

export function nextOccurrence(schedule, after = Date.now()) {
  const [hour, minute] = timeOf(schedule.run_time);
  if (schedule.mode === 'once') {
    const [, y, m, d] = DATE_RE.exec(schedule.run_date).map(Number);
    const ms = zonedToUtc(y, m, d, hour, minute, schedule.timezone);
    return ms > after ? new Date(ms) : null;
  }
  const today = localParts(after, schedule.timezone);
  for (let i = 0; i < SEARCH_DAYS; i += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const week = Math.ceil(date.getUTCDate() / 7);
    if (schedule.weekdays.includes(date.getUTCDay() || 7) && (!schedule.weeks || schedule.weeks.includes(week))) {
      const ms = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, schedule.timezone);
      if (ms > after) return new Date(ms);
    }
  }
  return null;
}

function cleanTimezone(value) {
  const timezone = String(value || '');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new ValidationError('Fuseau horaire invalide');
  }
  if (!timezone) throw new ValidationError('Fuseau horaire invalide');
  return timezone;
}

function cleanList(value, max, label) {
  if (!Array.isArray(value) || !value.length) throw new ValidationError(`Sélectionner au moins ${label}`);
  const list = [...new Set(value.map(Number))].sort((a, b) => a - b);
  if (!list.every((n) => Number.isInteger(n) && n >= 1 && n <= max)) throw new ValidationError(`Sélection invalide : ${label}`);
  return list;
}

function cleanDate(value) {
  const match = DATE_RE.exec(String(value || ''));
  if (!match) throw new ValidationError('Date d\'exécution obligatoire');
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new ValidationError('Date d\'exécution invalide');
  return match[0];
}

export function cleanSchedule(body, actions = null) {
  const name = String(body?.name || '').trim();
  if (!name || name.length > 100) throw new ValidationError('Nom de la planification obligatoire (100 caractères max)');
  if (!UUID_RE.test(String(body?.profile_id))) throw new ValidationError('Profil obligatoire');
  const mode = body?.mode;
  if (mode !== 'once' && mode !== 'recurring') throw new ValidationError('Programmation invalide');
  const run_time = String(body?.time || '');
  if (!TIME_RE.test(run_time)) throw new ValidationError('Heure d\'exécution invalide (HH:MM)');
  const timezone = cleanTimezone(body?.timezone);
  if (actions && !actions.includes(body?.action)) throw new ValidationError('Tâche obligatoire : Construire ou Détruire');
  const action = actions ? body.action : null;
  const schedule = mode === 'once'
    ? { name, profile_id: body.profile_id, action, mode, run_date: cleanDate(body?.date), weekdays: null, weeks: null, run_time, timezone }
    : { name, profile_id: body.profile_id, action, mode, run_date: null, run_time, timezone,
      weekdays: cleanList(body?.weekdays, 7, 'un jour de la semaine'),
      weeks: body?.weeks === null ? null : cleanList(body?.weeks, 4, 'une semaine') };
  const next = nextOccurrence(schedule);
  if (!next) throw new ValidationError('La date et l\'heure d\'exécution sont déjà passées');
  return { ...schedule, next_run_at: next };
}

export async function checkScheduledProfile(schedule, profiles) {
  const { rowCount } = await pool.query(`SELECT 1 FROM ${profiles} WHERE id = $1`, [schedule.profile_id]);
  if (!rowCount) throw new ValidationError('Profil introuvable');
}

const row = `id, name, profile_id, action, mode, to_char(run_date, 'YYYY-MM-DD') AS run_date, to_char(run_time, 'HH24:MI') AS run_time,
  weekdays, weeks, timezone, next_run_at`;

async function fire(schedule, { engine, table, action, launch }) {
  const late = Date.now() - schedule.next_run_at.getTime();
  const next = schedule.mode === 'once' ? null : nextOccurrence(schedule);
  const { rowCount } = await pool.query(
    `UPDATE ${table} SET next_run_at = $2 WHERE id = $1 AND enabled AND next_run_at <= now()`, [schedule.id, next]);
  if (!rowCount) return;
  let jobId = null;
  let outcome = null;
  if (late > MISSED_TOLERANCE_MS) {
    outcome = 'Exécution manquée : application arrêtée à l\'heure prévue';
  } else {
    try {
      jobId = (await launch(schedule.profile_id, schedule.action || action)).id;
    } catch (e) {
      if (!(e instanceof Refusal)) console.error(`planification ${schedule.name} :`, e);
      outcome = e instanceof Refusal ? `Non lancée : ${e.message}` : 'Non lancée : erreur interne';
    }
  }
  await pool.query(`UPDATE ${table} SET last_run_at = now(), last_job_id = COALESCE($2, last_job_id), last_outcome = $3 WHERE id = $1`,
    [schedule.id, jobId, outcome]);
  audit(`${engine}_schedule_triggered`, { actor: 'system', outcome: jobId ? 'success' : 'refused', target: schedule.name,
    profile_id: schedule.profile_id, action: schedule.action || action, job: jobId, result: outcome });
}

export function startScheduler(launchers) {
  const kinds = Object.entries(launchers).map(([kind, launch]) => ({ ...SCHEDULE_KINDS[kind], launch }));
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const kind of kinds) {
        const { rows } = await pool.query(`SELECT ${row} FROM ${kind.table} WHERE enabled AND next_run_at <= now() ORDER BY next_run_at`);
        for (const schedule of rows) await fire(schedule, kind);
      }
    } catch (e) {
      console.error('planificateur :', e);
    } finally {
      ticking = false;
    }
  };
  tick();
  setInterval(tick, TICK_MS).unref();
}
