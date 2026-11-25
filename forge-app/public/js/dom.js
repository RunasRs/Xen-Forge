export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  if (tag === 'button' && !('type' in (attrs || {}))) el.type = 'button';
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  if (tag === 'textarea' && attrs?.value != null) el.value = attrs.value;
  return el;
}

export function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children.flat().filter(Boolean));
  return el;
}

export const svgIcon = (d) => svgEl('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svgEl('path', { d }));

export const crossIcon = () => svgIcon('M4 4l8 8M12 4l-8 8');

const ACTION_ICONS = {
  Ajouter: 'M8 3v10M3 8h10',
  Importer: 'M8 2.5v7M5 6.5l3 3 3-3M2.5 11v2.5h11V11',
  Exporter: 'M8 9.5v-7M5 5.5l3-3 3 3M2.5 11v2.5h11V11',
  Modifier: 'M10.5 2.5l3 3L6 13H3v-3z',
  Cloner: 'M5.5 5.5h8v8h-8zM2.5 10.5v-8h8',
  Valider: 'M3 8.5l3 3 7-7',
  Vérifier: 'M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM5.5 8.2l1.8 1.8 3.2-3.5',
  Construire: 'M5 3l8 5-8 5z',
  Appliquer: 'M5 3l8 5-8 5z',
  Relancer: 'M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 2.5v3h-3',
  Annuler: 'M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM3.4 3.4l9.2 9.2',
  Supprimer: 'M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4',
  Détruire: 'M8 1.5v6M4.5 3.8a5.5 5.5 0 107 0',
  Activer: 'M5.5 4.5h5a3.5 3.5 0 010 7h-5a3.5 3.5 0 010-7zM10.5 6.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z',
  Désactiver: 'M5.5 4.5h5a3.5 3.5 0 010 7h-5a3.5 3.5 0 010-7zM5.5 6.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z',
  Révéler: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 110 4 2 2 0 010-4z',
  Détails: 'M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM8 7.5V11M8 5h.01',
  'Réinitialiser le mot de passe': 'M10 2.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zM7.5 8.5l-5 5M4 12l1.5 1.5M5.5 10.5L7 12',
  TOTP: 'M5 1.5h6v13H5zM7.5 12h1',
  Tester: 'M1.5 8h3l2-4.5 3 9 2-4.5h3',
  'Tester la connexion': 'M1.5 8h3l2-4.5 3 9 2-4.5h3',
  'Convertir en YAML': 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5',
  'Détecter le maître': 'M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM8 5a3 3 0 110 6 3 3 0 010-6zM8 7.5h.01',
};

export const actionIcon = (label) => (ACTION_ICONS[label] ? svgIcon(ACTION_ICONS[label]) : null);

export function morph(cur, next) {
  if (cur.nodeType !== next.nodeType || cur.nodeName !== next.nodeName) { cur.replaceWith(next); return; }
  if (cur.nodeType !== Node.ELEMENT_NODE) {
    if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue;
    return;
  }
  const keep = new Set((cur.getAttribute('data-morph-keep') || '').split(/\s+/).filter(Boolean));
  for (const { name, value } of [...next.attributes]) if (!keep.has(name) && cur.getAttribute(name) !== value) cur.setAttribute(name, value);
  for (const { name } of [...cur.attributes]) if (!keep.has(name) && !next.hasAttribute(name)) cur.removeAttribute(name);
  const a = [...cur.childNodes];
  const b = [...next.childNodes];
  b.forEach((n, i) => (a[i] ? morph(a[i], n) : cur.append(n)));
  a.slice(b.length).forEach((n) => n.remove());
}

export const ICONS = {
  calendar: 'M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3',
  disc: 'M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM8 6a2 2 0 110 4 2 2 0 010-4z',
  history: 'M2.5 8a5.5 5.5 0 105.5-5.5A5.6 5.6 0 004 4.3M2.5 1.8v2.7h2.7M8 5v3l2 1.5',
  user: 'M8 1.5a3 3 0 110 6 3 3 0 010-6zM2.5 14.5a5.5 5.5 0 0111 0',
  users: 'M6 2a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM1.5 13.5a4.5 4.5 0 019 0M10.5 2.3a2.5 2.5 0 010 4.4M12 9.3a4.5 4.5 0 012.5 4.2',
  lock: 'M3.5 7h9v7h-9zM5.5 7V5a2.5 2.5 0 015 0v2M8 10v1.5',
  certificate: 'M2.5 2.5h11v8h-11zM5 5h6M5 7.5h3.5M10.5 9a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM9.6 11.7L9 14.5l1.5-.8 1.5.8-.6-2.8',
  server: 'M2.5 2.5h11v4h-11zM2.5 9.5h11v4h-11zM5 4.5h.01M5 11.5h.01',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1',
  shield: 'M8 1.5l5.5 2v4c0 3.5-2.5 5.8-5.5 7-3-1.2-5.5-3.5-5.5-7v-4zM5.8 8l1.6 1.6L10.5 6.5',
  audit: 'M5.5 1.5h5v2h-5zM4 2.5H2.5v12h11v-12H12M5 7h6M5 9.5h6M5 12h3.5',
};

export function toast(msg) {
  const slot = document.getElementById('toast-slot');
  const box = h('div', { class: 'status-message', role: 'alert' },
    h('div', { class: 'status-text' }, msg),
    h('button', { class: 'status-close', type: 'button', 'aria-label': 'Fermer', onclick: () => box.remove() }, '×'));
  slot.replaceChildren(box);
  setTimeout(() => box.remove(), 4500);
}
