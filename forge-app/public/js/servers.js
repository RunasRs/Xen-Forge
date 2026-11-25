import { app, view } from './page.js';
import { actionIcon, h, ICONS, toast } from './dom.js';
import { countLabel, fmtDate } from './format.js';
import { api, batch, guard, localSource } from './api.js';
import { cardHeader, helpTip, oneLine, stack, stateBadge, stateRing, tipLines, when } from './display.js';
import { dataTable } from './table.js';
import { deleteConfirm, openModal } from './modal.js';
import { checkbox, formActions, group, numberStepper, passwordField, toggleSwitch } from './forms.js';
import { caPicker, SYSTEM_CA } from './certificates.js';
import { infraInfo } from './jobs.js';
import { COMPLEXITY_LABELS } from './password-policy.js';

export async function pageSettings(gen = view.pageGen) {
  const xo = await api('/settings/xo');
  const hostsCard = await xcpHostsCard();
  const xoCard = await connectionCard({
    title: 'Xen Orchestra',
    subtitle: 'Déploiements OpenTofu',
    intro: tipLines(['Utilisation', 'Utilisée par OpenTofu (provider Xen Orchestra) pour créer, modifier et détruire les VM.']),
    empty: 'Aucune connexion Xen Orchestra : requise pour les déploiements OpenTofu.',
    configured: !!(xo.xo_host && xo.xo_username),
    values: { host: xo.xo_host, user: xo.xo_username, passwordSet: xo.xo_password_set, insecure: xo.xo_insecure, caId: xo.xo_ca_id, caName: xo.xo_ca_name },
    form: {
      name: 'Xen Orchestra',
      title: 'Connecteur Xen Orchestra',
      save: (v) => api('/settings/xo', { method: 'PUT', body: {
        xo_host: v.host, xo_username: v.user, xo_password: v.password, xo_insecure: v.insecure, xo_ca_id: v.caId } }),
    },
    status: async () => (await api('/settings/xo')).status,
    test: () => api('/settings/xo/test', { method: 'POST' }),
    remove: () => api('/settings/xo', { method: 'DELETE' }),
    removeMessage: `Supprimer la connexion à « ${xo.xo_host} » ? Aucun déploiement OpenTofu ne pourra être lancé sans la reconfigurer.`,
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(hostsCard, xoCard);
}

const certBadge = (insecure, caName) => (insecure
  ? stateBadge('warn', 'non vérifié', 'Certificat non vérifié')
  : stateBadge('active', 'vérifié', `Certificat vérifié par : ${caName || SYSTEM_CA}`));
const caCell = (insecure, caName) => (insecure ? h('span', { class: 'cell-muted' }, '—') : oneLine(caName || SYSTEM_CA));

function connectionModal(f, current = null) {
  const host = h('input', { type: 'text', value: current?.host || '', required: true, maxlength: 255 });
  const user = h('input', { type: 'text', value: current?.user || '', required: true, maxlength: 255 });
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: !current?.passwordSet,
    placeholder: current?.passwordSet ? 'Laisser vide pour conserver' : '' });
  const verify = checkbox(current ? !current.insecure : false);
  const ca = caPicker(current?.caId || '');
  const caGroup = group('Autorité de certification', ca,
    tipLines(['Définition', 'Certificat CA (Sécurité › Certificats) qui doit avoir émis le certificat de l’hôte.'],
      ['Autorités du système', 'Magasin du conteneur.']), true);
  const syncVerify = () => { caGroup.hidden = !verify.checked; };
  verify.addEventListener('change', syncVerify);
  syncVerify();
  let close;
  const form = h('form', { class: 'form-compact', onsubmit: guard(async (e) => {
    e.preventDefault();
    await f.save({ host: host.value, user: user.value, password: password.value, insecure: !verify.checked,
      caId: verify.checked ? ca.value || '' : '' });
    close();
    pageSettings();
  }) },
  h('div', { class: 'form-row' },
    group('Adresse', host, tipLines(['Valeur', 'Adresse IP ou nom DNS.'], ['Port', 'Facultatif, après « : » ; 443 par défaut.']), true),
    group('Identifiant', user, null, true),
    group('Mot de passe', passwordField(password), null, true),
    group('Certificat', toggleSwitch(verify, 'Vérifier le certificat'), tipLines(['Désactivé', 'Connexion chiffrée, mais sans contrôle de l’identité du serveur.']), true),
    caGroup),
  formActions(() => close(), current ? 'Enregistrer' : 'Créer'));
  close = openModal(f.title, form, { size: 'compact' });
}

const HOST_ROLES = {
  master: ['active', 'maître'],
  member: ['disabled', 'membre'],
  auth_failed: ['failed', 'identifiants refusés'],
  unreachable: ['failed', 'injoignable'],
  unknown: ['warn', 'inconnu'],
};

async function xcpHostsCard() {
  const form = {
    name: 'XCP-ng',
    title: 'Connecteur XCP-ng',
  };
  const save = (id) => (v) => api(id ? `/xcp/hosts/${id}` : '/xcp/hosts', { method: id ? 'PUT' : 'POST', body: {
    host: v.host, username: v.user, password: v.password, insecure: v.insecure, ca_certificate_id: v.caId } });
  const roleLabel = (x) => (HOST_ROLES[x.role] || HOST_ROLES.unknown)[1];
  const roleCell = (x) => {
    const [cls, label] = HOST_ROLES[x.role] || HOST_ROLES.unknown;
    return stateBadge(cls, label);
  };

  let hosts = [];
  const masterRing = () => {
    if (!hosts.length) return stateRing(ICONS.server, { label: 'Aucun hôte' });
    const master = hosts.find((x) => x.role === 'master');
    if (!master) return stateRing(ICONS.server, { state: 'warn', label: 'Aucun maître joignable' });
    return stateRing(ICONS.server, { state: 'on',
      label: [`Maître : ${master.host}`, master.checked_at && `vérifié le ${fmtDate(master.checked_at)}`].filter(Boolean).join(' · ') });
  };
  const detectBtn = h('button', { class: 'btn', onclick: guard(async () => {
    const rows = await api('/xcp/hosts/detect', { method: 'POST' });
    if (!rows.some((r) => r.role === 'master')) toast('Aucun maître joignable parmi les hôtes enregistrés');
    await t.reload();
  }) }, actionIcon('Détecter le maître'), 'Détecter le maître');
  const loadHosts = async () => {
    hosts = await api('/xcp/hosts');
    detectBtn.hidden = !hosts.length;
    return hosts;
  };

  const t = await dataTable({
    key: 'xcp-hosts',
    source: localSource(loadHosts, (x) => [x.host, x.username, roleLabel(x)], { host: (x) => x.host, checked: (x) => x.checked_at }),
    card: {
      icon: ICONS.server, title: 'XCP-ng — hôtes du pool',
      subtitle: (d, st) => `Pool XCP-ng · ${countLabel(st, d.total || 0, 'hôte', 'hôtes')}`,
      intro: tipLines(['Utilisation', 'Builds Packer, listes des SR, réseaux et templates, pré-vérifications OpenTofu : toujours via le maître.'],
        ['Configuration', 'Enregistrer tous les hôtes du pool avec leurs identifiants.'],
        ['Maître', 'Redétecté chaque minute et après une bascule.']),
      ring: masterRing,
    },
    search: true,
    empty: 'Aucun hôte XCP-ng : requis pour les builds Packer et les déploiements OpenTofu.',
    create: { label: 'Ajouter', run: () => connectionModal({ ...form, save: save(null) }) },
    tools: detectBtn,
    poll: 30000,
    columns: [
      ['Hôte', (x) => stack(x.host), '14%', 'host'],
      ['Compte', (x) => oneLine(x.username), '14%'],
      ['Rôle', roleCell, '14%'],
      ['Erreur', (x) => (x.last_error ? oneLine(x.last_error) : h('span', { class: 'cell-muted' }, '—')), '25%'],
      ['Certificat', (x) => certBadge(x.insecure, x.ca_name || x.caName), '11%'],
      ['Autorité', (x) => caCell(x.insecure, x.ca_name || x.caName), '11%'],
      ['Vérifié', (x) => when(x.checked_at), '11%', 'checked:desc'],
    ],
    actions: [
      { label: 'Tester', when: 'many', reload: false, run: async (sel) => {
        const failures = (await Promise.all(sel.map(async (x) => {
          const r = await api(`/xcp/hosts/${x.id}/test`, { method: 'POST' }).catch((e) => ({ error: e.message }));
          return ['master', 'member'].includes(r.role) ? null : `${x.host} : ${r.error}`;
        }))).filter(Boolean);
        if (failures.length) toast(failures.join(' — '));
      } },
      { label: 'Modifier', when: 'one', reload: false, run: ([x]) => connectionModal({ ...form, save: save(x.id) },
        { host: x.host, user: x.username, passwordSet: true, insecure: x.insecure, caId: x.ca_certificate_id || '' }) },
      { label: 'Supprimer', when: 'many', danger: true,
        confirm: (sel) => deleteConfirm(sel, ["l'hôte", 'les hôtes'], (x) => x.host,
          `Les identifiants sont supprimés.${sel.some((x) => x.role === 'master')
            ? ' Le maître actuel en fait partie : un autre hôte enregistré devra être maître pour lancer des jobs.' : ''}`),
        run: (sel) => batch('/xcp/hosts/batch', 'delete', sel) },
    ],
  });
  t.el.classList.add('hosts-card');
  return t.el;
}

async function connectionCard(c) {
  const { values: v } = c;
  const edit = () => connectionModal(c.form, c.configured ? { ...v } : null);
  let status;
  const t = await dataTable({
    key: `connection-${c.form.name}`,
    source: async () => {
      status = await c.status();
      return c.configured ? { rows: [{ id: 'xo', ...v }], total: 1 } : { rows: [], total: 0 };
    },
    paginate: false,
    poll: 30000,
    card: {
      icon: ICONS.link, title: c.title, intro: c.intro, subtitle: () => c.subtitle,
      ring: () => {
        const { label, kind, title } = infraInfo('tofu', status);
        return stateRing(ICONS.link, { state: kind === 'on' || kind === 'warn' ? kind : '', label: title || label });
      },
    },
    empty: c.empty,
    create: c.configured ? null : { label: 'Ajouter', run: edit },
    columns: [
      ['Adresse', (x) => stack(x.host), '14%'],
      ['Compte', (x) => oneLine(x.user), '53%'],
      ['Certificat', (x) => certBadge(x.insecure, x.ca_name || x.caName), '11%'],
      ['Autorité', (x) => caCell(x.insecure, x.ca_name || x.caName), '11%'],
      ['Vérifié', () => when(status?.checked_at), '11%'],
    ],
    actions: [
      { label: 'Tester', when: 'one', run: () => c.test() },
      { label: 'Modifier', when: 'one', reload: false, run: edit },
      { label: 'Supprimer', when: 'one', danger: true, reload: false,
        confirm: () => ({ title: `Supprimer la connexion ${c.form.name}`, message: c.removeMessage, confirmLabel: 'Supprimer' }),
        run: async () => {
          await c.remove();
          pageSettings();
        } },
    ],
  });
  return t.el;
}

const POLICY_TIPS = [['Application', 'Création, réinitialisation et changement de mot de passe.'],
  ['Comptes existants', 'Mot de passe non conforme : changement imposé à la prochaine connexion.'],
  ['Domaine', 'Non concerné : politique de l’Active Directory.']];

export function pageSecurity() {
  const groups = [
    ['Authentification', [
      settingRow('Exiger le TOTP à la connexion', 'Code à usage unique demandé à chaque connexion.',
        tipLines(['Portée', 'S’applique aux comptes locaux et du domaine.']),
        toggleSetting('/auth/settings', 'totpEnabled', 'Exiger le TOTP à la connexion')),
      settingRow('Longueur minimale des mots de passe', 'Comptes locaux : nombre de caractères exigé.',
        tipLines(['Valeur', 'Entre 12 et 64 caractères.'], ['Par défaut', '12 caractères.'], ...POLICY_TIPS),
        numberSetting('/auth/password-policy', 'minLength', { min: 12, max: 64, unit: 'caractères', label: 'Longueur minimale des mots de passe' })),
      settingRow('Complexité des mots de passe', 'Types de caractères exigés : minuscules, majuscules, chiffres, caractères spéciaux.',
        tipLines(['Aucune', 'Seule la longueur compte.'], ['3 types sur 4', 'Au moins trois des quatre types.'], ['4 types sur 4', 'Les quatre types.'], ...POLICY_TIPS),
        selectSetting('/auth/password-policy', 'complexity', COMPLEXITY_LABELS, 'Complexité des mots de passe')),
    ]],
    ['Journaux des jobs', [
      settingRow('Couleurs dans les journaux', 'Packer, OpenTofu et Ansible écrivent leurs couleurs dans le journal.',
        tipLines(['Activé', 'Couleurs affichées avec celles du thème.'], ['Désactivé', 'Journal en texte sans couleur.'],
          ['Téléchargement', 'Archive et journal téléchargés toujours sans codes de couleur.'], ['Application', 'Jobs lancés après le changement.']),
        toggleSetting('/logs/settings', 'colors', 'Couleurs dans les journaux')),
      settingRow('Commandes exécutées (Packer Linux)', ['Chaque commande des scripts de provisionnement Linux est écrite dans le journal, précédée de ', h('code', {}, '+'), '.'],
        tipLines(['Désactivé', 'Seuls les messages des scripts sont écrits ; en cas d’échec, une ligne ', h('code', {}, 'Error:'), ' indique l’étape en cause.'],
          ['Application', 'Jobs lancés après le changement.'], ['Windows', 'Non concerné.']),
        toggleSetting('/logs/trace', 'packerLinux', 'Commandes exécutées (Packer Linux)')),
    ]],
    ['Conservation', [
      settingRow('Historique des jobs', 'Jobs terminés, avec leurs journaux et fichiers. 0 = jamais supprimé.',
        tipLines(['Valeur', 'Entre 0 et 3650 jours.'], ['Par défaut', '60 jours.'],
          ['Portée', 'Jobs Packer, OpenTofu et Ansible terminés ; les jobs en attente ou en cours ne sont jamais supprimés.'],
          ['Purge', 'Au démarrage, toutes les heures et à chaque changement de la valeur.']),
        numberSetting('/settings/jobs', 'retentionDays', { min: 0, max: 3650, unit: 'jours', label: 'Historique des jobs' })),
      settingRow('Journal d’audit', 'Entrées plus anciennes supprimées automatiquement.',
        tipLines(['Valeur', 'Entre 1 et 3650 jours.'], ['Par défaut', '120 jours.']),
        numberSetting('/audit/settings', 'retentionDays', { min: 1, max: 3650, unit: 'jours', label: 'Journal d’audit' })),
    ]],
  ];
  app.replaceChildren(h('div', { class: 'settings-page' },
    cardHeader(ICONS.shield, 'Sécurité', 'Authentification, journaux et conservation des données'),
    groups.map(([title, rows]) => h('section', { class: 'settings-group' },
      h('h2', { class: 'settings-group-title' }, title), h('div', { class: 'settings-list' }, rows)))));
}

function settingRow(label, desc, tip, load) {
  const control = h('div', { class: 'form-group setting-control' }, h('span', { class: 'hint' }, 'Chargement…'));
  load().then((el) => control.replaceChildren(el))
    .catch((e) => control.replaceChildren(h('span', { class: 'hint' }, `Indisponible : ${e.message}`)));
  return h('div', { class: 'setting-row' },
    h('div', { class: 'setting-text' },
      h('div', { class: 'setting-label' }, h('span', {}, label), helpTip(tip)),
      h('p', { class: 'setting-desc' }, desc)),
    control);
}

const toggleSetting = (path, key, label) => async () => {
  const tgl = checkbox((await api(path))[key]);
  tgl.setAttribute('aria-label', label);
  tgl.addEventListener('change', guard(async () => {
    try {
      tgl.checked = (await api(path, { method: 'PUT', body: { [key]: tgl.checked } }))[key];
    } catch (e) {
      tgl.checked = !tgl.checked;
      throw e;
    }
  }));
  return toggleSwitch(tgl, '');
};

const numberSetting = (path, key, { min, max, unit, label }) => async () => {
  let saved = (await api(path))[key];
  const input = h('input', { type: 'number', min, max, step: 1, required: true, value: saved, 'aria-label': `${label} (${unit})` });
  input.addEventListener('change', guard(async () => {
    try {
      saved = (await api(path, { method: 'PUT', body: { [key]: Number(input.value) } }))[key];
      input.value = saved;
    } catch (e) {
      input.value = saved;
      throw e;
    }
  }));
  return h('div', { class: 'setting-number' }, h('span', {}, unit), numberStepper(input));
};

const selectSetting = (path, key, labels, label) => async () => {
  let saved = (await api(path))[key];
  const select = h('select', { 'aria-label': label },
    Object.entries(labels).map(([value, text]) => h('option', { value, selected: value === saved }, text)));
  select.addEventListener('change', guard(async () => {
    try {
      saved = (await api(path, { method: 'PUT', body: { [key]: select.value } }))[key];
      select.value = saved;
    } catch (e) {
      select.value = saved;
      throw e;
    }
  }));
  return select;
};
