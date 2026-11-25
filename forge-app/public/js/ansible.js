import { app, view } from './page.js';
import { actionIcon, h, ICONS, svgIcon, toast } from './dom.js';
import { plural } from './format.js';
import { api, batch, guard, localSource, pagedSource, SessionExpired } from './api.js';
import { ENGINE_CARDS } from './engines.js';
import { emptyCell, oneLine, stack, stateBadge, tipLines, when } from './display.js';
import { dataTable, groupFilters } from './table.js';
import { confirmDialog, deleteConfirm, openModal } from './modal.js';
import { checkbox, formActions, formTabs, group, row, section, toggleSwitch } from './forms.js';
import { choiceChips, optionPicker, scrollSelect } from './pickers.js';
import { lineMarker, yamlEditor } from './yaml-editor.js';
import { isAccountEntry, safeEntryOption } from './safe-entries.js';
import { caPicker } from './certificates.js';
import { cloneProfile, lastJobCell, profileIdle, profilesCard } from './distributions.js';
import { activityRing, launchMany } from './jobs.js';

const OS_LABELS = { linux: 'Linux', windows: 'Windows' };
const TYPE_LABELS = { guided: 'étapes guidées', yaml: 'playbook YAML' };
const CONNECTION_LABELS = { ssh: 'SSH', winrms: 'WinRM HTTPS' };
const DEFAULT_PORTS = { ssh: 22, winrms: 5986 };
const MAX_TARGETS = 50;
const MAX_STEPS = 50;
const CHIP_CHOICES_MAX = 6;

const PLAYBOOK_EXAMPLE = `- name: Configuration des serveurs
  hosts: all
  become: true
  tasks:
    - name: Paquets de base
      ansible.builtin.package:
        name:
          - curl
          - htop
        state: present`;

const BRICK_EXAMPLE = `name: Ma brique
os: linux
description: Ce que fait la brique, en une phrase
parameters:
  paquet:
    label: Paquet à installer
    help: Nom du paquet dans le dépôt de la distribution
    type: str
    required: true
tasks:
  - name: Installation du paquet
    ansible.builtin.package:
      name: "{{ paquet }}"
      state: present`;

const BRICK_EXAMPLE_WINDOWS = `name: Ma brique
os: windows
description: Ce que fait la brique, en une phrase
parameters:
  fonctionnalite:
    label: Fonctionnalité Windows
    help: Nom donné par Get-WindowsFeature, par exemple Web-Server
    type: str
    required: true
tasks:
  - name: Installation de la fonctionnalité
    ansible.windows.win_feature:
      name: "{{ fonctionnalite }}"
      state: present`;

const BRICK_EXAMPLES = { linux: BRICK_EXAMPLE, windows: BRICK_EXAMPLE_WINDOWS };

const text = (value, attrs = {}) => h('input', { type: 'text', value: value ?? '', ...attrs });
const select = (pairs, selected, { disabled = false } = {}) => {
  const el = scrollSelect(pairs.map(([val, label]) => [String(val), label]), String(selected ?? ''));
  el.querySelector('.picker-trigger').disabled = disabled;
  return el;
};
const iconButton = (title, d, onclick, extra = '') => h('button', { type: 'button', class: `btn-icon${extra}`, title, 'aria-label': title, onclick }, svgIcon(d));

const loadSafe = () => api('/safe').then((rows) => rows.filter((e) => e.is_active && isAccountEntry(e)));
const loadCatalogue = () => api('/ansible/catalogue');
const loadCertificates = () => api('/certificates?all=1').then((rows) => rows.filter((e) => e.is_active));
const CERT_LABELS = { cert_key: 'certificat + clé', pkcs12: 'PKCS12', ca: 'autorité' };

function certificatePicker(certs, selected, { none = null, types }) {
  const options = certs.filter((c) => types.includes(c.type)).map((c) => {
    const end = c.not_after ? new Date(c.not_after) : null;
    const expiry = end ? `${end < new Date() ? 'expiré le' : 'jusqu’au'} ${end.toLocaleDateString('fr-FR')}` : '';
    return { value: c.id, name: c.name, meta: [CERT_LABELS[c.type], expiry].filter(Boolean).join(', ') };
  });
  return optionPicker([...(none ? [{ value: '', name: none }] : []), ...options], selected || '',
    { placeholder: options.length ? 'Sélectionner un certificat' : 'Aucun certificat actif de ce type (menu Certificats)',
      missing: 'Certificat supprimé, désactivé ou d’un autre type' });
}

function safePicker(entries, selected, { none = null, passwordOnly = false } = {}) {
  const options = entries.filter((e) => !passwordOnly || e.type === 'password')
    .map(safeEntryOption);
  return optionPicker([...(none ? [{ value: '', name: none }] : []), ...options], selected || '',
    { placeholder: 'Sélectionner une entrée', missing: 'Entrée supprimée ou inutilisable' });
}

function itemList({ items, make, addLabel, max, onAdd, onChange = () => {} }) {
  const entries = [];
  const list = h('div', { class: 'ansible-items' });
  const addBtn = h('button', { type: 'button', class: 'btn', onclick: () => (onAdd ? onAdd() : add({})) }, addLabel);
  const refresh = () => {
    addBtn.disabled = entries.length >= max;
    entries.forEach((e, i) => e.refresh(i, entries.length));
    onChange();
  };
  const move = (entry, delta) => {
    const i = entries.indexOf(entry);
    const j = i + delta;
    if (j < 0 || j >= entries.length) return;
    entries.splice(i, 1);
    entries.splice(j, 0, entry);
    list.replaceChildren(...entries.map((e) => e.el));
    refresh();
  };
  const remove = (entry) => {
    entries.splice(entries.indexOf(entry), 1);
    entry.el.remove();
    refresh();
  };
  function add(item) {
    const entry = make(item, { move: (d) => move(entry, d), remove: () => remove(entry) });
    entries.push(entry);
    list.append(entry.el);
    refresh();
  }
  items.forEach(add);
  refresh();
  return { list, addBtn, add, values: () => entries.map((e) => e.value()), size: () => entries.length };
}

function targetItem({ os, vms, safe, takenVms }) {
  return (t, { remove }) => {
    const source = select([['forge', 'VM déployée par Forge'], ['manual', 'Saisie manuelle (IP ou nom)']], t.source || 'forge');
    const osVms = vms.filter((v) => v.os_type === os && (v.deployed || v.id === t.tofu_profile_id));
    const vmSelect = optionPicker(osVms.map((v) => ({ value: v.id, name: v.vm_name,
      meta: `${v.deployed ? v.ipv4 || 'IP inconnue' : 'non déployée'} · profil ${v.profile}` })), t.tofu_profile_id,
    { placeholder: osVms.length ? 'Sélectionner une VM' : `Aucune VM ${OS_LABELS[os]} déployée par OpenTofu`, missing: 'Profil OpenTofu introuvable',
      hidden: (id) => id !== vmSelect.value && takenVms().includes(id) });
    const nameInput = text(t.name, { maxlength: 63 });
    const addressInput = text(t.address, { maxlength: 253 });
    const connections = os === 'windows' ? ['ssh', 'winrms'] : ['ssh'];
    const connection = select(connections.map((c) => [c, CONNECTION_LABELS[c]]), t.connection || connections[connections.length - 1]);
    const port = h('input', { type: 'number', min: 1, max: 65535, value: t.port || DEFAULT_PORTS[connection.value] });
    const account = safePicker(safe, t.safe_entry_id);
    const become = safePicker(safe, t.become_entry_id, { none: 'Aucun (sudo sans mot de passe)', passwordOnly: true });
    const verify = caPicker(t.ca_certificate_id || '', { empty: { name: 'Non : certificat auto-signé accepté', meta: 'aucune vérification' } });
    const title = h('b');
    const vmGroup = group('VM *', vmSelect);
    const manualGroups = [group('Nom *', nameInput, tipLines(['Définition', 'Nom de l’hôte dans l’inventaire Ansible.'])), group('Adresse *', addressInput, tipLines(['Valeur', 'Adresse IP ou nom DNS de la cible.']))];
    const becomeGroup = group('Mot de passe sudo', become, tipLines(['Format', 'Entrée « mot de passe » du coffre-fort.']));
    const verifyGroup = group('Vérifier le certificat', verify, tipLines(
      ['Non', 'Connexion chiffrée sans contrôle de l’identité du serveur : une interception sur le réseau reste possible.'],
      ['Autorité', 'Le certificat WinRM de la cible doit être émis par cette autorité et contenir l’adresse utilisée pour la connexion (nom ou IP).']));
    let lastConnection = connection.value;
    const paint = () => {
      const forge = source.value === 'forge';
      vmGroup.hidden = !forge;
      manualGroups.forEach((g) => { g.hidden = forge; });
      becomeGroup.hidden = os !== 'linux';
      verifyGroup.hidden = connection.value !== 'winrms';
      if (connection.value !== lastConnection && Number(port.value) === DEFAULT_PORTS[lastConnection]) port.value = DEFAULT_PORTS[connection.value];
      lastConnection = connection.value;
      const vm = osVms.find((v) => v.id === vmSelect.value);
      title.textContent = (forge ? vm?.vm_name : nameInput.value.trim()) || 'Nouvelle cible';
    };
    vmSelect.addEventListener('change', () => {
      const vm = osVms.find((v) => v.id === vmSelect.value);
      if (vm?.safe_entry_id && !account.value) account.choose(vm.safe_entry_id);
      paint();
    });
    [source, connection].forEach((x) => x.addEventListener('change', paint));
    nameInput.addEventListener('input', paint);
    paint();
    const el = h('div', { class: 'ansible-item' },
      h('div', { class: 'ansible-item-head' }, h('span', { class: 'ansible-item-title' }, title),
        iconButton('Retirer la cible', 'M4 4l8 8M12 4l-8 8', remove, ' btn-icon-danger')),
      row(group('Source', source), vmGroup, ...manualGroups),
      row(group('Connexion', connection), group('Port', port), group('Compte (coffre-fort) *', account), becomeGroup, verifyGroup));
    return {
      el,
      refresh: () => {},
      value: () => ({
        source: source.value,
        ...(source.value === 'forge' ? { tofu_profile_id: vmSelect.value } : { name: nameInput.value.trim(), address: addressInput.value.trim() }),
        connection: connection.value,
        port: Number(port.value) || DEFAULT_PORTS[connection.value],
        safe_entry_id: account.value,
        ...(os === 'linux' && become.value ? { become_entry_id: become.value } : {}),
        ...(connection.value === 'winrms' && verify.value ? { ca_certificate_id: verify.value } : {}),
      }),
    };
  };
}

const paramTip = (param) => (param.help ? String(param.help) : null);

function paramField(param, value, { safe, certs }) {
  const label = `${param.label}${param.required ? ' *' : ''}`;
  const current = value === undefined ? param.default : value;
  const isNumber = param.type === 'int' || param.type === 'float';
  let input;
  let read;
  if (param.type === 'bool') {
    input = checkbox(current === true);
    read = () => input.checked;
    return { el: group(label, toggleSwitch(input, 'Oui'), paramTip(param)), read };
  }
  if (param.type === 'list' && param.choices) {
    const star = param.choices.includes('*');
    const picked = Array.isArray(current) ? current : [];
    const chips = choiceChips(param.choices.filter((c) => c !== '*').map((c) => [c, c]), star ? 'Toutes (*)' : 'Toutes',
      star && picked.includes('*') ? null : picked, { nullWhenAll: star });
    chips.paint();
    return { el: group(label, chips.el, paramTip(param), true), read: () => chips.value() ?? ['*'] };
  }
  if (param.choices && param.choices.length <= CHIP_CHOICES_MAX) {
    let picked = current;
    const chips = param.choices.map((c) => h('button', { class: 'choice-chip', onclick: () => {
      picked = picked === c && !param.required && param.default === undefined ? undefined : c;
      paint();
    } }, String(c)));
    const paint = () => chips.forEach((b, i) => {
      b.classList.toggle('is-on', param.choices[i] === picked);
      b.setAttribute('aria-pressed', String(param.choices[i] === picked));
    });
    paint();
    return { el: group(label, h('div', { class: 'choice-chips', role: 'group' }, chips), paramTip(param)), read: () => picked };
  }
  if (param.type === 'vault_entry') {
    input = safePicker(safe, current, { none: param.required ? null : 'Aucune' });
    read = () => input.value;
  } else if (param.type === 'certificate_entry') {
    input = certificatePicker(certs, current, { none: param.required ? null : 'Aucun', types: param.cert_types });
    read = () => input.value;
  } else if (param.choices) {
    input = select([...(param.required ? [] : [['', '— Valeur par défaut —']]), ...param.choices.map((c) => [c, String(c)])], current ?? '');
    read = () => (input.value === '' ? undefined : isNumber ? Number(input.value) : input.value);
  } else if (isNumber) {
    input = h('input', { type: 'number', class: 'number-input', value: current ?? '', step: param.type === 'int' ? 1 : 'any', min: param.min, max: param.max });
    read = () => (input.value === '' ? undefined : Number(input.value));
  } else if (param.type === 'list') {
    input = text(Array.isArray(current) ? current.join(', ') : current ?? '');
    read = () => input.value.split(',').map((x) => x.trim()).filter(Boolean);
  } else if (param.multiline) {
    input = h('textarea', { class: 'commands-input', rows: 6, spellcheck: 'false', value: current ?? '' });
    read = () => input.value;
  } else {
    input = text(current ?? '');
    read = () => input.value;
  }
  return { el: group(label, input, paramTip(param), param.multiline), read };
}

function brickBody(brick, values, { safe, certs }) {
  const fields = brick.parameters.map((p) => [p.name, paramField(p, values?.[p.name], { safe, certs })]);
  const nodes = [brick.description ? h('p', { class: 'ansible-item-desc' }, brick.description) : null,
    fields.length ? h('div', { class: 'form-row' }, fields.map(([, f]) => f.el)) : h('p', { class: 'cell-muted' }, 'Aucun paramètre')];
  return { fields, nodes };
}

const brickTitle = (brick, number, fallback) => h('span', { class: 'ansible-item-title' }, number, h('b', {}, brick?.name || fallback),
  h('small', {}, brick ? `${brick.origin === 'forge' ? 'Forge' : 'personnalisée'} · ${brick.id}` : ''));

function stepItem({ bricks, safe, certs }) {
  return (s, { move, remove }) => {
    const brick = bricks.get(s.brick);
    const enabled = checkbox(s.enabled !== false);
    const number = h('span', { class: 'ansible-step-number' });
    const { fields, nodes: body } = brick ? brickBody(brick, s.values, { safe, certs })
      : { fields: [], nodes: [h('p', { class: 'ansible-item-error' }, `Brique ${s.brick} introuvable dans le catalogue : retirer l'étape ou restaurer la brique`)] };
    const up = iconButton('Monter', 'M4 10l4-4 4 4', () => move(-1));
    const down = iconButton('Descendre', 'M4 6l4 4 4-4', () => move(1));
    const el = h('div', { class: 'ansible-item' },
      h('div', { class: 'ansible-item-head' },
        brickTitle(brick, number, s.brick),
        toggleSwitch(enabled, 'Active'), up, down,
        iconButton('Retirer l\'étape', 'M4 4l8 8M12 4l-8 8', remove, ' btn-icon-danger')),
      ...body);
    return {
      el,
      refresh: (i, n) => { number.textContent = `${i + 1}.`; up.disabled = i === 0; down.disabled = i === n - 1; },
      value: () => ({
        brick: s.brick,
        enabled: enabled.checked,
        values: brick ? Object.fromEntries(fields.map(([name, f]) => [name, f.read()]).filter(([, v]) => v !== undefined)) : s.values || {},
      }),
    };
  };
}

function knownHostsReset(profile) {
  const confirmBox = h('div', { hidden: true });
  const startBtn = h('button', { type: 'button', class: 'btn', onclick: () => {
    startBtn.hidden = true;
    confirmBox.hidden = false;
  } }, 'Réinitialiser les empreintes');
  const cancel = () => {
    confirmBox.hidden = true;
    startBtn.hidden = false;
  };
  confirmBox.append(
    h('p', { class: 'schedule-warning' }, 'Oublier les empreintes SSH des cibles enregistrées de ce profil ? À faire seulement si un serveur a été réinstallé : la prochaine connexion acceptera et mémorisera la nouvelle empreinte sans contrôle.'),
    h('div', { class: 'ansible-add' },
      h('button', { type: 'button', class: 'btn', onclick: cancel }, 'Annuler'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: guard(async () => {
        const r = await api(`/ansible/profiles/${profile.id}/known-hosts/reset`, { method: 'POST' });
        if (r.skipped.length) toast(r.skipped.join(' ; '));
        cancel();
      }) }, 'Confirmer')));
  return group('Empreintes SSH', h('div', {}, startBtn, confirmBox),
    tipLines(['Utilisation', 'Après la réinstallation d’une cible SSH du profil (cibles enregistrées).']), true);
}

async function ansibleProfileModal(existing, copy = null) {
  const src = existing || copy;
  const v = src?.vars || {};
  const [vms, safe, catalogue, certs] = await Promise.all([api('/ansible/vms'), loadSafe(), loadCatalogue(), loadCertificates()]);
  const bricks = new Map(catalogue.rows.filter((b) => !b.error).map((b) => [b.id, b]));
  const fixed = !!src;
  const nameInput = text(src?.name, { maxlength: 100 });
  const descInput = text(src?.description, { maxlength: 500 });
  const osSelect = select([['linux', 'Linux'], ['windows', 'Windows']], v.os_type || 'linux', { disabled: fixed });
  const typeSelect = select([['guided', 'Étapes guidées (briques du catalogue)'], ['yaml', 'Playbook YAML brut']], v.config_type || 'guided', { disabled: fixed });
  const timeoutInput = h('input', { type: 'number', min: 0, max: 1440, step: 5, value: v.timeout_min ?? 60 });
  const forksInput = h('input', { type: 'number', min: 1, max: 20, value: v.forks ?? 5 });
  const playbookInput = yamlEditor(h('textarea', { class: 'code-input', rows: 24, spellcheck: 'false', value: v.playbook || '', placeholder: PLAYBOOK_EXAMPLE }));
  const preview = h('pre', { class: 'log ansible-preview' });
  const targetsPane = h('div');
  const stepsPane = h('div');
  const yamlPane = h('div', { class: 'ansible-yaml' }, section('Playbook YAML',
    row(group('Playbook', playbookInput, tipLines(['Cibles', 'Toujours « hosts: all » : les cibles viennent de l’onglet Cibles.'],
      ['Comptes', 'Les comptes et mots de passe sont fournis par Forge.']), true))));
  let targets;
  let steps;

  const buildTargets = (items) => {
    targets = itemList({ items, max: MAX_TARGETS, addLabel: 'Ajouter une cible', make: targetItem({ os: osSelect.value, vms, safe,
      takenVms: () => targets.values().filter((x) => x.source === 'forge').map((x) => x.tofu_profile_id) }) });
    targetsPane.replaceChildren(section('Serveurs cibles',
      h('p', { class: 'hint ansible-intro' }, osSelect.value === 'windows'
        ? 'Windows : SSH (OpenSSH Server) ou WinRM HTTPS (port 5986, authentification NTLM). Empreinte SSH mémorisée à la première connexion puis exigée.'
        : 'Linux : SSH avec un compte du coffre-fort (mot de passe ou clé). Empreinte SSH mémorisée à la première connexion puis exigée.'),
      targets.list, h('div', { class: 'ansible-add' }, targets.addBtn)));
  };
  const buildSteps = (items) => {
    steps = null;
    const os = osSelect.value;
    const usable = [...bricks.values()].filter((b) => b.os === os);
    const brickPlaceholder = usable.length ? 'Choisir une brique' : `Aucune brique ${OS_LABELS[os]} dans le catalogue`;
    const brickSelect = optionPicker(usable.map((b) => ({ value: b.id, name: b.name, meta: b.origin === 'forge' ? 'Forge' : 'personnalisée' })), '',
      { placeholder: brickPlaceholder });
    const empty = h('p', { class: 'cell-muted' }, 'Aucune étape : choisir une brique puis « Ajouter l\'étape ».');
    steps = itemList({ items, max: MAX_STEPS, addLabel: 'Ajouter l\'étape', make: stepItem({ bricks, safe, certs }),
      onAdd: () => {
        if (!brickSelect.value) return toast('Choisir une brique du catalogue');
        steps.add({ brick: brickSelect.value, enabled: true, values: {} });
        brickSelect.setValue('', brickPlaceholder);
        return undefined;
      },
      onChange: () => { empty.hidden = (steps ? steps.size() : items.length) > 0; } });
    stepsPane.replaceChildren(section('Étapes', h('p', { class: 'hint ansible-intro' },
      'Exécutées dans l\'ordre sur toutes les cibles, avec élévation des droits sous Linux. Une étape désactivée est conservée mais ignorée.'),
    steps.list, empty, h('div', { class: 'ansible-add' }, group('Brique', brickSelect), steps.addBtn)));
  };
  const showType = () => {
    const yaml = typeSelect.value === 'yaml';
    stepsPane.hidden = yaml;
    yamlPane.hidden = !yaml;
  };
  osSelect.addEventListener('change', () => {
    buildTargets(targets.values().filter((t) => t.source === 'manual')
      .map((t) => ({ source: 'manual', name: t.name, address: t.address, safe_entry_id: t.safe_entry_id })));
    buildSteps([]);
  });
  typeSelect.addEventListener('change', showType);
  buildTargets(v.targets || []);
  buildSteps(v.steps || []);
  showType();

  const collect = () => ({
    os_type: osSelect.value,
    config_type: typeSelect.value,
    targets: targets.values(),
    timeout_min: Number(timeoutInput.value),
    forks: Number(forksInput.value),
    ...(typeSelect.value === 'yaml' ? { playbook: playbookInput.value } : { steps: steps.values() }),
  });
  let previewRun = 0;
  const loadPreview = async () => {
    const run = ++previewRun;
    preview.textContent = 'Génération de l’aperçu…';
    try {
      const r = await api('/ansible/preview', { method: 'POST', body: { name: nameInput.value.trim(), vars: collect() } });
      if (run === previewRun) preview.textContent = r.playbook;
    } catch (e) {
      if (run === previewRun) preview.textContent = `Aperçu impossible : ${e.message}`;
    }
  };
  const previewPane = h('div', { class: 'ansible-preview-pane' }, section('Playbook généré',
    h('p', { class: 'hint ansible-intro' }, 'Mis à jour à chaque ouverture de l’onglet, à partir des valeurs actuelles du profil.'), preview));

  const tabs = formTabs([
    ['Général', h('div', { class: 'ansible-general' },
      section('Général', row(group('Nom du profil *', nameInput), group('Description', descInput))),
      section('Type de profil', row(group('Système des cibles', osSelect, fixed ? tipLines(['Création', 'Fixé à la création.']) : null),
        group('Configuration', typeSelect, fixed ? tipLines(['Création', 'Fixée à la création.'], ['Changement', '« Convertir en YAML » crée un nouveau profil.']) : null))),
      section('Exécution',
        row(group('Délai maximal (min)', timeoutInput, tipLines(['Définition', 'Au-delà, le job est interrompu.'], ['Valeur 0', 'Sans limite.'])),
          group('Serveurs en parallèle', forksInput, tipLines(['Définition', 'Nombre de cibles traitées en même temps (forks).']))),
        existing && (v.targets || []).some((t) => t.connection === 'ssh') ? row(knownHostsReset(existing)) : null))],
    ['Cibles', targetsPane],
    ['Configuration', h('div', { class: 'ansible-config' }, stepsPane, yamlPane)],
    ['Aperçu du playbook', previewPane],
  ]);
  tabs.bar.lastElementChild.addEventListener('click', loadPreview);

  let close;
  const form = h('form', { onsubmit: guard(async (e) => {
    e.preventDefault();
    if (!nameInput.value.trim()) { tabs.show(0); throw new Error('Le nom du profil est obligatoire'); }
    const vars = collect();
    const bad = vars.targets.findIndex((t) => !t.safe_entry_id || (t.source === 'forge' ? !t.tofu_profile_id : !t.name || !t.address));
    if (bad >= 0) { tabs.show(1); throw new Error(`Cible ${bad + 1} : ${vars.targets[bad].safe_entry_id ? 'VM, nom ou adresse manquant' : 'compte du coffre-fort obligatoire'}`); }
    if (vars.config_type === 'yaml' && !vars.playbook.trim()) { tabs.show(2); throw new Error('Le playbook YAML est obligatoire'); }
    const body = { name: nameInput.value.trim(), description: descInput.value.trim(), vars, ...(copy?.copy_from ? { copy_from: copy.copy_from } : {}) };
    await api(existing ? `/ansible/profiles/${existing.id}` : '/ansible/profiles', { method: existing ? 'PUT' : 'POST', body });
    close();
    pageAnsibleProfiles();
  }) }, tabs.bar, tabs.body, formActions(() => close(), existing ? 'Enregistrer' : 'Créer'));
  close = openModal(existing ? `Profil : ${existing.name}` : copy ? 'Copie de profil' : 'Nouveau profil', form, {
    size: 'wide3',
    subtitle: copy ? `Ansible · copie de « ${copy.sourceName} »`
      : existing ? `Ansible · ${OS_LABELS[v.os_type]} · ${TYPE_LABELS[v.config_type]}` : 'Ansible · configuration des serveurs après déploiement',
  });
}

const hasTargets = (p) => (p.vars.targets?.length ? profileIdle(p) : 'Aucune cible : ajouter un serveur dans l\'onglet Cibles');
const targetNames = (p) => (p.vars.targets || []).map((t) => t.name).join(', ');

export async function pageAnsibleProfiles(gen = view.pageGen) {
  const t = await dataTable({
    key: 'ansible-profiles',
    source: pagedSource('/ansible/profiles'),
    card: profilesCard('ansible'),
    search: true,
    empty: 'Aucun profil Ansible : créez-en un pour configurer des serveurs.',
    create: { label: 'Ajouter', run: guard(() => ansibleProfileModal(null)) },
    poll: 5000,
    columns: [
      ['Profil', (p) => stack(p.name), '14%', 'name'],
      ['Description', (p) => (p.description ? oneLine(p.description) : emptyCell()), '14%', 'description'],
      ['Système', (p) => (OS_LABELS[p.vars.os_type] ? oneLine(OS_LABELS[p.vars.os_type]) : emptyCell()), '8%', 'os'],
      ['Configuration', (p) => (TYPE_LABELS[p.vars.config_type] ? oneLine(TYPE_LABELS[p.vars.config_type]) : emptyCell()), '11%', 'config'],
      ['Étapes', (p) => (p.vars.config_type === 'guided' ? oneLine(plural(p.vars.steps?.length || 0, 'étape')) : emptyCell()), '8%', 'steps:desc'],
      ['Cibles', (p) => (targetNames(p) ? oneLine(targetNames(p)) : emptyCell()), '12%', 'targets'],
      ['Dernier job', lastJobCell('ansible'), '11%', 'last_job:desc'],
      ['Vérification', (p) => when(p.checked_at), '11%', 'validated:desc'],
      ['Application', (p) => when(p.applied_at), '11%', 'built:desc'],
    ],
    actions: [
      { label: 'Modifier', when: 'one', reload: false, run: ([p]) => ansibleProfileModal(p) },
      { label: 'Cloner', when: 'one', reload: false, run: ([p]) => cloneProfile('/ansible/profiles', p, ansibleProfileModal) },
      { label: 'Tester la connexion', when: 'many', allow: hasTargets, run: (sel) => launchMany('ansible', 'ping', sel) },
      { label: 'Vérifier', when: 'many', allow: hasTargets, run: (sel) => launchMany('ansible', 'check', sel) },
      { label: 'Appliquer', when: 'many', allow: hasTargets,
        confirm: (sel) => ({
          title: 'Appliquer la configuration',
          message: sel.length > 1
            ? `Appliquer ${sel.length} profils ? La configuration sera appliquée sur leurs serveurs cibles.`
            : [`Appliquer « ${sel[0].name} » ?`, `Serveurs modifiés : ${targetNames(sel[0])}.`],
        }),
        run: (sel) => launchMany('ansible', 'apply', sel) },
      { label: 'Convertir en YAML', when: 'one', allow: (p) => (p.vars.config_type === 'guided' ? true : 'Profil déjà en YAML'),
        confirm: ([p]) => ({ title: 'Convertir en YAML',
          message: `Créer un nouveau profil « ${p.name} (YAML) » avec le playbook généré par les étapes ? Le profil d'origine est conservé.` }),
        run: ([p]) => api(`/ansible/profiles/${p.id}/convert`, { method: 'POST' }) },
      { label: 'Supprimer', when: 'many', danger: true, allow: profileIdle,
        confirm: (sel) => deleteConfirm(sel, ['le profil', 'les profils'], (p) => p.name),
        run: (sel) => batch('/ansible/profiles/batch', 'delete', sel) },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}

function brickModal(brick, { create = false, readOnly = false, draft = null } = {}) {
  const idParts = (id) => {
    const m = /^(?:forge:)?(linux|windows)\/(.+)$/.exec(id || '');
    return m ? { os: m[1], file: m[2] } : { os: 'linux', file: '' };
  };
  const start = idParts(draft?.id || brick?.id);
  const osSelect = select([['linux', 'Linux'], ['windows', 'Windows']], start.os, { disabled: readOnly || !create });
  const fileInput = text(start.file, { maxlength: 63, disabled: readOnly, pattern: '[a-z0-9][a-z0-9_\\-]{0,62}',
    title: 'Minuscules, chiffres, « - » et « _ »' });
  const yamlInput = yamlEditor(h('textarea', { class: 'code-input', rows: 24, spellcheck: 'false', readOnly,
    value: draft?.yaml ?? brick?.yaml ?? (create ? BRICK_EXAMPLES[start.os] : '') }));
  const report = h('p', { class: 'hint ansible-check', role: 'status', hidden: true });
  const marker = lineMarker(yamlInput);
  const showReport = (message, valid) => {
    report.textContent = message;
    report.classList.toggle('ansible-check-error', !valid);
    report.hidden = false;
  };
  const reportErrors = (fn) => guard(async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof SessionExpired) throw e;
      tabs.show(0);
      showReport(e.message, false);
      if (e.data?.line) marker.show(e.data.line, e.data.lastLine);
      else marker.clear();
    }
  });
  const preview = h('div', { class: 'ansible-items' });
  const lists = Promise.all([loadSafe(), loadCertificates()]).catch(() => [[], []]);
  const paintPreview = async (b) => {
    if (!b) {
      preview.replaceChildren(h('p', { class: 'cell-muted' }, 'Vérifier la brique pour afficher son aperçu.'));
      return;
    }
    if (b.error) {
      preview.replaceChildren(h('p', { class: 'ansible-item-error' }, `Brique invalide : ${b.error}`));
      return;
    }
    const [safe, certs] = await lists;
    preview.replaceChildren(h('div', { class: 'ansible-item' },
      h('div', { class: 'ansible-item-head' }, brickTitle(b, h('span', { class: 'ansible-step-number' }, '1.'))),
      ...brickBody(b, {}, { safe, certs }).nodes));
  };
  const checked = (r) => ({ ...r, origin: brick?.origin === 'forge' && !create ? 'forge' : 'custom', id: id() });
  const checkBtn = h('button', { type: 'button', class: 'btn', onclick: reportErrors(async () => {
    const r = await api('/ansible/catalogue/check', { method: 'POST', body: { yaml: yamlInput.value, os: osSelect.value } });
    paintPreview(checked(r));
    marker.clear();
    showReport(`Brique valide : « ${r.name} », ${plural(r.parameters.length, 'paramètre')}${
      r.parameters.length ? ` (${r.parameters.map((p) => p.name).join(', ')})` : ''}`, true);
  }) }, 'Vérifier la brique');
  const id = () => `${osSelect.value}/${fileInput.value.trim()}`;
  osSelect.addEventListener('change', () => {
    const os = osSelect.value;
    const cur = yamlInput.value;
    yamlInput.value = Object.values(BRICK_EXAMPLES).includes(cur) ? BRICK_EXAMPLES[os] : cur.replace(/^os:[ \t]*\S*[ \t]*$/m, `os: ${os}`);
    report.hidden = true;
  });
  const used = !readOnly && brick?.used_by?.length ? h('p', { class: 'schedule-warning' },
    `Utilisée par ${plural(brick.used_by.length, 'profil')} : ${brick.used_by.join(', ')}. Une modification s'appliquera à leurs prochains jobs.`) : null;
  const save = async (confirm = false) => {
    if (!fileInput.value.trim()) throw new Error('Nom du fichier obligatoire');
    const body = create ? { id: id(), yaml: yamlInput.value, ...(draft?.copy_from ? { copy_from: draft.copy_from } : {}) } : { id: brick.id, new_id: id(), yaml: yamlInput.value, confirm };
    try {
      await api('/ansible/catalogue', { method: create ? 'POST' : 'PUT', body });
    } catch (e) {
      if (!e.data?.confirm) throw e;
      confirmDialog({ title: 'Brique utilisée', confirmLabel: 'Enregistrer',
        message: [`Cette brique est utilisée par ${e.data.used_by.map((n) => `« ${n} »`).join(', ')}.`,
          'Les prochains jobs de ces profils utiliseront la nouvelle version. Des paramètres retirés ou renommés peuvent rendre leurs étapes invalides.'],
        onConfirm: reportErrors(() => save(true)) });
      return;
    }
    close();
    pageAnsibleCatalogue();
  };
  const actions = readOnly
    ? h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Fermer'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: guard(async () => {
        const d = await api(`/ansible/catalogue/clone?id=${encodeURIComponent(brick.id)}`);
        close();
        brickModal(null, { create: true, draft: d });
      }) }, 'Cloner pour modifier'))
    : formActions(() => close(), create ? 'Créer' : 'Enregistrer');
  let close;
  const yamlSection = section('Contenu YAML', row(group('Brique', yamlInput,
    tipLines(['Clés', 'name, os, description, parameters, tasks.'],
      ['Paramètres', 'label et type obligatoires ; help, required, default, choices et multiline facultatifs.'],
      ['Types', 'str, int, float, bool, list, vault_entry, certificate_entry.'],
      ['Bornes', 'min et max pour int et float.'],
      ['Formats', 'format pour str et list : ipv4, cidr, hostname, fqdn, port, path_linux, path_windows, url, email.'],
      ['Certificats', 'cert_types pour certificate_entry : cert_key, pkcs12, ca.'],
      ['Modules', 'ansible.builtin, ansible.posix, community.general, community.crypto, ansible.windows, community.windows et microsoft.ad, avec leur nom complet.']), true)),
  readOnly ? null : h('div', { class: 'ansible-add' }, checkBtn), report);
  yamlSection.classList.add('brick-yaml');
  const previewSection = section('Aperçu de l\'étape',
    readOnly ? null : h('p', { class: 'hint ansible-intro' }, '« Vérifier la brique » met l\'aperçu à jour.'), preview);
  previewSection.classList.add('brick-preview');
  if (brick && !create) paintPreview(brick);
  else api('/ansible/catalogue/check', { method: 'POST', body: { yaml: yamlInput.value, os: osSelect.value } })
    .then((r) => paintPreview(checked(r)), () => paintPreview(null));
  const tabs = formTabs([['Code', yamlSection], ['Brique', previewSection]]);
  const submit = reportErrors(() => save());
  const form = h('form', { class: 'brick-form', onsubmit: (e) => { e.preventDefault(); submit(); } },
    tabs.bar,
    used,
    section('Fichier', row(group('Système', osSelect), group('Nom du fichier *', fileInput, tipLines(['Format', 'Minuscules, chiffres, « - » et « _ », sans extension.'])))),
    tabs.body,
    actions);
  close = openModal(create ? (draft ? 'Copie de brique' : 'Nouvelle brique') : `Brique : ${brick.name}`, form, {
    size: 'wide', subtitle: `Ansible · catalogue${brick ? ` · ${brick.id}` : ''}` });
}

const IMPORT_MAX_BYTES = 64 * 1024;
const IMPORT_EXT_RE = /^[^\\/]+\.ya?ml$/i;

async function readYamlFile(file) {
  if (!IMPORT_EXT_RE.test(file.name)) throw new Error('Import refusé : seuls les fichiers .yml ou .yaml sont acceptés');
  if (!file.size) throw new Error('Import refusé : fichier vide');
  if (file.size > IMPORT_MAX_BYTES) throw new Error('Import refusé : fichier trop volumineux (64 Ko max)');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error('Import refusé : le fichier n’est pas un texte UTF-8');
  }
  return text.replace(/\r\n?/g, '\n');
}

function importBrick() {
  const input = h('input', { type: 'file', accept: '.yml,.yaml', hidden: true });
  input.addEventListener('change', guard(async () => {
    const file = input.files[0];
    if (!file) return;
    const yaml = await readYamlFile(file);
    let brick;
    try {
      brick = await api('/ansible/catalogue/check', { method: 'POST', body: { yaml } });
    } catch (e) {
      throw new Error(`Import refusé : ${e.message}`);
    }
    const base = file.name.replace(/\.ya?ml$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 63) || 'brique-importee';
    brickModal(null, { create: true, draft: { id: `${brick.os}/${base}`, yaml } });
  }));
  document.body.append(input);
  input.click();
  input.remove();
}

export async function pageAnsibleCatalogue(gen = view.pageGen) {
  const source = localSource(async () => (await loadCatalogue()).rows, (b) => [b.name, b.id, b.description], { name: (b) => b.name, os: (b) => b.os, origin: (b) => b.origin, used: (b) => b.used_by.length },
    { linux: (b) => b.os === 'linux', windows: (b) => b.os === 'windows' });
  const custom = (b) => (b.origin === 'forge' ? 'Brique Forge : lecture seule' : true);
  const t = await dataTable({
    key: 'ansible-catalogue',
    source,
    filters: groupFilters([['linux', 'Linux'], ['windows', 'Windows']]),
    card: {
      engine: 'ansible', icon: activityRing('ansible', ICONS.disc), title: 'Catalogue',
      intro: tipLines(['Définition', 'Briques réutilisables des profils à étapes guidées.'],
        ['Briques Forge', 'En lecture seule : les cloner pour les adapter.'],
        ['Briques personnalisées', 'Fichiers YAML du dossier monté dans le conteneur.']),
      subtitle: (d, st) => [ENGINE_CARDS.ansible.subtitle, st.search ? plural(d.total || 0, 'résultat') : plural(d.total || 0, 'brique')].join(' · '),
    },
    search: true,
    empty: 'Catalogue vide.',
    create: { label: 'Ajouter', run: () => brickModal(null, { create: true }) },
    tools: h('button', { class: 'btn', onclick: importBrick }, actionIcon('Importer'), 'Importer'),
    columns: [
      ['Brique', (b) => stack(b.name), '20%', 'name'],
      ['Description', (b) => (b.error ? h('span', { title: b.error }, stateBadge('warn', 'invalide'))
        : b.description ? oneLine(b.description) : emptyCell()), '25%'],
      ['Système', (b) => OS_LABELS[b.os], '8%', 'os'],
      ['Origine', (b) => (b.origin === 'forge' ? 'Forge (lecture seule)' : 'Personnalisée'), '11%', 'origin'],
      ['Paramètres', (b) => (b.parameters.length ? oneLine(b.parameters.map((p) => p.label).join(', ')) : emptyCell()), '25%'],
      ['Utilisée par', (b) => (b.used_by.length ? h('span', { title: b.used_by.join(', ') }, plural(b.used_by.length, 'profil')) : h('span', { class: 'cell-muted' }, '—')), '11%', 'used:desc'],
    ],
    actions: [
      { label: 'Modifier', when: 'one', reload: false, run: async ([b]) => {
        const full = await api(`/ansible/catalogue/brick?id=${encodeURIComponent(b.id)}`);
        brickModal(full, { readOnly: full.origin === 'forge' });
      } },
      { label: 'Cloner', when: 'one', reload: false, run: async ([b]) => {
        const d = await api(`/ansible/catalogue/clone?id=${encodeURIComponent(b.id)}`);
        brickModal(null, { create: true, draft: d });
      } },
      { label: 'Exporter', when: 'one', reload: false, run: ([b]) => { location.href = `/api/ansible/catalogue/export?id=${encodeURIComponent(b.id)}`; } },
      { label: 'Supprimer', when: 'many', danger: true,
        allow: (b) => (custom(b) !== true ? custom(b) : b.used_by.length ? `Utilisée par ${b.used_by.join(', ')}` : true),
        confirm: (sel) => deleteConfirm(sel, ['la brique', 'les briques'], (b) => b.name, 'Le fichier YAML sera supprimé du dossier monté.'),
        run: (sel) => batch('/ansible/catalogue/batch', 'delete', sel) },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}

