#!/usr/bin/env bash
# Creates (once) and verifies the trusted root-only state used by the EXT-FINAL-03 scripts: /var/lib/xpertapply-release/extfinal03
#   init-extfinal03-state.sh            read-only: verifies and reports; creates and modifies nothing
#   sudo init-extfinal03-state.sh --apply   root: creates the directories (root:root, 0700 final directory) and the two pinned override files
#                                          file (root:root 0600). Never overwrites, never follows a symlink, never reads /home/luna.
# Run the INSTALLED copy: /opt/xpertapply-release/extfinal03-extension-connect/init-extfinal03-state.sh
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; readonly SELF_DIR
readonly STATE_PY="${SELF_DIR}/extfinal03_state.py"
die() { echo "ABORT: $*" >&2; exit 1; }
[[ "$(hostname)" == srv738314 ]] || die "unexpected host"
case "${1:-}" in
  "") exec python3 -I "$STATE_PY" verify ;;
  --apply)
    [[ "$(id -u)" == 0 ]] || die "--apply must run as root"
    case "$SELF_DIR" in /opt/xpertapply-release/*) ;; *) die "run the INSTALLED copy under /opt/xpertapply-release";; esac
    for d in "$SELF_DIR" /opt/xpertapply-release /opt; do
      [[ "$(stat -c '%u' "$d")" == 0 && $(( 0$(stat -c '%a' "$d") & 022 )) == 0 && ! -L "$d" ]] || die "${d} is not a root-owned, non-writable directory"
    done
    python3 -I "$STATE_PY" init
    python3 -I "$STATE_PY" verify ;;
  *) die "usage: init-extfinal03-state.sh [--apply]" ;;
esac
