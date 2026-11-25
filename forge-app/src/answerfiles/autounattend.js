import { cidrToNetmask, csvList, hostnameOf, ipv6Disabled, isStatic, lineList, xmlEscape } from './common.js';

const WINDOWS_KEYBOARDS = {
  us: '0409:00000409', fr: '040c:0000040c', de: '0407:00000407', es: '040a:0000040a',
  it: '0410:00000410', uk: '0809:00000809', be: '080c:0000080c', ch: '100c:0000100c',
  ca: '0c0c:00000c0c', pt: '0816:00000816', nl: '0413:00000413', fi: '040b:0000040b',
  sv: '041d:0000041d', dk: '0406:00000406', no: '0414:00000414', ru: '0419:00000419',
  pl: '0415:00010415', cz: '0405:00000405', hu: '040e:0000040e', ro: '0418:00000418',
};

export const WINDOWS_UI_LANGUAGES = [
  'fr-FR', 'en-US', 'de-DE', 'es-ES', 'it-IT', 'en-GB', 'fr-CA', 'pt-PT', 'nl-NL',
  'fi-FI', 'sv-SE', 'da-DK', 'nb-NO', 'ru-RU', 'pl-PL', 'cs-CZ', 'hu-HU', 'ro-RO',
];

const uiLanguageOf = (vars) => (WINDOWS_UI_LANGUAGES.includes(vars.windows_ui_language) ? vars.windows_ui_language : 'en-US');

const winCultureOf = (locale = 'en_US.UTF-8') =>
  String(locale).split('.')[0].replace('_', '-');

export const WINDOWS_TIMEZONES = {
  'Europe/Paris': 'Romance Standard Time',
  'Europe/London': 'GMT Standard Time',
  'Europe/Berlin': 'W. Europe Standard Time',
  'Europe/Madrid': 'Romance Standard Time',
  'Europe/Rome': 'W. Europe Standard Time',
  'Europe/Brussels': 'Romance Standard Time',
  'Europe/Amsterdam': 'W. Europe Standard Time',
  'Europe/Vienna': 'W. Europe Standard Time',
  'Europe/Zurich': 'W. Europe Standard Time',
  'Europe/Stockholm': 'W. Europe Standard Time',
  'Europe/Copenhagen': 'Romance Standard Time',
  'Europe/Oslo': 'W. Europe Standard Time',
  'Europe/Helsinki': 'FLE Standard Time',
  'America/New_York': 'Eastern Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Toronto': 'Eastern Standard Time',
  'Asia/Tokyo': 'Tokyo Standard Time',
  'Asia/Shanghai': 'China Standard Time',
  'Asia/Seoul': 'Korea Standard Time',
  'Asia/Hong_Kong': 'China Standard Time',
  'Asia/Singapore': 'Singapore Standard Time',
  'Asia/Dubai': 'Arabian Standard Time',
  'Australia/Sydney': 'AUS Eastern Standard Time',
  'Australia/Melbourne': 'AUS Eastern Standard Time',
  'Pacific/Auckland': 'New Zealand Standard Time',
  'UTC': 'UTC',
};

export const computerNameOf = (vars, fallback = '') => hostnameOf(vars, fallback).split('.')[0].replace(/[^A-Za-z0-9-]/g, '').slice(0, 15).replace(/-+$/, '');

const powershell = (cmd) => `powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`;

const partition = (order, attrs) => `            <CreatePartition wcm:action="add"><Order>${order}</Order>${attrs}</CreatePartition>\n`;
const format = (order, id, attrs) => `            <ModifyPartition wcm:action="add"><Order>${order}</Order><PartitionID>${id}</PartitionID>${attrs}</ModifyPartition>\n`;

const DISK_LAYOUTS = {
  bios: {
    windowsPartition: 2,
    create: [partition(1, '<Type>Primary</Type><Size>350</Size>'), partition(2, '<Type>Primary</Type><Extend>true</Extend>')],
    modify: [
      format(1, 1, '<Format>NTFS</Format><Label>System Reserved</Label><Active>true</Active>'),
      format(2, 2, '<Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter>'),
    ],
  },
  uefi: {
    windowsPartition: 3,
    create: [
      partition(1, '<Type>EFI</Type><Size>260</Size>'),
      partition(2, '<Type>MSR</Type><Size>16</Size>'),
      partition(3, '<Type>Primary</Type><Extend>true</Extend>'),
    ],
    modify: [
      format(1, 1, '<Format>FAT32</Format><Label>System</Label>'),
      format(2, 3, '<Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter>'),
    ],
  },
};

const diskLayout = (vars) => DISK_LAYOUTS[vars.firmware === 'uefi' ? 'uefi' : 'bios'];

const diskXml = (layout) => [
  '        <Disk wcm:action="add">\n',
  '          <DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk>\n',
  '          <CreatePartitions>\n',
  ...layout.create,
  '          </CreatePartitions>\n',
  '          <ModifyPartitions>\n',
  ...layout.modify,
  '          </ModifyPartitions>\n',
  '        </Disk>\n',
];

const AGENT_MSI_NAMES = "'managementagent*x64.msi', 'XenTools*x64.msi', 'XenDrivers*x64.msi'";
const AGENT_SERVICES = "'xenagent', 'XenSvc', 'xensvc'";
const AGENT_DETECT_LOG = 'C:\\Windows\\Temp\\xen-tools-detect.log';
const LIST_DRIVES = "[IO.DriveInfo]::GetDrives() | % { '{0} {1} pret={2}' -f $_.Name, $_.DriveType, $_.IsReady }";
const FIND_AGENT_MSI = "[IO.DriveInfo]::GetDrives() | ? { $_.DriveType -eq 'CDRom' -and $_.IsReady } |"
  + ` ForEach-Object { gci $_.RootDirectory.FullName -Recurse -Depth 2 -Include ${AGENT_MSI_NAMES} -EA 0 }`;
const AGENT_SCRIPT = 'xentools.ps1';
const AGENT_INSTALL_SCRIPT = [
  `$log = '${AGENT_DETECT_LOG}'`,
  "Add-Content $log 'Script lance'",
  'try {',
  `  $m = ${FIND_AGENT_MSI}`,
  "  Add-Content $log ('MSI : ' + ($m.FullName -join ', '))",
  '  if ($m) {',
  "    $p = Start-Process msiexec.exe -ArgumentList '/i', $m[0].FullName, '/qn', '/norestart', '/l*v', 'C:\\Windows\\Temp\\xen-tools-install.log' -Wait -PassThru",
  "    Add-Content $log ('msiexec : code ' + $p.ExitCode)",
  '  }',
  "} catch { Add-Content $log ('Erreur : ' + $_) }",
  '',
].join('\r\n');
const TCPIP6_PARAMS = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters';

const ONLINE_DISK = 'cmd /c "(echo select disk 0 & echo online disk & echo attributes disk clear readonly) | diskpart"';

export function build({ vars = {}, sshPassword = '', username: buildUser } = {}) {
  const iface = 'Ethernet';
  const netmask = isStatic(vars) ? cidrToNetmask(vars.network_cidr) : '';
  const dns = csvList(vars.network_dns);

  const netshCommands = !isStatic(vars) ? [] : [
    `netsh interface ipv4 set address name="${iface}" static ${vars.network_static_ip} ${netmask}`
      + (vars.network_gateway ? ` ${vars.network_gateway}` : ''),
    ...(dns.length ? [`netsh interface ipv4 set dnsservers name="${iface}" static ${dns[0]} primary`] : []),
    ...dns.slice(1).map((d, i) => `netsh interface ipv4 add dnsservers name="${iface}" ${d} index=${i + 2}`),
  ];

  const winCulture = winCultureOf(vars.locale || 'en_US.UTF-8');
  const uiLanguage = uiLanguageOf(vars);
  const inputLocale = WINDOWS_KEYBOARDS[String(vars.keyboard_layout || 'us').trim().toLowerCase()] || '0409:00000409';
  const winTimezone = WINDOWS_TIMEZONES[String(vars.timezone || 'UTC').trim()] || 'UTC';
  const imageIndex = Math.min(18, Math.max(1, parseInt(vars.windows_image_index, 10) || 2));
  const disk = diskLayout(vars);

  const firstLogon = [
    ...netshCommands.map((cmd) => ({ cmd, desc: 'Static IP configuration' })),
    ...(ipv6Disabled(vars)
      ? [{ ps: true, cmd: `New-ItemProperty -Path '${TCPIP6_PARAMS}' -Name DisabledComponents -PropertyType DWord -Value 0xFF -Force | Out-Null`, desc: 'Disabling IPv6' }]
      : []),
    { ps: true, cmd: "if ((Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0).State -ne 'Installed') { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 }", desc: 'Installing OpenSSH server if missing (preinstalled on Server 2025)' },
    {
      ps: true,
      cmd: "if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) { Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Any } else { New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -Profile Any }",
      desc: 'Firewall: allow SSH (TCP 22) on all network profiles',
    },
    { ps: true, cmd: `${LIST_DRIVES} | Set-Content '${AGENT_DETECT_LOG}'`, desc: 'XCP-ng agent: listing drives' },
    {
      ps: true,
      cmd: "[IO.DriveInfo]::GetDrives() | ? { $_.DriveType -eq 'CDRom' -and $_.IsReady } |"
        + ` % { Join-Path $_.Name '${AGENT_SCRIPT}' } | ? { Test-Path $_ } | Select-Object -First 1 |`
        + ' % { & ([scriptblock]::Create((Get-Content $_ -Raw))) }',
      desc: 'Installing the XCP-ng agent (build CD script)',
    },
    { ps: true, cmd: 'Set-Service sshd -StartupType Automatic', desc: 'SSH server: automatic startup' },
    { cmd: 'shutdown /r /f /t 5', desc: 'Restart: PV drivers and XCP-ng agent active, IP reporting' },
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">\n',
    '  <settings pass="windowsPE">\n',
    '    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">\n',
    `      <SetupUILanguage><UILanguage>${uiLanguage}</UILanguage><WillShowUI>OnError</WillShowUI></SetupUILanguage>\n`,
    `      <InputLocale>${inputLocale}</InputLocale>\n`,
    `      <SystemLocale>${winCulture}</SystemLocale>\n`,
    `      <UILanguage>${uiLanguage}</UILanguage>\n`,
    `      <UserLocale>${winCulture}</UserLocale>\n`,
    '    </component>\n',
    '    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">\n',
    '      <UserData><AcceptEula>true</AcceptEula>'
      + (String(vars.product_key || '').trim() ? `<ProductKey><Key>${xmlEscape(vars.product_key.trim())}</Key></ProductKey>` : '')
      + '</UserData>\n',
    '      <DiskConfiguration>\n',
    '        <WillShowUI>OnError</WillShowUI>\n',
    ...diskXml(disk),
    '      </DiskConfiguration>\n',
    '      <ImageInstall>\n',
    '        <OSImage>\n',
    `          <InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${imageIndex}</Value></MetaData></InstallFrom>\n`,
    `          <InstallTo><DiskID>0</DiskID><PartitionID>${disk.windowsPartition}</PartitionID></InstallTo>\n`,
    '          <WillShowUI>OnError</WillShowUI>\n',
    '          <InstallToAvailablePartition>false</InstallToAvailablePartition>\n',
    '        </OSImage>\n',
    '      </ImageInstall>\n',
    '      <RunSynchronous>\n',
    '        <RunSynchronousCommand wcm:action="add">\n',
    '          <Order>1</Order>\n',
    `          <Path>${xmlEscape(ONLINE_DISK)}</Path>\n`,
    '          <Description>Bringing disk 0 online (Server 2025)</Description>\n',
    '        </RunSynchronousCommand>\n',
    '      </RunSynchronous>\n',
    '    </component>\n',
    '  </settings>\n',
    '  <settings pass="specialize">\n',
    '    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">\n',
    `      <ComputerName>${xmlEscape(computerNameOf(vars))}</ComputerName>\n`,
    `      <TimeZone>${winTimezone}</TimeZone>\n`,
    '    </component>\n',
    '  </settings>\n',
    '  <settings pass="oobeSystem">\n',
    '    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">\n',
    '      <OOBE>\n',
    '        <HideEULAPage>true</HideEULAPage>\n',
    '        <HideLocalAccountScreen>true</HideLocalAccountScreen>\n',
    '        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>\n',
    '        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>\n',
    '        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>\n',
    '        <ProtectYourPC>3</ProtectYourPC>\n',
    '      </OOBE>\n',
    '      <UserAccounts>\n',
    `        <AdministratorPassword><Value>${xmlEscape(sshPassword)}</Value><PlainText>true</PlainText></AdministratorPassword>\n`,
    '        <LocalAccounts>\n',
    '          <LocalAccount wcm:action="add">\n',
    `            <Name>${xmlEscape(buildUser)}</Name>\n`,
    '            <Group>Administrators</Group>\n',
    `            <DisplayName>${xmlEscape(buildUser)}</DisplayName>\n`,
    `            <Password><Value>${xmlEscape(sshPassword)}</Value><PlainText>true</PlainText></Password>\n`,
    '          </LocalAccount>\n',
    '        </LocalAccounts>\n',
    '      </UserAccounts>\n',
    '      <AutoLogon>\n',
    '        <Enabled>true</Enabled>\n',
    `        <Username>${xmlEscape(buildUser)}</Username>\n`,
    '        <LogonCount>1</LogonCount>\n',
    `        <Password><Value>${xmlEscape(sshPassword)}</Value><PlainText>true</PlainText></Password>\n`,
    '      </AutoLogon>\n',
    '      <FirstLogonCommands>\n',
    ...firstLogon.map(({ ps: wrap = false, cmd, desc }, i) =>
      `        <SynchronousCommand wcm:action="add"><Order>${i + 1}</Order><CommandLine>${xmlEscape(wrap ? powershell(cmd) : cmd)}</CommandLine><Description>${xmlEscape(desc)}</Description></SynchronousCommand>\n`),
    '      </FirstLogonCommands>\n',
    '    </component>\n',
    '  </settings>\n',
    '</unattend>\n',
  ].join('');
}

const CBI_DIR = 'C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init';
const CBI_MSI = 'C:\\Windows\\Temp\\CloudbaseInitSetup.msi';
const CBI_SHA256 = String(process.env.CLOUDBASE_INIT_SHA256 || '').toUpperCase();
const SETUP_DIR = 'C:\\Windows\\Setup\\Scripts';
const SYSPREP_UNATTEND = `${SETUP_DIR}\\sysprep-unattend.xml`;
const RUNNING_SCRIPTS = ['C:\\Windows\\Temp\\script.bat', 'C:\\Windows\\Temp\\packer-30-prepare.ps1'];

const CLOUDBASE_CONF = [
  '[DEFAULT]',
  'first_logon_behaviour=no',
  'netbios_host_name_compatibility=true',
  'allow_reboot=true',
  'stop_service_on_exit=false',
  'check_latest_version=false',
  `bsdtar_path=${CBI_DIR}\\bin\\bsdtar.exe`,
  `mtools_path=${CBI_DIR}\\bin\\`,
  `log_dir=${CBI_DIR}\\log\\`,
  'log_file=cloudbase-init.log',
  'verbose=true',
  'metadata_services=cloudbaseinit.metadata.services.nocloudservice.NoCloudConfigDriveService',
  `plugins=${[
    'cloudbaseinit.plugins.common.mtu.MTUPlugin',
    'cloudbaseinit.plugins.common.networkconfig.NetworkConfigPlugin',
    'cloudbaseinit.plugins.common.userdata.UserDataPlugin',
  ].join(',')}`,
  '',
  '[config_drive]',
  'types=vfat,iso',
  'locations=hdd,cdrom,partition',
  '',
].join('\r\n');

const RESET_DHCP = 'Get-NetAdapter | ForEach-Object {'
  + ' netsh interface ipv4 set address name="$($_.Name)" source=dhcp;'
  + ' netsh interface ipv4 set dnsservers name="$($_.Name)" source=dhcp }';

const setupComplete = (vars) => [
  ...(isStatic(vars) ? [powershell(RESET_DHCP)] : []),
  ...(String(vars.cloudbase_init) === 'true'
    ? ['sc.exe config cloudbase-init start= auto', 'sc.exe start cloudbase-init']
    : []),
  'del /f /q "%~f0"',
  '',
].join('\r\n');

function sysprepUnattend(vars, sshPassword, removedUser) {
  const winCulture = winCultureOf(vars.locale || 'en_US.UTF-8');
  const uiLanguage = uiLanguageOf(vars);
  const inputLocale = WINDOWS_KEYBOARDS[String(vars.keyboard_layout || 'us').trim().toLowerCase()] || '0409:00000409';
  const winTimezone = WINDOWS_TIMEZONES[String(vars.timezone || 'UTC').trim()] || 'UTC';
  const component = (name) => `    <component name="${name}" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">\n`;
  const runSync = (order, cmd, desc) => '        <RunSynchronousCommand wcm:action="add">'
    + `<Order>${order}</Order><Path>${xmlEscape(cmd)}</Path><Description>${xmlEscape(desc)}</Description></RunSynchronousCommand>\n`;
  return [
    '<?xml version="1.0" encoding="utf-8"?>\n',
    '<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">\n',
    '  <settings pass="generalize">\n',
    component('Microsoft-Windows-PnpSysprep'),
    '      <PersistAllDeviceInstalls>true</PersistAllDeviceInstalls>\n',
    '      <DoNotCleanUpNonPresentDevices>true</DoNotCleanUpNonPresentDevices>\n',
    '    </component>\n',
    '  </settings>\n',
    '  <settings pass="specialize">\n',
    component('Microsoft-Windows-Shell-Setup'),
    `      <TimeZone>${winTimezone}</TimeZone>\n`,
    '    </component>\n',
    component('Microsoft-Windows-Deployment'),
    '      <RunSynchronous>\n',
    runSync(1, powershell(RESET_DHCP), 'Build network returned to DHCP'),
    runSync(2, `cmd /c del /f /q ${RUNNING_SCRIPTS.map((f) => `"${f}"`).join(' ')}`, 'Removing build scripts'),
    runSync(3, `cmd /c del /f /q "${SYSPREP_UNATTEND}"`, 'Removing answer file'),
    ...(removedUser ? [runSync(4, powershell(`Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -eq ${psQuote(`C:\\Users\\${removedUser}`)} } | Remove-CimInstance`), 'Removing the build account profile')] : []),
    '      </RunSynchronous>\n',
    '    </component>\n',
    '  </settings>\n',
    '  <settings pass="oobeSystem">\n',
    component('Microsoft-Windows-International-Core'),
    `      <InputLocale>${inputLocale}</InputLocale>\n`,
    `      <SystemLocale>${winCulture}</SystemLocale>\n`,
    `      <UILanguage>${uiLanguage}</UILanguage>\n`,
    `      <UserLocale>${winCulture}</UserLocale>\n`,
    '    </component>\n',
    component('Microsoft-Windows-Shell-Setup'),
    '      <OOBE>\n',
    '        <HideEULAPage>true</HideEULAPage>\n',
    '        <HideLocalAccountScreen>true</HideLocalAccountScreen>\n',
    '        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>\n',
    '        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>\n',
    '        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>\n',
    '        <ProtectYourPC>3</ProtectYourPC>\n',
    '      </OOBE>\n',
    '      <UserAccounts>\n',
    `        <AdministratorPassword><Value>${xmlEscape(sshPassword)}</Value><PlainText>true</PlainText></AdministratorPassword>\n`,
    '      </UserAccounts>\n',
    '    </component>\n',
    '  </settings>\n',
    '</unattend>\n',
  ].join('');
}

const psHereString = (s) => {
  if (/^'@/m.test(s)) throw new Error('Contenu incompatible avec une here-string PowerShell');
  return `@'\n${s}\n'@`;
};

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

const CLOUDBASE_STEPS = [
  `$cbi = '${CBI_DIR}'`,
  `$msi = '${CBI_MSI}'`,
  "Write-Output 'cloudbase-init: verifying package (SHA-256)'",
  `if ((Get-FileHash $msi -Algorithm SHA256).Hash -ne '${CBI_SHA256}') { throw "cloudbase-init: unexpected SHA-256 for $msi" }`,
  "Write-Output 'cloudbase-init: installing'",
  "$p = Start-Process msiexec.exe -ArgumentList '/i', \"`\"$msi`\"\", '/qn', '/norestart', 'RUN_SERVICE_AS_LOCAL_SYSTEM=1' -Wait -PassThru",
  'if ($p.ExitCode -ne 0) { throw "cloudbase-init installation: msiexec failed (code $($p.ExitCode))" }',
  'Stop-Service cloudbase-init -ErrorAction SilentlyContinue',
  '',
  "Write-Output 'cloudbase-init: configuring (NoCloud config drive)'",
  `$conf = ${psHereString(CLOUDBASE_CONF)}`,
  "[IO.File]::WriteAllText((Join-Path $cbi 'conf\\cloudbase-init.conf'), $conf)",
  'Set-Service cloudbase-init -StartupType Manual',
  "Remove-Item 'HKLM:\\SOFTWARE\\Cloudbase Solutions' -Recurse -Force -ErrorAction SilentlyContinue",
  "Remove-Item (Join-Path $cbi 'log\\*') -Force -ErrorAction SilentlyContinue",
  '',
];

const REMOVE_USER_APPX = [
  "Write-Output 'Cleanup: non-provisioned AppX packages (Edge automatic update)'",
  'Get-Service edgeupdate, edgeupdatem -ErrorAction SilentlyContinue | Stop-Service -Force -ErrorAction SilentlyContinue',
  "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\Microsoft\\Edge*' } | Stop-Process -Force -ErrorAction SilentlyContinue",
  'try {',
  '  $provisioned = Get-AppxProvisionedPackage -Online | ForEach-Object { "$($_.DisplayName)_$($_.Version)" }',
  '  $extra = Get-AppxPackage -AllUsers | Where-Object { -not $_.NonRemovable -and -not $_.IsFramework -and $_.SignatureKind -ne \'System\' -and "$($_.Name)_$($_.Version)" -notin $provisioned }',
  '  foreach ($p in $extra) {',
  '    Write-Output "AppX removed: $($p.PackageFullName)"',
  '    try { Remove-AppxPackage -Package $p.PackageFullName -AllUsers } catch { Write-Output "AppX: removal failed: $_" }',
  '  }',
  '} catch { Write-Output "AppX: cleanup skipped: $_" }',
  '',
];

const REMOVE_RECOVERY_PARTITION = [
  '$c = Get-Partition -DriveLetter C',
  '$rec = Get-Partition -DiskNumber $c.DiskNumber | Where-Object { $_.Offset -gt $c.Offset -and ($_.MbrType -eq 39 -or $_.GptType -eq \'{de94bba4-06d1-4d40-a16a-bfd50179d6ac}\') }',
  'if ($rec) {',
  "  Write-Output 'Cleanup: recovery partition after C: removed, WinRE moved to C:'",
  '  reagentc.exe /disable | Out-Null',
  '  if ($LASTEXITCODE) { throw "reagentc /disable failed (code $LASTEXITCODE)" }',
  '  $rec | Remove-Partition -Confirm:$false',
  '  reagentc.exe /enable | Out-Null',
  '  if ($LASTEXITCODE) { throw "reagentc /enable failed (code $LASTEXITCODE)" }',
  '}',
  '',
];

const PS_HEADER = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }',
  '',
];

function baseScript(vars) {
  const cloudbase = String(vars.cloudbase_init) === 'true';
  return [
    ...PS_HEADER,
    `$agent = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -in ${AGENT_SERVICES} -or $_.DisplayName -match 'X(en|CP-ng).*Agent' } | Select-Object -First 1`,
    'if (-not $agent) {',
    "  $log = 'C:\\Windows\\Temp\\xen-tools-install.log'",
    '  if (Test-Path $log) { Get-Content $log -Encoding Unicode -ErrorAction SilentlyContinue | Select-Object -Last 20 }',
    "  Write-Output 'Agent missing: drives at first logon'",
    `  Get-Content '${AGENT_DETECT_LOG}' -ErrorAction SilentlyContinue`,
    "  Write-Output 'Agent missing: drives now'",
    `  ${LIST_DRIVES}`,
    `  Write-Output ('MSI : ' + ((${FIND_AGENT_MSI}).FullName -join ', '))`,
    "  throw \"XCP-ng agent missing: Windows guest tools MSI not found on the ISO (tools_iso_name) or installation failed\"",
    '}',
    'Write-Output "XCP-ng agent: service $($agent.Name)"',
    'Set-Service $agent.Name -StartupType Automatic',
    '',
    ...(cloudbase ? CLOUDBASE_STEPS : ["Write-Output 'cloudbase-init: disabled (option Prepare for OpenTofu off)'", '']),
    "Set-Service sshd -StartupType Automatic",
    "foreach ($s in @('sshd', $agent.Name)) {",
    "  if ((Get-Service $s).StartType -ne 'Automatic') { throw \"Service ${s}: automatic startup not configured\" }",
    '  Write-Output "Service ${s}: automatic"',
    '}',
    ...(cloudbase ? [
      "if ((Get-Service cloudbase-init).StartType -ne 'Manual') { throw 'Service cloudbase-init: manual startup not configured' }",
      "Write-Output 'Service cloudbase-init: manual, automatic after OOBE (SetupComplete.cmd)'",
    ] : []),
    '',
  ].join('\r\n');
}

function profileScript(vars) {
  const cmds = lineList(vars.powershell_commands);
  return [
    ...PS_HEADER,
    ...(cmds.length ? cmds.flatMap((cmd) => [
      `Write-Output ${psQuote(`> ${cmd}`)}`,
      '$global:LASTEXITCODE = 0',
      cmd,
      `if ($LASTEXITCODE) { throw "Profile command failed (code $LASTEXITCODE)" }`,
    ]) : ["Write-Output 'No PowerShell commands defined in the profile.'"]),
    '',
  ].join('\r\n');
}

function prepareScript(vars, sshPassword, username) {
  const removedUser = String(vars.remove_build_user) === 'true' ? username : '';
  const winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon';
  return [
    ...PS_HEADER,
    `$setup = '${SETUP_DIR}'`,
    '',
    ...(String(vars.os_update) === 'true' ? [
      "Write-Output 'Cleanup: components superseded by Windows Update (DISM)'",
      '$p = Start-Process dism.exe -ArgumentList \'/Online\', \'/Cleanup-Image\', \'/StartComponentCleanup\' -Wait -PassThru -NoNewWindow',
      'if ($p.ExitCode -ne 0) { throw "DISM /StartComponentCleanup failed (code $($p.ExitCode))" }',
      '',
    ] : []),
    "Write-Output 'Cleanup: automatic logon, answer files'",
    `Set-ItemProperty '${winlogon}' -Name AutoAdminLogon -Value '0'`,
    `Remove-ItemProperty '${winlogon}' -Name DefaultPassword -ErrorAction SilentlyContinue`,
    "Remove-Item 'C:\\Windows\\Panther\\unattend.xml', 'C:\\Windows\\Panther\\unattend-original.xml' -Force -ErrorAction SilentlyContinue",
    '',
    "Write-Output 'Cleanup: temporary files, Windows Update cache, logs'",
    `Remove-Item '${CBI_MSI}', 'C:\\Windows\\Temp\\packer-10-base.ps1', 'C:\\Windows\\Temp\\packer-20-profile.ps1', 'C:\\Windows\\Temp\\xen-tools-install.log' -Force -ErrorAction SilentlyContinue`,
    "Get-ChildItem 'C:\\Windows\\Temp', $env:TEMP -Exclude 'script.bat', 'packer-30-prepare.ps1' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue",
    'Stop-Service wuauserv -Force -ErrorAction SilentlyContinue',
    "Remove-Item 'C:\\Windows\\SoftwareDistribution\\Download\\*' -Recurse -Force -ErrorAction SilentlyContinue",
    'foreach ($l in [System.Diagnostics.Eventing.Reader.EventLogSession]::GlobalSession.GetLogNames()) {',
    '  try { [System.Diagnostics.Eventing.Reader.EventLogSession]::GlobalSession.ClearLog($l) } catch { }',
    '}',
    '',
    "Write-Output 'Check: no build leftovers before sysprep'",
    `if ((Get-ItemProperty '${winlogon}').DefaultPassword) { throw 'Automatic logon password still in the registry' }`,
    "if (Test-Path 'C:\\Windows\\Panther\\unattend.xml') { throw 'Panther\\unattend.xml still present' }",
    '',
    'New-Item -ItemType Directory -Force $setup | Out-Null',
    `$unattend = ${psHereString(sysprepUnattend(vars, sshPassword, removedUser))}`,
    `[IO.File]::WriteAllText('${SYSPREP_UNATTEND}', $unattend)`,
    ...(String(vars.cloudbase_init) === 'true' || isStatic(vars)
      ? [`[IO.File]::WriteAllText('${SETUP_DIR}\\SetupComplete.cmd', ${psHereString(setupComplete(vars))})`]
      : []),
    '',
    ...REMOVE_RECOVERY_PARTITION,
    ...REMOVE_USER_APPX,
    "Write-Output 'sysprep: generalizing (may take several minutes)'",
    "$tag = Join-Path $env:SystemRoot 'System32\\Sysprep\\Sysprep_succeeded.tag'",
    'Remove-Item $tag -Force -ErrorAction SilentlyContinue',
    "$p = Start-Process (Join-Path $env:SystemRoot 'System32\\Sysprep\\sysprep.exe') -ArgumentList '/generalize', '/oobe', '/quit', '/quiet', "
      + `'/unattend:${SYSPREP_UNATTEND}' -Wait -PassThru`,
    "$err = Join-Path $env:SystemRoot 'System32\\Sysprep\\Panther\\setuperr.log'",
    'if (-not (Test-Path $tag)) { if (Test-Path $err) { Get-Content $err | Select-Object -Last 30 }; throw "sysprep failed (code $($p.ExitCode))" }',
    ...(removedUser ? [
      `Write-Output ${psQuote(`Build account: removing ${removedUser}`)}`,
      `Remove-LocalUser -Name ${psQuote(removedUser)}`,
      `if (Get-LocalUser -Name ${psQuote(removedUser)} -ErrorAction SilentlyContinue) { throw 'Build account still present' }`,
      "$logonUi = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI'",
      "Remove-ItemProperty $logonUi -Name LastLoggedOnUser, LastLoggedOnSAMUser, LastLoggedOnDisplayName, LastLoggedOnUserSID, SelectedUserSID -ErrorAction SilentlyContinue",
    ] : []),
    "Write-Output 'Final verification: OK, the template will boot into specialize then OOBE'",
    '',
  ].join('\r\n');
}

export function scripts({ vars = {}, sshPassword = '', username = '' } = {}) {
  const bom = (s) => `\uFEFF${s}`;
  return {
    [`cd/${AGENT_SCRIPT}`]: AGENT_INSTALL_SCRIPT,
    'scripts/windows/packer-10-base.ps1': bom(baseScript(vars)),
    'scripts/windows/packer-20-profile.ps1': bom(profileScript(vars)),
    'scripts/windows/packer-30-prepare.ps1': bom(prepareScript(vars, sshPassword, username)),
  };
}
