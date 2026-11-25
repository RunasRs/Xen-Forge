import { buildAccountCommands, csvList, hostnameOf, isStatic, xkbLayout, yamlScalar } from './common.js';

const INTERFACE_MATCH = 'en*';

export function build({ vars = {}, hash = '', username: user, publicKey = '' } = {}) {
  const dns = csvList(vars.network_dns);
  const lines = [
    '#cloud-config',
    'autoinstall:',
    '  version: 1',
    `  locale: ${yamlScalar((vars.locale || 'en_US.UTF-8').trim())}`,
    '  keyboard:',
    `    layout: ${yamlScalar(xkbLayout(vars.keyboard_layout || 'us'))}`,
    `  timezone: ${yamlScalar((vars.timezone || 'UTC').trim())}`,
    '  network:',
    '    version: 2',
    '    ethernets:',
    '      install:',
    '        match:',
    `          name: ${yamlScalar(INTERFACE_MATCH)}`,
    ...(isStatic(vars) ? [
      '        dhcp4: false',
      `        addresses: [${yamlScalar(`${vars.network_static_ip}/${vars.network_cidr}`)}]`,
      ...(vars.network_gateway ? ['        routes:', '          - to: default', `            via: ${yamlScalar(vars.network_gateway)}`] : []),
      ...(dns.length ? ['        nameservers:', `          addresses: [${dns.map(yamlScalar).join(', ')}]`] : []),
    ] : ['        dhcp4: true']),
    '  storage:',
    '    layout:',
    '      name: direct',
    '    swap:',
    '      size: 0',
    '  identity:',
    `    hostname: ${yamlScalar(hostnameOf(vars))}`,
    `    username: ${yamlScalar(user)}`,
    `    password: ${yamlScalar(hash)}`,
    '  ssh:',
    '    install-server: true',
    '    allow-pw: true',
    ...(publicKey ? ['    authorized-keys:', `      - ${yamlScalar(publicKey)}`] : []),
    '  late-commands:',
    ...buildAccountCommands(user, '', '/target').map((c) => `    - ${yamlScalar(c)}`),
  ];
  return lines.join('\n') + '\n';
}
