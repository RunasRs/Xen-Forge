import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { UUID_RE, ValidationError } from './validation.js';

const TYPES = ['password', 'ssh_key', 'product_key'];
const ACCOUNT_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const PRODUCT_KEY_RE = /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/;

function cleanProductKey(value) {
  const key = String(value || '').trim().toUpperCase();
  if (!PRODUCT_KEY_RE.test(key)) throw new ValidationError('Clé de produit invalide (format XXXXX-XXXXX-XXXXX-XXXXX-XXXXX)');
  return key;
}

function checkPublicKey(publicKey) {
  if (!/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/]+=*(\s+[\w.@+:-]*)?$/.test(publicKey.trim())) {
    throw new ValidationError('Clé publique invalide (format authorized_keys attendu : ssh-rsa AAAA…)');
  }
}

export function generateKeypair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-key-'));
  const keyPath = path.join(dir, 'id_rsa');
  try {
    execFileSync('ssh-keygen',
      ['-t', 'rsa', '-b', '4096', '-N', '', '-C', 'xen-forge', '-f', keyPath],
      { stdio: 'ignore' });
    return {
      publicKey: fs.readFileSync(`${keyPath}.pub`, 'utf8').trim(),
      privateKey: fs.readFileSync(keyPath, 'utf8').trim(),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cleanName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 100) throw new ValidationError('Nom requis (100 caractères max)');
  return n;
}

function cleanType(type) {
  const t = String(type || '').trim();
  if (!TYPES.includes(t)) throw new ValidationError('Type invalide (password, ssh_key ou product_key)');
  return t;
}

function cleanSecret(secret, { required, label }) {
  const s = String(secret || '');
  if (required && !s) throw new ValidationError(`${label} requis`);
  if (s.length > 16384) throw new ValidationError(`${label} trop long (16384 caractères max)`);
  return s;
}

const publicColumns = 'id, name, type, username, public_key, is_active, created_at, updated_at';

function readSecret(entry) {
  try {
    return decrypt(entry.secret);
  } catch {
    throw new ValidationError(`Entrée « ${entry.name} » : secret illisible, chiffré avec une autre APP_SECRET_KEY`);
  }
}

export async function list() {
  const { rows } = await pool.query(`SELECT ${publicColumns} FROM safe_entries ORDER BY name`);
  return rows;
}

function cleanUsername(value) {
  const username = String(value || '').trim();
  if (!username) throw new ValidationError('Identifiant requis');
  if (username.length > 100) throw new ValidationError('Identifiant trop long (100 caractères max)');
  return username;
}

function normalize(entry) {
  const name = cleanName(entry.name);
  const type = cleanType(entry.type);
  const base = { name, type };
  if (type === 'product_key') return { ...base, username: '', publicKey: '', secret: cleanProductKey(entry.secret) };
  if (type === 'password') {
    return { ...base, username: cleanUsername(entry.username), secret: cleanSecret(entry.secret, { required: true, label: 'Mot de passe' }), publicKey: '' };
  }
  const publicKey = cleanSecret(entry.publicKey, { required: true, label: 'Clé publique' });
  checkPublicKey(publicKey);
  const secret = cleanSecret(entry.secret, { required: true, label: 'Clé privée' });
  if (!secret.includes('PRIVATE KEY')) throw new ValidationError('Clé privée invalide (format OpenSSH ou PEM attendu)');
  return { ...base, username: cleanUsername(entry.username), publicKey, secret };
}

export async function create(entry) {
  const e = normalize(entry);
  try {
    const { rows } = await pool.query(`
      INSERT INTO safe_entries (name, type, username, secret, public_key)
      VALUES ($1, $2, $3, $4, $5) RETURNING ${publicColumns}`,
      [e.name, e.type, e.username, encrypt(e.secret), e.publicKey]);
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new ValidationError('Une entrée porte déjà ce nom pour ce type');
    throw err;
  }
}

export async function update(id, entry) {
  if (!UUID_RE.test(id)) throw new ValidationError('Entrée introuvable');
  const { rows } = await pool.query('SELECT * FROM safe_entries WHERE id = $1', [id]);
  const cur = rows[0];
  if (!cur) throw new ValidationError('Entrée introuvable');
  const type = cur.type;
  const merged = {
    name: 'name' in entry ? entry.name : cur.name,
    username: type === 'product_key' ? '' : String('username' in entry ? entry.username : cur.username).trim(),
    publicKey: type === 'ssh_key' ? String('publicKey' in entry ? entry.publicKey : cur.public_key).trim() : '',
  };
  const name = cleanName(merged.name);
  const givenSecret = cleanSecret('secret' in entry ? entry.secret : '', { required: false, label: 'Secret' });
  const newSecret = type === 'product_key' && givenSecret ? cleanProductKey(givenSecret) : givenSecret;
  if (type !== 'product_key') cleanUsername(merged.username);
  if (type === 'ssh_key') checkPublicKey(merged.publicKey);
  const is_active = 'is_active' in entry ? Boolean(entry.is_active) : cur.is_active;
  try {
    const { rows: updated } = await pool.query(`
      UPDATE safe_entries
      SET name = $2, username = $3, public_key = $4, is_active = $5,
          secret = CASE WHEN $6 THEN $7 ELSE secret END,
          updated_at = now()
      WHERE id = $1 RETURNING ${publicColumns}`,
      [id, name, merged.username, merged.publicKey, is_active, Boolean(newSecret), newSecret ? encrypt(newSecret) : null]);
    return updated[0];
  } catch (err) {
    if (err.code === '23505') throw new ValidationError('Une entrée porte déjà ce nom pour ce type');
    throw err;
  }
}

export async function remove(id) {
  if (!UUID_RE.test(id)) throw new ValidationError('Entrée introuvable');
  const { rowCount } = await pool.query('DELETE FROM safe_entries WHERE id = $1', [id]);
  if (!rowCount) throw new ValidationError('Entrée introuvable');
}

export async function reveal(id) {
  if (!UUID_RE.test(id)) throw new ValidationError('Entrée introuvable');
  const { rows } = await pool.query('SELECT name, type, username, public_key, secret FROM safe_entries WHERE id = $1', [id]);
  if (!rows[0]) throw new ValidationError('Entrée introuvable');
  return {
    name: rows[0].name, type: rows[0].type,
    username: rows[0].username, publicKey: rows[0].public_key, secret: readSecret(rows[0]),
  };
}

const WINDOWS_MIN_PASSWORD = 8;
export function windowsPasswordProblem(password, username = '') {
  const pw = String(password || '');
  const kinds = [/\p{Lu}/u, /\p{Ll}/u, /[0-9]/, /[^\p{L}0-9]/u].filter((re) => re.test(pw)).length;
  const problems = [
    ...(pw.length < WINDOWS_MIN_PASSWORD ? [`${WINDOWS_MIN_PASSWORD} caractères minimum`] : []),
    ...(kinds < 3 ? ['3 types parmi majuscules, minuscules, chiffres, symboles'] : []),
    ...(username.length >= 3 && pw.toLowerCase().includes(username.toLowerCase()) ? ['sans le nom du compte'] : []),
  ];
  return problems.length ? problems.join(', ') : null;
}

export async function windowsAccountRefusal(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const { rows } = await pool.query('SELECT name, type, username, secret FROM safe_entries WHERE id = $1', [id]);
  const e = rows[0];
  if (!e || e.type !== 'password') return null;
  const problem = windowsPasswordProblem(readSecret(e), String(e.username || '').trim());
  return problem ? `Entrée « ${e.name} » : mot de passe refusé par Windows (${problem}), le compte ne serait pas créé` : null;
}

export async function resolveForJob(id, { passwordOnly = false } = {}) {
  if (!id) throw new Error('Entrée du coffre-fort obligatoire : modifier le profil');
  if (!UUID_RE.test(String(id))) throw new Error('Identifiant du coffre-fort invalide');
  const { rows } = await pool.query(
    'SELECT name, type, username, public_key, secret, is_active FROM safe_entries WHERE id = $1', [id],
  );
  const e = rows[0];
  if (!e || !e.is_active) throw new Error('Entrée du coffre-fort introuvable ou désactivée');
  if (e.type === 'product_key') throw new Error(`Entrée « ${e.name} » : une clé de produit ne peut pas servir de compte`);
  if (passwordOnly && e.type !== 'password') {
    throw new Error(`Entrée « ${e.name} » : seule une entrée « mot de passe » est utilisable pour ce système`);
  }
  const username = String(e.username || '').trim();
  if (!ACCOUNT_RE.test(username)) {
    throw new Error(`Entrée « ${e.name} » : identifiant « ${username} » invalide (lettres, chiffres, « _ », « . », « - »)`);
  }
  return {
    name: e.name,
    type: e.type,
    username,
    publicKey: String(e.public_key || '').trim().split(/\s+/).slice(0, 2).join(' '),
    secret: readSecret(e),
  };
}

export async function resolveProductKey(id) {
  if (!UUID_RE.test(String(id))) throw new Error('Identifiant de la clé de produit invalide');
  const { rows } = await pool.query('SELECT name, type, secret, is_active FROM safe_entries WHERE id = $1', [id]);
  const e = rows[0];
  if (!e || !e.is_active) throw new Error('Clé de produit du coffre-fort introuvable ou désactivée');
  if (e.type !== 'product_key') throw new Error(`Entrée « ${e.name} » : ce n'est pas une clé de produit`);
  return readSecret(e);
}
