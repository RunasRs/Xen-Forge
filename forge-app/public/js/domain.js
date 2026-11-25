import { app, view } from './page.js';
import { actionIcon, h } from './dom.js';
import { fmtDate, plural, timeAgo } from './format.js';
import { api, batch, guard, localSource, SessionExpired } from './api.js';
import { activeIcon, cardHeader, emptyCell, helpTip, oneLine, stack, stateBadge, stateRing, tipLines, when } from './display.js';
import { dataTable } from './table.js';
import { confirmDialog, deleteConfirm, openModal } from './modal.js';
import { checkbox, group, passwordField, toggleSwitch } from './forms.js';
import { caPicker } from './certificates.js';

export async function pageDomain(gen = view.pageGen) {
  if (gen !== view.pageGen) return;
  const body = h('div', { class: 'section-body ldap-body' });
  await renderConfigs(body);
  if (gen === view.pageGen) app.replaceChildren(body);
}

const LDAP_ICON = 'M8 1.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM3.5 13.5a4.5 4.5 0 019 0M2 4.5h2.5M11.5 4.5H14';
const ldapProtocol = (c) => (c.tls ? (c.ldaps ? 'LDAPS' : 'STARTTLS') : 'Aucun');

const LDAP_STATES = {
  ok: (s) => ['on', `Joignable · ${s.server}`],
  down: (s) => ['warn', `Injoignable : ${s.error || 'erreur inconnue'}`],
  disabled: () => ['', 'Connecteur désactivé'],
  unconfigured: () => ['', 'Non configuré'],
};
const ldapRingOf = (s) => {
  const [state, text] = (LDAP_STATES[s?.state] || (() => ['', 'Vérification…']))(s || {});
  const checked = s?.checked_at ? `vérifié ${timeAgo(s.checked_at)} (${fmtDate(s.checked_at)})` : '';
  return stateRing(LDAP_ICON, { state, label: [text, checked].filter(Boolean).join('\n') });
};
let refreshLdapRing = () => {};
function ldapRing() {
  const gen = view.pageGen;
  const slot = h('span', { class: 'ec-ring-slot' }, ldapRingOf(null));
  let timer;
  const tick = async () => {
    clearTimeout(timer);
    if (gen !== view.pageGen) return;
    try {
      const s = await api('/ldap/status');
      if (gen !== view.pageGen) return;
      slot.replaceChildren(ldapRingOf(s));
    } catch (e) {
      if (e instanceof SessionExpired) return;
    }
    timer = setTimeout(tick, 30000);
  };
  refreshLdapRing = tick;
  tick();
  return slot;
}

async function renderConfigs(body) {
  const configs = await api('/ldap/configs');
  const c = configs.find((x) => x.enabled) || configs[0];
  const head = (subtitle, ...right) => cardHeader(ldapRing(), 'Connecteur LDAP', subtitle, ...right);
  if (!c) {
    body.replaceChildren(h('div', { class: 'section-card engine-card table-card ldap-card' },
      head('Authentification par l’annuaire'),
      h('div', { class: 'ldap-empty' },
        h('p', {}, 'Aucun connecteur LDAP : seuls les comptes locaux peuvent se connecter.'),
        h('button', { class: 'btn btn-primary', onclick: () => domainModal(null) }, actionIcon('Ajouter'), 'Ajouter'))));
    return;
  }

  const metric = ([label, value, sub, cls = '']) => h('div', { class: `ec-metric ${cls}` },
    h('span', { class: 'ec-metric-label' }, label),
    h('b', { title: String(value) }, String(value)),
    h('span', { class: 'ec-metric-sub' }, sub));
  const certMetric = () => {
    if (!c.tls) return ['Certificat', '—', 'connexion non chiffrée'];
    if (!c.ca_certificate_id) return ['Autorité', 'Aucune', 'à choisir dans Modifier', 'text warn'];
    if (!c.ca_active) return ['Autorité', c.ca_name, 'désactivée : connexions refusées', 'text warn'];
    const end = new Date(c.ca_not_after);
    const days = Math.ceil((end - Date.now()) / 86400000);
    const until = `${days < 0 ? 'expirée' : 'valide'} jusqu'au ${end.toLocaleDateString('fr-FR')}`;
    return ['Autorité', c.ca_name, until, `text${days <= 30 ? ' warn' : ''}`];
  };
  const adminsMetric = (list) => {
    const count = (kind) => list.filter((a) => a.kind === kind).length;
    const active = list.filter((a) => a.kind !== 'member' && a.enabled).length;
    const members = count('member');
    return ['Administrateurs', active, active
      ? [plural(count('user'), 'utilisateur', 'utilisateurs'), plural(count('group'), 'groupe', 'groupes'),
        ...(members ? [plural(members, 'membre connecté', 'membres connectés')] : [])].join(' · ')
      : 'aucun administrateur', active ? '' : 'warn'];
  };
  const metrics = [
    ['Serveur', c.server, c.bind_dn ? 'liaison authentifiée' : 'liaison anonyme', 'text'],
    ['Sécurité', ldapProtocol(c), c.tls ? `port ${c.ldaps ? 636 : 389}${c.tls_name ? ` · certificat ${c.tls_name}` : ''}` : 'port 389, en clair', c.tls ? '' : 'warn'],
    certMetric(),
  ].map(metric);
  const actions = h('div', { class: 'ldap-actions' },
    h('button', { class: 'btn', onclick: guard(async () => {
      try {
        await api('/ldap/test', { method: 'POST', body: { id: c.id } });
      } finally {
        refreshLdapRing();
      }
    }) }, 'Tester'),
    h('button', { class: 'btn', onclick: () => domainModal(c) }, 'Modifier'),
    h('button', { class: 'btn btn-danger-text', onclick: () => confirmDialog({
      title: 'Supprimer le connecteur LDAP', confirmLabel: 'Supprimer', danger: true, size: 'confirm',
      message: [`Supprimer le connecteur ${c.domain} ?`,
        "Tous les administrateurs associés à ce connecteur seront également supprimés. Les comptes rattachés à ce domaine ne pourront alors plus s'authentifier."],
      onConfirm: guard(async () => {
        await batch('/ldap/configs/batch', 'delete', [c]);
        pageDomain();
      }),
    }) }, 'Supprimer'));
  const fields = [
    ['Domaine', h('strong', {}, c.domain)],
    ['DN de base', c.base_dn],
    ['Utilisateur de liaison', c.bind_dn || '—'],
    ['Mot de passe', c.bind_password_set ? 'Défini' : '—'],
    ['Attribut', c.attribute],
  ];
  const connector = h('div', { class: 'users-table-container ldap-connector' }, h('table', { class: 'users-table' },
    h('thead', {}, h('tr', {}, fields.map(([t]) => h('th', {}, t)))),
    h('tbody', {}, h('tr', {}, fields.map(([, v]) => h('td', {}, v))))));
  let adminTile = null;
  const adminTable = await adminsTable((list) => {
    const tile = metric(adminsMetric(list));
    adminTile?.replaceWith(tile);
    adminTile = tile;
  });
  adminTable.el.classList.add('ldap-admins');
  const others = configs.length - 1;
  body.replaceChildren(h('div', { class: 'section-card engine-card table-card ldap-card' },
    head(c.domain),
    actions,
    h('div', { class: 'ec-metrics engine-metrics ldap-metrics' }, metrics, adminTile),
    others ? h('p', { class: 'hint ldap-warn' }, `${plural(others, 'autre domaine enregistré est ignoré', 'autres domaines enregistrés sont ignorés')} : supprimez-les pour n'en garder qu'un.`) : null,
    connector,
    h('div', { class: 'ldap-section' },
      h('h3', {}, 'Administrateurs du domaine'),
      helpTip(tipLines(['Accès', 'Seuls les comptes, ou membres des groupes, listés ici peuvent se connecter avec le domaine.']))),
    adminTable.el));
}

function domainModal(c) {
  const v = c || {};
  const f = {
    domain: h('input', { type: 'text', value: v.domain || '', required: true, autocomplete: 'off' }),
    server: h('input', { type: 'text', value: v.server || '', required: true, autocomplete: 'off' }),
    bind_dn: h('input', { type: 'text', value: v.bind_dn || '', autocomplete: 'off' }),
    bind_password: h('input', { type: 'password', placeholder: c?.bind_password_set ? '•••••• (inchangé si vide)' : '', autocomplete: 'new-password' }),
    base_dn: h('input', { type: 'text', value: v.base_dn || '', required: true, autocomplete: 'off' }),
    attribute: h('input', { type: 'text', value: v.attribute || '', required: true, autocomplete: 'off' }),
  };
  const tls = checkbox(v.tls);
  const enabled = checkbox(c ? v.enabled : true);
  const starttls = h('input', { type: 'radio', name: 'proto', value: 'starttls', checked: !v.ldaps });
  const ldaps = h('input', { type: 'radio', name: 'proto', value: 'ldaps', checked: !!v.ldaps });
  const ca = caPicker(v.ca_certificate_id || '', { withSystem: false });
  const tlsBox = h('div', {},
    h('div', { class: 'form-row' }, group('Protocole', h('div', { class: 'radio-group' },
      h('label', {}, starttls, ' STARTTLS (389)'), h('label', {}, ldaps, ' LDAPS (636)')), null, true)),
    h('div', { class: 'form-row' }, group('Autorité de certification *', ca,
      tipLines(['Définition', 'Autorité qui a émis le certificat du contrôleur de domaine.'],
        ['Prérequis', 'À importer d’abord dans Sécurité › Certificats (type CA).']))));
  const sync = () => { tlsBox.hidden = !tls.checked; };
  tls.addEventListener('change', sync);
  sync();
  const payload = () => ({
    domain: f.domain.value, server: f.server.value, bind_dn: f.bind_dn.value, bind_password: f.bind_password.value,
    base_dn: f.base_dn.value, attribute: f.attribute.value, tls: tls.checked, ldaps: tls.checked && ldaps.checked,
    enabled: enabled.checked, ca_certificate_id: tls.checked ? ca.value || '' : '',
  });
  let close;
  const form = h('form', { onsubmit: guard(async (e) => {
    e.preventDefault();
    await api(c ? `/ldap/configs/${c.id}` : '/ldap/configs', { method: c ? 'PUT' : 'POST', body: payload() });
    close();
    pageDomain();
  }) },
  h('div', { class: 'form-row' }, group('Domaine *', f.domain, tipLines(['Valeur', 'Nom DNS du domaine, par exemple ', h('code', {}, 'corp.local'), '.'])), group('Serveur LDAP *', f.server, tipLines(['Valeur', 'Adresse IP ou nom DNS du contrôleur de domaine.'],
    ['Port', 'Fixé par le protocole : 389 (sans TLS, STARTTLS) ou 636 (LDAPS). Un port ou un préfixe ldap:// saisi est ignoré.'],
    ['Avec TLS', 'L’adresse saisie doit figurer dans le certificat du serveur (nom DNS ou adresse IP), sinon la connexion est refusée.']))),
  h('div', { class: 'form-row' }, group('Utilisateur de liaison', f.bind_dn, tipLines(['DN complet', 'CN=svc-forge,OU=Services,DC=corp,DC=local'],
    ['Active Directory', 'Aussi compte@domaine (UPN) ou DOMAINE\\compte.'],
    ['Vide', 'Liaison anonyme, si l’annuaire l’autorise.'])), group('Mot de passe', passwordField(f.bind_password))),
  h('div', { class: 'form-row' }, group('DN de base *', f.base_dn, tipLines(['Définition', 'Branche de l’annuaire où chercher les comptes et les groupes.'], ['Format', h('code', {}, 'DC=corp,DC=local'), ' pour le domaine corp.local.'])),
    group('Attribut de recherche *', f.attribute, tipLines(['Définition', 'Attribut comparé à l’identifiant saisi à la connexion.'], ['Active Directory', h('code', {}, 'sAMAccountName'), '.'], ['OpenLDAP', h('code', {}, 'uid'), '.']))),
  h('div', { class: 'form-row' }, group('Connexion sécurisée', toggleSwitch(tls, 'TLS / SSL')), group('Connecteur', toggleSwitch(enabled, 'Activé'))),
  tlsBox,
  h('div', { class: 'form-actions' },
    h('button', { type: 'button', class: 'btn', onclick: guard(async () => {
      await api('/ldap/test', { method: 'POST', body: { ...(c ? { id: c.id } : {}), ...payload() } });
    }) }, 'Tester'),
    h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Annuler'),
    h('button', { type: 'submit', class: 'btn btn-primary' }, c ? 'Enregistrer' : 'Créer')));
  close = openModal(c ? `Connecteur LDAP : ${c.domain}` : 'Connecteur LDAP', form);
}

function deleteAdminsConfirm(sel) {
  const groups = sel.filter((a) => a.kind === 'group').length;
  const accounts = sel.length - groups;
  const words = !accounts ? ['le groupe', 'les groupes'] : groups ? ['l’élément', 'les éléments'] : ['l’administrateur', 'les administrateurs'];
  const lines = [];
  if (accounts) {
    const loss = 'définitivement leurs règles d’accès, leurs clés TOTP et leurs sessions actives.';
    if (groups) lines.push(accounts > 1 ? `Les comptes perdront ${loss}` : `Le compte perdra ${loss.replace(/leurs/g, 'ses')}`);
    else lines.push(accounts > 1
      ? 'Cette action entraînera la suppression définitive de leurs règles d’accès, de leurs clés TOTP et de leurs sessions actives.'
      : 'Cette action entraînera la suppression définitive de ses règles d’accès, de ses clés TOTP et de ses sessions actives.');
    lines.push(`Si ${accounts > 1 ? 'un' : 'le'} compte appartient toujours à un groupe autorisé, il sera automatiquement recréé lors de sa prochaine connexion.`);
  }
  if (groups) {
    lines.push(`Les comptes membres de ${groups > 1 ? 'ces groupes' : 'ce groupe'} ne pourront plus se connecter, sauf s’ils sont autorisés par une autre règle.`,
      'Les sessions ouvertes avec ce domaine seront fermées.');
  }
  return deleteConfirm(sel, words, (a) => a.name, [lines], { quote: false });
}

async function adminsTable(changed) {
  const kindLabel = (a) => (a.kind === 'member' ? a.group || 'Membre d’un groupe' : { user: 'Utilisateur', group: 'Groupe' }[a.kind]);
  const load = async () => { const list = await api('/ldap/admins'); changed(list); return list; };
  let t;
  t = await dataTable({
    key: 'ldap-admins',
    source: localSource(load, (a) => [a.name, kindLabel(a)], {
      name: (a) => a.name, kind: kindLabel, status: (a) => (a.enabled ? 0 : 1), totp: (a) => (a.totp_configured ? 0 : 1),
      last: (a) => (a.kind !== 'group' ? a.last_login : null),
    }),
    search: true,
    empty: 'Aucun administrateur : personne ne peut se connecter avec le domaine.',
    create: { label: 'Ajouter', run: () => adminModal(() => t.reload(true)) },
    columns: [
      ['Compte', (a) => stack(a.name), '24%', 'name'],
      ['DN', (a) => (a.kind !== 'group' ? emptyCell() : a.dn ? h('span', { class: 'cell-mono cell-line', title: a.dn }, a.dn)
        : h('span', { class: 'cell-muted' }, 'fixé à la prochaine connexion')), '24%'],
      ['Type', (a) => oneLine(kindLabel(a)), '8%', 'kind'],
      ['Statut', (a) => activeIcon(a.enabled), '8%', 'status'],
      ['TOTP', (a) => (a.kind === 'group' ? emptyCell()
        : a.totp_configured ? stateBadge('active', 'configuré')
          : h('span', { class: 'cell-muted' }, 'non configuré')), '12%', 'totp'],
      ['TOTP depuis', (a) => (a.kind !== 'group' && a.totp_configured && a.totp_since ? when(a.totp_since) : emptyCell()), '12%'],
      ['Dernière connexion', (a) => (a.kind !== 'group' && a.last_login ? when(a.last_login) : emptyCell()), '12%', 'last:desc'],
    ],
    actions: [
      { label: 'Activer', when: 'many', allow: (a) => (a.kind === 'member' ? 'Accès donné par un groupe' : a.enabled ? 'Déjà activé' : true),
        run: (sel) => batch('/ldap/admins/batch', 'enable', sel) },
      { label: 'Désactiver', when: 'many', allow: (a) => (a.enabled ? true : 'Déjà désactivé'),
        run: (sel) => batch('/ldap/admins/batch', 'disable', sel) },
      { label: 'TOTP', when: 'many', danger: true,
        allow: (a) => (a.kind === 'group' ? 'Un groupe n’a pas de clé TOTP' : true),
        confirm: (sel) => ({
          title: 'Réinitialiser la clé TOTP',
          message: [
            ...(sel.length > 1
              ? [`Réinitialiser la clé TOTP de ces ${sel.length} comptes ?`,
                sel.slice(0, 5).map((a) => a.name).join(', ') + (sel.length > 5 ? ` et ${plural(sel.length - 5, 'autre')}` : '')]
              : [`Réinitialiser la clé TOTP de « ${sel[0].name} » ?`]),
            'La clé actuelle, s’il y en a une, cesse de fonctionner et les sessions ouvertes sont fermées : un nouveau QR code sera proposé à la prochaine connexion, pendant 24 h.',
          ],
          confirmLabel: 'Réinitialiser',
        }),
        run: (sel) => batch('/ldap/admins/batch', 'totp-reset', sel) },
      { label: 'Supprimer', when: 'many', danger: true,
        confirm: deleteAdminsConfirm,
        run: (sel) => batch('/ldap/admins/batch', 'delete', sel) },
    ],
  });
  return t;
}

function adminModal(done) {
  let kind = 'user';
  const inputs = {
    user: h('input', { type: 'text', placeholder: 'Rechercher un utilisateur', autocomplete: 'off' }),
    group: h('input', { type: 'text', placeholder: 'Rechercher un groupe', autocomplete: 'off', hidden: true }),
  };
  const emptyRow = () => h('tr', {}, h('td', { class: 'no-data' }, 'Saisissez une recherche.'));
  const results = h('div', { class: 'users-table-container admin-results' }, h('table', { class: 'users-table' }, h('tbody', {}, emptyRow())));
  const picked = new Set();
  const modeBtns = ['user', 'group'].map((k) => h('button', { type: 'button', class: `tab-btn${k === kind ? ' is-active' : ''}`, onclick: () => {
    kind = k; picked.clear();
    Object.entries(inputs).forEach(([n, i]) => { i.value = ''; i.hidden = n !== k; });
    inputs[k].focus();
    modeBtns.forEach((b, i) => b.classList.toggle('is-active', ['user', 'group'][i] === k));
    results.querySelector('tbody').replaceChildren(emptyRow());
  } }, k === 'user' ? 'Utilisateur' : 'Groupe'));
  const search = guard(async () => {
    const { items } = await api(`/ldap/search?kind=${kind}&q=${encodeURIComponent(inputs[kind].value)}`);
    const tb = results.querySelector('tbody');
    const row = (it) => {
      const dot = h('button', { type: 'button', class: 'row-select', 'aria-label': 'Sélectionner' });
      const tr = h('tr', {}, h('td', { class: 'col-select' }, dot), h('td', {}, it.detail ? stack(it.name, it.detail) : it.name));
      const paint = () => {
        const on = picked.has(it.value);
        tr.classList.toggle('row-selected', on);
        dot.classList.toggle('is-selected', on);
        dot.setAttribute('aria-pressed', String(on));
      };
      tr.addEventListener('click', () => {
        if (picked.has(it.value)) picked.delete(it.value); else picked.add(it.value);
        paint();
      });
      paint();
      return tr;
    };
    tb.replaceChildren(...(items.length ? items.map(row)
      : [h('tr', {}, h('td', { class: 'no-data', colspan: 2 }, 'Aucun résultat.'))]));
  });
  Object.values(inputs).forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }));
  let close;
  const body = h('div', {},
    h('div', { class: 'domain-tabs' }, modeBtns),
    h('div', { class: 'form-row full-row admin-search' }, h('div', { class: 'form-group full' },
      h('div', { class: 'row' }, inputs.user, inputs.group, h('button', { type: 'button', class: 'btn', onclick: search }, 'Rechercher')))),
    results,
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Annuler'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: guard(async () => {
        await api('/ldap/admins', { method: 'POST', body: { kind, names: [...picked] } });
        close();
        done();
      }) }, 'Ajouter')));
  close = openModal('Ajouter des administrateurs du domaine', body);
}
