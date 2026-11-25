import { app, view } from './page.js';
import { h, ICONS } from './dom.js';
import { countLabel, fmtDate } from './format.js';
import { pagedSource } from './api.js';
import { emptyCell, oneLine, stateIcon, tipLines } from './display.js';
import { dataTable, groupFilters } from './table.js';

const OUTCOMES = {
  success: ['Réussi', 'success'],
  partial: ['Partiel', 'cancelled'],
  refused: ['Refusé', 'failed'],
  error: ['Erreur', 'failed'],
};
const FILTERS = groupFilters(Object.entries(OUTCOMES).map(([value, [label, cls]]) => [value, label, cls]));
const ACTORS = { system: 'Système (planificateur)', anonymous: 'Non connecté' };

const outcomeCell = (r) => {
  const [label, cls] = OUTCOMES[r.outcome] || [r.outcome, 'disabled'];
  return stateIcon(cls === 'cancelled' ? 'warn' : cls, label, [label, r.status && `HTTP ${r.status}`].filter(Boolean).join(' · '));
};

const detailValue = (v) => {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? `${x.target} (${x.error})` : x)).join(', ');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
const detailsText = (d = {}) => {
  const { from, to, ...rest } = d || {};
  const change = from !== undefined || to !== undefined ? [`${detailValue(from ?? '—')} → ${detailValue(to ?? '—')}`] : [];
  return [...change, ...Object.entries(rest)
    .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k} : ${detailValue(v)}`)].join(' · ');
};

export async function pageAudit(gen = view.pageGen) {
  const t = await dataTable({
    key: 'audit',
    source: pagedSource('/audit'),
    card: {
      icon: ICONS.audit, title: 'Audit',
      intro: tipLines(['Contenu', 'Une ligne par action : connexion, création, modification, suppression, lancement, test, téléchargement…'],
        ['Conservation', 'Les entrées plus anciennes que la durée de conservation (Paramètres › Sécurité) sont supprimées automatiquement.']),
      subtitle: (d, st) => `Journal d’audit · ${countLabel(st, d.total || 0, 'entrée', 'entrées')}`,
    },
    filters: FILTERS,
    search: true,
    empty: 'Aucune entrée d’audit.',
    poll: 30000,
    select: false,
    columns: [
      ['Utilisateur', (r) => oneLine(r.username || ACTORS[r.actor] || '—'), '10%', 'user'],
      ['Statut', outcomeCell, '8%', 'outcome'],
      ['Date', (r) => h('span', { class: 'cell-num' }, fmtDate(r.at)), '10%', 'at:desc'],
      ['Événement', (r) => h('span', { class: 'cell-mono', title: r.event }, r.event), '14%', 'event'],
      ['IP', (r) => (r.ip ? h('span', { class: 'cell-mono' }, r.ip) : emptyCell()), '10%', 'ip'],
      ['Cible', (r) => (r.target ? oneLine(r.target) : emptyCell()), '10%', 'target'],
      ['Détails', (r) => (detailsText(r.details) ? oneLine(detailsText(r.details)) : emptyCell()), '38%', 'details'],
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}
