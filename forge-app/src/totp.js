import { generateSecret as newSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { pool } from './db.js';
import { encrypt, decrypt } from './crypto.js';

const ISSUER = 'Xen Forge';
const CLOCK_TOLERANCE_SECONDS = 30;
const ENROLLMENT_WINDOW = '24 hours';
const enrollmentKey = (username, type) => `${String(username).toLowerCase()}|${type}`;
const PENDING_ACCOUNTS = `
  SELECT lower(u.username) || '|local' FROM local_users u
  WHERE u.is_active AND NOT EXISTS (
    SELECT 1 FROM totp_users t WHERE t.user_type = 'local' AND t.username = u.username AND t.totp_verified)
  UNION
  SELECT lower(a.username || '@' || c.domain) || '|domain' FROM ldap_accounts a JOIN ldap_configs c ON c.id = a.config_id
  WHERE NOT EXISTS (
    SELECT 1 FROM totp_users t WHERE t.user_type = 'domain' AND lower(t.username) = lower(a.username || '@' || c.domain) AND t.totp_verified)`;

const usedCodes = new Map();
const periodNow = () => Math.floor(Date.now() / 1000 / 30);

function isReplayAndMark(username, code) {
  const period = periodNow();
  const used = usedCodes.get(username) || new Map();
  for (const [oldCode, oldPeriod] of used) if (period - oldPeriod > 2) used.delete(oldCode);
  const replayed = used.has(code);
  used.set(code, period);
  usedCodes.set(username, used);
  return replayed;
}

const DEFAULTS = { totpEnabled: false, maxAttempts: 5 };

export async function getAuthSettings() {
  const { rows } = await pool.query(
    'SELECT totp_enabled, max_attempts FROM auth_settings WHERE id = 1');
  if (!rows[0]) return DEFAULTS;
  return {
    totpEnabled: rows[0].totp_enabled === true,
    maxAttempts: Number(rows[0].max_attempts) || DEFAULTS.maxAttempts,
  };
}

const openPendingEnrollments = () => pool.query(`
  INSERT INTO totp_enrollment (account, open_until) SELECT account, now() + interval '${ENROLLMENT_WINDOW}' FROM (${PENDING_ACCOUNTS}) AS p(account)
  ON CONFLICT (account) DO UPDATE SET open_until = EXCLUDED.open_until`);

export const openEnrollment = (username, type) => pool.query(`
  INSERT INTO totp_enrollment (account, open_until) VALUES ($1, now() + interval '${ENROLLMENT_WINDOW}')
  ON CONFLICT (account) DO UPDATE SET open_until = EXCLUDED.open_until`, [enrollmentKey(username, type)]);

export async function enrollmentOpen(username, type) {
  return (await pool.query('SELECT 1 FROM totp_enrollment WHERE account = $1 AND open_until > now()',
    [enrollmentKey(username, type)])).rowCount > 0;
}

export const purgeEnrollments = () => pool.query('DELETE FROM totp_enrollment WHERE open_until <= now()');

export async function setTotpEnabled(enabled) {
  const { rows } = await pool.query(`
    UPDATE auth_settings SET totp_enabled = $1, updated_at = now() WHERE id = 1
    RETURNING (SELECT totp_enabled FROM auth_settings WHERE id = 1) AS was_enabled`, [Boolean(enabled)]);
  if (enabled && rows[0] && !rows[0].was_enabled) await openPendingEnrollments();
}

async function getRow(username) {
  const { rows } = await pool.query('SELECT username, user_type, secret_encrypted, totp_verified FROM totp_users WHERE username = $1', [username]);
  return rows[0] || null;
}

export async function generateSecret(username, userType) {
  if (userType !== 'local' && userType !== 'domain') throw new Error('Type d\'utilisateur invalide');
  const secret = newSecret();
  await pool.query(`
    INSERT INTO totp_users (username, user_type, secret_encrypted, totp_verified)
    VALUES ($1, $2, $3, FALSE)
    ON CONFLICT (username) DO UPDATE
      SET user_type = EXCLUDED.user_type, secret_encrypted = EXCLUDED.secret_encrypted,
          totp_verified = FALSE, totp_created_at = now()`,
    [username, userType, encrypt(secret)]);
  const label = userType === 'domain' ? username.replace(/@[^@]*$/, '') : username;
  const otpauth = generateURI({ issuer: ISSUER, label, secret });
  const { modules } = QRCode.create(otpauth, { errorCorrectionLevel: 'Q' });
  return { secret, qr: { size: modules.size, modules: Array.from(modules.data, (d) => (d ? 1 : 0)).join('') } };
}

async function isValidToken(secret, token) {
  try {
    return (await verify({ secret, token, epochTolerance: CLOCK_TOLERANCE_SECONDS })).valid;
  } catch {
    return false;
  }
}

async function checkCode(row, code, { requireVerified }) {
  if (!row) return false;
  if (requireVerified && row.totp_verified !== true) return false;
  if (!requireVerified && row.totp_verified === true) return false;
  const secret = decrypt(row.secret_encrypted);
  if (!secret) return false;
  const token = String(code || '').trim();
  if (!(await isValidToken(secret, token))) return false;
  return !isReplayAndMark(row.username, token);
}

export async function verifySetupCode(username, code) {
  const row = await getRow(username);
  if (!(await checkCode(row, code, { requireVerified: false }))) return false;
  await pool.query('UPDATE totp_users SET totp_verified = TRUE, totp_created_at = now() WHERE username = $1', [username]);
  await pool.query('DELETE FROM totp_enrollment WHERE account = $1', [enrollmentKey(username, row.user_type)]);
  return true;
}

export async function verifyLoginCode(username, code) {
  const row = await getRow(username);
  return checkCode(row, code, { requireVerified: true });
}

export async function resetUser(username, userType) {
  const { rowCount } = await pool.query('DELETE FROM totp_users WHERE username = $1 AND user_type = $2', [username, userType]);
  return rowCount > 0;
}

export async function hasVerifiedSecret(username) {
  return (await getRow(username))?.totp_verified === true;
}
