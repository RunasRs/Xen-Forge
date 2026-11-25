import { getSetting, pool, setSetting } from './db.js';
import { likePattern, orderBy, pageParams, pagedRows } from './lists.js';
import { ValidationError } from './validation.js';

const RETENTION_KEY = 'audit_retention_days';
const RETENTION_LIMITS = { min: 1, max: 3650, default: 120 };
const PURGE_INTERVAL_MS = 3600 * 1000;
const MAX_TEXT = 500;
const MAX_LIST = 100;

const clip = (s) => (s == null ? null : String(s).slice(0, MAX_TEXT));

export function audit(event, { user = null, ip = null, actor = null, outcome = 'success', status = null, target = null, ...details } = {}) {
  pool.query(`INSERT INTO audit_log (at, event, actor, username, ip, outcome, status, target, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [new Date().toISOString(), event, actor || (user ? 'user' : 'anonymous'), user, ip, outcome, status, target ? clip(target) : null, Object.keys(details).length ? details : null])
    .catch((e) => console.error(`journal d'audit : écriture en base impossible (${event}) :`, e.message));
}

export const namesFrom = (sql) => async (ids) => new Map((await pool.query(sql, [ids])).rows.map((r) => [String(r.id), r.name]));
export const sameNames = async (ids) => new Map(ids.map((id) => [id, id]));

const PAST = { enable: 'enabled', disable: 'disabled', delete: 'deleted', cancel: 'cancelled', 'totp-reset': 'totp_reset' };
export const batchEvent = (prefix) => (req) => `${prefix}_${PAST[req.body?.action] || 'batch'}`;
export const createEvent = (prefix) => (req) => `${prefix}_${req.body?.copy_from ? 'cloned' : 'created'}`;

const defaultIds = (req) => {
  if (req.params?.id) return [req.params.id];
  return Array.isArray(req.body?.ids) ? req.body.ids.slice(0, MAX_LIST) : [];
};
const bodyName = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const name = body.name ?? body.username ?? body.host ?? body.domain;
  return typeof name === 'string' ? name : null;
};
const outcomeOf = (status, batch) => {
  if (status >= 500) return 'error';
  if (status >= 400) return 'refused';
  if (batch?.refused.length) return batch.done.length ? 'partial' : 'refused';
  return 'success';
};

export function auditAction(event, { names = null, ids = defaultIds, target = null, context = null, details = null } = {}) {
  return async (req, res, next) => {
    try {
      const wanted = ids(req).filter((x) => x != null && x !== '').map(String);
      const copyFrom = req.body?.copy_from != null ? String(req.body.copy_from) : null;
      const lookup = names ? [...wanted, ...(copyFrom ? [copyFrom] : [])] : [];
      const known = lookup.length ? await names(lookup).catch(() => new Map()) : new Map();
      const before = context ? await context(req).catch(() => null) : null;
      let body;
      const json = res.json.bind(res);
      res.json = (b) => { body = b; return json(b); };
      res.once('finish', () => {
        try {
          const nameOf = (id) => clip(known.get(String(id)) ?? String(id));
          const batch = body && Array.isArray(body.done) && Array.isArray(body.refused) ? body : null;
          const status = res.statusCode;
          const extra = {
            ...(before || {}),
            ...(copyFrom ? { source: nameOf(copyFrom) } : {}),
            ...(details && status < 400 ? details(req, body) || {} : {}),
          };
          if (batch) {
            extra.done = batch.done.slice(0, MAX_LIST).map(nameOf);
            if (batch.refused.length) extra.refused = batch.refused.slice(0, MAX_LIST).map((r) => ({ target: nameOf(r.id), error: clip(r.error) }));
          }
          if (status < 400 && before && 'from' in before && 'to' in extra && extra.from === extra.to) return;
          if (status >= 400 && body?.error) extra.error = clip(body.error);
          const after = bodyName(body) ?? (status >= 400 ? bodyName(req.body) : null);
          const listed = wanted.map(nameOf);
          if (status < 400 && listed.length === 1 && after && after !== listed[0]) extra.renamed_to = after;
          audit(typeof event === 'function' ? event(req) : event, {
            user: req.user || null,
            ip: req.ip,
            outcome: outcomeOf(status, batch),
            status,
            target: (target && target(req, body)) || (listed.length ? listed.join(', ') : after),
            ...extra,
          });
        } catch (e) {
          console.error('journal d\'audit :', e.message);
        }
      });
      next();
    } catch (e) {
      next(e);
    }
  };
}

export async function getAuditSettings() {
  const days = Number(await getSetting(RETENTION_KEY));
  const valid = Number.isInteger(days) && days >= RETENTION_LIMITS.min && days <= RETENTION_LIMITS.max;
  return { retentionDays: valid ? days : RETENTION_LIMITS.default };
}

export async function setAuditSettings(body = {}) {
  const days = body.retentionDays;
  if (!Number.isInteger(days) || days < RETENTION_LIMITS.min || days > RETENTION_LIMITS.max) {
    throw new ValidationError(`Durée de conservation : nombre entier de jours entre ${RETENTION_LIMITS.min} et ${RETENTION_LIMITS.max}`);
  }
  await setSetting(RETENTION_KEY, String(days));
  purgeAudit().catch((e) => console.error('journal d\'audit : purge impossible :', e.message));
  return getAuditSettings();
}

async function purgeAudit() {
  const { retentionDays } = await getAuditSettings();
  const { rowCount } = await pool.query('DELETE FROM audit_log WHERE at < now() - make_interval(days => $1)', [retentionDays]);
  if (rowCount) console.log(`journal d'audit : ${rowCount} entrée(s) de plus de ${retentionDays} jour${retentionDays > 1 ? 's' : ''} supprimée(s)`);
}

export function startAuditPurge() {
  const run = () => purgeAudit().catch((e) => console.error('journal d\'audit : purge impossible :', e.message));
  run();
  return setInterval(run, PURGE_INTERVAL_MS);
}

const OUTCOMES = ['success', 'partial', 'refused', 'error'];

export async function listAudit(req) {
  const params = pageParams(req);
  const { limit, offset, search } = params;
  const outcome = OUTCOMES.includes(req.query.status) ? req.query.status : null;
  const searchCols = ['event', 'username', 'target', 'ip', 'details::text'];
  const [page, { rows: counts }] = await Promise.all([
    pagedRows({ from: 'audit_log', select: 'id, at, event, actor, username, ip, outcome, status, target, details',
      where: outcome ? ['outcome = $1'] : [], params: outcome ? [outcome] : [],
      search, searchCols,
      order: orderBy(params, { at: 'at', event: 'event', user: 'username', outcome: 'outcome', ip: "CASE WHEN pg_input_is_valid(ip, 'inet') THEN ip::inet END", target: 'target', details: 'details::text' }, 'at DESC, id DESC'), limit, offset }),
    search
      ? pool.query(`SELECT outcome, count(*)::int AS n FROM audit_log WHERE ${searchCols.map((c) => `${c} ILIKE $1`).join(' OR ')} GROUP BY outcome`,
        [likePattern(search)])
      : pool.query('SELECT outcome, count(*)::int AS n FROM audit_log GROUP BY outcome'),
  ]);
  return { ...page, counts: Object.fromEntries(counts.map((r) => [r.outcome, r.n])) };
}
