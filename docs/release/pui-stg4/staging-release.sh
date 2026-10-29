#!/usr/bin/env bash
# PUI-STG4: guarded, step-by-step STAGING release of the Premium UI (API + web + migration 0034). Root, staging only.
#
#   sudo bash staging-release.sh evidence       # READ-ONLY: proves volume/network/image identity and migration scope
#   sudo bash staging-release.sh preflight      # READ-ONLY: re-runs the approved dry-run script and records snapshots
#   sudo bash staging-release.sh pin-rollback   # adds immutable alias TAGS to the two rollback images (no other change)
#   sudo XA_STAGING_APPROVED=yes-9dbf2836 bash staging-release.sh migrate    # one-off alembic upgrade with the NEW image
#   sudo XA_STAGING_APPROVED=yes-9dbf2836 bash staging-release.sh api        # recreate ONLY xpertapply-staging-api
#   sudo XA_STAGING_APPROVED=yes-9dbf2836 bash staging-release.sh web        # recreate ONLY xpertapply-staging-web
#   sudo bash staging-release.sh verify         # READ-ONLY smoke checks
#   sudo XA_STAGING_APPROVED=yes-9dbf2836 bash staging-release.sh rollback-web | rollback-api
#
# Mutating modes (migrate, api, web, rollback-*) need the approval variable. Nothing here runs `compose down`, removes a
# volume, image or container by hand, prunes, pulls, builds, touches nginx, production, VeoTrex, PostgreSQL or Redis, or sets
# any SMTP/password-recovery variable. It prints environment NAMES and ids, never values.
set -uo pipefail
umask 077

# ---- pinned release facts ---------------------------------------------------------------------------------
EXPECT_HOST="srv738314"
REV="9dbf2836a6ffa374d6e626a368820fd79410ba78"; APPROVAL="yes-${REV:0:8}"
NEW_API="xpertapply-api:pui-9dbf283-amd64";          NEW_API_ID="sha256:87c7226837b6133aadd3ffc72f88acb1119b0fca9c013f267b597d649bd83e55"
NEW_WEB="xpertapply-staging-web:pui-9dbf283-amd64";  NEW_WEB_ID="sha256:fb51cfd76b1ae7ea8bd1b473ef59d6cb60d3935ae2332586cfb3d0d320a819cd"
OLD_API_TAG="xpertapply-api:nav02-gated-1516f23";            OLD_API_ID="sha256:436c05e7dff8eebf2edefef402d3194046050c4cffd5fbbb58e0ca679746b020"
OLD_WEB_TAG="xpertapply-staging-web:stage50d-cb76c3d";       OLD_WEB_ID="sha256:30651fdd2fa8520c6aaa61d809ed57e7eb362de1ad879bb7452e943d1d8a62ca"
RB_API="xpertapply-staging-rollback:api-436c05e7dff8";       RB_WEB="xpertapply-staging-rollback:web-30651fdd2fa8"
DRYRUN_SHA="93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39"
BACKUP="${BACKUP:-/home/luna/staging-backups/xpertapply-staging-pre-0034-20261029T053028Z.dump}"
BACKUP_SHA="5538b770193cf5f778dc3b5b75039fdf4f2cf4f8e05b2dd5ebbf31f0aa098af0"
INFRA="${INFRA:-/home/xpertapply/apps/staging/infra/staging}"
API_OVR="${API_OVR:-/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRYRUN="${DRYRUN:-/home/luna/xpertapply-pui01/staging-release-dryrun.sh}"
NOINDEX_VALIDATOR="${NOINDEX_VALIDATOR:-/home/luna/xpertapply-pui01/nginx-noindex/validate-staging-noindex.sh}"
NOINDEX_SHA="832507de0449aae84b8cead8194806442326e95417cb9d335ec66ec6433f2ae6"
STATE="/root/pui-stg4"   # root-only; holds snapshots and generated overrides
PROTECTED_RE='^(xpertapply-(api|web|worker|scheduler|postgres|redis)-1|xpertapply-staging-(postgres|redis|worker|scheduler)|veotrex-.*)$'

say(){ printf '%s\n' "$*"; }; ok(){ printf 'PASS  %s\n' "$*"; }; info(){ printf 'INFO  %s\n' "$*"; }
stop(){ printf 'STOP  %s\n' "$*" >&2; exit 1; }
CLEAN=(env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)

mode="${1:-}"
case "$mode" in evidence|preflight|pin-rollback|migrate|api|web|verify|rollback-web|rollback-api) ;; *) stop "usage: $0 evidence|preflight|pin-rollback|migrate|api|web|verify|rollback-web|rollback-api";; esac
[[ "$(id -u)" == 0 ]] || stop "run with sudo"
[[ "$(hostname)" == "$EXPECT_HOST" ]] || stop "wrong host $(hostname)"
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || stop "DOCKER_HOST/DOCKER_CONTEXT is set"
[[ "$("${CLEAN[@]}" docker context show)" == default ]] || stop "docker context is not default"
for f in "$INFRA/compose.staging.yml" "$INFRA/.env.staging" "$API_OVR" "$INFRA/staging_guard.py"; do [[ -f "$f" ]] || stop "missing $f"; done
case "$mode" in migrate|api|web|rollback-web|rollback-api) [[ "${XA_STAGING_APPROVED:-}" == "$APPROVAL" ]] || stop "founder approval not given: set XA_STAGING_APPROVED=$APPROVAL only after approval";; esac
mkdir -p "$STATE"; chmod 700 "$STATE"
WORK="$(mktemp -d "$STATE/work.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

dc(){ "${CLEAN[@]}" docker compose --project-name xpertapply-staging --project-directory "$INFRA" --env-file "$INFRA/.env.staging" \
        -f "$INFRA/compose.staging.yml" -f "$API_OVR" "$@"; }
img_id(){ docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
snap(){ docker ps -a --format '{{.Names}} {{.ID}} {{.Image}}' | sort; }
need_img(){ [[ "$(img_id "$1")" == "$2" ]] || stop "image $1 is '$(img_id "$1")', expected $2"; ok "$1 = $2"; }
ovr(){ printf 'services:\n  %s:\n    image: %s\n' "$1" "$2" > "$WORK/$1.$3.yml"; echo "$WORK/$1.$3.yml"; }
save_before(){ [[ -f "$STATE/before.containers.txt" ]] || snap > "$STATE/before.containers.txt"; snap > "$WORK/step.before"; }
others_unchanged(){ # $1 = the one container allowed to differ; compares with the snapshot taken at the START of this step
  diff <(awk -v c="$1" '$1!=c' "$WORK/step.before") <(snap | awk -v c="$1" '$1!=c') >/dev/null \
    && ok "every other container name, id and image is unchanged since this step began" || stop "another container changed during this step; compare $WORK/step.before with docker ps -a"
}
wait_healthy(){ local c="$1" i s; for i in $(seq 1 40); do s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)"; [[ "$s" == healthy || "$s" == running ]] && { ok "$c is $s"; return 0; }; sleep 3; done; return 1; }
need_backup(){ [[ "$(sha256sum "$BACKUP" | cut -d' ' -f1)" == "$BACKUP_SHA" ]] || stop "backup checksum mismatch"; ok "backup verified: $BACKUP"; }
db_rev(){ docker exec xpertapply-staging-api alembic current 2>/dev/null | tail -1; }
validate_lib(){ [[ "$(sha256sum "$DRYRUN" | cut -d' ' -f1)" == "$DRYRUN_SHA" ]] || stop "dry-run script is not the approved version"; XA_DRYRUN_SOURCE_ONLY=1 source "$DRYRUN"; set +u; }

# ============================================================================================================
evidence(){
  say "== A. Physical volumes, networks and project identity: rendered configuration vs running containers (NO values printed)"
  api_o="$(ovr api "$NEW_API" new)"; web_o="$(ovr web "$NEW_WEB" new)"
  dc -f "$api_o" -f "$web_o" --profile web --profile workers config --format json > "$WORK/new.json" || stop "candidate configuration does not render"
  python3 - "$WORK/new.json" <<'PY'
import json, subprocess, sys
cfg = json.load(open(sys.argv[1])); bad = 0
def chk(ok, msg):
    global bad; print(("PASS  " if ok else "FAIL  ") + msg); bad += (not ok)
def ins(kind, name):
    return json.loads(subprocess.check_output(["docker", kind, "inspect", name]))[0]
chk(cfg.get("name") == "xpertapply-staging", "compose project name is xpertapply-staging")
tv = {k: (v or {}) for k, v in cfg.get("volumes", {}).items()}
print("INFO  rendered top-level volumes:", {k: v.get("name") for k, v in tv.items()})
chk(all(v.get("name", "").startswith("xpertapply-staging-") and not v.get("external") for v in tv.values()), "every volume has an explicit xpertapply-staging-* name (no project-default name, none external)")
chk(all(not v.get("driver_opts") and v.get("driver", "local") == "local" for v in tv.values()), "all volumes use the plain local driver with no driver options")
for svc, cname in (("api", "xpertapply-staging-api"), ("web", "xpertapply-staging-web")):
    run = ins("container", cname)
    rmount = sorted((m["Name"], m["Destination"], bool(m["RW"]), m["Type"]) for m in run["Mounts"])
    want = []
    for v in cfg["services"][svc].get("volumes", []):
        chk(v.get("type") == "volume" and v.get("source") in tv, "%s mount %s -> %s is a NAMED volume defined at top level (not anonymous, not a bind)" % (svc, v.get("source"), v.get("target")))
        want.append((tv[v["source"]]["name"], v["target"], not v.get("read_only", False), "volume"))
    want = sorted(want)
    print("INFO  %s running mounts : %s" % (svc, rmount)); print("INFO  %s candidate mounts: %s" % (svc, want))
    chk(rmount == want, "%s: candidate mounts are IDENTICAL to the running container's (same physical volume names, destinations, rw, type)" % svc)
    nets = sorted(run["NetworkSettings"]["Networks"])
    cn = sorted(cfg["networks"][n].get("name") for n in cfg["services"][svc].get("networks", {}))
    chk(nets == cn, "%s networks running=%s candidate=%s" % (svc, nets, cn))
for vname in sorted(v.get("name") for v in tv.values()):
    try:
        vi = ins("volume", vname); lab = vi.get("Labels") or {}
        chk(lab.get("com.docker.compose.project") == "xpertapply-staging", "volume %s exists (driver %s, created %s) with compose project label xpertapply-staging; Compose will REUSE it, creating nothing" % (vname, vi["Driver"], vi["CreatedAt"]))
    except subprocess.CalledProcessError:
        chk(False, "volume %s does not exist: Compose would CREATE an empty one" % vname)
pg = ins("container", "xpertapply-staging-postgres"); pgm = [m["Name"] for m in pg["Mounts"]]
chk(pgm == [tv["postgres_data"]["name"]], "postgres data volume %s is the one rendered for postgres_data; postgres is not in scope of any step" % pgm)
sys.exit(1 if bad else 0)
PY
  [[ $? -eq 0 ]] || fails=1
  say "== B. Rollback images are exactly the ones the running containers use"
  need_img "$OLD_API_TAG" "$OLD_API_ID"; need_img "$OLD_WEB_TAG" "$OLD_WEB_ID"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$OLD_API_ID" ]] && ok "running staging API container uses $OLD_API_ID" || stop "staging API is not on the expected image"
  [[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$OLD_WEB_ID" ]] && ok "running staging web container uses $OLD_WEB_ID" || stop "staging web is not on the expected image"
  info "compose files that created the running api : $(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' xpertapply-staging-api)"
  info "compose files that created the running web : $(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' xpertapply-staging-web)"
  info "(the web override names $(grep -h image: /home/luna/xa-web-build-cb76c3d/staging-web.release.yml 2>/dev/null | tr -d ' ') ; the base config alone says xpertapply-staging-web:local, which explains the dry-run INFO line)"
  say "== C. Migration scope (isolated one-off: no network, no env, read-only)"
  docker run --rm --network none --read-only --cap-drop ALL --entrypoint alembic "$NEW_API" history -r 0036_application_doc_snapshots:head 2>&1 | grep -- '->' | sed 's/^/      /'
  [[ "$(docker run --rm --network none --read-only --cap-drop ALL --entrypoint alembic "$NEW_API" heads 2>&1 | tail -1)" == "0034_password_reset (head)" ]] && ok "exactly one step above 0036: 0034_password_reset" || stop "unexpected head"
  [[ "$(db_rev)" == "0036_application_doc_snapshots (head)" ]] && ok "staging database is at 0036" || stop "staging database revision is '$(db_rev)'"
  api_env="$(dc -f "$api_o" --profile web config --format json | python3 -c 'import json,sys; e=json.load(sys.stdin)["services"]["api"].get("environment",{}); print("RUN_MIGRATIONS_ON_STARTUP=%s EMAIL_BACKEND=%s SMTP_HOST_set=%s" % (e.get("RUN_MIGRATIONS_ON_STARTUP","<unset>"), e.get("EMAIL_BACKEND","<unset>"), bool(str(e.get("SMTP_HOST","")).strip())))')"
  info "rendered api: $api_env"
  [[ "$api_env" == *"RUN_MIGRATIONS_ON_STARTUP=false"* && "$api_env" == *"SMTP_HOST_set=False"* ]] && ok "no migration on startup; no SMTP configured; recovery stays disabled" || stop "startup-migration or SMTP setting differs"
  say; [[ "${fails:-0}" == 0 ]] && say "EVIDENCE VERDICT: PASS (nothing was changed)" || { say "EVIDENCE VERDICT: BLOCKED"; exit 1; }
}

preflight(){
  validate_lib
  need_img "$NEW_API" "$NEW_API_ID"; need_img "$NEW_WEB" "$NEW_WEB_ID"; need_img "$OLD_API_TAG" "$OLD_API_ID"; need_img "$OLD_WEB_TAG" "$OLD_WEB_ID"
  need_backup
  save_before; ok "container snapshot saved to $STATE/before.containers.txt ($(wc -l < "$STATE/before.containers.txt") containers)"
  say "-- approved dry-run script (read-only) --"; bash "$DRYRUN" | tail -n 12
}

pin_rollback(){
  need_img "$OLD_API_TAG" "$OLD_API_ID"; need_img "$OLD_WEB_TAG" "$OLD_WEB_ID"
  docker tag "$OLD_API_ID" "$RB_API"; docker tag "$OLD_WEB_ID" "$RB_WEB"
  need_img "$RB_API" "$OLD_API_ID"; need_img "$RB_WEB" "$OLD_WEB_ID"
  ok "alias tags added; the original tags and images are untouched"
}

do_migrate(){
  need_img "$NEW_API" "$NEW_API_ID"; need_backup; save_before
  [[ "$(find "$BACKUP" -mmin -1440 | wc -l)" == 1 ]] || stop "backup is older than 24h; take a fresh one first"
  [[ "$(db_rev)" == "0036_application_doc_snapshots (head)" ]] || stop "database is not at 0036: $(db_rev)"
  api_o="$(ovr api "$NEW_API" new)"
  say "-- one-off container from the NEW image: no published ports, no dependencies started --"
  out="$(dc -f "$api_o" run --rm --no-deps --entrypoint alembic api upgrade head 2>&1)"; rc=$?; printf '%s\n' "$out" | grep -E 'Running upgrade|Error|error' | sed 's/^/      /'
  [[ $rc -eq 0 ]] || stop "alembic exited $rc. The migration is transactional on PostgreSQL, so nothing partial should remain; verify with 'alembic current', then see the recovery section of the runbook"
  [[ "$(printf '%s\n' "$out" | grep -c 'Running upgrade')" == 1 && "$out" == *"0036_application_doc_snapshots -> 0034_password_reset"* ]] || stop "migration output is not exactly the single 0036 -> 0034 step"
  [[ "$(db_rev)" == "0036_application_doc_snapshots (head)" ]] && info "(the running OLD api image reports 0036 as its head because it does not know 0034)"
  printf '%s\n' "select version_num from alembic_version;" "select count(*) from users;" "select count(*) from password_reset_tokens;" | docker exec -i xpertapply-staging-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' | tr '\n' ' ' | sed 's/^/      version, users, tokens: /'; echo
  others_unchanged xpertapply-staging-none; ok "migration step complete; API and web are still the old images"
}

do_service(){ # $1 api|web  $2 new image  $3 new id  $4 previous id
  local svc="$1" cname="xpertapply-staging-$1" o rc cid
  validate_lib; need_img "$2" "$3"; save_before
  [[ "$(docker inspect -f '{{.Image}}' "$cname")" == "$4" ]] || stop "$cname does not run the expected current image"
  [[ "$svc" == web ]] || [[ "$(echo "select count(*) from information_schema.columns where table_name='users' and column_name='password_changed_at'" | docker exec -i xpertapply-staging-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At')" == 1 ]] || stop "migration 0034 has not been applied: refusing to start the new API"
  o="$(ovr "$svc" "$2" new)"; cid="$(docker inspect -f '{{.Id}}' "$cname" | cut -c1-12)"
  prof=(); [[ "$svc" == web ]] && prof=(--profile web)
  dc -f "$o" ${prof[@]+"${prof[@]}"} up --dry-run -d --no-deps --no-build --pull never "$svc" > "$WORK/dry" 2>&1; rc=$?
  cat "$WORK/dry"; r="$(validate_dry_run "$svc" "$WORK/dry" "$rc" "$cid")" || stop "dry run rejected: $r"; ok "dry run touches only $cname"
  docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' "$cname" > "$WORK/mounts.before"
  dc -f "$o" ${prof[@]+"${prof[@]}"} up -d --no-deps --no-build --pull never "$svc" || stop "compose up failed; run rollback-$svc"
  [[ "$(docker inspect -f '{{.Image}}' "$cname")" == "$3" ]] && ok "$cname now runs $3" || stop "$cname is not on the candidate image; run rollback-$svc"
  [[ "$(docker inspect -f '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' "$cname")" == "$(cat "$WORK/mounts.before")" ]] && ok "$cname kept exactly the same volumes" || stop "volumes changed; run rollback-$svc"
  wait_healthy "$cname" || stop "$cname did not become healthy; run rollback-$svc"
  others_unchanged "$cname"
}

do_rollback(){ # $1 api|web  $2 alias tag  $3 old id
  local svc="$1" cname="xpertapply-staging-$1" o prof=()
  need_img "$2" "$3"; [[ "$svc" == web ]] && prof=(--profile web); save_before
  o="$(ovr "$svc" "$2" rollback)"
  dc -f "$o" ${prof[@]+"${prof[@]}"} up -d --no-deps --no-build --pull never "$svc" || stop "rollback compose up failed"
  [[ "$(docker inspect -f '{{.Image}}' "$cname")" == "$3" ]] && ok "$cname is back on $3" || stop "$cname is not on $3"
  wait_healthy "$cname" || stop "$cname not healthy after rollback"
  say "NOTE: the database was NOT downgraded; the old $svc runs against the 0034 schema (additive, nullable column and a new table)."
}

verify(){
  curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "staging API healthz" || stop "staging API health failed"
  code="$(curl -s -o /dev/null -w '%{http_code}' https://staging.xpertapply.com/)"; [[ "$code" == 200 ]] && ok "staging web / = 200" || stop "staging web returned $code"
  curl -fsS https://api-staging.xpertapply.com/auth/password-reset/availability | tee /dev/stderr | grep -q '"available":false' && ok "password recovery reports unavailable (SMTP not configured)" || stop "password recovery availability is not false"
  [[ "$(sha256sum "$NOINDEX_VALIDATOR" | cut -d' ' -f1)" == "$NOINDEX_SHA" ]] || stop "noindex validator is not the reviewed one"
  bash "$NOINDEX_VALIDATOR" | grep -E "^(FAIL|PASS)" | sort | uniq -c | sed 's/^/      /'
  curl -fsS https://api.xpertapply.com/healthz >/dev/null && ok "production API healthz" || stop "production API unhealthy"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://xpertapply.com/)" == 200 ]] && ok "production web 200" || stop "production web not 200"
  [[ -f "$STATE/before.containers.txt" ]] || stop "run preflight first (no container snapshot exists)"
  snap | grep -E "$PROTECTED_RE" | diff - <(grep -E "$PROTECTED_RE" "$STATE/before.containers.txt") >/dev/null && ok "postgres, redis, production and veotrex containers are identical to the snapshot" || stop "a protected container differs from the snapshot"
}

case "$mode" in
  evidence) fails=0; evidence ;;
  preflight) preflight ;;
  pin-rollback) pin_rollback ;;
  migrate) do_migrate ;;
  api) do_service api "$NEW_API" "$NEW_API_ID" "$OLD_API_ID" ;;
  web) do_service web "$NEW_WEB" "$NEW_WEB_ID" "$OLD_WEB_ID" ;;
  verify) verify ;;
  rollback-api) do_rollback api "$RB_API" "$OLD_API_ID" ;;
  rollback-web) do_rollback web "$RB_WEB" "$OLD_WEB_ID" ;;
esac
