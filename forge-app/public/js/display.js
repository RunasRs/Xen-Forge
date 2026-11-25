import { h, svgEl, svgIcon } from './dom.js';
import { fmtDate, plural, timeAgo } from './format.js';
import { ENGINE_CARDS } from './engines.js';

const STATUS_LABELS = {
  queued: 'en attente', running: 'en cours', success: 'réussi', failed: 'échec', cancelled: 'annulé', active: 'actif', disabled: 'désactivé',
};

const statusLabel = (s) => STATUS_LABELS[s] || s;

export const stateBadge = (cls, label, title = '') => h('span', { class: `badge st ${cls}`, ...(title ? { title } : {}) }, label);

export const stateIcon = (cls, label, title = label) => h('span', { class: `badge st ${cls} icon-only`, role: 'img', 'aria-label': label, title });

export const jobIcon = (j) => stateIcon(j.status, statusLabel(j.status));

export const jobBadge = (j) => h('span', { class: `badge st ${j.status}` }, statusLabel(j.status));

export const activeIcon = (on) => (on ? stateIcon('active', 'Actif') : stateIcon('disabled', 'Désactivé'));

export const active = (j) => ['running', 'queued'].includes(j.status);

export const stateRing = (icon, { state = '', label = '' } = {}) => h('div', {
  class: `ec-ring${state ? ` ${state}` : ''}`, ...(label ? { role: 'img', 'aria-label': label.replace(/\n/g, '. '), title: label } : { 'aria-hidden': 'true' }) },
svgEl('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' }, svgEl('circle', { class: 'ec-track', cx: 60, cy: 60, r: 52 })),
h('span', { class: 'ec-ring-icon' }, svgIcon(icon)));

const iconRing = (icon) => h('span', { class: 'ec-ring-slot' }, stateRing(icon));

export const cardHeader = (icon, title, subtitle, ...right) => {
  const [text, tip] = [].concat(title);
  return h('div', { class: 'ec-head' },
    icon instanceof Node ? icon : iconRing(icon),
    h('div', { class: 'ec-title' },
      tip ? h('div', { class: 'ec-title-row' }, h('h2', {}, text), tip) : h('h2', {}, text),
      subtitle == null ? null : h('span', {}, subtitle)),
    ...right);
};

export function tipLines(...lines) {
  const kept = lines.filter(Boolean);
  return kept.length ? kept.flatMap(([title, ...body], i) => [i ? h('br') : null, h('b', {}, `${title} : `), ...body]) : null;
}

export function helpTip(text) {
  const tip = h('span', { class: 'help-tip-text', role: 'tooltip', hidden: true }, text);
  const btn = h('button', { type: 'button', class: 'help-tip-btn', 'aria-label': 'Aide', 'aria-expanded': 'false' }, '?');
  const wrap = h('span', { class: 'help-tip' }, btn, tip);
  const outside = (e) => { if (!wrap.contains(e.target)) set(false); };
  const escape = (e) => { if (e.key === 'Escape') { e.stopPropagation(); set(false); } };
  const dismiss = () => set(false);
  const place = () => {
    const r = btn.getBoundingClientRect();
    const margin = 8;
    const below = r.bottom + 6;
    const top = below + tip.offsetHeight > window.innerHeight - margin ? r.top - 6 - tip.offsetHeight : below;
    tip.style.top = `${Math.max(margin, top)}px`;
    tip.style.left = `${Math.max(margin, Math.min(r.left, window.innerWidth - tip.offsetWidth - margin))}px`;
  };
  function set(open) {
    tip.hidden = !open;
    if (open) place();
    btn.setAttribute('aria-expanded', String(open));
    const method = open ? 'addEventListener' : 'removeEventListener';
    document[method]('click', outside);
    window[method]('keydown', escape, true);
    window[method]('scroll', dismiss, true);
    window[method]('resize', dismiss);
  }
  btn.addEventListener('click', () => set(tip.hidden));
  return wrap;
}

const fullText = (v) => (typeof v === 'string' || typeof v === 'number' ? { title: String(v) } : {});

export const stack = (main, sub) => h('span', { class: 'cell-stack' }, h('b', fullText(main), main), sub ? h('span', fullText(sub), sub) : null);

export const emptyCell = () => h('span', { class: 'cell-muted' }, '—');

export const oneLine = (text) => h('span', { class: 'cell-line', title: text }, text);

export const when = (d) => (d ? h('span', { class: 'cell-when', title: fmtDate(d) }, timeAgo(d)) : '—');

const usagePlace = (u) => u.place || `${ENGINE_CARDS[u.engine]?.name || u.engine} > Profils`;

export const usersText = (users, shown = 5) => [users.slice(0, shown).map((u) => `« ${u.name} » [${usagePlace(u)}]`).join(', '),
  users.length > shown ? ` et ${plural(users.length - shown, 'autre')}` : ''].join('');

export const usedByCell = (users = []) => {
  const connectors = users.filter((u) => u.engine === 'connector').length;
  const profiles = users.length - connectors;
  return users.length ? h('span', { class: 'cell-line', title: usersText(users, users.length) },
    [profiles && plural(profiles, 'profil'), connectors && plural(connectors, 'connecteur')].filter(Boolean).join(' · ')) : emptyCell();
};
