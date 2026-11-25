#!/bin/bash
set -eEu
step='Unexpected error'
trap '{ [ "$BASH_SUBSHELL" -ne 0 ] || echo "Error: $step" >&2; } 9>/dev/null' ERR
if [ "${COMMAND_TRACE:-false}" = true ]; then exec 9>&1; BASH_XTRACEFD=9; set -x; fi

if [ "${OS_UPDATE:-false}" != true ]; then
  echo 'Updates : disabled in profile.'
  exit 0
fi

if command -v apt-get >/dev/null 2>&1; then
  { step='Failed to update package lists'; } 9>/dev/null
  apt-get -o Acquire::Retries=3 update
  { step='Failed to update packages'; } 9>/dev/null
  apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade
elif command -v dnf >/dev/null 2>&1; then
  { step='Failed to update packages'; } 9>/dev/null
  dnf -y upgrade --refresh
else
  rc=0
  { step='Failed to refresh repositories'; } 9>/dev/null
  zypper --non-interactive --gpg-auto-import-keys refresh
  { step='Failed to update packages'; } 9>/dev/null
  zypper --non-interactive update --auto-agree-with-licenses || rc=$?
  case $rc in 0|102|103) ;; *) echo "Error: $step" >&2; exit "$rc" ;; esac
fi

{ step='Failed to check installed kernels'; } 9>/dev/null
newest=$(ls -1 /lib/modules | sort -V | tail -n 1)
if [ "$newest" != "$(uname -r)" ] || [ -f /var/run/reboot-required ]; then
  echo "Reboot : kernel $(uname -r) -> $newest"
  nohup sh -c 'sleep 5; systemctl reboot' >/dev/null 2>&1 &
fi
