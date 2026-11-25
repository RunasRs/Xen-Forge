import crypto from 'node:crypto';
import { pool } from './db.js';

export const DEVICE_TTL_MS = 90 * 24 * 3600 * 1000;
const MAX_FAILURES = 5;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
const valid = (token) => typeof token === 'string' && TOKEN_RE.test(token);

export const accountOf = (login, source) => `${String(login || '').trim().toLowerCase()}|${source}`;

export async function isTrusted(token, account) {
  if (!valid(token)) return false;
  const { rowCount } = await pool.query(`
    SELECT 1 FROM trusted_devices
    WHERE token_hash = $1 AND account = $2 AND created_at > now() - $3 * interval '1 millisecond'`,
  [hashOf(token), account, DEVICE_TTL_MS]);
  return rowCount > 0;
}

export async function trust(token, account) {
  const kept = valid(token) ? token : crypto.randomBytes(32).toString('base64url');
  await pool.query(`
    INSERT INTO trusted_devices (token_hash, account) VALUES ($1, $2)
    ON CONFLICT (token_hash, account) DO UPDATE SET failures = 0, last_used_at = now()`,
  [hashOf(kept), account]);
  return kept;
}

export async function recordFailure(token, account) {
  if (!valid(token)) return;
  const { rows } = await pool.query(`
    UPDATE trusted_devices SET failures = failures + 1
    WHERE token_hash = $1 AND account = $2 RETURNING failures`, [hashOf(token), account]);
  if (rows[0]?.failures >= MAX_FAILURES) {
    await pool.query('DELETE FROM trusted_devices WHERE token_hash = $1 AND account = $2', [hashOf(token), account]);
  }
}

export const revoke = (account) => pool.query('DELETE FROM trusted_devices WHERE account = $1', [account]);

export const purgeDevices = () =>
  pool.query("DELETE FROM trusted_devices WHERE created_at <= now() - $1 * interval '1 millisecond'", [DEVICE_TTL_MS]);
