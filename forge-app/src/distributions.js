import { pool } from './db.js';
import { ValidationError } from './validation.js';
import { Refusal, orderBy, pagedRows } from './lists.js';
import { CATALOG_OS } from './os.js';

const VERSION_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
export const KEY_RE = /^[a-z0-9]+\/[A-Za-z0-9][\w.-]{0,63}$/;

const keyOf = (d) => `${d.os}/${d.version}`;
const splitKey = (key) => {
  const i = String(key).indexOf('/');
  return [String(key).slice(0, i), String(key).slice(i + 1)];
};

const select = `d.os, d.version, d.url, d.hash,
  (SELECT count(*)::int FROM profiles p WHERE p.vars->>'iso_url' = d.url) AS profiles`;

function clean(input = {}) {
  const os = String(input.os || '').trim();
  if (!CATALOG_OS.includes(os)) throw new ValidationError(`OS invalide (attendu : ${CATALOG_OS.join(', ')})`);
  const version = String(input.version || '').trim();
  if (!VERSION_RE.test(version)) {
    throw new ValidationError('Version invalide (64 caractères max : lettres, chiffres, . _ -)');
  }
  const url = String(input.url || '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || /\s/.test(url) || url.length > 2048) {
    throw new ValidationError('URL invalide (http:// ou https://, sans espace)');
  }
  const hash = String(input.hash || '').trim().toLowerCase().replace(/^sha256:/, '');
  if (hash && !HASH_RE.test(hash)) throw new ValidationError('Hash invalide : SHA-256 attendu (64 caractères hexadécimaux)');
  return { os, version, url, hash: hash || null };
}

function uniqueError(e) {
  if (e.code !== '23505') return e;
  return new ValidationError(e.constraint === 'distribution_url_key'
    ? 'Cette URL est déjà utilisée par une autre distribution'
    : 'Cette version existe déjà pour cet OS');
}

export const list = (params) => pagedRows({
  from: 'distribution d', select, search: params.search, searchCols: ['d.os', 'd.version', 'd.url', 'd.hash'],
  order: orderBy(params, { version: 'd.version', os: 'd.os', profiles: 'profiles' }, 'd.os, d.version'), limit: params.limit, offset: params.offset,
});

export async function get(key) {
  if (!KEY_RE.test(String(key))) return null;
  const { rows } = await pool.query(`SELECT ${select} FROM distribution d WHERE d.os = $1 AND d.version = $2`, splitKey(key));
  return rows[0] || null;
}

export async function create(input) {
  const d = clean(input);
  try {
    await pool.query('INSERT INTO distribution (os, version, url, hash) VALUES ($1, $2, $3, $4)',
      [d.os, d.version, d.url, d.hash]);
  } catch (e) {
    throw uniqueError(e);
  }
  return get(keyOf(d));
}

const profileChecksum = (hash) => (hash ? `sha256:${hash}` : '');

export async function update(key, input) {
  if (!KEY_RE.test(String(key))) return null;
  const d = clean(input);
  const client = await pool.connect();
  let propagated = 0;
  try {
    await client.query('BEGIN');
    const { rows: [old] } = await client.query(
      'SELECT url, hash FROM distribution WHERE os = $1 AND version = $2 FOR UPDATE', splitKey(key));
    if (!old) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      'UPDATE distribution SET os = $3, version = $4, url = $5, hash = $6 WHERE os = $1 AND version = $2',
      [...splitKey(key), d.os, d.version, d.url, d.hash]);
    if (old.url !== d.url || old.hash !== d.hash) {
      ({ rowCount: propagated } = await client.query(`
        UPDATE profiles SET
          vars = vars || jsonb_build_object('iso_url', $2::text)
            || CASE WHEN lower(coalesce(vars->>'iso_checksum', '')) IN ($3, $4)
               THEN jsonb_build_object('iso_checksum', $5::text) ELSE '{}'::jsonb END,
          validated_at = NULL, built_at = NULL, updated_at = now()
        WHERE vars->>'iso_url' = $1`,
      [old.url, d.url, profileChecksum(old.hash), old.hash || '', profileChecksum(d.hash)]));
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw uniqueError(e);
  } finally {
    client.release();
  }
  return { ...(await get(keyOf(d))), propagated };
}

export async function remove(key) {
  const { rowCount } = await pool.query(`
    DELETE FROM distribution d WHERE d.os = $1 AND d.version = $2
      AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.vars->>'iso_url' = d.url)`, splitKey(key));
  if (rowCount) return true;
  const d = await get(key);
  if (!d) return false;
  throw new Refusal(`« ${d.version} » : utilisée par ${d.profiles} profil${d.profiles > 1 ? 's' : ''}, changer leur ISO d'abord`);
}
