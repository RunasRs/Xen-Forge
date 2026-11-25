import {
  CIDR_RE, DNS_LIST_RE, HOSTNAME_RE, IPV4_RE, KEYBOARD_RE, LOCALE_RE, NTP_LIST_RE, PACKAGES_RE, TIMEZONE_RE, UUID_RE,
  ValidationError, checkExtra, checkField, checkFields, checkRequiredField, checkStaticNetwork, isBannedKey, requireSafeEntry,
  TAGS_MAX_LENGTH, TAGS_RE, XCP_NAME_RE, splitStaticAddress,
} from '../validation.js';

const MAX_EXTRA_DISKS = 100;
const MAX_EXTRA_NETWORKS = 15;
const MAX_ACLS = 20;
const MAX_POWERSHELL_TIMEOUT = 1440;
const ACL_ROLES = ['admin', 'operator', 'viewer'];
const NETWORK_MODE_RE = /^(dhcp|static)$/;
const NETWORK_FIELDS = ['network_static_ip', 'network_cidr', 'network_gateway', 'network_dns'];
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IMPORT_VARS = { imported: { re: /^true$/ }, vm_mac: { re: MAC_RE }, vm_uuid: { re: UUID_RE } };

function xenToggle(key, label, defaultValue) {
  return { key, label, type: 'select', required: true, default: defaultValue,
    options: [{ value: 'true', label: 'Activé' }, { value: 'false', label: 'Désactivé' }] };
}

const TOFU_PROFILE_VARS = [
  { key: 'source_template', label: 'Template XCP-ng source', type: 'string', required: true },
  { key: 'vm_name', label: 'Nom de la VM déployée', type: 'string', required: true, re: XCP_NAME_RE },
  { key: 'vm_description', label: 'Description', type: 'string', maxLength: 1000 },
  { key: 'sr_uuid', label: 'SR (disque de la VM)', type: 'string', required: true, re: UUID_RE },
  { key: 'network', label: 'Réseau XCP-ng', type: 'string', required: true },
  { key: 'vcpus', label: 'vCPU', type: 'int', min: 1, max: 128, required: true, default: 1 },
  { key: 'vm_memory', label: 'Mémoire (Mo)', type: 'int', min: 256, max: 1048576, required: true, default: 2048 },
  { key: 'cores_per_socket', label: 'Cœurs par socket', type: 'int', min: 1, max: 128 },
  { key: 'disk_size', label: 'Disque (Go)', type: 'int', min: 1, max: 16384, required: true, default: 10 },
  { key: 'disk_name', label: 'Nom du disque principal', type: 'string', re: XCP_NAME_RE },
  { key: 'os_type', label: 'Système du modèle', type: 'select', required: true,
    options: [{ value: 'linux', label: 'Linux (cloud-init)' }, { value: 'windows', label: 'Windows (cloudbase-init)' }] },
  { key: 'clone_type', label: 'Clone du disque', type: 'select', required: true, default: 'full',
    options: [{ value: 'full', label: 'Disque dédié' }, { value: 'fast', label: 'Fast clone' }] },
  { key: 'wait_for_ip', label: "Attendre l'IP de la VM", type: 'select', required: true, default: 'true',
    options: [{ value: 'true', label: 'Oui' }, { value: 'false', label: 'Non' }] },
  { key: 'destroy_cloud_config', label: 'Supprimer le config drive après le premier démarrage', type: 'select', required: true,
    default: 'true', options: [{ value: 'false', label: 'Non' }, { value: 'true', label: 'Oui' }] },
  { key: 'affinity_host', label: "Hôte d'affinité", type: 'string', maxLength: 255 },
  { key: 'resource_set', label: 'Groupe self-service', type: 'string', maxLength: 255 },
  { key: 'resource_set_share', label: 'Partager avec les membres du groupe', type: 'select', required: true,
    default: 'false', options: [{ value: 'false', label: 'Non' }, { value: 'true', label: 'Oui' }] },
  { key: 'tags', label: 'Tags', type: 'string', maxLength: TAGS_MAX_LENGTH, re: TAGS_RE },
  xenToggle('auto_poweron', 'Auto power on', 'true'),
  xenToggle('protect_delete', 'Protect from accidental deletion', 'false'),
  xenToggle('protect_shutdown', 'Protect from accidental shutdown', 'false'),
  xenToggle('prevent_migration', 'Prevent migration', 'false'),
  xenToggle('citrix_pv_drivers', 'Manage Citrix PV drivers via Windows Update', 'false'),
  { key: 'high_availability', label: 'HA', type: 'select',
    options: [{ value: 'best-effort', label: 'best-effort' }, { value: 'restart', label: 'restart' }] },
  { key: 'nic_type', label: 'NIC type', type: 'select', required: true, default: 'rtl8139',
    options: [{ value: 'rtl8139', label: 'Realtek RTL8139' }, { value: 'e1000', label: 'Intel e1000' }] },
  xenToggle('vga', 'VGA', 'true'),
  { key: 'videoram', label: 'Video RAM', type: 'select', required: true, default: '8',
    options: ['1', '2', '4', '8', '16'].map((value) => ({ value, label: `${value} MiB` })) },
  { key: 'boot_firmware', label: 'Boot firmware', type: 'select', required: true, default: 'bios',
    options: [{ value: 'bios', label: 'bios' }, { value: 'uefi', label: 'uefi' }] },
  xenToggle('secure_boot', 'Secure Boot', 'false'),
];

const TOFU_EXTRA_VARS = {
  ...IMPORT_VARS,
  hostname: { re: HOSTNAME_RE },
  package_upgrade: { re: /^(true|false)$/ },
  ntp_servers: { re: NTP_LIST_RE },
  timezone: { re: TIMEZONE_RE },
  locale: { re: LOCALE_RE },
  keyboard_layout: { re: KEYBOARD_RE },
  network_mode: { re: NETWORK_MODE_RE },
  network_static_ip: { re: IPV4_RE },
  network_cidr: { re: CIDR_RE },
  network_gateway: { re: IPV4_RE },
  network_dns: { re: DNS_LIST_RE },
  safe_entry_id: { re: UUID_RE },
  additional_packages: { re: PACKAGES_RE },
  additional_commands: { text: { max: 4000, lines: 50 } },
  cloud_init_yaml: { text: { max: 16000, lines: 400 } },
};

const TOFU_WINDOWS_VARS = {
  ...IMPORT_VARS,
  hostname: { re: /^(?![0-9]+$)[A-Za-z0-9][A-Za-z0-9-]{0,14}$/ },
  timezone: { re: TIMEZONE_RE },
  network_mode: { re: NETWORK_MODE_RE },
  network_static_ip: { re: IPV4_RE },
  network_cidr: { re: CIDR_RE },
  network_gateway: { re: IPV4_RE },
  network_dns: { re: DNS_LIST_RE },
  safe_entry_id: { re: UUID_RE },
  powershell_commands: { text: { max: 4000, lines: 50 } },
  powershell_timeout: { re: /^\d{1,4}$/ },
  cleanup_first_boot: { re: /^(true|false)$/ },
  disable_builtin_admin: { re: /^(true|false)$/ },
  password_never_expires: { re: /^(true|false)$/ },
  winrm_https: { re: /^(true|false)$/ },
  rdp_enabled: { re: /^(true|false)$/ },
  ntp_servers: { re: NTP_LIST_RE },
  cloud_init_yaml: { text: { max: 16000, lines: 400 } },
};

function checkExtraDisks(list, mainDiskName) {
  if (list === undefined || list === null || list === '') return [];
  if (!Array.isArray(list)) throw new ValidationError('Disques supplémentaires : liste attendue');
  if (list.length > MAX_EXTRA_DISKS) throw new ValidationError(`Disques supplémentaires : ${MAX_EXTRA_DISKS} au maximum`);
  const names = new Set([mainDiskName]);
  return list.map((d, i) => {
    const label = `Disque supplémentaire ${i + 1}`;
    if (!d || typeof d !== 'object') throw new ValidationError(`${label} : valeur invalide`);
    const field = (f, raw) => checkRequiredField({ ...f, label: `${label} : ${f.label}` }, raw);
    const disk = {
      name: field({ label: 'nom', type: 'string', re: XCP_NAME_RE }, d.name),
      sr_uuid: field({ label: 'SR', type: 'string', re: UUID_RE }, d.sr_uuid),
      size_gb: field({ label: 'taille (Go)', type: 'int', min: 1, max: 16384 }, d.size_gb),
    };
    if (names.has(disk.name)) throw new ValidationError(`${label} : nom « ${disk.name} » déjà utilisé`);
    names.add(disk.name);
    return disk;
  });
}

function checkExtraNetworks(list, mainIp) {
  if (list === undefined || list === null || list === '') return [];
  if (!Array.isArray(list)) throw new ValidationError('Interfaces supplémentaires : liste attendue');
  if (list.length > MAX_EXTRA_NETWORKS) throw new ValidationError(`Interfaces supplémentaires : ${MAX_EXTRA_NETWORKS} au maximum`);
  const ips = new Set(mainIp ? [mainIp] : []);
  return list.map((n, i) => {
    const label = `Interface supplémentaire ${i + 1}`;
    if (!n || typeof n !== 'object') throw new ValidationError(`${label} : valeur invalide`);
    const field = (f, raw) => checkRequiredField({ ...f, label: `${label} : ${f.label}` }, raw);
    const address = String(n.ip ?? '').trim();
    const m = address.match(/^([^/\s]+)\/(\d{1,2})$/);
    if (!m) throw new ValidationError(`${label} : adresse IP au format IP/CIDR attendue, par exemple 10.0.0.10/24`);
    const net = {
      network: field({ label: 'réseau', type: 'string' }, n.network),
      ip: field({ label: 'adresse IP', type: 'string', re: IPV4_RE }, m[1]),
      cidr: field({ label: 'préfixe CIDR (de /0 à /32)', type: 'string', re: CIDR_RE }, m[2]),
    };
    if (ips.has(net.ip)) throw new ValidationError(`${label} : adresse ${net.ip} déjà utilisée`);
    ips.add(net.ip);
    return net;
  });
}

function checkAcls(list) {
  if (list === undefined || list === null || list === '') return [];
  if (!Array.isArray(list)) throw new ValidationError('ACL : liste attendue');
  if (list.length > MAX_ACLS) throw new ValidationError(`ACL : ${MAX_ACLS} au maximum`);
  const subjects = new Set();
  return list.map((a, i) => {
    const label = `ACL ${i + 1}`;
    if (!a || typeof a !== 'object') throw new ValidationError(`${label} : valeur invalide`);
    const subject = checkField({ label: `${label} : sujet`, type: 'string', re: /^[\w-]{1,64}$/ }, a.subject);
    if (subject === null) throw new ValidationError(`${label} : sujet obligatoire`);
    if (!ACL_ROLES.includes(a.role)) throw new ValidationError(`${label} : rôle invalide (${ACL_ROLES.join(', ')})`);
    if (subjects.has(subject)) throw new ValidationError(`${label} : sujet déjà présent (un rôle par sujet)`);
    subjects.add(subject);
    return { subject, role: a.role };
  });
}

const DEPLOYED_LOCKED_VARS = [
  ['imported', 'VM importée'],
  ['vm_mac', 'Adresse MAC de la VM importée'],
  ['vm_uuid', 'UUID de la VM importée'],
  ['source_template', 'Modèle source'],
  ['os_type', 'Système du modèle'],
  ['sr_uuid', 'Stockage (SR)'],
  ['network', 'Réseau'],
  ['clone_type', 'Clone du disque'],
  ['wait_for_ip', "Attendre l'IP"],
  ['destroy_cloud_config', 'Supprimer le config drive'],
  ['extra_networks', 'Interfaces supplémentaires'],
  ['boot_firmware', 'Boot firmware'],
  ['secure_boot', 'Secure Boot'],
  ['safe_entry_id', 'Entrée du coffre-fort'],
  ['package_upgrade', 'Mise à jour au premier démarrage'],
  ['disable_builtin_admin', 'Administrator intégré désactivé'],
  ['password_never_expires', 'Mot de passe sans expiration'],
  ['winrm_https', 'WinRM HTTPS'],
  ['rdp_enabled', 'Bureau à distance'],
  ['ntp_servers', 'Serveurs de temps'],
  ['network_mode', 'DHCP ou IP fixe'],
  ['network_static_ip', 'Adresse IP'],
  ['network_cidr', "Préfixe CIDR de l'adresse IP"],
  ['network_gateway', 'Passerelle'],
  ['network_dns', 'DNS'],
  ['hostname', "Nom d'hôte"],
  ['timezone', 'Fuseau horaire'],
  ['locale', 'Paramètres régionaux'],
  ['keyboard_layout', 'Clavier'],
  ['additional_packages', 'Paquets supplémentaires'],
  ['additional_commands', 'Commandes au premier démarrage'],
  ['powershell_commands', 'Commandes PowerShell'],
  ['powershell_timeout', 'Délai maximal des commandes PowerShell'],
  ['cleanup_first_boot', 'Supprimer les logs et les scripts'],
  ['cloud_init_yaml', 'Données utilisateur personnalisées'],
];

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const LOCKED_DEFAULTS = {
  package_upgrade: 'false',
  disable_builtin_admin: 'true', password_never_expires: 'false', winrm_https: 'false', rdp_enabled: 'false', ntp_servers: '',
  powershell_timeout: '30', cleanup_first_boot: 'true',
};
const FIELD_DEFAULTS = Object.fromEntries(TOFU_PROFILE_VARS.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
const lockedValue = (vars, key) => vars[key] ?? LOCKED_DEFAULTS[key] ?? FIELD_DEFAULTS[key];

const FIRST_BOOT_VARS = new Set(DEPLOYED_LOCKED_VARS.slice(DEPLOYED_LOCKED_VARS.findIndex(([key]) => key === 'safe_entry_id'))
  .map(([key]) => key));

export function deployedUpdateRefusal({ cur, deployed, next, vmName }) {
  const vm = `VM « ${vmName} » déployée`;
  const imported = cur.imported === 'true';
  const locked = DEPLOYED_LOCKED_VARS
    .filter(([key]) => !(imported && FIRST_BOOT_VARS.has(key)))
    .filter(([key]) => !sameValue(lockedValue(deployed, key), lockedValue(next, key))
      && !sameValue(lockedValue(cur, key), lockedValue(next, key)))
    .map(([, label]) => label);
  if (locked.length) {
    return `${vm} : ${locked.join(', ')} non ${locked.length > 1 ? 'modifiables' : 'modifiable'}. `
      + 'Remettre la valeur déployée, ou cloner le profil pour déployer une nouvelle VM';
  }
  const deployedDisks = new Map((deployed.extra_disks || []).map((d) => [d.name, d.size_gb]));
  const shrunk = [
    ...(Number(next.disk_size) < Number(deployed.disk_size) ? [`disque principal (${deployed.disk_size} Go)`] : []),
    ...(next.extra_disks || []).filter((d) => deployedDisks.has(d.name) && d.size_gb < deployedDisks.get(d.name))
      .map((d) => `« ${d.name} » (${deployedDisks.get(d.name)} Go)`),
  ];
  if (shrunk.length) return `${vm} : réduction de disque impossible : ${shrunk.join(', ')}`;
  const grown = Number(next.disk_size) > Number(deployed.disk_size)
    || (next.extra_disks || []).some((d) => deployedDisks.has(d.name) && d.size_gb > deployedDisks.get(d.name));
  const needsRestart = grown || Number(next.vm_memory) !== Number(deployed.vm_memory)
    || !sameValue(deployed.nic_type, next.nic_type) || !sameValue(deployed.citrix_pv_drivers, next.citrix_pv_drivers);
  if ((deployed.protect_shutdown === 'true' || next.protect_shutdown === 'true') && needsRestart) {
    return `${vm} : mémoire, agrandissement de disque, NIC type et pilotes Citrix redémarrent la VM, incompatible avec « Protect from accidental shutdown ». `
      + 'Changer la protection et ces paramètres en deux constructions séparées (d\'abord la protection désactivée)';
  }
  return null;
}

export function validateTofuProfile(rawInput = {}) {
  if (!rawInput || typeof rawInput !== 'object') throw new ValidationError('Variables du profil manquantes');
  const input = splitStaticAddress(rawInput);
  const vars = checkFields(TOFU_PROFILE_VARS, input);

  const windows = vars.os_type === 'windows';
  if (!windows) vars.citrix_pv_drivers = 'false';
  if (vars.boot_firmware !== 'uefi') vars.secure_boot = 'false';
  if (!vars.resource_set) vars.resource_set_share = 'false';
  const acls = checkAcls(input.acls);
  if (acls.length) vars.acls = acls;
  const extraDisks = checkExtraDisks(input.extra_disks, vars.disk_name || `${vars.vm_name}-disk0`);
  if (extraDisks.length) vars.extra_disks = extraDisks;
  if (vars.cores_per_socket && vars.vcpus % vars.cores_per_socket) {
    throw new ValidationError(`Cœurs par socket : ${vars.cores_per_socket} ne divise pas ${vars.vcpus} vCPU`);
  }
  if (vars.destroy_cloud_config === 'true') {
    if (vars.wait_for_ip !== 'true') throw new ValidationError("Suppression du config drive : « Attendre l'IP » requis");
    if (windows && String(input.cloud_init_yaml || '').trim()) throw new ValidationError('Suppression du config drive : incompatible avec un user-data personnalisé sous Windows');
  }
  const extras = windows ? TOFU_WINDOWS_VARS : TOFU_EXTRA_VARS;
  for (const [key, value] of Object.entries(input)) {
    if (isBannedKey(key) || !extras[key]) continue;
    const v = checkExtra(key, extras[key], value);
    if (v !== '') vars[key] = v;
  }

  if (vars.powershell_timeout !== undefined && Number(vars.powershell_timeout) > MAX_POWERSHELL_TIMEOUT) {
    throw new ValidationError(`Délai maximal des commandes PowerShell : ${MAX_POWERSHELL_TIMEOUT} min au plus (0 : sans limite)`);
  }

  requireSafeEntry(vars);
  if (vars.imported && !vars.vm_mac) throw new ValidationError('VM importée : adresse MAC manquante');
  if (!vars.imported) {
    delete vars.vm_mac;
    delete vars.vm_uuid;
  }
  if (vars.imported) vars.destroy_cloud_config = 'false';

  const mode = vars.network_mode || (vars.network_static_ip ? 'static' : 'dhcp');
  if (mode === 'static') {
    if (!vars.network_static_ip) throw new ValidationError('Adresse IP obligatoire en IP fixe (onglet Configuration OS, Réseau)');
    checkStaticNetwork(vars);
  } else if (!vars.network_mode && (vars.network_gateway || vars.network_dns)) {
    throw new ValidationError('Passerelle et DNS ne s\'appliquent qu\'avec une adresse IP fixe (sinon DHCP)');
  } else {
    for (const key of NETWORK_FIELDS) delete vars[key];
  }
  vars.network_mode = mode;

  const extraNetworks = checkExtraNetworks(input.extra_networks, vars.network_static_ip);
  if (extraNetworks.length) vars.extra_networks = extraNetworks;

  if (windows && vars.cloud_init_yaml && !/^#(cloud-config|ps1_sysnative|ps1)\s/.test(vars.cloud_init_yaml)) {
    throw new ValidationError('user-data personnalisé : la première ligne doit être « #cloud-config » ou « #ps1_sysnative »');
  }
  if (!windows && vars.cloud_init_yaml && !vars.cloud_init_yaml.startsWith('#cloud-config')) {
    throw new ValidationError('user-data personnalisé : la première ligne doit être « #cloud-config »');
  }
  return vars;
}
