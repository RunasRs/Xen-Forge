import { buildAccountCommands, xkbLayout } from './common.js';

const BASE_PACKAGES = ['openssh-server', 'sudo', 'ifupdown', 'resolvconf', 'ca-certificates', 'curl'];

const DISTROS = {
  debian: {
    mirror: ['deb.debian.org', '/debian'],
    settings: [
      'd-i apt-setup/services-select multiselect security, updates',
      'd-i apt-setup/non-free-firmware boolean true',
      'tasksel tasksel/first multiselect standard',
      'popularity-contest popularity-contest/participate boolean false',
    ],
    packages: [],
  },
  kali: {
    mirror: ['http.kali.org', '/kali'],
    settings: [
      'd-i mirror/suite string kali-rolling',
      'd-i mirror/codename string kali-rolling',
      'd-i apt-setup/services-select multiselect',
      'd-i apt-setup/contrib boolean true',
      'd-i apt-setup/non-free boolean true',
      'd-i apt-setup/non-free-firmware boolean true',
      'd-i pkgsel/run_tasksel boolean false',
    ],
    packages: ['kali-linux-core'],
  },
};

const DEBIAN_LAST_ARCHIVED = 11;
const debianMajor = (url) => Number(String(url || '').match(/debian-(\d+)\.[\d.]+-amd64/)?.[1]) || 0;

const ROOT_PARTITION = 'use_filesystem{ } filesystem{ ext4 } mountpoint{ / } .';
const PARTITION_RECIPES = {
  bios: `root :: 2048 10000 -1 ext4 $primary{ } $bootable{ } method{ format } format{ } ${ROOT_PARTITION}`,
  uefi: 'root :: 538 538 538 free $primary{ } method{ efi } format{ } . '
    + `2048 10000 -1 ext4 $primary{ } method{ format } format{ } ${ROOT_PARTITION}`,
};
const UEFI_SETTINGS = [
  'd-i partman-partitioning/default_label string gpt',
  'd-i grub-installer/force-efi-extra-removable boolean true',
];

function lateCommand({ user, publicKey }) {
  return `in-target sh -c "${[...buildAccountCommands(user, publicKey), 'systemctl enable ssh'].join(' && ')}"`;
}

function buildPreseed(distro, { vars = {}, hash = '', username: user, publicKey = '' } = {}) {
  const { mirror, settings, packages } = DISTROS[distro];
  const archived = distro === 'debian' && debianMajor(vars.iso_url) && debianMajor(vars.iso_url) <= DEBIAN_LAST_ARCHIVED;
  const [mirrorHost, mirrorDir] = archived ? ['archive.debian.org', '/debian'] : mirror;
  const include = [...BASE_PACKAGES, ...packages];
  const uefi = vars.firmware === 'uefi';

  return [
    `d-i debian-installer/locale string ${vars.locale || 'en_US.UTF-8'}`,
    `d-i keyboard-configuration/xkb-keymap select ${xkbLayout(vars.keyboard_layout || 'us')}`,
    'd-i hw-detect/load_firmware boolean false',

    'd-i mirror/country string manual',
    `d-i mirror/http/hostname string ${mirrorHost}`,
    `d-i mirror/http/directory string ${mirrorDir}`,
    'd-i mirror/http/proxy string',
    ...(archived ? ['d-i apt-setup/security_host string archive.debian.org'] : []),
    'd-i apt-setup/disable-cdrom-entries boolean true',
    'd-i apt-setup/enable-source-repositories boolean false',

    'd-i passwd/root-login boolean false',
    `d-i passwd/user-fullname string ${user}`,
    `d-i passwd/username string ${user}`,
    `d-i passwd/user-password-crypted password ${hash}`,

    'd-i clock-setup/utc boolean true',
    `d-i time/zone string ${vars.timezone || 'UTC'}`,
    'd-i clock-setup/ntp boolean true',

    'd-i partman/early_command string debconf-set partman-auto/disk "$(list-devices disk | head -n1)"',
    'd-i partman-auto/method string regular',
    `d-i partman-auto/expert_recipe string ${PARTITION_RECIPES[uefi ? 'uefi' : 'bios']}`,
    'd-i partman-auto/choose_recipe select root',
    'd-i partman-basicfilesystems/no_swap boolean false',
    'd-i partman-partitioning/confirm_write_new_label boolean true',
    'd-i partman/choose_partition select finish',
    'd-i partman/confirm boolean true',
    'd-i partman/confirm_nooverwrite boolean true',

    ...settings,
    `d-i pkgsel/include string ${include.join(' ')}`,
    'd-i pkgsel/upgrade select none',

    'd-i grub-installer/only_debian boolean true',
    'd-i grub-installer/bootdev string default',
    ...(uefi ? UEFI_SETTINGS : []),

    `d-i preseed/late_command string ${lateCommand({ user, publicKey })}`,
    'd-i cdrom-detect/eject boolean true',
    'd-i finish-install/reboot_in_progress note',
  ].join('\n') + '\n';
}

export const buildDebian = (ctx) => buildPreseed('debian', ctx);
export const buildKali = (ctx) => buildPreseed('kali', ctx);
