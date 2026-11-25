import { app, modalRoot, view } from './page.js';
import { h, toast } from './dom.js';
import { api, SessionExpired } from './api.js';
import { pageAnsibleCatalogue, pageAnsibleProfiles } from './ansible.js';
import { pageAudit } from './audit.js';
import { pageCertificates } from './certificates.js';
import { pageDistributions } from './distributions.js';
import { pageDomain } from './domain.js';
import { pageDashboard, pageHistory, pageJob } from './jobs.js';
import { pageProfiles } from './profiles.js';
import { pageSafe } from './safe.js';
import { pageSchedules } from './schedules.js';
import { pageSecurity, pageSettings } from './servers.js';
import { pageTofuProfiles } from './tofu.js';
import { pageUsers } from './users.js';

const ENGINES = ['packer', 'tofu', 'ansible'];
const PROFILE_PAGES = { packer: pageProfiles, tofu: pageTofuProfiles, ansible: pageAnsibleProfiles };

async function route() {
  const [, first = '', second, third] = (location.hash.slice(1) || '/').split('/');
  const gen = ++view.pageGen;
  clearTimeout(view.timer);
  view.stream?.close();
  modalRoot.replaceChildren();
  const engine = ENGINES.includes(first) ? first : null;
  const page = (engine ? second : first) || '';
  const id = engine ? third : second;
  const prefix = engine ? `/${engine}` : '';
  document.body.dataset.section = engine || (page ? 'admin' : 'home');
  const navRoute = engine ? `${prefix}/${page === 'jobs' ? 'history' : page || 'profiles'}` : `/${page}`;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.route === navRoute));
  const pages = engine
    ? {
      '': () => PROFILE_PAGES[engine](gen),
      profiles: () => PROFILE_PAGES[engine](gen),
      history: () => pageHistory(engine, gen),
      ...(engine === 'packer' ? { distributions: () => pageDistributions(gen), schedules: () => pageSchedules('packer', gen) } : {}),
      ...(engine === 'tofu' ? { schedules: () => pageSchedules('tofu', gen) } : {}),
      ...(engine === 'ansible' ? { catalogue: () => pageAnsibleCatalogue(gen), schedules: () => pageSchedules('ansible', gen) } : {}),
      jobs: () => (id ? pageJob(engine, id, gen) : location.replace(`#${prefix}/history`)),
    }
    : {
      '': () => pageDashboard(gen),
      connectors: () => pageSettings(gen),
      settings: () => location.replace('#/connectors'),
      security: () => pageSecurity(),
      safe: () => pageSafe(gen),
      certificates: () => pageCertificates(gen),
      audit: () => pageAudit(gen),
      users: () => pageUsers(gen),
      domain: () => pageDomain(gen),
    };
  try {
    if (pages[page]) await pages[page]();
    else app.replaceChildren(h('p', {}, 'Page introuvable'));
  } catch (e) {
    if (!(e instanceof SessionExpired)) toast(e.message);
  }
}

const themeToggle = document.getElementById('theme-toggle');
const THEME_MODES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'système', light: 'clair', dark: 'sombre' };
const nextThemeMode = mode => THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
const syncThemeToggle = () => {
  const mode = window.forgeTheme.mode();
  themeToggle.title = `Thème ${THEME_LABELS[mode]} : passer en thème ${THEME_LABELS[nextThemeMode(mode)]}`;
  themeToggle.setAttribute('aria-label', themeToggle.title);
};
syncThemeToggle();
document.addEventListener('forge-theme-change', syncThemeToggle);
themeToggle.addEventListener('click', () => window.forgeTheme.setMode(nextThemeMode(window.forgeTheme.mode())));

const userMenu = document.getElementById('user-menu');
const userMenuBtn = document.getElementById('user-menu-btn');
const userMenuList = document.getElementById('user-menu-list');
const menuItems = () => [...userMenuList.querySelectorAll('[role="menuitem"]')];
const setUserMenu = (open, { focus = false } = {}) => {
  userMenuList.hidden = !open;
  userMenuBtn.setAttribute('aria-expanded', String(open));
  if (open && focus) menuItems()[0]?.focus();
};
userMenuBtn.addEventListener('click', () => setUserMenu(userMenuList.hidden));
userMenuBtn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setUserMenu(true, { focus: true }); }
});
userMenuList.addEventListener('keydown', (e) => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.stopPropagation(); setUserMenu(false); userMenuBtn.focus(); }
  else if (e.key === 'Tab') setUserMenu(false);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
});
document.addEventListener('click', (e) => { if (!userMenu.contains(e.target)) setUserMenu(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !userMenuList.hidden) { setUserMenu(false); userMenuBtn.focus(); }
});

const userInitial = (name) => (name.split('\\').pop().match(/[\p{L}\p{N}]/u)?.[0] || '?').toLocaleUpperCase('fr');

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => { location.hash = `#${b.dataset.route}`; }));
document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.replace('/');
});

try {
  const me = await api('/auth/me');
  view.currentUser = me.user;
  const initial = userInitial(me.user);
  document.getElementById('session-name').textContent = me.user.replace(/@[^@]*$/, '');
  document.getElementById('app-version').textContent = `v${me.version}`;
  document.getElementById('user-initial').textContent = initial;
  document.getElementById('user-initial-lg').textContent = initial;
  userMenuBtn.title = me.user;
  userMenuBtn.setAttribute('aria-label', `Menu de ${me.user}`);
  window.addEventListener('hashchange', route);
  route();
} catch {}
