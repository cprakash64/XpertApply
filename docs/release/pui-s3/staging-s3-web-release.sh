#!/usr/bin/env bash
# S3 (Safari/WebKit dialog focus restoration, useDialogFocus): WEB-ONLY staging release of 1b26947. Root, staging only.
#
# Staging runs the S2 web (95de977), the F2 API (aa5bc2f), database 0034_password_reset, and the S1 nginx headers.
# THIS RELEASE CHANGES ONLY THE WEB IMAGE: it recreates ONLY `xpertapply-staging-web` and never touches the API, the database, the worker,
# the scheduler, nginx, production, VeoTrex, PostgreSQL, Redis or SMTP. It never edits a file under /etc/nginx.
#
#   sudo bash staging-s3-web-release.sh preflight      # READ-ONLY: writes nothing under /root, changes nothing
#   sudo bash staging-s3-web-release.sh pin-rollback   # adds ONE alias tag to the S2 web image staging runs today; nothing else
#   sudo XA_STAGING_APPROVED=yes-s3-1b26947d bash staging-s3-web-release.sh web          # recreate ONLY xpertapply-staging-web
#   sudo bash staging-s3-web-release.sh verify         # READ-ONLY checks of the live result
#   sudo XA_STAGING_APPROVED=yes-s3-1b26947d bash staging-s3-web-release.sh rollback-web # back to the verified S2 web (95de977)
#
# Exit codes: 0 done and verified; 1 STOP, nothing was changed; 2 the web container WAS replaced (or restored) but verification did not
# complete (the final RESULT block says exactly what happened); 10 nothing to do, the web already runs the target of this mode.
# Images are identified by layer fingerprint, revision label AND host image id (a loaded image has a host-specific id).
# No compose down, no volume/image/container removal, no prune, pull or build.
set -uo pipefail
umask 077

EXPECT_HOST="srv738314"
REV="1b26947dfd46c3038c79579dd77df40db8622f60"; APPROVAL="yes-s3-${REV:0:8}"
NEW_WEB="xpertapply-staging-web:s3-1b26947-amd64"; NEW_WEB_FP="185247471546c434039840dd47515e15ffeaa4744435b92bcab533f6e5dfd86d"
# What staging runs today (the S2 release) and therefore what a rollback restores. NOT F4, NOT F2.
PREV_WEB_REV="95de9778b54f6fe18894e088bd29ab72307bb74b"; PREV_WEB_FP="ff8c29c3ec6ab407cdde3f5769b9893208fff4d1fabe1bc6957d3135a22aed54"
# Host image id of the S2 web as loaded on srv738314 was not recorded in the repository; leave empty to match by fingerprint + revision label, or pin it
# from the S2 `verify` output:  XA_S3_PREV_WEB_ID=sha256:...   When set it is enforced exactly like the other pins.
PREV_WEB_ID="${XA_S3_PREV_WEB_ID:-}"
CUR_API_REV="aa5bc2fa3cd943cdba53dbb475554eee6178a399";  CUR_API_FP="87b53b0e0032b94198cb27fd08b73422d145bddff37510c5b84bb102ffd6a95b"
CUR_API_ID="sha256:c7a15f1ea23b6e9dc1acc1699dd9ad607140797c9ebae40f57900938f64e3440"
RB_WEB="xpertapply-staging-rollback:web-s2-95de977"
DRYRUN_SHA="93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39"
ENFORCED_CSP="frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
STG_API="https://api-staging.xpertapply.com"; STG_WEB="https://staging.xpertapply.com"
INFRA="${INFRA:-/home/xpertapply/apps/staging/infra/staging}"
API_OVR="${API_OVR:-/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
DRYRUN="${DRYRUN:-/home/luna/xpertapply-pui01/staging-release-dryrun.sh}"
STATE="${XA_S3_STATE:-/root/pui-s3}"
PROTECTED_RE='^(xpertapply-(api|web|worker|scheduler|postgres|redis)-1|xpertapply-staging-(postgres|redis|worker|scheduler|api)|veotrex-.*)$'
DOCKER=docker; CURL=curl; CHECK_HOST=1; CLEAN=(env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
# Test hooks: honoured ONLY with XA_S3_SELFTEST=1, so every guard can be exercised against stubs without a host.
if [[ "${XA_S3_SELFTEST:-}" == "1" ]]; then
  DOCKER="${XA_S3_DOCKER:-docker}"; CURL="${XA_S3_CURL:-curl}"; CHECK_HOST=0; CLEAN=(env "PATH=$PATH" "XA_STUB=${XA_STUB:-}")
  [[ -n "${XA_S3_NEW_WEB_FP:-}" ]] && NEW_WEB_FP="$XA_S3_NEW_WEB_FP"; [[ -n "${XA_S3_PREV_WEB_FP:-}" ]] && PREV_WEB_FP="$XA_S3_PREV_WEB_FP"
  [[ -n "${XA_S3_PREV_WEB_ID:-}" ]] && PREV_WEB_ID="$XA_S3_PREV_WEB_ID"; [[ -n "${XA_S3_API_FP:-}" ]] && CUR_API_FP="$XA_S3_API_FP"
  [[ -n "${XA_S3_API_ID:-}" ]] && CUR_API_ID="$XA_S3_API_ID"; [[ -n "${XA_S3_DRYRUN_SHA:-}" ]] && DRYRUN_SHA="$XA_S3_DRYRUN_SHA"
fi

say(){ printf '%s\n' "$*"; }; ok(){ printf 'PASS  %s\n' "$*"; }; info(){ printf 'INFO  %s\n' "$*"; }
# Phases that make the final RESULT block accurate. STOP before REPLACED means "nothing changed".
REPLACED=0; VERIFIED=0; OLD_CID=""; NEW_CID=""; MODE_DONE=""
stop(){ printf 'STOP  %s\n' "$*" >&2; exit 1; }
mode="${1:-}"
case "$mode" in preflight|pin-rollback|web|verify|rollback-web) ;; *) stop "usage: $0 preflight|pin-rollback|web|verify|rollback-web";; esac
result_block() {
  local rc=$?
  [[ "$mode" == web || "$mode" == rollback-web ]] || return 0
  say; say "RESULT ($mode)"
  if [[ "$REPLACED" == 1 ]]; then say "      web container: REPLACED  ${OLD_CID:-?} -> ${NEW_CID:-?}"; else say "      web container: NOT replaced (no change was made to the web container)"; fi
  if [[ "$VERIFIED" == 1 ]]; then say "      verification:  COMPLETE and passed"
  elif [[ "$REPLACED" == 1 ]]; then say "      verification:  INCOMPLETE. The web WAS changed. Run:  sudo bash $0 verify   or   sudo XA_STAGING_APPROVED=$APPROVAL bash $0 rollback-web"
  else say "      verification:  not reached"; fi
  [[ "$rc" == 0 || "$rc" == 10 ]] || { [[ "$REPLACED" == 1 ]] && exit 2; }
}
[[ "$(id -u)" == 0 || "${XA_S3_SELFTEST:-}" == 1 ]] || stop "run with sudo"
[[ "$CHECK_HOST" == 0 || "$(hostname)" == "$EXPECT_HOST" ]] || stop "wrong host $(hostname)"
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || stop "DOCKER_HOST/DOCKER_CONTEXT is set"
[[ "$("${CLEAN[@]}" "$DOCKER" context show)" == default ]] || stop "docker context is not default"
for f in "$INFRA/compose.staging.yml" "$INFRA/.env.staging" "$API_OVR" "$DRYRUN"; do [[ -f "$f" ]] || stop "missing $f"; done
case "$mode" in web|rollback-web) [[ "${XA_STAGING_APPROVED:-}" == "$APPROVAL" ]] || stop "founder approval not given: set XA_STAGING_APPROVED=$APPROVAL only after approval";; esac
case "$mode" in preflight|verify) WORK="$(mktemp -d)" ;; *) mkdir -p "$STATE"; chmod 700 "$STATE"; WORK="$(mktemp -d "$STATE/work.XXXXXX")" ;; esac
trap 'result_block; rm -rf "$WORK"' EXIT
# Concurrent operators: only one mutating run at a time, and a second one sees the state the first left.
if [[ "$mode" == web || "$mode" == rollback-web || "$mode" == pin-rollback ]]; then
  exec 9>"$STATE/lock"; flock -n 9 || stop "another S3 release command holds the lock (concurrent operator?)"
fi

dc(){ "${CLEAN[@]}" "$DOCKER" compose --project-name xpertapply-staging --project-directory "$INFRA" --env-file "$INFRA/.env.staging" \
        -f "$INFRA/compose.staging.yml" -f "$API_OVR" "$@"; }
img_id(){ "$DOCKER" image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
img_fp(){ "$DOCKER" image inspect -f '{{json .RootFS.Layers}}' "$1" 2>/dev/null | sha256sum | cut -d' ' -f1; }
img_rev(){ "$DOCKER" image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null; }
snap(){ "$DOCKER" ps -a --format '{{.Names}} {{.ID}} {{.Image}}' | sort; }
running_img(){ "$DOCKER" inspect -f '{{.Image}}' "$1" 2>/dev/null; }
web_cid(){ "$DOCKER" inspect -f '{{.Id}}' xpertapply-staging-web 2>/dev/null | cut -c1-12; }
web_started(){ "$DOCKER" inspect -f '{{.State.StartedAt}}' xpertapply-staging-web 2>/dev/null; }
log_phase(){ mkdir -p "$STATE"; printf '%s %s %s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$1" "${2:-}" >> "$STATE/web-release.log"; }
# $1 image ref/id  $2 expected fingerprint  $3 expected revision  $4 label  [$5 expected host image id]
need_fp(){ [[ -n "$(img_id "$1")" ]] || stop "$4: image $1 is not present"; [[ "$(img_fp "$1")" == "$2" ]] || stop "$4: layer fingerprint mismatch"
  [[ "$(img_rev "$1")" == "$3" ]] || stop "$4: revision label mismatch"; [[ "$("$DOCKER" image inspect -f '{{.Os}}/{{.Architecture}}' "$1")" == linux/amd64 ]] || stop "$4: not linux/amd64"
  [[ -z "${5:-}" || "$(img_id "$1")" == "$5" ]] || stop "$4: host image id is $(img_id "$1"), expected $5"
  ok "$4: fingerprint, revision label ${3:0:8}, linux/amd64${5:+ and host image id} verified"; }
need_new(){ need_fp "$NEW_WEB" "$NEW_WEB_FP" "$REV" "candidate web"; NEW_WEB_ID="$(img_id "$NEW_WEB")"; ok "candidate web host image id $NEW_WEB_ID"; }
# Where is the running web? PREV (verified S2), CAND (S3), or OTHER. The candidate is matched by host id; PREV by host id when pinned, else by fingerprint + revision label.
classify_web(){
  local rid; rid="$(running_img xpertapply-staging-web)"; [[ -n "$rid" ]] || { echo NONE; return; }
  if [[ "$rid" == "$(img_id "$NEW_WEB")" ]]; then echo CAND
  elif [[ -n "$PREV_WEB_ID" ]]; then [[ "$rid" == "$PREV_WEB_ID" ]] && echo PREV || echo OTHER
  elif [[ "$(img_fp "$rid")" == "$PREV_WEB_FP" && "$(img_rev "$rid")" == "$PREV_WEB_REV" ]]; then echo PREV; else echo OTHER; fi
}
need_prev_running(){ local c; c="$(classify_web)"
  case "$c" in PREV) need_fp "$(running_img xpertapply-staging-web)" "$PREV_WEB_FP" "$PREV_WEB_REV" "staging web currently running (S2)" "$PREV_WEB_ID" ;;
    CAND) return 10 ;; *) stop "staging web is neither the verified S2 web nor the S3 candidate (running: $(running_img xpertapply-staging-web)); refusing" ;; esac; }
validate_lib(){ [[ "$(sha256sum "$DRYRUN" | cut -d' ' -f1)" == "$DRYRUN_SHA" ]] || stop "dry-run script is not the approved version"; XA_DRYRUN_SOURCE_ONLY=1 source "$DRYRUN"; set +u; }
override(){ printf 'services:\n  %s:\n    image: %s\n' "$1" "$2" > "$WORK/$1.yml"; echo "$WORK/$1.yml"; }
others_unchanged(){ diff <(awk '$1!="xpertapply-staging-web"' "$WORK/step.before") <(snap | awk '$1!="xpertapply-staging-web"') >/dev/null \
  && ok "every other container name, id and image is unchanged since this step began" || stop "another container changed during this step"; }
wait_up(){ local c="$1" i s; for i in $(seq 1 40); do s="$("$DOCKER" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)"; [[ "$s" == healthy || "$s" == running ]] && { ok "$c is $s"; return 0; }; sleep "${XA_S3_POLL:-3}"; done; return 1; }
db_rev(){ "$DOCKER" exec xpertapply-staging-api alembic current 2>/dev/null | tail -1; }
base_state(){ # what must hold before ANY change: the API and database are exactly the F2 API release and healthy
  need_fp "$(running_img xpertapply-staging-api)" "$CUR_API_FP" "$CUR_API_REV" "staging API (must stay unchanged)" "$CUR_API_ID"
  [[ "$(db_rev)" == "0034_password_reset (head)" ]] && ok "staging database is at 0034_password_reset" || stop "database revision is '$(db_rev)'"
  [[ -z "$("$DOCKER" exec xpertapply-staging-api printenv EMAIL_BACKEND 2>/dev/null | head -1)" ]] && ok "password-reset email stays disabled (EMAIL_BACKEND unset)" || stop "EMAIL_BACKEND is set on staging"
  "$CURL" -fsS "$STG_API/healthz" >/dev/null && ok "staging API healthy" || stop "staging API health failed"
}
serves_web(){ # the web keeps the earlier UI features (F2 scoring notice, match score panel, search placeholder)
  local page chunk body a="" b="" c=""
  page="$("$CURL" -fsS "$1/jobs")" || return 1
  for chunk in $(printf '%s' "$page" | grep -oE '/_next/static/chunks/[^"]*\.js' | sort -u); do
    body="$("$CURL" -fsS "$1$chunk" 2>/dev/null)" || continue
    printf '%s' "$body" | grep -q "Scoring your matches" && a=1
    printf '%s' "$body" | grep -q "Match score" && b=1
    printf '%s' "$body" | grep -q "Role, company or skill" && c=1
  done
  [[ -n "$a" && -n "$b" && -n "$c" ]]
}
# The S3 hook ships its interactive-control selector as a string literal; the S2 bundles do not contain it.
FOCUS_MARK='summary, [role="button"], [role="link"], [role="menuitem"]'
serves_focus(){ local page chunk; page="$("$CURL" -fsS "$1/jobs")" || return 1
  for chunk in $(printf '%s' "$page" | grep -oE '/_next/static/chunks/[^"]*\.js' | sort -u); do "$CURL" -fsS "$1$chunk" 2>/dev/null | grep -qF "$FOCUS_MARK" && return 0; done; return 1; }

# ---- live header contract (read-only) -------------------------------------------------------------------------------
HV=""; HS=""
getf(){ local raw; raw="$("$CURL" -sS -o /dev/null -D - --max-time 20 "$@" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z')"; HS="$(grep -E '^http/' <<<"$raw" | tail -1 | awk '{print $2}')"; HV="$(grep -vE '^http/' <<<"$raw")"; }
hn(){ grep -c "^$1:" <<<"$HV" || true; }
hv(){ grep -m1 "^$1:" <<<"$HV" | sed -E "s/^$1:[[:space:]]*//" || true; }
FAILS=0
chk(){ if [[ "$1" == 1 ]]; then ok "$2"; else printf 'FAIL  %s\n' "$2"; FAILS=$((FAILS+1)); fi; }
b(){ [[ "$1" == "$2" ]] && echo 1 || echo 0; }
live_headers(){  # $1 base URL
  local base="$1" r st csp ro ref
  for r in /login /signup /forgot-password /reset-password /dashboard /jobs /tracker /extension/connect /__s2_no_such_page__; do
    getf "$base$r"; st="$HS"
    case "$r" in /__s2_no_such_page__) chk "$(b "$st" 404)" "$r status $st (want 404)";; *) chk "$(b "$st" 200)" "$r status $st (want 200)";; esac
    csp="$(hv content-security-policy)"; ro="$(hv content-security-policy-report-only)"
    chk "$(b "$(hn content-security-policy)" 1)" "$r: exactly one enforced CSP header"
    chk "$(b "$csp" "$(tr 'A-Z' 'a-z' <<<"$ENFORCED_CSP")")" "$r: enforced CSP is exactly: $ENFORCED_CSP"
    chk "$([[ "$csp" != *script-src* && "$csp" != *form-action* && "$csp" != *default-src* && "$csp" != *connect-src* ]] && echo 1 || echo 0)" "$r: enforced CSP has no script-src, form-action, default-src or connect-src"
    chk "$(b "$(hn content-security-policy-report-only)" 1)" "$r: exactly one Report-Only CSP header"
    chk "$([[ "$ro" == *"connect-src 'self' $STG_API;"* && "$ro" == *"img-src 'self' $STG_API data: blob:;"* && "$ro" != *"https://api.xpertapply.com"* ]] && echo 1 || echo 0)" "$r: Report-Only names the staging API origin and never the production one"
    chk "$([[ "$ro" == *"script-src 'self';"* ]] && echo 1 || echo 0)" "$r: Report-Only keeps its script-src (observation only)"
    chk "$(b "$(hn strict-transport-security)$(hv strict-transport-security)" 1max-age=300)" "$r: S1 HSTS exactly once = max-age=300"
    chk "$(b "$(hn x-frame-options)$(hv x-frame-options)" 1deny)" "$r: S1 X-Frame-Options exactly once = DENY"
    chk "$(b "$(hn x-content-type-options)$(hv x-content-type-options)" 1nosniff)" "$r: S1 nosniff exactly once"
    ref="strict-origin-when-cross-origin"; [[ "$r" == /forgot-password || "$r" == /reset-password ]] && ref="no-referrer"
    chk "$(b "$(hn referrer-policy)$(hv referrer-policy)" "1$ref")" "$r: Referrer-Policy exactly once = $ref"
    chk "$(b "$(hn x-robots-tag)$(hv x-robots-tag)" "1noindex, nofollow")" "$r: X-Robots-Tag exactly once = noindex, nofollow (staging stays noindex)"
    [[ "$r" == /forgot-password || "$r" == /reset-password ]] && chk "$([[ "$(hv cache-control)" == *no-store* ]] && echo 1 || echo 0)" "$r: Cache-Control no-store kept"
  done
  # Authenticated/dynamic pages must never be publicly cached; static shells carry no user data.
  for r in /jobs/1 /matches/1; do getf "$base$r"; chk "$([[ "$(hv cache-control)" != *public* && "$(hv cache-control)" != *s-maxage* ]] && echo 1 || echo 0)" "$r (dynamic) is not publicly cacheable: '$(hv cache-control)'"; done
  for r in /icon.png /robots.txt; do getf "$base$r"; chk "$([[ "$(hn content-security-policy)" == 0 && "$(hn content-security-policy-report-only)" == 0 ]] && echo 1 || echo 0)" "$r (file) carries no CSP header"; done
  getf "$base/robots.txt"; chk "$(b "$HS" 404)" "/robots.txt stays 404 (not advertised)"
  getf "$base/sitemap.xml"; chk "$(b "$HS" 404)" "/sitemap.xml stays 404"
}

case "$mode" in
preflight)
  validate_lib; need_new
  c="$(classify_web)"
  case "$c" in PREV) need_fp "$(running_img xpertapply-staging-web)" "$PREV_WEB_FP" "$PREV_WEB_REV" "staging web currently running (S2)" "$PREV_WEB_ID";;
    CAND) info "staging web already runs the S3 candidate; nothing to deploy. Run verify."; exit 10 ;;
    *) stop "staging web is neither the verified S2 web nor the S3 candidate (running: $(running_img xpertapply-staging-web))";; esac
  base_state
  if "$DOCKER" image inspect "$RB_WEB" >/dev/null 2>&1; then need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB (already pinned)" "$PREV_WEB_ID"; else info "rollback alias $RB_WEB not yet pinned: run pin-rollback before web"; fi
  say "-- scope check: compose dry run for ONLY the web with the candidate image (read-only) --"
  o="$(override web "$NEW_WEB")"; cid="$(web_cid)"
  dc -f "$o" --profile web up --dry-run -d --no-deps --no-build --pull never web > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run web "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only xpertapply-staging-web"
  say "-- S1 is active right now (public, read-only) --"
  getf "$STG_WEB/login"; [[ "$(hn strict-transport-security)" == 1 && "$(hn x-frame-options)" == 1 && "$(hn x-content-type-options)" == 1 && "$(hn referrer-policy)" == 1 ]] && ok "staging web already sends the four S1 headers once" || stop "S1 headers are not active on staging web; S3 is not to be released ahead of S1"
  getf "$STG_API/healthz"; [[ "$(hn strict-transport-security)" == 1 && "$(hn x-content-type-options)" == 1 ]] && ok "staging API sends HSTS and nosniff once" || stop "S1 headers are not active on the staging API"
  say "PREFLIGHT PASS (nothing was changed)" ;;
pin-rollback)
  need_prev_running; rc=$?; [[ $rc == 10 ]] && { info "web already runs the S3 candidate; the S2 alias must already exist"; exit 10; }
  if "$DOCKER" image inspect "$RB_WEB" >/dev/null 2>&1; then
    need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB" "$PREV_WEB_ID"; info "alias already present and correct; nothing changed"; exit 0
  fi
  "$DOCKER" tag "$(running_img xpertapply-staging-web)" "$RB_WEB"; need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB" "$PREV_WEB_ID"
  log_phase PINNED "$RB_WEB"; ok "alias tag added; no other change" ;;
web)
  validate_lib; need_new
  need_prev_running; rc=$?
  if [[ $rc == 10 ]]; then
    info "NO ACTION: staging web already runs the S3 candidate (container $(web_cid), started $(web_started)). It was NOT redeployed."
    info "last recorded phases:"; tail -4 "$STATE/web-release.log" 2>/dev/null | sed 's/^/      /'
    say "      run:  sudo bash $0 verify"; exit 10
  fi
  need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB" "$PREV_WEB_ID"
  OLD_IMG="$(running_img xpertapply-staging-web)"; [[ "$OLD_IMG" == "$(img_id "$RB_WEB")" ]] || stop "running web is not the image the rollback alias points to"
  base_state; snap > "$WORK/step.before"; cp "$WORK/step.before" "$STATE/before.containers.txt"
  o="$(override web "$NEW_WEB")"; OLD_CID="$(web_cid)"
  "$DOCKER" inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' xpertapply-staging-web > "$WORK/mounts.before"
  dc -f "$o" --profile web up --dry-run -d --no-deps --no-build --pull never web > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run web "$WORK/dry" "$rc" "$OLD_CID")" || stop "dry run rejected: $r"; ok "dry run touches only xpertapply-staging-web"
  log_phase BEGIN "old_container=$OLD_CID old_image=$OLD_IMG new_image=$NEW_WEB_ID"
  dc -f "$o" --profile web up -d --no-deps --no-build --pull never web; urc=$?
  NEW_CID="$(web_cid)"
  # Report what really happened, whatever the exit code of compose said.
  if [[ "$NEW_CID" != "$OLD_CID" || "$(running_img xpertapply-staging-web)" != "$OLD_IMG" ]]; then REPLACED=1; log_phase REPLACED "old=$OLD_CID new=$NEW_CID compose_rc=$urc"; fi
  [[ $urc == 0 ]] || stop "compose up failed (rc=$urc); the RESULT block below states whether the web container changed"
  [[ "$(running_img xpertapply-staging-web)" == "$NEW_WEB_ID" ]] && ok "xpertapply-staging-web now runs $NEW_WEB_ID (container $OLD_CID -> $NEW_CID)" || stop "web is not on the candidate; run rollback-web"
  [[ "$("$DOCKER" inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' xpertapply-staging-web)" == "$(cat "$WORK/mounts.before")" ]] && ok "web kept exactly the same volumes" || stop "volumes changed; run rollback-web"
  wait_up xpertapply-staging-web || stop "web did not become healthy; run rollback-web"
  ok_http=""; for _ in $(seq 1 20); do "$CURL" -fsS -o /dev/null --max-time 5 http://127.0.0.1:3001/login && { ok_http=1; break; }; sleep "${XA_S3_POLL:-3}"; done
  [[ -n "$ok_http" ]] && ok "web answers on 127.0.0.1:3001" || stop "web did not answer; run rollback-web"
  log_phase HEALTHY "container=$NEW_CID"
  serves_web http://127.0.0.1:3001 && ok "the Jobs UI (scoring notice, match score, search) is still served" || stop "Jobs UI not found; run rollback-web"
  serves_focus http://127.0.0.1:3001 && ok "the S3 dialog-focus code is in the served Jobs bundle" || stop "S3 focus code not found in the served bundle; run rollback-web"
  need_fp "$(running_img xpertapply-staging-api)" "$CUR_API_FP" "$CUR_API_REV" "staging API (unchanged)" "$CUR_API_ID"
  others_unchanged
  FAILS=0; say "-- live header contract (public staging, read-only) --"; live_headers "$STG_WEB"
  [[ "$FAILS" == 0 ]] || stop "$FAILS live header check(s) failed; run rollback-web (nothing else was changed)"
  VERIFIED=1; log_phase VERIFIED "container=$NEW_CID"; say "S3 WEB RELEASE COMPLETE AND VERIFIED. Rollback: sudo XA_STAGING_APPROVED=$APPROVAL bash $0 rollback-web" ;;
rollback-web)
  c="$(classify_web)"
  case "$c" in PREV) info "NO ACTION: staging web already runs the verified S2 image."; exit 10;; CAND) ;; *) stop "staging web is neither the S2 web nor the S3 candidate; refusing to guess";; esac
  RB_ID="$(img_id "$RB_WEB")"
  need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB (the verified S2 web, not F4 or F2)" "$PREV_WEB_ID"
  snap > "$WORK/step.before"; o="$(override web "$RB_WEB")"; OLD_CID="$(web_cid)"; log_phase ROLLBACK_BEGIN "old_container=$OLD_CID"
  dc -f "$o" --profile web up -d --no-deps --no-build --pull never web; urc=$?
  NEW_CID="$(web_cid)"; [[ "$NEW_CID" != "$OLD_CID" ]] && { REPLACED=1; log_phase ROLLBACK_REPLACED "old=$OLD_CID new=$NEW_CID"; }
  [[ $urc == 0 ]] || stop "rollback compose up failed (rc=$urc)"
  [[ "$(running_img xpertapply-staging-web)" == "$RB_ID" ]] && ok "xpertapply-staging-web is back on the verified S2 image $RB_ID" || stop "web is not on the S2 image"
  need_fp "$(running_img xpertapply-staging-web)" "$PREV_WEB_FP" "$PREV_WEB_REV" "restored web" "$PREV_WEB_ID"
  wait_up xpertapply-staging-web || stop "web not healthy after rollback"
  others_unchanged; need_fp "$(running_img xpertapply-staging-api)" "$CUR_API_FP" "$CUR_API_REV" "staging API (unchanged)" "$CUR_API_ID"
  "$CURL" -fsS -o /dev/null --max-time 10 "$STG_WEB/login" && ok "https web answers" || stop "staging web does not answer"
  FAILS=0; say "-- live header contract after rollback (S1 + S2 policy must still hold) --"; live_headers "$STG_WEB"
  [[ "$FAILS" == 0 ]] || stop "post-rollback checks failed"
  VERIFIED=1; log_phase ROLLBACK_VERIFIED "container=$NEW_CID"; say "ROLLBACK COMPLETE AND VERIFIED. The API and database were NOT touched." ;;
verify)
  need_new; base_state
  [[ "$(classify_web)" == CAND ]] && ok "staging web runs the S3 candidate image (container $(web_cid), started $(web_started))" || stop "staging web is not on the S3 candidate"
  FAILS=0; say "-- live header contract: staging web (public, read-only) --"; live_headers "$STG_WEB"
  say "-- staging API --"; getf "$STG_API/healthz"
  chk "$(b "$HS" 200)" "api /healthz 200"; chk "$(b "$(hn strict-transport-security)$(hn x-content-type-options)$(hn x-robots-tag)" 111)" "api S1 headers and noindex once"
  getf "$STG_API/jobs"; chk "$(b "$HS" 401)" "api unauthenticated /jobs 401"
  for path in dashboard/summary auth/me; do c="$("$CURL" -s -o /dev/null -w '%{http_code}' "$STG_API/$path")"; chk "$([[ "$c" == 401 || "$c" == 403 ]] && echo 1 || echo 0)" "unauthenticated /$path refused ($c)"; done
  getf -H "Origin: $STG_WEB" "$STG_API/healthz"; chk "$(b "$(hv access-control-allow-origin)" "$STG_WEB")" "api CORS still allows the staging web origin"
  say "-- S1 nginx file (read-only INFO; the script never edits it) --"
  [[ -r /etc/nginx/sites-available/xpertapply-staging ]] && info "staging vhost sha256 $(sha256sum /etc/nginx/sites-available/xpertapply-staging | cut -d' ' -f1)" || info "staging vhost not readable here"
  say "-- production is unaffected --"
  "$CURL" -fsS https://api.xpertapply.com/healthz >/dev/null && ok "production API healthy" || { printf 'FAIL  production API unhealthy\n'; FAILS=$((FAILS+1)); }
  getf https://xpertapply.com/; chk "$(b "$HS" 200)" "production web 200"
  chk "$([[ "$(hn content-security-policy)" == 0 ]] && echo 1 || echo 0)" "production web has no enforced CSP (it is untouched by this release)"
  if [[ -f "$STATE/before.containers.txt" ]]; then
    snap | grep -E "$PROTECTED_RE" | diff - <(grep -E "$PROTECTED_RE" "$STATE/before.containers.txt") >/dev/null && ok "API, worker, scheduler, postgres, redis, production and veotrex containers are identical to the pre-release snapshot" || { printf 'FAIL  a protected container differs from the snapshot\n'; FAILS=$((FAILS+1)); }
  else info "no pre-release snapshot at $STATE/before.containers.txt (verify run on a host where web was not run by this script)"; fi
  if [[ "$FAILS" == 0 ]]; then say "VERIFY PASSED"; else say "VERIFY FAILED ($FAILS)"; exit 1; fi ;;
esac
