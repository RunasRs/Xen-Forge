import crypto from 'node:crypto';
import { cidrToNetmask, csvList, hostLabel, hostnameOf, lineList, xkbLayout, yamlScalar } from '../answerfiles/common.js';
import { WINDOWS_TIMEZONES, computerNameOf } from '../answerfiles/autounattend.js';

const guestInterface = (index) => `eth${index}`;

export function profileMac(profileId, index = 0) {
  const seed = index ? `tofu-mac:${profileId}:${index}` : `tofu-mac:${profileId}`;
  const b = crypto.createHash('sha256').update(seed).digest();
  return ['02', ...[...b.subarray(0, 5)].map((x) => x.toString(16).padStart(2, '0'))].join(':');
}

const list = (indent, items) => items.map((i) => `${' '.repeat(indent)}- ${yamlScalar(i)}`);

const LOCALE_SCRIPT = [
  'locale -a | grep -qxF "$2" && exit 0',
  'if [ -d /var/lib/locales/supported.d ]; then locale-gen "$1"',
  'elif [ -f /etc/locale.gen ]; then',
  '  line=$(awk -v l="$1" \'$1 == l { print; exit }\' /usr/share/i18n/SUPPORTED)',
  '  [ -n "$line" ] || { echo "Locale $1 inconnue" >&2; exit 1; }',
  '  grep -qxF "$line" /etc/locale.gen || echo "$line" >> /etc/locale.gen',
  '  locale-gen',
  'elif command -v dnf >/dev/null; then dnf -y install "glibc-langpack-${1%%_*}"',
  'elif command -v zypper >/dev/null; then zypper --non-interactive install glibc-locale',
  'fi',
].join('\n');
const localeAlias = (l) => l.replace(/\.([^@]+)/, (_, cs) => `.${cs.toLowerCase().replace(/-/g, '')}`);

const REPLACED_BY_CUSTOM = {
  hostname: "nom d'hôte",
  timezone: 'fuseau horaire',
  locale: 'locale',
  keyboard_layout: 'clavier',
  additional_packages: 'paquets supplémentaires',
  additional_commands: 'commandes au premier démarrage',
  powershell_commands: 'commandes PowerShell',
  ntp_servers: 'serveurs de temps',
};

const TOGGLES_REPLACED_BY_CUSTOM = {
  package_upgrade: ['true', 'mise à jour au premier démarrage'],
  disable_builtin_admin: ['false', 'Administrator intégré non désactivé'],
  password_never_expires: ['true', 'mot de passe sans expiration'],
  winrm_https: ['true', 'WinRM HTTPS'],
  rdp_enabled: ['true', 'Bureau à distance'],
};

export const fieldsIgnoredByCustom = (vars = {}) => [
  ...Object.entries(REPLACED_BY_CUSTOM).filter(([key]) => String(vars[key] || '').trim()).map(([, label]) => label),
  ...Object.entries(TOGGLES_REPLACED_BY_CUSTOM).filter(([key, [value]]) => vars[key] === value).map(([, [, label]]) => label),
];

export function buildUserData({ vars = {}, user, passwordHash = '', publicKeys = [] }) {
  const custom = String(vars.cloud_init_yaml || '').trim();
  const userData = custom ? `${custom}\n` : profileUserData({ vars, user, passwordHash, publicKeys });
  return String(vars.destroy_cloud_config) === 'true' ? firstBootOnly(userData) : userData;
}

const CLOUD_INIT_SECRETS = [
  '/var/lib/cloud/instance', '/var/lib/cloud/instances', '/var/lib/cloud/data', '/var/lib/cloud/handlers',
  '/run/cloud-init/instance-data-sensitive.json', '/run/cloud-init/combined-cloud-config.json', '/run/cloud-init/cloud-config.txt',
];
const FIRST_BOOT_DONE = [
  '#!/bin/sh',
  'touch /etc/cloud/cloud-init.disabled',
  "purge='i=0; while [ ! -e /run/cloud-init/result.json ] && [ $i -lt 1800 ]; do sleep 2; i=$((i+2)); done; sleep 5; '\\",
  `'rm -rf ${CLOUD_INIT_SECRETS.join(' ')}'`,
  'if command -v systemd-run >/dev/null 2>&1; then systemd-run --no-block --collect --unit=tofu-cloud-init-purge sh -c "$purge"',
  'else nohup sh -c "$purge" >/dev/null 2>&1 & fi',
].join('\n');

function firstBootOnly(userData) {
  let boundary = '==tofu-user-data==';
  while (userData.includes(boundary)) boundary = `=${boundary}=`;
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset="utf-8"`, 'MIME-Version: 1.0', '', body.trimEnd()];
  return [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    'MIME-Version: 1.0',
    '',
    ...part('text/cloud-config', userData),
    ...part('text/x-shellscript', FIRST_BOOT_DONE),
    `--${boundary}--`,
    '',
  ].join('\n');
}

function profileUserData({ vars, user, passwordHash, publicKeys }) {
  const hostname = hostnameOf(vars, hostLabel(vars.vm_name) || 'vm');
  const packages = csvList(vars.additional_packages);
  const upgrade = vars.package_upgrade === 'true';
  const ntp = csvList(vars.ntp_servers);
  const layout = vars.keyboard_layout && xkbLayout(vars.keyboard_layout);
  const runcmd = [
    ...(layout ? [`if [ -f /etc/default/keyboard ]; then sed -i -e 's/^XKBLAYOUT=.*/XKBLAYOUT="${layout}"/'`
      + ` -e 's/^XKBVARIANT=.*/XKBVARIANT=""/' /etc/default/keyboard && { setupcon --force --save || true; };`
      + ` else localectl set-x11-keymap ${layout}; fi`] : []),
    ...lineList(vars.additional_commands),
  ];
  return [
    '#cloud-config',
    `hostname: ${yamlScalar(hostname.split('.')[0])}`,
    `fqdn: ${yamlScalar(hostname.includes('.') ? hostname : `${hostname}.localdomain`)}`,
    'manage_etc_hosts: true',
    ...(vars.timezone ? [`timezone: ${yamlScalar(vars.timezone)}`] : []),
    ...(vars.locale ? [
      'bootcmd:',
      `  - ${JSON.stringify(['cloud-init-per', 'once', 'tofu-locale', 'sh', '-c', LOCALE_SCRIPT, 'sh', vars.locale, localeAlias(vars.locale)])}`,
      `locale: ${yamlScalar(vars.locale)}`,
    ] : []),
    'disable_root: true',
    `ssh_pwauth: ${passwordHash ? 'true' : 'false'}`,
    'users:',
    `  - name: ${yamlScalar(user)}`,
    `    gecos: ${yamlScalar('Admin (OpenTofu)')}`,
    '    shell: /bin/bash',
    `    sudo: ${yamlScalar('ALL=(ALL) NOPASSWD:ALL')}`,
    `    lock_passwd: ${passwordHash ? 'false' : 'true'}`,
    ...(passwordHash ? [`    hashed_passwd: ${yamlScalar(passwordHash)}`] : []),
    ...(publicKeys.length ? ['    ssh_authorized_keys:', ...list(6, publicKeys)] : []),
    'growpart:',
    '  mode: auto',
    '  devices: ["/"]',
    'resize_rootfs: true',
    ...(ntp.length ? ['ntp:', '  enabled: true', '  servers:', ...list(4, ntp)] : []),
    ...(packages.length || upgrade ? ['package_update: true'] : []),
    ...(upgrade ? ['package_upgrade: true'] : []),
    ...(packages.length ? ['packages:', ...list(2, packages)] : []),
    ...(runcmd.length ? ['runcmd:', ...list(2, runcmd)] : []),
    '',
  ].join('\n');
}

const FIRST_BOOT = 'C:\\Windows\\Setup\\Scripts\\tofu-first-boot.ps1';
const FIRST_BOOT_LOG = 'C:\\Windows\\Setup\\Scripts\\tofu-first-boot.log';
const COMMANDS = 'C:\\Windows\\Setup\\Scripts\\tofu-commands.ps1';
const COMMANDS_LOG = 'C:\\Windows\\Setup\\Scripts\\tofu-commands.log';

const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;

const WIPE_CONFIG_DRIVE = [
  "$drive = Get-CimInstance Win32_Volume -Filter \"Label='cidata'\" | Select-Object -First 1",
  'if ($drive) {',
  '  $root = $drive.DriveLetter',
  "  if (-not $root) { $root = 'Z:'; mountvol.exe $root $drive.DeviceID }",
  '  Get-ChildItem "$root\\" -Recurse -File -Force | ForEach-Object {',
  '    $f = [IO.File]::OpenWrite($_.FullName)',
  '    $f.Write((New-Object byte[] $_.Length), 0, $_.Length)',
  '    $f.Flush($true)',
  '    $f.Close()',
  '    Remove-Item -LiteralPath $_.FullName -Force',
  '  }',
  '  fsutil.exe volume dismount $root',
  '  mountvol.exe $root /D',
  '}',
];

const EXTEND_SYSTEM_DRIVE = [
  'try {',
  '  $max = (Get-PartitionSupportedSize -DriveLetter C -ErrorAction Stop).SizeMax',
  '  $size = (Get-Partition -DriveLetter C -ErrorAction Stop).Size',
  '  if ($max - $size -gt 1MB) { Resize-Partition -DriveLetter C -Size $max -ErrorAction Stop; "C: étendu à $([math]::Round($max / 1GB, 1)) Go" }',
  '  else { "C: déjà à la taille du disque ($([math]::Round($size / 1GB, 1)) Go)" }',
  '} catch {',
  '  "C: non étendu : $($_.Exception.Message)"',
  '}',
];

const DEFAULT_POWERSHELL_TIMEOUT = 30;

function runUserCommands(timeoutMin) {
  return [
    `$p = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','"${COMMANDS}"' -WindowStyle Hidden -PassThru`,
    '$null = $p.Handle',
    timeoutMin > 0
      ? `if ($p.WaitForExit(${timeoutMin * 60000})) { "Commandes terminées (code $($p.ExitCode))" } else { taskkill.exe /T /F /PID $p.Id | Out-Null; 'Délai de ${timeoutMin} min dépassé : commandes interrompues (journal : ${COMMANDS_LOG})' }`
      : '$p.WaitForExit(); "Commandes terminées (code $($p.ExitCode))"',
  ];
}

function powershellTimeout(vars) {
  const n = Number(vars.powershell_timeout);
  return vars.powershell_timeout !== undefined && vars.powershell_timeout !== '' && Number.isInteger(n) && n >= 0
    ? n : DEFAULT_POWERSHELL_TIMEOUT;
}

function addToAdministrators(user) {
  return [
    'try {',
    `  Add-LocalGroupMember -SID 'S-1-5-32-544' -Member ${psString(user)} -ErrorAction Stop`,
    `  ${psString(`Compte ${user} : ajouté aux administrateurs`)}`,
    '} catch [Microsoft.PowerShell.Commands.MemberExistsException] {',
    `  ${psString(`Compte ${user} : déjà administrateur`)}`,
    '} catch {',
    `  ${psString(`Compte ${user} : ajout aux administrateurs impossible : `)} + $_.Exception.Message`,
    '}',
  ];
}

function disableBuiltinAdmin(user) {
  return [
    'try {',
    `  $u = Get-LocalUser -Name ${psString(user)} -ErrorAction Stop`,
    String.raw`  $group = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]`,
    String.raw`  $names = @(([ADSI]"WinNT://./$group,group").Invoke('Members') | ForEach-Object { $_.GetType().InvokeMember('Name', 'GetProperty', $null, $_, $null) })`,
    String.raw`  $builtin = Get-LocalUser | Where-Object { $_.SID.Value -like 'S-1-5-*-500' }`,
    String.raw`  if ($u.SID.Value -like 'S-1-5-*-500') { "Administrator intégré conservé : c'est le compte du profil" }`,
    String.raw`  elseif (-not $u.Enabled -or $names -notcontains $u.Name) { "Administrator intégré conservé : compte $($u.Name) inactif ou hors des administrateurs" }`,
    String.raw`  elseif ($builtin.Enabled) { Disable-LocalUser -SID $builtin.SID -ErrorAction Stop; "Administrator intégré ($($builtin.Name)) désactivé" }`,
    '} catch {',
    String.raw`  "Administrator intégré conservé : $($_.Exception.Message)"`,
    '}',
  ];
}

function passwordNeverExpires(user) {
  return [
    'try {',
    `  Set-LocalUser -Name ${psString(user)} -PasswordNeverExpires $true -ErrorAction Stop`,
    `  ${psString(`Mot de passe de ${user} : sans expiration`)}`,
    '} catch {',
    String.raw`  "Expiration du mot de passe inchangée : $($_.Exception.Message)"`,
    '}',
  ];
}

const WINRM_HTTPS = [
  'try {',
  '  Set-Service WinRM -StartupType Automatic',
  '  Start-Service WinRM -ErrorAction Stop',
  "  $cert = New-SelfSignedCertificate -DnsName $env:COMPUTERNAME -CertStoreLocation 'Cert:\\LocalMachine\\My' -NotAfter (Get-Date).AddYears(10) -ErrorAction Stop",
  "  Get-ChildItem 'WSMan:\\localhost\\Listener' | Where-Object { $_.Keys -contains 'Transport=HTTPS' } | Remove-Item -Recurse -Force",
  "  New-Item -Path 'WSMan:\\localhost\\Listener' -Transport HTTPS -Address * -CertificateThumbPrint $cert.Thumbprint -Force -ErrorAction Stop | Out-Null",
  "  Set-Item 'WSMan:\\localhost\\Service\\Auth\\Basic' $false",
  "  Set-Item 'WSMan:\\localhost\\Service\\AllowUnencrypted' $false",
  "  New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name LocalAccountTokenFilterPolicy -Value 1 -PropertyType DWord -Force | Out-Null",
  "  if (-not (Get-NetFirewallRule -Name 'Forge-WinRM-HTTPS' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name 'Forge-WinRM-HTTPS' -DisplayName 'WinRM HTTPS (Forge)' -Direction Inbound -Protocol TCP -LocalPort 5986 -Action Allow -Profile Any | Out-Null }",
  '  "WinRM HTTPS actif sur le port 5986 (certificat auto-signé $($cert.Thumbprint))"',
  '} catch {',
  '  "WinRM HTTPS non configuré : $($_.Exception.Message)"',
  '}',
];

const RDP = [
  'try {',
  "  Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0 -ErrorAction Stop",
  "  Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name UserAuthentication -Value 1 -ErrorAction Stop",
  "  Enable-NetFirewallRule -Name 'RemoteDesktop-UserMode-In-TCP', 'RemoteDesktop-UserMode-In-UDP' -ErrorAction Stop",
  '  Set-Service TermService -StartupType Automatic',
  '  Start-Service TermService -ErrorAction Stop',
  "  'Bureau à distance actif sur le port 3389 (authentification NLA exigée)'",
  '} catch {',
  '  "Bureau à distance non configuré : $($_.Exception.Message)"',
  '}',
];

function renameComputer(name) {
  return [
    '$forgeRename = $false',
    'try {',
    `  if ($env:COMPUTERNAME -ne ${psString(name)}) {`,
    `    Rename-Computer -NewName ${psString(name)} -Force -ErrorAction Stop`,
    '    $forgeRename = $true',
    `    ${psString(`Nom de l'ordinateur : ${name} (appliqué au redémarrage, dans 15 secondes)`)}`,
    `  } else { ${psString(`Nom de l'ordinateur : ${name} (déjà en place)`)} }`,
    '} catch {',
    String.raw`  "Nom de l'ordinateur inchangé : $($_.Exception.Message)"`,
    '}',
  ];
}

function windowsTimeServers(servers) {
  return [
    'Set-Service w32time -StartupType Automatic',
    'Start-Service w32time -ErrorAction SilentlyContinue',
    `w32tm.exe /config ${psString(`/manualpeerlist:${servers.map((s) => `${s},0x8`).join(' ')}`)} /syncfromflags:manual /reliable:no /update | Out-Null`,
    'Restart-Service w32time',
    'w32tm.exe /resync /nowait | Out-Null',
    psString(`Serveurs de temps : ${servers.join(', ')}`),
  ];
}

function windowsFirstBoot({ vars, user, publicKeys, hasCommands }) {
  const wipe = String(vars.destroy_cloud_config) === 'true';
  const ntp = csvList(vars.ntp_servers);
  return [
    "$ErrorActionPreference = 'Continue'",
    `Start-Transcript -Path '${FIRST_BOOT_LOG}' -Append | Out-Null`,
    ...(publicKeys.length ? [
      "$keyFile = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'",
      'New-Item -ItemType Directory -Force (Split-Path $keyFile) | Out-Null',
      `[IO.File]::WriteAllLines($keyFile, [string[]]@(${publicKeys.map(psString).join(', ')}))`,
      "icacls.exe $keyFile /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null",
    ] : []),
    ...(wipe ? WIPE_CONFIG_DRIVE : ["Get-CimInstance Win32_Volume -Filter \"Label='cidata'\" | Where-Object DriveLetter | ForEach-Object { mountvol.exe $_.DriveLetter /D }"]),
    ...EXTEND_SYSTEM_DRIVE,
    ...addToAdministrators(user),
    ...(vars.disable_builtin_admin === 'false' ? [] : disableBuiltinAdmin(user)),
    ...(vars.password_never_expires === 'true' ? passwordNeverExpires(user) : []),
    ...(vars.winrm_https === 'true' ? WINRM_HTTPS : []),
    ...(vars.rdp_enabled === 'true' ? RDP : []),
    ...(ntp.length ? windowsTimeServers(ntp) : []),
    ...(hasCommands ? runUserCommands(powershellTimeout(vars)) : []),
    ...renameComputer(computerNameOf(vars, hostLabel(vars.vm_name) || 'vm')),
    'Stop-Transcript | Out-Null',
    ...(String(vars.cleanup_first_boot) !== 'false'
      ? [`Remove-Item -LiteralPath ${[FIRST_BOOT, FIRST_BOOT_LOG, COMMANDS, COMMANDS_LOG].map(psString).join(', ')} -Force -ErrorAction SilentlyContinue`]
      : []),
    "if ($forgeRename) { shutdown.exe /r /t 15 /c 'Forge : application du nom de l''ordinateur' | Out-Null }",
    '',
  ].join('\r\n');
}

function userCommandsScript(commands) {
  return [
    "$ErrorActionPreference = 'Continue'",
    `Start-Transcript -Path '${COMMANDS_LOG}' -Append | Out-Null`,
    ...commands,
    'Stop-Transcript | Out-Null',
    '',
  ].join('\r\n');
}

const psFile = (content) => Buffer.from(`\uFEFF${content}`, 'utf8').toString('base64');

export function buildWindowsUserData({ vars = {}, user, password = '', publicKeys = [] }) {
  if (String(vars.cloud_init_yaml || '').trim()) return `${String(vars.cloud_init_yaml).trim()}\n`;

  const zone = String(vars.timezone || '').trim();
  const timezone = WINDOWS_TIMEZONES[zone] ? zone : '';
  const commands = lineList(vars.powershell_commands);
  const files = [
    [FIRST_BOOT, windowsFirstBoot({ vars, user, publicKeys, hasCommands: commands.length > 0 })],
    ...(commands.length ? [[COMMANDS, userCommandsScript(commands)]] : []),
  ];
  return [
    '#cloud-config',
    'write_files:',
    ...files.flatMap(([file, content]) => [
      `  - path: ${yamlScalar(file)}`,
      '    encoding: b64',
      `    content: ${yamlScalar(psFile(content))}`,
    ]),
    ...(timezone ? [`set_timezone: ${yamlScalar(timezone)}`] : []),
    'users:',
    `  - name: ${yamlScalar(user)}`,
    ...(password ? [`    passwd: ${yamlScalar(password)}`] : []),
    `    gecos: ${yamlScalar('Admin (OpenTofu)')}`,
    'runcmd:',
    `  - ${yamlScalar(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${FIRST_BOOT}"`)}`,
    '',
  ].join('\n');
}

export function buildNetworkConfig({ vars = {}, mac, extra = [], dhcpType = 'dhcp4' }) {
  const ip = String(vars.network_static_ip || '').trim();
  const dns = csvList(vars.network_dns);
  const subnet = ip
    ? [
      '      - type: static',
      `        address: ${yamlScalar(ip)}`,
      `        netmask: ${yamlScalar(cidrToNetmask(vars.network_cidr))}`,
      ...(vars.network_gateway ? [`        gateway: ${yamlScalar(vars.network_gateway)}`] : []),
      ...(dns.length ? ['        dns_nameservers:', ...list(10, dns)] : []),
    ]
    : [`      - type: ${dhcpType}`];
  const physical = (index, ifMac, subnets) => [
    '  - type: physical',
    `    name: ${guestInterface(index)}`,
    `    mac_address: ${yamlScalar(ifMac)}`,
    '    subnets:',
    ...subnets,
  ];
  return [
    'version: 1',
    'config:',
    ...physical(0, mac, subnet),
    ...extra.flatMap((n, i) => physical(i + 1, n.mac, [
      '      - type: static',
      `        address: ${yamlScalar(n.ip)}`,
      `        netmask: ${yamlScalar(cidrToNetmask(n.cidr))}`,
    ])),
    '',
  ].join('\n');
}
