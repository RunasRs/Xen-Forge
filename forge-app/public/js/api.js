import { toast } from './dom.js';
import { plural } from './format.js';

export class SessionExpired extends Error {}

const sendApi = (path, opts) => fetch(`/api${path}`, {
  method: opts.method || 'GET',
  headers: opts.body ? { 'Content-Type': 'application/json' } : {},
  body: opts.body ? JSON.stringify(opts.body) : undefined,
});

export async function api(path, opts = {}) {
  const res = await sendApi(path, opts);
  if (res.status === 401) {
    location.replace('/');
    throw new SessionExpired('Session expirée');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { data });
  return data;
}

export const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { if (!(e instanceof SessionExpired)) toast(e.message); }
};

export const pagedSource = (path) => ({ limit, offset, search, filter, sort }) =>
  api(`${path}?paged=1&limit=${limit}&offset=${offset}&search=${encodeURIComponent(search)}${filter ? `&status=${filter}` : ''}${
    sort ? `&sort=${sort.key}&dir=${sort.dir}` : ''}`);

export const localSource = (load, fields, sorts = {}, groups = null) => async ({ limit, offset, search, filter, sort }) => {
  const all = await load();
  const term = search.toLowerCase();
  let hits = term ? all.filter((r) => fields(r).some((v) => String(v ?? '').toLowerCase().includes(term))) : all;
  const counts = groups && Object.fromEntries(Object.entries(groups).map(([k, test]) => [k, hits.filter(test).length]));
  if (groups?.[filter]) hits = hits.filter(groups[filter]);
  const value = sort && sorts[sort.key];
  if (value) {
    const sign = sort.dir === 'desc' ? -1 : 1;
    hits = [...hits].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      if (x == null || y == null) return (x == null) - (y == null);
      return sign * String(x).localeCompare(String(y), 'fr', { numeric: true });
    });
  }
  return { rows: hits.slice(offset, offset + limit), total: hits.length, ...(counts && { counts }) };
};

export function batchToast(r) {
  const refused = r.refused || [];
  if (!refused.length) return;
  const reasons = [...new Set(refused.map((x) => x.error))];
  toast(`${plural(refused.length, 'refusé')} : ${reasons.join(' ; ')}`);
}

export const batch = (path, action, sel) =>
  api(path, { method: 'POST', body: { action, ids: sel.map((r) => r.id) } }).then(batchToast);
