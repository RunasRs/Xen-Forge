import { actionIcon, h, morph, svgIcon } from './dom.js';
import { guard } from './api.js';
import { cardHeader, helpTip } from './display.js';
import { confirmDialog } from './modal.js';

const PAGE_SIZES = [20, 50, 100];

const tableState = {};

const COLUMN_ORDER_KEY = 'forge.columns.';

const COLUMN_WIDTH_KEY = 'forge.columnWidths.';

const MIN_COLUMN_PX = 48;

const readStored = (name) => {
  try {
    return JSON.parse(localStorage.getItem(name));
  } catch {
    return null;
  }
};

const writeStored = (name, value) => {
  try {
    if (value) localStorage.setItem(name, JSON.stringify(value));
    else localStorage.removeItem(name);
  } catch {
    return;
  }
};

const trackPointer = (bodyClass, onMove, onEnd) => {
  document.body.classList.add(bodyClass);
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove(bodyClass);
    onEnd();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
};

export const groupFilters = (items) => ({ items: [['', 'Tous'], ...items],
  count: (d, f) => (f ? d.counts?.[f] || 0 : Object.values(d.counts || {}).reduce((a, b) => a + b, 0)) });

export async function dataTable(cfg) {
  const st = (tableState[cfg.key] ||= { page: 1, size: PAGE_SIZES[0], search: '', filter: '', sort: null });
  const rowId = cfg.rowId || ((r) => r.id);
  const paginate = cfg.paginate !== false;
  const selected = new Map();
  const selectable = cfg.select !== false;
  let rows = [];
  let total = 0;
  let data = {};
  let pending = null;
  let busy = false;

  const allowed = (a, r) => (a.allow ? a.allow(r) : true);
  const buttons = (cfg.actions || []).map((a) => [a, h('button', {
    class: `btn${a.danger ? ' btn-danger-text' : ''}`, disabled: true, onclick: () => trigger(a),
  }, actionIcon(a.label), a.label)]);
  const search = cfg.search ? h('input', {
    type: 'text', class: 'search-bar', placeholder: 'Rechercher…', autocomplete: 'off', value: st.search,
  }) : null;
  let debounce;
  search?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(guard(() => { st.search = search.value.trim(); st.page = 1; return reload(true); }), 300);
  });

  const selectAll = h('button', { class: 'row-select', title: 'Sélectionner la page', 'aria-label': 'Sélectionner la page',
    onclick: () => {
      const all = rows.length && rows.every((r) => selected.has(rowId(r)));
      rows.forEach((r) => (all ? selected.delete(rowId(r)) : selected.set(rowId(r), r)));
      render();
    } });
  const tbody = h('tbody');
  const sortable = [];
  const defaultTitles = cfg.columns.map(([t]) => t);
  const storedOrder = readStored(COLUMN_ORDER_KEY + cfg.key);
  const savedTitles = Array.isArray(storedOrder) ? storedOrder : [];
  const storedWidths = readStored(COLUMN_WIDTH_KEY + cfg.key);
  let widths = Object.fromEntries(Object.entries(storedWidths && typeof storedWidths === 'object' ? storedWidths : {})
    .filter(([t, w]) => defaultTitles.includes(t) && /^\d+(\.\d+)?%$/.test(w)));
  const widthOf = (i) => widths[defaultTitles[i]] || cfg.columns[i][2] || '';
  let order = [...savedTitles.map((t) => defaultTitles.indexOf(t)).filter((i, k, a) => i >= 0 && a.indexOf(i) === k),
    ...defaultTitles.map((_, i) => i).filter((i) => !savedTitles.includes(defaultTitles[i]))];
  const cols = () => order.map((i) => cfg.columns[i]);
  const grips = [];
  const resizers = [];
  const ths = cfg.columns.map(([t, , , sortSpec]) => {
    const th = h('th');
    const resizer = h('span', { class: 'th-resize', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
      title: 'Largeur : glisser, ou flèches ← → au clavier', 'aria-label': `Largeur entre la colonne ${t} et la précédente` });
    resizers.push(resizer);
    const grip = h('button', { type: 'button', class: 'th-grip', title: 'Déplacer la colonne : glisser, ou flèches ← → au clavier',
      'aria-label': `Déplacer la colonne ${t}` }, svgIcon('M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01'));
    grips.push(grip);
    const inner = h('span', { class: 'th-inner' }, resizer, grip);
    th.append(inner);
    if (!sortSpec) { inner.append(h('span', { class: 'th-label' }, t)); return th; }
    const [key, first = 'asc'] = sortSpec.split(':');
    const arrow = h('span', { class: 'th-arrow', 'aria-hidden': 'true' });
    inner.append(h('button', { class: 'th-sort', title: `Trier par ${t.toLowerCase()}`,
      onclick: guard(() => {
        const cur = st.sort?.key === key ? st.sort.dir : null;
        const next = !cur ? first : cur === first ? (first === 'asc' ? 'desc' : 'asc') : null;
        st.sort = next ? { key, dir: next } : null;
        st.page = 1;
        return reload(true);
      }) }, h('span', { class: 'th-label' }, t), arrow));
    sortable.push({ key, th, arrow });
    return th;
  });
  const colgroup = () => h('colgroup', {}, selectable ? h('col', { class: 'col-select' }) : null, order.map((i) => {
    const col = h('col');
    col.style.width = widthOf(i);
    return col;
  }));
  const headRow = h('tr', {}, selectable ? h('th', { class: 'col-select' }, selectAll) : null, order.map((i) => ths[i]));
  const headTable = h('table', { class: 'users-table' }, colgroup(), h('thead', {}, headRow));
  const bodyTable = h('table', { class: 'users-table' }, colgroup(), tbody);
  const headWrap = h('div', { class: 'table-head-wrapper' }, headTable);
  const bodyWrap = h('div', { class: 'table-body-wrapper' }, bodyTable);
  const resetColumns = h('button', { type: 'button', class: 'col-reset', hidden: true,
    title: 'Colonnes par défaut : remettre l’ordre et la largeur d’origine', 'aria-label': 'Colonnes par défaut', onclick: () => {
      widths = {};
      writeStored(COLUMN_WIDTH_KEY + cfg.key, null);
      applyOrder(defaultTitles.map((_, i) => i));
    } }, svgIcon('M2.75 8a5.25 5.25 0 1 0 1.55-3.7M2.75 2.5v2.75H5.5'));
  const isDefaultOrder = () => order.every((i, k) => i === k);
  const layout = () => {
    headTable.firstElementChild.replaceWith(colgroup());
    bodyTable.firstElementChild.replaceWith(colgroup());
    ths.forEach((th, i) => { th.style.width = widthOf(i); resizers[i].hidden = order[0] === i; });
    resetColumns.hidden = isDefaultOrder() && !Object.keys(widths).length;
  };
  function applyOrder(next) {
    order = next;
    headRow.replaceChildren(...[selectable ? headRow.firstElementChild : null, ...order.map((i) => ths[i])].filter(Boolean));
    layout();
    writeStored(COLUMN_ORDER_KEY + cfg.key, isDefaultOrder() ? null : order.map((i) => defaultTitles[i]));
    render();
  }
  const startResize = (idx) => {
    const pos = order.indexOf(idx);
    if (pos < 1) return null;
    const left = order[pos - 1];
    const total = headTable.getBoundingClientRect().width;
    const px = Object.fromEntries(order.map((i) => [i, ths[i].getBoundingClientRect().width]));
    widths = Object.fromEntries(order.map((i) => [defaultTitles[i], `${(px[i] / total * 100).toFixed(3)}%`]));
    return (d) => {
      const shift = Math.max(MIN_COLUMN_PX - px[left], Math.min(px[idx] - MIN_COLUMN_PX, d));
      widths[defaultTitles[left]] = `${((px[left] + shift) / total * 100).toFixed(3)}%`;
      widths[defaultTitles[idx]] = `${((px[idx] - shift) / total * 100).toFixed(3)}%`;
      layout();
    };
  };
  const saveWidths = () => writeStored(COLUMN_WIDTH_KEY + cfg.key, widths);
  resizers.forEach((resizer, idx) => {
    resizer.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const resize = startResize(idx);
      if (!resize) return;
      resize(e.key === 'ArrowLeft' ? -16 : 16);
      saveWidths();
    });
    resizer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const resize = startResize(idx);
      if (!resize) return;
      const startX = e.clientX;
      resizer.classList.add('is-active');
      trackPointer('col-resizing', (ev) => resize(ev.clientX - startX), () => {
        resizer.classList.remove('is-active');
        saveWidths();
      });
    });
  });
  const moveColumn = (from, over, after) => {
    const next = order.filter((i) => i !== from);
    next.splice(next.indexOf(over) + (after ? 1 : 0), 0, from);
    if (next.some((i, k) => i !== order[k])) applyOrder(next);
  };
  ths.forEach((th, idx) => {
    const grip = grips[idx];
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const pos = order.indexOf(idx);
      const target = pos + (e.key === 'ArrowLeft' ? -1 : 1);
      if (target < 0 || target >= order.length) return;
      moveColumn(idx, order[target], e.key === 'ArrowRight');
      grip.focus();
    });
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      let drop = null;
      const clear = () => ths.forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      th.classList.add('is-dragging');
      trackPointer('col-dragging', (ev) => {
        clear();
        const over = ths.find((x) => { const r = x.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX < r.right; });
        if (!over || over === th) { drop = null; return; }
        const r = over.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        over.classList.add(after ? 'drop-after' : 'drop-before');
        drop = { over: ths.indexOf(over), after };
      }, () => {
        clear();
        th.classList.remove('is-dragging');
        if (drop) moveColumn(idx, drop.over, drop.after);
      });
    });
  });
  layout();
  bodyWrap.addEventListener('scroll', () => { headWrap.scrollLeft = bodyWrap.scrollLeft; }, { passive: true });
  const createBtn = () => cfg.create && h('button', { class: 'btn btn-primary', onclick: cfg.create.run }, actionIcon(cfg.create.label), cfg.create.label);

  const c = cfg.card;
  const subtitle = h('span');
  const ringSlot = c?.ring ? h('span', { class: 'ec-ring-slot' }) : null;
  const asMenu = !!cfg.filters;
  const pick = (value) => guard(() => { st.filter = value; st.page = 1; setFilterMenu(false); return reload(true); });
  const chips = cfg.filters ? cfg.filters.items.map(([value, label, cls]) => {
    const n = h('small');
    const b = h('button', { type: 'button', class: `dt-filter-item${cls ? ` ${cls}` : ''}`, role: 'menuitemradio', 'aria-checked': 'false',
      onclick: pick(value) }, h('i'), h('span', {}, label), n);
    return { value, label, b, n };
  }) : [];
  const filterBtn = asMenu ? h('button', { type: 'button', class: 'dt-filter-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: () => setFilterMenu(filterList.hidden) }, svgIcon('M2 3h12L9.5 8.5V13l-3 1.5V8.5z')) : null;
  const filterList = asMenu ? h('div', { class: 'dt-filter-list', role: 'menu', hidden: true }, chips.map((x) => x.b)) : null;
  const filterMenu = asMenu ? h('div', { class: 'dt-filter' }, filterBtn, filterList) : null;
  const closeOutside = (e) => { if (!filterMenu.contains(e.target)) setFilterMenu(false); };
  const closeOnKey = (e) => {
    const items = chips.map((x) => x.b);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { setFilterMenu(false); filterBtn.focus(); }
    else if (e.key === 'Tab') setFilterMenu(false);
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && filterMenu.contains(document.activeElement)) {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  };
  function setFilterMenu(open) {
    if (!asMenu || filterList.hidden === !open) return;
    filterList.hidden = !open;
    filterBtn.setAttribute('aria-expanded', String(open));
    document[open ? 'addEventListener' : 'removeEventListener']('click', closeOutside, true);
    document[open ? 'addEventListener' : 'removeEventListener']('keydown', closeOnKey);
    if (open) (chips.find((x) => x.value === st.filter) || chips[0]).b.focus();
  }

  const count = h('span', { class: 'bulk-count' });
  const sizeSel = h('select', { class: 'page-size', 'aria-label': 'Lignes par page' },
    PAGE_SIZES.map((n) => h('option', { value: n, selected: n === st.size }, String(n))));
  sizeSel.addEventListener('change', guard(() => { st.size = Number(sizeSel.value); st.page = 1; return reload(true); }));
  const pageInput = h('input', { type: 'number', class: 'page-input', min: 1, 'aria-label': 'Page' });
  const pageInfo = h('span', { class: 'page-info' });
  const go = guard((p) => { st.page = p; return reload(true); });
  const lastPage = () => Math.max(1, Math.ceil(total / st.size));
  pageInput.addEventListener('change', () => {
    const p = Math.min(lastPage(), Math.max(1, Math.floor(Number(pageInput.value)) || 1));
    if (p === st.page) pageInput.value = p;
    else go(p);
  });
  const nav = (label, title, target) => h('button', { class: 'btn pagination-nav-btn', title, 'aria-label': title,
    onclick: () => go(target()) }, label);
  const navFirst = nav(svgIcon('M11.5 4L7.5 8l4 4M4.5 4v8'), 'Première page', () => 1);
  const navPrev = nav(svgIcon('M10 4L6 8l4 4'), 'Page précédente', () => st.page - 1);
  const navNext = nav(svgIcon('M6 4l4 4-4 4'), 'Page suivante', () => st.page + 1);
  const navLast = nav(svgIcon('M4.5 4l4 4-4 4M11.5 4v8'), 'Dernière page', lastPage);

  const finder = (search || asMenu) ? h('div', { class: 'bulk-tools' }, asMenu ? h('div', { class: 'search-group' }, filterMenu, search) : search) : null;
  const hasActions = !!(cfg.create || cfg.tools || buttons.length);
  const bar = h('div', { class: 'bulk-actions-bar' },
    h('div', { class: 'bulk-actions-buttons' }, createBtn(), cfg.tools, buttons.map(([, b]) => b)), finder);
  const pager = paginate
      ? h('div', { class: 'pagination pagination-with-size' },
        h('div', { class: 'pagination-size-control' }, h('label', { class: 'pagination-size-label' }, 'Lignes par page', sizeSel), resetColumns),
        h('div', { class: 'pagination-center-controls' }, navFirst, navPrev,
          h('span', { class: 'page-label' }, 'Page ', pageInput, pageInfo), navNext, navLast),
        h('div', { class: 'pagination-bulk-control' }, selectable ? count : null))
      : h('div', { class: 'pagination pagination-solo' }, resetColumns, h('div', { class: 'pagination-bulk-control' }, selectable ? count : null));
  const table = h('div', { class: 'data-table' },
    c ? cardHeader(ringSlot || c.icon, c.intro ? [c.title, helpTip(c.intro)] : c.title, subtitle) : null,
    bar, h('div', { class: 'users-table-container' }, headWrap, bodyWrap), pager);
  const el = c
    ? h('div', { class: `section-card engine-card table-card dt-card${c.engine ? ` ${c.engine}` : ''}` }, table)
    : table;

  function updateBar() {
    const sel = [...selected.values()];
    for (const [a, b] of buttons) {
      const sized = a.when === 'one' ? sel.length === 1 : sel.length > 0;
      const refusal = sized ? sel.map((r) => allowed(a, r)).find((x) => x !== true) : null;
      b.disabled = busy || !sized || refusal != null;
      b.title = typeof refusal === 'string' ? refusal : (a.when === 'one' && sel.length > 1 ? 'Une seule ligne à la fois' : '');
    }
    count.textContent = `${sel.length} sélectionné${sel.length > 1 ? 's' : ''}`;
    count.classList.toggle('has-selection', sel.length > 0);
    selectAll.classList.toggle('is-selected', rows.length > 0 && rows.every((r) => selected.has(rowId(r))));
    const last = lastPage();
    pageInput.value = st.page;
    pageInput.max = last;
    pageInfo.textContent = ` / ${last} (${total})`;
    navFirst.disabled = navPrev.disabled = st.page <= 1;
    navNext.disabled = navLast.disabled = st.page >= last;
  }

  function render() {
    if (c) {
      subtitle.textContent = c.subtitle ? c.subtitle(data, st) : '';
      subtitle.hidden = !subtitle.textContent;
      if (ringSlot) {
        const ring = c.ring(data, st);
        if (ringSlot.firstChild) morph(ringSlot.firstChild, ring);
        else ringSlot.append(ring);
      }
    }
    for (const x of chips) {
      x.b.setAttribute('aria-checked', String(x.value === st.filter));
      x.n.textContent = cfg.filters.count(data, x.value);
    }
    if (asMenu) {
      const cur = chips.find((x) => x.value === st.filter) || chips[0];
      filterBtn.title = `Filtrer : ${cur.label} (${cur.n.textContent})`;
      filterBtn.setAttribute('aria-label', filterBtn.title);
      filterBtn.classList.toggle('is-filtered', !!st.filter);
    }
    for (const x of sortable) {
      const dir = st.sort?.key === x.key ? st.sort.dir : null;
      x.th.classList.toggle('is-sorted', !!dir);
      if (dir) x.th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
      else x.th.removeAttribute('aria-sort');
      x.arrow.replaceChildren(svgIcon(dir === 'desc' ? 'M8 3.5v9M4.5 9L8 12.5 11.5 9' : dir === 'asc' ? 'M8 12.5v-9M4.5 7L8 3.5 11.5 7' : 'M5 6l3-3 3 3M5 10l3 3 3-3'));
    }
    const filtered = st.search || st.filter;
    const blank = !rows.length && !filtered && st.page === 1;
    pager.hidden = blank;
    bar.hidden = blank || (!hasActions && !finder);
    tbody.replaceChildren(...(rows.length ? rows.map((r) => {
      const id = rowId(r);
      const on = selected.has(id);
      const toggle = () => { on ? selected.delete(id) : selected.set(id, r); render(); };
      return h('tr', { class: on ? 'row-selected' : null },
        selectable ? h('td', { class: 'col-select', onclick: toggle },
          h('button', { class: `row-select${on ? ' is-selected' : ''}`, 'aria-label': 'Sélectionner', 'aria-pressed': String(on),
            onclick: (e) => { e.stopPropagation(); toggle(); } })) : null,
        cols().map(([, cell]) => h('td', {}, cell(r))));
    }) : [h('tr', { class: 'row-empty' }, h('td', { class: 'no-data', colspan: cfg.columns.length + (selectable ? 1 : 0) },
      h('div', { class: 'empty-state' },
        h('p', {}, filtered ? 'Aucun résultat pour cette recherche.' : cfg.empty),
        filtered ? null : createBtn())))]));
    updateBar();
  }

  async function reload(clear = false) {
    if (clear) selected.clear();
    const req = (pending = cfg.source({ limit: paginate ? st.size : 1000, offset: paginate ? (st.page - 1) * st.size : 0,
      search: st.search, filter: st.filter, sort: st.sort }));
    const res = await req;
    if (req !== pending) return;
    data = res;
    ({ rows, total } = data);
    if (st.page > lastPage()) { st.page = lastPage(); return reload(clear); }
    const fresh = new Map(rows.map((r) => [rowId(r), r]));
    for (const id of [...selected.keys()]) {
      if (fresh.has(id)) selected.set(id, fresh.get(id));
      else selected.delete(id);
    }
    cfg.onData?.(rows, total);
    render();
  }

  function trigger(a) {
    const sel = [...selected.values()];
    const run = guard(async () => {
      busy = true;
      updateBar();
      try {
        await a.run(sel);
      } finally {
        busy = false;
        updateBar();
      }
      if (a.reload !== false && el.isConnected) await reload(true);
    });
    const ask = a.confirm?.(sel);
    if (ask) confirmDialog({ confirmLabel: a.label, danger: !!a.danger, ...ask, onConfirm: run });
    else run();
  }

  await reload();
  if (cfg.poll) {
    const tick = async () => {
      if (!el.isConnected) return;
      await reload().catch(() => {});
      if (el.isConnected) setTimeout(tick, cfg.poll);
    };
    setTimeout(tick, cfg.poll);
  }
  return { el, reload };
}
