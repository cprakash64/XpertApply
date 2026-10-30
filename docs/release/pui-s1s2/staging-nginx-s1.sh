#!/usr/bin/env bash
# S1: staging-only nginx security headers, as guarded preflight / apply / verify / rollback.
#
#   bash  staging-nginx-s1.sh preflight          # read-only; changes nothing (nginx -t needs root and is skipped otherwise)
#   sudo bash staging-nginx-s1.sh apply          # root; shows the diff, asks for approval, backs up, patches ONE file
#   bash  staging-nginx-s1.sh verify             # read-only; checks live headers and routes (no root needed)
#   sudo bash staging-nginx-s1.sh rollback [backup-file]
#
# Scope: only /etc/nginx/sites-available/xpertapply-staging (staging.xpertapply.com, api-staging.xpertapply.com).
# The shared nginx is RELOADED (never restarted), which re-reads every vhost, so the script proves that no other
# nginx file changed, that nginx -t prints the same warnings as before (a pre-existing VeoTrex TLS warning stays
# untouched), and that production and optional extra health URLs answer exactly as before. It never edits the
# enabled symlink, other vhosts, nginx.conf, Docker, databases or SMTP.
# Fail closed: any unexpected hash, host, version, diff line, warning, status or header STOPs; after a mutation any
# failure restores the backup automatically.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$HERE/xpertapply-staging-s1.patch"
REF="$HERE/xpertapply-staging.reviewed-baseline.conf"   # reviewed copy of the live file with SSL lines masked

# Pinned inputs. Anything different is a STOP, never a guess.
EXPECT_HOST="srv738314"
EXPECT_BASE_SHA="c7f40f8b2f873d0166e1822064c317aa4a40e0b53bed0bf76a09ec5117d1d57a"   # live file, verified by the operator
EXPECT_PATCH_SHA="020b38191d296777f8341cf4b91f840d4bf0feb7c13b00c961bbf3c46b774c6d"
EXPECT_REF_NORM_SHA="0e01db49a8b4b0a231d2cdf851bf2fad1e337e9bdc04dc9709877c6a9b493ab3"
EXPECT_CAND_NORM_SHA="6506cb579307a5c51c805ac158d2a8843379d6523c616ef3692e75834c1ac4b4"
HSTS_VALUE="max-age=300"      # staging only; shorter than production's 86400; no includeSubDomains, no preload
DEFAULT_REFERRER="strict-origin-when-cross-origin"

NGINX_DIR="/etc/nginx"
STATE_DIR="/var/backups/xpertapply-nginx-s1"
NGINX=nginx; RELOAD=(systemctl reload nginx); CURL_ARGS=(); CURL_HTTP_ARGS=(); CHECK_HOST=1; NGINX_VERSION_RE='^nginx version: nginx/1\.24\.'
W="https://staging.xpertapply.com"; A="https://api-staging.xpertapply.com"
PROD_URLS=("https://xpertapply.com/" "https://api.xpertapply.com/health")
EXTRA_URLS=(${XA_S1_EXTRA_URLS:-})     # optional: e.g. the VeoTrex health URL(s); only their status code must be unchanged
# Test hooks: honoured ONLY with XA_S1_SELFTEST=1 so every guard can be exercised against a throw-away nginx.
if [[ "${XA_S1_SELFTEST:-}" == "1" ]]; then
  NGINX_DIR="${XA_S1_NGINX_DIR:-$NGINX_DIR}"; STATE_DIR="${XA_S1_STATE_DIR:-$STATE_DIR}"; NGINX="${XA_S1_NGINX_BIN:-nginx}"
  [[ -n "${XA_S1_RELOAD_CMD:-}" ]] && read -r -a RELOAD <<<"$XA_S1_RELOAD_CMD"
  [[ -n "${XA_S1_CURL_ARGS:-}" ]] && read -r -a CURL_ARGS <<<"$XA_S1_CURL_ARGS"
  [[ -n "${XA_S1_CURL_HTTP_ARGS:-}" ]] && read -r -a CURL_HTTP_ARGS <<<"$XA_S1_CURL_HTTP_ARGS"
  [[ -n "${XA_S1_EXPECT_BASE_SHA:-}" ]] && EXPECT_BASE_SHA="$XA_S1_EXPECT_BASE_SHA"
  CHECK_HOST=0
fi
TARGET="$NGINX_DIR/sites-available/xpertapply-staging"
ENABLED="$NGINX_DIR/sites-enabled/xpertapply-staging"
WORK=""; trap 'rm -rf "${WORK:-}"' EXIT

say()  { printf '%s\n' "$*"; }
ok()   { printf 'OK    %s\n' "$*"; }
stop() { printf 'STOP  %s\n' "$*" >&2; exit 1; }
sha()  { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# The SSL certificate/key lines are masked so the reviewed (secret-free) copy can be compared with the live file.
norm_sha() { sed -E 's/^[[:space:]]*ssl_certificate.*$/    SSL/' "$1" | if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }
is_root() { [[ "$(id -u)" == 0 ]] || [[ "${XA_S1_SELFTEST:-}" == "1" && "${XA_S1_FAKE_ROOT:-}" == "1" ]]; }

mode="${1:-}"; [[ "$mode" == preflight || "$mode" == apply || "$mode" == verify || "$mode" == rollback ]] || stop "usage: preflight | apply | verify | rollback [backup-file]"

# ---- live observation ---------------------------------------------------------------------------------------------
H=""; STATUS=""
fetch() {  # fetch URL [curl args...]  -> STATUS, H (lower-cased header lines, CR stripped). Inconclusive (000) is a STOP.
  local url="$1"; shift; local args=("${CURL_ARGS[@]}"); [[ "$url" == http://* ]] && args+=("${CURL_HTTP_ARGS[@]}")
  local raw; raw="$(curl -sS -o /dev/null -D - --max-time 20 "${args[@]}" "$@" "$url" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z' || true)"
  STATUS="$(grep -E '^http/' <<<"$raw" | tail -1 | awk '{print $2}' || true)"
  H="$(grep -vE '^http/' <<<"$raw" || true)"
  [[ -n "$STATUS" && "$STATUS" != 000 ]] || stop "no usable response from $url (inconclusive; failing closed)"
}
hcount() { grep -c "^$1:" <<<"$H" || true; }
hval()   { grep -m1 "^$1:" <<<"$H" | sed -E "s/^$1:[[:space:]]*//" || true; }

SELECT="strict-transport-security x-frame-options x-content-type-options referrer-policy x-robots-tag content-security-policy-report-only content-security-policy access-control-allow-origin cache-control location permissions-policy"
snap_one() {  # URL [curl args]  -> deterministic text block
  fetch "$@"; printf 'URL %s STATUS %s\n' "$1" "$STATUS"
  local h; for h in $SELECT; do grep "^$h:" <<<"$H" | sed 's/^/  /' || true; done
}
WEB_ROUTES=(/login /signup /forgot-password /reset-password /jobs /robots.txt /sitemap.xml /__s1_no_such_page__)
snapshot() {
  local u r
  for r in "${WEB_ROUTES[@]}"; do snap_one "$W$r"; done
  snap_one "$A/healthz"; snap_one "$A/jobs"; snap_one "$A/healthz" -H "Origin: https://staging.xpertapply.com"
  snap_one "http://staging.xpertapply.com/s1-redirect-check"; snap_one "http://api-staging.xpertapply.com/s1-redirect-check"
  for u in "${PROD_URLS[@]}"; do snap_one "$u"; done
  for u in "${EXTRA_URLS[@]}"; do fetch "$u"; printf 'URL %s STATUS %s\n' "$u" "$STATUS"; done
}
prod_block() { awk '/^URL https:\/\/(xpertapply\.com|api\.xpertapply\.com)/{p=1} /^URL /{ if ($0 !~ /^URL https:\/\/(xpertapply\.com|api\.xpertapply\.com)/) p=0 } p' "$1"; }
extra_block() { grep -E '^URL .* STATUS' "$1" | grep -vE '^URL (https?://)?(staging|api-staging|xpertapply|api)\.xpertapply\.com' || true; }

# ---- expectation checks (shared by verify, apply and rollback) -----------------------------------------------------
FAILS=0
chk() { if [[ "$1" == 1 ]]; then printf 'PASS  %s\n' "$2"; else printf 'FAIL  %s\n' "$2"; FAILS=$((FAILS+1)); fi; }
one() { [[ "$(hcount "$1")" == 1 && "$(hval "$1")" == "$2" ]] && echo 1 || echo 0; }

check_present() {  # S1 headers must be present exactly once with the reviewed values
  local r exp_status exp_ref
  for r in "${WEB_ROUTES[@]}"; do
    fetch "$W$r"
    case "$r" in /robots.txt|/sitemap.xml|/__s1_no_such_page__) exp_status=404 ;; *) exp_status=200 ;; esac
    exp_ref="$DEFAULT_REFERRER"; [[ "$r" == /forgot-password || "$r" == /reset-password ]] && exp_ref="no-referrer"
    chk "$([[ "$STATUS" == "$exp_status" ]] && echo 1 || echo 0)" "web $r status $STATUS (want $exp_status)"
    chk "$(one strict-transport-security "$HSTS_VALUE")" "web $r HSTS exactly once = $HSTS_VALUE"
    chk "$(one x-frame-options deny)" "web $r X-Frame-Options exactly once = DENY (header values are compared lower-cased)"
    chk "$(one x-content-type-options nosniff)" "web $r X-Content-Type-Options exactly once = nosniff"
    chk "$(one referrer-policy "$exp_ref")" "web $r Referrer-Policy exactly once = $exp_ref"
    chk "$(one x-robots-tag 'noindex, nofollow')" "web $r X-Robots-Tag exactly once = noindex, nofollow"
    if [[ "$r" == /robots.txt || "$r" == /sitemap.xml ]]; then
      chk "$([[ "$(hcount content-security-policy)" == 0 && "$(hcount content-security-policy-report-only)" == 0 ]] && echo 1 || echo 0)" "web $r nginx 404 adds no CSP of its own"
    fi
    [[ "$(hval strict-transport-security)" != *includesubdomains* && "$(hval strict-transport-security)" != *preload* ]] || chk 0 "web $r HSTS has no includeSubDomains/preload"
  done
  fetch "$A/healthz"; chk "$([[ "$STATUS" == 200 ]] && echo 1 || echo 0)" "api /healthz status $STATUS (want 200)"
  chk "$(one strict-transport-security "$HSTS_VALUE")" "api /healthz HSTS exactly once"
  chk "$(one x-content-type-options nosniff)" "api /healthz nosniff exactly once"
  chk "$(one x-robots-tag 'noindex, nofollow')" "api /healthz X-Robots-Tag exactly once"
  chk "$([[ "$(hcount x-frame-options)" == 0 ]] && echo 1 || echo 0)" "api /healthz adds no X-Frame-Options (JSON; matches production API)"
  fetch "$A/jobs"; chk "$([[ "$STATUS" == 401 ]] && echo 1 || echo 0)" "api unauthorized /jobs status $STATUS (want 401)"
  chk "$(one strict-transport-security "$HSTS_VALUE")" "api 401 response carries HSTS exactly once"
  chk "$(one x-content-type-options nosniff)" "api 401 response carries nosniff exactly once"
  fetch "$A/healthz" -H "Origin: https://staging.xpertapply.com"
  chk "$([[ "$(hval access-control-allow-origin)" == "https://staging.xpertapply.com" ]] && echo 1 || echo 0)" "api CORS still allows the staging web origin"
  local h
  for h in "$W" "$A"; do
    fetch "http://${h#https://}/s1-redirect-check"
    chk "$([[ "$STATUS" == 301 && "$(hval location)" == "$h/s1-redirect-check" ]] && echo 1 || echo 0)" "http ${h#https://} redirects 301 to https unchanged"
    chk "$(one x-robots-tag 'noindex, nofollow')" "http ${h#https://} redirect keeps noindex"
    chk "$([[ "$(hcount strict-transport-security)" == 0 ]] && echo 1 || echo 0)" "http ${h#https://} redirect sends no HSTS (ignored over http)"
  done
}
check_absent() {  # after rollback: the nginx-added S1 headers are gone, noindex is intact
  local r
  for r in /login /robots.txt; do
    fetch "$W$r"
    chk "$([[ "$(hcount strict-transport-security)" == 0 && "$(hcount x-frame-options)" == 0 && "$(hcount x-content-type-options)" == 0 ]] && echo 1 || echo 0)" "web $r has no S1 headers again"
    chk "$([[ "$(hcount x-robots-tag)" -ge 1 ]] && echo 1 || echo 0)" "web $r still has noindex"
  done
  fetch "$A/healthz"
  chk "$([[ "$(hcount strict-transport-security)" == 0 && "$(hcount x-content-type-options)" == 0 ]] && echo 1 || echo 0)" "api has no S1 headers again"
  chk "$(one x-robots-tag 'noindex, nofollow')" "api still has noindex"
}
compare_snapshots() {  # BEFORE AFTER MODE(applied|rolledback): statuses, CSP-RO, CORS, production and extra URLs
  local before="$1" after="$2" m="$3"
  chk "$([[ "$(prod_block "$before")" == "$(prod_block "$after")" ]] && echo 1 || echo 0)" "production URLs answer byte-identically to before (status and security headers)"
  chk "$([[ "$(extra_block "$before")" == "$(extra_block "$after")" ]] && echo 1 || echo 0)" "extra health URLs unchanged"
  chk "$([[ "$(grep -E '^URL .* STATUS' "$before")" == "$(grep -E '^URL .* STATUS' "$after")" ]] && echo 1 || echo 0)" "every probed URL keeps its status code"
  chk "$([[ "$(grep -E 'content-security-policy-report-only:|access-control-allow-origin:|^  location:|cache-control:' "$before")" == "$(grep -E 'content-security-policy-report-only:|access-control-allow-origin:|^  location:|cache-control:' "$after")" ]] && echo 1 || echo 0)" "upstream CSP Report-Only, CORS, redirect Location and Cache-Control are unchanged"
  if [[ "$m" == rolledback ]]; then
    chk "$([[ "$(grep -cE '^  x-robots-tag:' "$before")" == "$(grep -cE '^  x-robots-tag:' "$after")" ]] && echo 1 || echo 0)" "noindex headers match the pre-change state"
  fi
}

# ---- configuration observation ---------------------------------------------------------------------------------------
other_hashes() {  # every nginx file except the staging vhost, its backups and the state dir (symlinks resolved)
  ( cd "$NGINX_DIR" && find . \( -type f -o -type l \) ! -path "./sites-available/xpertapply-staging" ! -path "./sites-available/xpertapply-staging.bak-s1-*" ! -path "./sites-enabled/xpertapply-staging" -print0 2>/dev/null | sort -z | xargs -0 -r -n1 sh -c 'f="$1"; if [ -e "$f" ]; then printf "%s  %s\n" "$(if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$f"; else shasum -a 256 < "$f"; fi | cut -d" " -f1)" "$f"; else printf "BROKEN-LINK  %s\n" "$f"; fi' sh )
}
nginx_t() { "$NGINX" -t 2>&1; }
warns() { grep -E '^nginx: \[warn\]' <<<"$1" | sed -E 's/ in [^ ]+:[0-9]+$//' | sort || true; }
perms() { stat -c '%U:%G %a' "$1" 2>/dev/null || stat -f '%Su:%Sg %Lp' "$1"; }
main_pid() { systemctl show -p MainPID nginx 2>/dev/null | head -1 || true; [[ -r /run/nginx.pid ]] && cat /run/nginx.pid || true; }

# ---- guards ---------------------------------------------------------------------------------------------------------
preflight() {
  local hn="${XA_S1_FAKE_HOSTNAME:-$(hostname)}"
  if [[ "$CHECK_HOST" == 1 ]]; then [[ "$hn" == "$EXPECT_HOST" ]] || stop "wrong host: $hn, expected $EXPECT_HOST (staging only)"
  else [[ "$hn" == "$EXPECT_HOST" ]] || stop "wrong host: $hn, expected $EXPECT_HOST (staging only)"; fi
  ok "host is $EXPECT_HOST"
  command -v "$NGINX" >/dev/null 2>&1 || stop "nginx not found"
  for t in patch curl diff awk sed find xargs; do command -v "$t" >/dev/null 2>&1 || stop "required tool missing: $t"; done
  "$NGINX" -v 2>&1 | sed 's/^/      /'
  [[ "$("$NGINX" -v 2>&1 | sed 's/^nginx version: //; s/^/nginx version: /')" =~ $NGINX_VERSION_RE ]] || stop "nginx is not 1.24.x (the inheritance analysis was done for 1.24)"
  ok "nginx 1.24.x"
  for f in "$PATCH" "$REF"; do [[ -f "$f" ]] || stop "missing $f next to this script"; done
  [[ "$(sha "$PATCH")" == "$EXPECT_PATCH_SHA" ]] || stop "patch SHA-256 differs from the reviewed one"
  [[ "$(norm_sha "$REF")" == "$EXPECT_REF_NORM_SHA" ]] || stop "reviewed baseline copy differs from the pinned one"
  ok "patch and reviewed baseline match their pinned SHA-256 values"
  [[ -f "$TARGET" ]] || stop "$TARGET missing"
  [[ -L "$ENABLED" && "$(readlink -f "$ENABLED")" == "$(readlink -f "$TARGET")" ]] || stop "sites-enabled/xpertapply-staging is not a symlink to $TARGET"
  ok "enabled path is a symlink to the source file (kept as is)"
  local live; live="$(sha "$TARGET")"
  [[ "$live" == "$EXPECT_BASE_SHA" ]] || { say "      live=$live"; say "      want=$EXPECT_BASE_SHA"; stop "the live staging vhost is not the verified baseline: BLOCKED"; }
  ok "live source SHA-256 is the verified baseline (${EXPECT_BASE_SHA:0:12}…)"
  [[ "$(norm_sha "$TARGET")" == "$EXPECT_REF_NORM_SHA" ]] || { diff <(sed -E 's/^[[:space:]]*ssl_certificate.*$/    SSL/' "$REF") <(sed -E 's/^[[:space:]]*ssl_certificate.*$/    SSL/' "$TARGET") | head -20 | sed 's/^/      /'; stop "live file does not match the reviewed copy outside the SSL lines"; }
  ok "live file equals the reviewed copy outside the SSL lines"
  [[ "$(grep -cE '^server[[:space:]]*\{' "$TARGET")" == 3 ]] || stop "expected exactly three server blocks"
  local live_ah; live_ah="$(grep -vE '^[[:space:]]*#' "$TARGET" | grep -o 'add_header[^;]*;' || true)"
  [[ "$(grep -c . <<<"$live_ah")" == 5 && "$(grep -vc 'add_header X-Robots-Tag "noindex, nofollow" always;' <<<"$live_ah" || true)" == 0 ]] || stop "unexpected add_header directives in the staging vhost"
  ok "three server blocks; the only add_header directives are the five X-Robots-Tag ones"
  if grep -REl 'add_header|more_set_headers' "$NGINX_DIR/nginx.conf" "$NGINX_DIR/conf.d" 2>/dev/null | grep . >/dev/null; then stop "add_header exists at http level (nginx.conf or conf.d): inheritance analysis no longer holds; re-review"; fi
  ok "no http-level add_header that the new directives could shadow"
  local claim; claim="$(grep -RlE 'server_name[^;]*(staging|api-staging)\.xpertapply\.com' "$NGINX_DIR/sites-enabled" "$NGINX_DIR/conf.d" 2>/dev/null | xargs -r -n1 readlink -f | sort -u || true)"
  [[ "$claim" == "$(readlink -f "$TARGET")" ]] || stop "other enabled files declare the staging names: $claim"
  ok "only the staging vhost declares the staging server names"
  if grep -Rl 'xa_staging_referrer_policy' "$NGINX_DIR" 2>/dev/null | grep -v "^$TARGET\$\|\.bak-s1-" | grep . >/dev/null; then stop "variable name xa_staging_referrer_policy already used elsewhere"; fi
  ok "map variable name is unused elsewhere (the map is http-level and shared by name)"
}

build_candidate() {
  WORK="$(mktemp -d)"; mkdir -p "$WORK/etc/nginx/sites-available"
  local c="$WORK/etc/nginx/sites-available/xpertapply-staging"; cp "$TARGET" "$c"
  ( cd "$WORK" && patch -s -p1 --dry-run < "$PATCH" >/dev/null && patch -s -p1 < "$PATCH" >/dev/null ) || stop "patch does not apply cleanly to the live file"
  [[ "$(norm_sha "$c")" == "$EXPECT_CAND_NORM_SHA" ]] || stop "candidate is not the reviewed result (masked sha $(norm_sha "$c"))"
  local d; d="$(diff "$TARGET" "$c" || true)"
  local removed; removed="$(grep '^<' <<<"$d" | sed 's/^< *//' | sort || true)"
  local wantrm; wantrm="$(printf '%s\n' 'location = /robots.txt  { add_header X-Robots-Tag "noindex, nofollow" always; return 404; }' 'location = /sitemap.xml { add_header X-Robots-Tag "noindex, nofollow" always; return 404; }' | sort)"
  [[ "$removed" == "$wantrm" ]] || stop "candidate removes lines other than the two 404 one-liners: $removed"
  if grep -E '^[<>].*(ssl_certificate|listen|server_name|proxy_pass|proxy_set_header|proxy_.*timeout|return 301|acme-challenge|root )' <<<"$d" >/dev/null; then stop "candidate touches certificates, listeners, names, proxies, timeouts or redirects"; fi
  if grep -E '^>' <<<"$d" | grep -vE '^>[[:space:]]*#' | grep -iE '(includeSubDomains|preload|content-security-policy|cross-origin-|permissions-policy)' >/dev/null; then stop "candidate adds a forbidden directive"; fi
  ok "candidate is the reviewed result (masked sha ${EXPECT_CAND_NORM_SHA:0:12}…): only header directives, the map and the proxy_hide_header lines changed"
  CAND="$c"
}

# ---- modes ---------------------------------------------------------------------------------------------------------------
do_preflight() {
  preflight; build_candidate
  say "--- exact diff (live -> candidate)"; diff -u "$TARGET" "$CAND" | sed '1,2d' | sed 's/^/      /' || true
  if is_root; then
    local out; out="$(nginx_t)" || { say "$out"; stop "nginx -t fails BEFORE any change; fix that first"; }
    ok "nginx -t passes now; warnings (recorded, must be identical after the change):"; warns "$out" | sed 's/^/      /'
  else say "SKIP  nginx -t needs root; apply runs it before and after"; fi
  say "--- live observation before any change (read-only requests; staging S1 rows are EXPECTED to fail here)"
  local snap; snap="$(mktemp)"; snapshot > "$snap"; grep -E '^URL' "$snap" | sed 's/^/      /'; rm -f "$snap"
  say; say "PREFLIGHT COMPLETE. Nothing was changed. Next: sudo bash $0 apply"
}

do_verify() {
  say "== staging S1 headers (read-only)"; check_present
  local latest="$STATE_DIR/before.latest"
  if [[ -f "$latest" ]]; then local after; after="$(mktemp)"; snapshot > "$after"; say "== comparison with the pre-change snapshot $(basename "$(readlink -f "$latest")")"; compare_snapshots "$latest" "$after" applied; rm -f "$after"
  else say "NOTE  no pre-change snapshot at $latest; production and extra-URL comparison skipped"; fi
  [[ "$FAILS" == 0 ]] && { say; say "VERIFY PASSED"; } || { say; say "VERIFY FAILED ($FAILS)"; exit 1; }
}

restore_from() {  # BACKUP : put the backup content back in place (same inode, owner, mode), test, reload
  local bak="$1"
  cat "$bak" > "$TARGET"
  local out; out="$(nginx_t)" || { say "$out"; return 1; }
  "${RELOAD[@]}"
}

do_apply() {
  is_root || stop "apply needs root"
  preflight; build_candidate
  say "--- exact diff (live -> candidate)"; diff -u "$TARGET" "$CAND" | sed '1,2d' | sed 's/^/      /' || true
  local out0; out0="$(nginx_t)" || { say "$out0"; stop "nginx -t fails before the change"; }
  local warn0; warn0="$(warns "$out0")"; ok "nginx -t passes before the change"; if [[ -n "$warn0" ]]; then say "      recorded warnings (must be identical after):"; say "$warn0" | sed 's/^/      /'; fi
  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
  local ts bak snapf; ts="$(date -u +%Y%m%dT%H%M%SZ)"; bak="$TARGET.bak-s1-$ts"; snapf="$STATE_DIR/before-$ts.snap"
  [[ ! -e "$bak" ]] || stop "backup path already exists: $bak"
  say "--- pre-change observation"; snapshot > "$snapf"; ln -sfn "$snapf" "$STATE_DIR/before.latest"; ok "snapshot written: $snapf"
  local others0 perm0 inode0 link0 pid0
  others0="$(other_hashes)"; perm0="$(perms "$TARGET")"; link0="$(readlink "$ENABLED")"; inode0="$(ls -i "$TARGET" | awk '{print $1}')"; pid0="$(main_pid)"
  # Approval: explicit, bound to the candidate that was just shown.
  local want="APPLY ${EXPECT_CAND_NORM_SHA:0:12}" got=""
  if [[ -n "${XA_S1_APPROVE:-}" ]]; then got="$XA_S1_APPROVE"
  elif [[ -t 0 ]]; then printf '\nType exactly "%s" to apply the diff above to the shared nginx (reload): ' "$want"; read -r got
  fi
  [[ "$got" == "$want" ]] || stop "approval missing or wrong (needed: $want). Nothing was changed."
  cp -p -n "$TARGET" "$bak"; [[ "$(sha "$bak")" == "$EXPECT_BASE_SHA" ]] || stop "backup does not verify"
  printf 'owner_mode=%s\nsource_sha256=%s\nenabled_link=%s\nutc=%s\n' "$perm0" "$EXPECT_BASE_SHA" "$link0" "$ts" > "$bak.meta"
  ok "backup written and verified: $bak"
  cat "$CAND" > "$TARGET"          # in-place rewrite: inode, owner, mode and the sites-enabled symlink are untouched
  local out1; if ! out1="$(nginx_t)"; then cat "$bak" > "$TARGET"; say "$out1"; stop "nginx -t FAILED after the change; the original was restored and nginx was NOT reloaded"; fi
  if [[ "$(warns "$out1")" != "$warn0" ]]; then cat "$bak" > "$TARGET"; stop "nginx -t warnings changed after the change; the original was restored and nginx was NOT reloaded"; fi
  ok "nginx -t passes after the change with identical warnings"
  "${RELOAD[@]}"; ok "nginx reloaded gracefully"
  sleep 2
  local fail=""
  [[ "$(other_hashes)" == "$others0" ]] || fail="another nginx file changed"
  [[ "$(perms "$TARGET")" == "$perm0" && "$(readlink "$ENABLED")" == "$link0" && "$(ls -i "$TARGET" | awk '{print $1}')" == "$inode0" ]] || fail="${fail:+$fail; }owner/mode/inode/symlink changed"
  [[ "$(main_pid)" == "$pid0" ]] || fail="${fail:+$fail; }nginx master PID changed (not a graceful reload)"
  if [[ -z "$fail" ]]; then ok "all other nginx files, the symlink, owner, mode and master PID are unchanged"
    say "--- live verification"; FAILS=0; check_present
    local after; after="$(mktemp)"; snapshot > "$after"; compare_snapshots "$snapf" "$after" applied; rm -f "$after"
    [[ "$FAILS" == 0 ]] || fail="live verification failed ($FAILS checks)"
  fi
  if [[ -n "$fail" ]]; then
    say; say "FAILED: $fail. Restoring the backup automatically."
    restore_from "$bak" && ok "backup restored and nginx reloaded" || say "AUTOMATIC RESTORE FAILED: run  sudo bash $0 rollback $bak"
    exit 2
  fi
  say; say "APPLIED AND VERIFIED. Backup: $bak   Rollback: sudo bash $0 rollback $bak"
}

do_rollback() {
  is_root || stop "rollback needs root"
  local bak="${2:-}"
  [[ -n "$bak" ]] || bak="$(ls -1 "$TARGET".bak-s1-* 2>/dev/null | grep -v '\.meta$' | sort | tail -1 || true)"
  [[ -n "$bak" && -f "$bak" ]] || stop "no backup found; pass the backup path"
  [[ "$bak" == "$TARGET".bak-s1-* ]] || stop "backup must be a $TARGET.bak-s1-* file"
  [[ "$(sha "$bak")" == "$EXPECT_BASE_SHA" ]] || stop "backup does not match the verified baseline hash; refusing to restore it"
  [[ -L "$ENABLED" && "$(readlink -f "$ENABLED")" == "$(readlink -f "$TARGET")" ]] || stop "enabled path is not a symlink to the staging source"
  local out0; out0="$(nginx_t)" || { say "$out0"; stop "nginx -t fails before the rollback; not touching it"; }
  local warn0; warn0="$(warns "$out0")"
  local others0 link0 pid0 cur; others0="$(other_hashes)"; link0="$(readlink "$ENABLED")"; pid0="$(main_pid)"; cur="$(mktemp)"; cp -p "$TARGET" "$cur"
  local before; before="$STATE_DIR/before.latest"
  cat "$bak" > "$TARGET"
  local out1; if ! out1="$(nginx_t)"; then cat "$cur" > "$TARGET"; rm -f "$cur"; say "$out1"; stop "nginx -t failed with the restored file; the pre-rollback file was put back and nginx was NOT reloaded"; fi
  [[ "$(warns "$out1")" == "$warn0" ]] || { cat "$cur" > "$TARGET"; rm -f "$cur"; stop "nginx -t warnings changed with the restored file; nothing reloaded"; }
  "${RELOAD[@]}"; ok "restored $bak and reloaded nginx gracefully"; sleep 2; rm -f "$cur"
  say "--- independent verification of the rollback"
  FAILS=0
  chk "$([[ "$(sha "$TARGET")" == "$EXPECT_BASE_SHA" ]] && echo 1 || echo 0)" "staging source SHA-256 is the verified baseline again"
  chk "$([[ "$(readlink "$ENABLED")" == "$link0" && "$(readlink -f "$ENABLED")" == "$(readlink -f "$TARGET")" ]] && echo 1 || echo 0)" "enabled symlink preserved"
  chk "$([[ "$(other_hashes)" == "$others0" ]] && echo 1 || echo 0)" "no other nginx file changed"
  chk "$([[ "$(main_pid)" == "$pid0" ]] && echo 1 || echo 0)" "nginx master PID unchanged (graceful reload)"
  check_absent
  if [[ -f "$before" ]]; then local after; after="$(mktemp)"; snapshot > "$after"; compare_snapshots "$before" "$after" rolledback; rm -f "$after"; fi
  [[ "$FAILS" == 0 ]] && { say; say "ROLLED BACK AND VERIFIED."; } || { say; say "ROLLBACK VERIFICATION FAILED ($FAILS). The baseline file IS restored; investigate before anything else."; exit 3; }
}

case "$mode" in preflight) do_preflight ;; apply) do_apply ;; verify) do_verify ;; rollback) do_rollback "$@" ;; esac
