import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, pool } from './db.js';
import { UUID_RE, ValidationError } from './validation.js';
import { hashPassword, needsRehash, verifyPassword } from './crypto.js';
import * as devices from './devices.js';
import { closeLocalSessions } from './sessions.js';
import { openEnrollment } from './totp.js';
import { getPasswordPolicy, passwordProblem } from './passwordpolicy.js';

const USERNAME_RE = /^[\w.-]{3,64}$/;
const INITIAL_ADMIN = 'admin';
const INITIAL_PASSWORD_FILE = path.join(DATA_DIR, 'initial-admin-password');
const UNKNOWN_ACCOUNT_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

const cleanUsername = (username) => {
  const u = String(username || '').trim();
  if (!USERNAME_RE.test(u)) throw new ValidationError('Identifiant invalide (3 à 64 caractères : lettres, chiffres, . _ -)');
  return u;
};

async function cleanPassword(password, username) {
  const p = typeof password === 'string' ? password : '';
  const problem = passwordProblem(p, await getPasswordPolicy(), username);
  if (problem) throw new ValidationError(problem);
  return p;
}

const publicColumns = 'id, username, is_active, must_change_password, created_at, updated_at';

export async function get(id) {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await pool.query(`SELECT ${publicColumns} FROM local_users WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function count() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM local_users');
  return rows[0].n;
}

export async function create({ username, password, must_change_password: mustChange = true }) {
  const u = cleanUsername(username);
  const p = await cleanPassword(password, u);
  const hash = await hashPassword(p);
  try {
    const { rows } = await pool.query(`
      INSERT INTO local_users (username, password_hash, must_change_password) VALUES ($1, $2, $3)
      RETURNING ${publicColumns}`, [u, hash, Boolean(mustChange)]);
    await openEnrollment(u, 'local');
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('Cet identifiant est déjà utilisé');
    throw e;
  }
}

async function writeAdmin(onConflict) {
  const password = crypto.randomBytes(18).toString('base64url');
  await fs.writeFile(INITIAL_PASSWORD_FILE, `${INITIAL_ADMIN} : ${password}\n`, { mode: 0o600 });
  const { rows } = await pool.query(`
    INSERT INTO local_users (username, password_hash, must_change_password) VALUES ($1, $2, TRUE)
    ON CONFLICT (username) ${onConflict} RETURNING ${publicColumns}`,
  [INITIAL_ADMIN, await hashPassword(password)]);
  if (rows[0]) await openEnrollment(INITIAL_ADMIN, 'local');
  return rows[0] || null;
}

export async function seedAdmin() {
  return (await count()) > 0 ? null : writeAdmin('DO NOTHING');
}

export async function resetAdmin() {
  await revokeDevices(INITIAL_ADMIN);
  await closeLocalSessions(INITIAL_ADMIN);
  await pool.query('DELETE FROM totp_users WHERE username = $1 AND user_type = \'local\'', [INITIAL_ADMIN]);
  return writeAdmin(`DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change_password = TRUE, is_active = TRUE,
      password_changed_at = now(), updated_at = now()`);
}

const clearInitialPassword = (username) => username === INITIAL_ADMIN && fs.rm(INITIAL_PASSWORD_FILE, { force: true });
const revokeDevices = (username) => devices.revoke(devices.accountOf(username, 'local'));

async function findHash(username) {
  const { rows } = await pool.query(
    'SELECT id, password_hash, is_active, must_change_password FROM local_users WHERE username = $1',
    [String(username || '').trim()]);
  return rows[0] || null;
}

export async function authenticate(username, password) {
  const row = await findHash(username);
  const known = Boolean(row?.is_active);
  const valid = await verifyPassword(String(password || ''), known ? row.password_hash : UNKNOWN_ACCOUNT_HASH);
  if (!known || !valid) return false;
  if (needsRehash(row.password_hash)) {
    await pool.query('UPDATE local_users SET password_hash = $2 WHERE id = $1', [row.id, await hashPassword(String(password))]);
  }
  return true;
}

export async function loginState(username) {
  const row = await findHash(username);
  return row && row.is_active ? { id: row.id, mustChange: row.must_change_password } : null;
}

export async function passwordCompliant(username, password) {
  return !passwordProblem(password, await getPasswordPolicy(), username);
}

export async function requirePasswordChange(username) {
  const { rowCount } = await pool.query(`UPDATE local_users SET must_change_password = TRUE, updated_at = now()
    WHERE username = $1 AND is_active AND NOT must_change_password`, [username]);
  return rowCount > 0;
}

export async function sessionValid(username, issuedAt) {
  if (!Number.isFinite(issuedAt)) return false;
  const { rows } = await pool.query(
    'SELECT is_active, must_change_password, password_changed_at FROM local_users WHERE username = $1', [username]);
  const row = rows[0];
  return Boolean(row && row.is_active && !row.must_change_password && row.password_changed_at.getTime() <= issuedAt);
}

export async function changeRequiredPassword(id, newPassword) {
  const row = UUID_RE.test(String(id)) && (await pool.query(
    'SELECT username, password_hash FROM local_users WHERE id = $1 AND is_active AND must_change_password', [id])).rows[0];
  if (!row) return null;
  const p = await cleanPassword(newPassword, row.username);
  if (await verifyPassword(p, row.password_hash)) throw new ValidationError('Le nouveau mot de passe doit être différent de l\'actuel');
  const { rows } = await pool.query(`
    UPDATE local_users SET password_hash = $2, must_change_password = FALSE, password_changed_at = now(), updated_at = now()
    WHERE id = $1 AND is_active AND must_change_password RETURNING username`, [id, await hashPassword(p)]);
  if (rows[0]) {
    await clearInitialPassword(rows[0].username);
    await revokeDevices(rows[0].username);
  }
  return rows[0]?.username || null;
}

export async function update(id, { password, is_active, must_change_password: mustChange }) {
  const cur = await get(id);
  if (!cur) throw new ValidationError('Administrateur introuvable');
  const changes = {};
  if (password !== undefined && String(password || '') !== '') {
    changes.password_hash = await hashPassword(await cleanPassword(password, cur.username));
  }
  if (is_active !== undefined) changes.is_active = Boolean(is_active);
  if (mustChange !== undefined) changes.must_change_password = Boolean(mustChange);
  const keys = Object.keys(changes);
  if (!keys.length) return cur;
  const stamp = changes.password_hash ? ', password_changed_at = now()' : '';
  const { rows } = await pool.query(`
    UPDATE local_users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}${stamp}, updated_at = now()
    WHERE id = $1 RETURNING ${publicColumns}`,
    [id, ...keys.map((k) => changes[k])]);
  if (changes.password_hash) await clearInitialPassword(cur.username);
  if (changes.password_hash || changes.is_active === false) await revokeDevices(cur.username);
  return rows[0];
}

export async function remove(id) {
  if (!UUID_RE.test(id)) throw new ValidationError('Administrateur introuvable');
  const cur = await get(id);
  if (!cur) throw new ValidationError('Administrateur introuvable');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM local_users WHERE is_active');
  if (cur.is_active && rows[0].n <= 1) {
    throw new ValidationError('Impossible de supprimer le dernier administrateur actif');
  }
  await pool.query('DELETE FROM totp_users WHERE username = $1 AND user_type = \'local\'', [cur.username]);
  await pool.query('DELETE FROM local_users WHERE id = $1', [id]);
  await clearInitialPassword(cur.username);
  await revokeDevices(cur.username);
}
