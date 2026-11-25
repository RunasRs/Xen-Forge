import { pool } from './db.js';
import { ValidationError, UUID_RE } from './validation.js';

const PAGE_SIZES = [20, 50, 100];
const MAX_BATCH = 100;

export const isPaged = (req) => req.query.paged === '1';

export function pageParams(req) {
  const limit = PAGE_SIZES.includes(Number(req.query.limit)) ? Number(req.query.limit) : PAGE_SIZES[0];
  const offset = Math.max(0, Math.floor(Number(req.query.offset)) || 0);
  const search = String(req.query.search || '').trim().slice(0, 100);
  const sort = String(req.query.sort || '');
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  return { limit, offset, search, sort, dir };
}

export const orderBy = ({ sort, dir }, columns, fallback) => (Object.hasOwn(columns, sort)
  ? `${columns[sort]} ${dir} NULLS LAST, ${fallback}`
  : fallback);

export const likePattern = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function whereClause({ where = [], params = [], search = '', searchCols = [] }) {
  const p = [...params];
  const clauses = [...where];
  if (search && searchCols.length) {
    p.push(likePattern(search));
    clauses.push(`(${searchCols.map((c) => `${c} ILIKE $${p.length}`).join(' OR ')})`);
  }
  return { w: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', p };
}

export async function pagedRows({ from, select = '*', order, limit, offset, ...filter }) {
  const { w, p } = whereClause(filter);
  const [{ rows }, { rows: [count] }] = await Promise.all([
    pool.query(`SELECT ${select} FROM ${from} ${w} ORDER BY ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, p),
    pool.query(`SELECT count(*)::int AS n FROM ${from} ${w}`, p),
  ]);
  return { rows, total: count.n };
}

export async function groupedRows(status, { groups, where = [], ...query }) {
  const chosen = Object.hasOwn(groups, status) ? [groups[status]] : Object.values(groups);
  const { w, p } = whereClause({ where, ...query });
  const counts = Object.entries(groups).map(([k, c]) => `count(*) FILTER (WHERE ${c})::int AS "${k}"`).join(', ');
  const [page, { rows: [byGroup] }] = await Promise.all([
    pagedRows({ ...query, where: [...where, `((${chosen.join(') OR (')}))`] }),
    pool.query(`SELECT ${counts} FROM ${query.from} ${w}`, p),
  ]);
  return { ...page, counts: byGroup };
}

export const usageWindow = (params) => (params.sort === 'used' ? { limit: 100000, offset: 0 } : { limit: params.limit, offset: params.offset });

export function usageOrder(rows, params) {
  if (params.sort !== 'used') return rows;
  const sign = params.dir === 'DESC' ? -1 : 1;
  return [...rows].sort((a, b) => sign * (a.used_by.length - b.used_by.length)).slice(params.offset, params.offset + params.limit);
}

export function batchInput(body, actions, isId = (x) => UUID_RE.test(String(x))) {
  const action = String(body?.action || '');
  if (!actions.includes(action)) throw new ValidationError('Action invalide');
  const ids = [...new Set(Array.isArray(body?.ids) ? body.ids : [])];
  if (!ids.length) throw new ValidationError('Aucun élément sélectionné');
  if (ids.length > MAX_BATCH) throw new ValidationError(`${MAX_BATCH} éléments au maximum par action`);
  if (!ids.every(isId)) throw new ValidationError('Identifiant invalide');
  return { action, ids };
}

export class Refusal extends Error {}

export async function runBatch(ids, fn) {
  const done = [];
  const refused = [];
  for (const id of ids) {
    try {
      done.push((await fn(id)) ?? id);
    } catch (e) {
      const known = e instanceof Refusal || e instanceof ValidationError;
      if (!known) console.error('action groupée :', e);
      refused.push({ id, error: known ? e.message : 'Erreur interne' });
    }
  }
  return { done, refused };
}

export async function copyName(table, column, name, max = 100, extraWhere = '', extraParams = []) {
  for (let n = 1; n < 100; n += 1) {
    const suffix = n === 1 ? ' (copie)' : ` (copie ${n})`;
    const candidate = `${String(name).slice(0, max - suffix.length)}${suffix}`;
    const { rows } = await pool.query(
      `SELECT 1 FROM ${table} WHERE ${column} = $1 ${extraWhere} LIMIT 1`, [candidate, ...extraParams]);
    if (!rows.length) return candidate;
  }
  throw new ValidationError('Impossible de trouver un nom libre pour la copie');
}
