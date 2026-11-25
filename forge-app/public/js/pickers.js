import { view } from './page.js';
import { h, svgIcon } from './dom.js';
import { api } from './api.js';

export function placePanel(wrap, panel) {
  const scroller = wrap.closest('.modal-scroll');
  if (scroller) panel.classList.add('is-floating');
  const field = wrap.getBoundingClientRect();
  const height = panel.offsetHeight + 8;
  if (!scroller) {
    panel.classList.toggle('is-up', field.bottom + height > window.innerHeight && field.top - height >= 0);
    return;
  }
  const box = scroller.getBoundingClientRect();
  if (field.bottom < box.top || field.top > box.bottom) { panel.hidden = true; return; }
  const up = field.bottom + height > window.innerHeight && field.top - height >= 0;
  const right = panel.matches('.time-panel');
  Object.assign(panel.style, {
    left: right ? 'auto' : `${field.left}px`,
    right: right ? `${document.documentElement.clientWidth - field.right}px` : 'auto',
    width: right ? '' : `${field.width}px`,
    top: up ? 'auto' : `${field.bottom + 4}px`,
    bottom: up ? `${window.innerHeight - field.top + 4}px` : 'auto',
  });
  if (!panel.floatTracked) {
    panel.floatTracked = true;
    const follow = () => {
      if (!panel.isConnected) { window.removeEventListener('resize', follow); return; }
      if (!panel.hidden) placePanel(wrap, panel);
    };
    scroller.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', follow);
  }
}

export function searchPicker(load, value, onPick = () => {}, { searchMeta = false, placeholder = 'Sélectionner...', label: initialLabel, hidden = () => false } = {}) {
  const label = h('span', { class: 'picker-label', title: initialLabel || value || '' }, initialLabel || value || placeholder);
  const search = h('input', { type: 'text', class: 'picker-search', placeholder: 'Rechercher...', autocomplete: 'off' });
  const list = h('ul', { class: 'picker-list', role: 'listbox' });
  const panel = h('div', { class: 'picker-panel', hidden: true }, search, list);
  const trigger = h('button', { type: 'button', class: 'picker-trigger', 'aria-haspopup': 'listbox' }, label, h('span', { class: 'picker-caret' }, svgIcon('M4 6l4 4 4-4')));
  let selected = value || '';
  let items = null;
  let err = null;

  const render = () => {
    const term = search.value.trim().toLowerCase();
    const matches = (items || []).filter((s) => !hidden(s.value ?? s.name)).filter((s) => (searchMeta ? `${s.name} ${s.meta || ''} ${s.tip || ''}` : s.name).toLowerCase().includes(term)).map((s) => {
      const v = s.value ?? s.name;
      return h('li', {
        role: 'option',
        class: `picker-item${v === selected ? ' is-selected' : ''}`,
        onclick: () => {
          selected = v;
          label.textContent = s.name;
          label.title = s.tip || s.name;
          panel.hidden = true;
          onPick(v, s);
          wrap.dispatchEvent(new Event('change'));
        },
        title: s.tip || (s.meta ? `${s.name} — ${s.meta}` : s.name),
      }, h('span', {}, s.name), h('small', {}, s.meta || ''));
    });
    const emptyText = err || (items ? 'Aucun résultat.' : 'Chargement...');
    list.replaceChildren(...(matches.length ? matches : [h('li', { class: 'picker-empty', title: emptyText }, emptyText)]));
  };
  const open = async () => {
    panel.hidden = false; search.value = ''; search.focus(); render();
    placePanel(wrap, panel);
    if (!items) {
      try { items = (await load()) || []; err = null; } catch (e) { items = []; err = e.message; }
      render();
      placePanel(wrap, panel);
    }
  };
  trigger.addEventListener('click', () => (panel.hidden ? open() : (panel.hidden = true)));
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  const wrap = h('div', { class: 'picker' }, trigger, panel);
  document.addEventListener('mousedown', function away(e) {
    if (!wrap.isConnected) return document.removeEventListener('mousedown', away);
    if (!wrap.contains(e.target)) panel.hidden = true;
  });
  Object.defineProperty(wrap, 'value', { get: () => selected });
  wrap.setValue = (v, text, tip) => { selected = v || ''; label.textContent = text || placeholder; label.title = tip || text || ''; };
  wrap.reload = () => { items = null; err = null; if (!panel.hidden) open(); };
  Object.defineProperty(wrap, 'disabled', {
    get: () => trigger.disabled,
    set: (d) => { trigger.disabled = !!d; if (d) panel.hidden = true; },
  });
  return wrap;
}

export function optionPicker(options, selected = '', { placeholder = 'Sélectionner...', missing = 'Valeur introuvable', hidden } = {}) {
  let opts = options;
  let ready;
  const loaded = new Promise((resolve) => { ready = resolve; });
  if (opts) ready();
  const textFor = (v) => {
    if (!opts) return v ? 'Chargement...' : placeholder;
    const o = opts.find((x) => x.value === v);
    return o ? o.name : v ? missing : placeholder;
  };
  const el = searchPicker(async () => { await loaded; return opts; }, selected || '', undefined,
    { searchMeta: true, placeholder, label: textFor(selected || ''), hidden });
  el.setOptions = (list, value = el.value) => {
    opts = list || [];
    ready();
    el.reload();
    el.setValue(value, textFor(value || ''), opts.find((x) => x.value === value)?.tip);
  };
  el.choose = (v) => {
    const o = opts?.find((x) => x.value === v);
    if (o) el.setValue(o.value, o.name, o.tip);
    return !!o;
  };
  return el;
}

export function scrollSelect(options, selected) {
  let values = [];
  let labels = [];
  let items = [];
  let current = selected;
  let cursor = 0;
  let typed = '';
  let typedAt = 0;
  const label = h('span', { class: 'picker-label' });
  const list = h('ul', { class: 'picker-list picker-list-scroll', role: 'listbox' });
  const build = (opts, value) => {
    const known = opts.map((o) => (Array.isArray(o) ? o : [o, o]));
    const pairs = known.some(([v]) => v === value) ? known : [[value, value], ...known];
    values = pairs.map(([v]) => v);
    labels = pairs.map(([, l]) => l);
    current = value;
    cursor = values.indexOf(value);
    label.textContent = labels[cursor];
    label.title = labels[cursor];
    items = labels.map((text, i) => h('li', { role: 'option', class: 'picker-item', title: text, onclick: () => pick(i) }, text));
    list.replaceChildren(...items);
  };
  build(options, selected);
  const panel = h('div', { class: 'picker-panel', hidden: true }, list);
  const trigger = h('button', { type: 'button', class: 'picker-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    onclick: () => (panel.hidden ? open() : close()) }, label, h('span', { class: 'picker-caret' }, svgIcon('M4 6l4 4 4-4')));
  const wrap = h('div', { class: 'picker' }, trigger, panel);
  const paint = () => items.forEach((li, i) => {
    li.classList.toggle('is-selected', values[i] === current);
    li.classList.toggle('is-cursor', i === cursor);
    li.setAttribute('aria-selected', String(values[i] === current));
  });
  function moveTo(i) {
    cursor = Math.max(0, Math.min(values.length - 1, i));
    paint();
    const li = items[cursor];
    if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
    else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
  }
  function open() {
    cursor = values.indexOf(current);
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    placePanel(wrap, panel);
    paint();
    list.scrollTop = items[cursor].offsetTop - 2 * items[cursor].offsetHeight;
  }
  function close() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  function pick(i) {
    const changed = values[i] !== current;
    current = values[i];
    label.textContent = labels[i];
    label.title = labels[i];
    close();
    trigger.focus();
    if (changed) wrap.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function typeAhead(key) {
    typed = Date.now() - typedAt > 800 ? key : typed + key;
    typedAt = Date.now();
    const found = labels.findIndex((text) => text.toLowerCase().startsWith(typed.toLowerCase()));
    if (found >= 0) moveTo(found);
  }
  wrap.addEventListener('keydown', (e) => {
    const isChar = e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (panel.hidden) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && !isChar) return;
      e.preventDefault();
      open();
      if (isChar) typeAhead(e.key);
      return;
    }
    if (e.key === 'Tab') return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' || e.key === ' ') pick(cursor);
    else if (e.key === 'ArrowDown') moveTo(cursor + 1);
    else if (e.key === 'ArrowUp') moveTo(cursor - 1);
    else if (e.key === 'Home') moveTo(0);
    else if (e.key === 'End') moveTo(values.length - 1);
    else if (isChar) typeAhead(e.key);
    else return;
    e.preventDefault();
  });
  wrap.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !wrap.contains(e.relatedTarget)) close();
  });
  document.addEventListener('mousedown', function away(e) {
    if (!wrap.isConnected) return document.removeEventListener('mousedown', away);
    if (!wrap.contains(e.target)) close();
    return undefined;
  });
  Object.defineProperty(wrap, 'value', { get: () => current });
  wrap.setValue = (v) => { const i = values.indexOf(v); if (i >= 0) { current = v; label.textContent = labels[i]; label.title = labels[i]; } };
  wrap.setOptions = (opts, value = current) => { build(opts, value); if (!panel.hidden) paint(); };
  return wrap;
}

export function choiceChips(options, allLabel, initial, { nullWhenAll = false, onChange = () => {} } = {}) {
  const values = new Set(initial ?? options.map(([v]) => v));
  const isAll = () => values.size === options.length;
  const allChip = h('button', { class: 'choice-chip choice-all', onclick: () => {
    const fill = !isAll();
    values.clear();
    if (fill) options.forEach(([v]) => values.add(v));
    paint();
  } }, allLabel);
  const chips = options.map(([v, label]) => [v, h('button', { class: 'choice-chip', onclick: () => {
    if (values.has(v)) values.delete(v); else values.add(v);
    paint();
  } }, label)]);
  function paint() {
    allChip.classList.toggle('is-on', isAll());
    allChip.setAttribute('aria-pressed', String(isAll()));
    chips.forEach(([v, b]) => {
      b.classList.toggle('is-on', values.has(v));
      b.setAttribute('aria-pressed', String(values.has(v)));
    });
    onChange();
  }
  return {
    el: h('div', { class: 'choice-chips' }, allChip, chips.map(([, b]) => b)),
    value: () => (nullWhenAll && isAll() ? null : options.map(([v]) => v).filter((v) => values.has(v))),
    paint,
  };
}

const loadSrs = () => (view.srPromise ||= api('/xcp/srs').catch((e) => { view.srPromise = null; throw e; }));
const loadNetworks = () => (view.networksPromise ||= api('/xcp/networks').catch((e) => { view.networksPromise = null; throw e; }));

export function xcpPicker(type, value, onPick) {
  const load = type === 'network' ? loadNetworks : async () => (await loadSrs())[type];
  return searchPicker(load, value, onPick);
}

export function srPicker(type, uuid, onPick, { uniqueName = false } = {}) {
  const missing = uniqueName ? 'SR introuvable ou nom partagé par plusieurs SR : le renommer dans Xen Orchestra ou en choisir un autre'
    : 'SR introuvable : le choisir à nouveau';
  const el = optionPicker(null, uuid, { missing });
  loadSrs().then((all) => el.setOptions(all[type].filter((s) => !uniqueName || !s.shared_name))).catch(() => el.setOptions([]));
  el.addEventListener('change', () => onPick(el.value));
  return el;
}
