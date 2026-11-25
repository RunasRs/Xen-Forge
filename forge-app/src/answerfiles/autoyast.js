import { buildAccountCommands, cidrToNetmask, csvList, hostnameOf, ipv6Disabled, isStatic, xkbLayout, xmlEscape } from './common.js';

const YAST_KEYBOARDS = {
  fr: 'french', us: 'english-us', de: 'german', es: 'spanish', it: 'italian', gb: 'english-uk',
  be: 'belgian', ch: 'german-ch', ca: 'french-ca', pt: 'portugese', nl: 'dutch', fi: 'finnish',
  se: 'swedish', dk: 'danish', no: 'norwegian', ru: 'russian', pl: 'polish', cz: 'czech',
  hu: 'hungarian', ro: 'romanian',
};
const yastKeymap = (layout) => YAST_KEYBOARDS[xkbLayout(layout)] || xkbLayout(layout);

export function build({ vars = {}, hash = '', username: user, publicKey = '' } = {}) {
  const dns = csvList(vars.network_dns);
  const pkgs = ['openssh', 'sudo', 'curl'];
  const fixed = isStatic(vars);
  return [
    '<?xml version="1.0"?>\n',
    '<!DOCTYPE profile>\n',
    '<profile xmlns="http://www.suse.com/1.0/yast2ns" xmlns:config="http://www.suse.com/1.0/configns">\n',
    '  <general>\n    <mode>\n',
    '      <confirm config:type="boolean">false</confirm>\n',
    '      <final_reboot config:type="boolean">true</final_reboot>\n',
    '    </mode>\n  </general>\n',
    `  <language><language>${xmlEscape(String(vars.locale || 'en_US').split('.')[0])}</language></language>\n`,
    `  <keyboard><keymap>${xmlEscape(yastKeymap(vars.keyboard_layout || 'us'))}</keymap></keyboard>\n`,
    `  <timezone><timezone>${xmlEscape(vars.timezone || 'UTC')}</timezone><hwclock>UTC</hwclock></timezone>\n`,
    '  <networking>\n',
    `    <ipv6 config:type="boolean">${!ipv6Disabled(vars)}</ipv6>\n`,
    '    <interfaces config:type="list">\n      <interface>\n',
    ...(fixed
      ? ['        <bootproto>static</bootproto>\n        <device>eth0</device>\n',
          `        <ipaddr>${vars.network_static_ip}</ipaddr>\n`,
          `        <netmask>${cidrToNetmask(vars.network_cidr)}</netmask>\n`]
      : ['        <bootproto>dhcp</bootproto>\n        <device>eth0</device>\n']),
    '        <startmode>auto</startmode>\n',
    '      </interface>\n    </interfaces>\n',
    '    <dns>\n',
    `      <hostname>${xmlEscape(hostnameOf(vars))}</hostname>\n`,
    ...(fixed && dns.length
      ? ['      <nameservers config:type="list">\n',
          ...dns.map((d) => `        <nameserver>${d}</nameserver>\n`),
          '      </nameservers>\n']
      : []),
    '    </dns>\n',
    ...(fixed && vars.network_gateway
      ? ['    <routing>\n      <routes config:type="list">\n',
          '        <route><destination>default</destination><device>eth0</device>',
          `<gateway>${vars.network_gateway}</gateway></route>\n`,
          '      </routes>\n    </routing>\n']
      : []),
    '  </networking>\n',
    '  <firewall>\n    <enable_firewall config:type="boolean">false</enable_firewall>\n  </firewall>\n',
    '  <users config:type="list">\n',
    '    <user>\n',
    `      <username>${xmlEscape(user)}</username>\n`,
    '      <encrypted config:type="boolean">true</encrypted>\n',
    `      <user_password>${xmlEscape(hash)}</user_password>\n`,
    `      <shell>/bin/bash</shell>\n      <home>/home/${xmlEscape(user)}</home>\n    </user>\n`,
    '    <user>\n      <username>root</username>\n',
    '      <encrypted config:type="boolean">false</encrypted>\n',
    '      <user_password>!</user_password>\n',
    '    </user>\n  </users>\n',
    '  <software>\n    <patterns config:type="list">\n      <pattern>base</pattern>\n    </patterns>\n',
    '    <packages config:type="list">\n',
    ...pkgs.map((p) => `      <package>${xmlEscape(p)}</package>\n`),
    '    </packages>\n  </software>\n',
    '  <partitioning config:type="list">\n    <drive>\n',
    '      <initialize config:type="boolean">true</initialize>\n      <use>all</use>\n',
    '      <partitions config:type="list">\n        <partition>\n',
    '          <mount>/</mount>\n          <filesystem config:type="symbol">ext4</filesystem>\n          <size>max</size>\n',
    '        </partition>\n      </partitions>\n',
    '    </drive>\n  </partitioning>\n',
    '  <scripts>\n',
    '    <post-scripts config:type="list">\n      <script>\n',
    '        <filename>post.sh</filename>\n        <interpreter>shell</interpreter>\n',
    '        <source><![CDATA[\n',
    'set -e\n',
    ...buildAccountCommands(user, publicKey).map((c) => `${c}\n`),
    'systemctl enable sshd\n',
    'ln -sf /dev/null /etc/udev/rules.d/80-net-setup-link.rules\n',
    '        ]]></source>\n      </script>\n    </post-scripts>\n',
    '  </scripts>\n',
    '</profile>\n',
  ].join('');
}
