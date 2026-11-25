import { buildAccountCommands, csvList, hostnameOf, ipv6Disabled, isStatic, xkbLayout } from './common.js';

function connection(vars) {
  const base = { id: 'eth0', interface: 'eth0', method6: ipv6Disabled(vars) ? 'disabled' : 'auto' };
  if (!isStatic(vars)) return { ...base, method4: 'auto' };
  const dns = csvList(vars.network_dns);
  return {
    ...base,
    method4: 'manual',
    addresses: [`${vars.network_static_ip}/${vars.network_cidr}`],
    ...(vars.network_gateway ? { gateway4: vars.network_gateway } : {}),
    ...(dns.length ? { nameservers: dns } : {}),
  };
}

function postScript({ user, publicKey }) {
  return [
    '#!/bin/bash',
    'set -eux',
    ...buildAccountCommands(user, publicKey),
    'systemctl enable sshd',
    'ln -sf /dev/null /etc/udev/rules.d/80-net-setup-link.rules',
    '',
  ].join('\n');
}

export function build({ vars = {}, hash = '', username: user, publicKey = '' } = {}) {
  const profile = {
    product: { id: 'openSUSE_Leap' },
    localization: {
      language: vars.locale || 'en_US.UTF-8',
      keyboard: xkbLayout(vars.keyboard_layout || 'us'),
      timezone: vars.timezone || 'UTC',
    },
    hostname: { static: hostnameOf(vars) },
    user: {
      userName: user,
      fullName: user,
      hashedPassword: true,
      password: hash,
      ...(publicKey ? { sshPublicKey: publicKey } : {}),
    },
    software: { packages: ['openssh', 'sudo', 'curl'] },
    storage: {
      drives: [{ partitions: [{ filesystem: { path: '/', type: 'ext4' } }] }],
    },
    network: { connections: [connection(vars)] },
    bootloader: { extraKernelParams: 'net.ifnames=0' },
    scripts: {
      post: [{
        name: 'packer',
        chroot: true,
        content: postScript({ user, publicKey }),
      }],
    },
  };
  return `${JSON.stringify(profile, null, 2)}\n`;
}
