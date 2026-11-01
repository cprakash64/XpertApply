#!/usr/bin/env bash
# Installs the reviewed EXT-FINAL-03 scripts as a NEW root-owned, read-only directory. Never overwrites. Run as root from this directory.
# The copy list is read FROM SHA256SUMS, so every listed file (including this installer) is installed and nothing unlisted is.
set -Eeuo pipefail
umask 022
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; readonly SRC
readonly PARENT="/opt/xpertapply-release" DEST="/opt/xpertapply-release/extfinal03-extension-connect"
die() { echo "ABORT: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ "$(hostname)" = "srv738314" ] || die "unexpected host"
for d in /opt "$PARENT"; do
  [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c '%u' "$d")" = 0 ] && [ $(( 0$(stat -c '%a' "$d") & 022 )) = 0 ] || die "$d is not a root-owned, non-writable directory"
done
[ ! -e "$DEST" ] || die "$DEST already exists; refusing to overwrite"
[ -f "$SRC/SHA256SUMS" ] && [ ! -L "$SRC/SHA256SUMS" ] || die "SHA256SUMS missing"
( cd "$SRC" && sha256sum -c --quiet SHA256SUMS ) || die "SHA256SUMS verification failed; do not install"
names="$(awk '{print $2}' "$SRC/SHA256SUMS")"
[ -n "$names" ] || die "SHA256SUMS lists no files"
for f in $names; do case "$f" in */*|.*) die "unsafe name in SHA256SUMS: $f";; esac; [ -f "$SRC/$f" ] && [ ! -L "$SRC/$f" ] || die "listed file missing or a symlink: $f"; done
install -d -m 0755 -o root -g root "$DEST"
for f in $names SHA256SUMS; do
  case "$f" in *.sh) m=0755;; *) m=0644;; esac
  install -m "$m" -o root -g root "$SRC/$f" "$DEST/$f"
done
( cd "$DEST" && sha256sum -c --quiet SHA256SUMS ) || die "installed copy does not verify"
for f in $names; do [ -f "$DEST/$f" ] || die "installed copy is missing $f"; done
echo "installed ${DEST}: $(echo "$names" | wc -l) files listed in SHA256SUMS, all present and verified (root-owned; not writable by ordinary users)"
echo "next (once, as root):  ${DEST}/init-extfinal03-state.sh --apply"
