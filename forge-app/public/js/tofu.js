import { app, view } from './page.js';
import { actionIcon, h, toast } from './dom.js';
import { api, batch, guard, pagedSource } from './api.js';
import { emptyCell, oneLine, stack, tipLines, when } from './display.js';
import { dataTable, groupFilters } from './table.js';
import { deleteConfirm, openModal } from './modal.js';
import { checkbox, formActions, formTabs, group, repeatList, row, section, toggleSwitch } from './forms.js';
import { optionPicker, scrollSelect, searchPicker, srPicker, xcpPicker } from './pickers.js';
import { yamlEditor } from './yaml-editor.js';
import { KEYBOARD_LAYOUTS, LOCALES, TIMEZONES } from './regional.js';
import { isAccountEntry, safeEntryOption } from './safe-entries.js';
import { cloneProfile, lastJobCell, profileIdle, profilesCard } from './distributions.js';
import { launchMany } from './jobs.js';

const tofuDeployed = (p) => (p.state?.resources || 0) > 0;
const TOFU_STATE_JOBS = ['apply', 'import', 'destroy'];
function tofuStateCell(p) {
  if (TOFU_STATE_JOBS.includes(p.activeJob?.action)) return emptyCell();
  if (!tofuDeployed(p)) return h('span', { class: 'badge disabled' }, 'non déployée');
  const ips = p.state.vm?.ipv4?.join(', ');
  if (ips) return h('span', { class: 'badge active badge-ip', title: ips }, ips);
  const power = p.state.vm?.power;
  const seen = 'État lu à la dernière opération OpenTofu (Importer, Valider, Construire).';
  if (power === 'Halted') return h('span', { class: 'badge disabled', title: `VM éteinte : aucune IP. ${seen}` }, 'arrêtée');
  if (power === 'Paused' || power === 'Suspended') return h('span', { class: 'badge disabled', title: `VM en pause ou suspendue. ${seen}` }, 'suspendue');
  return h('span', { class: 'badge warn', title: `VM démarrée sans IP : agent invité absent ou IP pas encore remontée. ${seen}` }, 'sans IP');
}

export async function pageTofuProfiles(gen = view.pageGen) {
  const deployedVm = (p) => p.state?.vm?.name || p.vars.vm_name;
  const t = await dataTable({
    key: 'tofu-profiles',
    source: pagedSource('/tofu/profiles'),
    filters: groupFilters([['deployed', 'VM déployée', 'success'], ['undeployed', 'Non déployée', 'cancelled']]),
    card: profilesCard('tofu'),
    search: true,
    empty: 'Aucun profil OpenTofu : créez-en un pour déployer une VM.',
    create: { label: 'Ajouter', run: () => tofuProfileModal(null) },
    tools: h('button', { class: 'btn', onclick: () => importVmModal() }, actionIcon('Importer'), 'Importer'),
    poll: 5000,
    columns: [
      ['Profil', (p) => stack(p.name), '14%', 'name'],
      ['Description', (p) => (p.description ? oneLine(p.description) : emptyCell()), '14%', 'description'],
      ['VM', (p) => (p.vars.vm_name ? oneLine(p.vars.vm_name) : emptyCell()), '13%', 'vm'],
      ['Template source', (p) => (p.vars.source_template ? oneLine(p.vars.source_template) : emptyCell()), '13%', 'source'],
      ['État', tofuStateCell, '13%'],
      ['Dernier job', lastJobCell('tofu'), '11%', 'last_job:desc'],
      ['Validation', (p) => when(p.planned_at), '11%', 'validated:desc'],
      ['Construction', (p) => when(p.applied_at), '11%', 'built:desc'],
    ],
    actions: [
      { label: 'Modifier', when: 'one', reload: false, run: ([p]) => tofuProfileModal(p) },
      { label: 'Cloner', when: 'one', reload: false, run: ([p]) => cloneProfile('/tofu/profiles', p, tofuProfileModal) },
      { label: 'Valider', when: 'many', allow: profileIdle, run: (sel) => launchMany('tofu', 'plan', sel) },
      { label: 'Construire', when: 'many', allow: profileIdle,
        confirm: (sel) => {
          if (sel.length > 1) {
            return { title: 'Construire les VMs',
              message: `Lancer la construction de ${sel.length} profils ? Les VMs absentes seront créées, les VMs déployées alignées sur leur profil (redémarrage possible).` };
          }
          const [p] = sel;
          return tofuDeployed(p)
            ? { title: 'Mettre à jour la VM',
              message: `Lancer la construction de « ${p.name} » ? La VM « ${p.vars.vm_name} » sera alignée sur le profil (un changement de ressources peut la redémarrer).` }
            : { title: 'Construire la VM',
              message: [`Lancer la construction de ${p.name} ?`, `La VM ${p.vars.vm_name} sera créée sur XCP-ng depuis le modèle ${p.vars.source_template}.`] };
        },
        run: (sel) => launchMany('tofu', 'apply', sel) },
      { label: 'Supprimer', when: 'many', danger: true, allow: profileIdle,
        confirm: (sel) => {
          const kept = sel.filter(tofuDeployed).map(deployedVm);
          return deleteConfirm(sel, ['le profil', 'les profils'], (p) => p.name, [
            'Le profil et son état OpenTofu seront définitivement supprimés.',
            ...(kept.length ? [`VM conservée sur XCP-ng, hors de Forge : ${kept.map((n) => `« ${n} »`).join(', ')}. `
              + 'Elle n\'est ni arrêtée ni supprimée ; « Importer une VM » permet de la reprendre. Les cibles Ansible qui la visent devront être modifiées.'] : []),
          ]);
        },
        run: (sel) => batch('/tofu/profiles/batch', 'delete', sel) },
      { label: 'Détruire', when: 'many', danger: true,
        allow: (p) => (tofuDeployed(p) ? profileIdle(p) : 'Aucune VM déployée par ce profil'),
        confirm: (sel) => (sel.length > 1
          ? { title: 'Détruire les VMs',
            message: [`Voulez-vous vraiment détruire ${sel.length} VMs ? TOUS LES DISQUES DES VMS SERONT SUPPRIMÉS.`,
              sel.map(deployedVm).join(', ')],
            typed: `delete ${sel.length} vms` }
          : { title: 'Détruire la VM',
            message: [`Lancer la destruction de « ${deployedVm(sel[0])} » ? La VM et ses disques seront SUPPRIMÉS définitivement de XCP-ng.`,
              ...(sel[0].vars.imported === 'true' ? ['Cette VM a été importée : elle n\'a pas été créée par Forge.'] : [])],
            typed: deployedVm(sel[0]) }),
        run: (sel) => launchMany('tofu', 'destroy', sel) },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}

const CLOUD_INIT_EXAMPLE = `#cloud-config
hostname: web-01
fqdn: web-01.localdomain
manage_etc_hosts: true
timezone: Europe/Paris
locale: fr_FR.UTF-8

disable_root: true
ssh_pwauth: false
users:
  - name: deploy
    gecos: Administration
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... deploy@poste

growpart:
  mode: auto
  devices: ["/"]
resize_rootfs: true

package_update: true
package_upgrade: false
packages:
  - nginx
  - htop

write_files:
  - path: /etc/motd
    content: |
      Serveur déployé par OpenTofu

runcmd:
  - systemctl enable --now nginx

final_message: "cloud-init terminé en $UPTIME secondes"`;

const CLOUDBASE_INIT_EXAMPLE = `#cloud-config
set_hostname: WEB-01
set_timezone: Romance Standard Time

users:
  - name: admin
    gecos: Administration
    groups: Administrators
    passwd: MotDePasse!aChanger
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... admin@poste

write_files:
  - path: C:\\Scripts\\lisezmoi.txt
    content: Serveur déployé par OpenTofu

runcmd:
  - powershell -Command "Install-WindowsFeature Web-Server -IncludeManagementTools"
  - powershell -Command "Set-NetFirewallRule -DisplayGroup 'Partage de fichiers et d''imprimantes' -Enabled True"`;

function tofuProfileModal(existing, copy = null) {
  const src = existing || copy;
  view.srPromise = null;
  view.networksPromise = null;
  const v = src?.vars || {};
  const deployed = !!existing && tofuDeployed(existing);
  const shutdownProtected = deployed && v.protect_shutdown === 'true';
  const IMPACTS = {
    hot: 'Modifiable à chaud, sans redémarrage de la VM',
    reboot: 'Modification avec redémarrage de la VM',
  };
  const dot = (kind) => h('span', { class: `impact-dot impact-${kind}`, title: IMPACTS[kind], 'aria-label': IMPACTS[kind] });
  const impact = (label, kind) => (deployed ? h('span', { class: 'impact-label' }, dot(kind), label) : label);
  const LOCKED = 'Non modifiable : la VM est déployée. Cloner le profil pour déployer une nouvelle VM avec une autre valeur';
  const IMPORTED_LOCKED = 'Non modifiable : VM importée, Forge n\'a pas fait son premier démarrage';
  const importedProfile = !!existing && v.imported === 'true';
  const lock = (el, reason = LOCKED, when = deployed) => {
    if (!when) return el;
    el.classList.add('is-locked');
    el.title = reason;
    el.querySelectorAll('input, select, textarea, button').forEach((c) => { c.disabled = true; });
    return el;
  };
  const RESTART_TIP = () => tipLines(['Impact', 'Un changement arrête puis redémarre la VM.']);
  const NEXT_BOOT_TIP = () => tipLines(['Impact', 'Appliqué au prochain démarrage de la VM.']);
  const PROTECTED = 'VM protégée contre l\'arrêt : désactiver « Protect from accidental shutdown », enregistrer et construire avant de modifier ce paramètre';
  const picked = {
    source_template: v.source_template || '',
    sr_uuid: v.sr_uuid || '',
    network: v.network || '',
  };
  const text = (value, attrs = {}) => h('input', { type: 'text', value: value ?? '', ...attrs });
  const select = (pairs, selected) => scrollSelect(pairs, selected);

  const nameInput = text(src?.name, { maxlength: 100 });
  const descInput = text(src?.description, { maxlength: 500 });
  const templatePicker = xcpPicker('template', picked.source_template, (x) => { picked.source_template = x; });
  const srSelect = srPicker('disk', picked.sr_uuid, (x) => { picked.sr_uuid = x; });
  const networkPicker = xcpPicker('network', picked.network, (x) => { picked.network = x; });
  const osTypeSelect = select([['', '— Non configuré —'], ['linux', 'Linux (cloud-init)'], ['windows', 'Windows (cloudbase-init)']],
    v.os_type || '');
  osTypeSelect.addEventListener('change', () => updateOs());
  const vmNameInput = text(v.vm_name, { maxlength: 128 });
  const vmDescInput = text(v.vm_description, { maxlength: 1000 });
  const vcpusInput = h('input', { type: 'number', value: v.vcpus || 1, min: 1, max: 128 });
  const memoryInput = h('input', { type: 'number', value: v.vm_memory || 2048, min: 256, step: 256 });
  const diskInput = h('input', { type: 'number', value: v.disk_size || 10, min: 1, step: 1 });
  const diskNameInput = text(v.disk_name, { maxlength: 128 });
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
  const OS_DEFAULTS = { linux: { vcpus: 1, memory: 2048, disk: 10 }, windows: { vcpus: 2, memory: 4096, disk: 32 } };
  if (!src) osTypeSelect.addEventListener('change', () => {
    const d = OS_DEFAULTS[osTypeSelect.value];
    if (!d) return;
    vcpusInput.value = d.vcpus;
    memoryInput.value = d.memory;
    diskInput.value = d.disk;
    coresValue = 1;
    updateCores();
  });
  const extraDisks = repeatList({
    items: v.extra_disks || [],
    max: 100,
    addLabel: 'Ajouter un disque',
    make: (d) => {
      let sr = d.sr_uuid || '';
      const nameInput = text(d.name, { maxlength: 128 });
      const sizeInput = h('input', { type: 'number', value: d.size_gb || 10, min: 1, max: 16384, step: 1 });
      return {
        fields: [group('Nom', nameInput), group('Stockage (SR)', srPicker('disk', sr, (x) => { sr = x; })), group('Taille (Go)', sizeInput)],
        value: () => ({ name: nameInput.value.trim(), sr_uuid: sr, size_gb: Number(sizeInput.value) }),
      };
    },
  });
  extraDisks.list.classList.add('row-list', 'disk-list');
  const extraNetworks = repeatList({
    items: v.extra_networks || [],
    max: 15,
    addLabel: 'Ajouter une interface',
    make: (n) => {
      let network = n.network || '';
      const ipInput = text(n.ip ? `${n.ip}${n.cidr ? `/${n.cidr}` : ''}` : '', { placeholder: '10.0.0.10/24' });
      return {
        fields: [group('Réseau', xcpPicker('network', network, (x) => { network = x; })),
          group('Adresse IP', ipInput, tipLines(['Format', 'Adresse et préfixe CIDR, par exemple ', h('code', {}, '10.0.0.10/24'), '.']))],
        value: () => ({ network, ip: ipInput.value.trim() }),
      };
    },
  });
  extraNetworks.list.classList.add('row-list', 'network-list');
  const affinityBase = (master) => [{ value: '', name: 'Aucun (défaut)' },
    { value: '__master__', name: master ? `Master du pool : ${master.name}` : 'Master du pool' }];
  const affinitySelect = optionPicker(null, v.affinity_host || '',
    { placeholder: 'Aucun (défaut)', missing: `${v.affinity_host} (introuvable dans le pool)` });
  api('/xcp/pool-hosts').then((hosts) => {
    const master = hosts.find((x) => x.master);
    affinitySelect.setOptions([...affinityBase(master), ...hosts.filter((x) => !x.master).map((x) => ({ value: x.name, name: x.name, meta: x.meta }))],
      master && affinitySelect.value === master.name ? '__master__' : affinitySelect.value);
  }).catch(() => affinitySelect.setOptions(affinityBase(null)));
  const autoPowerOnToggle = checkbox(v.auto_poweron !== 'false');
  const protectDeleteToggle = checkbox(v.protect_delete === 'true');
  const protectShutdownToggle = checkbox(v.protect_shutdown === 'true');
  const preventMigrationToggle = checkbox(v.prevent_migration === 'true');
  const citrixDriversToggle = checkbox(v.citrix_pv_drivers === 'true');
  const vgaToggle = checkbox(v.vga !== 'false');
  const haSelect = select([['', 'Disabled'], ['best-effort', 'best-effort'], ['restart', 'restart']], v.high_availability || '');
  const nicTypeSelect = select([['rtl8139', 'Realtek RTL8139'], ['e1000', 'Intel e1000']], v.nic_type || 'rtl8139');
  const videoramSelect = select(['1', '2', '4', '8', '16'].map((mib) => [mib, `${mib} MiB`]), String(v.videoram || '8'));
  const firmwareSelect = select([['bios', 'bios'], ['uefi', 'uefi']], v.boot_firmware || 'bios');
  const secureBootToggle = checkbox(v.secure_boot === 'true');
  const secureBootGroup = lock(group('Secure Boot', toggleSwitch(secureBootToggle, 'Activé'), tipLines(
    ['Prérequis', 'Boot firmware uefi, certificats Secure Boot installés sur le pool XCP-ng.'],
    ['Compatibilité', 'Le système du modèle source doit démarrer avec un chargeur signé, sinon la VM ne démarre pas.'])));
  const refreshSecureBoot = () => { secureBootGroup.hidden = firmwareSelect.value !== 'uefi'; };
  firmwareSelect.addEventListener('change', refreshSecureBoot);
  refreshSecureBoot();
  const videoramGroup = group(impact('Video RAM', 'hot'), videoramSelect);
  const citrixDriversGroup = lock(group(impact('Manage Citrix PV drivers via Windows Update', 'reboot'),
    toggleSwitch(citrixDriversToggle, 'Pilotes par Windows Update'), RESTART_TIP()), PROTECTED, shutdownProtected);
  const refreshVga = () => { videoramGroup.hidden = !vgaToggle.checked; };
  vgaToggle.addEventListener('change', refreshVga);
  const xenSettingsPane = h('div', {},
    section('Disponibilité',
      row(group(impact('Auto power on', 'hot'), toggleSwitch(autoPowerOnToggle, 'Démarrer avec l\'hôte')),
        group(impact('HA', 'hot'), haSelect, tipLines(['best-effort', 'La VM est redémarrée si le pool en a les ressources.'],
          ['restart', 'Le redémarrage de la VM est garanti par le pool.'], ['Prérequis', 'HA activée sur le pool XCP-ng.'])),
        group(impact("Hôte d'affinité", 'hot'), affinitySelect, tipLines(['Définition', 'Hôte du pool sur lequel la VM démarre de préférence.'],
          ['Aucun', 'XCP-ng choisit l’hôte.'])))),
    section('Protections',
      row(group(impact('Prevent migration', 'hot'), toggleSwitch(preventMigrationToggle, 'Migration bloquée')),
        group(impact('Protect from accidental deletion', 'hot'), toggleSwitch(protectDeleteToggle, 'Suppression bloquée')),
        group(impact('Protect from accidental shutdown', 'hot'), toggleSwitch(protectShutdownToggle, 'Arrêt et redémarrage bloqués')))),
    section('Matériel virtuel',
      row(lock(group(impact('NIC type', 'reboot'), nicTypeSelect, RESTART_TIP()), PROTECTED, shutdownProtected),
        lock(group('Boot firmware', firmwareSelect, tipLines(['Compatibilité', 'Identique au modèle source.']))),
        secureBootGroup),
      row(group(impact('VGA', 'hot'), toggleSwitch(vgaToggle, 'Adaptateur standard'), NEXT_BOOT_TIP()),
        videoramGroup),
      row(citrixDriversGroup)));
  const resourceSetInput = text(v.resource_set, { maxlength: 255 });
  const sharedVm = deployed && existing.state?.vm?.share === true;
  const shareSelect = select([...(sharedVm ? [] : [['false', 'Non']]), ['true', 'Oui : membres du groupe']],
    sharedVm ? 'true' : String(v.resource_set_share ?? 'false'));
  const subjectsPromise = api('/xo/subjects');
  subjectsPromise.catch(() => {});
  const roleLabels = [['viewer', 'Lecture (viewer)'], ['operator', 'Opérateur (operator)'], ['admin', 'Administrateur (admin)']];
  const acls = repeatList({
    items: v.acls || [],
    max: 20,
    addLabel: 'Ajouter une ACL',
    make: (a) => {
      const subjectSelect = optionPicker(null, a.subject || '', { placeholder: 'Sélectionner...', missing: `${a.subject} (introuvable dans XO)` });
      subjectsPromise.then((subjects) => subjectSelect.setOptions(subjects.map((x) => ({
        value: x.id, name: `${x.type === 'group' ? 'Groupe' : 'Utilisateur'} : ${x.name}`, meta: x.meta || '',
      })))).catch(() => subjectSelect.setOptions([]));
      const roleSelect = select(roleLabels, a.role || 'viewer');
      return {
        fields: [group('Utilisateur ou groupe XO', subjectSelect), group('Rôle', roleSelect)],
        value: () => ({ subject: subjectSelect.value, role: roleSelect.value }),
      };
    },
  });
  acls.list.classList.add('row-list', 'acl-list');
  const destroyDriveSelect = select([
    ['false', 'Non'],
    ['true', 'Oui'],
  ], String(v.destroy_cloud_config ?? 'true'));
  const tagsInput = text(v.tags, { maxlength: 3249 });
  const waitIpSelect = select([
    ['true', 'Oui'],
    ['false', 'Non'],
  ], String(v.wait_for_ip ?? 'true'));
  const cloneTypeSelect = select([
    ['full', 'Disque dédié (copie complète)'],
    ['fast', 'Fast clone (copy-on-write)'],
  ], v.clone_type || 'full');

  const safeSelect = optionPicker(null, v.safe_entry_id || '', { placeholder: 'Sélectionner...', missing: 'Entrée supprimée ou inutilisable' });
  api('/safe').then((rows) => safeSelect.setOptions(safeAccountOptions(rows))).catch(() => safeSelect.setOptions([]));
  const dhcpToggle = checkbox(v.network_mode ? v.network_mode === 'dhcp' : !v.network_static_ip);
  const ipInput = text(v.network_static_ip ? `${v.network_static_ip}${v.network_cidr ? `/${v.network_cidr}` : ''}` : '',
    { placeholder: '192.168.1.10/24' });
  const gatewayInput = text(v.network_gateway, { placeholder: '192.168.1.1' });
  const dnsInput = text(v.network_dns, { placeholder: '1.1.1.1,9.9.9.9' });
  const staticRow = row(group('Adresse IP *', ipInput),
    group('Passerelle', gatewayInput), group('DNS', dnsInput));
  const refreshNetwork = () => { staticRow.hidden = dhcpToggle.checked; };
  dhcpToggle.addEventListener('change', refreshNetwork);
  const hostnameInput = text(v.hostname);
  const timezoneSelect = scrollSelect(TIMEZONES, v.timezone || 'Europe/Paris');
  const localeSelect = scrollSelect(LOCALES, v.locale || 'fr_FR.UTF-8');
  const keyboardSelect = scrollSelect(KEYBOARD_LAYOUTS, v.keyboard_layout || 'fr');
  const upgradeToggle = checkbox(v.package_upgrade === 'true');
  const disableAdminToggle = checkbox(v.disable_builtin_admin !== 'false');
  const windowsDefault = (key) => (src ? v[key] === 'true' : true);
  const neverExpiresToggle = checkbox(windowsDefault('password_never_expires'));
  const winrmHttpsToggle = checkbox(windowsDefault('winrm_https'));
  const rdpToggle = checkbox(windowsDefault('rdp_enabled'));
  const ntpInput = text(v.ntp_servers);
  const packagesInput = text(v.additional_packages);
  const commandsInput = h('textarea', { rows: 20, value: v.additional_commands || '' });
  const powershellInput = h('textarea', { rows: 20, value: v.powershell_commands || '' });
  const cleanupToggle = checkbox(v.cleanup_first_boot !== 'false');
  const powershellTimeoutInput = h('input', { type: 'number', value: v.powershell_timeout ?? 30, min: 0, max: 1440, step: 10 });
  const cloudInitInput = yamlEditor(h('textarea', { class: 'code-input', rows: 24, spellcheck: 'false', value: v.cloud_init_yaml || '' }));

  const osTexts = [];
  const osText = (linux, windows) => {
    const el = h('span', {}, linux);
    osTexts.push([el, linux, windows]);
    return el;
  };

  const windowsAccessGroups = [
    group('Administrator intégré', toggleSwitch(disableAdminToggle, 'Désactivé'),
      tipLines(['Désactivé', 'Le compte Administrator de Windows est désactivé ; le compte du coffre-fort sert à l’administration.'])),
    group('Expiration du mot de passe', toggleSwitch(neverExpiresToggle, 'Mot de passe sans expiration')),
    group('WinRM HTTPS', toggleSwitch(winrmHttpsToggle, 'Activer (port 5986, certificat auto-signé)'),
      tipLines(['Utilisation', 'Nécessaire pour les connexions Ansible « WinRM HTTPS » vers cette VM.'])),
    group('Bureau à distance (RDP)', toggleSwitch(rdpToggle, 'Activer (port 3389, NLA)')),
  ];
  const linuxGroups = [
    group('Paramètres régionaux', localeSelect),
    group('Clavier', keyboardSelect),
    group('Mise à jour au premier démarrage', toggleSwitch(upgradeToggle, 'Mettre à jour les paquets installés'),
      tipLines(['Définition', 'Mise à jour des paquets installés au premier démarrage, par cloud-init.'],
        ['Noyau', 'Un nouveau noyau n’est actif qu’au redémarrage suivant.']), true),
    group('Paquets supplémentaires', packagesInput, tipLines(['Format', 'Noms des paquets séparés par des virgules.'],
      ['Installation', 'Au premier démarrage, par le gestionnaire de paquets de la distribution.']), true),
    group('Commandes au premier démarrage', commandsInput, tipLines(['Format', 'Une commande par ligne, exécutées dans l’ordre, en root.'],
      ['Exécution', 'Une seule fois, au premier démarrage de la VM.']), true),
  ];
  const windowsGroups = [
    group('Délai maximal des commandes (min)', powershellTimeoutInput, tipLines(['Définition', 'Au-delà, les commandes PowerShell sont interrompues.'],
      ['Valeur 0', 'Sans limite.'])),
    group('Logs et scripts du premier démarrage', toggleSwitch(cleanupToggle, 'Supprimer les logs et les scripts'),
      tipLines(['Activé', 'Scripts et journaux du premier démarrage supprimés à la fin de celui-ci.'],
        ['Journaux Forge', h('code', {}, 'C:\\Windows\\Setup\\Scripts\\tofu-first-boot.log'), ' et ', h('code', {}, 'tofu-commands.log'), '.'],
        ['Journal Cloudbase-Init', h('code', {}, 'C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init\\log\\cloudbase-init.log'), ', jamais supprimé.'])),
    group('Commandes PowerShell au premier démarrage', powershellInput, tipLines(['Format', 'Une commande par ligne, exécutées dans l’ordre.'],
      ['Exécution', 'Une seule fois, au premier démarrage de la VM.']), true),
  ];
  const windowsAccessRow = row(...windowsAccessGroups);
  const osSections = [
    section('Accès',
      row(group('Entrée du coffre-fort *', safeSelect, tipLines(['Définition', 'Compte d’administration créé sur la VM au premier démarrage.'],
        ['Ansible', 'Proposé par défaut pour les cibles Ansible de cette VM.'],
        ['SSH (Linux)', 'Entrée « mot de passe » : connexion SSH par mot de passe autorisée. Entrée « clé SSH » : connexion par clé seulement, compte sans mot de passe.']))),
      windowsAccessRow),
    section('Réseau',
      row(group('DHCP', toggleSwitch(dhcpToggle, 'Adresse obtenue par DHCP'),
        tipLines(['Désactivé', 'Adresse IP fixe à renseigner : IP, CIDR, passerelle et DNS.']))),
      staticRow),
    section('Système',
      row(group(osText("Nom d'hôte", "Nom de l'ordinateur"), hostnameInput, tipLines(['Par défaut', 'Nom de la VM.'],
          ['Windows', 'Nom de l’ordinateur limité à 15 caractères.'])), group('Fuseau horaire', timezoneSelect),
        group('Serveurs de temps (NTP)', ntpInput, tipLines(['Format', 'Serveurs séparés par des virgules.'], ['Vide', 'Réglage du système conservé.']))),
      row(linuxGroups[0], linuxGroups[1])),
    section('Premier démarrage',
      row(linuxGroups[2], windowsGroups[1])),
  ];
  const linuxSoftware = section('Logiciels et commandes',
    row(linuxGroups[3]),
    row(linuxGroups[4]));
  const windowsScripts = section('Scripts',
    row(windowsGroups[0]),
    row(windowsGroups[2]));
  const customTipLinux = h('span', {}, ...tipLines(
    ['Remplace', 'Tout le cloud-init généré par Forge : le contenu du champ est envoyé tel quel.'],
    ['Ignorés, Configuration OS', 'Création du compte de l’entrée du coffre-fort (mot de passe, clés SSH, sudo), connexion SSH par mot de passe, blocage des clés SSH de root, nom d’hôte, fuseau horaire, serveurs NTP, paramètres régionaux, clavier, mise à jour au premier démarrage.'],
    ['Ignorés, Post-Installation', 'Paquets supplémentaires, commandes au premier démarrage.'],
    ['Ignoré aussi', 'Agrandissement de la partition à la taille du disque (growpart).'],
    ['Conservés', 'Réseau (DHCP ou IP fixe, passerelle, DNS, interfaces supplémentaires), suppression du config drive, onglets Machine virtuelle et Xen settings.'],
    ['Coffre-fort', 'L’entrée sert encore aux connexions Ansible : le user-data doit créer ce compte.'],
    ['Format', 'Première ligne #cloud-config.']));
  const customTipWindows = h('span', {}, ...tipLines(
    ['Remplace', 'Tout le user-data généré par Forge, dont son script de premier démarrage : le contenu du champ est envoyé tel quel.'],
    ['Ignorés, Configuration OS', 'Création du compte de l’entrée du coffre-fort et ajout aux Administrateurs, clés SSH, Administrator intégré, expiration du mot de passe, WinRM HTTPS, Bureau à distance, nom de l’ordinateur, fuseau horaire, serveurs NTP, logs et scripts du premier démarrage.'],
    ['Ignorés, Post-Installation', 'Commandes PowerShell et leur délai maximal.'],
    ['Conservés', 'Réseau (DHCP ou IP fixe, passerelle, DNS, interfaces supplémentaires), onglets Machine virtuelle et Xen settings.'],
    ['Config drive', '« Supprimer le config drive » doit être à Non ; le lecteur cidata reste monté dans Windows.'],
    ['Coffre-fort', 'L’entrée sert encore aux connexions Ansible : le user-data doit créer ce compte.'],
    ['Format', 'Première ligne #cloud-config, #ps1_sysnative ou #ps1.']));
  const cloudInitPane = h('div', {},
    section(osText('Cloud-init personnalisées (expert)', 'Cloudbase-init personnalisées (expert)'),
      row(group(osText('Données utilisateur', 'Données utilisateur'), cloudInitInput, h('span', {}, customTipLinux, customTipWindows), true))));
  const isWindows = () => osTypeSelect.value === 'windows';
  const destroyDriveGroup = group('Supprimer le config drive', destroyDriveSelect, tipLines(
    ['Définition', 'Disque qui transmet la configuration (cloud-init ou cloudbase-init) à la VM.'],
    ['Oui', 'Retiré après le premier démarrage.'], ['Non', 'Conservé sur la VM.']));
  const updateOs = () => {
    const win = isWindows();
    linuxGroups.forEach((g) => { g.hidden = win; });
    windowsAccessRow.hidden = !win;
    customTipLinux.hidden = win;
    customTipWindows.hidden = !win;
    linuxSoftware.hidden = win;
    windowsScripts.hidden = !win;
    windowsGroups.forEach((g) => { g.hidden = !win; });
    osTexts.forEach(([el, linux, windows]) => { el.textContent = win ? windows : linux; });
    citrixDriversGroup.hidden = !win;
    osSections.forEach((sec) => sec.querySelectorAll('.form-row').forEach((r) => {
      const empty = [...r.children].every((c) => c.hidden);
      if (empty) { r.hidden = true; r.dataset.osEmpty = '1'; } else if (r.dataset.osEmpty) { r.hidden = false; delete r.dataset.osEmpty; }
    }));
    hostnameInput.maxLength = win ? 15 : 253;
    cloudInitInput.placeholder = win ? CLOUDBASE_INIT_EXAMPLE : CLOUD_INIT_EXAMPLE;
  };

  const headWith = (kind, btn) => (deployed ? h('span', { class: 'impact-label' }, dot(kind), btn) : btn);
  const importedNote = existing && v.imported === 'true'
    ? h('p', { class: 'hint imported-note' }, 'VM importée depuis XCP-ng : Forge n\'a pas fait son premier démarrage. '
      + 'Ces réglages n\'ont pas été appliqués à la VM ; l\'entrée du coffre-fort sert aux connexions (Ansible) et doit correspondre à un compte qui existe déjà sur la VM.')
    : null;
  const tabs = formTabs([
    ['Général', h('div', {},
      section('Général',
        row(group('Nom du profil *', nameInput), group('Description', descInput)),
        row(group(impact('Nom de la VM *', 'hot'), vmNameInput, tipLines(['Définition', 'Nom de la VM dans XCP-ng et Xen Orchestra.'],
          ['Nom d’hôte', 'Utilisé aussi comme nom d’hôte si celui-ci est vide (onglet Configuration OS).'])), group(impact('Description de la VM', 'hot'), vmDescInput),
          group(impact('Étiquettes', 'hot'), tagsInput, tipLines(['Format', 'Étiquettes séparées par des virgules.'],
            ['Groupe self-service', 'Les étiquettes du groupe sont ajoutées à celles-ci.'])))),
      section('Source de construction',
        row(lock(group('Système du modèle *', osTypeSelect, tipLines(['Linux', 'Configuration au premier démarrage par cloud-init.'],
          ['Windows', 'Configuration au premier démarrage par cloudbase-init.']))),
        lock(group('Modèle source *', templatePicker, tipLines(['Définition', 'Template XCP-ng cloné pour créer la VM, par exemple un template construit par Packer.'],
          ['Disque', 'Le disque du profil ne doit pas être plus petit que celui du template.']))))),
      section('Déploiement',
        row(lock(group("Attendre l'IP", waitIpSelect, tipLines(['Oui', 'Le job attend que la VM remonte son adresse IP (IP fixe du profil ou adresse DHCP).'],
          ['Non', 'Le job se termine au démarrage de la VM, sans attendre son adresse.']))), lock(lock(destroyDriveGroup), IMPORTED_LOCKED, importedProfile))))],
    ['Machine virtuelle', h('div', {},
      section('Ressources',
        row(group(impact('Processeurs virtuels (vCPU)', 'reboot'), vcpusInput,
          deployed ? tipLines(['Impact', 'À chaud jusqu’au maximum de vCPU de la VM, redémarrage au-delà.']) : null),
        group(impact('Topologie CPU', 'hot'), coresSelect),
        lock(group(impact('Mémoire (Mo)', 'reboot'), memoryInput), PROTECTED, shutdownProtected))),
      section('Stockage',
        row(lock(group('Stockage (SR) *', srSelect, tipLines(['Définition', 'Storage Repository XCP-ng du disque principal de la VM.']))),
          lock(group('Clone du disque', cloneTypeSelect, tipLines(['Disque dédié', 'Copie complète du disque du modèle : la VM a son propre disque.'],
            ['Fast clone', 'Disque lié à celui du modèle (copy-on-write) : création rapide, sans copie complète.'])))),
        row(lock(group(impact('Disque (Go)', 'reboot'), diskInput, tipLines(['Minimum', 'Au moins la taille du disque du modèle source.'],
          ['Premier démarrage', 'Le système agrandit sa partition à cette taille.'], deployed && ['Impact', 'Agrandissement seulement.'])), PROTECTED, shutdownProtected),
          group(impact('Nom du disque', 'hot'), diskNameInput, tipLines(['Par défaut', h('code', {}, '<nom de la VM>-disk0'), '.'])),
          h('div', { class: 'row-action' }, headWith('hot', extraDisks.addBtn))),
        extraDisks.list),
      section('Réseau',
        row(lock(group('Réseau *', networkPicker, tipLines(['Définition', 'Réseau XCP-ng de la première interface de la VM.'],
          ['Interfaces supplémentaires', 'Bouton « Ajouter une interface » : réseau et adresse IP fixe au format IP/CIDR.']))),
          lock(h('div', { class: 'row-action' }, extraNetworks.addBtn))),
        lock(extraNetworks.list)),
      section('Habilitations',
        row(group(impact('Groupe self-service', 'hot'), resourceSetInput, tipLines(['Définition', 'Resource set de Xen Orchestra auquel la VM est rattachée.'],
            ['Étiquettes', 'Les étiquettes du groupe sont ajoutées à la VM.'], ['Vide', 'Aucun groupe.'])),
          group(impact('Partager avec le groupe', 'hot'), shareSelect, tipLines(['Oui', 'VM partagée avec les membres du groupe self-service.'],
            ['Prérequis', 'Sans effet sans groupe self-service.'],
            sharedVm && ['Partage', 'VM partagée : le partage ne se retire qu’avec le groupe.'])),
          h('div', { class: 'row-action' }, headWith('hot', acls.addBtn))),
        acls.list))],
    ['Configuration OS', h('div', {}, importedNote, lock(h('div', {}, ...osSections)))],
    ['Post-Installation', lock(h('div', {}, linuxSoftware, windowsScripts))],
    ['Xen settings', xenSettingsPane],
    [osText('Cloud-init', 'Cloudbase-init'), lock(cloudInitPane)],
  ]);
  const legend = deployed ? h('div', { class: 'impact-legend' }, h('strong', {}, 'VM déployée'),
    h('span', {}, dot('hot'), 'à chaud'), h('span', {}, dot('reboot'), 'redémarrage de la VM')) : null;

  let close;
  const form = h('form', { onsubmit: guard(async (e) => {
    e.preventDefault();
    const missingIn = (tab) => (msg) => { tabs.show(tab); toast(msg); };
    const missing = missingIn(0);
    const missingVm = missingIn(1);
    if (!nameInput.value.trim()) return missing('Le nom du profil est obligatoire');
    if (!vmNameInput.value.trim()) return missing('Le nom de la VM est obligatoire');
    if (!picked.source_template) return missing('Sélectionnez le modèle XCP-ng source');
    if (!picked.sr_uuid) return missingVm('Sélectionnez le stockage (SR) du disque');
    if (!picked.network) return missingVm('Sélectionnez le réseau XCP-ng');
    const disks = extraDisks.values();
    if (disks.some((d) => !d.name || !d.sr_uuid)) return missingVm('Disques supplémentaires : nom et stockage (SR) obligatoires');
    const aclRows = acls.values();
    if (aclRows.some((a) => !a.subject)) return missingVm('ACL : sélectionnez un utilisateur ou un groupe');
    const nets = extraNetworks.values();
    if (nets.some((n) => !n.network || !n.ip)) return missingVm('Interfaces supplémentaires : réseau et adresse IP obligatoires');
    if (nets.some((n) => !/^[^/\s]+\/\d{1,2}$/.test(n.ip))) return missingVm('Interfaces supplémentaires : adresse au format IP/CIDR, par exemple 10.0.0.10/24');
    if (!safeSelect.value) {
      tabs.show(2);
      toast('Sélectionnez une entrée du coffre-fort (Accès)');
      return;
    }
    const dhcp = dhcpToggle.checked;
    if (!dhcp && !ipInput.value.trim()) { tabs.show(2); toast('L\'adresse IP est obligatoire en IP fixe'); return; }
    if (!dhcp && !/^[^/\s]+\/\d{1,2}$/.test(ipInput.value.trim())) {
      tabs.show(2); toast('Adresse IP : format IP/CIDR attendu, par exemple 192.168.1.10/24'); return;
    }
    const vars = {
      source_template: picked.source_template,
      sr_uuid: picked.sr_uuid,
      network: picked.network,
      os_type: osTypeSelect.value,
      vm_name: vmNameInput.value.trim(),
      vm_description: vmDescInput.value.trim(),
      vcpus: Number(vcpusInput.value),
      cores_per_socket: coresSelect.value,
      vm_memory: Number(memoryInput.value),
      disk_size: Number(diskInput.value),
      disk_name: diskNameInput.value.trim(),
      destroy_cloud_config: destroyDriveSelect.value,
      extra_disks: disks,
      extra_networks: nets,
      affinity_host: affinitySelect.value,
      auto_poweron: String(autoPowerOnToggle.checked),
      protect_delete: String(protectDeleteToggle.checked),
      protect_shutdown: String(protectShutdownToggle.checked),
      prevent_migration: String(preventMigrationToggle.checked),
      citrix_pv_drivers: String(isWindows() && citrixDriversToggle.checked),
      high_availability: haSelect.value,
      nic_type: nicTypeSelect.value,
      vga: String(vgaToggle.checked),
      videoram: videoramSelect.value,
      boot_firmware: firmwareSelect.value,
      secure_boot: String(firmwareSelect.value === 'uefi' && secureBootToggle.checked),
      resource_set: resourceSetInput.value.trim(),
      resource_set_share: shareSelect.value,
      acls: aclRows,
      tags: tagsInput.value.trim(),
      wait_for_ip: waitIpSelect.value,
      clone_type: cloneTypeSelect.value,
      safe_entry_id: safeSelect.value,
      ...(v.imported === 'true' && existing ? { imported: 'true', vm_mac: v.vm_mac, vm_uuid: v.vm_uuid } : {}),
      network_mode: dhcp ? 'dhcp' : 'static',
      ...(dhcp ? {} : {
        network_static_ip: ipInput.value.trim(),
        network_gateway: gatewayInput.value.trim(),
        network_dns: dnsInput.value.trim(),
      }),
      hostname: hostnameInput.value.trim(),
      timezone: timezoneSelect.value,
      ntp_servers: ntpInput.value.trim(),
      cloud_init_yaml: cloudInitInput.value,
      ...(isWindows() ? {
        powershell_commands: powershellInput.value,
        powershell_timeout: String(powershellTimeoutInput.value).trim(),
        cleanup_first_boot: String(cleanupToggle.checked),
        disable_builtin_admin: String(disableAdminToggle.checked),
        password_never_expires: String(neverExpiresToggle.checked),
        winrm_https: String(winrmHttpsToggle.checked),
        rdp_enabled: String(rdpToggle.checked),
      } : {
        locale: localeSelect.value,
        keyboard_layout: keyboardSelect.value,
        package_upgrade: String(upgradeToggle.checked),
        additional_packages: packagesInput.value.trim(),
        additional_commands: commandsInput.value,
      }),
    };
    const body = { name: nameInput.value.trim(), description: descInput.value.trim(), vars, ...(copy?.copy_from ? { copy_from: copy.copy_from } : {}) };
    await api(existing ? `/tofu/profiles/${existing.id}` : '/tofu/profiles', { method: existing ? 'PUT' : 'POST', body });
    close();
    pageTofuProfiles();
  }) },
  tabs.bar,
  tabs.body,
  formActions(() => close(), existing ? 'Enregistrer' : 'Créer'));

  close = openModal(existing ? `Profil : ${existing.name}` : copy ? 'Copie de profil' : 'Nouveau profil', form, { size: 'wide3', aside: legend,
    subtitle: copy ? `OpenTofu · copie de « ${copy.sourceName} »`
      : existing?.vars?.vm_name ? `OpenTofu · VM ${existing.vars.imported === 'true' ? 'importée ' : ''}${existing.vars.vm_name}` : 'OpenTofu · déploiement d’une VM depuis un modèle XCP-ng' });
  updateOs();
  refreshNetwork();
  refreshVga();
}

const safeAccountOptions = (rows) => rows.filter((e) => e.is_active && isAccountEntry(e))
  .map(safeEntryOption);

function importVmModal() {
  const nameInput = h('input', { type: 'text', maxlength: 100 });
  const descInput = h('input', { type: 'text', maxlength: 500 });
  const osSelect = scrollSelect([['linux', 'Linux'], ['windows', 'Windows']], 'linux');
  const safeSelect = optionPicker(null, '', { placeholder: 'Sélectionner...' });
  const picked = { source_template: '' };
  const templateSlot = h('div');
  const setTemplate = (name) => {
    picked.source_template = name || '';
    templateSlot.replaceChildren(xcpPicker('template', picked.source_template, (x) => { picked.source_template = x; }));
  };
  setTemplate('');
  let vmId = '';
  let autoName = '';
  const loadVms = async () => (await api('/tofu/importable-vms')).map((vm) => ({
    value: vm.uuid, name: vm.name, meta: `${vm.power_state === 'Running' ? 'démarrée' : 'arrêtée'} · ${vm.uuid}`, vm }));
  const vmPicker = searchPicker(loadVms, '', (uuid, { vm }) => {
    vmId = uuid;
    osSelect.setValue(vm.os_type);
    setTemplate(vm.source_template);
    if (!nameInput.value.trim() || nameInput.value === autoName) nameInput.value = vm.name;
    autoName = vm.name;
  }, { searchMeta: true, placeholder: 'Sélectionner...' });
  api('/safe').then((rows) => safeSelect.setOptions(safeAccountOptions(rows))).catch(() => safeSelect.setOptions([]));

  let close;
  const form = h('form', { onsubmit: guard(async (e) => {
    e.preventDefault();
    if (!vmId) { toast('Sélectionnez la VM à importer'); return; }
    if (!nameInput.value.trim()) { toast('Le nom du profil est obligatoire'); return; }
    if (!picked.source_template) { toast('Sélectionnez un modèle XCP-ng existant (obligatoire pour OpenTofu, sans effet sur la VM)'); return; }
    if (!safeSelect.value) { toast('Sélectionnez une entrée du coffre-fort'); return; }
    await api('/tofu/profiles/import', { method: 'POST', body: {
      name: nameInput.value.trim(), description: descInput.value.trim(), vm_id: vmId,
      os_type: osSelect.value, source_template: picked.source_template, safe_entry_id: safeSelect.value,
    } });
    close();
    pageTofuProfiles();
  }) },
  section('VM à importer',
    row(group('VM *', vmPicker, tipLines(['Liste', 'VM non gérées par un profil Forge.'], ['Recherche', 'Par nom ou UUID.']))),
    row(group('Système *', osSelect), group('Modèle source *', templateSlot,
      tipLines(['Définition', 'Requis par OpenTofu, sans effet sur la VM.'],
        ['Choix', 'Celui d’origine s’il est trouvé, sinon un modèle existant.'])))),
  section('Profil',
    row(group('Nom du profil *', nameInput), group('Description', descInput)),
    row(group('Entrée du coffre-fort *', safeSelect, tipLines(['Définition', 'Compte qui existe déjà sur la VM, utilisé pour les connexions Ansible.'])))),
  formActions(() => close(), 'Importer'));
  close = openModal('Importer une VM', form, { subtitle: 'OpenTofu · reprise d’une VM existante dans Forge',
    help: tipLines(['Profil', 'Forge crée le profil à partir des réglages de la VM (CPU, mémoire, disques, réseau, réglages Xen).'],
      ['Import', 'Groupe self-service et ACL Xen Orchestra non importés.'],
      ['Ensuite', 'Lancer « Valider » pour voir les écarts éventuels.']) });
}
