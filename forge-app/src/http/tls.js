import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const SELF_SIGNED_DAYS = '825';

export function appDomain(value = process.env.APP_NAME) {
  const domain = String(value || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) throw new Error('APP_NAME : nom de domaine de l\'application absent ou invalide');
  return domain;
}

function readPair(certFile, keyFile) {
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

function assertUsable({ cert, key }, domain, source) {
  let x509;
  let privateKey;
  try {
    x509 = new X509Certificate(cert);
    privateKey = createPrivateKey(key);
  } catch (e) {
    throw new Error(`${source} : certificat ou clé illisible (clé chiffrée non prise en charge) : ${e.message}`);
  }
  if (!x509.checkPrivateKey(privateKey)) throw new Error(`${source} : la clé ne correspond pas au certificat`);
  if (!x509.checkHost(domain)) throw new Error(`${source} : le certificat ne couvre pas ${domain}`);
  return x509;
}

function isExpired(x509, now) {
  return new Date(x509.validTo) <= now;
}

function selfSignedPair(domain, dir, now) {
  const certFile = path.join(dir, 'self-signed.crt');
  const keyFile = path.join(dir, 'self-signed.key');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const pair = readPair(certFile, keyFile);
    const x509 = new X509Certificate(pair.cert);
    if (x509.checkHost(domain) && !isExpired(x509, now)) return pair;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', SELF_SIGNED_DAYS,
    '-subj', `/CN=${domain}`, '-addext', `subjectAltName=DNS:${domain}`, '-keyout', keyFile, '-out', certFile,
  ], { stdio: 'ignore' });
  fs.chmodSync(keyFile, 0o600);
  return readPair(certFile, keyFile);
}

export function loadTls({ domain, sslDir, generatedDir, now = new Date() }) {
  const certFile = path.join(sslDir, 'cert.crt');
  const keyFile = path.join(sslDir, 'cert.key');
  const hasCert = fs.existsSync(certFile);
  if (hasCert !== fs.existsSync(keyFile)) throw new Error(`${sslDir} : cert.crt et cert.key doivent être fournis ensemble`);
  if (!hasCert) {
    const pair = selfSignedPair(domain, generatedDir, now);
    assertUsable(pair, domain, 'Certificat auto-signé');
    return { ...pair, expired: false };
  }
  const pair = readPair(certFile, keyFile);
  const x509 = assertUsable(pair, domain, sslDir);
  return { ...pair, expired: isExpired(x509, now) };
}
