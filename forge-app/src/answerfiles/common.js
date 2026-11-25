export const yamlScalar = (s) => JSON.stringify(String(s));

export const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function cidrToNetmask(cidr) {
  const bits = Number(cidr);
  if (!/^\d{1,2}$/.test(String(cidr ?? '')) || bits > 32) throw new Error(`CIDR invalide ou manquant : « ${cidr ?? ''} »`);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((s) => (mask >>> s) & 0xff).join('.');
}

export const csvList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
export const lineList = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);

export const isStatic = (vars = {}) => vars.network_mode === 'static';
export const ipv6Disabled = (vars = {}) => String(vars.ipv6_enabled) !== 'true';

export const hostLabel = (name) => String(name || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 63).replace(/-+$/, '');

export const hostnameOf = (vars = {}, fallback = '') => {
  const name = String(vars.hostname || '').trim() || fallback;
  if (!name) throw new Error('Nom d\'hôte manquant : le renseigner dans le profil (onglet Configuration OS, Identité)');
  return name;
};

const XKB_LAYOUTS = { uk: 'gb', sv: 'se' };
export const xkbLayout = (layout) => {
  const id = String(layout || '').trim().toLowerCase();
  return XKB_LAYOUTS[id] || id;
};

export const LOCKED_PASSWORD = '!';

export function buildAccountCommands(user, publicKey = '', root = '') {
  const ssh = `/home/${user}/.ssh`;
  return [
    `echo '${user} ALL=(ALL) NOPASSWD:ALL' > ${root}/etc/sudoers.d/${user}`,
    `chmod 440 ${root}/etc/sudoers.d/${user}`,
    ...(publicKey ? [
      `mkdir -p ${ssh}`,
      `echo '${publicKey}' > ${ssh}/authorized_keys`,
      `chmod 700 ${ssh}`,
      `chmod 600 ${ssh}/authorized_keys`,
      `chown -R ${user}: ${ssh}`,
    ] : []),
  ];
}

export function linuxProfileScript(vars = {}) {
  const pkgs = csvList(vars.additional_packages).join(' ');
  const cmds = lineList(vars.additional_commands);
  return [
    '#!/bin/bash',
    'set -eEu',
    "step='Unexpected error'",
    `trap '{ [ "$BASH_SUBSHELL" -ne 0 ] || echo "Error: $step" >&2; } 9>/dev/null' ERR`,
    'if [ "${COMMAND_TRACE:-false}" = true ]; then exec 9>&1; BASH_XTRACEFD=9; set -x; fi',
    ...(pkgs ? [
      "{ step='Failed to install additional packages'; } 9>/dev/null",
      'if command -v apt-get >/dev/null 2>&1; then',
      "  printf '#!/bin/sh\\nexit 101\\n' > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d",
      "  trap 'rm -f /usr/sbin/policy-rc.d' EXIT",
      '  apt-get -o Acquire::Retries=3 update',
      `  apt-get install -y ${pkgs}`,
      'elif command -v dnf >/dev/null 2>&1; then',
      `  dnf -y install ${pkgs}`,
      'else',
      `  zypper --non-interactive install ${pkgs}`,
      'fi',
    ] : []),
    ...(cmds.length ? [
      'commands_start=$((LINENO + 2))',
      `trap '{ [ "$BASH_SUBSHELL" -ne 0 ] || echo "Error: additional command $((LINENO - commands_start + 1)) failed" >&2; } 9>/dev/null' ERR`,
      ...cmds,
    ] : []),
    ...(!pkgs && !cmds.length ? ["echo 'No packages or commands defined in the profile.'"] : []),
    '',
  ].join('\n');
}
