import { crossIcon, h, svgEl, svgIcon, toast } from './dom.js';
import { helpTip } from './display.js';

export const checkbox = (checked) => h('input', { type: 'checkbox', checked: !!checked });

export const toggleSwitch = (input, label) => h('label', { class: 'inline-toggle' }, input.classList.add('toggle-checkbox') || input,
  h('span', { class: 'toggle-switch', 'aria-hidden': 'true' }, h('span', { class: 'toggle-slider' })), h('span', { class: 'txt' }, label));

const tipLabel = (label) => {
  const el = h('label', {}, label);
  el.addEventListener('mouseenter', () => { el.title = el.scrollWidth > el.clientWidth ? el.textContent : ''; });
  return el;
};

export function numberStepper(input) {
  const step = (dir) => {
    if (input.disabled || input.readOnly) return;
    if (input.step === 'any') {
      const bound = (v, fallback) => (v === '' ? fallback : Number(v));
      const next = Math.round(((Number(input.value) || 0) + dir) * 1e9) / 1e9;
      input.value = String(Math.min(Math.max(next, bound(input.min, -Infinity)), bound(input.max, Infinity)));
    } else if (dir > 0) input.stepUp(); else input.stepDown();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const button = (dir, label, d) => {
    let timer = null;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; };
    return h('button', { type: 'button', class: 'num-step', tabindex: '-1', title: label, 'aria-label': label,
      onpointerdown: (e) => {
        e.preventDefault();
        input.focus();
        step(dir);
        timer = setTimeout(() => { timer = setInterval(() => step(dir), 70); }, 400);
      },
      onpointerup: stop, onpointerleave: stop, onpointercancel: stop }, svgIcon(d));
  };
  return h('div', { class: 'num-field' }, input, h('div', { class: 'num-steps' },
    button(1, 'Augmenter', 'M4 10l4-4 4 4'), button(-1, 'Diminuer', 'M4 6l4 4 4-4')));
}

export const group = (label, input, hint, full) => h('div', { class: `form-group${full ? ' full' : ''}` },
  hint ? h('div', { class: 'label-with-tip' }, tipLabel(label), helpTip(hint)) : tipLabel(label),
  input?.tagName === 'INPUT' && input.type === 'number' ? numberStepper(input) : input);

export const row = (...groups) => h('div', { class: 'form-row' }, ...groups);

export const section = (title, ...rows) => h('div', { class: 'form-section' }, h('h3', {}, title), ...rows);

export const formActions = (onCancel, submitLabel = 'Enregistrer') => h('div', { class: 'form-actions' },
  h('button', { class: 'btn', onclick: onCancel }, 'Annuler'),
  h('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel));

export function formTabs(entries) {
  const buttons = entries.map(([label], i) => h('button', { class: 'main-tab-btn', onclick: () => show(i) }, label));
  const panes = entries.map(([, content]) => content);
  const show = (index) => {
    buttons.forEach((b, i) => b.classList.toggle('is-active', i === index));
    panes.forEach((p, i) => { p.classList.toggle('tab-off', i !== index); p.inert = i !== index; });
  };
  show(0);
  return { bar: h('div', { class: 'domain-tabs' }, buttons), body: h('div', { class: 'tab-stack' }, panes), show };
}

const eyeIcon = (cls, ...shapes) => svgEl('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ...shapes);

export function passwordField(input) {
  const btn = h('button', { type: 'button', class: 'reveal-btn', 'aria-label': 'Afficher le mot de passe', 'aria-pressed': 'false' },
    eyeIcon('icon-show', svgEl('path', { d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z' }), svgEl('circle', { cx: 12, cy: 12, r: 3 })),
    eyeIcon('icon-hide', svgEl('path', { d: 'M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.6 3.5M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18' })));
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
  });
  return h('div', { class: 'password-wrap' }, input, btn);
}

export function filePicker({ accept, maxBytes, stored = null, emptyLabel = 'Aucun fichier', removeTitle = 'Retirer le fichier' }) {
  const input = h('input', { type: 'file', accept, hidden: true });
  const name = h('span', { class: 'file-name' });
  let picked = null;
  let removed = false;
  const show = () => {
    const keep = stored && !removed;
    name.textContent = picked?.name || (keep ? stored : emptyLabel);
    name.classList.toggle('is-empty', !picked && !keep);
    remove.hidden = !picked && !keep;
  };
  const remove = h('button', { type: 'button', class: 'btn-remove', title: removeTitle, 'aria-label': removeTitle,
    onclick: () => { picked = null; removed = !!stored; input.value = ''; show(); } }, crossIcon());
  const extensions = accept.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x.startsWith('.'));
  const refuse = (message) => { toast(`Fichier refusé : ${message}`); input.value = ''; };
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!extensions.some((x) => lower.endsWith(x) && lower.length > x.length)) return refuse(`extensions acceptées : ${extensions.join(', ')}`);
    if (!file.size) return refuse('fichier vide');
    if (file.size > maxBytes) return refuse(`fichier trop volumineux (${Math.round(maxBytes / 1024)} Kio max)`);
    const reader = new FileReader();
    reader.onerror = () => refuse('lecture impossible');
    reader.onload = () => {
      picked = { name: file.name, data: String(reader.result).split(',')[1] || '' };
      removed = false;
      input.value = '';
      show();
    };
    reader.readAsDataURL(file);
    return undefined;
  });
  show();
  const el = h('div', { class: 'file-picker' },
    h('button', { type: 'button', class: 'btn', onclick: () => input.click() }, svgIcon('M8 10.5V2.5M4.5 6L8 2.5 11.5 6M2.5 10.5v3h11v-3'), 'Parcourir…'),
    name, remove, input);
  return { el, value: () => (picked ? picked.data : removed ? '' : undefined), empty: () => !picked && (!stored || removed) };
}

export function repeatList({ items = [], make, addLabel, max }) {
  const entries = [];
  const list = h('div', { class: 'repeat-list' });
  const addBtn = h('button', { type: 'button', class: 'btn', onclick: () => add({}) }, addLabel);
  const refresh = () => { addBtn.disabled = entries.length >= max; };
  const add = (item) => {
    const { fields, value } = make(item);
    const entry = { value };
    entry.line = h('div', { class: 'repeat-row' }, ...fields,
      h('button', { type: 'button', class: 'btn-remove', title: 'Retirer', 'aria-label': 'Retirer', onclick: () => {
        entries.splice(entries.indexOf(entry), 1);
        entry.line.remove();
        refresh();
      } }, crossIcon()));
    entries.push(entry);
    list.append(entry.line);
    refresh();
  };
  items.forEach(add);
  refresh();
  return { list, addBtn, values: () => entries.map((e) => e.value()) };
}
