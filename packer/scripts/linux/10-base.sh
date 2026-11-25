#!/bin/bash
set -eEu
step='Unexpected error'
trap '{ [ "$BASH_SUBSHELL" -ne 0 ] || echo "Error: $step" >&2; } 9>/dev/null' ERR
if [ "${COMMAND_TRACE:-false}" = true ]; then exec 9>&1; BASH_XTRACEFD=9; set -x; fi

VENDOR=/tmp
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v zypper >/dev/null 2>&1; then PM=zypper
else echo 'Unsupported package manager (apt, dnf, zypper)' >&2; exit 1
fi
{ step='Failed to read /etc/os-release'; } 9>/dev/null
. /etc/os-release

verify() {
  grep "  $1\$" "$VENDOR/SHA256SUMS" | (cd "$VENDOR" && sha256sum -c -)
}
{ DEB=xen-guest-agent.deb; RPM=xen-guest-agent.rpm; } 9>/dev/null

case $PM in
  apt)
    { step='Failed to update package lists'; } 9>/dev/null
    apt-get -o Acquire::Retries=3 update
    { step='Failed to install cloud-init, growpart, chrony and curl'; } 9>/dev/null
    apt-get install -y --no-install-recommends cloud-init cloud-guest-utils chrony curl
    { step='Checksum mismatch for the xen-guest-agent package'; } 9>/dev/null
    verify $DEB
    { step='Failed to install xen-guest-agent'; } 9>/dev/null
    apt-get install -y "$VENDOR/$DEB"
    ;;
  dnf)
    { step='Failed to install cloud-init, growpart, chrony and curl'; } 9>/dev/null
    dnf -y install cloud-init cloud-utils-growpart chrony curl
    { step='Checksum mismatch for the xen-guest-agent package'; } 9>/dev/null
    verify $RPM
    { step='Failed to install xen-guest-agent'; } 9>/dev/null
    dnf -y install "$VENDOR/$RPM"
    { step='Failed to remove zram swap'; } 9>/dev/null
    if rpm -q zram-generator-defaults >/dev/null 2>&1; then
      dnf -y remove zram-generator-defaults
      swapoff -a
    fi
    ;;
  zypper)
    { step='Failed to install cloud-init, growpart, chrony and curl'; } 9>/dev/null
    zypper --non-interactive install cloud-init growpart chrony curl
    { step='Checksum mismatch for the xen-guest-agent package'; } 9>/dev/null
    verify $RPM
    { step='Failed to install xen-guest-agent'; } 9>/dev/null
    zypper --non-interactive install --allow-unsigned-rpm "$VENDOR/$RPM"
    ;;
esac
{ step='growpart not found'; } 9>/dev/null
command -v growpart
{ step='xen-guest-agent binary not found'; } 9>/dev/null
test -x /usr/sbin/xen-guest-agent

if [ "${SWAP_ENABLED:-false}" = true ]; then
  case ${SWAP_SIZE_GB:-} in
    ''|*[!0-9]*) echo "Invalid swap size : '${SWAP_SIZE_GB:-}'" >&2; exit 1 ;;
  esac
  { step='Failed to create /swapfile'; } 9>/dev/null
  if ! swapon --noheadings --show=NAME | grep -qx /swapfile; then
    rm -f /swapfile
    dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_SIZE_GB * 1024)) status=none
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
  fi
  { step='Failed to add /swapfile to /etc/fstab'; } 9>/dev/null
  grep -q '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi

{ step='Failed to configure cloud-init'; } 9>/dev/null
touch /etc/cloud/cloud-init.disabled

printf '%s\n' 'datasource_list: [ NoCloud, ConfigDrive, None ]' > /etc/cloud/cloud.cfg.d/90-xcp-ng.cfg
case $ID in
  debian|kali)
    printf '%s\n' 'system_info:' '  network:' '    renderers: [ eni ]' >> /etc/cloud/cloud.cfg.d/90-xcp-ng.cfg
    echo 'policy: search,found=all,maybe=all,notfound=enabled' > /etc/cloud/ds-identify.cfg
    ;;
esac
for u in cloud-init-local cloud-init cloud-init-network cloud-config cloud-final; do
  mkdir -p "/etc/systemd/system/$u.service.d"
  printf '%s\n' '[Service]' 'Environment=LC_ALL=C.UTF-8' > "/etc/systemd/system/$u.service.d/10-locale.conf"
done

{ step='Failed to set kernel boot arguments'; } 9>/dev/null
args=${KERNEL_ARGS:-}
[ "${IPV6_ENABLED:-false}" = true ] || args="$args ipv6.disable=1"
sed -i '/^GRUB_CMDLINE_LINUX/s/ *ipv6\.disable=1//' /etc/default/grub
for a in $args; do
  grep -q "^GRUB_CMDLINE_LINUX=.*$a" /etc/default/grub \
    || sed -i "s/^GRUB_CMDLINE_LINUX=\"\(.*\)\"/GRUB_CMDLINE_LINUX=\"\1 $a\"/" /etc/default/grub
  grep -q "^GRUB_CMDLINE_LINUX=.*$a" /etc/default/grub
done
if command -v grubby >/dev/null 2>&1; then
  [ "${IPV6_ENABLED:-false}" != true ] || grubby --update-kernel=ALL --remove-args=ipv6.disable=1
  [ -z "$(echo $args)" ] || grubby --update-kernel=ALL --args="$(echo $args)"
elif command -v update-grub >/dev/null 2>&1; then { step='Failed to update GRUB configuration'; } 9>/dev/null; update-grub
else { step='Failed to update GRUB configuration'; } 9>/dev/null; grub2-mkconfig -o /boot/grub2/grub.cfg
fi
