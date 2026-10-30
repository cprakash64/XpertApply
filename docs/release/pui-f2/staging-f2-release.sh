#!/usr/bin/env bash
# F2 (automatic initial job scoring): STAGING release of aa5bc2f. API first, then web. Root, staging only.
#
# Staging runs the e4797e4 API (throttling + two-phase jobs list) and the 1df25f5 web, database at 0034_password_reset.
# THERE IS NO MIGRATION in this release (the candidate's only Alembic head is still 0034); this script never runs alembic against the
# database. Only `xpertapply-staging-api` and then `xpertapply-staging-web` are recreated. The worker and scheduler are not touched.
#
#   sudo bash staging-f2-release.sh preflight       # READ-ONLY: images, state, approved dry runs, snapshot
#   sudo bash staging-f2-release.sh pin-rollback    # adds TWO alias tags to the images staging runs today; nothing else
#   sudo XA_STAGING_APPROVED=yes-aa5bc2fa bash staging-f2-release.sh api          # recreate ONLY xpertapply-staging-api
#   sudo XA_STAGING_APPROVED=yes-aa5bc2fa bash staging-f2-release.sh web          # recreate ONLY xpertapply-staging-web (needs the API first)
#   sudo bash staging-f2-release.sh verify          # READ-ONLY checks plus a harmless throttle probe (unknown address, creates no account)
#   sudo XA_STAGING_APPROVED=yes-aa5bc2fa bash staging-f2-release.sh rollback-web | rollback-api     # web first, then API
#
# What runs today is identified by layer fingerprint and revision label (a loaded image has a host-specific ID that was not known when
# this was written); pin-rollback tags exactly those images. Candidates are likewise identified by fingerprint and revision label.
# No compose down, no volume/image/container removal, no prune, pull or build, no nginx, production, VeoTrex, PostgreSQL, Redis config
# or SMTP. Prints names, ids and pass/fail only.
set -uo pipefail
umask 077

EXPECT_HOST="srv738314"
REV="aa5bc2fa3cd943cdba53dbb475554eee6178a399"; APPROVAL="yes-${REV:0:8}"
NEW_API="xpertapply-api:f2-aa5bc2f-amd64";             NEW_API_FP="87b53b0e0032b94198cb27fd08b73422d145bddff37510c5b84bb102ffd6a95b"
NEW_WEB="xpertapply-staging-web:f2-aa5bc2f-amd64";     NEW_WEB_FP="64f805646ad52c01571dea4b8d029d3016e2492d40abe695c8728432697a1c1a"
# What staging runs today, and therefore what a rollback restores.
PREV_API_REV="e4797e4d9e27dbed253e312462c4db081197fd2d"; PREV_API_FP="56a016d22de6cacf1c273b988511f331aa97f0c35e22c72ad1db4530de1cb6e5"
PREV_WEB_REV="1df25f52bf81af02282e52be3e9505a1cfa4b665"; PREV_WEB_FP="524f869837ed4dc2a2888687d609448a281b709b09a18c5b137590c2e3dda4d3"
RB_API="xpertapply-staging-rollback:api-e4797e4";      RB_WEB="xpertapply-staging-rollback:web-1df25f5"
DRYRUN_SHA="93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39"
NOINDEX_SHA="832507de0449aae84b8cead8194806442326e95417cb9d335ec66ec6433f2ae6"
INFRA="${INFRA:-/home/xpertapply/apps/staging/infra/staging}"
API_OVR="${API_OVR:-/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
DRYRUN="${DRYRUN:-/home/luna/xpertapply-pui01/staging-release-dryrun.sh}"
NOINDEX_VALIDATOR="${NOINDEX_VALIDATOR:-/home/luna/xpertapply-pui01/nginx-noindex/validate-staging-noindex.sh}"
STATE="/root/pui-f2"
PROTECTED_RE='^(xpertapply-(api|web|worker|scheduler|postgres|redis)-1|xpertapply-staging-(postgres|redis|worker|scheduler)|veotrex-.*)$'

say(){ printf '%s\n' "$*"; }; ok(){ printf 'PASS  %s\n' "$*"; }; info(){ printf 'INFO  %s\n' "$*"; }
stop(){ printf 'STOP  %s\n' "$*" >&2; exit 1; }
CLEAN=(env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
mode="${1:-}"
case "$mode" in preflight|pin-rollback|api|web|verify|rollback-api|rollback-web) ;; *) stop "usage: $0 preflight|pin-rollback|api|web|verify|rollback-api|rollback-web";; esac
[[ "$(id -u)" == 0 ]] || stop "run with sudo"
[[ "$(hostname)" == "$EXPECT_HOST" ]] || stop "wrong host $(hostname)"
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || stop "DOCKER_HOST/DOCKER_CONTEXT is set"
[[ "$("${CLEAN[@]}" docker context show)" == default ]] || stop "docker context is not default"
for f in "$INFRA/compose.staging.yml" "$INFRA/.env.staging" "$API_OVR" "$DRYRUN"; do [[ -f "$f" ]] || stop "missing $f"; done
case "$mode" in api|web|rollback-api|rollback-web) [[ "${XA_STAGING_APPROVED:-}" == "$APPROVAL" ]] || stop "founder approval not given: set XA_STAGING_APPROVED=$APPROVAL only after approval";; esac
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
need_new(){ need_fp "$NEW_API" "$NEW_API_FP" "$REV" "candidate API"; NEW_API_ID="$(img_id "$NEW_API")"; ok "candidate API host image id $NEW_API_ID"
            need_fp "$NEW_WEB" "$NEW_WEB_FP" "$REV" "candidate web"; NEW_WEB_ID="$(img_id "$NEW_WEB")"; ok "candidate web host image id $NEW_WEB_ID"; }
validate_lib(){ [[ "$(sha256sum "$DRYRUN" | cut -d' ' -f1)" == "$DRYRUN_SHA" ]] || stop "dry-run script is not the approved version"; XA_DRYRUN_SOURCE_ONLY=1 source "$DRYRUN"; set +u; }
override(){ printf 'services:\n  %s:\n    image: %s\n' "$1" "$2" > "$WORK/$1.yml"; echo "$WORK/$1.yml"; }
others_unchanged(){ diff <(awk -v a="$1" '$1!=a' "$WORK/step.before") <(snap | awk -v a="$1" '$1!=a') >/dev/null \
  && ok "every other container name, id and image is unchanged since this step began" || stop "another container changed during this step"; }
wait_up(){ local c="$1" i s; for i in $(seq 1 40); do s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)"; [[ "$s" == healthy || "$s" == running ]] && { ok "$c is $s"; return 0; }; sleep 3; done; return 1; }
db_rev(){ docker exec xpertapply-staging-api alembic current 2>/dev/null | tail -1; }
base_state(){ # what must hold before ANY change
  [[ "$(db_rev)" == "0034_password_reset (head)" ]] && ok "staging database is at 0034_password_reset (this release applies no migration)" || stop "database revision is '$(db_rev)'"
  [[ "$(docker exec xpertapply-staging-api printenv RUN_MIGRATIONS_ON_STARTUP 2>/dev/null | head -1)" == "false" ]] && ok "startup migrations are off" || stop "RUN_MIGRATIONS_ON_STARTUP is not false"
  [[ -z "$(docker exec xpertapply-staging-api printenv EMAIL_BACKEND 2>/dev/null | head -1)" ]] && ok "password-reset email stays disabled (EMAIL_BACKEND unset)" || stop "EMAIL_BACKEND is set on staging"
  curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "staging API healthy" || stop "staging API health failed"
}
# A POST without a token reaches the new route and is refused with 401; the previous API has no such route (404 or 405).
new_route(){ [[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$1/jobs/scoring/advance")" == 401 ]]; }
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
# The candidate web's chunks carry the scoring notice, the match-score panel and the new search placeholder; the 1df25f5 web lacks the first.
serves_new_web(){
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
step_service(){ # $1 api|web  $2 candidate ref  $3 candidate id  $4 expected CURRENT fingerprint  $5 expected CURRENT revision
  local svc="$1" cname="xpertapply-staging-$1" o rc cid prof=()
  validate_lib; need_new
  need_fp "$(running_img "$cname")" "$4" "$5" "$cname currently running"
  base_state; snap > "$WORK/step.before"
  [[ "$svc" == web ]] && prof=(--profile web)
  o="$(override "$svc" "$2")"; cid="$(docker inspect -f '{{.Id}}' "$cname" | cut -c1-12)"
  docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' "$cname" > "$WORK/mounts.before"
  dc -f "$o" ${prof[@]+"${prof[@]}"} up --dry-run -d --no-deps --no-build --pull never "$svc" > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run "$svc" "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only $cname"
  dc -f "$o" ${prof[@]+"${prof[@]}"} up -d --no-deps --no-build --pull never "$svc" || stop "compose up failed; run rollback-$svc"
  [[ "$(running_img "$cname")" == "$3" ]] && ok "$cname now runs $3" || stop "$cname is not on the candidate; run rollback-$svc"
  [[ "$(docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' "$cname")" == "$(cat "$WORK/mounts.before")" ]] && ok "$cname kept exactly the same volumes" || stop "volumes changed; run rollback-$svc"
  wait_up "$cname" || stop "$cname did not become healthy; run rollback-$svc"
}
step_rollback(){ # $1 api|web  $2 alias tag  $3 expected fingerprint  $4 expected revision
  local svc="$1" cname="xpertapply-staging-$1" o prof=()
  need_fp "$2" "$3" "$4" "rollback alias $2"; [[ "$svc" == web ]] && prof=(--profile web); snap > "$WORK/step.before"; o="$(override "$svc" "$2")"
  dc -f "$o" ${prof[@]+"${prof[@]}"} up -d --no-deps --no-build --pull never "$svc" || stop "rollback compose up failed"
  [[ "$(running_img "$cname")" == "$(img_id "$2")" ]] && ok "$cname is back on $2" || stop "$cname is not on $2"
  wait_up "$cname" || stop "$cname not healthy after rollback"; others_unchanged "$cname"
  say "NOTE: the database was NOT touched. This release made no schema change, so no restore is involved."
}

case "$mode" in
preflight)
  validate_lib; need_new
  need_fp "$(running_img xpertapply-staging-api)" "$PREV_API_FP" "$PREV_API_REV" "staging API currently running"
  need_fp "$(running_img xpertapply-staging-web)" "$PREV_WEB_FP" "$PREV_WEB_REV" "staging web currently running"
  base_state
  h="$(docker run --rm --network none --read-only --cap-drop ALL --entrypoint alembic "$NEW_API" heads 2>&1 | tail -1)"
  [[ "$h" == "0034_password_reset (head)" ]] && ok "candidate API head is 0034_password_reset: no migration" || stop "candidate API head is '$h'"
  docker run --rm --network none --entrypoint python "$NEW_API" -c "import app.services.auth_throttle, app.main; from app.routes import jobs; from app.jobs import initial_scoring; assert not {'description_raw','raw_json','responsibilities'} & {c.key for c in jobs._LIST_COLUMNS}" >/dev/null 2>&1 \
    && ok "candidate API contains the throttle, the two-phase list and the initial-scoring module, and imports cleanly" || stop "candidate API does not import or lacks the expected code"
  snap > "$STATE/before.containers.txt"; ok "container snapshot saved ($(wc -l < "$STATE/before.containers.txt") containers)"
  say "-- scope check: compose dry runs for ONLY the api and ONLY the web (read-only) --"
  for svc in api web; do
    [[ "$svc" == api ]] && { img="$NEW_API"; prof=(); } || { img="$NEW_WEB"; prof=(--profile web); }
    o="$(override "$svc" "$img")"; cid="$(docker inspect -f '{{.Id}}' "xpertapply-staging-$svc" | cut -c1-12)"
    dc -f "$o" ${prof[@]+"${prof[@]}"} up --dry-run -d --no-deps --no-build --pull never "$svc" > "$WORK/dry.$svc" 2>&1; rc=$?; cat "$WORK/dry.$svc"
    r="$(validate_dry_run "$svc" "$WORK/dry.$svc" "$rc" "$cid")" || stop "$svc dry run rejected: $r"; ok "$svc dry run touches only xpertapply-staging-$svc"
  done
  say "PREFLIGHT PASS (nothing was changed)" ;;
pin-rollback)
  need_fp "$(running_img xpertapply-staging-api)" "$PREV_API_FP" "$PREV_API_REV" "staging API currently running"
  need_fp "$(running_img xpertapply-staging-web)" "$PREV_WEB_FP" "$PREV_WEB_REV" "staging web currently running"
  docker tag "$(running_img xpertapply-staging-api)" "$RB_API"; docker tag "$(running_img xpertapply-staging-web)" "$RB_WEB"
  need_fp "$RB_API" "$PREV_API_FP" "$PREV_API_REV" "rollback alias $RB_API"; need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB"
  ok "alias tags added; no other change" ;;
api)
  need_fp "$RB_API" "$PREV_API_FP" "$PREV_API_REV" "rollback alias $RB_API"; need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB"
  validate_lib; need_new
  step_service api "$NEW_API" "$NEW_API_ID" "$PREV_API_FP" "$PREV_API_REV"
  docker exec xpertapply-staging-api python -c "import app.services.auth_throttle; from app.routes import jobs; from app.jobs import initial_scoring; jobs._LIST_COLUMNS" >/dev/null 2>&1 \
    && ok "the new API contains the throttle, the two-phase list and the initial-scoring module" || stop "new code missing; run rollback-api"
  [[ "$(db_rev)" == "0034_password_reset (head)" ]] && ok "the new API sees the database at its head 0034 (nothing to migrate)" || stop "database/API revision mismatch; run rollback-api"
  curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "https healthz" || stop "https health failed; run rollback-api"
  curl -fsS https://api-staging.xpertapply.com/auth/password-reset/availability | grep -q '"available":false' && ok "recovery still reports unavailable" || stop "availability is not false; run rollback-api"
  new_route https://api-staging.xpertapply.com && ok "POST /jobs/scoring/advance exists and refuses an unauthenticated call (401)" || stop "scoring route missing; run rollback-api"
  throttle_probe && ok "login throttling answers 429 with Retry-After for repeated wrong passwords" || stop "throttle probe failed; run rollback-api"
  others_unchanged xpertapply-staging-api ;;
web)
  need_fp "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" "rollback alias $RB_WEB"
  need_new
  [[ "$(running_img xpertapply-staging-api)" == "$NEW_API_ID" ]] || stop "run the api step first: the web needs the API's scoring endpoint"
  new_route https://api-staging.xpertapply.com || stop "the running API lacks the scoring route; do not release the web"
  step_service web "$NEW_WEB" "$NEW_WEB_ID" "$PREV_WEB_FP" "$PREV_WEB_REV"
  ok_http=""; for _ in $(seq 1 20); do curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3001/login && { ok_http=1; break; }; sleep 3; done
  [[ -n "$ok_http" ]] && ok "web answers on 127.0.0.1:3001" || stop "web did not answer; run rollback-web"
  serves_new_web http://127.0.0.1:3001 && ok "the new Jobs UI (scoring notice, match score, search) is served" || stop "new Jobs UI not found; run rollback-web"
  others_unchanged xpertapply-staging-web ;;
rollback-web) step_rollback web "$RB_WEB" "$PREV_WEB_FP" "$PREV_WEB_REV" ;;
rollback-api)
  [[ "$(running_img xpertapply-staging-web)" == "$(img_id "$RB_WEB")" ]] || info "NOTE: the web is not on its rollback image; roll the web back first (rollback-web), then the API"
  step_rollback api "$RB_API" "$PREV_API_FP" "$PREV_API_REV" ;;
verify)
  [[ -f "$STATE/before.containers.txt" ]] || stop "run preflight first"
  need_new; base_state
  [[ "$(running_img xpertapply-staging-api)" == "$NEW_API_ID" ]] && ok "staging API runs the aa5bc2f image" || stop "staging API is not on the candidate"
  [[ "$(running_img xpertapply-staging-web)" == "$NEW_WEB_ID" ]] && ok "staging web runs the aa5bc2f image" || stop "staging web is not on the candidate"
  for path in dashboard jobs tracker settings login; do [[ "$(curl -s -o /dev/null -w '%{http_code}' "https://staging.xpertapply.com/$path")" == 200 ]] && ok "https://staging.xpertapply.com/$path = 200" || stop "/$path not 200"; done
  serves_new_web https://staging.xpertapply.com && ok "the new Jobs UI is served publicly" || stop "new Jobs UI missing"
  for path in jobs "dashboard/summary" "auth/me"; do c="$(curl -s -o /dev/null -w '%{http_code}' "https://api-staging.xpertapply.com/$path")"; [[ "$c" == 401 || "$c" == 403 ]] && ok "unauthenticated /$path is refused ($c)" || stop "/$path answered $c"; done
  new_route https://api-staging.xpertapply.com && ok "scoring endpoint is live and authenticated" || stop "scoring endpoint missing"
  throttle_probe && ok "login throttling is active" || stop "throttle probe failed"
  [[ "$(sha256sum "$NOINDEX_VALIDATOR" | cut -d' ' -f1)" == "$NOINDEX_SHA" ]] || stop "noindex validator is not the reviewed one"
  bash "$NOINDEX_VALIDATOR" | grep -E "^(FAIL|PASS)" | sort | uniq -c | sed 's/^/      /'
  curl -fsS https://api.xpertapply.com/healthz >/dev/null && ok "production API healthy" || stop "production API unhealthy"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://xpertapply.com/)" == 200 ]] && ok "production web 200" || stop "production web not 200"
  snap | grep -E "$PROTECTED_RE" | diff - <(grep -E "$PROTECTED_RE" "$STATE/before.containers.txt") >/dev/null && ok "worker, scheduler, postgres, redis, production and veotrex containers are identical to the snapshot" || stop "a protected container differs from the snapshot" ;;
esac
