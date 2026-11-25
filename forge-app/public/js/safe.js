import { app, view } from './page.js';
import { h, ICONS } from './dom.js';
import { countLabel } from './format.js';
import { api, batch, batchToast, guard, pagedSource } from './api.js';
import { activeIcon, stack, tipLines, usedByCell, usersText, when } from './display.js';
import { dataTable, groupFilters } from './table.js';
import { deleteConfirm, openModal } from './modal.js';
import { group, passwordField } from './forms.js';
import { copySecret, copyText } from './clipboard.js';

const REVEAL_DURATION_MS = 60000;

export async function pageSafe(gen = view.pageGen) {
  const typeLabel = { password: 'Mot de passe', ssh_key: 'Clé SSH', product_key: 'Clé de produit' };

  const safeModal = (entry) => {
    const name = h('input', { type: 'text', value: entry?.name || '', required: true, maxlength: 100 });
    const typeSel = h('select', { disabled: !!entry },
      h('option', { value: 'password', selected: !entry || entry.type === 'password' }, 'Mot de passe'),
      h('option', { value: 'ssh_key', selected: entry?.type === 'ssh_key' }, 'Clé SSH'),
      h('option', { value: 'product_key', selected: entry?.type === 'product_key' }, 'Clé de produit'));
    const username = h('input', { type: 'text', value: entry?.username || '', maxlength: 100, required: true });
    const password = h('input', { type: 'password', autocomplete: 'new-password',
      ...(entry ? { placeholder: 'Laisser vide pour conserver' } : {}) });
    const publicKey = h('textarea', { rows: 4, spellcheck: 'false', value: entry?.public_key || '' });
    const privateKey = h('textarea', { rows: 6, spellcheck: 'false',
      ...(entry ? { placeholder: 'Laisser vide pour conserver la clé privée' } : {}) });
    const productKey = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false',
      ...(entry ? { placeholder: 'Laisser vide pour conserver' } : {}) });
    const genBtn = h('button', { type: 'button', class: 'btn',
      onclick: guard(async () => {
        const d = await api('/safe/generate', { method: 'POST', body: {} });
        publicKey.value = d.publicKey;
        privateKey.value = d.privateKey;
      }) }, 'Générer une paire de clés RSA');

    const secretStar = entry ? '' : ' *';
    const userGroup = group('Identifiant *', username);
    const pwdGroup = group(`Mot de passe${secretStar}`, passwordField(password));
    const accountField = h('div', { class: 'form-row' }, userGroup, pwdGroup);
    const sshFields = h('div', {},
      h('div', { class: 'form-row' }, group('Auto-génération', genBtn, null, true)),
      h('div', { class: 'form-row' }, group('Clé publique *', publicKey, tipLines(['Format', 'Une ligne au format OpenSSH : type, clé, commentaire facultatif.']), true)),
      h('div', { class: 'form-row' }, group(`Clé privée${secretStar}`, privateKey, tipLines(['Format', 'Bloc PEM ou OpenSSH complet, lignes BEGIN et END comprises.']), true)));
    const keyFields = h('div', {},
      h('div', { class: 'form-row' }, group(`Clé de produit${secretStar}`, productKey, tipLines(['Format', '25 caractères en 5 groupes séparés par des tirets.']))));
    const toggleType = () => {
      accountField.hidden = typeSel.value === 'product_key';
      pwdGroup.hidden = typeSel.value !== 'password';
      sshFields.hidden = typeSel.value !== 'ssh_key';
      keyFields.hidden = typeSel.value !== 'product_key';
      username.required = typeSel.value !== 'product_key';
    };
    typeSel.addEventListener('change', toggleType);
    toggleType();

    let close;
    const form = h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      let body;
      if (typeSel.value === 'password') {
        body = { name: name.value.trim(), type: 'password', username: username.value.trim(), secret: password.value };
      } else if (typeSel.value === 'product_key') {
        body = { name: name.value.trim(), type: 'product_key', secret: productKey.value.trim() };
        if (entry && !body.secret) delete body.secret;
      } else {
        body = { name: name.value.trim(), type: 'ssh_key', username: username.value.trim(), publicKey: publicKey.value.trim(), secret: privateKey.value };
        if (entry && !body.secret) delete body.secret;
      }
      if (entry) await api(`/safe/${entry.id}`, { method: 'PUT', body });
      else await api('/safe', { method: 'POST', body });
      close();
      pageSafe();
    }) },
    h('div', { class: 'form-row' }, group('Nom *', name), group('Type *', typeSel)),
    accountField, sshFields, keyFields,
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Annuler'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, entry ? 'Enregistrer' : 'Créer')));
    close = openModal(entry ? `Entrée : ${entry.name}` : 'Nouvelle entrée du coffre-fort', form);
  };

  const revealModal = guard(async (entry) => {
    const d = await api(`/safe/${entry.id}/reveal`, { method: 'POST', body: {} });
    const copy = (label, value) => h('button', { class: 'btn',
      onclick: guard(() => copyText(value)) },
      `Copier ${label.toLowerCase()}`);
    const copyHidden = (label, value) => h('button', { class: 'btn',
      onclick: guard(() => copySecret(value)) },
      `Copier ${label.toLowerCase()}`);
    const pre = (v, kind = '') => h('pre', { class: `log${kind ? ` reveal-${kind}` : ''}` }, v);
    const keyRows = [h('div', { class: 'form-row' }, group('Clé de produit', pre(d.secret, 'password'), '', true)),
      h('div', { class: 'form-actions' }, copyHidden('Clé de produit', d.secret))];
    const rows = d.type === 'product_key' ? keyRows : d.type === 'password'
      ? [h('div', { class: 'form-row' }, group('Identifiant', h('code', {}, d.username || '—'), '', true)),
         h('div', { class: 'form-row' }, group('Mot de passe', pre(d.secret, 'password'), '', true)),
         h('div', { class: 'form-actions' }, copyHidden('Mot de passe', d.secret))]
      : [h('div', { class: 'form-row' }, group('Identifiant', h('code', {}, d.username || '—'), '', true)),
         h('div', { class: 'form-row' }, group('Clé publique', pre(d.publicKey, 'key'), '', true)),
         h('div', { class: 'form-row' }, group('Clé privée', pre(d.secret, 'key'), '', true)),
         h('div', { class: 'form-actions' }, copy('Clé publique', d.publicKey), copyHidden('Clé privée', d.secret))];
    const content = h('div', { class: 'form-section' }, ...rows);
    const size = { password: 'reveal-password', product_key: 'reveal-product', ssh_key: 'reveal-ssh' }[d.type];
    const close = openModal(`Secret : ${d.name}`, content, { size });
    setTimeout(() => { if (content.isConnected) close(); }, REVEAL_DURATION_MS);
  });

  const t = await dataTable({
    key: 'safe',
    source: pagedSource('/safe'),
    filters: groupFilters([['password', 'Mots de passe'], ['product_key', 'Clés de produit'], ['ssh_key', 'Clés SSH']]),
    card: {
      icon: ICONS.lock, title: 'Coffre-fort',
      subtitle: (d, st) => `${countLabel(st, d.total || 0, 'entrée', 'entrées')}`,
    },
    search: true,
    empty: 'Le coffre-fort est vide : ajoutez un mot de passe, une clé SSH ou une clé de produit pour vos profils.',
    create: { label: 'Ajouter', run: () => safeModal(null) },
    columns: [
      ['Entrée', (e) => stack(e.name), '25%', 'name'],
      ['Identifiant', (e) => (e.username ? h('span', { class: 'cell-line', title: e.username }, e.username) : h('span', { class: 'cell-muted' }, '—')), '25%', 'username'],
      ['Type', (e) => typeLabel[e.type] || e.type, '14%', 'type'],
      ['Utilisée par', (e) => usedByCell(e.used_by), '14%', 'used:desc'],
      ['Statut', (e) => activeIcon(e.is_active), '11%', 'active:desc'],
      ['Modifiée', (e) => when(e.updated_at), '11%', 'updated:desc'],
    ],
    actions: [
      { label: 'Modifier', when: 'one', reload: false, run: ([e]) => safeModal(e) },
      { label: 'Révéler', when: 'one', reload: false, run: ([e]) => revealModal(e) },
      { label: 'Activer', when: 'many', allow: (e) => (e.is_active ? 'Entrée déjà active' : true),
        run: (sel) => batch('/safe/batch', 'enable', sel) },
      { label: 'Désactiver', when: 'many', allow: (e) => (e.is_active ? true : 'Entrée déjà désactivée'),
        confirm: (sel) => {
          const used = sel.filter((e) => e.used_by?.length);
          return used.length ? {
            title: 'Désactiver une entrée utilisée',
            message: [...used.map((e) => `« ${e.name} » est utilisée par ${usersText(e.used_by)}.`),
              'Leurs jobs échoueront tant que l’entrée reste désactivée.'],
          } : null;
        },
        run: (sel) => api('/safe/batch', { method: 'POST', body: { action: 'disable', ids: sel.map((e) => e.id), confirm: true } }).then(batchToast) },
      { label: 'Supprimer', when: 'many', danger: true,
        allow: (e) => (e.used_by?.length ? `« ${e.name} » est utilisée par ${usersText(e.used_by)}` : true),
        confirm: (sel) => deleteConfirm(sel, ["l'entrée", 'les entrées'], (e) => e.name),
        run: (sel) => batch('/safe/batch', 'delete', sel) },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}
