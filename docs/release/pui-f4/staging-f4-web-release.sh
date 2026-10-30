#!/usr/bin/env bash
# F4 (Apply dialog keyboard accessibility): WEB-ONLY staging release of baf0817. Root, staging only.
#
# Staging runs the aa5bc2f API and web, database at 0034_password_reset. THIS RELEASE CHANGES ONLY THE WEB IMAGE: no API change, no migration,
# no environment change. This script recreates ONLY `xpertapply-staging-web` and never touches the API, the database, the worker, the scheduler,
# nginx, production, VeoTrex, PostgreSQL, Redis or SMTP.
#
#   sudo bash staging-f4-web-release.sh preflight       # READ-ONLY: images, state, approved dry run, snapshot
#   sudo bash staging-f4-web-release.sh pin-rollback    # adds ONE alias tag to the web image staging runs today; nothing else
#   sudo XA_STAGING_APPROVED=yes-baf08176 bash staging-f4-web-release.sh web           # recreate ONLY xpertapply-staging-web
#   sudo bash staging-f4-web-release.sh verify          # READ-ONLY checks
#   sudo XA_STAGING_APPROVED=yes-baf08176 bash staging-f4-web-release.sh rollback-web  # back to the aa5bc2f web
#
# The web running today and the candidate are identified by layer fingerprint and revision label (a loaded image has a host-specific ID).
# No compose down, no volume/image/container removal, no prune, pull or build. Prints names, ids and pass/fail only.
set -uo pipefail
umask 077

EXPECT_HOST="srv738314"
REV="baf081769b8e4c2ce4f04599f0568da3456a8b1c"; APPROVAL="yes-${REV:0:8}"
NEW_WEB="xpertapply-staging-web:f4-baf0817-amd64";     NEW_WEB_FP="7f9f346b43d6f6ac2d3052693154c3977d4838f8779a8342d033e919bee66ed2"
# What staging runs today, and therefore what a rollback restores (the F2 release, aa5bc2f).
PREV_WEB_REV="aa5bc2fa3cd943cdba53dbb475554eee6178a399"; PREV_WEB_FP="64f805646ad52c01571dea4b8d029d3016e2492d40abe695c8728432697a1c1a"
CUR_API_REV="aa5bc2fa3cd943cdba53dbb475554eee6178a399";  CUR_API_FP="87b53b0e0032b94198cb27fd08b73422d145bddff37510c5b84bb102ffd6a95b"
RB_WEB="xpertapply-staging-rollback:web-aa5bc2f"
DRYRUN_SHA="93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39"
NOINDEX_SHA="832507de0449aae84b8cead8194806442326e95417cb9d335ec66ec6433f2ae6"
INFRA="${INFRA:-/home/xpertapply/apps/staging/infra/staging}"
API_OVR="${API_OVR:-/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
DRYRUN="${DRYRUN:-/home/luna/xpertapply-pui01/staging-release-dryrun.sh}"
NOINDEX_VALIDATOR="${NOINDEX_VALIDATOR:-/home/luna/xpertapply-pui01/nginx-noindex/validate-staging-noindex.sh}"
STATE="/root/pui-f4"
PROTECTED_RE='^(xpertapply-(api|web|worker|scheduler|postgres|redis)-1|xpertapply-staging-(postgres|redis|worker|scheduler|api)|veotrex-.*)$'

say(){ printf '%s\n' "$*"; }; ok(){ printf 'PASS  %s\n' "$*"; }; info(){ printf 'INFO  %s\n' "$*"; }
stop(){ printf 'STOP  %s\n' "$*" >&2; exit 1; }
CLEAN=(env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
mode="${1:-}"
case "$mode" in preflight|pin-rollback|web|verify|rollback-web) ;; *) stop "usage: $0 preflight|pin-rollback|web|verify|rollback-web";; esac
[[ "$(id -u)" == 0 ]] || stop "run with sudo"
[[ "$(hostname)" == "$EXPECT_HOST" ]] || stop "wrong host $(hostname)"
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || stop "DOCKER_HOST/DOCKER_CONTEXT is set"
[[ "$("${CLEAN[@]}" docker context show)" == default ]] || stop "docker context is not default"
for f in "$INFRA/compose.staging.yml" "$INFRA/.env.staging" "$API_OVR" "$DRYRUN"; do [[ -f "$f" ]] || stop "missing $f"; done
case "$mode" in web|rollback-web) [[ "${XA_STAGING_APPROVED:-}" == "$APPROVAL" ]] || stop "founder approval not given: set XA_STAGING_APPROVED=$APPROVAL only after approval";; esac
mkdir -p "$STATE"; chmod 700 "$STATE"; WORK="$(mktemp -d "$STATE/work.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

dc(){ "${CLEAN[@]}" docker compose --project-name xpertapply-staging --project-directory "$INFRA" --env-file "$INFRA/.env.staging" \
        -f "$INFRA/compose.staging.yml" -f "$API_OVR" "$@"; }
img_id(){ docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
img_fp(){ docker image inspect -f '{{json .RootFS.Layers}}' "$1" 2>/dev/null | sha256sum | cut -d' ' -f1; }
img_rev(){ docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null; }
snap(){ docker ps -a --format '{{.Names}} {{.ID}} {{.Image}}' | sort; }
running_img(){ docker inspect -f '{{.Image}}' "$1" 2>/dev/null; }
# $1 image ref/id  $2 expected fingerprint  $3 expected revision  $4 label for messages
need_fp(){ [[ -n "$(img_id "$1")" ]] || stop "$4: image $1 is not present"; [[ "$(img_fp "$1")" == "$2" ]] || stop "$4: layer fingerprint mismatch"
  [[ "$(img_rev "$1")" == "$3" ]] || stop "$4: revision label mismatch"; [[ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$1")" == linux/amd64 ]] || stop "$4: not linux/amd64"
  ok "$4: fingerprint, revision label ${3:0:8} and linux/amd64 verified"; }
need_new(){ need_fp "$NEW_WEB" "$NEW_WEB_FP" "$REV" "candidate web"; NEW_WEB_ID="$(img_id "$NEW_WEB")"; ok "candidate web host image id $NEW_WEB_ID"; }
validate_lib(){ [[ "$(sha256sum "$DRYRUN" | cut -d' ' -f1)" == "$DRYRUN_SHA" ]] || stop "dry-run script is not the approved version"; XA_DRYRUN_SOURCE_ONLY=1 source "$DRYRUN"; set +u; }
override(){ printf 'services:\n  %s:\n    image: %s\n' "$1" "$2" > "$WORK/$1.yml"; echo "$WORK/$1.yml"; }
others_unchanged(){ diff <(awk '$1!="xpertapply-staging-web"' "$WORK/step.before") <(snap | awk '$1!="xpertapply-staging-web"') >/dev/null \
  && ok "every other container name, id and image is unchanged since this step began" || stop "another container changed during this step"; }
wait_up(){ local c="$1" i s; for i in $(seq 1 40); do s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)"; [[ "$s" == healthy || "$s" == running ]] && { ok "$c is $s"; return 0; }; sleep 3; done; return 1; }
db_rev(){ docker exec xpertapply-staging-api alembic current 2>/dev/null | tail -1; }
base_state(){ # what must hold before ANY change: the API and database are exactly the F2 release and healthy
  need_fp "$(running_img xpertapply-staging-api)" "$CUR_API_FP" "$CUR_API_REV" "staging API (must stay unchanged)"
  [[ "$(db_rev)" == "0034_password_reset (head)" ]] && ok "staging database is at 0034_password_reset" || stop "database revision is '$(db_rev)'"
  [[ -z "$(docker exec xpertapply-staging-api printenv EMAIL_BACKEND 2>/dev/null | head -1)" ]] && ok "password-reset email stays disabled (EMAIL_BACKEND unset)" || stop "EMAIL_BACKEND is set on staging"
  curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "staging API healthy" || stop "staging API health failed"
}
# The web keeps every earlier UI feature: scoring notice (F2), match score panel, new search placeholder.
serves_web(){
  local page chunk body a="" b="" c=""
  page="$(curl -fsS "$1/jobs")" || return 1
  for chunk in $(printf '%s' "$page" | grep -oE '/_next/static/chunks/[^"]*\.js' | sort -u); do
    body="$(curl -fsS "$1$chunk" 2>/dev/null)" || continue
    printf '%s' "$body" | grep -q "Scoring your matches" && a=1
    printf '%s' "$body" | grep -q "Match score" && b=1
    printf '%s' "$body" | grep -q "Role, company or skill" && c=1
  done
  [[ -n "$a" && -n "$b" && -n "$c" ]]
}

case "$mode" in
preflight)
  validate_lib; need_new
  need_fp "$(running_img xpertapply-staging-web)" "$PREV_WEB_FP" "$PREV_WEB_REV" "staging web currently running"
  base_state
  snap > "$STATE/before.containers.txt"; ok "container snapshot saved ($(wc -l < "$STATE/before.containers.txt") containers)"
  say "-- scope check: compose dry run for ONLY the web with the candidate image (read-only) --"
  o="$(override web "$NEW_WEB")"; cid="$(docker inspect -f '{{.Id}}' xpertapply-staging-web | cut -c1-12)"
  dc -f "$o" --profile web up --dry-run -d --no-deps --no-build --pull never web > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run web "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only xpertapply-staging-web"
  say "PREFLIGHT PASS (nothing was changed)" ;;
pin-rollback)
  need_fp "$(running_img xpertapply-staging-web)" "$PREV_WEB_FP" "$PREV_WEB_REV" "staging web currently running"
  docker tag "$(running_img xpertapply-staging-web)" "$RB_WEB"; need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB"
  ok "alias tag added; no other change" ;;
web)
  validate_lib; need_new; need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB"
  need_fp "$(running_img xpertapply-staging-web)" "$PREV_WEB_FP" "$PREV_WEB_REV" "staging web currently running"
  base_state; snap > "$WORK/step.before"
  o="$(override web "$NEW_WEB")"; cid="$(docker inspect -f '{{.Id}}' xpertapply-staging-web | cut -c1-12)"
  docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' xpertapply-staging-web > "$WORK/mounts.before"
  dc -f "$o" --profile web up --dry-run -d --no-deps --no-build --pull never web > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run web "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only xpertapply-staging-web"
  dc -f "$o" --profile web up -d --no-deps --no-build --pull never web || stop "compose up failed; run rollback-web"
  [[ "$(running_img xpertapply-staging-web)" == "$NEW_WEB_ID" ]] && ok "xpertapply-staging-web now runs $NEW_WEB_ID" || stop "web is not on the candidate; run rollback-web"
  [[ "$(docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' xpertapply-staging-web)" == "$(cat "$WORK/mounts.before")" ]] && ok "web kept exactly the same volumes" || stop "volumes changed; run rollback-web"
  wait_up xpertapply-staging-web || stop "web did not become healthy; run rollback-web"
  ok_http=""; for _ in $(seq 1 20); do curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3001/login && { ok_http=1; break; }; sleep 3; done
  [[ -n "$ok_http" ]] && ok "web answers on 127.0.0.1:3001" || stop "web did not answer; run rollback-web"
  serves_web http://127.0.0.1:3001 && ok "the Jobs UI (scoring notice, match score, search) is still served" || stop "Jobs UI not found; run rollback-web"
  need_fp "$(running_img xpertapply-staging-api)" "$CUR_API_FP" "$CUR_API_REV" "staging API (unchanged)"
  others_unchanged ;;
rollback-web)
  need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB"; snap > "$WORK/step.before"; o="$(override web "$RB_WEB")"
  dc -f "$o" --profile web up -d --no-deps --no-build --pull never web || stop "rollback compose up failed"
  [[ "$(running_img xpertapply-staging-web)" == "$(img_id "$RB_WEB")" ]] && ok "xpertapply-staging-web is back on $RB_WEB" || stop "web is not on $RB_WEB"
  wait_up xpertapply-staging-web || stop "web not healthy after rollback"; others_unchanged xpertapply-staging-web
  say "NOTE: the API and database were NOT touched by this release or its rollback." ;;
verify)
  [[ -f "$STATE/before.containers.txt" ]] || stop "run preflight first"
  need_new; base_state
  [[ "$(running_img xpertapply-staging-web)" == "$NEW_WEB_ID" ]] && ok "staging web runs the baf0817 image" || stop "staging web is not on the candidate"
  for path in dashboard jobs tracker settings login; do [[ "$(curl -s -o /dev/null -w '%{http_code}' "https://staging.xpertapply.com/$path")" == 200 ]] && ok "https://staging.xpertapply.com/$path = 200" || stop "/$path not 200"; done
  serves_web https://staging.xpertapply.com && ok "the Jobs UI is served publicly" || stop "Jobs UI missing"
  for path in jobs "dashboard/summary" "auth/me"; do c="$(curl -s -o /dev/null -w '%{http_code}' "https://api-staging.xpertapply.com/$path")"; [[ "$c" == 401 || "$c" == 403 ]] && ok "unauthenticated /$path is refused ($c)" || stop "/$path answered $c"; done
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST https://api-staging.xpertapply.com/jobs/scoring/advance)" == 401 ]] && ok "scoring endpoint still live and authenticated" || stop "scoring endpoint missing"
  [[ "$(sha256sum "$NOINDEX_VALIDATOR" | cut -d' ' -f1)" == "$NOINDEX_SHA" ]] || stop "noindex validator is not the reviewed one"
  bash "$NOINDEX_VALIDATOR" | grep -E "^(FAIL|PASS)" | sort | uniq -c | sed 's/^/      /'
  curl -fsS https://api.xpertapply.com/healthz >/dev/null && ok "production API healthy" || stop "production API unhealthy"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://xpertapply.com/)" == 200 ]] && ok "production web 200" || stop "production web not 200"
  snap | grep -E "$PROTECTED_RE" | diff - <(grep -E "$PROTECTED_RE" "$STATE/before.containers.txt") >/dev/null && ok "API, worker, scheduler, postgres, redis, production and veotrex containers are identical to the snapshot" || stop "a protected container differs from the snapshot" ;;
esac
