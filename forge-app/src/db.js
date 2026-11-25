import pg from 'pg';
import { encrypt, decrypt } from './crypto.js';

export const DATA_DIR = process.env.DATA_DIR || '/data';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function getSetting(key) {
  const { rows } = await pool.query('SELECT value, is_secret FROM settings WHERE key = $1', [key]);
  if (!rows[0] || rows[0].value == null) return null;
  return rows[0].is_secret ? decrypt(rows[0].value) : rows[0].value;
}

export async function setSetting(key, value, isSecret = false) {
  const stored = isSecret && value ? encrypt(value) : value;
  await pool.query(
    `INSERT INTO settings (key, value, is_secret, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, is_secret = $3, updated_at = now()`,
    [key, stored, isSecret],
  );
}

export async function deleteSetting(key) {
  await pool.query('DELETE FROM settings WHERE key = $1', [key]);
}
