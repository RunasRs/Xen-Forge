#!/bin/bash
set -eEu
step='Unexpected error'
trap '{ [ "$BASH_SUBSHELL" -ne 0 ] || echo "Error: $step" >&2; } 9>/dev/null' ERR
if [ "${COMMAND_TRACE:-false}" = true ]; then exec 9>&1; BASH_XTRACEFD=9; set -x; fi

{ step='Failed to reset network configuration'; } 9>/dev/null
rm -f /etc/NetworkManager/system-connections/*.nmconnection
if [ -d /etc/netplan ]; then
  rm -f /etc/netplan/*.yaml /etc/cloud/cloud.cfg.d/99-installer.cfg /etc/cloud/cloud.cfg.d/subiquity-disable-cloudinit-networking.cfg
fi
if [ -f /etc/network/interfaces ]; then
  printf '%s\n' 'source /etc/network/interfaces.d/*' '' 'auto lo' 'iface lo inet loopback' > /etc/network/interfaces
  rm -f /etc/network/interfaces.d/*
fi
if [ -d /etc/sysconfig/network ] && ls /etc/sysconfig/network/ifcfg-* >/dev/null 2>&1; then
  for f in /etc/sysconfig/network/ifcfg-*; do
    [ "$f" = /etc/sysconfig/network/ifcfg-lo ] || printf '%s\n' "BOOTPROTO='dhcp'" "STARTMODE='auto'" > "$f"
  done
  rm -f /etc/sysconfig/network/routes
  sed -i 's/^NETCONFIG_DNS_STATIC_SERVERS=.*/NETCONFIG_DNS_STATIC_SERVERS=""/' /etc/sysconfig/network/config
fi
rm -rf /var/lib/NetworkManager/*.lease /var/lib/dhclient/* /var/lib/dhcp/* /var/lib/dhcpcd/* /var/lib/wicked/lease-*

{ step='Failed to write SSH configuration'; } 9>/dev/null
conf='PermitRootLogin no'
[ "${IPV6_ENABLED:-false}" = true ] || conf="$conf
AddressFamily inet"
if grep -qsE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config /usr/etc/ssh/sshd_config; then
  mkdir -p /etc/ssh/sshd_config.d
  printf '%s\n' "# Template (dashboard Packer)" "$conf" > /etc/ssh/sshd_config.d/10-template.conf
else
  printf '%s\n' "# Template (dashboard Packer)" "$conf" | cat - /etc/ssh/sshd_config > /etc/ssh/sshd_config.new
  mv /etc/ssh/sshd_config.new /etc/ssh/sshd_config
fi
sshd=$(command -v sshd || echo /usr/sbin/sshd)
{ step='Invalid SSH configuration'; } 9>/dev/null
"$sshd" -t
{ step='SSH root login not disabled'; } 9>/dev/null
"$sshd" -T | grep -qix 'permitrootlogin no'

{ step='Failed to clean packages'; } 9>/dev/null
if command -v apt-get >/dev/null 2>&1; then
  apt-get -y autoremove --purge
  apt-get clean
  rm -rf /var/lib/apt/lists/*
elif command -v dnf >/dev/null 2>&1; then
  old=$(dnf -q repoquery --installonly --latest-limit=-1)
  [ -z "$old" ] || dnf -y remove $old
  dnf clean all
  rm -rf /var/cache/dnf
else
  zypper --non-interactive purge-kernels
  zypper --non-interactive clean --all
fi
{ step='Failed to remove build files from /tmp'; } 9>/dev/null
rm -f /tmp/SHA256SUMS /tmp/xen-guest-agent* /tmp/script_*.sh

{ step='Failed to write /etc/template-release'; } 9>/dev/null
. /etc/os-release
clean() { printf '%s' "$1" | tr -d "'\\\\"; }
printf "%s='%s'\n" \
  TEMPLATE_PROFILE "$(clean "${TEMPLATE_PROFILE:-}")" \
  TEMPLATE_OS "$(clean "$PRETTY_NAME")" \
  BUILD_DATE "$(clean "${BUILD_DATE:-}")" \
  BUILD_NETWORK "${NET_MODE:-}" \
  OS_UPDATE "${OS_UPDATE:-false}" \
  IPV6_ENABLED "${IPV6_ENABLED:-false}" \
  SWAP_ENABLED "${SWAP_ENABLED:-false}" \
  SWAP_SIZE_GB "$([ "${SWAP_ENABLED:-false}" = true ] && echo "${SWAP_SIZE_GB:-}" || echo 0)" \
  XEN_GUEST_AGENT "$(dpkg-query -W -f='${Version}' xen-guest-agent 2>/dev/null || rpm -q --qf '%{VERSION}' xen-guest-agent)" > /etc/template-release

{ step='Failed to reset cloud-init'; } 9>/dev/null
cloud-init clean --logs --seed
rm -f /etc/cloud/cloud-init.disabled
{ step='Failed to reset machine-id'; } 9>/dev/null
rm -f /var/lib/dbus/machine-id
truncate -s 0 /etc/machine-id
{ step='Failed to clear logs and shell history'; } 9>/dev/null
find /var/log -type f -exec truncate -s 0 {} +
rm -rf /var/log/journal/* /var/tmp/* /root/.*_history /home/*/.*_history
{ step='Failed to remove installer files'; } 9>/dev/null
rm -rf /root/anaconda-ks.cfg /root/original-ks.cfg /root/initial-setup-ks.cfg /root/autoinst.xml /var/adm/autoinstall /var/log/installer /var/log/anaconda

