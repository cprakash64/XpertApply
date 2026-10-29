#!/usr/bin/env bash
# PUI-STG6: STAGING release of release candidate fb6475f (Dashboard, Jobs, Applications + server-side ranking). API then web. Root, staging only.
#
# Staging runs the 9dbf283 API and the b99125c web with the database at 0034_password_reset. THERE IS NO MIGRATION in this release
# (0034 is still the only head and 0035/0036 are byte-identical); this script never runs alembic against the database.
#
#   sudo bash staging-rc-release.sh preflight       # READ-ONLY: images, state, approved dry runs, snapshot
#   sudo bash staging-rc-release.sh pin-rollback    # adds TWO alias tags to the images staging runs today; nothing else
#   sudo XA_STAGING_APPROVED=yes-fb6475fb bash staging-rc-release.sh api          # recreate ONLY xpertapply-staging-api
#   sudo XA_STAGING_APPROVED=yes-fb6475fb bash staging-rc-release.sh web          # recreate ONLY xpertapply-staging-web
#   sudo bash staging-rc-release.sh verify          # READ-ONLY smoke checks
#   sudo XA_STAGING_APPROVED=yes-fb6475fb bash staging-rc-release.sh rollback-web | rollback-api
#
# No compose down, no volume/image/container removal, no prune, pull or build, no nginx, production, VeoTrex, PostgreSQL, Redis or SMTP.
# Prints names, ids and pass/fail only.
set -uo pipefail
umask 077

EXPECT_HOST="srv738314"
REV="fb6475fb6f42b6b365e227d2773f960b9e0499f7"; APPROVAL="yes-${REV:0:8}"
NEW_API="xpertapply-api:rc-fb6475f-amd64";          NEW_API_ID="sha256:cfefee8171251736c399fc95b6bb3ab2fe6d20f2517c55e4f9bf3f1a0dc9e90d"
NEW_WEB="xpertapply-staging-web:rc-fb6475f-amd64";  NEW_WEB_ID="sha256:49c1e73412b015747c3850bf240f411b704d99c85e40e1c73a9df2c51576fcea"
# What staging runs today, and therefore what a rollback restores.
PREV_API_TAG="xpertapply-api:pui-9dbf283-amd64";          PREV_API_ID="sha256:87c7226837b6133aadd3ffc72f88acb1119b0fca9c013f267b597d649bd83e55"
PREV_WEB_TAG="xpertapply-staging-web:pui-b99125c-amd64";  PREV_WEB_ID="sha256:55fa6bb761925c62021a5bbe88fe90c8a8ff48c89513c530eda50516881ddc46"
RB_API="xpertapply-staging-rollback:api-87c7226837b6";    RB_WEB="xpertapply-staging-rollback:web-55fa6bb76192"
DRYRUN_SHA="93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39"
NOINDEX_SHA="832507de0449aae84b8cead8194806442326e95417cb9d335ec66ec6433f2ae6"
INFRA="${INFRA:-/home/xpertapply/apps/staging/infra/staging}"
API_OVR="${API_OVR:-/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
DRYRUN="${DRYRUN:-/home/luna/xpertapply-pui01/staging-release-dryrun.sh}"
NOINDEX_VALIDATOR="${NOINDEX_VALIDATOR:-/home/luna/xpertapply-pui01/nginx-noindex/validate-staging-noindex.sh}"
STATE="/root/pui-stg6"
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
snap(){ docker ps -a --format '{{.Names}} {{.ID}} {{.Image}}' | sort; }
need_img(){ [[ "$(img_id "$1")" == "$2" ]] || stop "image $1 is '$(img_id "$1")', expected $2"; ok "$1 = $2"; }
need_rev(){ [[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1")" == "$REV" ]] && ok "$1 revision label $REV" || stop "$1 revision label mismatch"; [[ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$1")" == linux/amd64 ]] || stop "$1 is not linux/amd64"; }
validate_lib(){ [[ "$(sha256sum "$DRYRUN" | cut -d' ' -f1)" == "$DRYRUN_SHA" ]] || stop "dry-run script is not the approved version"; XA_DRYRUN_SOURCE_ONLY=1 source "$DRYRUN"; set +u; }
override(){ printf 'services:\n  %s:\n    image: %s\n' "$1" "$2" > "$WORK/$1.$3.yml"; echo "$WORK/$1.$3.yml"; }
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
step_service(){ # $1 api|web  $2 new image  $3 new id  $4 expected CURRENT id
  local svc="$1" cname="xpertapply-staging-$1" o rc cid prof=()
  validate_lib; need_img "$2" "$3"; need_rev "$2"
  [[ "$(docker inspect -f '{{.Image}}' "$cname")" == "$4" ]] || stop "$cname is not on the expected current image"
  base_state; snap > "$WORK/step.before"
  [[ "$svc" == web ]] && prof=(--profile web)
  o="$(override "$svc" "$2" new)"; cid="$(docker inspect -f '{{.Id}}' "$cname" | cut -c1-12)"
  docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' "$cname" > "$WORK/mounts.before"
  dc -f "$o" ${prof[@]+"${prof[@]}"} up --dry-run -d --no-deps --no-build --pull never "$svc" > "$WORK/dry" 2>&1; rc=$?; cat "$WORK/dry"
  r="$(validate_dry_run "$svc" "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only $cname"
  dc -f "$o" ${prof[@]+"${prof[@]}"} up -d --no-deps --no-build --pull never "$svc" || stop "compose up failed; run rollback-$svc"
  [[ "$(docker inspect -f '{{.Image}}' "$cname")" == "$3" ]] && ok "$cname now runs $3" || stop "$cname is not on the candidate image; run rollback-$svc"
  [[ "$(docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' "$cname")" == "$(cat "$WORK/mounts.before")" ]] && ok "$cname kept exactly the same volumes" || stop "volumes changed; run rollback-$svc"
  wait_up "$cname" || stop "$cname did not become healthy; run rollback-$svc"
}
step_rollback(){ # $1 api|web  $2 alias tag  $3 expected id
  local svc="$1" cname="xpertapply-staging-$1" o prof=()
  need_img "$2" "$3"; [[ "$svc" == web ]] && prof=(--profile web); snap > "$WORK/step.before"; o="$(override "$svc" "$2" rollback)"
  dc -f "$o" ${prof[@]+"${prof[@]}"} up -d --no-deps --no-build --pull never "$svc" || stop "rollback compose up failed"
  [[ "$(docker inspect -f '{{.Image}}' "$cname")" == "$3" ]] && ok "$cname is back on $3" || stop "$cname is not on $3"
  wait_up "$cname" || stop "$cname not healthy after rollback"; others_unchanged "$cname"
  say "NOTE: the database was NOT touched. This release made no schema change, so no restore is involved."
}

case "$mode" in
preflight)
  validate_lib
  need_img "$NEW_API" "$NEW_API_ID"; need_rev "$NEW_API"; need_img "$NEW_WEB" "$NEW_WEB_ID"; need_rev "$NEW_WEB"
  need_img "$PREV_API_TAG" "$PREV_API_ID"; need_img "$PREV_WEB_TAG" "$PREV_WEB_ID"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$PREV_API_ID" ]] && ok "staging API runs $PREV_API_ID" || stop "staging API is not on the expected image"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$PREV_WEB_ID" ]] && ok "staging web runs $PREV_WEB_ID" || stop "staging web is not on the expected image"
  base_state
  # The candidate API must know exactly the revision the database is at: one head, 0034, and nothing newer to apply.
  h="$(docker run --rm --network none --read-only --cap-drop ALL --entrypoint alembic "$NEW_API" heads 2>&1 | tail -1)"
  [[ "$h" == "0034_password_reset (head)" ]] && ok "candidate API head is 0034_password_reset: no migration" || stop "candidate API head is '$h'"
  snap > "$STATE/before.containers.txt"; ok "container snapshot saved ($(wc -l < "$STATE/before.containers.txt") containers)"
  say "-- scope check: compose dry runs for ONLY the api and ONLY the web (read-only) --"
  for svc in api web; do
    [[ "$svc" == api ]] && { img="$NEW_API"; prof=(); } || { img="$NEW_WEB"; prof=(--profile web); }
    o="$(override "$svc" "$img" new)"; cid="$(docker inspect -f '{{.Id}}' "xpertapply-staging-$svc" | cut -c1-12)"
    dc -f "$o" ${prof[@]+"${prof[@]}"} up --dry-run -d --no-deps --no-build --pull never "$svc" > "$WORK/dry.$svc" 2>&1; rc=$?; cat "$WORK/dry.$svc"
    r="$(validate_dry_run "$svc" "$WORK/dry.$svc" "$rc" "$cid")" || stop "$svc dry run rejected: $r"; ok "$svc dry run touches only xpertapply-staging-$svc"
  done
  say "PREFLIGHT PASS (nothing was changed)" ;;
pin-rollback)
  need_img "$PREV_API_TAG" "$PREV_API_ID"; need_img "$PREV_WEB_TAG" "$PREV_WEB_ID"
  docker tag "$PREV_API_ID" "$RB_API"; docker tag "$PREV_WEB_ID" "$RB_WEB"
  need_img "$RB_API" "$PREV_API_ID"; need_img "$RB_WEB" "$PREV_WEB_ID"; ok "alias tags added; no other change" ;;
api)
  need_img "$RB_API" "$PREV_API_ID"; need_img "$RB_WEB" "$PREV_WEB_ID"
  step_service api "$NEW_API" "$NEW_API_ID" "$PREV_API_ID"
  docker exec xpertapply-staging-api python -c "import app.jobs.ranking" >/dev/null 2>&1 && ok "the new API contains the ranking module" || stop "ranking module missing; run rollback-api"
  [[ "$(db_rev)" == "0034_password_reset (head)" ]] && ok "the new API sees the database at its head 0034 (nothing to migrate)" || stop "database/API revision mismatch; run rollback-api"
  curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "https healthz" || stop "https health failed; run rollback-api"
  curl -fsS https://api-staging.xpertapply.com/auth/password-reset/availability | grep -q '"available":false' && ok "recovery still reports unavailable" || stop "availability is not false; run rollback-api"
  others_unchanged xpertapply-staging-api ;;
web)
  need_img "$RB_WEB" "$PREV_WEB_ID"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$NEW_API_ID" ]] || stop "run the api step first: the web is released after the API"
  step_service web "$NEW_WEB" "$NEW_WEB_ID" "$PREV_WEB_ID"
  ok_http=""; for _ in $(seq 1 20); do curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3001/dashboard && { ok_http=1; break; }; sleep 3; done
  [[ -n "$ok_http" ]] && ok "web answers on 127.0.0.1:3001" || stop "web did not answer; run rollback-web"
  html="$(curl -fsS http://127.0.0.1:3001/tracker)" || stop "/tracker failed; run rollback-web"
  if grep -q "Your job search" <<<"$html"; then stop "the OLD Applications header is still served; run rollback-web"; fi
  ok "the Applications introduction is gone from the served page"
  curl -fsS http://127.0.0.1:3001/jobs -o /dev/null && ok "/jobs serves" || stop "/jobs failed; run rollback-web"
  others_unchanged xpertapply-staging-web ;;
rollback-api) step_rollback api "$RB_API" "$PREV_API_ID" ;;
rollback-web) step_rollback web "$RB_WEB" "$PREV_WEB_ID" ;;
verify)
  [[ -f "$STATE/before.containers.txt" ]] || stop "run preflight first"
  base_state
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$NEW_API_ID" ]] && ok "staging API runs the fb6475f image" || stop "staging API is not on the candidate"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$NEW_WEB_ID" ]] && ok "staging web runs the fb6475f image" || stop "staging web is not on the candidate"
  for path in dashboard jobs tracker settings; do [[ "$(curl -s -o /dev/null -w '%{http_code}' "https://staging.xpertapply.com/$path")" == 200 ]] && ok "https://staging.xpertapply.com/$path = 200" || stop "/$path did not return 200"; done
  for path in jobs "dashboard/summary"; do c="$(curl -s -o /dev/null -w '%{http_code}' "https://api-staging.xpertapply.com/$path")"; [[ "$c" == 401 || "$c" == 403 ]] && ok "unauthenticated /$path is refused ($c)" || stop "unauthenticated /$path returned $c"; done
  [[ "$(sha256sum "$NOINDEX_VALIDATOR" | cut -d' ' -f1)" == "$NOINDEX_SHA" ]] || stop "noindex validator is not the reviewed one"
  bash "$NOINDEX_VALIDATOR" | grep -E "^(FAIL|PASS)" | sort | uniq -c | sed 's/^/      /'
  curl -fsS https://api.xpertapply.com/healthz >/dev/null && ok "production API healthy" || stop "production API unhealthy"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://xpertapply.com/)" == 200 ]] && ok "production web 200" || stop "production web not 200"
  snap | grep -E "$PROTECTED_RE" | diff - <(grep -E "$PROTECTED_RE" "$STATE/before.containers.txt") >/dev/null && ok "postgres, redis, production and veotrex containers are identical to the snapshot" || stop "a protected container differs from the snapshot" ;;
esac
