import { app, view } from './page.js';
import { h, ICONS, svgIcon } from './dom.js';
import { countLabel, fmtDate } from './format.js';
import { api, batch, guard, pagedSource } from './api.js';
import { ENGINE_CARDS } from './engines.js';
import { emptyCell, helpTip, oneLine, stack, stateIcon, tipLines } from './display.js';
import { dataTable } from './table.js';
import { deleteConfirm, openModal } from './modal.js';
import { formActions, group, row } from './forms.js';
import { choiceChips, optionPicker, placePanel, scrollSelect } from './pickers.js';
import { lastJobCell } from './distributions.js';
import { activityRing, launchMany } from './jobs.js';

const WEEKDAYS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Jeu'], [5, 'Ven'], [6, 'Sam'], [7, 'Dim']];
const WEEKDAY_NAMES = { 1: 'lundi', 2: 'mardi', 3: 'mercredi', 4: 'jeudi', 5: 'vendredi', 6: 'samedi', 7: 'dimanche' };
const WEEKS = [[1, '1re'], [2, '2e'], [3, '3e'], [4, '4e']];
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = (n) => String(n).padStart(2, '0');
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const timeInput = (value) => h('input', { type: 'text', value, inputmode: 'numeric', maxlength: 5, autocomplete: 'off', placeholder: 'HH:MM',
  pattern: '([01][0-9]|2[0-3]):[0-5][0-9]', title: 'Heure au format HH:MM, de 00:00 à 23:59' });
const frenchList = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}` : items[0]);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const SCHEDULE_ENGINES = {
  packer: {
    api: '/schedules',
    subtitle: 'Packer · construction programmée d’un template',
    empty: 'Aucune planification : créez-en une pour construire un template à date fixe ou à intervalle régulier.',
    check: ['Valider', 'validate'],
    existingTemplateWarning: true,
  },
  tofu: {
    api: '/tofu/schedules',
    subtitle: 'OpenTofu · construction ou destruction programmée',
    empty: 'Aucune planification : créez-en une pour construire ou détruire la VM d’un profil à date fixe ou à intervalle régulier.',
    check: ['Valider', 'plan'],
    existingTemplateWarning: false,
    tasks: [['apply', 'Construire'], ['destroy', 'Détruire']],
    retiredTasks: { plan: 'Valider (n’est plus proposée)' },
  },
  ansible: {
    api: '/ansible/schedules',
    subtitle: 'Ansible · application programmée d’un profil',
    empty: 'Aucune planification : créez-en une pour appliquer un profil Ansible à date fixe ou à intervalle régulier.',
    check: ['Vérifier', 'check'],
    existingTemplateWarning: false,
    profileTip: (recurring) => [['Exécution', `${recurring ? 'Chaque exécution applique' : 'L’exécution applique'} le profil sans autre confirmation : les serveurs cibles sont modifiés.`],
      NOT_STARTED_BUSY],
  },
};

const NOT_STARTED_BUSY = ['Non lancée', 'Si le profil a déjà un job en attente ou en cours.'];
const TASK_WARNINGS = {
  apply: (recurring) => [['Exécution', `${recurring ? 'Chaque exécution crée' : 'L’exécution crée'} la VM si elle n’existe pas, sinon l’aligne sur le profil.`],
    ['Redémarrage', 'Un changement de ressources peut redémarrer la VM.']],
  destroy: (recurring) => [['Exécution', `${recurring ? 'Chaque exécution détruit' : 'L’exécution détruit'} la VM du profil et TOUS SES DISQUES, sans autre confirmation.`],
    ['Non lancée', 'Si aucune VM n’est déployée à l’heure prévue.']],
};
function tipGroup(label, input) {
  const slot = h('span', { class: 'field-tip' });
  const el = group(label, h('div', { class: 'field-with-tip' }, input, slot));
  let shown = null;
  const tip = (lines) => {
    const key = JSON.stringify(lines || []);
    if (key === shown) return;
    shown = key;
    const content = tipLines(...(lines || []));
    slot.replaceChildren(...(content ? [helpTip(content)] : []));
  };
  return { el, tip };
}
const taskLabel = (e, action) => e.tasks.find(([value]) => value === action)?.[1] || (action === 'plan' ? 'Valider' : '—');

function nextHour() {
  const d = new Date(Date.now() + 3600 * 1000);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

function describeSchedule(s) {
  const zone = s.timezone && s.timezone !== browserZone() ? ` (${s.timezone})` : '';
  if (s.mode === 'once') {
    const [y, m, d] = s.run_date.split('-');
    return `Le ${d}/${m}/${y} à ${s.run_time}${zone}`;
  }
  const days = s.weekdays.length === 7 ? 'Tous les jours' : capitalize(frenchList(s.weekdays.map((n) => WEEKDAY_NAMES[n])));
  const weeks = s.weeks ? `, ${frenchList(s.weeks.map((n) => WEEKS[n - 1][1]))} ${s.weeks.length > 1 ? 'semaines' : 'semaine'} du mois` : '';
  return `${days}${weeks}, à ${s.run_time}${zone}`;
}

const TIME_ROWS = [-2, -1, 0, 1, 2];
const WHEEL_STEP = 60;

function timeField(input) {
  const parts = () => (TIME_RE.test(input.value) ? input.value.split(':').map(Number) : null);
  let active = 0;
  const columns = [[24, 'Heures'], [60, 'Minutes']].map(([count, label], part) => {
    const current = () => (parts() || [0, 0])[part];
    const step = (delta) => {
      active = part;
      const next = parts() || [0, 0];
      next[part] = (current() + delta + count) % count;
      input.value = next.map(pad).join(':');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const rows = TIME_ROWS.map((offset) => h('div', { class: `time-option${offset ? '' : ' is-center'}`, onclick: () => step(offset) }));
    const el = h('div', { class: 'time-column', role: 'spinbutton', tabindex: '0', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(count - 1),
      onfocus: () => { active = part; } }, rows);
    let wheel = 0;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      wheel += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      if (Math.abs(wheel) >= WHEEL_STEP) {
        step(Math.sign(wheel));
        wheel = 0;
      }
    }, { passive: false });
    const paint = () => {
      rows.forEach((row, i) => { row.textContent = pad((current() + TIME_ROWS[i] + count) % count); });
      rows[TIME_ROWS.indexOf(0)].classList.toggle('is-on', !!parts());
      el.setAttribute('aria-valuenow', String(current()));
    };
    return { el, step, paint };
  });
  const panel = h('div', { class: 'picker-panel time-panel', hidden: true }, columns.map((c) => c.el));
  const paint = () => columns.forEach((c) => c.paint());
  const trigger = h('button', { type: 'button', class: 'time-trigger', 'aria-label': 'Choisir l’heure', 'aria-expanded': 'false', onclick: () => (panel.hidden ? open() : close()) }, svgIcon('M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM8 5v3.2l2 1.3'));
  const wrap = h('div', { class: 'time-field' }, input, trigger, panel);
  function close() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  function open() {
    paint();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    placePanel(wrap, panel);
  }
  input.addEventListener('click', open);
  input.addEventListener('input', paint);
  input.addEventListener('change', () => {
    const typed = /^(\d{1,2})(?::?(\d{2}))?$/.exec(input.value.trim());
    if (typed && TIME_RE.test(`${pad(typed[1])}:${typed[2] || '00'}`)) input.value = `${pad(typed[1])}:${typed[2] || '00'}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  wrap.addEventListener('keydown', (e) => {
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (panel.hidden) {
      if (vertical && e.target === input) {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      close();
      input.focus();
    } else if (vertical) {
      e.preventDefault();
      columns[active].step(e.key === 'ArrowDown' ? 1 : -1);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target !== input) {
      e.preventDefault();
      columns[e.key === 'ArrowLeft' ? 0 : 1].el.focus();
    }
  });
  wrap.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !wrap.contains(e.relatedTarget)) close();
  });
  document.addEventListener('mousedown', function away(e) {
    if (!wrap.isConnected) return document.removeEventListener('mousedown', away);
    if (!wrap.contains(e.target)) close();
    return undefined;
  });
  return wrap;
}

const WEEKDAY_SHORT = ['Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa', 'Di'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const frOf = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const fromIso = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
function parseFr(text) {
  const m = DATE_RE.exec(text.trim());
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return d.getDate() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 ? d : null;
}

function dateField(value) {
  const input = h('input', { type: 'text', value: value ? frOf(fromIso(value)) : '', inputmode: 'numeric', maxlength: 10, autocomplete: 'off',
    placeholder: 'JJ/MM/AAAA', title: 'Date au format JJ/MM/AAAA' });
  const today = () => dayOf(new Date());
  let focus = today();
  const title = h('span', { class: 'date-title', 'aria-live': 'polite' });
  const grid = h('div', { class: 'date-grid', role: 'grid' });
  const nav = (label, d, delta) => h('button', { type: 'button', class: 'date-nav', 'aria-label': label, onclick: () => move(0, delta) }, svgIcon(d));
  const panel = h('div', { class: 'picker-panel date-panel', hidden: true },
    h('div', { class: 'date-head' }, nav('Mois précédent', 'M10 4l-4 4 4 4', -1), title, nav('Mois suivant', 'M6 4l4 4-4 4', 1)),
    h('div', { class: 'date-weekdays' }, WEEKDAY_SHORT.map((d) => h('span', {}, d))),
    grid,
    h('div', { class: 'date-foot' }, h('button', { type: 'button', class: 'date-today', onclick: () => pick(today()) }, 'Aujourd’hui')));
  const trigger = h('button', { type: 'button', class: 'time-trigger', 'aria-label': 'Choisir la date', 'aria-expanded': 'false',
    onclick: () => (panel.hidden ? open() : close()) }, svgIcon('M3 4.5h10v9H3zM3 7.5h10M5.5 3v3M10.5 3v3'));
  const wrap = h('div', { class: 'time-field date-field' }, input, trigger, panel);
  const selected = () => parseFr(input.value);

  function paint() {
    const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - ((first.getDay() + 6) % 7));
    const now = today().getTime();
    const sel = selected()?.getTime();
    title.textContent = `${MONTHS[first.getMonth()]} ${first.getFullYear()}`;
    grid.replaceChildren(...Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const t = d.getTime();
      const cls = ['date-day', d.getMonth() !== first.getMonth() && 'is-out', t === now && 'is-today', t === sel && 'is-on',
        t === focus.getTime() && 'is-focus'].filter(Boolean).join(' ');
      return h('button', { type: 'button', class: cls, tabindex: '-1', disabled: t < now, 'aria-label': frOf(d),
        'aria-selected': String(t === sel), onmousedown: (e) => e.preventDefault(), onclick: () => pick(d) }, String(d.getDate()));
    }));
  }
  function move(days, months = 0) {
    const target = new Date(focus.getFullYear(), focus.getMonth() + months, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    focus = months ? new Date(target.getFullYear(), target.getMonth(), Math.min(focus.getDate(), last))
      : new Date(focus.getFullYear(), focus.getMonth(), focus.getDate() + days);
    paint();
  }
  function pick(d) {
    if (d < today()) return;
    input.value = frOf(d);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    input.focus();
  }
  function close() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  function open() {
    focus = selected() || today();
    paint();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    placePanel(wrap, panel);
  }
  input.addEventListener('click', open);
  input.addEventListener('input', () => {
    const d = selected();
    if (d) focus = d;
    if (!panel.hidden) paint();
  });
  input.addEventListener('change', () => {
    const d = selected();
    if (d) input.value = frOf(d);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [-7, 0], ArrowDown: [7, 0], PageUp: [0, -1], PageDown: [0, 1] };
  wrap.addEventListener('keydown', (e) => {
    if (panel.hidden) {
      if (e.key === 'ArrowDown' && e.target === input) {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(focus);
    } else if (KEYS[e.key]) {
      e.preventDefault();
      move(...KEYS[e.key]);
    }
  });
  wrap.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !wrap.contains(e.relatedTarget)) close();
  });
  document.addEventListener('mousedown', function away(e) {
    if (!wrap.isConnected) return document.removeEventListener('mousedown', away);
    if (!wrap.contains(e.target)) close();
    return undefined;
  });
  return { el: wrap, input, value: () => { const d = selected(); return d ? isoOf(d) : ''; } };
}

async function scheduleModal(engine, existing, copy) {
  const e = SCHEDULE_ENGINES[engine];
  const src = existing || copy;
  const profiles = await api(`${e.api}/profiles`);
  const defaults = nextHour();
  const pastOnce = copy?.mode === 'once' && copy.run_date < defaults.date;
  const nameInput = h('input', { type: 'text', value: src?.name || '', required: true, maxlength: 100, autocomplete: 'off' });
  const profileSelect = optionPicker(profiles.map((p) => ({ value: p.id, name: p.name, meta: p.description || '' })), src?.profile_id || '',
    { placeholder: profiles.length ? 'Sélectionner…' : 'Aucun profil : créez-en un d’abord', missing: 'Profil supprimé' });
  const date = dateField(src?.mode === 'once' && !pastOnce ? src.run_date : defaults.date);
  const timeOnce = timeInput(src?.mode === 'once' && !pastOnce ? src.run_time : defaults.time);
  const timeRecurring = timeInput(src?.mode === 'recurring' ? src.run_time : defaults.time);
  const task = src?.action || e.tasks?.[0][0];
  const taskSelect = e.tasks
    ? scrollSelect([...(e.retiredTasks?.[task] ? [[task, e.retiredTasks[task]]] : []), ...e.tasks], task)
    : null;
  const profileGroup = tipGroup('Profil *', profileSelect);
  const taskGroup = taskSelect ? tipGroup('Tâche *', taskSelect) : null;
  const summary = h('p', { class: 'schedule-summary' });
  const radio = (value, title, text) => h('label', { class: 'schedule-mode' },
    h('input', { type: 'radio', name: 'schedule-mode', value, checked: (src?.mode || 'once') === value, onchange: () => refresh() }),
    h('span', {}, h('b', {}, title), h('small', {}, text)));
  const modes = h('div', { class: 'schedule-modes', role: 'radiogroup', 'aria-label': 'Programmation' },
    radio('once', 'Date et heure précises', 'Une seule exécution'),
    radio('recurring', 'Exécution périodique', 'Jours et semaines du mois'));
  const mode = () => modes.querySelector('input:checked').value;
  const days = choiceChips(WEEKDAYS, 'Tous', src?.mode === 'recurring' ? src.weekdays : [], { onChange: () => refresh() });
  const weeks = choiceChips(WEEKS, 'Toutes', src?.mode === 'recurring' ? src.weeks : null, { nullWhenAll: true, onChange: () => refresh() });
  const onceFields = h('div', {}, row(group('Date *', date.el), group('Heure *', timeField(timeOnce))));
  const recurringFields = h('div', {},
    h('div', { class: 'form-row' }, group('Jours de la semaine *', days.el, null, true)),
    h('div', { class: 'form-row' }, group('Semaines du mois *', weeks.el,
      tipLines(['Découpage', '1re semaine : du 1er au 7 du mois ; 2e : du 8 au 14 ; 3e : du 15 au 21 ; 4e : du 22 au 28.'],
        ['Fin de mois', 'Les 29, 30 et 31 ne sont couverts que par « Toutes ».']), true)),
    row(group('Heure d’exécution *', timeField(timeRecurring))));

  function refresh() {
    const recurring = mode() === 'recurring';
    onceFields.hidden = recurring;
    recurringFields.hidden = !recurring;
    timeOnce.required = !recurring;
    date.input.required = !recurring;
    timeRecurring.required = recurring;
    timeOnce.disabled = recurring;
    timeRecurring.disabled = !recurring;
    const typedTime = recurring ? timeRecurring.value : timeOnce.value;
    const time = TIME_RE.test(typedTime) ? typedTime : '';
    const complete = recurring ? days.value().length && weeks.value()?.length !== 0 && time : date.value() && time;
    summary.textContent = complete
      ? describeSchedule({ mode: mode(), run_date: date.value(), run_time: time, weekdays: days.value(), weeks: weeks.value() })
      : 'Programmation incomplète';
    const profile = profiles.find((p) => p.id === profileSelect.value);
    if (taskSelect) {
      taskGroup.tip(TASK_WARNINGS[taskSelect.value]?.(recurring) || []);
      return;
    }
    if (e.profileTip) {
      profileGroup.tip(profile ? e.profileTip(recurring) : []);
      return;
    }
    const unforced = e.existingTemplateWarning && profile && profile.existing_template === 'refuse';
    if (profile && !unforced) {
      profileGroup.tip([['Exécution', `${recurring ? 'Chaque exécution reconstruit' : 'L’exécution reconstruit'} le template du profil et remplace celui qui existe`
        + `${profile.existing_template === 'replace_purge' ? ', puis supprime ses disques' : ''} (« Template existant » du profil).`],
        NOT_STARTED_BUSY]);
      return;
    }
    profileGroup.tip(!unforced ? [] : [['Attention', 'Ce profil refuse le build si le template existe (« Template existant »).'],
      ['Conséquence', recurring ? 'Seule la première exécution réussira tant que le template existe.' : 'Si le template existe déjà, le job sera refusé.']]);
  }
  profileSelect.addEventListener('change', refresh);
  taskSelect?.addEventListener('change', refresh);
  [date.input, timeOnce, timeRecurring].forEach((i) => i.addEventListener('input', refresh));

  let close;
  const form = h('form', { onsubmit: guard(async (ev) => {
    ev.preventDefault();
    const recurring = mode() === 'recurring';
    if (!profileSelect.value) throw new Error('Sélectionner un profil');
    if (recurring && !days.value().length) throw new Error('Sélectionner au moins un jour de la semaine');
    if (recurring && weeks.value()?.length === 0) throw new Error('Sélectionner au moins une semaine du mois');
    if (!recurring && !date.value()) throw new Error('Date invalide : format JJ/MM/AAAA');
    const body = {
      name: nameInput.value.trim(),
      profile_id: profileSelect.value,
      ...(taskSelect ? { action: taskSelect.value } : {}),
      mode: mode(),
      timezone: existing?.timezone || copy?.timezone || browserZone(),
      ...(recurring
        ? { time: timeRecurring.value, weekdays: days.value(), weeks: weeks.value() }
        : { date: date.value(), time: timeOnce.value }),
      ...(copy?.copy_from ? { copy_from: copy.copy_from } : {}),
    };
    await api(existing ? `${e.api}/${existing.id}` : e.api, { method: existing ? 'PUT' : 'POST', body });
    close();
    pageSchedules(engine);
  }) },
  row(group('Nom de la planification *', nameInput), profileGroup.el),
  taskGroup ? row(taskGroup.el) : null,
  h('div', { class: 'form-section' }, h('h3', {}, 'Programmation *'), modes, onceFields, recurringFields, summary),
  formActions(() => close(), existing ? 'Enregistrer' : 'Créer'));

  close = openModal(existing ? `Planification : ${existing.name}` : copy ? 'Copie de planification' : 'Nouvelle planification', form, {
    icon: ICONS.calendar,
    subtitle: copy ? `${ENGINE_CARDS[engine].name} · copie de « ${copy.sourceName} »` : e.subtitle });
  days.paint();
  weeks.paint();
  refresh();
}

const statusCell = (s) => {
  if (!s.enabled) return stateIcon('disabled', 'Désactivée');
  return s.next_run_at ? stateIcon('active', 'Active') : h('span', { class: 'cell-muted' }, 'Terminée');
};
const nextCell = (s) => (s.enabled && s.next_run_at
  ? h('span', { class: 'cell-when' }, fmtDate(s.next_run_at))
  : h('span', { class: 'cell-muted' }, '—'));
const lastCell = (engine) => (s) => (s.last_outcome
  ? h('span', { class: 'cell-muted', title: s.last_outcome }, s.last_outcome)
  : lastJobCell(engine)(s));

export async function pageSchedules(engine = 'packer', gen = view.pageGen) {
  const e = SCHEDULE_ENGINES[engine];
  const w = engine === 'tofu'
    ? { name: '16%', profile: '16%', task: '8%', program: '24%', status: '8%', next: '14%', last: '14%' }
    : { name: '20%', profile: '20%', program: '24%', status: '8%', next: '14%', last: '14%' };
  const [checkLabel, checkAction] = e.check;
  const t = await dataTable({
    key: `${engine}-schedules`,
    source: pagedSource(e.api),
    poll: 15000,
    card: {
      engine, icon: activityRing(engine, ICONS.calendar), title: 'Planification',
      subtitle: (d, st) => [ENGINE_CARDS[engine].subtitle, countLabel(st, d.total || 0, 'planification', 'planifications')].join(' · '),
    },
    search: true,
    empty: e.empty,
    create: { label: 'Ajouter', run: () => scheduleModal(engine, null) },
    columns: [
      ['Planification', (s) => stack(s.name), w.name, 'name'],
      ['Profil', (s) => (s.profile_name ? oneLine(s.profile_name) : emptyCell()), w.profile, 'profile'],
      ...(e.tasks ? [['Tâche', (s) => taskLabel(e, s.action), w.task, 'task']] : []),
      ['Programmation', (s) => describeSchedule(s), w.program, 'program'],
      ['Statut', statusCell, w.status, 'active:desc'],
      ['Prochaine exécution', nextCell, w.next, 'next'],
      ['Dernière exécution', lastCell(engine), w.last, 'last:desc'],
    ],
    actions: [
      { label: 'Modifier', when: 'one', reload: false, run: ([s]) => scheduleModal(engine, s) },
      { label: 'Cloner', when: 'one', reload: false, run: async ([s]) => {
        const draft = await api(`${e.api}/${s.id}/clone`);
        return scheduleModal(engine, null, { ...draft, sourceName: s.name });
      } },
      { label: 'Activer', when: 'many', allow: (s) => (s.enabled ? 'Planification déjà activée' : true),
        run: (sel) => batch(`${e.api}/batch`, 'enable', sel) },
      { label: 'Désactiver', when: 'many', allow: (s) => {
        if (!s.enabled) return 'Planification déjà désactivée';
        return s.next_run_at ? true : 'Planification terminée';
      },
        run: (sel) => batch(`${e.api}/batch`, 'disable', sel) },
      { label: checkLabel, when: 'many', allow: (s) => (s.busy ? 'Un job est en attente ou en cours sur ce profil' : true),
        run: (sel) => launchMany(engine, checkAction, [...new Set(sel.map((s) => s.profile_id))].map((id) => ({ id }))) },
      { label: 'Supprimer', when: 'many', danger: true,
        confirm: (sel) => deleteConfirm(sel, ['la planification', 'les planifications'], (s) => s.name),
        run: (sel) => batch(`${e.api}/batch`, 'delete', sel) },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}
