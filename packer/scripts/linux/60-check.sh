#!/bin/bash
set -eEu
step='Unexpected error'
trap '{ [ "$BASH_SUBSHELL" -ne 0 ] || echo "Error: $step" >&2; } 9>/dev/null' ERR
if [ "${COMMAND_TRACE:-false}" = true ]; then exec 9>&1; BASH_XTRACEFD=9; set -x; fi

fail() { echo "Final verification : $*" >&2; exit 1; }

for s in xen-guest-agent.service cloud-final.service cloud-init-local.service; do
  systemctl is-enabled "$s" >/dev/null || fail "$s not enabled"
done
systemctl is-enabled ssh.service >/dev/null 2>&1 || systemctl is-enabled sshd.service >/dev/null || fail 'sshd not enabled'
systemctl is-enabled chrony.service >/dev/null 2>&1 || systemctl is-enabled chronyd.service >/dev/null || fail 'chrony not enabled'
command -v cloud-init >/dev/null || fail 'cloud-init not installed'
command -v growpart >/dev/null || fail 'growpart not installed'
test -s /etc/cloud/cloud.cfg.d/90-xcp-ng.cfg || fail 'XCP-ng cloud-init configuration missing'
test -s /etc/template-release || fail '/etc/template-release missing'
test -s /etc/systemd/system/cloud-init.service.d/10-locale.conf || fail 'cloud-init C locale missing'

{ step='Failed to locate the root partition'; } 9>/dev/null
r=$(findmnt -no SOURCE /)
last=$(lsblk -nrpo NAME,TYPE "/dev/$(lsblk -no PKNAME "$r")" | awk '$2 == "part" { p = $1 } END { print p }')
[ "$r" = "$last" ] || fail "root $r is not on the last partition ($last)"
{ step='Failed to check swap'; } 9>/dev/null
if [ "${SWAP_ENABLED:-false}" = true ]; then
  swapon --noheadings --show=NAME | grep -qx /swapfile || fail "swap file /swapfile not active"
  grep -q '^/swapfile[[:space:]]' /etc/fstab || fail '/swapfile missing from /etc/fstab'
  [ "$(stat -c %s /swapfile)" -eq $((${SWAP_SIZE_GB:-0} * 1024 * 1024 * 1024)) ] || fail "/swapfile size differs from ${SWAP_SIZE_GB:-?} GB"
  [ -z "$(swapon --noheadings --show=NAME | grep -vx /swapfile)" ] || fail 'swap active outside /swapfile'
else
  [ -z "$(swapon --noheadings --show)" ] || fail 'swap active'
fi

boot_entry() {
  if command -v grubby >/dev/null 2>&1 && grep -qs blscfg /boot/grub2/grub.cfg /boot/efi/EFI/*/grub.cfg; then
    info=$(grubby --info=DEFAULT)
    printf '%s\n' "$info"
    case $info in *'$kernelopts'*)
      opts=$(grub2-editenv list | sed -n 's/^kernelopts=//p')
      [ -n "$opts" ] || opts=$(sed -n 's/^[[:space:]]*set kernelopts="\(.*\)"[[:space:]]*$/\1/p' /boot/grub2/grub.cfg /boot/efi/EFI/*/grub.cfg 2>/dev/null | head -n 1)
      printf '%s\n' "$opts" ;;
    esac
  else cat /boot/grub/grub.cfg /boot/grub2/grub.cfg /boot/efi/EFI/*/grub.cfg 2>/dev/null
  fi
}
{ step='Failed to read the boot entry'; } 9>/dev/null
args=${KERNEL_ARGS:-}
for a in $args; do
  boot_entry | grep -q "$a" || fail "$a missing from the boot entry"
done
if [ "${IPV6_ENABLED:-false}" = true ]; then
  ! boot_entry | grep -q 'ipv6\.disable=1' || fail "ipv6.disable=1 in the boot entry while the profile enables IPv6"
else
  boot_entry | grep -q 'ipv6\.disable=1' || fail "ipv6.disable=1 missing from the boot entry (profile without IPv6)"
fi
! ls /etc/NetworkManager/system-connections/*.nmconnection >/dev/null 2>&1 || fail 'build NetworkManager connections still present'
case " $args " in *' net.ifnames=0 '*) test -e /sys/class/net/eth0 || fail 'eth0 interface missing' ;; esac

test ! -s /etc/machine-id || fail 'machine-id not emptied'
! ls /tmp/xen-guest-agent* /tmp/SHA256SUMS >/dev/null 2>&1 || fail 'build packages still present in /tmp'
test ! -e /usr/sbin/policy-rc.d || fail 'build policy-rc.d still present'
test ! -e /var/lib/cloud/instance || fail 'cloud-init state not cleaned'
test ! -e /etc/cloud/cloud-init.disabled || fail 'cloud-init disabled'
! ls /root/.*_history /home/*/.*_history >/dev/null 2>&1 || fail 'shell histories still present'

for f in /root/anaconda-ks.cfg /root/original-ks.cfg /root/initial-setup-ks.cfg /root/autoinst.xml /var/adm/autoinstall /var/log/installer /var/log/anaconda; do
  test ! -e "$f" || fail "$f present (installer file)"
done

set +x
{ step='Failed to check the build account hash'; } 9>/dev/null
h=$(getent shadow "${BUILD_USER:-}" | cut -d: -f2 || true)
case "$h" in
  '$'*)
    left=$(grep -rlsF -e "$h" /etc /root /home /var /opt /srv /boot 2>/dev/null | grep -vxE '/etc/shadow-?' || true)
    [ -z "$left" ] || fail "Build account hash stored outside /etc/shadow : $(echo $left)"
    ;;
esac
unset h left

if [ "${COMMAND_TRACE:-false}" = true ]; then set -x; fi
{ step='Failed to remove SSH host keys'; } 9>/dev/null
rm -f /etc/ssh/ssh_host_*
! ls /etc/ssh/ssh_host_* >/dev/null 2>&1 || fail "SSH host keys present"
if [ "${REMOVE_BUILD_USER:-false}" = true ]; then
  [ -n "${BUILD_USER:-}" ] && [ "$BUILD_USER" != root ] || fail 'Invalid build account for deletion'
  { step="Failed to remove sudoers file for user \"$BUILD_USER\""; } 9>/dev/null
  rm -f "/etc/sudoers.d/$BUILD_USER"
  { step="Failed to delete user \"$BUILD_USER\""; } 9>/dev/null
  userdel -rf "$BUILD_USER"
  ! id "$BUILD_USER" >/dev/null 2>&1 || fail 'Build account still present'
  echo 'Build account deleted'
fi
echo 'Final verification: OK'
