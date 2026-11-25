import { audit } from '../audit.js';
import { readSession, signSession } from '../crypto.js';
import { domainSessionValid, stillAuthorized } from '../ldap.js';
import { activeSession, closeSession, createSession, markChecked } from '../sessions.js';
import { sessionValid } from '../users.js';

const SESSION_TTL_MS = 12 * 3600 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const COOKIE_ATTRIBUTES = { httpOnly: true, sameSite: 'strict', secure: true, path: '/' };

export const COOKIES = { session: '__Host-sid', totp: '__Host-totp_pending', password: '__Host-password_pending', device: '__Host-device' };

export const cookieOptions = (maxAge) => ({ ...COOKIE_ATTRIBUTES, maxAge });
export const clearCookies = (res, ...names) => names.forEach((name) => res.clearCookie(name, COOKIE_ATTRIBUTES));
export const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const notFound = (res) => res.status(404).json({ error: 'Introuvable' });


export function readCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k),
  );
}

const rechecks = new Map();

function recheckDomain(jti, user) {
  if (!rechecks.has(jti)) {
    rechecks.set(jti, (async () => {
      const allowed = await stillAuthorized(user);
      if (allowed === false) {
        await closeSession(jti);
        audit('session_closed_by_directory', { actor: 'system', user, target: user });
        return false;
      }
      await markChecked(jti);
      return true;
    })().finally(() => rechecks.delete(jti)));
  }
  return rechecks.get(jti);
}

export async function currentSession(req) {
  const token = readSession(readCookies(req)[COOKIES.session]);
  if (!token?.jti) return null;
  const stored = await activeSession(token.jti);
  if (!stored || stored.username !== token.user || stored.type !== token.type) return null;
  const valid = token.type === 'domain'
    ? await domainSessionValid(token.user) && (!stored.recheck || await recheckDomain(token.jti, token.user))
    : token.type === 'local' && await sessionValid(token.user, token.iat);
  return valid ? { user: token.user, type: token.type, jti: token.jti } : null;
}

export async function openSession(res, user, type) {
  const jti = await createSession(user, type, SESSION_TTL_MS);
  res.cookie(COOKIES.session, signSession(user, type, SESSION_TTL_MS, jti), cookieOptions(SESSION_TTL_MS));
}

export const auth = handle(async (req, res, next) => {
  const session = await currentSession(req);
  if (!session) {
    clearCookies(res, COOKIES.session);
    return res.status(401).json({ error: 'Non authentifié' });
  }
  req.user = session.user;
  req.session = session;
  return next();
});

export function sameOriginOnly(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  const site = req.get('sec-fetch-site');
  const allowed = origin ? origin === `https://${req.get('host')}` : !site || site === 'same-origin' || site === 'none';
  if (allowed) return next();
  audit('cross_origin_refused', { outcome: 'refused', status: 403, method: req.method, path: req.path, origin, site, ip: req.ip });
  return res.status(403).json({ error: 'Origine de la requête refusée' });
}
