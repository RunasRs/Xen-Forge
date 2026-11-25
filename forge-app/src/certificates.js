import { execFile } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { UUID_RE, ValidationError } from './validation.js';

export const CERT_TYPES = ['cert_key', 'pkcs12', 'ca'];
const MAX_CERT_BYTES = 32 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_PKCS12_BYTES = 48 * 1024;
const MAX_CHAIN = 10;
const MAX_PASSWORD = 1024;
const OPENSSL_TIMEOUT_MS = 10000;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const PEM_BLOCK_RE = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([\s\S]*?)-----END \1-----/g;

export const publicColumns = 'id, name, type, subject, issuer, not_after, is_active, created_at, updated_at';

export async function connectionCa(id, label) {
  if (!id) return null;
  if (!UUID_RE.test(String(id))) throw new ValidationError(`${label} : autorité de certification invalide`);
  const { rows } = await pool.query('SELECT name, type, certificate, is_active FROM certificate_entries WHERE id = $1', [id]);
  const c = rows[0];
  if (!c) throw new ValidationError(`${label} : autorité de certification introuvable (Sécurité > Certificats)`);
  if (c.type !== 'ca') throw new ValidationError(`${label} : « ${c.name} » n'est pas un certificat CA`);
  if (!c.is_active) throw new ValidationError(`${label} : autorité de certification « ${c.name} » désactivée (Sécurité > Certificats)`);
  return { id: String(id), name: c.name, pem: c.certificate };
}

export const tlsOptions = (conn) => (conn.insecure
  ? { rejectUnauthorized: false }
  : { rejectUnauthorized: true, ...(conn.ca ? { ca: conn.ca } : {}) });

function cleanName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 100) throw new ValidationError('Nom requis (100 caractères max)');
  return n;
}

function cleanType(type) {
  const t = String(type || '');
  if (!CERT_TYPES.includes(t)) throw new ValidationError('Type invalide (X.509, PKCS12 ou CA)');
  return t;
}

function decodeFile(value, maxBytes, label) {
  const b64 = String(value || '').replace(/\s+/g, '');
  if (!b64) throw new ValidationError(`${label} obligatoire`);
  if (!BASE64_RE.test(b64) || b64.length % 4 === 1) throw new ValidationError(`${label} : fichier illisible`);
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new ValidationError(`${label} obligatoire`);
  if (buf.length > maxBytes) throw new ValidationError(`${label} : fichier trop volumineux (${maxBytes / 1024} Kio max)`);
  return buf;
}

function pemBlocks(text) {
  return [...text.matchAll(PEM_BLOCK_RE)].map((m) => ({ label: m[1], pem: m[0] }));
}

function parseCertificates(buf, label) {
  const text = buf.toString('latin1');
  const blocks = pemBlocks(text);
  if (blocks.some((b) => b.label.includes('PRIVATE KEY'))) {
    throw new ValidationError(`${label} : le fichier contient une clé privée, la mettre dans le champ Clé privée`);
  }
  const other = blocks.find((b) => b.label !== 'CERTIFICATE');
  if (other) throw new ValidationError(`${label} : bloc « ${other.label} » refusé, seuls des blocs CERTIFICATE sont acceptés`);
  if (!blocks.length && /-----BEGIN /.test(text)) throw new ValidationError(`${label} : bloc PEM incomplet ou mal formé`);
  let certs;
  try {
    certs = blocks.length ? blocks.map((b) => new X509Certificate(b.pem)) : [new X509Certificate(buf)];
  } catch {
    throw new ValidationError(`${label} : certificat X.509 illisible (PEM ou DER attendu)`);
  }
  if (!blocks.length && certs[0].raw.length !== buf.length) throw new ValidationError(`${label} : données en trop après le certificat DER`);
  if (!certs.length) throw new ValidationError(`${label} : aucun certificat trouvé (PEM ou DER attendu)`);
  if (certs.length > MAX_CHAIN) throw new ValidationError(`${label} : ${MAX_CHAIN} certificats au plus`);
  return certs;
}

function checkChainOrder(certs, label) {
  for (let i = 0; i < certs.length - 1; i += 1) {
    if (!certs[i].checkIssued(certs[i + 1])) {
      throw new ValidationError(`${label} : chaîne dans le désordre, le certificat ${i + 2} n'a pas émis le certificat ${i + 1} (ordre attendu : serveur, intermédiaires, racine)`);
    }
  }
}

async function parsePrivateKey(buf, password) {
  if (password.length > MAX_PASSWORD) throw new ValidationError(`Mot de passe de la clé privée : ${MAX_PASSWORD} caractères au plus`);
  const text = buf.toString('latin1');
  const encrypted = /ENCRYPTED PRIVATE KEY|Proc-Type: 4,ENCRYPTED/.test(text);
  if (encrypted && !password) throw new ValidationError('Clé privée protégée par un mot de passe : le saisir sous la clé');
  const blocks = pemBlocks(text).filter((b) => b.label.endsWith('PRIVATE KEY'));
  if (blocks.length > 1) throw new ValidationError('Clé privée : le fichier contient plusieurs clés');
  const passphrase = password || undefined;
  try {
    return blocks.length
      ? createPrivateKey({ key: blocks[0].pem, passphrase })
      : createPrivateKey({ key: buf, format: 'der', type: 'pkcs8', passphrase });
  } catch (e) {
    if (e.code === 'ERR_MISSING_PASSPHRASE') throw new ValidationError('Clé privée protégée par un mot de passe : le saisir sous la clé');
    if (password && (encrypted || !blocks.length) && /bad decrypt|BAD_DECRYPT|decrypt/i.test(`${e.code} ${e.message}`)) {
      throw new ValidationError('Clé privée : mot de passe incorrect');
    }
    if (password && /unsupported/i.test(e.message)) return decryptLegacyKey(buf, password);
    throw new ValidationError('Clé privée illisible (PEM, ou DER PKCS#8)');
  }
}

const keyPem = (key) => key.export({ type: 'pkcs8', format: 'pem' });

function checkKeyMatches(cert, key) {
  if (!cert.checkPrivateKey(key)) throw new ValidationError('La clé privée ne correspond pas au certificat');
}

const certsPem = (certs) => `${certs.map((c) => c.toString().trim()).join('\n')}\n`;

const dn = (value) => String(value || '').split('\n').filter(Boolean).join(', ');

const metadata = (cert) => ({ subject: dn(cert.subject), issuer: dn(cert.issuer), notAfter: new Date(cert.validTo) });

function runOpenssl(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('openssl', args, { timeout: OPENSSL_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'latin1' },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function withTempFiles(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cert-'));
  try {
    const paths = files.map((buf, i) => {
      const file = path.join(dir, `in${i}`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      return file;
    });
    return await fn(...paths);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const withTempFile = (buf, fn) => withTempFiles([buf], fn);

const LEGACY_RE = /unsupported|legacy|RC2|global default library context/i;

async function runWithLegacy(args, password) {
  try {
    return await runOpenssl(args, `${password}\n`);
  } catch (e) {
    if (!LEGACY_RE.test(e.stderr || '')) throw e;
    return runOpenssl([...args, '-legacy'], `${password}\n`);
  }
}

function checkPasswordLine(password, label) {
  if (password.length > MAX_PASSWORD || /[\r\n]/.test(password)) throw new ValidationError(`${label} : une ligne, ${MAX_PASSWORD} caractères au plus`);
}

async function openPkcs12(buf, password) {
  checkPasswordLine(password, 'Mot de passe du PKCS12');
  try {
    return await withTempFile(buf, (file) => runWithLegacy(['pkcs12', '-in', file, '-passin', 'stdin', '-nodes'], password));
  } catch (e) {
    if (/mac verify|invalid password|bad decrypt/i.test(e.stderr || '')) throw new ValidationError('PKCS12 : mot de passe incorrect');
    if (e.killed) throw new ValidationError('PKCS12 : lecture trop longue, fichier refusé');
    throw new ValidationError('PKCS12 illisible (fichier .p12 ou .pfx attendu)');
  }
}

async function decryptLegacyKey(buf, password) {
  checkPasswordLine(password, 'Mot de passe de la clé privée');
  try {
    const out = await withTempFile(buf, (file) => runWithLegacy(['pkey', '-in', file, '-passin', 'stdin'], password));
    return createPrivateKey(out);
  } catch (e) {
    if (/bad decrypt|maybe wrong password/i.test(e.stderr || '')) throw new ValidationError('Clé privée : mot de passe incorrect');
    throw new ValidationError('Clé privée : chiffrement non pris en charge, la convertir (openssl pkey) ou utiliser un PKCS12');
  }
}

async function checkPkcs12(buf, password) {
  const blocks = pemBlocks(await openPkcs12(buf, password));
  const keys = blocks.filter((b) => b.label.endsWith('PRIVATE KEY'));
  if (keys.length !== 1) throw new ValidationError(`PKCS12 : une clé privée attendue, ${keys.length} trouvée(s)`);
  const key = createPrivateKey(keys[0].pem);
  const certs = blocks.filter((b) => b.label === 'CERTIFICATE').map((b) => new X509Certificate(b.pem));
  const leaf = certs.find((c) => c.checkPrivateKey(key));
  if (!leaf) throw new ValidationError('PKCS12 : aucun certificat ne correspond à la clé privée');
  if (certs.length > MAX_CHAIN) throw new ValidationError(`PKCS12 : ${MAX_CHAIN} certificats au plus`);
  return [leaf, ...certs.filter((c) => c !== leaf)];
}

function checkCa(buf) {
  const certs = parseCertificates(buf, 'Certificat CA');
  if (certs.length !== 1) throw new ValidationError('Certificat CA : un seul certificat attendu');
  if (!certs[0].ca) throw new ValidationError('Certificat CA : ce certificat n\'est pas une autorité de certification (CA:FALSE)');
  return certs[0];
}

const has = (input, key) => Object.hasOwn(input, key);

async function buildEntry(type, input, current = null) {
  const keep = (key) => current && !has(input, key);
  if (type === 'ca') {
    if (keep('certificate')) return null;
    const cert = checkCa(decodeFile(input.certificate, MAX_CERT_BYTES, 'Certificat CA'));
    return { certificate: certsPem([cert]), secret: '', passphrase: '', ...metadata(cert) };
  }
  if (type === 'cert_key') {
    if (keep('certificate') && keep('key')) return null;
    const certs = keep('certificate')
      ? parseCertificates(Buffer.from(current.certificate, 'latin1'), 'Certificat')
      : parseCertificates(decodeFile(input.certificate, MAX_CERT_BYTES, 'Certificat'), 'Certificat');
    checkChainOrder(certs, 'Certificat');
    const key = keep('key')
      ? createPrivateKey(decrypt(current.secret))
      : await parsePrivateKey(decodeFile(input.key, MAX_KEY_BYTES, 'Clé privée'), String(input.key_password ?? ''));
    checkKeyMatches(certs[0], key);
    return { certificate: certsPem(certs), secret: encrypt(keyPem(key)), passphrase: '', ...metadata(certs[0]) };
  }
  const givenPassword = String(input.password ?? '');
  if (keep('pkcs12') && !givenPassword) return null;
  const p12 = keep('pkcs12') ? Buffer.from(decrypt(current.secret), 'base64') : decodeFile(input.pkcs12, MAX_PKCS12_BYTES, 'PKCS12');
  const password = givenPassword || (current ? decrypt(current.passphrase) : '');
  const certs = await checkPkcs12(p12, password);
  return {
    certificate: certsPem(certs), secret: encrypt(p12.toString('base64')), passphrase: encrypt(password), ...metadata(certs[0]),
  };
}

function nameTaken(err) {
  if (err.code === '23505') return new ValidationError('Un certificat porte déjà ce nom');
  return err;
}

export async function create(input) {
  const name = cleanName(input.name);
  const type = cleanType(input.type);
  const e = await buildEntry(type, input);
  try {
    const { rows } = await pool.query(`
      INSERT INTO certificate_entries (name, type, certificate, secret, passphrase, subject, issuer, not_after)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${publicColumns}`,
    [name, type, e.certificate, e.secret, e.passphrase, e.subject, e.issuer, e.notAfter]);
    return rows[0];
  } catch (err) {
    throw nameTaken(err);
  }
}

async function current(id) {
  if (!UUID_RE.test(String(id))) throw new ValidationError('Certificat introuvable');
  const { rows } = await pool.query('SELECT * FROM certificate_entries WHERE id = $1', [id]);
  if (!rows[0]) throw new ValidationError('Certificat introuvable');
  return rows[0];
}

export async function update(id, input) {
  const cur = await current(id);
  const name = has(input, 'name') ? cleanName(input.name) : cur.name;
  const isActive = has(input, 'is_active') ? Boolean(input.is_active) : cur.is_active;
  const e = await buildEntry(cur.type, input, cur);
  try {
    const { rows } = await pool.query(`
      UPDATE certificate_entries
      SET name = $2, is_active = $3,
          certificate = COALESCE($4, certificate), secret = COALESCE($5, secret), passphrase = COALESCE($6, passphrase),
          subject = COALESCE($7, subject), issuer = COALESCE($8, issuer), not_after = COALESCE($9, not_after),
          updated_at = now()
      WHERE id = $1 RETURNING ${publicColumns}`,
    [id, name, isActive, e?.certificate ?? null, e?.secret ?? null, e?.passphrase ?? null, e?.subject ?? null, e?.issuer ?? null,
      e?.notAfter ?? null]);
    return rows[0];
  } catch (err) {
    throw nameTaken(err);
  }
}

export async function remove(id) {
  if (!UUID_RE.test(String(id))) throw new ValidationError('Certificat introuvable');
  const { rowCount } = await pool.query('DELETE FROM certificate_entries WHERE id = $1', [id]);
  if (!rowCount) throw new ValidationError('Certificat introuvable');
}

export async function details(id) {
  const cur = await current(id);
  const certs = parseCertificates(Buffer.from(cur.certificate, 'latin1'), 'Certificat');
  return {
    id: cur.id, name: cur.name, type: cur.type, is_active: cur.is_active, updated_at: cur.updated_at,
    has_private_key: cur.type !== 'ca',
    chain: certs.map((c) => ({
      subject: dn(c.subject), issuer: dn(c.issuer), valid_from: new Date(c.validFrom), valid_to: new Date(c.validTo),
      san: c.subjectAltName || '', serial: c.serialNumber, fingerprint256: c.fingerprint256, ca: c.ca,
    })),
  };
}

async function exportPkcs12(chainPem, keyText, name) {
  const password = randomBytes(24).toString('base64url');
  const out = await withTempFiles([chainPem, keyText], (certFile, keyFile) => runOpenssl(
    ['pkcs12', '-export', '-in', certFile, '-inkey', keyFile, '-name', name, '-passout', 'stdin'], `${password}\n`));
  return { pfx: Buffer.from(out, 'latin1').toString('base64'), password };
}

export async function resolveForJob(id, types = CERT_TYPES) {
  if (!UUID_RE.test(String(id))) throw new Error('Identifiant de certificat invalide');
  const { rows } = await pool.query('SELECT * FROM certificate_entries WHERE id = $1', [id]);
  const e = rows[0];
  if (!e || !e.is_active) throw new Error('Certificat introuvable ou désactivé');
  if (!types.includes(e.type)) throw new Error(`Certificat « ${e.name} » : type non accepté par cette brique (${types.join(', ')})`);
  const certs = parseCertificates(Buffer.from(e.certificate, 'latin1'), 'Certificat');
  const pems = certs.map((c) => `${c.toString().trim()}\n`);
  const leaf = certs[0];
  const value = {
    name: e.name,
    type: e.type,
    subject: dn(leaf.subject),
    issuer: dn(leaf.issuer),
    not_after: new Date(leaf.validTo).toISOString(),
    thumbprint: leaf.fingerprint.replace(/:/g, ''),
    fingerprint: leaf.fingerprint256.replace(/:/g, ''),
    certificate: pems[0],
    chain: pems.slice(1).join(''),
    fullchain: pems.join(''),
  };
  const secrets = [];
  if (e.type !== 'ca') {
    let key;
    if (e.type === 'cert_key') key = decrypt(e.secret);
    else {
      const blocks = pemBlocks(await openPkcs12(Buffer.from(decrypt(e.secret), 'base64'), decrypt(e.passphrase)));
      key = keyPem(createPrivateKey(blocks.find((b) => b.label.endsWith('PRIVATE KEY')).pem));
    }
    const { pfx, password } = await exportPkcs12(value.fullchain, key, e.name);
    Object.assign(value, { private_key: `${key.trim()}\n`, pfx, pfx_password: password });
    secrets.push(pfx, password);
  }
  return { value, secrets, expired: new Date(leaf.validTo) < new Date() };
}
