import { copySecret, flushSecret } from './js/clipboard.js';

const $ = (id) => document.getElementById(id);
const form = $('login-form');
const statusEl = $('status');
const submitBtn = $('login-btn');
const authSource = $('auth-source');

let step = 'credentials';
let loginInProgress = false;

const STEPS = {
  credentials: { panel: 'credentials-step', action: 'Connexion', focus: 'username' },
  totp: { panel: 'totp-section', focus: 'totp-code' },
  setup: { panel: 'totp-setup', focus: 'totp-setup-code' },
  password: { panel: 'password-step', action: 'Enregistrer et se connecter', focus: 'new-password' },
};
const SECRET_FIELDS = ['password', 'totp-code', 'totp-setup-code', 'new-password', 'confirm-password'];
const OTP_FIELDS = ['totp-code', 'totp-setup-code'];

function renderOtp(input) {
  const active = document.activeElement === input;
  [...input.nextElementSibling.children].forEach((slot, i) => {
    slot.textContent = input.value[i] || '';
    slot.classList.toggle('cur', active && i === input.value.length);
  });
}
const syncOtp = () => OTP_FIELDS.forEach((id) => renderOtp($(id)));

function setStatus(message, isError = true) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = !message;
}

function showStep(name) {
  const cfg = STEPS[name];
  step = name;
  for (const s of Object.values(STEPS)) $(s.panel).hidden = s !== cfg;
  submitBtn.hidden = !cfg.action;
  $('login-btn-label').textContent = cfg.action || '';
  $('back-btn').hidden = name === 'credentials';
  for (const id of SECRET_FIELDS) $(id).value = '';
  if (name !== 'setup') {
    $('totp-qrcode').replaceChildren();
    $('totp-secret').value = '';
  }
  $(name === 'credentials' && $('username').value ? 'password' : cfg.focus).focus();
  syncOtp();
}

document.querySelectorAll('.reveal').forEach((btn) => btn.addEventListener('click', () => {
  const input = $(btn.dataset.target);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', btn.getAttribute('aria-label').replace(show ? 'Afficher' : 'Masquer', show ? 'Masquer' : 'Afficher'));
}));

$('totp-secret-copy').addEventListener('click', async () => {
  const input = $('totp-secret');
  const btn = $('totp-secret-copy');
  try {
    await copySecret(input.value);
    btn.classList.add('copied');
    btn.title = 'Copié';
    setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Copier'; }, 1600);
  } catch {
    setStatus('Copie impossible : affichez la clé et recopiez-la.');
  }
});

for (const id of OTP_FIELDS) {
  const input = $(id);
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== input.value) input.value = digits;
    renderOtp(input);
    if (digits.length === 6 && !loginInProgress) form.requestSubmit();
  });
  input.addEventListener('focus', () => renderOtp(input));
  input.addEventListener('blur', () => renderOtp(input));
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function qrSvg(qr) {
  const size = Number(qr?.size);
  const bits = String(qr?.modules || '');
  if (!Number.isInteger(size) || size < 21 || size > 177 || bits.length !== size * size || /[^01]/.test(bits)) return null;
  const el = (tag, attrs) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'QR code à scanner avec l\'application d\'authentification' });
  const finders = [[0, 0], [size - 7, 0], [0, size - 7]];
  const inFinder = (x, y) => finders.some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
  let dots = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (bits[y * size + x] === '1' && !inFinder(x, y)) dots += `M${x + 0.05} ${y + 0.5}a.45 .45 0 1 0 .9 0a.45 .45 0 1 0-.9 0`;
    }
  }
  svg.append(el('path', { d: dots }));
  for (const [fx, fy] of finders) {
    svg.append(
      el('path', { 'fill-rule': 'evenodd', d: `M${fx + 2} ${fy}h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z`
        + `M${fx + 2.2} ${fy + 1}h2.6a1.2 1.2 0 0 1 1.2 1.2v2.6a1.2 1.2 0 0 1-1.2 1.2h-2.6a1.2 1.2 0 0 1-1.2-1.2v-2.6a1.2 1.2 0 0 1 1.2-1.2z` }),
      el('rect', { x: fx + 2, y: fy + 2, width: 3, height: 3, rx: 0.9 }),
    );
  }
  return svg;
}

const invalidTimers = new WeakMap();
function flagInvalid(input) {
  input.value = '';
  input.classList.add('invalid');
  input.setAttribute('aria-invalid', 'true');
  clearTimeout(invalidTimers.get(input));
  invalidTimers.set(input, setTimeout(() => {
    input.classList.remove('invalid');
    input.removeAttribute('aria-invalid');
  }, 3000));
  input.focus();
  syncOtp();
}

$('back-btn').addEventListener('click', () => { setStatus('', false); showStep('credentials'); });

fetch('/api/auth/options')
  .then((r) => r.json())
  .then((o) => {
    authSource.hidden = !o.domain;
    if (o.domain) form.elements.authSource.value = 'domain';
  })
  .catch(() => {});

const openApp = async () => {
  await flushSecret();
  if (location.hash) location.reload();
  else location.replace('/');
};

fetch('/api/auth/me').then((r) => { if (r.ok) openApp(); });

const postJson = async (url, payload) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
};

function passwordRequest() {
  if ($('new-password').value !== $('confirm-password').value) {
    setStatus('La confirmation ne correspond pas au nouveau mot de passe.');
    flagInvalid($('confirm-password'));
    return null;
  }
  return postJson('/api/auth/change-password', { newPassword: $('new-password').value });
}

function loginRequest() {
  if (step === 'totp' || step === 'setup') {
    return postJson('/api/auth/login', { totpCode: $(step === 'setup' ? 'totp-setup-code' : 'totp-code').value.trim() });
  }
  return postJson('/api/auth/login', {
    username: $('username').value.trim(),
    password: $('password').value,
    authSource: form.elements.authSource.value === 'domain' ? 'domain' : 'local',
  });
}

function handleResponse(data) {
  if (data.ok) {
    openApp();
    return;
  }
  switch (data.code) {
    case 'TOTP_SETUP_VERIFY': {
      showStep('setup');
      const svg = qrSvg(data.totpSetup?.qr);
      $('totp-qrcode').replaceChildren(...(svg ? [svg] : []));
      $('totp-secret').value = data.totpSetup?.secret || '';
      break;
    }
    case 'TOTP_REQUIRED':
      showStep('totp');
      break;
    case 'PASSWORD_CHANGE_REQUIRED':
      showStep('password');
      if (data.reason === 'policy') setStatus('Votre mot de passe ne respecte plus la politique de sécurité.', false);
      break;
    case 'TOTP_INVALID':
      setStatus('Code TOTP invalide.');
      flagInvalid($('totp-code'));
      break;
    case 'TOTP_SETUP_INVALID':
      setStatus('Code TOTP invalide.');
      flagInvalid($('totp-setup-code'));
      break;
    case 'PASSWORD_INVALID':
      setStatus(data.error || 'Mot de passe refusé.');
      $('confirm-password').value = '';
      $('new-password').focus();
      break;
    case 'TOTP_TOO_MANY_ATTEMPTS':
      showStep('credentials');
      setStatus('Trop de codes TOTP invalides : reconnectez-vous dans quelques minutes.');
      break;
    case 'TOTP_ENROLLMENT_CLOSED':
      showStep('credentials');
      setStatus(data.error);
      break;
    case 'TOTP_LOCKOUT':
      setStatus(data.error || 'Compte temporairement verrouillé : réessayez plus tard.');
      break;
    case 'TOTP_SESSION_EXPIRED':
    case 'PASSWORD_SESSION_EXPIRED':
      showStep('credentials');
      setStatus('Étape expirée : reconnectez-vous.');
      break;
    default:
      setStatus(data.error || 'Identifiants invalides.');
      if (step === 'credentials') {
        $('password').value = '';
        $('password').focus();
      }
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (loginInProgress) return;
  setStatus('', false);
  const request = step === 'password' ? passwordRequest() : loginRequest();
  if (!request) return;
  loginInProgress = true;
  submitBtn.disabled = true;
  submitBtn.classList.add('loading');
  try {
    handleResponse(await request);
  } catch (err) {
    setStatus(`Erreur de connexion : ${err.message}`);
  } finally {
    loginInProgress = false;
    submitBtn.disabled = false;
    submitBtn.classList.remove('loading');
  }
});
