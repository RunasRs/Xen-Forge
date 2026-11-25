import { modalRoot } from './page.js';
import { crossIcon, h } from './dom.js';
import { plural } from './format.js';
import { ENGINE_CARDS } from './engines.js';
import { helpTip, stateRing } from './display.js';

const MODAL_SIZES = { wide: ' modal-wide', wide3: ' modal-wide modal-wide3', narrow: ' modal-narrow', compact: ' modal-compact', confirm: ' modal-confirm', details: ' modal-details', 'reveal-password': ' modal-reveal-password', 'reveal-product': ' modal-reveal-product', 'reveal-ssh': ' modal-reveal-ssh' };

function modalLayout(body) {
  const last = body.lastElementChild;
  const actions = last?.matches('.form-actions, .confirm-actions') ? last : null;
  const tabsBar = body.firstElementChild?.matches('.domain-tabs') ? body.firstElementChild : null;
  const content = [...body.childNodes].filter((n) => n !== actions && n !== tabsBar);
  body.replaceChildren(...(tabsBar ? [tabsBar] : []), h('div', { class: 'modal-scroll' }, content), ...(actions ? [actions] : []));
  return body;
}

export function openModal(title, body, { size, subtitle, icon, aside, help } = {}) {
  const close = () => { modalRoot.replaceChildren(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const engine = ENGINE_CARDS[document.body.dataset.section];
  const ic = icon || engine?.icon;
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: `modal-content${MODAL_SIZES[size] || ''}${engine ? ` ${document.body.dataset.section}` : ''}` },
      h('div', { class: 'modal-header' },
        ic ? stateRing(ic) : null,
        h('div', { class: 'modal-title' },
          help ? h('div', { class: 'modal-title-line' }, h('h2', {}, title), helpTip(help)) : h('h2', {}, title),
          subtitle ? h('span', {}, subtitle) : null),
        aside || null,
        h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Fermer', onclick: close }, crossIcon())),
      h('div', { class: 'modal-body' }, modalLayout(body))));
  modalRoot.replaceChildren(modal);
  return close;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false, typed, size, onConfirm }) {
  const confirm = () => { close(); onConfirm && onConfirm(); };
  const okBtn = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', disabled: !!typed, onclick: confirm }, confirmLabel);
  const input = typed ? h('input', { type: 'text', class: 'confirm-input', autocomplete: 'off', spellcheck: 'false', placeholder: typed }) : null;
  input?.addEventListener('input', () => { okBtn.disabled = input.value.trim() !== typed; });
  const refuse = (e) => e.preventDefault();
  input?.addEventListener('paste', refuse);
  input?.addEventListener('drop', refuse);
  input?.addEventListener('beforeinput', (e) => {
    if (/^insertFrom(Paste|Drop|Yank)|^insertReplacementText$/.test(e.inputType)) refuse(e);
  });
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !okBtn.disabled) confirm(); });
  const close = openModal(title, h('div', { class: 'confirm-dialog' },
    [].concat(message).map((m) => h('p', {}, Array.isArray(m) ? m.flatMap((line, i) => (i ? [h('br'), line] : line)) : m)),
    typed && h('label', { class: 'confirm-typed' }, 'Saisissez le texte suivant pour confirmer : ', h('code', {}, typed), input),
    h('div', { class: 'row confirm-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, cancelLabel),
      okBtn)), { size });
  input?.focus();
}

export function deleteConfirm(sel, [one, many], name, note = [], { quote = true } = {}) {
  const names = sel.slice(0, 5).map((x) => (quote ? `« ${name(x)} »` : name(x))).join(', ');
  const more = sel.length > 5 ? ` et ${plural(sel.length - 5, 'autre')}` : '';
  return {
    title: `Supprimer ${sel.length > 1 ? many : one}`,
    message: [`Supprimer ${sel.length > 1 ? many : one} ${names}${more} ?`, ...[].concat(note)],
    confirmLabel: 'Supprimer',
    danger: true,
    size: 'confirm',
  };
}
