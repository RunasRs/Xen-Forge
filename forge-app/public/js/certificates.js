import { app, view } from './page.js';
import { h, ICONS, toast } from './dom.js';
import { countLabel } from './format.js';
import { api, batch, batchToast, guard, pagedSource } from './api.js';
import { activeIcon, stack, stateBadge, tipLines, usedByCell, usersText, when } from './display.js';
import { dataTable, groupFilters } from './table.js';
import { deleteConfirm, openModal } from './modal.js';
import { filePicker, group, passwordField } from './forms.js';
import { optionPicker } from './pickers.js';

const TYPE_LABELS = { cert_key: 'X.509', pkcs12: 'PKCS12', ca: 'CA' };
const CERT_ACCEPT = '.crt,.cer,.pem,.der';
const KEY_ACCEPT = '.key,.pem,.der';
const P12_ACCEPT = '.p12,.pfx';
const MAX_CERT_BYTES = 32 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_PKCS12_BYTES = 48 * 1024;

export const SYSTEM_CA = 'Autorités du système';

const SYSTEM_OPTION = { name: SYSTEM_CA, meta: 'magasin du conteneur' };

export function caPicker(current = '', { withSystem = true, empty = withSystem ? SYSTEM_OPTION : null } = {}) {
  const picker = optionPicker(null, current, { placeholder: empty?.name || 'Sélectionner...', missing: 'Autorité introuvable' });
  const system = empty ? [{ value: '', ...empty }] : [];
  api('/certificates?all').then((rows) => picker.setOptions([...system, ...rows
    .filter((c) => c.type === 'ca' && (c.is_active || c.id === current))
    .map((c) => ({ value: c.id, name: c.name,
      meta: [!c.is_active && 'désactivé', c.not_after && new Date(c.not_after) < new Date() && 'expiré'].filter(Boolean).join(', ') }))], current))
    .catch((e) => { picker.setOptions(system, ''); toast(`Certificats indisponibles : ${e.message}`); });
  return picker;
}

const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('fr-FR') : '—');
const commonName = (dn) => /(?:^|, )CN=([^,]+)/.exec(dn || '')?.[1] || dn || '—';
const expired = (d) => d && new Date(d) < new Date();
const disableNotes = (used) => {
  const users = used.flatMap((e) => e.used_by);
  const connectors = users.filter((u) => u.engine === 'connector');
  return [
    users.length > connectors.length && 'Les jobs des profils concernés échoueront tant que le certificat reste désactivé.',
    connectors.length && 'Les connecteurs concernés refuseront de se connecter tant que le certificat reste désactivé.',
    connectors.some((u) => u.name.startsWith('LDAP ')) && 'Les comptes du domaine ne pourront plus se connecter à Forge : garder un administrateur local.',
  ].filter(Boolean);
};
const sendBatch = (action, sel) => api('/certificates/batch', { method: 'POST', body: { action, ids: sel.map((r) => r.id), confirm: true } }).then(batchToast);

function expiryCell(e) {
  if (!e.not_after) return h('span', { class: 'cell-muted' }, '—');
  return expired(e.not_after) ? stateBadge('failed', 'Expiré', `Expiré le ${fmtDay(e.not_after)}`) : fmtDay(e.not_after);
}

function certificateModal(entry) {
  const stored = (label) => (entry ? `${label} enregistré` : null);
  const name = h('input', { type: 'text', value: entry?.name || '', required: true, maxlength: 100 });
  const typeSel = h('select', { disabled: !!entry },
    Object.entries(TYPE_LABELS).map(([v, label]) => h('option', { value: v, selected: (entry?.type || 'cert_key') === v }, label)));
  const certFile = filePicker({ accept: CERT_ACCEPT, maxBytes: MAX_CERT_BYTES, stored: stored('Certificat'),
    emptyLabel: 'Aucun certificat', removeTitle: 'Retirer le certificat' });
  const keyFile = filePicker({ accept: KEY_ACCEPT, maxBytes: MAX_KEY_BYTES, stored: entry ? 'Clé privée enregistrée' : null,
    emptyLabel: 'Aucune clé privée', removeTitle: 'Retirer la clé privée' });
  const p12File = filePicker({ accept: P12_ACCEPT, maxBytes: MAX_PKCS12_BYTES, stored: stored('PKCS12'),
    emptyLabel: 'Aucun PKCS12', removeTitle: 'Retirer le PKCS12' });
  const caFile = filePicker({ accept: CERT_ACCEPT, maxBytes: MAX_CERT_BYTES, stored: stored('Certificat CA'),
    emptyLabel: 'Aucun certificat CA', removeTitle: 'Retirer le certificat CA' });
  const keyPassword = h('input', { type: 'password', autocomplete: 'new-password' });
  const password = h('input', { type: 'password', autocomplete: 'new-password' });
  const star = entry ? '' : ' *';
  const sections = {
    cert_key: h('div', {},
      h('div', { class: 'form-row' }, group(`Certificat ou chaîne${star}`, certFile.el, tipLines(['Format', 'PEM ou DER.'], ['Chaîne', 'Dans l’ordre : serveur, intermédiaires, racine.']), true)),
      h('div', { class: 'form-row' }, group(`Clé privée${star}`, keyFile.el, tipLines(['Format', 'PEM ou DER.']), true)),
      h('div', { class: 'form-row' }, group('Mot de passe de la clé privée', passwordField(keyPassword),
        tipLines(['Vide', 'Clé sans mot de passe.'], ['Utilisation', 'Sert seulement à déchiffrer la clé à l’import.'],
          ['Conservation', 'Forge enregistre la clé déchiffrée puis chiffrée, sans garder ce mot de passe.'])))),
    pkcs12: h('div', {},
      h('div', { class: 'form-row' }, group(`PKCS12${star}`, p12File.el, tipLines(['Format', 'Fichier .p12 ou .pfx contenant la clé privée.']), true)),
      h('div', { class: 'form-row' }, group('Mot de passe du PKCS12', passwordField(password), tipLines(['Vide', entry ? 'Mot de passe enregistré conservé.' : 'PKCS12 sans mot de passe.'])))),
    ca: h('div', {},
      h('div', { class: 'form-row' }, group(`Certificat CA${star}`, caFile.el, tipLines(['Format', 'Un seul certificat d’autorité, PEM ou DER.']), true))),
  };
  const toggleType = () => Object.entries(sections).forEach(([t, el]) => { el.hidden = typeSel.value !== t; });
  typeSel.addEventListener('change', toggleType);
  toggleType();

  const required = { cert_key: [[certFile, 'Certificat'], [keyFile, 'Clé privée']], pkcs12: [[p12File, 'PKCS12']], ca: [[caFile, 'Certificat CA']] };
  const files = { cert_key: { certificate: certFile, key: keyFile }, pkcs12: { pkcs12: p12File }, ca: { certificate: caFile } };
  let close;
  const form = h('form', { onsubmit: guard(async (e) => {
    e.preventDefault();
    const type = typeSel.value;
    const missing = required[type].find(([picker]) => picker.empty());
    if (missing) {
      toast(`${missing[1]} obligatoire`);
      return;
    }
    const body = { name: name.value.trim(), ...(entry ? {} : { type }) };
    Object.entries(files[type]).forEach(([key, picker]) => {
      const v = picker.value();
      if (v !== undefined) body[key] = v;
    });
    if (type === 'pkcs12' && (password.value || !entry)) body.password = password.value;
    if (type === 'cert_key' && keyFile.value() && keyPassword.value) body.key_password = keyPassword.value;
    if (entry) await api(`/certificates/${entry.id}`, { method: 'PUT', body });
    else await api('/certificates', { method: 'POST', body });
    close();
    pageCertificates();
  }) },
  h('div', { class: 'form-row' }, group('Nom *', name), group('Type *', typeSel)),
  ...Object.values(sections),
  h('div', { class: 'form-actions' },
    h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Annuler'),
    h('button', { type: 'submit', class: 'btn btn-primary' }, entry ? 'Enregistrer' : 'Créer')));
  close = openModal(entry ? `Certificat : ${entry.name}` : 'Nouveau certificat', form);
}

const detailsModal = guard(async (entry) => {
  const d = await api(`/certificates/${entry.id}`);
  const line = (label, value) => h('div', { class: 'form-row' }, group(label, h('code', { class: 'cert-value' }, value || '—'), null, true));
  const blocks = d.chain.map((c, i) => h('div', { class: 'form-section' },
    h('h3', {}, d.chain.length > 1 ? `${i === 0 && d.type !== 'ca' ? 'Certificat' : 'Autorité'} ${i + 1} / ${d.chain.length}` : 'Certificat'),
    line('Sujet', c.subject),
    line('Émetteur', c.issuer),
    line('Validité', `du ${fmtDay(c.valid_from)} au ${fmtDay(c.valid_to)}${expired(c.valid_to) ? ' (expiré)' : ''}`),
    c.san ? line('Noms alternatifs', c.san.replaceAll('IP Address:', 'IP:')) : null,
    line('Autorité (CA)', c.ca ? 'oui' : 'non'),
    line('Numéro de série', c.serial),
    line('Empreinte SHA-256', c.fingerprint256)));
  const content = h('div', {},
    line('Type', TYPE_LABELS[d.type]),
    ...blocks);
  openModal(`Certificat : ${d.name}`, content, { size: 'details' });
});

export async function pageCertificates(gen = view.pageGen) {
  const t = await dataTable({
    key: 'certificates',
    source: pagedSource('/certificates'),
    filters: groupFilters([['valid', 'Valides', 'success'], ['expired', 'Expirés', 'failed']]),
    card: {
      icon: ICONS.certificate, title: 'Certificats',
      subtitle: (d, st) => countLabel(st, d.total || 0, 'certificat', 'certificats'),
    },
    search: true,
    empty: 'Aucun certificat : ajoutez un certificat avec sa clé, un PKCS12 ou une autorité de certification.',
    create: { label: 'Ajouter', run: () => certificateModal(null) },
    columns: [
      ['Certificat', (e) => stack(e.name), '22%', 'name'],
      ['Type', (e) => TYPE_LABELS[e.type] || e.type, '11%', 'type'],
      ['Sujet', (e) => h('span', { class: 'cell-line', title: e.subject }, commonName(e.subject)), '22%'],
      ['Expiration', expiryCell, '12%', 'expires'],
      ['Utilisé par', (e) => usedByCell(e.used_by), '11%', 'used:desc'],
      ['Statut', (e) => activeIcon(e.is_active), '11%', 'active:desc'],
      ['Modifié', (e) => when(e.updated_at), '11%', 'updated:desc'],
    ],
    actions: [
      { label: 'Modifier', when: 'one', reload: false, run: ([e]) => certificateModal(e) },
      { label: 'Détails', when: 'one', reload: false, run: ([e]) => detailsModal(e) },
      { label: 'Activer', when: 'many', allow: (e) => (e.is_active ? 'Certificat déjà actif' : true),
        run: (sel) => batch('/certificates/batch', 'enable', sel) },
      { label: 'Désactiver', when: 'many', allow: (e) => (e.is_active ? true : 'Certificat déjà désactivé'),
        confirm: (sel) => {
          const used = sel.filter((e) => e.used_by?.length);
          return used.length ? {
            title: 'Désactiver un certificat utilisé',
            message: [...used.map((e) => `« ${e.name} » est utilisé par ${usersText(e.used_by)}.`), ...disableNotes(used)],
          } : null;
        },
        run: (sel) => sendBatch('disable', sel) },
      { label: 'Supprimer', when: 'many', danger: true,
        allow: (e) => (e.used_by?.length ? `« ${e.name} » est utilisé par ${usersText(e.used_by)}` : true),
        confirm: (sel) => deleteConfirm(sel, ['le certificat', 'les certificats'], (e) => e.name,
          'Le certificat, sa clé privée et son mot de passe sont effacés.'),
        run: (sel) => sendBatch('delete', sel) },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}
