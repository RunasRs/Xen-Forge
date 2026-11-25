import crypto from 'node:crypto';
import { pool } from './db.js';

const IDLE_TIMEOUT = '1 hour';
const TOUCH_INTERVAL = '1 minute';
const DOMAIN_RECHECK_INTERVAL = '15 minutes';

export async function createSession(username, type, ttlMs) {
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (jti, username, type, expires_at) VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')`,
    [jti, username, type, ttlMs]);
  return jti;
}

export async function activeSession(jti) {
  const { rows } = await pool.query(`
    SELECT username, type, last_seen < now() - interval '${TOUCH_INTERVAL}' AS stale,
      checked_at < now() - interval '${DOMAIN_RECHECK_INTERVAL}' AS recheck
    FROM sessions WHERE jti = $1 AND expires_at > now() AND last_seen > now() - interval '${IDLE_TIMEOUT}'`, [jti]);
  if (!rows[0]) return null;
  if (rows[0].stale) await pool.query('UPDATE sessions SET last_seen = now() WHERE jti = $1', [jti]);
  return rows[0];
}

export const closeSession = (jti) => pool.query('DELETE FROM sessions WHERE jti = $1', [jti]);

export const markChecked = (jti) => pool.query('UPDATE sessions SET checked_at = now() WHERE jti = $1', [jti]);

export const closeLocalSessions = (username) => pool.query("DELETE FROM sessions WHERE type = 'local' AND username = $1", [username]);

export const closeDomainSessions = (domain) => pool.query(
  "DELETE FROM sessions WHERE type = 'domain' AND lower(right(username, length($1) + 1)) = '@' || lower($1)", [domain]);

export const closeDomainSession = (login) => pool.query(
  "DELETE FROM sessions WHERE type = 'domain' AND lower(username) = lower($1)", [login]);

export const purgeSessions = () =>
  pool.query(`DELETE FROM sessions WHERE expires_at <= now() OR last_seen <= now() - interval '${IDLE_TIMEOUT}'`);
