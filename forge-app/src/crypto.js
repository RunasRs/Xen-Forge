import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

const MIN_SECRET_KEY_LENGTH = 32;
const SCRYPT_V1 = {};
const SCRYPT_V2 = { N: 2 ** 17, r: 8, p: 1, maxmem: 2 ** 28 };
const HASH_BYTES = 32;
const key = crypto.createHash('sha256').update(process.env.APP_SECRET_KEY || '').digest();
const sessionKey = crypto.createHmac('sha256', key).update('forge-session').digest();

export function assertSecretKey() {
  if ((process.env.APP_SECRET_KEY || '').length < MIN_SECRET_KEY_LENGTH) {
    throw new Error(`APP_SECRET_KEY obligatoire (${MIN_SECRET_KEY_LENGTH} caractères minimum)`);
  }
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, HASH_BYTES, SCRYPT_V2);
  return `s2$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [version, salt, hash] = String(stored || '').split('$');
  const expected = Buffer.from(hash || '', 'base64');
  if (!salt || expected.length !== HASH_BYTES) return false;
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), HASH_BYTES, version === 's2' ? SCRYPT_V2 : SCRYPT_V1);
  return crypto.timingSafeEqual(expected, actual);
}

export const needsRehash = (stored) => !stored.startsWith('s2$');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const mac = (data) => crypto.createHmac('sha256', sessionKey).update(data).digest('base64url');

export function signSession(user, type, ttlMs, jti) {
  const now = Date.now();
  const data = Buffer.from(JSON.stringify({ user, type, jti, iat: now, exp: now + ttlMs })).toString('base64url');
  return `${data}.${mac(data)}`;
}

export function readSession(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig || !safeEqual(sig, mac(data))) return null;
  try {
    const s = JSON.parse(Buffer.from(data, 'base64url').toString());
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function sha512Crypt(password) {
  return new Promise((resolve, reject) => {
    const p = spawn('openssl', ['passwd', '-6', '-stdin']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && out.startsWith('$6$') ? resolve(out.trim()) : reject(new Error('Hash du mot de passe impossible'))));
    p.stdin.end(password);
  });
}

