#!/usr/bin/env bash
# PUI-STG3B: staging-only nginx noindex change, as a guarded plan / apply / rollback.
#
#   bash staging-nginx-noindex.sh plan        # read-only; any user; changes nothing
#   sudo bash staging-nginx-noindex.sh apply  # root; backs up, patches ONE file, nginx -t, graceful reload, validates
#   sudo bash staging-nginx-noindex.sh rollback [backup-file]   # root; restores the saved file, nginx -t, reload
#
# Scope: only /etc/nginx/sites-available/xpertapply-staging (staging.xpertapply.com, api-staging.xpertapply.com).
# It never edits production vhosts or nginx.conf, never restarts nginx (reload only), never touches Docker state
# (it only LISTS containers before and after), and never changes the target file's owner or mode (the content is
# rewritten in place). Noindex is a crawler hint, not access control.
#
# Run it from the directory that holds the patch and validator (docs/release/pui-stg2), copied to the host
# together with the SHA-256 values printed by `plan`.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$HERE/xpertapply-staging-noindex.patch"
VALIDATOR="$HERE/validate-staging-noindex.sh"

# Pinned inputs. Anything different is a STOP, never a guess.
EXPECT_HOST="srv738314"
EXPECT_PATCH_SHA="44b7d9840d0085f34b919746c956547a3dae9516fb95212325bbfafceefe0bfa"
EXPECT_VALIDATOR_SHA="832507de0449aae84b8cead8194806442326e95417cb9d335ec66ec6433f2ae6"
EXPECT_BASE_SHA="1d635e304affc54a13303b6030b90dd8c1d159e3e8be915d2746837323a3c182"      # live file before
EXPECT_RESULT_SHA="c7f40f8b2f873d0166e1822064c317aa4a40e0b53bed0bf76a09ec5117d1d57a"    # file after the patch

NGINX_DIR="/etc/nginx"
TARGET="$NGINX_DIR/sites-available/xpertapply-staging"
ENABLED="$NGINX_DIR/sites-enabled/xpertapply-staging"
PROD_FILES=("$NGINX_DIR/sites-available/xpertapply" "$NGINX_DIR/nginx.conf")
CAND=""; WORK=""; TMPCUR=""
trap 'rm -rf "${WORK:-}" "${TMPCUR:-}"' EXIT
NGINX=nginx; SYSTEMCTL=systemctl; DOCKER=docker; CHECK_HOST=1
# Test hooks: honoured ONLY with XA_NOINDEX_SELFTEST=1 so the guards can be exercised against stubs.
if [[ "${XA_NOINDEX_SELFTEST:-}" == "1" ]]; then
  NGINX_DIR="${XA_NGINX_DIR:-$NGINX_DIR}"; TARGET="$NGINX_DIR/sites-available/xpertapply-staging"
  ENABLED="$NGINX_DIR/sites-enabled/xpertapply-staging"; PROD_FILES=("$NGINX_DIR/sites-available/xpertapply" "$NGINX_DIR/nginx.conf")
  NGINX="${XA_NGINX_BIN:-nginx}"; SYSTEMCTL="${XA_SYSTEMCTL_BIN:-systemctl}"; DOCKER="${XA_DOCKER_BIN:-docker}"; CHECK_HOST=0
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf 'OK    %s\n' "$*"; }
stop() { printf 'STOP  %s\n' "$*" >&2; exit 1; }
sha()  { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
is_root() { [[ "$(id -u)" == 0 ]] || [[ "${XA_NOINDEX_SELFTEST:-}" == "1" && "${XA_FAKE_ROOT:-}" == "1" ]]; }

mode="${1:-}"; [[ "$mode" == plan || "$mode" == apply || "$mode" == rollback ]] || stop "usage: plan | apply | rollback [backup-file]"

# ---- guards common to every mode ----------------------------------------------------------------------------
preflight() {
  if [[ "$CHECK_HOST" == 1 ]]; then [[ "$(hostname)" == "$EXPECT_HOST" ]] || stop "wrong host: $(hostname), expected $EXPECT_HOST"; fi
  ok "host is $EXPECT_HOST"
  [[ -f "$PATCH" && -f "$VALIDATOR" ]] || stop "patch or validator missing next to this script"
  [[ "$(sha "$PATCH")" == "$EXPECT_PATCH_SHA" ]] || stop "patch SHA-256 differs from the reviewed one ($(sha "$PATCH"))"
  [[ "$(sha "$VALIDATOR")" == "$EXPECT_VALIDATOR_SHA" ]] || stop "validator SHA-256 differs from the reviewed one"
  ok "patch and validator match the reviewed SHA-256 values"
  [[ -f "$TARGET" ]] || stop "$TARGET missing"
  [[ "$(readlink -f "$ENABLED")" == "$(readlink -f "$TARGET")" ]] || stop "sites-enabled/xpertapply-staging does not point at $TARGET"
  ok "the enabled staging site is $TARGET"
  # The patch must name exactly this one file and nothing else.
  local named
  named="$(grep -E '^(---|\+\+\+) ' "$PATCH" | awk '{print $2}' | sort -u | tr '\n' ' ')"
  [[ "$named" == "a/etc/nginx/sites-available/xpertapply-staging b/etc/nginx/sites-available/xpertapply-staging " ]] \
    || stop "patch names files other than the staging vhost: $named"
  # It may only ADD lines.
  if grep -E '^-[^-]' "$PATCH" >/dev/null; then stop "patch removes lines; the reviewed patch only adds"; fi
  ok "patch touches only the staging vhost and only adds lines"
  # No other vhost may claim the staging names (a second server_name match would make the patch miss traffic or hit production).
  local claimers
  claimers="$(grep -lE 'server_name[^;]*(staging\.xpertapply\.com|api-staging\.xpertapply\.com)' "$NGINX_DIR"/sites-enabled/* "$NGINX_DIR"/conf.d/*.conf 2>/dev/null | xargs -r -n1 readlink -f | sort -u || true)"
  [[ "$claimers" == "$(readlink -f "$TARGET")" ]] || stop "other enabled files mention the staging server names: $claimers"
  ok "only the staging vhost declares the staging server names"
  local names
  names="$(grep -E '^[[:space:]]*server_name' "$TARGET" | sed -E 's/^[[:space:]]*server_name//; s/;.*$//' | tr ' ' '\n' | grep -v '^$' | sort -u)"
  [[ -n "$names" ]] && ! grep -vE '^(staging|api-staging)\.xpertapply\.com$' <<<"$names" >/dev/null || stop "staging file declares server names other than the two staging hosts"
  ok "the staging file mentions no production server name"
  if grep -E 'add_header|more_set_headers' "$NGINX_DIR/nginx.conf" >/dev/null 2>&1; then stop "nginx.conf now sets headers globally: the inheritance analysis no longer holds; re-review"; fi
  if [[ "$(sha "$TARGET")" == "$EXPECT_BASE_SHA" ]] && grep -E 'add_header|more_set_headers' "$TARGET" >/dev/null; then stop "baseline file unexpectedly contains add_header"; fi
  ok "no add_header at http level or in the staging vhost, so nothing inherited can be suppressed"
}

containers() { "$DOCKER" ps -a --format '{{.Names}} {{.ID}} {{.Image}}' | sort; }
prod_hashes() { for f in "${PROD_FILES[@]}"; do printf '%s  %s\n' "$(sha "$f")" "$f"; done; }

# Applies the patch to a private copy and proves the result before anything touches /etc.
build_candidate() {
  local work="$1"; mkdir -p "$work/etc/nginx/sites-available"
  cp "$TARGET" "$work/etc/nginx/sites-available/xpertapply-staging"
  ( cd "$work" && patch -s -p1 --dry-run < "$PATCH" && patch -s -p1 < "$PATCH" ) || stop "patch does not apply cleanly to the live file"
  local cand="$work/etc/nginx/sites-available/xpertapply-staging"
  [[ "$(sha "$cand")" == "$EXPECT_RESULT_SHA" ]] || stop "patched result is not the reviewed result ($(sha "$cand"))"
  # Only additions, and only noindex lines plus the two 404 locations.
  local extra
  extra="$(diff "$TARGET" "$cand" | grep '^>' | sed 's/^> *//' | grep -v '^$' | grep -v '^#' | grep -vE '^add_header X-Robots-Tag "noindex, nofollow" always;$|^location = /(robots\.txt|sitemap\.xml) +\{ add_header X-Robots-Tag "noindex, nofollow" always; return 404; \}$' || true)"
  [[ -z "$extra" ]] || stop "unexpected added lines: $extra"
  diff "$TARGET" "$cand" | grep -q '^<' && stop "candidate removes or changes existing lines"
  ok "candidate is exactly the reviewed result (sha ${EXPECT_RESULT_SHA:0:12}…): additions only"
  CAND="$cand"
}

validate() { bash "$VALIDATOR"; }

do_plan() {
  preflight
  local live; live="$(sha "$TARGET")"
  [[ "$live" == "$EXPECT_BASE_SHA" ]] || { say "      live=$live"; say "      want=$EXPECT_BASE_SHA"; stop "the live staging vhost differs from the reviewed baseline: BLOCKED"; }
  ok "live staging vhost matches the reviewed baseline (${EXPECT_BASE_SHA:0:12}…)"
  WORK="$(mktemp -d)"
  build_candidate "$WORK"
  if is_root; then
    "$NGINX" -t 2>&1 | sed 's/^/      /' || stop "nginx -t fails BEFORE any change; fix that first"
    ok "nginx -t passes on the current configuration"
  else
    say "SKIP  nginx -t needs root; apply runs it before and after the change"
  fi
  say "--- production/global files (hashes recorded; apply requires they are unchanged afterwards)"; prod_hashes
  say "--- containers right now (apply compares before/after)"; containers | wc -l | sed 's/^/      count: /'
  say "--- external validator BEFORE the change (staging header checks are EXPECTED to FAIL; production checks should PASS)"
  validate || true
  say; say "PLAN COMPLETE. Nothing was changed. To apply:  sudo bash $0 apply"
}

do_apply() {
  is_root || stop "apply needs root"
  preflight
  [[ "$(sha "$TARGET")" == "$EXPECT_BASE_SHA" ]] || stop "live staging vhost differs from the reviewed baseline: BLOCKED"
  "$NGINX" -t 2>&1 | sed 's/^/      /' || stop "nginx -t fails before the change"
  ok "nginx -t passes before the change"
  local ts bak before_c before_p; ts="$(date -u +%Y%m%dT%H%M%SZ)"; bak="$TARGET.bak-noindex-$ts"
  [[ ! -e "$bak" ]] || stop "backup path already exists: $bak"
  cp -p -n "$TARGET" "$bak"; [[ "$(sha "$bak")" == "$EXPECT_BASE_SHA" ]] || stop "backup does not verify"
  ok "backup written and verified: $bak"
  before_c="$(containers)"; before_p="$(prod_hashes)"
  WORK="$(mktemp -d)"
  build_candidate "$WORK"
  cat "$CAND" > "$TARGET"            # rewrite in place: owner, mode and inode are unchanged
  if ! "$NGINX" -t 2>&1 | sed 's/^/      /'; then
    cat "$bak" > "$TARGET"; stop "nginx -t FAILED after the change; the original was restored automatically and nginx was not reloaded"
  fi
  [[ "$(sha "$TARGET")" == "$EXPECT_RESULT_SHA" ]] || { cat "$bak" > "$TARGET"; stop "written file is not the reviewed result; original restored"; }
  ok "nginx -t passes after the change"
  "$SYSTEMCTL" reload nginx; ok "nginx reloaded gracefully (no restart)"
  sleep 2
  [[ "$(prod_hashes)" == "$before_p" ]] && ok "production vhost and nginx.conf are byte-identical to before" || stop "a production/global nginx file changed during apply: investigate immediately"
  [[ "$(containers)" == "$before_c" ]] && ok "all container names, IDs and images are unchanged" || stop "container set changed during apply: investigate immediately"
  say "--- external validation"
  if validate; then ok "validator passed"; else say; say "VALIDATION FAILED. The change is live. Roll back with:  sudo bash $0 rollback $bak"; exit 2; fi
  say; say "APPLIED. Backup: $bak   Rollback: sudo bash $0 rollback $bak"
}

do_rollback() {
  is_root || stop "rollback needs root"
  local bak="${2:-}"
  if [[ -z "$bak" ]]; then bak="$(ls -1 "$TARGET".bak-noindex-* 2>/dev/null | sort | tail -1 || true)"; fi
  [[ -n "$bak" && -f "$bak" ]] || stop "no backup found; pass the backup path"
  [[ "$bak" == "$TARGET".bak-noindex-* ]] || stop "backup must be a $TARGET.bak-noindex-* file"
  [[ "$(sha "$bak")" == "$EXPECT_BASE_SHA" ]] || stop "backup does not match the reviewed baseline hash; refusing to restore it"
  [[ -f "$TARGET" ]] || stop "$TARGET missing"
  [[ "$(readlink -f "$ENABLED")" == "$(readlink -f "$TARGET")" ]] || stop "sites-enabled link does not point at the staging vhost"
  local before_c before_p; before_c="$(containers)"; before_p="$(prod_hashes)"; TMPCUR="$(mktemp)"
  cp -p "$TARGET" "$TMPCUR"
  cat "$bak" > "$TARGET"
  if ! "$NGINX" -t 2>&1 | sed 's/^/      /'; then cat "$TMPCUR" > "$TARGET"; stop "nginx -t failed with the restored file; the pre-rollback file was put back and nginx was not reloaded"; fi
  "$SYSTEMCTL" reload nginx; ok "restored $bak and reloaded nginx gracefully"
  sleep 2
  [[ "$(prod_hashes)" == "$before_p" ]] && ok "production files unchanged" || stop "production/global nginx file changed: investigate"
  [[ "$(containers)" == "$before_c" ]] && ok "containers unchanged" || stop "container set changed: investigate"
  say "staging is back to the baseline (noindex header is expected to be absent now):"; validate || true
}

case "$mode" in plan) do_plan ;; apply) do_apply ;; rollback) do_rollback "$@" ;; esac
