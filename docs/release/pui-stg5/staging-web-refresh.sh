#!/usr/bin/env bash
# PUI-STG5: web-ONLY refresh of staging to the final Applications redesign (b99125c). Root, staging only.
#
# Staging already runs the 9dbf283 API (database at 0034_password_reset) and the 9dbf283 web. This replaces ONLY the web.
#
#   sudo bash staging-web-refresh.sh preflight      # READ-ONLY: image, health, state, approved dry run, snapshot
#   sudo bash staging-web-refresh.sh pin-rollback   # adds ONE alias tag to the web image staging runs today (no other change)
#   sudo XA_STAGING_APPROVED=yes-b99125c9 bash staging-web-refresh.sh web           # recreate ONLY xpertapply-staging-web
#   sudo bash staging-web-refresh.sh verify         # READ-ONLY smoke checks
#   sudo XA_STAGING_APPROVED=yes-b99125c9 bash staging-web-refresh.sh rollback-web  # back to the 9dbf283 web image
#
# No migration, no API change, no compose down, no volume/image removal, no prune, no pull, no build, no nginx, no production,
# no VeoTrex, no PostgreSQL/Redis, no SMTP. Prints names, ids and pass/fail only.
set -uo pipefail
umask 077

EXPECT_HOST="srv738314"
APPROVAL="yes-b99125c9"
NEW_WEB="xpertapply-staging-web:pui-b99125c-amd64"; NEW_WEB_ID="sha256:55fa6bb761925c62021a5bbe88fe90c8a8ff48c89513c530eda50516881ddc46"
NEW_REV="b99125c9224f2fc4a8a1ab2376964ef3b5ea6654"
PREV_WEB_TAG="xpertapply-staging-web:pui-9dbf283-amd64"; PREV_WEB_ID="sha256:fb51cfd76b1ae7ea8bd1b473ef59d6cb60d3935ae2332586cfb3d0d320a819cd"
RB_WEB="xpertapply-staging-rollback:web-fb51cfd76b1a"
API_ID="sha256:87c7226837b6133aadd3ffc72f88acb1119b0fca9c013f267b597d649bd83e55"
DRYRUN_SHA="93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39"
NOINDEX_SHA="832507de0449aae84b8cead8194806442326e95417cb9d335ec66ec6433f2ae6"
INFRA="${INFRA:-/home/xpertapply/apps/staging/infra/staging}"
API_OVR="${API_OVR:-/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
DRYRUN="${DRYRUN:-/home/luna/xpertapply-pui01/staging-release-dryrun.sh}"
NOINDEX_VALIDATOR="${NOINDEX_VALIDATOR:-/home/luna/xpertapply-pui01/nginx-noindex/validate-staging-noindex.sh}"
STATE="/root/pui-stg5"
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
snap(){ docker ps -a --format '{{.Names}} {{.ID}} {{.Image}}' | sort; }
need_img(){ [[ "$(img_id "$1")" == "$2" ]] || stop "image $1 is '$(img_id "$1")', expected $2"; ok "$1 = $2"; }
validate_lib(){ [[ "$(sha256sum "$DRYRUN" | cut -d' ' -f1)" == "$DRYRUN_SHA" ]] || stop "dry-run script is not the approved version"; XA_DRYRUN_SOURCE_ONLY=1 source "$DRYRUN"; set +u; }
web_override(){ printf 'services:\n  web:\n    image: %s\n' "$1" > "$WORK/web.yml"; echo "$WORK/web.yml"; }
others_unchanged(){ diff <(awk '$1!="xpertapply-staging-web"' "$WORK/step.before") <(snap | awk '$1!="xpertapply-staging-web"') >/dev/null \
  && ok "every other container name, id and image is unchanged since this step began" || stop "another container changed during this step"; }
common_state(){
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$API_ID" ]] && ok "staging API runs the 9dbf283 image (untouched by this step)" || stop "staging API is not on the expected image"
  [[ "$(docker exec xpertapply-staging-api alembic current 2>/dev/null | tail -1)" == "0034_password_reset (head)" ]] && ok "staging database is at 0034_password_reset" || stop "staging database is not at 0034"
  curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "staging API healthy" || stop "staging API health failed"
  [[ "$(docker exec xpertapply-staging-api printenv EMAIL_BACKEND 2>/dev/null | head -1)" == "" ]] && ok "password-reset email stays disabled (EMAIL_BACKEND unset)" || stop "EMAIL_BACKEND is set on staging"
}

case "$mode" in
preflight)
  validate_lib
  need_img "$NEW_WEB" "$NEW_WEB_ID"; need_img "$PREV_WEB_TAG" "$PREV_WEB_ID"
  [[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NEW_WEB")" == "$NEW_REV" ]] && ok "revision label $NEW_REV" || stop "revision label mismatch"
  [[ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$NEW_WEB")" == linux/amd64 ]] && ok "linux/amd64" || stop "platform mismatch"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$PREV_WEB_ID" ]] && ok "staging web currently runs $PREV_WEB_ID" || stop "staging web is not on the expected current image"
  common_state
  snap > "$STATE/before.containers.txt"; ok "container snapshot saved ($(wc -l < "$STATE/before.containers.txt") containers)"
  say "-- scope check: compose dry run for ONLY the web with the new image (read-only) --"
  o="$(web_override "$NEW_WEB")"; cid="$(docker inspect -f '{{.Id}}' xpertapply-staging-web | cut -c1-12)"
  dc -f "$o" --profile web up --dry-run -d --no-deps --no-build --pull never web > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run web "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only xpertapply-staging-web"
  say "PREFLIGHT PASS (nothing was changed)" ;;
pin-rollback)
  need_img "$PREV_WEB_TAG" "$PREV_WEB_ID"; docker tag "$PREV_WEB_ID" "$RB_WEB"; need_img "$RB_WEB" "$PREV_WEB_ID"; ok "alias tag added; no other change" ;;
web)
  validate_lib; need_img "$NEW_WEB" "$NEW_WEB_ID"; need_img "$RB_WEB" "$PREV_WEB_ID"
  [[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NEW_WEB")" == "$NEW_REV" ]] || stop "revision label mismatch"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$PREV_WEB_ID" ]] || stop "staging web is not on the expected current image"
  common_state; snap > "$WORK/step.before"
  o="$(web_override "$NEW_WEB")"; cid="$(docker inspect -f '{{.Id}}' xpertapply-staging-web | cut -c1-12)"
  dc -f "$o" --profile web up --dry-run -d --no-deps --no-build --pull never web > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run web "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only xpertapply-staging-web"
  dc -f "$o" --profile web up -d --no-deps --no-build --pull never web || stop "compose up failed; run rollback-web"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$NEW_WEB_ID" ]] && ok "xpertapply-staging-web now runs $NEW_WEB_ID" || stop "web is not on the new image; run rollback-web"
  ok_http=""; for _ in $(seq 1 20); do curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3001/tracker && { ok_http=1; break; }; sleep 3; done
  [[ -n "$ok_http" ]] && ok "web answers on 127.0.0.1:3001" || stop "web did not answer; run rollback-web"
  curl -fsS http://127.0.0.1:3001/tracker | grep -q "Your job search" && ok "the new Applications header is served" || stop "new header not found; run rollback-web"
  others_unchanged ;;
rollback-web)
  need_img "$RB_WEB" "$PREV_WEB_ID"; snap > "$WORK/step.before"; o="$(web_override "$RB_WEB")"
  dc -f "$o" --profile web up -d --no-deps --no-build --pull never web || stop "rollback compose up failed"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$PREV_WEB_ID" ]] && ok "web is back on $PREV_WEB_ID" || stop "web is not on $PREV_WEB_ID"
  for _ in $(seq 1 20); do curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3001/ && break; sleep 3; done
  curl -fsS -o /dev/null http://127.0.0.1:3001/ && ok "web answers" || stop "web not answering after rollback"
  others_unchanged; say "NOTE: no API or database change was made by this step or its rollback." ;;
verify)
  [[ -f "$STATE/before.containers.txt" ]] || stop "run preflight first"
  common_state
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$NEW_WEB_ID" ]] && ok "staging web runs the b99125c image" || stop "staging web is not on the new image"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://staging.xpertapply.com/tracker)" == 200 ]] && ok "https://staging.xpertapply.com/tracker = 200" || stop "tracker route not 200"
  curl -fsS https://staging.xpertapply.com/tracker | grep -q "Your job search" && ok "Applications header is served publicly" || stop "header missing"
  curl -fsS https://api-staging.xpertapply.com/auth/password-reset/availability | grep -q '"available":false' && ok "recovery reports unavailable" || stop "availability is not false"
  [[ "$(sha256sum "$NOINDEX_VALIDATOR" | cut -d' ' -f1)" == "$NOINDEX_SHA" ]] || stop "noindex validator is not the reviewed one"
  bash "$NOINDEX_VALIDATOR" | grep -E "^(FAIL|PASS)" | sort | uniq -c | sed 's/^/      /'
  curl -fsS https://api.xpertapply.com/healthz >/dev/null && ok "production API healthy" || stop "production API unhealthy"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://xpertapply.com/)" == 200 ]] && ok "production web 200" || stop "production web not 200"
  snap | grep -E "$PROTECTED_RE" | diff - <(grep -E "$PROTECTED_RE" "$STATE/before.containers.txt") >/dev/null && ok "api, postgres, redis, production and veotrex containers are identical to the snapshot" || stop "a protected container differs from the snapshot" ;;
esac
