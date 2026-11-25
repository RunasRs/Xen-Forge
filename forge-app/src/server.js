import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { assertSecretKey } from './crypto.js';
import { DATA_DIR, pool } from './db.js';
import { currentSession, handle, notFound, sameOriginOnly } from './http/session.js';
import { appDomain, loadTls } from './http/tls.js';
import { pump, recoverOrphans } from './jobs.js';
import { ansiblePump, recoverOrphanAnsibleJobs } from './ansible/jobs.js';
import { startAuditPurge } from './audit.js';
import { runMigrations } from './migrations.js';
import { startJobPurge } from './jobretention.js';
import { router as ansibleRoutes } from './routes/ansible.js';
import { router as auditRoutes } from './routes/audit.js';
import { router as authRoutes } from './routes/auth.js';
import { router as certificateRoutes } from './routes/certificates.js';
import { router as distributionRoutes } from './routes/distributions.js';
import { router as infrastructureRoutes } from './routes/infrastructure.js';
import { router as ldapRoutes } from './routes/ldap.js';
import { router as profileRoutes } from './routes/profiles.js';
import { launchAnsibleJob, launchPackerJob, launchTofuJob, router as jobRoutes } from './routes/jobs.js';
import { router as safeRoutes } from './routes/safe.js';
import { router as scheduleRoutes } from './routes/schedules.js';
import { router as statsRoutes } from './routes/stats.js';
import { router as userRoutes } from './routes/users.js';
import { recoverOrphanTofuJobs, tofuPump } from './tofu/jobs.js';
import { startScheduler } from './schedules.js';
import * as users from './users.js';
import { ValidationError } from './validation.js';
import { startMasterRefresh } from './xcp.js';
import { startXoRefresh } from './tofu/xo.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "img-src 'self' data:", "style-src 'self'", "script-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
].join('; ');

function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
    'Strict-Transport-Security': 'max-age=31536000',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  });
  next();
}

function errorHandler(err, _req, res, _next) {
  if (err instanceof ValidationError) return res.status(400).json({ ...err.details, error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'Requête invalide' });
  console.error(err);
  return res.status(500).json({ error: 'Erreur interne' });
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(sameOriginOnly);
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', handle(async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'db_error' });
    }
  }));

  [authRoutes, auditRoutes, ldapRoutes, userRoutes, safeRoutes, certificateRoutes, profileRoutes, scheduleRoutes, distributionRoutes,
    infrastructureRoutes, jobRoutes, statsRoutes, ansibleRoutes].forEach((router) => app.use(router));
  app.use('/api', (_req, res) => notFound(res));

  app.get('/', handle(async (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, (await currentSession(req)) ? 'index.html' : 'login.html'));
  }));
  app.get(['/index.html', '/login.html'], (_req, res) => res.redirect(302, '/'));
  app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.use(errorHandler);
  return app;
}

async function seedInitialAdmin() {
  const seeded = await users.seedAdmin();
  if (seeded) console.log('-> Credentials : docker exec -it forge-app adminpasswd');
}

assertSecretKey();
const domain = appDomain();
const tls = loadTls({ domain, sslDir: process.env.SSL_DIR || '/ssl', generatedDir: path.join(DATA_DIR, 'ssl') });
await runMigrations();
await recoverOrphans();
await recoverOrphanTofuJobs();
await recoverOrphanAnsibleJobs();
await seedInitialAdmin();

if (tls.expired) console.warn('HTTPS : le certificat fourni est expiré');

const host = process.env.HOST || '0.0.0.0';
const TLS12_CIPHERS = ['ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305', 'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256'].join(':');

https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2', ciphers: TLS12_CIPHERS, honorCipherOrder: true }, createApp()).listen(443, host, () => {
  console.log(`-> Application : https://${domain}:${process.env.APP_HTTPS_PORT || 443}`);
  pump();
  tofuPump();
  ansiblePump();
  startScheduler({ packer: launchPackerJob, tofu: launchTofuJob, ansible: launchAnsibleJob });
  startMasterRefresh();
  startXoRefresh();
  startAuditPurge();
  startJobPurge();
});
