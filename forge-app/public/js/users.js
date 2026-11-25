import { app, view } from './page.js';
import { h, ICONS } from './dom.js';
import { countLabel, plural } from './format.js';
import { api, batch, guard, pagedSource } from './api.js';
import { activeIcon, stack, stateBadge, tipLines, when } from './display.js';
import { dataTable } from './table.js';
import { deleteConfirm, openModal } from './modal.js';
import { checkbox, group, passwordField, toggleSwitch } from './forms.js';
import { policySummary } from './password-policy.js';

export async function pageUsers(gen = view.pageGen) {
  const passwordHint = (policy) => tipLines(['Format', policySummary(policy)], ['Politique', 'Paramètres › Sécurité.']);
  const userModal = async (entry) => {
    const policy = entry ? null : await api('/auth/password-policy');
    const username = h('input', { type: 'text', value: entry?.username || '', required: !entry, maxlength: 64, disabled: Boolean(entry) });
    const password = !entry && h('input', { type: 'password', autocomplete: 'new-password', required: true, maxlength: 256 });
    const mustChange = checkbox(entry ? entry.must_change_password : true);
    let close;
    const form = h('form', { class: 'form-compact', onsubmit: guard(async (e) => {
      e.preventDefault();
      const body = {};
      if (!entry) body.username = username.value.trim();
      if (password) body.password = password.value;
      body.must_change_password = mustChange.checked;
      if (entry) await api(`/users/${entry.id}`, { method: 'PUT', body });
      else await api('/users', { method: 'POST', body });
      close();
      pageUsers();
    }) },
    h('div', { class: 'form-row' }, group('Identifiant', username, '', true)),
    password && h('div', { class: 'form-row' }, group('Mot de passe', passwordField(password), passwordHint(policy), true)),
    h('div', { class: 'form-row' }, group('Prochaine connexion', toggleSwitch(mustChange, 'Changer le mot de passe'), '', true)),
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Annuler'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, entry ? 'Enregistrer' : 'Créer')));
    close = openModal(entry ? `Administrateur : ${entry.username}` : 'Nouvel administrateur', form, { size: 'compact' });
  };

  const resetModal = async (entry) => {
    const policy = await api('/auth/password-policy');
    const self = entry.username === view.currentUser;
    const oldPassword = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const newPassword = h('input', { type: 'password', autocomplete: 'new-password', required: true, maxlength: 256 });
    const confirmation = h('input', { type: 'password', autocomplete: 'new-password', required: true, maxlength: 256 });
    let close;
    const form = h('form', { class: 'form-compact', onsubmit: guard(async (e) => {
      e.preventDefault();
      if (newPassword.value !== confirmation.value) throw new Error('La confirmation ne correspond pas au nouveau mot de passe');
      await api(`/users/${entry.id}/reset-password`, { method: 'POST',
        body: { oldPassword: oldPassword.value, newPassword: newPassword.value, confirmPassword: confirmation.value } });
      close();
      pageUsers();
    }) },
    h('div', { class: 'form-row' }, self
      ? group('Ancien mot de passe', passwordField(oldPassword), '', true)
      : group('Votre mot de passe', passwordField(oldPassword), tipLines(['Définition', `Le vôtre, pas celui de « ${entry.username} ».`], ['Ensuite', `« ${entry.username} » devra le changer à sa prochaine connexion.`]), true)),
    h('div', { class: 'form-row' }, group('Nouveau mot de passe', passwordField(newPassword), passwordHint(policy), true)),
    h('div', { class: 'form-row' }, group('Confirmer le nouveau mot de passe', passwordField(confirmation), '', true)),
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Annuler'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Réinitialiser')));
    close = openModal(`Réinitialiser : ${entry.username}`, form, { size: 'compact' });
    oldPassword.focus();
  };

  const notSelf = (e) => (e.username === view.currentUser ? 'Impossible sur votre propre compte' : true);
  const t = await dataTable({
    key: 'users',
    source: pagedSource('/users'),
    card: {
      icon: ICONS.user, title: 'Administrateurs',
      subtitle: (d, st) => `Comptes de connexion · ${countLabel(st, d.total || 0, 'administrateur', 'administrateurs')}`,
    },
    search: true,
    empty: 'Aucun administrateur local.',
    create: { label: 'Ajouter', run: guard(() => userModal(null)) },
    columns: [
      ['Administrateur', (e) => h('span', { title: e.username === view.currentUser ? 'Votre compte' : null }, stack(e.username)), '39%', 'username'],
      ['Statut', (e) => activeIcon(e.is_active), '8%', 'active:desc'],
      ['Mot de passe', (e) => (e.must_change_password ? stateBadge('warn', 'à changer') : h('span', { class: 'cell-muted' }, '—')), '14%', 'password:desc'],
      ['TOTP', (e) => (e.totp_configured ? stateBadge('active', 'configuré') : h('span', { class: 'cell-muted' }, '—')), '14%', 'totp:desc'],
      ['TOTP depuis', (e) => (e.totp_configured && e.totp_since ? when(e.totp_since) : h('span', { class: 'cell-muted' }, '—')), '14%'],
      ['Créé', (e) => when(e.created_at), '11%', 'created:desc'],
    ],
    actions: [
      { label: 'Modifier', when: 'one', reload: false, run: ([e]) => userModal(e) },
      { label: 'Réinitialiser le mot de passe', when: 'one', reload: false, run: ([e]) => resetModal(e) },
      { label: 'Activer', when: 'many', allow: (e) => (e.is_active ? 'Compte déjà actif' : true),
        run: (sel) => batch('/users/batch', 'enable', sel) },
      { label: 'Désactiver', when: 'many', allow: (e) => (e.is_active ? notSelf(e) : 'Compte déjà désactivé'),
        run: (sel) => batch('/users/batch', 'disable', sel) },
      { label: 'TOTP', when: 'many', danger: true, allow: (e) => (e.is_active ? true : 'Compte désactivé'),
        confirm: (sel) => ({
          title: 'Réinitialiser la clé TOTP',
          message: [
            ...(sel.length > 1
              ? [`Réinitialiser la clé TOTP de ces ${sel.length} administrateurs ?`,
                sel.slice(0, 5).map((e) => e.username).join(', ') + (sel.length > 5 ? ` et ${plural(sel.length - 5, 'autre')}` : '')]
              : [`Réinitialiser la clé TOTP de « ${sel[0].username} » ?`]),
            'La clé actuelle, s’il y en a une, cesse de fonctionner et les sessions ouvertes sont fermées : un nouveau QR code sera proposé à la prochaine connexion, pendant 24 h.',
          ],
          confirmLabel: 'Réinitialiser',
        }),
        run: (sel) => batch('/users/batch', 'totp-reset', sel) },
      { label: 'Supprimer', when: 'many', danger: true, allow: notSelf,
        confirm: (sel) => deleteConfirm(sel, ['l’administrateur', 'les administrateurs'], (e) => e.username, [], { quote: false }),
        run: (sel) => batch('/users/batch', 'delete', sel) },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}
