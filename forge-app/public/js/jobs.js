import { app, view } from './page.js';
import { actionIcon, h, ICONS, morph, svgEl, svgIcon } from './dom.js';
import { countLabel, duration, fmtDate, plural, shortDuration, timeAgo } from './format.js';
import { api, batch, batchToast, guard, pagedSource, SessionExpired } from './api.js';
import { ENGINE_CARDS } from './engines.js';
import { active, cardHeader, emptyCell, jobBadge, jobIcon, oneLine, stack, when } from './display.js';
import { dataTable } from './table.js';
import { deleteConfirm } from './modal.js';

const TOFU_ACTIONS = { plan: 'Validation', apply: 'Construction', import: 'Import', destroy: 'Destruction' };
const PACKER_ACTIONS = { validate: 'Validation', build: 'Construction' };
const ANSIBLE_ACTIONS = { ping: 'Test de connexion', check: 'Vérification', apply: 'Application' };
export const JOB_KINDS = {
  packer: {
    api: '/jobs',
    route: '#/packer/jobs',
    historyRoute: '#/packer/history',
    empty: 'Aucun job Packer pour l’instant.',
    actionLabel: (j) => PACKER_ACTIONS[j.action] || j.action,
  },
  tofu: {
    api: '/tofu/jobs',
    route: '#/tofu/jobs',
    historyRoute: '#/tofu/history',
    empty: 'Aucun job OpenTofu pour l’instant.',
    actionLabel: (j) => TOFU_ACTIONS[j.action] || j.action,
  },
  ansible: {
    api: '/ansible/jobs',
    route: '#/ansible/jobs',
    historyRoute: '#/ansible/history',
    empty: 'Aucun job Ansible pour l’instant.',
    actionLabel: (j) => ANSIBLE_ACTIONS[j.action] || j.action,
  },
};

async function launch(kind, profileId, action) {
  const k = JOB_KINDS[kind];
  const job = await api(k.api, { method: 'POST', body: { profileId, action } });
  location.hash = `${k.route}/${job.id}`;
}

export async function launchMany(kind, action, profiles) {
  if (profiles.length === 1) return launch(kind, profiles[0].id, action);
  const r = await api(`${JOB_KINDS[kind].api}/launch`, { method: 'POST', body: { action, ids: profiles.map((p) => p.id) } });
  batchToast(r);
}

const HISTORY_FILTERS = [['', 'Tous'], ['active', 'En cours', 'active'], ['success', 'Réussis', 'success'],
  ['failed', 'Échecs', 'failed'], ['cancelled', 'Annulés', 'cancelled']];
const statusCount = (counts = {}, f) => ({
  '': Object.values(counts).reduce((a, b) => a + b, 0),
  active: (counts.running || 0) + (counts.queued || 0),
}[f] ?? counts[f] ?? 0);

const XCP_NOTE = ' Une VM sera créée, modifiée ou supprimée sur XCP-ng.';
const RELAUNCH_NOTES = {
  packer: { build: XCP_NOTE },
  tofu: { apply: XCP_NOTE, destroy: XCP_NOTE },
  ansible: { apply: ' La configuration sera appliquée sur les serveurs cibles.' },
};

export async function pageHistory(kind, gen) {
  const k = JOB_KINDS[kind];
  const w = { status: '16%', job: '29%', vm: '29%', duration: '13%', created: '13%' };
  const t = await dataTable({
    key: `${kind}-history`,
    source: pagedSource(k.api),
    card: {
      engine: kind, icon: ICONS.history, title: 'Historique',
      subtitle: (d, st) => [ENGINE_CARDS[kind].subtitle, countLabel(st, d.total || 0, 'job', 'jobs')].join(' · '),
      ring: (d) => countsRing(kind, ICONS.history, d.counts),
    },
    filters: { items: HISTORY_FILTERS, count: (d, f) => statusCount(d.counts, f) },
    search: true,
    empty: k.empty,
    poll: 5000,
    columns: [
      ['Statut', (j) => h('a', { class: 'cell-job history-status', href: `${k.route}/${j.id}` }, jobIcon(j), h('span', {}, k.actionLabel(j))), w.status, 'status'],
      ['Job', (j) => h('span', { class: 'history-job' }, stack(j.profile || '(profil supprimé)')), w.job, 'job'],
      kind === 'ansible'
        ? ['Cibles', (j) => (j.target_count ? plural(j.target_count, 'cible') : emptyCell()), w.vm, 'targets:desc']
        : ['VM', (j) => (j.vm_name ? oneLine(j.vm_name) : emptyCell()), w.vm, 'vm'],
      ['Durée', (j) => (j.started_at ? h('span', { class: 'cell-num' }, duration(j)) : emptyCell()), w.duration, 'duration:desc'],
      ['Lancé', (j) => when(j.created_at), w.created, 'created:desc'],
    ],
    actions: [
      { label: 'Relancer', when: 'one',
        allow: (j) => (j.profile_id ? true : 'Profil supprimé : relance impossible'),
        confirm: ([j]) => ({
          title: 'Relancer le job',
          message: `Relancer « ${k.actionLabel(j)} » sur « ${j.profile} » avec les valeurs actuelles du profil ?${
            RELAUNCH_NOTES[kind]?.[j.action] || ''}`,
          danger: j.action === 'destroy',
        }),
        run: async ([j]) => {
          const job = await api(`${k.api}/${j.id}/clone`, { method: 'POST' });
          location.hash = `${k.route}/${job.id}`;
        } },
      { label: 'Annuler', when: 'many', danger: true, allow: (j) => (active(j) ? true : 'Job déjà terminé'),
        confirm: (sel) => ({ title: 'Annuler', message: `Annuler ${sel.length > 1 ? `ces ${sel.length} jobs` : 'ce job'} ?`,
          confirmLabel: 'Annuler les jobs', cancelLabel: 'Retour', danger: true }),
        run: (sel) => batch(`${k.api}/batch`, 'cancel', sel) },
      { label: 'Supprimer', when: 'many', danger: true,
        allow: (j) => (active(j) ? 'Job en attente ou en cours : l’annuler d’abord' : true),
        confirm: (sel) => deleteConfirm(sel, ['le job', 'les jobs'], (j) => `${k.actionLabel(j)} ${j.profile || ''} du ${fmtDate(j.created_at)}`,
          'Le journal et les fichiers seront définitivement supprimés.'),
        run: (sel) => batch(`${k.api}/batch`, 'delete', sel) },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}

const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const ANSI_SEQUENCE = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b[@-Z\\-_]/g;

function ansiWriter(target) {
  const style = { fg: null, bold: false, dim: false, italic: false, underline: false };
  let carry = '';
  const classes = () => [style.fg && `ansi-${style.fg}`, style.bold && 'ansi-bold', style.dim && 'ansi-dim',
    style.italic && 'ansi-italic', style.underline && 'ansi-underline'].filter(Boolean).join(' ');
  const emit = (text) => {
    if (!text) return;
    const cls = classes();
    target.append(cls ? h('span', { class: cls }, text) : text);
  };
  const apply = (params) => {
    const codes = params === '' ? [0] : params.split(';').map((n) => Number(n) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) Object.assign(style, { fg: null, bold: false, dim: false, italic: false, underline: false });
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 22) { style.bold = false; style.dim = false; }
      else if (c === 23) style.italic = false;
      else if (c === 24) style.underline = false;
      else if (c >= 30 && c <= 37) style.fg = ANSI_COLORS[c - 30];
      else if (c >= 90 && c <= 97) style.fg = ANSI_COLORS[c - 90];
      else if (c === 39) style.fg = null;
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
    }
  };
  return (chunk) => {
    let text = carry + chunk;
    carry = '';
    const cut = text.lastIndexOf('\x1b');
    if (cut !== -1 && !/^\x1b(\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/.test(text.slice(cut))) {
      carry = text.slice(cut);
      text = text.slice(0, cut);
    }
    let last = 0;
    for (const m of text.matchAll(ANSI_SEQUENCE)) {
      emit(text.slice(last, m.index));
      if (m[2] === 'm') apply(m[1]);
      last = m.index + m[0].length;
    }
    emit(text.slice(last));
  };
}

export async function pageJob(kind, id, gen) {
  const k = JOB_KINDS[kind];
  const jobPath = `${k.api}/${encodeURIComponent(id)}`;
  const job = await api(jobPath);
  if (gen !== view.pageGen) return;
  const log = h('pre', { class: 'log' });
  const writeLog = ansiWriter(log);
  const result = (j) => (active(j) ? [] : [jobBadge(j)]);
  const status = h('span', { class: 'job-status' }, ...result(job));
  const cancelBtn = h('button', { class: 'btn btn-danger-text', onclick: guard(() => api(`${jobPath}/cancel`, { method: 'POST' })) }, actionIcon('Annuler'), 'Annuler');
  const subtitle = h('span');
  const describe = (j) => {
    subtitle.textContent = [ENGINE_CARDS[kind].name, j.vm_name && `VM ${j.vm_name}`,
      `lancé le ${fmtDate(j.created_at)}`, j.started_at && `durée ${duration(j)}`].filter(Boolean).join(' · ');
  };
  const ringOf = (j) => engineRing(kind, { running: j.status === 'running' ? 1 : 0, queued: j.status === 'queued' ? 1 : 0,
    label: `${ENGINE_CARDS[kind].name} · ${{ running: 'job en cours', queued: 'job en attente' }[j.status] || 'job terminé'}` });
  const jobRing = h('span', { class: 'ec-ring-slot' }, ringOf(job));
  describe(job);
  app.replaceChildren(
    h('div', { class: `section-card engine-card job-card ${kind}` },
      cardHeader(jobRing, `${k.actionLabel(job)} · ${job.profile || '(profil supprimé)'}`, subtitle,
        h('div', { class: 'row job-actions' }, status, cancelBtn,
          h('a', { class: 'job-download', href: `/api${jobPath}/archive`, title: 'Télécharger le journal et les fichiers du job', 'aria-label': 'Télécharger' },
            svgIcon('M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10')))),
      h('div', { class: 'job-panels' },
        h('div', { class: 'job-panel job-bottom' }, h('h2', {}, 'Journal'), log))));
  const refresh = async () => {
    const j = await api(jobPath).catch(() => job);
    status.replaceChildren(...result(j));
    morph(jobRing.firstChild, ringOf(j));
    describe(j);
    cancelBtn.hidden = !active(j);
    return j;
  };
  view.stream = new EventSource(`/api${jobPath}/logs`);
  view.stream.onmessage = (e) => {
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    writeLog(JSON.parse(e.data));
    if (stick) log.scrollTop = log.scrollHeight;
  };
  view.stream.addEventListener('end', () => { view.stream.close(); refresh(); });
  const poll = async () => { if (gen === view.pageGen && active(await refresh())) view.timer = setTimeout(poll, 2000); };
  poll();
}

export async function pageDashboard(gen) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [stats, jobs, tofuJobs, ansibleJobs] = await Promise.all([
    api(`/stats?tz=${encodeURIComponent(tz)}`), api('/jobs?limit=15'), api('/tofu/jobs?limit=15'), api('/ansible/jobs?limit=15')]);
  if (gen !== view.pageGen) return;
  const next = h('div', { class: 'dashboard' },
    h('div', { class: 'dash-grid' }, engineCard('packer', stats.packer), engineCard('tofu', stats.tofu), engineCard('ansible', stats.ansible)),
    h('div', { class: 'dash-grid dash-recent' },
      recentJobsCard('packer', jobs),
      recentJobsCard('tofu', tofuJobs),
      recentJobsCard('ansible', ansibleJobs)));
  const cur = app.firstElementChild;
  if (cur?.classList.contains('dashboard') && app.childElementCount === 1) morph(cur, next);
  else app.replaceChildren(next);
  restoreChartHover();
  nextDashboardRefresh(gen);
}

function nextDashboardRefresh(gen) {
  view.timer = setTimeout(() => {
    if (gen !== view.pageGen) return;
    pageDashboard(gen).catch((e) => { if (!(e instanceof SessionExpired)) nextDashboardRefresh(gen); });
  }, 4000);
}

const pointer = { x: null, y: null };
document.addEventListener('mousemove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
document.documentElement.addEventListener('mouseleave', () => { pointer.x = null; });
function restoreChartHover() {
  if (pointer.x == null) return;
  const bars = document.elementFromPoint(pointer.x, pointer.y)?.closest('.ec-bars');
  bars?.dispatchEvent(new MouseEvent('mousemove', { clientX: pointer.x, clientY: pointer.y }));
}

const percent = (n, total) => (total ? Math.round((n / total) * 100) : 0);


const successRate = ({ success, failed }) => (success + failed ? percent(success, success + failed) : null);

function monotonePath(xs, ys) {
  const n = xs.length;
  if (n < 2) return n ? `M${xs[0]},${ys[0]}` : '';
  const dx = [];
  const sl = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i]; sl[i] = (ys[i + 1] - ys[i]) / dx[i]; }
  const m = [sl[0]];
  for (let i = 1; i < n - 1; i++) {
    m[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / sl[i - 1] + (dx[i] + 2 * dx[i - 1]) / sl[i]);
  }
  m[n - 1] = sl[n - 2];
  let d = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const t = dx[i] / 3;
    d += ` C${xs[i] + t},${ys[i] + m[i] * t} ${xs[i + 1] - t},${ys[i + 1] - m[i + 1] * t} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return d;
}

function activityChart(activity) {
  const n = activity.length;
  const totals = activity.map((d) => d.success + d.failed + d.cancelled + d.active);
  const total = totals.reduce((a, b) => a + b, 0);
  const max = Math.max(...totals, 1);
  const dayLabel = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const X = (i) => ((i + 0.5) / n) * 100;
  const Y = (v) => 96 - (v / max) * 88;
  const place = (el, i, v) => { el.style.left = `${X(i)}%`; el.style.top = `${Y(v)}%`; return el; };
  const failedDays = activity.filter((d) => d.failed).length;

  const bars = h('div', { class: 'ec-bars', role: 'img', 'data-activity': JSON.stringify(activity),
    'aria-label': `${plural(total, 'job', 'jobs')} sur ${n} jours, ${failedDays ? plural(failedDays, 'jour avec échec', 'jours avec échec') : 'aucun échec'}` },
  svgEl('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svgEl('path', { class: 'ec-line', d: monotonePath(activity.map((_, i) => X(i)), totals.map(Y)) })));
  activity.forEach((_, i) => { if (i < n - 1) bars.append(place(h('i', { class: 'ec-tick' }), i, totals[i])); });
  if (n) {
    const last = n - 1;
    bars.append(place(h('i', { class: `ec-pt${activity[last].active ? ' run' : ''}` }), last, totals[last]),
      place(h('span', { class: 'ec-end' }, String(totals[last])), last, totals[last]));
  }

  bars.append(h('i', { class: 'ec-xh' }), h('div', { class: 'ec-xt' }));
  bars.addEventListener('mousemove', (e) => {
    const days = JSON.parse(bars.dataset.activity);
    const r = bars.getBoundingClientRect();
    const i = Math.max(0, Math.min(days.length - 1, Math.floor(((e.clientX - r.left) / r.width) * days.length)));
    const d = days[i];
    const x = `${((i + 0.5) / days.length) * 100}%`;
    const tip = bars.querySelector('.ec-xt');
    bars.querySelector('.ec-xh').style.left = tip.style.left = x;
    tip.classList.toggle('left', i >= days.length / 2);
    const lines = [
      d.success && h('span', {}, plural(d.success, 'réussi', 'réussis')),
      d.failed && h('span', { class: 'ko' }, plural(d.failed, 'échec', 'échecs')),
      d.cancelled && h('span', { class: 'cx' }, plural(d.cancelled, 'annulé', 'annulés')),
      d.active && h('span', {}, `${d.active} en cours`)].filter(Boolean);
    tip.replaceChildren(h('b', {}, i === days.length - 1 ? 'Aujourd’hui' : dayLabel(d.day)), ...(lines.length ? lines : [h('span', {}, 'aucun job')]));
    bars.classList.add('hovering');
  });
  bars.addEventListener('mouseleave', () => bars.classList.remove('hovering'));

  return h('div', { class: 'ec-activity' },
    h('div', { class: 'ec-activity-head' }, h('span', {}, `${n} jours · ${plural(total, 'job', 'jobs')}`)),
    bars,
    h('div', { class: 'ec-axis' },
      h('span', {}, n ? dayLabel(activity[0].day) : ''), h('span', {}, 'aujourd’hui')));
}

const INFRA_NAMES = { packer: 'XCP-ng', tofu: 'Xen Orchestra', ansible: 'forge-ansible' };
const INFRA_HOSTS = { packer: 'Maître', tofu: 'Serveur', ansible: 'Conteneur' };
export function infraInfo(engine, infra = {}) {
  const name = INFRA_NAMES[engine];
  const checked = infra.checked_at ? `vérifié ${timeAgo(infra.checked_at)}` : 'pas encore vérifié';
  const [up, down] = engine === 'ansible' ? ['Actif', 'Arrêté'] : ['Joignable', 'Injoignable'];
  const [label, kind, title] = {
    ok: [name, 'on', [`${up} · ${INFRA_HOSTS[engine]} ${infra.host} · ${checked}`, ...(infra.issues || [])].join('\n')],
    down: [name, 'warn', `${down} : ${infra.error || 'Erreur inconnue'} · ${checked}`],
    unconfigured: [`${name} non configuré`, '', 'À renseigner dans Infrastructure > Connecteurs'],
  }[infra.state] || [`${name} : état inconnu`, '', ''];
  return { label, kind, title };
}


const RING_SPIN_MS = 4000;
function spinArc(r) {
  const arc = svgEl('circle', { class: 'ec-spin', cx: 60, cy: 60, r, 'stroke-dasharray': `${(2 * Math.PI * r) / 4} ${2 * Math.PI * r}` });
  arc.style.animationDelay = `-${Date.now() % RING_SPIN_MS}ms`;
  arc.setAttribute('data-morph-keep', 'style');
  return arc;
}
export function engineRing(engine, { running = 0, queued = 0, label, dot, icon }) {
  const r = 52;
  return h('div', { class: `ec-ring${running + queued ? ' busy' : ''}${running ? ' running' : ''}`,
    role: 'img', 'aria-label': label.replace(/\n/g, '. '), title: label },
  svgEl('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' },
    svgEl('circle', { class: 'ec-track', cx: 60, cy: 60, r }),
    running ? spinArc(r) : null),
  h('span', { class: 'ec-ring-icon' }, svgIcon(icon || ENGINE_CARDS[engine].icon)),
  dot ? h('i', { class: `ec-dot ${dot}` }) : null);
}
const countsRing = (engine, icon, counts) => {
  const running = counts?.running || 0;
  const queued = counts?.queued || 0;
  const state = running + queued ? [running && `${running} en cours`, queued && `${queued} en attente`].filter(Boolean).join(' · ') : 'Inactif';
  return engineRing(engine, { running, queued, icon, label: `${ENGINE_CARDS[engine].name} · ${state}` });
};
export function activityRing(engine, icon) {
  const gen = view.pageGen;
  const slot = h('span', { class: 'ec-ring-slot' }, countsRing(engine, icon));
  const tick = async () => {
    if (gen !== view.pageGen) return;
    try {
      const d = await api(`${JOB_KINDS[engine].api}?paged=1&limit=1&offset=0&search=`);
      if (gen !== view.pageGen) return;
      morph(slot.firstChild, countsRing(engine, icon, d.counts));
    } catch (e) {
      if (e instanceof SessionExpired) return;
    }
    setTimeout(tick, 5000);
  };
  tick();
  return slot;
}
function statusRing(engine, st) {
  const infra = infraInfo(engine, st.infra);
  const activity = st.running + st.queued
    ? [st.running && `${st.running} en cours`, st.queued && `${st.queued} en attente`].filter(Boolean).join(' · ')
    : 'Inactif';
  const label = [`${infra.kind ? INFRA_NAMES[engine] : infra.label}${infra.title ? ` · ${infra.title}` : ''}`,
    `${ENGINE_CARDS[engine].name} : ${activity}`].join('\n');
  const ring = engineRing(engine, { running: st.running, queued: st.queued, label, dot: infra.kind || 'off' });
  return st.infra?.state === 'ok' || engine === 'ansible' ? ring : h('a', { class: 'ec-ring-link', href: '#/connectors' }, ring);
}

function nextRun(d) {
  const date = new Date(d);
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const day = days <= 0 ? 'aujourd’hui' : days === 1 ? 'demain' : date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  return [day, time];
}

function engineCard(engine, st) {
  const e = ENGINE_CARDS[engine];
  const metric = ({ label, value, of, sub, title, href }) => h(href ? 'a' : 'div', { class: 'ec-metric', ...(href ? { href } : {}), ...(title ? { title } : {}) },
    h('span', { class: 'ec-metric-label' }, label),
    h('b', {}, String(value), of != null ? h('span', { class: 'ec-of' }, `/${of}`) : null),
    h('span', { class: 'ec-metric-sub' }, sub));
  const rate = successRate(st.recent);
  const sched = st.schedules || {};
  const [day, time] = sched.next_run_at ? nextRun(sched.next_run_at) : [];
  const actives = sched.active ? plural(sched.active, 'planification active', 'planifications actives') : 'aucune planification active';
  const metrics = [
    e.asset(st),
    { label: 'Durée moy.', value: shortDuration(st.avg_seconds), sub: st.avg_count ? plural(st.avg_count, 'job', 'jobs') : 'aucun job',
      title: st.avg_count ? `Moyenne sur ${plural(st.avg_count, 'job réussi', 'jobs réussis')} · ${st.window_days} j` : `Aucun job réussi sur ${st.window_days} j` },
    { label: 'Réussite', value: rate == null ? '—' : `${rate} %`,
      sub: rate == null ? 'aucun job' : `${st.recent.success} sur ${plural(st.recent.success + st.recent.failed, 'job', 'jobs')}`,
      title: `${plural(st.recent.success, 'réussi', 'réussis')} / ${plural(st.recent.failed, 'échec', 'échecs')} sur ${st.window_days} jours, annulés non comptés` },
    { label: 'Prochaine', value: time || '—', sub: day || (sched.active ? plural(sched.active, 'active', 'actives') : 'aucune'),
      title: `Planification · ${actives}`, href: `#/${engine}/schedules` },
  ];
  return h('div', { class: `section-card engine-card ${engine}` },
    h('div', { class: 'ec-head' },
      statusRing(engine, st),
      h('div', { class: 'ec-title' }, h('h2', {}, e.name), h('span', {}, e.subtitle))),
    h('div', { class: 'ec-metrics engine-metrics' }, metrics.map(metric)),
    activityChart(st.activity),
    h('div', { class: 'ec-foot' },
      h('nav', { class: 'ec-links' }, h('a', { href: `#/${engine}/profiles` }, '☰ Profils'))));
}

function recentJobsCard(engine, jobs) {
  const k = JOB_KINDS[engine];
  const line = (j) => h('a', { class: `rj-row${active(j) ? ' live' : ''}`, href: `${k.route}/${j.id}` },
    h('span', { class: 'cell-job' }, jobIcon(j), h('span', {}, k.actionLabel(j))),
    h('span', { class: 'rj-main' },
      h('b', {}, j.profile || '(profil supprimé)')),
    h('span', { class: 'rj-duration' }, duration(j)),
    h('span', { class: 'rj-time', title: fmtDate(j.created_at) }, timeAgo(j.created_at)));
  return h('div', { class: `section-card recent-card ${engine}` },
    h('div', { class: 'ec-head' },
      h('nav', { class: 'ec-links' }, h('a', { href: k.historyRoute }, '☰ Historique'))),
    jobs.length
      ? h('div', { class: 'rj-list' }, jobs.map(line))
      : h('div', { class: 'rj-empty' }, k.empty));
}
