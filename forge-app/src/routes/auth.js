import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Router } from 'express';
import pkg from '../../package.json' with { type: 'json' };
import { audit, auditAction, namesFrom } from '../audit.js';
import { COOKIES, auth, clearCookies, cookieOptions, currentSession, handle, notFound, openSession, readCookies } from '../http/session.js';
import { createLoginGuard } from '../http/login-guard.js';
import * as devices from '../devices.js';
import * as ldap from '../ldap.js';
import { getLogColors, setLogColors } from '../logcolors.js';
import { getCommandTrace, setCommandTrace } from '../commandtrace.js';
import { getPasswordPolicy, setPasswordPolicy } from '../passwordpolicy.js';
import { closeSession, purgeSessions } from '../sessions.js';
import * as totp from '../totp.js';
import * as users from '../users.js';
import { ValidationError } from '../validation.js';

const TOTP_PENDING_TTL_MS = 5 * 60 * 1000;
const PASSWORD_PENDING_TTL_MS = 10 * 60 * 1000;
const PASSWORD_MAX_ERRORS = 5;
const PURGE_INTERVAL_MS = 60 * 1000;
const MAX_LOGIN_LENGTH = 256;
const MAX_CONCURRENT_CHECKS = 8;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const FAILURE_MIN_MS = 1000;

export const router = Router();

const guard = createLoginGuard();
const totpPending = new Map();
const passwordPending = new Map();
let checksInFlight = 0;

const newToken = () => crypto.randomBytes(24).toString('base64url');
const isExpired = (entry, ttlMs) => Date.now() - entry.at > ttlMs;

function purgeExpired(pending, ttlMs) {
  for (const [token, entry] of pending) if (isExpired(entry, ttlMs)) pending.delete(token);
}

setInterval(() => {
  purgeExpired(totpPending, TOTP_PENDING_TTL_MS);
  purgeExpired(passwordPending, PASSWORD_PENDING_TTL_MS);
  guard.purge();
  purgeSessions().catch((e) => console.error('purge des sessions :', e.message));
  devices.purgeDevices().catch((e) => console.error('purge des appareils :', e.message));
  totp.purgeEnrollments().catch((e) => console.error('purge des enrôlements TOTP :', e.message));
}, PURGE_INTERVAL_MS).unref();

const waitText = (seconds) => (seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`);

function tooMany(res, seconds, extra = {}) {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ ...extra, error: `Trop de tentatives, réessayer dans ${waitText(seconds)}` });
}

async function trustDevice(req, res, account) {
  const token = await devices.trust(readCookies(req)[COOKIES.device], account);
  res.cookie(COOKIES.device, token, cookieOptions(devices.DEVICE_TTL_MS));
}

async function recordFailure(req, account, trusted) {
  if (trusted) await devices.recordFailure(readCookies(req)[COOKIES.device], account);
  else guard.recordFailure(req.ip, account);
}

function requirePasswordChange(res, { user, id, account, policyChange }) {
  for (const [token, entry] of passwordPending) if (entry.user === user) passwordPending.delete(token);
  const token = newToken();
  passwordPending.set(token, { user, id, account, at: Date.now(), failed: 0 });
  res.cookie(COOKIES.password, token, cookieOptions(PASSWORD_PENDING_TTL_MS));
  return res.json({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED', ...(policyChange ? { reason: 'policy' } : {}) });
}

async function completeLogin(req, res, { user, type, account, nonCompliant }) {
  if (type === 'local') {
    const policyChange = nonCompliant && await users.requirePasswordChange(user);
    if (policyChange) audit('password_noncompliant', { user, ip: req.ip });
    const state = await users.loginState(user);
    if (!state) return res.status(401).json({ error: 'Identifiants invalides' });
    if (state.mustChange) return requirePasswordChange(res, { user, id: state.id, account, policyChange });
  } else {
    const at = user.lastIndexOf('@');
    await ldap.recordLogin(user.slice(0, at), user.slice(at + 1));
  }
  await openSession(res, user, type);
  await trustDevice(req, res, account);
  audit('login', { user, type, ip: req.ip });
  return res.json({ ok: true, user });
}

async function verifyTotpStep(req, res, code, settings) {
  const token = readCookies(req)[COOKIES.totp];
  const pending = token && totpPending.get(token);
  const clearPending = () => {
    clearCookies(res, COOKIES.totp);
    return res;
  };
  if (!pending || isExpired(pending, TOTP_PENDING_TTL_MS)) {
    if (token) totpPending.delete(token);
    return clearPending().status(400).json({ ok: false, code: 'TOTP_SESSION_EXPIRED' });
  }
  const account = `${pending.account}|totp`;
  const wait = pending.trusted ? 0 : guard.retryAfter(req.ip, account);
  if (wait) {
    totpPending.delete(token);
    audit('login_locked', { user: pending.user, outcome: 'refused', step: 'totp', ip: req.ip });
    return tooMany(clearPending(), wait, { ok: false, code: 'TOTP_LOCKOUT' });
  }
  const valid = pending.isSetup
    ? await totp.verifySetupCode(pending.user, code)
    : await totp.verifyLoginCode(pending.user, code);
  if (!valid) {
    pending.failed = (pending.failed || 0) + 1;
    await recordFailure(req, pending.trusted ? pending.account : account, pending.trusted);
    audit('login_failed', { user: pending.user, outcome: 'refused', step: 'totp', ip: req.ip });
    if (pending.failed >= settings.maxAttempts) {
      totpPending.delete(token);
      return clearPending().status(400).json({ ok: false, code: 'TOTP_TOO_MANY_ATTEMPTS' });
    }
    return res.status(401).json({ ok: false, code: pending.isSetup ? 'TOTP_SETUP_INVALID' : 'TOTP_INVALID' });
  }
  totpPending.delete(token);
  if (!pending.trusted) guard.recordSuccess(req.ip, account);
  clearPending();
  return completeLogin(req, res, pending);
}

async function limitedCheck(check) {
  if (checksInFlight >= MAX_CONCURRENT_CHECKS) return { busy: true };
  checksInFlight += 1;
  try {
    return { result: await check() };
  } finally {
    checksInFlight -= 1;
  }
}

async function authenticate(username, password, source) {
  if (CONTROL_CHARACTERS.test(username)) return null;
  if (source === 'domain') {
    const result = await ldap.authenticate(username, password);
    return result ? { user: `${result.username}@${result.domain}`, type: 'domain' } : null;
  }
  return (await users.authenticate(username, password)) ? { user: username, type: 'local' } : null;
}

function readCredentials(body) {
  const username = typeof body.username === 'string' ? body.username.trim().slice(0, MAX_LOGIN_LENGTH) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const source = body.authSource === 'domain' ? 'domain' : 'local';
  return { username, password, source };
}

async function enrollmentAllowed({ user, type }) {
  if (await totp.enrollmentOpen(user, type)) return true;
  return type === 'domain' && !(await ldap.hasLoggedIn(user));
}

async function startTotpStep(req, res, identity) {
  const token = newToken();
  const isSetup = !(await totp.hasVerifiedSecret(identity.user));
  if (isSetup && !(await enrollmentAllowed(identity))) {
    audit('totp_enrollment_closed', { user: identity.user, outcome: 'refused', ip: req.ip });
    return res.status(403).json({ ok: false, code: 'TOTP_ENROLLMENT_CLOSED',
      error: 'Enrôlement TOTP expiré : demandez à un administrateur de réinitialiser votre clé TOTP' });
  }
  const setup = isSetup ? await totp.generateSecret(identity.user, identity.type) : null;
  totpPending.set(token, { ...identity, isSetup, at: Date.now() });
  res.cookie(COOKIES.totp, token, cookieOptions(TOTP_PENDING_TTL_MS));
  return res.json(isSetup
    ? { ok: false, code: 'TOTP_SETUP_VERIFY', totpSetup: { secret: setup.secret, qr: setup.qr } }
    : { ok: false, code: 'TOTP_REQUIRED' });
}

async function verifyPasswordStep(req, res, settings) {
  const started = Date.now();
  const { username, password, source } = readCredentials(req.body || {});
  const account = devices.accountOf(username, source);
  const trusted = await devices.isTrusted(readCookies(req)[COOKIES.device], account);
  const wait = trusted ? 0 : guard.retryAfter(req.ip, account);
  if (wait) {
    audit('login_locked', { user: username, outcome: 'refused', ip: req.ip });
    return tooMany(res, wait);
  }
  const { busy, result: identity } = await limitedCheck(() => authenticate(username, password, source));
  if (busy) {
    audit('login_busy', { user: username, outcome: 'refused', ip: req.ip });
    return res.status(503).json({ error: 'Serveur occupé, réessayer dans un instant' });
  }
  if (!identity) {
    await recordFailure(req, account, trusted);
    audit('login_failed', { user: username, outcome: 'refused', step: 'password', trusted, ip: req.ip });
    await sleep(Math.max(0, FAILURE_MIN_MS - (Date.now() - started)));
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  if (!trusted) guard.recordSuccess(req.ip, account);
  const nonCompliant = identity.type === 'local' && !(await users.passwordCompliant(identity.user, password));
  const login = { ...identity, account, trusted, nonCompliant };
  return settings.totpEnabled ? startTotpStep(req, res, login) : completeLogin(req, res, login);
}

router.post('/api/auth/login', handle(async (req, res) => {
  const settings = await totp.getAuthSettings();
  const code = String(req.body?.totpCode || '').trim();
  return code ? verifyTotpStep(req, res, code, settings) : verifyPasswordStep(req, res, settings);
}));

router.post('/api/auth/change-password', handle(async (req, res) => {
  const token = readCookies(req)[COOKIES.password];
  const pending = token && passwordPending.get(token);
  const expire = () => {
    if (token) passwordPending.delete(token);
    clearCookies(res, COOKIES.password);
    return res.status(400).json({ ok: false, code: 'PASSWORD_SESSION_EXPIRED' });
  };
  if (!pending || isExpired(pending, PASSWORD_PENDING_TTL_MS)) return expire();
  let user;
  try {
    user = await users.changeRequiredPassword(pending.id, req.body?.newPassword);
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    pending.failed += 1;
    if (pending.failed >= PASSWORD_MAX_ERRORS) return expire();
    return res.status(400).json({ ok: false, code: 'PASSWORD_INVALID', error: e.message });
  }
  if (user !== pending.user) return expire();
  passwordPending.delete(token);
  clearCookies(res, COOKIES.password);
  await openSession(res, user, 'local');
  await trustDevice(req, res, pending.account);
  audit('password_changed', { user, ip: req.ip });
  audit('login', { user, type: 'local', ip: req.ip });
  return res.json({ ok: true, user });
}));

router.get('/api/auth/options', handle(async (_req, res) => res.json({ domain: await ldap.hasEnabledConfig() })));

router.post('/api/auth/logout', handle(async (req, res) => {
  const session = await currentSession(req);
  if (session) {
    await closeSession(session.jti);
    audit('logout', { user: session.user, ip: req.ip });
  }
  clearCookies(res, COOKIES.session, COOKIES.totp, COOKIES.password);
  res.json({ ok: true });
}));

async function passwordMatches(session, password) {
  if (session.type !== 'domain') return users.authenticate(session.user, password);
  const at = session.user.lastIndexOf('@');
  const result = await ldap.authenticate(session.user.slice(0, at), password);
  return Boolean(result) && `${result.username}@${result.domain}` === session.user;
}

async function endLockedSession(req, res, seconds) {
  await closeSession(req.session.jti);
  clearCookies(res, COOKIES.session);
  audit('password_check_locked', { user: req.user, outcome: 'refused', ip: req.ip });
  return res.status(401).json({ error: `Trop de tentatives, réessayer dans ${waitText(seconds)}` });
}

async function ownPasswordConfirmed(req, res, value) {
  const account = `${req.user}|confirm`;
  const wait = guard.retryAfter(req.ip, account);
  if (wait) { await endLockedSession(req, res, wait); return false; }
  const password = typeof value === 'string' ? value : '';
  const { busy, result: valid } = await limitedCheck(() => passwordMatches(req.session, password));
  if (busy) {
    audit('password_check_busy', { user: req.user, outcome: 'refused', ip: req.ip });
    res.status(503).json({ error: 'Serveur occupé, réessayer dans un instant' });
    return false;
  }
  if (!valid) {
    guard.recordFailure(req.ip, account);
    audit('password_check_failed', { user: req.user, outcome: 'refused', ip: req.ip });
    const locked = guard.retryAfter(req.ip, account);
    if (locked) await endLockedSession(req, res, locked);
    else res.status(403).json({ error: 'Mot de passe incorrect' });
    return false;
  }
  guard.recordSuccess(req.ip, account);
  return true;
}

router.post('/api/users/:id/reset-password', auth,
  auditAction('user_password_reset', { names: namesFrom('SELECT id, username AS name FROM local_users WHERE id::text = ANY($1)') }), handle(async (req, res) => {
  const entry = await users.get(req.params.id);
  if (!entry) return notFound(res);
  const { oldPassword, newPassword, confirmPassword } = req.body || {};
  if (typeof newPassword !== 'string' || !newPassword) throw new ValidationError('Nouveau mot de passe requis');
  if (newPassword !== confirmPassword) throw new ValidationError('La confirmation ne correspond pas au nouveau mot de passe');
  if (!(await ownPasswordConfirmed(req, res, oldPassword))) return undefined;
  const self = req.session.type === 'local' && entry.username === req.user;
  if (self && newPassword === oldPassword) throw new ValidationError('Le nouveau mot de passe doit être différent de l\'ancien');
  await users.update(entry.id, { password: newPassword, must_change_password: !self });
  if (self) {
    await closeSession(req.session.jti);
    await openSession(res, req.user, 'local');
  }
  return res.json({ ok: true });
}));

router.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user, version: pkg.version }));

router.get('/api/auth/settings', auth, handle(async (_req, res) => res.json(await totp.getAuthSettings())));

router.put('/api/auth/settings', auth, auditAction('totp_settings_modified', {
  context: async () => ({ from: (await totp.getAuthSettings()).totpEnabled }), details: (_req, s) => ({ to: s?.totpEnabled }) }), handle(async (req, res) => {
  const body = req.body || {};
  if ('totpEnabled' in body) await totp.setTotpEnabled(Boolean(body.totpEnabled));
  res.json(await totp.getAuthSettings());
}));

router.get('/api/auth/password-policy', auth, handle(async (_req, res) => res.json(await getPasswordPolicy())));

const COMPLEXITY_TEXT = { none: 'aucune', three: '3 types sur 4', four: '4 types sur 4' };
const policyLabel = (p) => p && `${p.minLength} caractères, complexité ${COMPLEXITY_TEXT[p.complexity]}`;
router.put('/api/auth/password-policy', auth, auditAction('password_policy_modified', {
  context: async () => ({ from: policyLabel(await getPasswordPolicy()) }), details: (_req, s) => ({ to: policyLabel(s) }) }), handle(async (req, res) => {
  res.json(await setPasswordPolicy(req.body));
}));

router.get('/api/logs/settings', auth, handle(async (_req, res) => res.json({ colors: await getLogColors() })));
router.put('/api/logs/settings', auth, auditAction('log_colors_modified', {
  context: async () => ({ from: await getLogColors() }), details: (_req, s) => ({ to: s?.colors }) }), handle(async (req, res) => {
  res.json({ colors: await setLogColors(req.body?.colors) });
}));

router.get('/api/logs/trace', auth, handle(async (_req, res) => res.json(await getCommandTrace())));
router.put('/api/logs/trace', auth, auditAction('command_trace_modified', {
  context: async () => ({ from: (await getCommandTrace()).packerLinux }), details: (_req, s) => ({ to: s?.packerLinux }) }), handle(async (req, res) => res.json(await setCommandTrace(req.body || {}))));
