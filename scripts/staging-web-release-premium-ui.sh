#!/usr/bin/env bash
# Premium UI overhaul: web-only STAGING release. DRAFT, NOT YET RUN on any server.
# Adapted from staging-web-release-50d.sh; the pinned image names/IDs are supplied as
# environment variables instead of being hard-coded, so the same script serves apply and rollback.
#
# Run as root on the staging host (infra dir is readable only by xpertapply; Docker only by the docker group):
#   export NEW_IMG=<repo:tag>  NEW_ID=sha256:<id of NEW_IMG>
#   export OLD_IMG=<repo:tag>  OLD_ID=sha256:<id of the image staging runs TODAY>
#   export NEW_REV=<full 40-char git sha the NEW image was built from>
#   sudo -E bash staging-web-release-premium-ui.sh plan      # read-only: diff effective config + Compose dry run
#   sudo -E bash staging-web-release-premium-ui.sh apply     # recreate ONLY xpertapply-staging-web with NEW_IMG
#   sudo -E bash staging-web-release-premium-ui.sh rollback  # recreate ONLY the web with OLD_IMG
# Never touches api/postgres/redis, volumes or networks. Prints no environment values.
#
# Safety properties (reviewed in PUI-RC1): files are created 0600 and the resolved-config JSON lives in a
# private temp dir removed on exit (it contains environment values); the image id AND its recorded source
# revision must match; the compose `web` service must be the STAGING container; only web.image may differ.
#
# BEFORE `apply`: NEW_IMG must be built for the server's architecture (linux/amd64 on a typical VPS)
# with the real staging NEXT_PUBLIC_* build args (they are compiled into the browser bundle).
set -euo pipefail
umask 077
# Overridable only so the guard logic can be exercised against a stub `docker` in tests.
: "${INFRA:=/home/xpertapply/apps/staging/infra/staging}"
: "${API_OVR:=/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${NEW_IMG:?set NEW_IMG}" "${NEW_ID:?set NEW_ID}" "${OLD_IMG:?set OLD_IMG}" "${OLD_ID:?set OLD_ID}" "${NEW_REV:?set NEW_REV}"
[[ "$NEW_REV" =~ ^[0-9a-f]{40}$ ]] || { echo "NEW_REV must be a full 40-char sha"; exit 1; }
[[ "$(id -u)" == 0 ]] || { echo "run with sudo"; exit 1; }
[[ -f "$INFRA/compose.staging.yml" && -f "$INFRA/.env.staging" ]] || { echo "staging infra files missing under INFRA"; exit 1; }
[[ -f "$API_OVR" ]] || { echo "API override file missing: $API_OVR"; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
[[ "$(docker image inspect -f '{{.Id}}' "$NEW_IMG")" == "$NEW_ID" ]] || { echo "new image id mismatch"; exit 1; }
[[ "$(docker image inspect -f '{{.Id}}' "$OLD_IMG")" == "$OLD_ID" ]] || { echo "rollback image no longer $OLD_ID"; exit 1; }
[[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NEW_IMG")" == "$NEW_REV" ]] \
  || { echo "new image was not built from NEW_REV"; exit 1; }
[[ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$NEW_IMG")" == "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$OLD_IMG")" ]] \
  || { echo "new image platform differs from the image staging runs today"; exit 1; }
cat > "$HERE/staging-web.release.yml" <<YML
services:
  web:
    image: $NEW_IMG
YML
cat > "$HERE/staging-web.rollback.yml" <<YML
services:
  web:
    image: $OLD_IMG
YML
dc() { local web="$1"; shift
  env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    docker compose --project-name xpertapply-staging --project-directory "$INFRA" --env-file "$INFRA/.env.staging" \
    -f "$INFRA/compose.staging.yml" -f "$API_OVR" ${web:+-f "$web"} --profile web --profile workers "$@"; }
snap() { docker inspect -f '{{.Name}} {{.Id}} {{.Image}}' xpertapply-staging-api xpertapply-staging-postgres xpertapply-staging-redis xpertapply-staging-web xpertapply-api-1 xpertapply-web-1 xpertapply-worker-1 xpertapply-scheduler-1 xpertapply-postgres-1 xpertapply-redis-1; }
cfgdiff() { # effective config with vs without the web override; only web.image may differ
  dc "" config --format json > "$WORK/cfg.base.json"; dc "$1" config --format json > "$WORK/cfg.new.json"
  python3 - "$WORK/cfg.base.json" "$WORK/cfg.new.json" <<'PY'
import json,sys
a,b=(json.load(open(p)) for p in sys.argv[1:3])
if a["services"]["web"].get("container_name") != "xpertapply-staging-web":
    sys.exit("compose web service is not xpertapply-staging-web - STOP (would not be staging)")
a["services"]["web"].pop("image"); b["services"]["web"].pop("image")
if a!=b: sys.exit("UNEXPECTED effective-config difference beyond web.image - STOP")
print("effective config identical except web.image")
PY
}
mode="${1:-plan}"
case "$mode" in
  plan)
    cfgdiff "$HERE/staging-web.release.yml"
    echo "--- dry run (expect only xpertapply-staging-web recreated)"
    dc "$HERE/staging-web.release.yml" up --dry-run -d --no-deps --no-build --pull never web 2>&1 | grep -v -i -E "pass|secret|token" ;;
  apply|rollback)
    [[ $mode == apply ]] && F="$HERE/staging-web.release.yml" || F="$HERE/staging-web.rollback.yml"
    cfgdiff "$F"; snap > "$HERE/before.$mode.txt"  # container/image ids only; no environment values
    dc "$F" up -d --no-deps --no-build --pull never web
    snap > "$HERE/after.$mode.txt"
    # An `a && b` list is exempt from `set -e`, so a changed container would NOT have aborted the run.
    if diff <(grep -v staging-web "$HERE/before.$mode.txt") <(grep -v staging-web "$HERE/after.$mode.txt"); then
      echo "all other containers unchanged"
    else
      echo "OTHER CONTAINERS CHANGED (production and staging api/postgres/redis must not) - STOP and investigate"; exit 2
    fi
    sleep 6; curl -s -o /dev/null -w "web http=%{http_code}\n" http://127.0.0.1:3001/ ;;
  *) echo "usage: plan|apply|rollback"; exit 1 ;;
esac
