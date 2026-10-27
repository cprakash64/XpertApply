#!/usr/bin/env bash
# Stage 50D: web-only STAGING release of the production-line Tracker-download candidate (cb76c3d). Run as root (sudo): infra dir readable only by xpertapply, Docker only by the docker group.
# `xpertapply` while Docker is reachable only by the docker group; root is the only account with both.
#   sudo bash staging-web-release.sh plan      # read-only: diff effective config + Compose dry run
#   sudo bash staging-web-release.sh apply     # recreate ONLY xpertapply-staging-web with the pinned image
#   sudo bash staging-web-release.sh rollback  # recreate ONLY the web with the previous image
# Never touches api/postgres/redis, volumes or networks. Prints no environment values.
set -euo pipefail
INFRA=/home/xpertapply/apps/staging/infra/staging
API_OVR=/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEW_IMG=xpertapply-staging-web:stage50d-cb76c3d
NEW_ID=sha256:30651fdd2fa8520c6aaa61d809ed57e7eb362de1ad879bb7452e943d1d8a62ca
OLD_ID=sha256:4dfceefe6176d987b465bacb0cf44ca1078920dceb1223ced1a2f0d164c3b2cc
OLD_IMG=xpertapply-staging-web:nav02-downloads-1516f23
[[ "$(id -u)" == 0 ]] || { echo "run with sudo"; exit 1; }
[[ "$(docker image inspect -f '{{.Id}}' "$NEW_IMG")" == "$NEW_ID" ]] || { echo "new image id mismatch"; exit 1; }
[[ "$(docker image inspect -f '{{.Id}}' "$OLD_IMG")" == "$OLD_ID" ]] || { echo "rollback image no longer $OLD_ID"; exit 1; }
cat > "$HERE/staging-web.release.yml" <<EOF
services:
  web:
    image: $NEW_IMG
EOF
cat > "$HERE/staging-web.rollback.yml" <<EOF
services:
  web:
    image: $OLD_IMG
EOF
dc() { local web="$1"; shift
  env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    docker compose --project-name xpertapply-staging --project-directory "$INFRA" --env-file "$INFRA/.env.staging" \
    -f "$INFRA/compose.staging.yml" -f "$API_OVR" ${web:+-f "$web"} --profile web --profile workers "$@"; }
snap() { docker inspect -f '{{.Name}} {{.Id}} {{.Image}}' xpertapply-staging-api xpertapply-staging-postgres xpertapply-staging-redis xpertapply-staging-web xpertapply-api-1 xpertapply-web-1 xpertapply-worker-1 xpertapply-scheduler-1 xpertapply-postgres-1 xpertapply-redis-1; }
cfgdiff() { # effective config with vs without the web override; only web.image may differ
  dc "" config --format json > "$HERE/cfg.base.json"; dc "$1" config --format json > "$HERE/cfg.new.json"
  python3 - "$HERE/cfg.base.json" "$HERE/cfg.new.json" <<'PY'
import json,sys
a,b=(json.load(open(p)) for p in sys.argv[1:3])
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
    cfgdiff "$F"; snap > "$HERE/before.$mode.txt"
    dc "$F" up -d --no-deps --no-build --pull never web
    snap > "$HERE/after.$mode.txt"
    diff <(grep -v staging-web "$HERE/before.$mode.txt") <(grep -v staging-web "$HERE/after.$mode.txt") && echo "all other containers unchanged"
    sleep 6; curl -s -o /dev/null -w "web http=%{http_code}\n" http://127.0.0.1:3001/ ;;
  *) echo "usage: plan|apply|rollback"; exit 1 ;;
esac
