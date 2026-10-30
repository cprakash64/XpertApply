#!/usr/bin/env bash
# PUI-JOBS-FINAL: web-ONLY refresh of staging to the Jobs match-score panel + navigation (1df25f5). Root, staging only.
#
# Staging already runs the fb6475f API and the fb6475f web (database at 0034_password_reset, no migration in this release).
# This replaces ONLY the web. It never touches the API, the database, nginx, production, VeoTrex or SMTP.
#
#   sudo bash staging-web-final-release.sh preflight      # READ-ONLY: image, health, state, approved dry run, snapshot
#   sudo bash staging-web-final-release.sh pin-rollback   # adds ONE alias tag to the web image staging runs today (no other change)
#   sudo XA_STAGING_APPROVED=yes-1df25f52 bash staging-web-final-release.sh web           # recreate ONLY xpertapply-staging-web
#   sudo bash staging-web-final-release.sh verify         # READ-ONLY smoke checks
#   sudo XA_STAGING_APPROVED=yes-1df25f52 bash staging-web-final-release.sh rollback-web  # back to the fb6475f web image
#
# The candidate image is identified by its layer fingerprint (identical on every host) and its revision label, because a loaded
# image gets a host-specific image ID. The ID it receives on this host is printed by preflight and then enforced by `web`.
# No migration, no API change, no compose down, no volume/image removal, no prune, no pull, no build, no nginx, no production,
# no VeoTrex, no PostgreSQL/Redis, no SMTP. Prints names, ids and pass/fail only.
set -uo pipefail
umask 077

EXPECT_HOST="srv738314"
REV="1df25f52bf81af02282e52be3e9505a1cfa4b665"; APPROVAL="yes-${REV:0:8}"
NEW_WEB="xpertapply-staging-web:final-1df25f5-amd64"
NEW_WEB_FP="524f869837ed4dc2a2888687d609448a281b709b09a18c5b137590c2e3dda4d3"       # sha256 over the ordered RootFS layer diff IDs; identical locally and on the host
# What staging runs today (the fb6475f release candidate), and therefore what a rollback restores.
PREV_WEB_TAG="xpertapply-staging-web:rc-fb6475f-amd64"; PREV_WEB_ID="sha256:49c1e73412b015747c3850bf240f411b704d99c85e40e1c73a9df2c51576fcea"
RB_WEB="xpertapply-staging-rollback:web-49c1e73412b0"
API_ID="sha256:cfefee8171251736c399fc95b6bb3ab2fe6d20f2517c55e4f9bf3f1a0dc9e90d"
DRYRUN_SHA="93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39"
NOINDEX_SHA="832507de0449aae84b8cead8194806442326e95417cb9d335ec66ec6433f2ae6"
INFRA="${INFRA:-/home/xpertapply/apps/staging/infra/staging}"
API_OVR="${API_OVR:-/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
DRYRUN="${DRYRUN:-/home/luna/xpertapply-pui01/staging-release-dryrun.sh}"
NOINDEX_VALIDATOR="${NOINDEX_VALIDATOR:-/home/luna/xpertapply-pui01/nginx-noindex/validate-staging-noindex.sh}"
STATE="/root/pui-final"
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
snap(){ docker ps -a --format '{{.Names}} {{.ID}} {{.Image}}' | sort; }
need_img(){ [[ "$(img_id "$1")" == "$2" ]] || stop "image $1 is '$(img_id "$1")', expected $2"; ok "$1 = $2"; }
need_new(){
  [[ -n "$(img_id "$NEW_WEB")" ]] || stop "candidate image $NEW_WEB is not loaded on this host"
  [[ "$(img_fp "$NEW_WEB")" == "$NEW_WEB_FP" ]] && ok "candidate layer fingerprint $NEW_WEB_FP" || stop "candidate layer fingerprint mismatch"
  [[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NEW_WEB")" == "$REV" ]] && ok "revision label $REV" || stop "revision label mismatch"
  [[ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$NEW_WEB")" == linux/amd64 ]] && ok "linux/amd64" || stop "platform mismatch"
  NEW_WEB_ID="$(img_id "$NEW_WEB")"; ok "candidate host image id $NEW_WEB_ID"
}
validate_lib(){ [[ "$(sha256sum "$DRYRUN" | cut -d' ' -f1)" == "$DRYRUN_SHA" ]] || stop "dry-run script is not the approved version"; XA_DRYRUN_SOURCE_ONLY=1 source "$DRYRUN"; set +u; }
web_override(){ printf 'services:\n  web:\n    image: %s\n' "$1" > "$WORK/web.yml"; echo "$WORK/web.yml"; }
others_unchanged(){ diff <(awk '$1!="xpertapply-staging-web"' "$WORK/step.before") <(snap | awk '$1!="xpertapply-staging-web"') >/dev/null \
  && ok "every other container name, id and image is unchanged since this step began" || stop "another container changed during this step"; }
common_state(){
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$API_ID" ]] && ok "staging API runs the fb6475f image (untouched by this step)" || stop "staging API is not on the expected image"
  [[ "$(docker exec xpertapply-staging-api alembic current 2>/dev/null | tail -1)" == "0034_password_reset (head)" ]] && ok "staging database is at 0034_password_reset" || stop "staging database is not at 0034"
  curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "staging API healthy" || stop "staging API health failed"
  [[ "$(docker exec xpertapply-staging-api printenv EMAIL_BACKEND 2>/dev/null | head -1)" == "" ]] && ok "password-reset email stays disabled (EMAIL_BACKEND unset)" || stop "EMAIL_BACKEND is set on staging"
}
# The candidate's Jobs chunks carry the new search placeholder and the match-score panel; the fb6475f web has neither.
serves_new_nav(){
  local page chunk body a="" b=""
  page="$(curl -fsS "$1/jobs")" || return 1
  for chunk in $(printf '%s' "$page" | grep -oE '/_next/static/chunks/[^"]*\.js' | sort -u); do
    body="$(curl -fsS "$1$chunk" 2>/dev/null)" || continue
    printf '%s' "$body" | grep -q "Role, company or skill" && a=1
    printf '%s' "$body" | grep -q "Match score" && b=1
  done
  [[ -n "$a" && -n "$b" ]]
}

case "$mode" in
preflight)
  validate_lib
  need_new; need_img "$PREV_WEB_TAG" "$PREV_WEB_ID"
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
  validate_lib; need_new; need_img "$RB_WEB" "$PREV_WEB_ID"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$PREV_WEB_ID" ]] || stop "staging web is not on the expected current image"
  common_state; snap > "$WORK/step.before"
  o="$(web_override "$NEW_WEB")"; cid="$(docker inspect -f '{{.Id}}' xpertapply-staging-web | cut -c1-12)"
  dc -f "$o" --profile web up --dry-run -d --no-deps --no-build --pull never web > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run web "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only xpertapply-staging-web"
  dc -f "$o" --profile web up -d --no-deps --no-build --pull never web || stop "compose up failed; run rollback-web"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$NEW_WEB_ID" ]] && ok "xpertapply-staging-web now runs $NEW_WEB_ID" || stop "web is not on the new image; run rollback-web"
  ok_http=""; for _ in $(seq 1 20); do curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3001/login && { ok_http=1; break; }; sleep 3; done
  [[ -n "$ok_http" ]] && ok "web answers on 127.0.0.1:3001" || stop "web did not answer; run rollback-web"
  serves_new_nav http://127.0.0.1:3001 && ok "the new Jobs navigation and match-score panel are served" || stop "new Jobs UI not found; run rollback-web"
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
  need_new; common_state
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$NEW_WEB_ID" ]] && ok "staging web runs the 1df25f5 image" || stop "staging web is not on the new image"
  for route in dashboard jobs tracker settings login; do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "https://staging.xpertapply.com/$route")" == 200 ]] && ok "https://staging.xpertapply.com/$route = 200" || stop "$route route not 200"
  done
  serves_new_nav https://staging.xpertapply.com && ok "the new Jobs navigation and match-score panel are served publicly" || stop "new Jobs UI missing"
  curl -fsS https://api-staging.xpertapply.com/auth/password-reset/availability | grep -q '"available":false' && ok "recovery reports unavailable" || stop "availability is not false"
  [[ "$(sha256sum "$NOINDEX_VALIDATOR" | cut -d' ' -f1)" == "$NOINDEX_SHA" ]] || stop "noindex validator is not the reviewed one"
  bash "$NOINDEX_VALIDATOR" | grep -E "^(FAIL|PASS)" | sort | uniq -c | sed 's/^/      /'
  curl -fsS https://api.xpertapply.com/healthz >/dev/null && ok "production API healthy" || stop "production API unhealthy"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://xpertapply.com/)" == 200 ]] && ok "production web 200" || stop "production web not 200"
  snap | grep -E "$PROTECTED_RE" | diff - <(grep -E "$PROTECTED_RE" "$STATE/before.containers.txt") >/dev/null && ok "api, postgres, redis, production and veotrex containers are identical to the snapshot" || stop "a protected container differs from the snapshot" ;;
esac
