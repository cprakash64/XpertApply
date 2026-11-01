# EXT-FINAL-03 shared definitions. Sourced by production-release.sh and production-rollback.sh from the INSTALLED, root-owned copy.
# Nothing here prints a secret. No file under /home is used as a Compose input.
readonly PROJECT=xpertapply API_C=xpertapply-api-1 WEB_C=xpertapply-web-1 EXPECT_HOST=srv738314
readonly PROD_DIR=/home/xpertapply/apps/production ENV_FILE=/home/xpertapply/apps/production/.env
readonly STATE3=/var/lib/xpertapply-release/netprod03 STATE8=/var/lib/xpertapply-release/netprod08 STATEE=/var/lib/xpertapply-release/extfinal03
readonly BASE3=("${PROD_DIR}/docker-compose.yml" "${PROD_DIR}/compose.production.yml" "${PROD_DIR}/compose.redis-preserve.yml")
readonly BASE4="${STATE3}/compose.netprod01-release.yml" ACT="${STATE3}/compose.netprod03-activate.yml" IMG8="${STATE8}/compose.netprod08-images.yml"
readonly WEBIMG="${STATEE}/compose.extfinal03-web-image.yml" EXTID="${STATEE}/compose.extfinal03-extension-id.yml"
readonly STORE_ID="gnibjomjfdobadlockphjiibbpmiehcj"
# Running today (NET-PROD-08) = the web rollback target; the API image never changes in this release.
readonly API_ID="sha256:12eb76af8610a7e9f723e5997b05ef59784d9d5df4208f24150a4663ebd75541" API_TAG="xpertapply-api:netprod08-32a7d54-prod-amd64"
readonly OLD_WEB_ID="sha256:0e6c28d056ebd134d386aaeb9ceb0ec26708e068b16007165e1e5bd29684b488" OLD_WEB_TAG="xpertapply-web:netprod08-32a7d54-prod-amd64"
readonly OLD_WEB_TAR="/home/luna/xpertapply-release-candidates/netprod08-32a7d54-20261101T043704Z/xpertapply-web-netprod08-32a7d54-prod-amd64.tar"
readonly OLD_WEB_TAR_SHA="4e8bc9be82ddd01820840755712024f1981c9d65fe9de547ae0a97afcbf9d84c"
# This release
readonly NEW_WEB_ID="sha256:ef03408595cc433ba783be4a93acbfc0fe208f2b04ec8ddc859892a2ce422b1d" NEW_WEB_TAG="xpertapply-web:extfinal03-273f975-prod-amd64"
readonly NEW_WEB_TAR="/home/luna/xpertapply-release-candidates/extfinal03-273f975-20261101T091352Z/xpertapply-web-extfinal03-273f975-prod-amd64.tar"
readonly NEW_WEB_TAR_SHA="bce9bbf1efd8ef3e0fed2864c5a0991ccb205cfc3743e2eefeec2027383c32e2"
readonly COMMIT="273f975a3123babc50d55fdc39faa8c81160e0c5"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; readonly SELF_DIR
readonly STATE3_PY=/opt/xpertapply-release/netprod03-email-activation/netprod03_state.py
readonly STATE8_PY=/opt/xpertapply-release/netprod08-networking-final/netprod08_state.py
readonly STATEE_PY="${SELF_DIR}/extfinal03_state.py" MONITOR="${SELF_DIR}/production-monitor.sh"

pass=0; fail=0; skip=0
ok()  { printf '  PASS  %s\n' "$*"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$*"; fail=$((fail+1)); }
skp() { printf '  SKIP  %s\n' "$*"; skip=$((skip+1)); }
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }

common_guard() {
  [[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || die "DOCKER_HOST/DOCKER_CONTEXT must be unset"
  [[ "$(hostname)" == "$EXPECT_HOST" ]] || die "unexpected host $(hostname)"
  is_root=0; [[ "$(id -u)" == 0 ]] && is_root=1
  if (( is_root )); then
    case "$SELF_DIR" in /opt/xpertapply-release/*) ;; *) die "run the INSTALLED copy under /opt/xpertapply-release (this one is in ${SELF_DIR})";; esac
    local d; for d in "$SELF_DIR" /opt/xpertapply-release /opt; do
      [[ "$(stat -c '%u' "$d")" == 0 && $(( 0$(stat -c '%a' "$d") & 022 )) == 0 && ! -L "$d" ]] || die "${d} is not a root-owned, non-writable directory"
    done
  fi
}

img() { docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true; }
archive_ok() { [[ -f "$1" && ! -L "$1" && "$(sha256sum "$1" | cut -d' ' -f1)" == "$2" ]]; }
image_ok()   { [[ "$(docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true)" == "$2" ]]; }
load_if_missing() { # id tag tar pinned-sha: the archive path is not trusted, its hash is pinned here and the loaded id is re-checked
  [[ "$(docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true)" == "$1" ]] && { docker tag "$1" "$2"; return 0; }
  [[ -f "$3" && ! -L "$3" ]] || die "image ${1:7:12} is missing and its archive is not a regular file"
  [[ "$(sha256sum "$3" | cut -d' ' -f1)" == "$4" ]] || die "archive $(basename "$3") does not match its pinned SHA-256"
  docker load -i "$3" >/dev/null
  [[ "$(docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true)" == "$1" ]] || die "loaded archive did not yield the expected image id"
  docker tag "$1" "$2"
}

dc() { env -i HOME=/root PATH="$PATH" docker compose --project-name "$PROJECT" --project-directory "$PROD_DIR" --env-file "$ENV_FILE" "$@"; }
render_json() { local -a a=(); local f; for f in "$@"; do a+=(-f "$f"); done; dc "${a[@]}" config --format json 2>/dev/null | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)))' 2>/dev/null || true; }

# The Compose list is a pure function of the intended global state: web_new (0/1) and ext (0/1). Order is fixed.
build_files() { # $1 web_new  $2 ext   -> sets FILES
  FILES=("${BASE3[@]}" "$BASE4" "$ACT" "$IMG8")
  [[ "$1" == 1 ]] && FILES+=("$WEBIMG")
  [[ "$2" == 1 ]] && FILES+=("$EXTID")
  return 0
}
live_ext()     { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$API_C" 2>/dev/null | grep -c '^EXTENSION_ALLOWED_IDS=' || true; }
live_webnew()  { [[ "$(img "$WEB_C")" == "$NEW_WEB_ID" ]] && echo 1 || echo 0; }
label_files()  { docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$1" 2>/dev/null || true; }

settings_json() { # non-secret effective settings of the running API; no key, URL, e-mail or id value is printed except the public extension ids
  docker exec -i "$API_C" python - <<'PY'
import json
from app.core.config import settings as s
print(json.dumps(dict(discovery=bool(s.people_email_discovery_enabled), key=bool(s.hunter_api_key),
  daily=s.people_email_daily_credit_budget, per_user=s.people_email_per_user_daily_limit, hourly=s.people_email_rate_limit_per_hour,
  rollout=s.people_rollout_mode, testers=len(s.people_internal_emails), backend=s.email_backend, recs=bool(s.people_recommendations_enabled),
  drafting=bool(s.application_answer_drafting_enabled), env=s.app_env, ext_ids=sorted(s.extension_allowed_ids))))
PY
}
same_except_ext() { # $1 before-json $2 after-json $3 expected ext_ids (comma list, may be empty): everything else must be identical
  python3 -c '
import json, sys
b, a = json.loads(sys.argv[1]), json.loads(sys.argv[2]); want = [x for x in sys.argv[3].split(",") if x]
diff = sorted(k for k in set(b) | set(a) if k != "ext_ids" and b.get(k) != a.get(k))
bad = list(diff) + ([] if a.get("ext_ids") == want else ["ext_ids"]) + ([] if a.get("drafting") is False else ["drafting-not-disabled"])
print("   changed settings besides ext_ids: " + (", ".join(diff) or "none") + "; ext_ids now " + json.dumps(a.get("ext_ids")) + "; drafting " + json.dumps(a.get("drafting")))
sys.exit(1 if bad else 0)' "$1" "$2" "$3"
}
others_hash() { # every container except the listed one(s) must be untouched ($1 = space-separated names that may be recreated)
  docker ps -a --no-trunc --format '{{.ID}} {{.Names}}' | awk -v ex=" $1 " 'index(ex, " " $2 " ")==0 {print $1,$2}' | sort | sha256sum | cut -c1-16
}
started_hash() { # start times of the services that must never restart, plus whichever of api/web is not being recreated
  { local c; for c in worker scheduler postgres redis; do docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' "${PROJECT}-${c}-1"; done
    for c in $1; do docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' "$c"; done; } | sha256sum | cut -c1-16
}
public_ok() { # path expected-code
  [[ "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://xpertapply.com$1" 2>/dev/null || true)" == "$2" ]]
}
api_public_ok() { [[ "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.xpertapply.com/healthz 2>/dev/null || true)" == 200 ]]; }
redirect_check() { # inside the running API: exact-match redirect policy (store id yes; staging id, unlisted id and wildcard no)
  docker exec -i "$API_C" python - "$1" <<'PY'
import sys
from app.routes.extension import _redirect_allowed as ok
want = sys.argv[1] == "1"
store, staging, other = "gnibjomjfdobadlockphjiibbpmiehcj", "cglmdonbfbadfbggkpajpkjgpekhkall", "a" * 32
r = lambda i: ok(f"https://{i}.chromiumapp.org/xpertapply")
res = (r(store), r(staging), r(other), r("*"), ok("https://evil.example/x"))
print("store=%s staging=%s other=%s wildcard=%s foreign=%s" % res)
sys.exit(0 if res == (want, False, False, False, False) else 1)
PY
}
