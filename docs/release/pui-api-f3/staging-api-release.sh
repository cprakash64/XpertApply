#!/usr/bin/env bash
# API-ONLY refresh of staging: login/signup throttling (6d3a8e7) + two-phase GET /jobs (F3/F5 fix, e4797e4). Root, staging only.
#
# Staging runs the fb6475f API and the 1df25f5 web, database at 0034_password_reset. THERE IS NO MIGRATION in this release (the candidate's
# only Alembic head is still 0034); this script never runs alembic against the database. Only `xpertapply-staging-api` is recreated. The
# worker and scheduler keep their current image on purpose: both changes live only in API request handlers (/auth/login, /auth/signup, GET /jobs).
#
#   sudo bash staging-api-release.sh preflight      # READ-ONLY: image, state, approved dry run, snapshot
#   sudo bash staging-api-release.sh pin-rollback   # adds ONE alias tag to the API image staging runs today; nothing else
#   sudo XA_STAGING_APPROVED=yes-e4797e4d bash staging-api-release.sh api          # recreate ONLY xpertapply-staging-api
#   sudo bash staging-api-release.sh verify         # READ-ONLY checks plus a harmless throttle probe (unknown address, creates no account)
#   sudo XA_STAGING_APPROVED=yes-e4797e4d bash staging-api-release.sh rollback-api   # back to the fb6475f API image
#
# No compose down, no volume/image/container removal, no prune, pull or build, no nginx, production, VeoTrex, PostgreSQL, Redis config or SMTP.
# The candidate is identified by its layer fingerprint (identical on every host) and revision label, because a loaded image gets a
# host-specific ID; preflight prints that ID and `api` enforces it. Prints names, ids and pass/fail only.
set -uo pipefail
umask 077

EXPECT_HOST="srv738314"
REV="e4797e4d9e27dbed253e312462c4db081197fd2d"; APPROVAL="yes-${REV:0:8}"
NEW_API="xpertapply-api:api-e4797e4-amd64"
NEW_API_FP="56a016d22de6cacf1c273b988511f331aa97f0c35e22c72ad1db4530de1cb6e5"       # sha256 over the ordered RootFS layer ids; identical locally and on the host
# What staging runs today (the fb6475f release candidate), and therefore what a rollback restores.
PREV_API_TAG="xpertapply-api:rc-fb6475f-amd64"; PREV_API_ID="sha256:cfefee8171251736c399fc95b6bb3ab2fe6d20f2517c55e4f9bf3f1a0dc9e90d"
RB_API="xpertapply-staging-rollback:api-cfefee817125"
DRYRUN_SHA="93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39"
NOINDEX_SHA="832507de0449aae84b8cead8194806442326e95417cb9d335ec66ec6433f2ae6"
INFRA="${INFRA:-/home/xpertapply/apps/staging/infra/staging}"
API_OVR="${API_OVR:-/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
DRYRUN="${DRYRUN:-/home/luna/xpertapply-pui01/staging-release-dryrun.sh}"
NOINDEX_VALIDATOR="${NOINDEX_VALIDATOR:-/home/luna/xpertapply-pui01/nginx-noindex/validate-staging-noindex.sh}"
STATE="/root/pui-api-f3"
PROTECTED_RE='^(xpertapply-(api|web|worker|scheduler|postgres|redis)-1|xpertapply-staging-(postgres|redis|worker|scheduler|web)|veotrex-.*)$'

say(){ printf '%s\n' "$*"; }; ok(){ printf 'PASS  %s\n' "$*"; }; info(){ printf 'INFO  %s\n' "$*"; }
stop(){ printf 'STOP  %s\n' "$*" >&2; exit 1; }
CLEAN=(env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
mode="${1:-}"
case "$mode" in preflight|pin-rollback|api|verify|rollback-api) ;; *) stop "usage: $0 preflight|pin-rollback|api|verify|rollback-api";; esac
[[ "$(id -u)" == 0 ]] || stop "run with sudo"
[[ "$(hostname)" == "$EXPECT_HOST" ]] || stop "wrong host $(hostname)"
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || stop "DOCKER_HOST/DOCKER_CONTEXT is set"
[[ "$("${CLEAN[@]}" docker context show)" == default ]] || stop "docker context is not default"
for f in "$INFRA/compose.staging.yml" "$INFRA/.env.staging" "$API_OVR" "$DRYRUN"; do [[ -f "$f" ]] || stop "missing $f"; done
case "$mode" in api|rollback-api) [[ "${XA_STAGING_APPROVED:-}" == "$APPROVAL" ]] || stop "founder approval not given: set XA_STAGING_APPROVED=$APPROVAL only after approval";; esac
mkdir -p "$STATE"; chmod 700 "$STATE"; WORK="$(mktemp -d "$STATE/work.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

dc(){ "${CLEAN[@]}" docker compose --project-name xpertapply-staging --project-directory "$INFRA" --env-file "$INFRA/.env.staging" \
        -f "$INFRA/compose.staging.yml" -f "$API_OVR" "$@"; }
img_id(){ docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
img_fp(){ docker image inspect -f '{{json .RootFS.Layers}}' "$1" 2>/dev/null | sha256sum | cut -d' ' -f1; }
snap(){ docker ps -a --format '{{.Names}} {{.ID}} {{.Image}}' | sort; }
need_img(){ [[ "$(img_id "$1")" == "$2" ]] || stop "image $1 is '$(img_id "$1")', expected $2"; ok "$1 = $2"; }
need_new(){
  [[ -n "$(img_id "$NEW_API")" ]] || stop "candidate image $NEW_API is not loaded on this host"
  [[ "$(img_fp "$NEW_API")" == "$NEW_API_FP" ]] && ok "candidate layer fingerprint $NEW_API_FP" || stop "candidate layer fingerprint mismatch"
  [[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NEW_API")" == "$REV" ]] && ok "revision label $REV" || stop "revision label mismatch"
  [[ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$NEW_API")" == linux/amd64 ]] && ok "linux/amd64" || stop "platform mismatch"
  NEW_API_ID="$(img_id "$NEW_API")"; ok "candidate host image id $NEW_API_ID"
}
validate_lib(){ [[ "$(sha256sum "$DRYRUN" | cut -d' ' -f1)" == "$DRYRUN_SHA" ]] || stop "dry-run script is not the approved version"; XA_DRYRUN_SOURCE_ONLY=1 source "$DRYRUN"; set +u; }
api_override(){ printf 'services:\n  api:\n    image: %s\n' "$1" > "$WORK/api.yml"; echo "$WORK/api.yml"; }
others_unchanged(){ diff <(awk '$1!="xpertapply-staging-api"' "$WORK/step.before") <(snap | awk '$1!="xpertapply-staging-api"') >/dev/null \
  && ok "every other container name, id and image is unchanged since this step began" || stop "another container changed during this step"; }
wait_up(){ local c="$1" i s; for i in $(seq 1 40); do s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)"; [[ "$s" == healthy || "$s" == running ]] && { ok "$c is $s"; return 0; }; sleep 3; done; return 1; }
db_rev(){ docker exec xpertapply-staging-api alembic current 2>/dev/null | tail -1; }
base_state(){ # what must hold before ANY change
  [[ "$(db_rev)" == "0034_password_reset (head)" ]] && ok "staging database is at 0034_password_reset (this release applies no migration)" || stop "database revision is '$(db_rev)'"
  [[ "$(docker exec xpertapply-staging-api printenv RUN_MIGRATIONS_ON_STARTUP 2>/dev/null | head -1)" == "false" ]] && ok "startup migrations are off" || stop "RUN_MIGRATIONS_ON_STARTUP is not false"
  [[ -z "$(docker exec xpertapply-staging-api printenv EMAIL_BACKEND 2>/dev/null | head -1)" ]] && ok "password-reset email stays disabled (EMAIL_BACKEND unset)" || stop "EMAIL_BACKEND is set on staging"
  curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "staging API healthy" || stop "staging API health failed"
}
# Unknown address, never an account: counts attempts in Redis for a random hashed key, creates nothing in PostgreSQL.
throttle_probe(){
  local email="xa-throttle-probe-$(date +%s)-$RANDOM@example.com" i code first429="" ra=""
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -D "$WORK/h" -w '%{http_code}' -X POST https://api-staging.xpertapply.com/auth/login -H 'content-type: application/json' \
            -d "{\"email\":\"$email\",\"password\":\"definitely-wrong-probe\"}")"
    if [[ "$code" == 429 ]]; then first429="$i"; ra="$(grep -i '^retry-after:' "$WORK/h" | tr -d '\r' | awk '{print $2}')"; break; fi
    [[ "$code" == 401 ]] || { say "probe attempt $i returned $code"; return 1; }
  done
  [[ -n "$first429" ]] || { say "no 429 within 30 attempts"; return 1; }
  [[ "${ra:-0}" -gt 0 ]] || { say "429 without a Retry-After header"; return 1; }
  info "throttle probe: attempts 1..$((first429-1)) returned 401, attempt $first429 returned 429 (Retry-After ${ra}s)"
  return 0
}

case "$mode" in
preflight)
  validate_lib; need_new; need_img "$PREV_API_TAG" "$PREV_API_ID"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$PREV_API_ID" ]] && ok "staging API runs $PREV_API_ID" || stop "staging API is not on the expected image"
  base_state
  h="$(docker run --rm --network none --read-only --cap-drop ALL --entrypoint alembic "$NEW_API" heads 2>&1 | tail -1)"
  [[ "$h" == "0034_password_reset (head)" ]] && ok "candidate API head is 0034_password_reset: no migration" || stop "candidate API head is '$h'"
  docker run --rm --network none --entrypoint python "$NEW_API" -c "import app.services.auth_throttle, app.main; from app.routes import jobs; assert not {'description_raw','raw_json','responsibilities'} & {c.key for c in jobs._LIST_COLUMNS}" >/dev/null 2>&1 && ok "candidate contains the throttle module and the two-phase jobs list, and imports cleanly" || stop "candidate does not import or lacks the two-phase list"
  snap > "$STATE/before.containers.txt"; ok "container snapshot saved ($(wc -l < "$STATE/before.containers.txt") containers)"
  say "-- scope check: compose dry run for ONLY the api with the candidate image (read-only) --"
  o="$(api_override "$NEW_API")"; cid="$(docker inspect -f '{{.Id}}' xpertapply-staging-api | cut -c1-12)"
  dc -f "$o" up --dry-run -d --no-deps --no-build --pull never api > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run api "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only xpertapply-staging-api"
  say "PREFLIGHT PASS (nothing was changed)" ;;
pin-rollback)
  need_img "$PREV_API_TAG" "$PREV_API_ID"; docker tag "$PREV_API_ID" "$RB_API"; need_img "$RB_API" "$PREV_API_ID"; ok "alias tag added; no other change" ;;
api)
  validate_lib; need_new; need_img "$RB_API" "$PREV_API_ID"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$PREV_API_ID" ]] || stop "staging API is not on the expected current image"
  base_state; snap > "$WORK/step.before"
  o="$(api_override "$NEW_API")"; cid="$(docker inspect -f '{{.Id}}' xpertapply-staging-api | cut -c1-12)"
  docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' xpertapply-staging-api > "$WORK/mounts.before"
  dc -f "$o" up --dry-run -d --no-deps --no-build --pull never api > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run api "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only xpertapply-staging-api"
  dc -f "$o" up -d --no-deps --no-build --pull never api || stop "compose up failed; run rollback-api"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$NEW_API_ID" ]] && ok "xpertapply-staging-api now runs $NEW_API_ID" || stop "API is not on the candidate; run rollback-api"
  [[ "$(docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' xpertapply-staging-api)" == "$(cat "$WORK/mounts.before")" ]] && ok "API kept exactly the same volumes" || stop "volumes changed; run rollback-api"
  wait_up xpertapply-staging-api || stop "API did not become healthy; run rollback-api"
  docker exec xpertapply-staging-api python -c "import app.services.auth_throttle; from app.routes import jobs; jobs._LIST_COLUMNS" >/dev/null 2>&1 && ok "the new API contains the throttle module and the two-phase jobs list" || stop "new code missing; run rollback-api"
  [[ "$(db_rev)" == "0034_password_reset (head)" ]] && ok "the new API sees the database at its head 0034 (nothing to migrate)" || stop "database/API revision mismatch; run rollback-api"
  curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "https healthz" || stop "https health failed; run rollback-api"
  curl -fsS https://api-staging.xpertapply.com/auth/password-reset/availability | grep -q '"available":false' && ok "recovery still reports unavailable" || stop "availability is not false; run rollback-api"
  throttle_probe && ok "login throttling answers 429 with Retry-After for repeated wrong passwords" || stop "throttle probe failed; run rollback-api"
  others_unchanged ;;
rollback-api)
  need_img "$RB_API" "$PREV_API_ID"; snap > "$WORK/step.before"; o="$(api_override "$RB_API")"
  dc -f "$o" up -d --no-deps --no-build --pull never api || stop "rollback compose up failed"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$PREV_API_ID" ]] && ok "xpertapply-staging-api is back on $PREV_API_ID" || stop "API is not on $PREV_API_ID"
  wait_up xpertapply-staging-api || stop "API not healthy after rollback"; others_unchanged
  say "NOTE: the database was NOT touched. This release made no schema change, so no restore is involved. Throttle counters left in Redis (xa:auththrottle:*) expire on their own." ;;
verify)
  [[ -f "$STATE/before.containers.txt" ]] || stop "run preflight first"
  need_new; base_state
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$NEW_API_ID" ]] && ok "staging API runs the e4797e4 image" || stop "staging API is not on the candidate"
  for path in dashboard jobs tracker settings login; do [[ "$(curl -s -o /dev/null -w '%{http_code}' "https://staging.xpertapply.com/$path")" == 200 ]] && ok "https://staging.xpertapply.com/$path = 200" || stop "/$path not 200"; done
  for path in jobs "dashboard/summary" "auth/me"; do c="$(curl -s -o /dev/null -w '%{http_code}' "https://api-staging.xpertapply.com/$path")"; [[ "$c" == 401 || "$c" == 403 ]] && ok "unauthenticated /$path is refused ($c)" || stop "/$path answered $c"; done
  throttle_probe && ok "login throttling is active" || stop "throttle probe failed"
  [[ "$(sha256sum "$NOINDEX_VALIDATOR" | cut -d' ' -f1)" == "$NOINDEX_SHA" ]] || stop "noindex validator is not the reviewed one"
  bash "$NOINDEX_VALIDATOR" | grep -E "^(FAIL|PASS)" | sort | uniq -c | sed 's/^/      /'
  curl -fsS https://api.xpertapply.com/healthz >/dev/null && ok "production API healthy" || stop "production API unhealthy"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://xpertapply.com/)" == 200 ]] && ok "production web 200" || stop "production web not 200"
  snap | grep -E "$PROTECTED_RE" | diff - <(grep -E "$PROTECTED_RE" "$STATE/before.containers.txt") >/dev/null && ok "web, worker, scheduler, postgres, redis, production and veotrex containers are identical to the snapshot" || stop "a protected container differs from the snapshot" ;;
esac
