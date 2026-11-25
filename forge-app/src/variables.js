import {
  CIDR_RE, DNS_LIST_RE, HOSTNAME_RE, IPV4_RE, KEYBOARD_RE, LOCALE_RE, PACKAGES_RE, TAGS_MAX_LENGTH, TAGS_RE, TIMEZONE_RE, UUID_RE,
  ValidationError, checkExtra, checkFields, checkStaticNetwork, isBannedKey, requireSafeEntry, splitStaticAddress,
} from './validation.js';
import { WINDOWS_UI_LANGUAGES } from './answerfiles/autounattend.js';

const BOOLEAN = [{ value: 'false', label: 'Non' }, { value: 'true', label: 'Oui' }];

const PROFILE_VARS = [
  { key: 'sr_uuid', label: 'SR (disque de la VM)', type: 'string', required: true, re: UUID_RE },
  { key: 'sr_iso_uuid', label: 'SR ISO', type: 'string', required: true, re: UUID_RE },
  { key: 'clone_template', label: 'Template à cloner', type: 'string', required: true },
  { key: 'iso_url', label: "URL de l'ISO", type: 'url', required: true, maxLength: 1000 },
  { key: 'iso_checksum', label: "Checksum de l'ISO", type: 'string', maxLength: 1000 },
  { key: 'vm_name', label: 'Nom de la VM / du template', type: 'string', required: true, re: /^[\w][\w .-]{0,62}$/ },
  { key: 'vm_description', label: 'Description', type: 'string', maxLength: 1000 },
  { key: 'vcpus', label: 'vCPU', type: 'int', min: 1, max: 128, required: true, default: 2 },
  { key: 'vm_memory', label: 'Mémoire (Mo)', type: 'int', min: 256, max: 1048576, required: true, default: 2048 },
  { key: 'disk_size', label: 'Disque (Mo)', type: 'int', min: 1024, max: 16777216, required: true, default: 10240 },
  { key: 'network', label: 'Réseau', type: 'string' },
  { key: 'os_type', label: 'Type OS', type: 'select', required: true, default: 'linux',
    options: [{ value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' }] },
  { key: 'firmware', label: 'Firmware de démarrage', type: 'select', required: true, default: 'bios',
    options: [{ value: 'bios', label: 'BIOS' }, { value: 'uefi', label: 'UEFI' }] },
  { key: 'secure_boot', label: 'Secure Boot', type: 'select', required: true, default: 'false', options: BOOLEAN },
  { key: 'existing_template', label: 'Template existant', type: 'select', required: true, default: 'replace_purge',
    options: [
      { value: 'refuse', label: 'Refuser si le template existe' },
      { value: 'replace', label: 'Remplacer' },
      { value: 'replace_purge', label: 'Remplacer et supprimer ses disques' },
    ] },
  { key: 'remove_build_user', label: 'Supprimer le compte utilisateur', type: 'select', required: true, default: 'false', options: BOOLEAN },
  { key: 'keep_vm', label: 'Conserver la VM de build', type: 'select', required: true, default: 'on_success',
    options: [
      { value: 'on_success', label: 'Suppression après succès' },
      { value: 'always', label: 'Conservation pour inspection' },
      { value: 'never', label: 'Suppression systématique' },
    ] },
];

const EXTRA_VARS = {
  hostname: { re: HOSTNAME_RE },
  timezone: { re: TIMEZONE_RE },
  locale: { re: LOCALE_RE },
  keyboard_layout: { re: KEYBOARD_RE },
  network_static_ip: { re: IPV4_RE },
  network_cidr: { re: CIDR_RE },
  network_gateway: { re: IPV4_RE },
  network_dns: { re: DNS_LIST_RE },
  additional_packages: { re: PACKAGES_RE },
  additional_commands: { text: { max: 4000, lines: 50 } },
  safe_entry_id: { re: UUID_RE },
  product_key_entry_id: { re: UUID_RE },
  windows_image_index: { re: /^([1-9]|1[0-8])$/ },
  windows_ui_language: { re: new RegExp(`^(${WINDOWS_UI_LANGUAGES.join('|')})$`) },
  powershell_commands: { text: { max: 4000, lines: 50 } },
  cloudbase_init: { re: /^(true|false)$/ },
  network_mode: { re: /^(dhcp|static)$/ },
  os_update: { re: /^(true|false)$/ },
  ipv6_enabled: { re: /^(true|false)$/ },
  swap_enabled: { re: /^(true|false)$/ },
  swap_size_gb: { re: /^([1-9]|[1-5][0-9]|6[0-4])$/ },
  cores_per_socket: { re: /^([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/ },
  disk_name: { re: /^[\w][\w .-]{0,62}$/ },
  tags: { re: TAGS_RE, text: { max: TAGS_MAX_LENGTH } },
  vga: { re: /^(true|false)$/ },
  videoram: { re: /^(1|2|4|8|16)$/ },
  nic_type: { re: /^(rtl8139|e1000)$/ },
};

const WINDOWS_ONLY = ['product_key_entry_id', 'windows_image_index', 'windows_ui_language', 'powershell_commands', 'cloudbase_init'];

export function validateProfile(rawInput = {}) {
  if (!rawInput || typeof rawInput !== 'object') throw new ValidationError('Variables du profil manquantes');
  const input = splitStaticAddress(rawInput);
  const vars = checkFields(PROFILE_VARS, input);
  const windows = vars.os_type === 'windows';
  for (const [key, value] of Object.entries(input)) {
    if (isBannedKey(key) || !EXTRA_VARS[key] || (!windows && WINDOWS_ONLY.includes(key))) continue;
    const v = checkExtra(key, EXTRA_VARS[key], value);
    if (v !== '') vars[key] = v;
  }

  requireSafeEntry(vars);
  if (!vars.hostname) throw new ValidationError('Nom d\'hôte obligatoire (onglet Configuration OS, Identité)');

  if (vars.iso_checksum) vars.iso_checksum = normalizeChecksum(vars.iso_checksum);

  Object.assign(vars, withBuildDefaults(vars));
  if (vars.network_mode === 'static') {
    if (!vars.network_static_ip) throw new ValidationError('Adresse IP obligatoire en IP fixe (onglet Configuration OS, Réseau)');
    checkStaticNetwork(vars);
  } else {
    for (const key of NETWORK_FIELDS) delete vars[key];
  }

  if (vars.firmware !== 'uefi') vars.secure_boot = 'false';
  applySwap(vars);
  if (vars.cores_per_socket && vars.vcpus % Number(vars.cores_per_socket)) {
    throw new ValidationError(`Topologie CPU : ${vars.cores_per_socket} cœur(s) par socket ne divise pas ${vars.vcpus} vCPU`);
  }
  if (vars.vga !== 'true') delete vars.videoram;

  if (windows && vars.disk_size < 32768) {
    throw new ValidationError('Disque : 32 Go minimum pour Windows Server');
  }
  return vars;
}

const NETWORK_FIELDS = ['network_static_ip', 'network_cidr', 'network_gateway', 'network_dns'];

export function withBuildDefaults(vars = {}) {
  return {
    ...vars,
    firmware: vars.firmware || 'bios',
    secure_boot: vars.firmware === 'uefi' && vars.secure_boot === 'true' ? 'true' : 'false',
    network_mode: vars.network_mode || (vars.network_static_ip ? 'static' : 'dhcp'),
    os_update: vars.os_update || 'false',
    ipv6_enabled: vars.ipv6_enabled || 'false',
    swap_enabled: vars.os_type !== 'windows' && vars.swap_enabled === 'true' ? 'true' : 'false',
  };
}

function applySwap(vars) {
  if (vars.swap_enabled !== 'true') {
    delete vars.swap_size_gb;
    return;
  }
  vars.swap_size_gb ||= '2';
  if (Number(vars.swap_size_gb) * 1024 > vars.disk_size / 2) {
    throw new ValidationError(`Swap : ${vars.swap_size_gb} Go dépasse la moitié du disque (${vars.disk_size / 1024} Go, onglet Machine virtuelle)`);
  }
}

function normalizeChecksum(value) {
  const v = value.trim();
  if (/^(file|sha256|sha512|sha384|sha1|md5):/i.test(v) || v === 'none') return v;
  if (/^https?:\/\//i.test(v)) return `file:${v}`;
  if (/^[0-9a-f]{64}$/i.test(v)) return `sha256:${v}`;
  throw new ValidationError("Checksum de l'ISO : hash SHA-256, URL de fichier de sommes ou « algo:hash » attendu");
}

const hclString = (s) => JSON.stringify(String(s)).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');

const hclMap = (obj) => `{\n${Object.entries(obj).map(([k, v]) => `  ${hclString(k)} = ${hclString(v)}`).join('\n')}\n}`;

export const toPkrvars = (values) => Object.entries(values)
  .map(([k, v]) => `${k} = ${typeof v === 'number' ? v
    : Array.isArray(v) ? `[${v.map(hclString).join(', ')}]`
      : (v && typeof v === 'object' ? hclMap(v) : hclString(v))}`)
  .join('\n') + '\n';
