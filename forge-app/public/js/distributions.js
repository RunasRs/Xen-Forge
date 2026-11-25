import { app, view } from './page.js';
import { h, ICONS, toast } from './dom.js';
import { countLabel, fmtDate, plural } from './format.js';
import { api, batchToast, guard, pagedSource } from './api.js';
import { ENGINE_CARDS } from './engines.js';
import { jobIcon, stack, tipLines } from './display.js';
import { dataTable } from './table.js';
import { deleteConfirm, openModal } from './modal.js';
import { formActions, group } from './forms.js';
import { optionPicker } from './pickers.js';
import { copyText } from './clipboard.js';
import { activityRing, engineRing, JOB_KINDS } from './jobs.js';

const distributionKey = (d) => `${d.os}/${d.version}`;

const copyCell = (value, extra = '') => h('button', {
  class: `cell-copy${extra ? ` ${extra}` : ''}`, title: `${value}\n(cliquer pour copier)`,
  onclick: guard(() => copyText(value)),
}, value);
let catalogOsPromise = null;
const loadCatalogOs = () => (catalogOsPromise ||= api('/distributions/os').catch((e) => { catalogOsPromise = null; throw e; }));

export async function pageDistributions(gen = view.pageGen) {
  const distributionModal = (entry) => {
    const osSelect = optionPicker(null, entry?.os || '', { placeholder: 'Sélectionner…', missing: `${entry?.os} (absent de la liste des OS)` });
    loadCatalogOs().then((list) => osSelect.setOptions(list.map((o) => ({ value: o, name: o }))))
      .catch((e) => { osSelect.setOptions([]); toast(`Liste des OS indisponible : ${e.message}`); });
    const version = h('input', { type: 'text', value: entry?.version || '', required: true, maxlength: 64, autocomplete: 'off' });
    const url = h('input', { type: 'url', value: entry?.url || '', required: true, maxlength: 2048, autocomplete: 'off', spellcheck: 'false' });
    const hash = h('input', { type: 'text', value: entry?.hash || '', maxlength: 71, autocomplete: 'off', spellcheck: 'false' });
    let close;
    const form = h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      if (!osSelect.value) throw new Error('Sélectionner l’OS');
      const body = { os: osSelect.value, version: version.value.trim(), url: url.value.trim(), hash: hash.value.trim() };
      await (entry
        ? api(`/distributions/${encodeURIComponent(entry.os)}/${encodeURIComponent(entry.version)}`, { method: 'PUT', body })
        : api('/distributions', { method: 'POST', body }));
      view.distributionRows = null;
      close();
      pageDistributions();
    }) },
    h('div', { class: 'form-row' }, group('OS *', osSelect), group('Version *', version, tipLines(['Définition', 'Identifiant de l’ISO, unique pour cet OS, proposé dans les profils Packer.']))),
    h('div', { class: 'form-row' }, group('URL de l’ISO *', url, tipLines(['Valeur', 'Lien direct vers le fichier ISO, en http ou https.']), true)),
    h('div', { class: 'form-row' }, group('Hash SHA-256', hash, tipLines(['Format', '64 caractères hexadécimaux, préfixe « sha256: » accepté.'], ['Vide', 'Image téléchargée sans contrôle d’intégrité.']), true)),
    formActions(() => close(), entry ? 'Enregistrer' : 'Créer'));
    close = openModal(entry ? `Distribution : ${entry.version}` : 'Nouvelle distribution', form, {
      icon: ICONS.disc, subtitle: entry ? `Packer · ${entry.os}` : 'Packer · ISO proposée aux profils' });
  };

  const t = await dataTable({
    key: 'distributions',
    source: pagedSource('/distributions'),
    rowId: distributionKey,
    card: {
      engine: 'packer', icon: activityRing('packer', ICONS.disc), title: 'Distributions',
      subtitle: (d, st) => `Catalogue des ISO · ${countLabel(st, d.total || 0, 'distribution', 'distributions')}`,
    },
    search: true,
    empty: 'Aucune distribution : ajoutez une ISO pour la proposer aux profils.',
    create: { label: 'Ajouter', run: () => distributionModal(null) },
    columns: [
      ['Distribution', (d) => stack(d.version), '16%', 'version'],
      ['Système', (d) => d.os, '13%', 'os'],
      ['URL', (d) => copyCell(d.url), '30%'],
      ['SHA-256', (d) => (d.hash ? copyCell(d.hash, 'mono') : h('span', { class: 'cell-muted' }, 'non vérifié')), '30%'],
      ['Profils', (d) => (d.profiles ? plural(d.profiles, 'profil') : h('span', { class: 'cell-muted' }, 'inutilisée')), '11%', 'profiles:desc'],
    ],
    actions: [
      { label: 'Modifier', when: 'one', reload: false, run: ([d]) => distributionModal(d) },
      { label: 'Supprimer', when: 'many', danger: true,
        allow: (d) => (d.profiles ? `« ${d.version} » est utilisée par ${plural(d.profiles, 'profil')} : changer leur ISO d'abord` : true),
        confirm: (sel) => deleteConfirm(sel, ['la distribution', 'les distributions'], (d) => d.version),
        run: async (sel) => {
          const r = await api('/distributions/batch', { method: 'POST', body: { action: 'delete', ids: sel.map(distributionKey) } });
          view.distributionRows = null;
          batchToast(r);
        } },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}

export const lastJobCell = (kind) => (p) => {
  const j = p.lastJob;
  if (!j) return h('span', { class: 'cell-muted' }, 'aucun job');
  const k = JOB_KINDS[kind];
  return h('a', { class: 'cell-job', href: `${k.route}/${j.id}`, title: fmtDate(j.created_at) },
    jobIcon(j), h('span', {}, k.actionLabel(j)));
};
export const profilesCard = (engine, extra) => ({
  engine, icon: ENGINE_CARDS[engine].icon, title: 'Profils',
  subtitle: (d, st) => [ENGINE_CARDS[engine].subtitle, countLabel(st, d.total || 0, 'profil', 'profils'), extra?.(d)].filter(Boolean).join(' · '),
  ring: (d) => {
    const running = d.running || 0;
    const queued = Math.max(0, (d.active || 0) - running);
    const label = d.active
      ? `${plural(d.active, 'profil occupé', 'profils occupés')} : ${[running && `${running} en cours`, queued && `${queued} en attente`].filter(Boolean).join(' · ')}`
      : 'Inactif';
    return engineRing(engine, { running, queued, label: `${ENGINE_CARDS[engine].name} · ${label}` });
  },
});

export const profileIdle = (p) => (p.busy ? 'Un job est en attente ou en cours sur ce profil' : true);

export async function cloneProfile(base, p, modal) {
  const draft = await api(`${base}/${p.id}/clone`);
  modal(null, { ...draft, sourceName: p.name });
}
