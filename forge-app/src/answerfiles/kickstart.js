import { LOCKED_PASSWORD, buildAccountCommands, cidrToNetmask, csvList, hostnameOf, ipv6Disabled, isStatic, xkbLayout } from './common.js';
import { kickstartSource } from '../os.js';

export function build({ vars = {}, hash = '', username: user, publicKey = '' } = {}) {
  const major = Number(vars.os_major) || 9;
  const src = kickstartSource(vars.iso_url);
  const dns = csvList(vars.network_dns).join(',');
  const noIpv6 = ipv6Disabled(vars);
  const network = isStatic(vars)
    ? `network --bootproto=static --ip=${vars.network_static_ip}`
      + ` --netmask=${cidrToNetmask(vars.network_cidr)}`
      + (vars.network_gateway ? ` --gateway=${vars.network_gateway}` : '')
      + (dns ? ` --nameserver=${dns}` : '')
    : 'network --bootproto=dhcp --device=link';
  return [
    'text',
    ...(src ? [src.mirrorlist ? `url --mirrorlist=${src.mirrorlist}` : `url --url=${src.url}`, ...src.repos] : ['cdrom']),
    `lang ${(vars.locale || 'en_US.UTF-8').trim()}`,
    `keyboard --xlayouts=${xkbLayout(vars.keyboard_layout || 'us')}`,
    `timezone --utc ${(vars.timezone || 'UTC').trim()}`,
    network
      + (noIpv6 ? ' --noipv6' : '')
      + (major >= 7 ? ' --activate' : ' --onboot=yes')
      + ` --hostname=${hostnameOf(vars)}`,
    'rootpw --lock',
    `user --name=${user} --groups=wheel ${hash === LOCKED_PASSWORD ? '--lock' : `--iscrypted --password=${hash}`}`,
    'services --enabled=sshd',
    'zerombr',
    'clearpart --all --initlabel',
    'reqpart',
    'part / --fstype=xfs --size=4096 --grow',
    `bootloader --location=mbr${noIpv6 ? ' --append="ipv6.disable=1"' : ''}`,
    'reboot',
    '',
    '%packages',
    '@core',
    '%end',
    '',
    '%post --erroronfail',
    ...buildAccountCommands(user, publicKey),
    '%end',
    '',
  ].join('\n');
}
