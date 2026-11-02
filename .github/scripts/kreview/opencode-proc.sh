#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" == 0 ]]; then
  mkdir -p /run/ksai-tool-proc
  /usr/bin/mount -t proc -o nosuid,nodev,noexec proc /run/ksai-tool-proc
  exec /usr/bin/setpriv --bounding-set=-all,+setuid,+setgid,+setpcap,+setfcap --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
fi
exec "$@"
