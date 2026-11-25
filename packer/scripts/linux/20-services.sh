#!/bin/bash
set -eEu
step='Unexpected error'
trap '{ [ "$BASH_SUBSHELL" -ne 0 ] || echo "Error: $step" >&2; } 9>/dev/null' ERR
if [ "${COMMAND_TRACE:-false}" = true ]; then exec 9>&1; BASH_XTRACEFD=9; set -x; fi

unit_of() {
  for u in "$@"; do
    if systemctl list-unit-files "$u" --no-legend 2>/dev/null | grep -q "^$u"; then echo "$u"; return 0; fi
  done
  echo "Service not found : $*" >&2
  return 1
}

{ step='SSH service not found'; } 9>/dev/null
ssh=$(unit_of ssh.service sshd.service)
{ step='chrony service not found'; } 9>/dev/null
chrony=$(unit_of chrony.service chronyd.service)
{ step='cloud-init service not found'; } 9>/dev/null
cloudinit=$(unit_of cloud-init-network.service cloud-init.service)
services="$ssh $chrony xen-guest-agent.service cloud-init-local.service $cloudinit cloud-config.service cloud-final.service"

{ step='Failed to enable services'; } 9>/dev/null
systemctl enable $services
for s in $services; do
  { step="Service $s not enabled"; } 9>/dev/null
  systemctl is-enabled "$s"
done
