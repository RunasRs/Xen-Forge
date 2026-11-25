import { view } from './page.js';
import { h, toast } from './dom.js';
import { api, guard } from './api.js';
import { tipLines } from './display.js';
import { openModal } from './modal.js';
import { checkbox, formActions, formTabs, group, row, section, toggleSwitch } from './forms.js';
import { optionPicker, scrollSelect, srPicker, xcpPicker } from './pickers.js';
import { KEYBOARD_LAYOUTS, LOCALES, TIMEZONES, WINDOWS_UI_LANGUAGES } from './regional.js';
import { isAccountEntry, safeEntryOption } from './safe-entries.js';

const COMMAND_LINES = 20;
const COMMAND_CHARS = 2000;
function commandsTextarea(value) {
  const el = h('textarea', { class: 'commands-input commands-input-20', rows: COMMAND_LINES, value: value || '' });
  el.maxLength = COMMAND_CHARS;
  const lineCount = (s) => s.split('\n').length;
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const selected = el.value.slice(el.selectionStart, el.selectionEnd);
    if (lineCount(el.value) - (lineCount(selected) - 1) >= COMMAND_LINES) e.preventDefault();
  });
  el.addEventListener('input', () => {
    const lines = el.value.split('\n');
    if (lines.length <= COMMAND_LINES) return;
    const pos = el.selectionStart;
    el.value = lines.slice(0, COMMAND_LINES).join('\n');
    el.setSelectionRange(Math.min(pos, el.value.length), Math.min(pos, el.value.length));
  });
  return el;
}

const loadDistributions = async () => {
  if (view.distributionRows) return view.distributionRows;
  try { view.distributionRows = await api('/distributions'); }
  catch (e) { view.distributionRows = []; toast(`Catalogue des ISO indisponible : ${e.message}`); }
  return view.distributionRows;
};

function createCatalogPicker(onPick, initialUrl = '', onInit = () => {}) {
  const naturalOrder = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const osSelect = optionPicker(null, '', { placeholder: 'Sélectionner…' });
  const versionSelect = optionPicker([], '', { placeholder: 'Sélectionner…' });
  versionSelect.disabled = true;

  const fillOs = (rows, selected) => osSelect.setOptions(
    [...new Set(rows.map((r) => r.os))].sort(naturalOrder).map((o) => ({ value: o, name: o })), selected);
  const fillVersions = (rows, os, selected) => {
    versionSelect.setOptions(rows.filter((r) => r.os === os).sort((a, b) => naturalOrder(a.version, b.version))
      .map((r) => ({ value: r.version, name: r.version, meta: String(r.url || '').split('/').pop() })), selected);
    versionSelect.disabled = !os;
  };
  osSelect.addEventListener('change', async () => fillVersions(await loadDistributions(), osSelect.value, ''));
  versionSelect.addEventListener('change', async () => {
    const row = (await loadDistributions()).find((r) => r.os === osSelect.value && r.version === versionSelect.value);
    if (row) onPick(row);
  });
  loadDistributions().then((rows) => {
    const match = rows.find((r) => r.url === initialUrl);
    fillOs(rows, match?.os || '');
    fillVersions(rows, match?.os || '', match?.version || '');
    if (match) onInit(match);
  });
  return row(group('OS *', osSelect), group('Version *', versionSelect));
}

export function profileModal(existing, copy, onSaved) {
  const src = existing || copy;
  view.srPromise = null;
  view.networksPromise = null;
  const v = src?.vars || {};
  const state = {
    osType: v.os_type === 'windows' ? 'windows' : 'linux',
    catalogOs: '',
    iso_url: v.iso_url || '',
    iso_checksum: v.iso_checksum || '',
    clone_template: v.clone_template || '',
    sr_uuid: v.sr_uuid || '',
    sr_iso_uuid: v.sr_iso_uuid || '',
    network: v.network || '',
    safe_entry_id: v.safe_entry_id || '',
  };
  const isWindows = () => state.osType === 'windows';
  const text = (value, attrs = {}) => h('input', { type: 'text', value: value ?? '', ...attrs });
  const select = (pairs, selected) => scrollSelect(pairs, selected);

  const nameInput = text(src?.name, { maxlength: 100 });
  const descInput = text(src?.description, { maxlength: 500 });
  const existingTemplateSelect = select([
    ['refuse', 'Refuser si le template existe'],
    ['replace', 'Remplacer'],
    ['replace_purge', 'Remplacer et supprimer ses disques'],
  ], v.existing_template || 'replace_purge');
  const removeBuildUser = checkbox(v.remove_build_user === 'true');
  const keepVmHelp = () => [
    ['Suppression après succès', 'Template créé, puis VM de build supprimée.', 'VM de build supprimée.'],
    ['Conservation pour inspection', 'Template créé, puis VM de build supprimée.', 'VM de build conservée pour inspection.'],
    ['Suppression systématique', 'Template non créé, VM de build supprimée.', 'VM de build supprimée.'],
  ].flatMap(([title, ok, ko], i) => [i ? h('br') : null, h('b', {}, title), h('br'),
    h('b', {}, 'Build réussi : '), ok, h('br'), h('b', {}, 'Build en échec ou annulé : '), ko]);
  const keepVmSelect = select([
    ['on_success', 'Suppression après succès'],
    ['always', 'Conservation pour inspection'],
    ['never', 'Suppression systématique'],
  ], v.keep_vm || 'on_success');
  const firmwareSelect = scrollSelect([['bios', 'BIOS'], ['uefi', 'UEFI']], v.firmware || 'bios');
  const secureBoot = checkbox(v.secure_boot === 'true');
  const secureBootGroup = group('Secure Boot', toggleSwitch(secureBoot, 'Activé'));
  const updateFirmware = () => { secureBootGroup.hidden = firmwareSelect.value !== 'uefi'; };
  firmwareSelect.addEventListener('change', updateFirmware);
  updateFirmware();
  const templatePicker = xcpPicker('template', state.clone_template, (x) => { state.clone_template = x; });
  const catalogPicker = createCatalogPicker((row) => {
    Object.assign(state, { iso_url: row.url, iso_checksum: row.hash || '', catalogOs: row.os, osType: row.os === 'windows' ? 'windows' : 'linux' });
    if (!src) applyOsDefaults();
    updateOs();
  }, state.iso_url, (row) => { state.catalogOs = row.os; refreshSafe(); });
  catalogPicker.append(group('Template à cloner *', templatePicker,
    tipLines(['Définition', 'Modèle matériel XCP-ng utilisé comme base pour créer la VM de build.'],
      ['Compatibilité', 'Le nombre de vCPU configuré au démarrage du modèle ne doit pas dépasser celui défini dans le profil.'])));
  const vcpusInput = h('input', { type: 'number', value: v.vcpus || (isWindows() ? 2 : 1), min: 1, max: 128 });
  const memoryInput = h('input', { type: 'number', value: v.vm_memory || (isWindows() ? 4096 : 2048), min: 256, step: 256 });
  const diskInput = h('input', { type: 'number', value: v.disk_size ? Math.round(Number(v.disk_size) / 1024) : (isWindows() ? 60 : 10), min: 1, max: 16384, step: 1 });
  const coresSelect = scrollSelect([], '');
  let coresN = Number(vcpusInput.value) || 1;
  let coresValue = Number(v.cores_per_socket) || 1;
  const updateCores = () => {
    const n = Number(vcpusInput.value) || 1;
    if (n % coresValue) coresValue = coresValue === coresN ? n : 1;
    coresN = n;
    coresSelect.setOptions(Array.from({ length: n }, (_, i) => i + 1).filter((c) => n % c === 0)
      .map((c) => [String(c), `${c} cœur(s) × ${n / c} socket(s)`]), String(coresValue));
  };
  coresSelect.addEventListener('change', () => { coresValue = Number(coresSelect.value) || 1; });
  vcpusInput.addEventListener('input', updateCores);
  updateCores();
  const diskNameInput = text(v.disk_name, { maxlength: 63 });
  const tagsInput = text(v.tags, { maxlength: 3249 });
  const nicTypeSelect = select([['rtl8139', 'Realtek RTL8139'], ['e1000', 'Intel e1000']], v.nic_type || 'rtl8139');
  const vgaToggle = checkbox(v.vga !== 'false');
  const videoramSelect = select(['1', '2', '4', '8', '16'].map((mib) => [mib, `${mib} MiB`]), String(v.videoram || '8'));
  const videoramGroup = group('Video RAM', videoramSelect);
  const refreshVga = () => { videoramGroup.hidden = !vgaToggle.checked; };
  vgaToggle.addEventListener('change', refreshVga);
  refreshVga();
  const OS_DEFAULTS = { linux: { vcpus: 1, memory: 2048, disk: 10 }, windows: { vcpus: 2, memory: 4096, disk: 32 } };
  const applyOsDefaults = () => {
    const d = OS_DEFAULTS[state.osType];
    vcpusInput.value = d.vcpus;
    memoryInput.value = d.memory;
    diskInput.value = d.disk;
    coresValue = 1;
    updateCores();
  };
  const srSelect = srPicker('disk', state.sr_uuid, (x) => { state.sr_uuid = x; }, { uniqueName: true });
  const srIsoSelect = srPicker('iso', state.sr_iso_uuid, (x) => { state.sr_iso_uuid = x; }, { uniqueName: true });
  const networkPicker = xcpPicker('network', state.network, (x) => { state.network = x; });

  let safeEntries = null;
  const safeSelect = optionPicker(null, state.safe_entry_id, { placeholder: 'Sélectionner...' });
  safeSelect.addEventListener('change', () => { state.safe_entry_id = safeSelect.value; });
  const productKeySelect = optionPicker(null, v.product_key_entry_id || '', { placeholder: 'Aucune' });
  const refreshSafe = () => {
    if (!safeEntries) return;
    const passwordOnly = isWindows();
    const list = safeEntries.filter((e) => e.is_active && isAccountEntry(e) && (!passwordOnly || e.type === 'password'));
    if (state.safe_entry_id && !list.some((e) => e.id === state.safe_entry_id)) state.safe_entry_id = '';
    safeSelect.setOptions(list.map(safeEntryOption),
      state.safe_entry_id);
    const keys = safeEntries.filter((e) => e.is_active && !isAccountEntry(e));
    const keyId = keys.some((e) => e.id === productKeySelect.value) ? productKeySelect.value : '';
    productKeySelect.setOptions([{ value: '', name: 'Aucune' }, ...keys.map((e) => ({ value: e.id, name: e.name }))], keyId);
  };
  api('/safe').then((rows) => { safeEntries = rows; refreshSafe(); }).catch(() => { safeEntries = []; refreshSafe(); });

  const hostnameInput = text(v.hostname);
  const syncDiskPlaceholder = () => { diskNameInput.placeholder = `disk-${hostnameInput.value.trim() || '<nom d’hôte>'}`; };
  hostnameInput.addEventListener('input', syncDiskPlaceholder);
  syncDiskPlaceholder();
  const timezoneSelect = scrollSelect(TIMEZONES, v.timezone || 'Europe/Paris');
  const localeSelect = scrollSelect(LOCALES, v.locale || (isWindows() ? 'en_US.UTF-8' : 'fr_FR.UTF-8'));
  const keyboardSelect = scrollSelect(KEYBOARD_LAYOUTS, v.keyboard_layout || 'fr');
  const uiLanguageSelect = scrollSelect(WINDOWS_UI_LANGUAGES, v.windows_ui_language || 'fr-FR');
  const uiLanguageGroup = group('Langue OS', uiLanguageSelect);
  const dhcpToggle = checkbox(v.network_mode ? v.network_mode === 'dhcp' : !src || !v.network_static_ip);
  const ipv6Toggle = checkbox(v.ipv6_enabled === 'true');
  const updateToggle = checkbox(v.os_update === 'true');
  const swapToggle = checkbox(v.swap_enabled === 'true');
  const swapSizeInput = h('input', { type: 'number', value: v.swap_size_gb || 2, min: 1, max: 64 });
  const ipInput = text(v.network_static_ip ? `${v.network_static_ip}${v.network_cidr ? `/${v.network_cidr}` : ''}` : '',
    { placeholder: '192.168.1.10/24' });
  const gatewayInput = text(v.network_gateway, { placeholder: '192.168.1.1' });
  const dnsInput = text(v.network_dns, { placeholder: '1.1.1.1,9.9.9.9' });
  const staticRow = row(group('Adresse IP / CIDR *', ipInput),
    group('Passerelle', gatewayInput), group('DNS', dnsInput));
  const refreshNetwork = () => { staticRow.hidden = dhcpToggle.checked; };
  dhcpToggle.addEventListener('change', refreshNetwork);
  const packagesInput = text(v.additional_packages);
  const commandsInput = commandsTextarea(v.additional_commands);
  const imageIndexSelect = select([
    ['1', '1 — Standard (Core)'], ['2', '2 — Standard (Desktop Experience)'],
    ['3', '3 — Datacenter (Core)'], ['4', '4 — Datacenter (Desktop Experience)'],
  ], String(v.windows_image_index || '2'));
  const powershellInput = commandsTextarea(v.powershell_commands);
  const cloudbaseSelect = select([
    ['true', 'Cloudbase-init installé, puis sysprep'],
    ['false', 'Sysprep seul'],
  ], String(v.cloudbase_init ?? (src ? 'false' : 'true')));

  const swapSizeGroup = group('Taille du swap (Go)', swapSizeInput);
  const refreshSwap = () => { swapSizeGroup.hidden = !swapToggle.checked; };
  swapToggle.addEventListener('change', refreshSwap);
  refreshSwap();
  const swapSection = section('Swap',
    row(group('Swap', toggleSwitch(swapToggle, 'Fichier d\'échange')), swapSizeGroup));
  const linuxSoftware = section('Logiciels et commandes',
    row(group('Paquets supplémentaires', packagesInput, tipLines(['Format', 'Noms des paquets séparés par des virgules, 50 paquets maximum.'],
      ['Échec', 'Tout paquet introuvable entraîne l\'échec du build.']), true)),
    row(group('Commandes supplémentaires', commandsInput, tipLines(['Format', 'Une commande par ligne, 20 lignes maximum.'],
      ['Échec', 'Toute commande en erreur entraîne l\'échec du build.']), true)));
  const windowsSections = [
    section('Configuration Windows',
      row(group('Édition (index de l\'image ISO)', imageIndexSelect), group('Clé de produit (coffre-fort)', productKeySelect))),
    section('Déploiement OpenTofu',
      row(group('Préparer pour OpenTofu', cloudbaseSelect, tipLines(
        ['Cloudbase-init installé, puis sysprep', 'Le template contient cloudbase-init, OpenTofu peut configurer chaque VM au premier démarrage (nom, réseau, comptes, commandes).'],
        ['Sysprep seul', 'La VM démarre sans cette personnalisation, à configurer à la main.'])))),
  ];
  const windowsScripts = section('Scripts',
    row(group('Commandes PowerShell', powershellInput, tipLines(
      ['Format', 'Une commande par ligne, 20 lignes maximum.'],
      ['Échec', 'Toute commande en erreur entraîne l’échec du build.']), true)));
  const updateOs = () => {
    linuxSoftware.hidden = isWindows();
    swapSection.hidden = isWindows();
    uiLanguageGroup.hidden = !isWindows();
    windowsSections.forEach((s) => { s.hidden = !isWindows(); });
    windowsScripts.hidden = !isWindows();
    refreshSafe();
  };

  const tabs = formTabs([
    ['Général', h('div', {},
      section('Système',
        row(group('Nom du profil *', nameInput, tipLines(
          ['Définition', 'Le template est créé au format ', h('code', {}, 'packer-<nom du profil>'), ', en minuscules.'],
          ['Format', 'Les caractères autres que les lettres, les chiffres et les tirets sont remplacés par des tirets.'],
          ['Renommage', 'Toute modification du nom du profil entraîne un changement du nom du prochain template généré.'])), group('Description', descInput),
          group('Étiquettes', tagsInput, tipLines(['Format', 'Étiquettes séparées par des virgules.'],
            ['Template', 'Posées sur la VM de build, donc sur le template.'])))),
      section('Source de construction',
        catalogPicker,
        row(group('Conserver la VM de build', keepVmSelect, keepVmHelp()),
          group('Template existant', existingTemplateSelect, tipLines(
            ['Refuser si le template existe', 'Le build s\'arrête avant Packer si un template du même nom existe sur XCP-ng.'],
            ['Remplacer', 'Après un build réussi, l\'ancien template est supprimé ; ses disques restent sur le SR, sans VM rattachée.'],
            ['Remplacer et supprimer ses disques', 'Comme Remplacer, puis les disques de l\'ancien template sont supprimés du SR.'],
            ['Fast clones', 'Les VM déployées en fast clone depuis l\'ancien template ne sont pas touchées ; l\'espace de leur disque de base n\'est libéré qu\'à la suppression de la dernière.'],
            ['Échec du build', 'L\'ancien template et ses disques sont conservés.']))),
        row(group('Coffre-fort *', safeSelect, tipLines(['Définition', 'Compte utilisateur créé lors de l\'installation du système et utilisé par Packer '
          + 'pour se connecter à la VM de build et exécuter les scripts de configuration.'])),
          group('Compte utilisateur', toggleSwitch(removeBuildUser, 'Supprimé à la fin de la construction')))))],
    ['Machine virtuelle', h('div', {},
      section('Ressources',
        row(group('vCPU', vcpusInput), group('Topologie CPU', coresSelect), group('Mémoire (Mo)', memoryInput)),
        row(group('Disque (Go)', diskInput),
          group('Nom du disque', diskNameInput))),
      section('Stockage et réseau',
        row(group('SR (ISO) *', srIsoSelect, tipLines(
          ['Définition', 'Storage Repository XCP-ng dans lequel l\'ISO d\'installation est téléversée et stockée pendant le build.'],
          ['Utilisation', 'L\'ISO est utilisée comme support d\'installation du système d\'exploitation.'],
          ['Liste', 'SR dont le nom est partagé masqués : le plugin Packer désigne un SR par son nom.'])),
          group('SR (disque) *', srSelect, tipLines(
          ['Définition', 'Storage Repository XCP-ng utilisé pour héberger le disque de la VM de build.'],
          ['Conservation', 'Le template obtenu à l\'issue du build est stocké sur ce SR.'],
          ['Liste', 'SR dont le nom est partagé masqués : le plugin Packer désigne un SR par son nom.']))),
        row(group('Réseau *', networkPicker),
          group('NIC type', nicTypeSelect, tipLines(['Build', 'Carte réseau de la VM de build : l’installeur doit en avoir le pilote.'])))),
      section('Matériel virtuel',
        row(group('Firmware de démarrage', firmwareSelect), secureBootGroup),
        row(group('VGA', toggleSwitch(vgaToggle, 'Adaptateur standard')), videoramGroup)))],
    ['Configuration OS', h('div', {},
      section('Identité',
        row(group("Nom d'hôte *", hostnameInput, tipLines(
          ['Valeur', 'Nom d\'hôte donné au système pendant le build, tel que saisi.'],
          ['Windows', 'Nom de l’ordinateur limité à 15 caractères.'])), uiLanguageGroup),
        row(group('Fuseau horaire', timezoneSelect), group('Locale', localeSelect), group('Clavier', keyboardSelect))),
      section('Réseau',
        row(group('DHCP', toggleSwitch(dhcpToggle, 'Adresse obtenue par DHCP')),
          group('IPv6', toggleSwitch(ipv6Toggle, 'Activer IPv6'))),
        staticRow),
      section('Mise à jour',
        row(h('div', { class: 'form-group full' }, toggleSwitch(updateToggle, 'Mise à jour de l\'OS pendant le build')))),
      swapSection,
      ...windowsSections)],
    ['Post-Installation', h('div', {},
      linuxSoftware,
      windowsScripts)],
  ]);

  let close;
  const form = h('form', { onsubmit: guard(async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { tabs.show(0); toast('Le nom du profil est obligatoire'); return; }
    if (!state.clone_template) { tabs.show(0); toast('Sélectionnez le template à cloner'); return; }
    if (!state.iso_url) { tabs.show(0); toast('Sélectionnez un OS et une version dans le catalogue'); return; }
    const dhcp = dhcpToggle.checked;
    if (!dhcp && !ipInput.value.trim()) { tabs.show(2); toast('L\'adresse IP est obligatoire en IP fixe'); return; }
    if (!dhcp && !/^[^/\s]+\/\d{1,2}$/.test(ipInput.value.trim())) {
      tabs.show(2); toast('Adresse IP : format IP/CIDR attendu, par exemple 192.168.1.10/24'); return;
    }
    if (!hostnameInput.value.trim()) { tabs.show(2); toast('Le nom d\'hôte est obligatoire'); return; }
    const win = isWindows();
    if (!safeSelect.value) { tabs.show(0); toast('Sélectionnez une entrée du coffre-fort'); return; }
    if (!state.sr_iso_uuid) { tabs.show(1); toast('Sélectionnez le SR ISO'); return; }
    const diskGb = Number(diskInput.value);
    if (!(Number.isInteger(diskGb) && diskGb >= 1 && diskGb <= 16384)) {
      tabs.show(1); toast('Disque : nombre entier de Go entre 1 et 16384'); return;
    }
    if (win && diskGb < 32) { tabs.show(1); toast('Disque : 32 Go minimum pour Windows Server'); return; }
    const swapSize = Number(swapSizeInput.value);
    if (!win && swapToggle.checked && !(Number.isInteger(swapSize) && swapSize >= 1 && swapSize <= 64)) {
      tabs.show(2); toast('Taille du swap : entier entre 1 et 64 Go'); return;
    }
    const vars = {
      sr_uuid: state.sr_uuid,
      sr_iso_uuid: state.sr_iso_uuid,
      clone_template: state.clone_template,
      iso_url: state.iso_url,
      iso_checksum: state.iso_checksum,
      vm_name: `packer-${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 63),
      vm_description: descInput.value.trim(),
      vcpus: Number(vcpusInput.value),
      cores_per_socket: String(coresValue),
      vm_memory: Number(memoryInput.value),
      disk_size: diskGb * 1024,
      disk_name: diskNameInput.value.trim(),
      tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean).join(','),
      nic_type: nicTypeSelect.value,
      vga: String(vgaToggle.checked),
      ...(vgaToggle.checked ? { videoram: videoramSelect.value } : {}),
      network: state.network,
      os_type: state.osType,
      existing_template: existingTemplateSelect.value,
      remove_build_user: String(removeBuildUser.checked),
      keep_vm: keepVmSelect.value,
      firmware: firmwareSelect.value,
      secure_boot: String(firmwareSelect.value === 'uefi' && secureBoot.checked),
      safe_entry_id: safeSelect.value,
      hostname: hostnameInput.value.trim(),
      timezone: timezoneSelect.value,
      locale: localeSelect.value,
      keyboard_layout: keyboardSelect.value,
      network_mode: dhcp ? 'dhcp' : 'static',
      ipv6_enabled: String(ipv6Toggle.checked),
      os_update: String(updateToggle.checked),
      ...(dhcp ? {} : {
        network_static_ip: ipInput.value.trim(),
        network_gateway: gatewayInput.value.trim(),
        network_dns: dnsInput.value.trim(),
      }),
      ...(win ? {
        product_key_entry_id: productKeySelect.value,
        windows_image_index: imageIndexSelect.value,
        windows_ui_language: uiLanguageSelect.value,
        powershell_commands: powershellInput.value,
        cloudbase_init: cloudbaseSelect.value,
      } : {
        swap_enabled: String(swapToggle.checked),
        ...(swapToggle.checked ? { swap_size_gb: String(swapSize) } : {}),
        additional_packages: packagesInput.value.trim(),
        additional_commands: commandsInput.value,
      }),
    };
    await api(existing ? `/profiles/${existing.id}` : '/profiles', {
      method: existing ? 'PUT' : 'POST',
      body: { name, description: descInput.value.trim(), vars, ...(copy?.copy_from ? { copy_from: copy.copy_from } : {}) },
    });
    close();
    onSaved();
  }) },
  tabs.bar,
  tabs.body,
  formActions(() => close(), existing ? 'Enregistrer' : 'Créer'));

  close = openModal(existing ? `Profil : ${existing.name}` : copy ? 'Copie de profil' : 'Nouveau profil', form, {
    size: 'wide3',
    subtitle: copy ? `Packer · copie de « ${copy.sourceName} »`
      : existing?.vars?.vm_name ? `Packer · template ${existing.vars.vm_name}` : 'Packer · construction d’un template' });
  updateOs();
  refreshNetwork();
}
