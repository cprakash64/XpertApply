#!/usr/bin/env bash
# PUI-STG3C: coordinated staging API + web release DRY RUN. Root, read-only.
#
#   sudo bash staging-release-dryrun.sh
#
# It renders the staging Compose configuration and runs `docker compose up --dry-run` for the api and the web only.
# It starts, stops, recreates and removes nothing, runs no migration, writes no database, touches no nginx file and never
# prints an environment VALUE: only variable NAMES, counts, image ids and pass/fail. The report is also written to
# /home/luna/xpertapply-pui01/dryrun-<UTC>.txt (owner luna, mode 0640) so the reviewer can read it.
set -uo pipefail
umask 077

# --- Dry-run output validator (sourced by test-dryrun-validator.sh; ignored when the script is executed) -----------
# validate_dry_run <api|web> <output-file> <compose-exit-code> <current-short-container-id (12 lowercase hex)>
# Accepts only the grammar Compose v2.35 was observed to emit for a recreate of ONE service:
#   " DRY-RUN MODE -  Container NAME  VERB"   with VERB in Recreate|Recreated|Starting|Started
# where NAME is exactly xpertapply-staging-<service>, or <that service's CURRENT 12-hex container id>_xpertapply-staging-<service>
# (Compose names the container being replaced with its own id while it starts). Every non-blank line must match; an unknown
# service, prefix, suffix, verb, extra line, empty output or non-zero exit is rejected. Prints the reason and returns 1.
validate_dry_run() {
  local svc="${1:-}" file="${2:-}" rc="${3:-}" cid="${4:-}" name line n_re recreate=0 lines=0
  case "$svc" in api|web) name="xpertapply-staging-$svc" ;; *) echo "unknown service '$svc'"; return 1 ;; esac
  [[ "$rc" == 0 ]] || { echo "$svc dry run exited '$rc'"; return 1; }
  [[ "$cid" =~ ^[0-9a-f]{12}$ ]] || { echo "current container id for $svc is not 12 lowercase hex: '$cid'"; return 1; }
  [[ -s "$file" ]] || { echo "$svc dry run output is empty"; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    lines=$((lines+1))
    if [[ "$line" =~ ^[[:space:]]*DRY-RUN\ MODE\ -[[:space:]]+Container[[:space:]]+([A-Za-z0-9_.-]+)[[:space:]]+(Recreate|Recreated|Starting|Started)[[:space:]]*$ ]]; then
      n_re="${BASH_REMATCH[1]}"
      if [[ "$n_re" != "$name" && "$n_re" != "${cid}_${name}" ]]; then echo "$svc dry run names an unexpected container: $n_re"; return 1; fi
      [[ "${BASH_REMATCH[2]}" == Recreate && "$n_re" == "$name" ]] && recreate=1
    else
      echo "$svc dry run has an unexpected line: $line"; return 1
    fi
  done < "$file"
  [[ $lines -gt 0 && $recreate -eq 1 ]] || { echo "$svc dry run does not show a recreate of $name"; return 1; }
  return 0
}
if [[ "${XA_DRYRUN_SOURCE_ONLY:-}" == "1" && "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; fi

EXPECT_HOST="srv738314"
INFRA="${INFRA:-/home/xpertapply/apps/staging/infra/staging}"
API_OVR="${API_OVR:-/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml}"
NEW_API="xpertapply-api:pui-9dbf283-amd64";          NEW_API_ID="sha256:87c7226837b6133aadd3ffc72f88acb1119b0fca9c013f267b597d649bd83e55"
NEW_WEB="xpertapply-staging-web:pui-9dbf283-amd64";  NEW_WEB_ID="sha256:fb51cfd76b1ae7ea8bd1b473ef59d6cb60d3935ae2332586cfb3d0d320a819cd"
OLD_API_ID="sha256:436c05e7dff8eebf2edefef402d3194046050c4cffd5fbbb58e0ca679746b020"
OLD_WEB_ID="sha256:30651fdd2fa8520c6aaa61d809ed57e7eb362de1ad879bb7452e943d1d8a62ca"
NEW_REV="9dbf2836a6ffa374d6e626a368820fd79410ba78"
BACKUP="/home/luna/staging-backups/xpertapply-staging-pre-0034-20261029T053028Z.dump"
BACKUP_SHA="5538b770193cf5f778dc3b5b75039fdf4f2cf4f8e05b2dd5ebbf31f0aa098af0"
OUT_DIR="/home/luna/xpertapply-pui01"

[[ "$(id -u)" == 0 ]] || { echo "STOP  run with sudo (the staging infra files are root/xpertapply only)"; exit 1; }
[[ "$(hostname)" == "$EXPECT_HOST" ]] || { echo "STOP  wrong host $(hostname)"; exit 1; }
REPORT="$OUT_DIR/dryrun-$(date -u +%Y%m%dT%H%M%SZ).txt"
exec > >(tee "$REPORT") 2>&1
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; chown luna:luna "$REPORT" 2>/dev/null; chmod 640 "$REPORT" 2>/dev/null' EXIT
fails=0
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fails=$((fails+1)); }
info() { printf 'INFO  %s\n' "$*"; }
CLEAN=(env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)

echo "== 0. Guards"
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] && ok "DOCKER_HOST/DOCKER_CONTEXT unset" || bad "DOCKER_HOST or DOCKER_CONTEXT is set"
[[ "$("${CLEAN[@]}" docker context show)" == default ]] && ok "docker context is default" || bad "docker context is not default"
for f in "$INFRA/compose.staging.yml" "$INFRA/.env.staging" "$API_OVR" "$INFRA/staging_guard.py"; do
  [[ -f "$f" ]] && ok "present: $f" || bad "missing: $f"
done
[[ $fails -eq 0 ]] || { echo "STOP  missing prerequisites; nothing else was run"; exit 1; }

echo "== 1. Release artifacts"
for pair in "$NEW_API|$NEW_API_ID" "$NEW_WEB|$NEW_WEB_ID"; do
  img="${pair%%|*}"; want="${pair##*|}"
  got="$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null)"
  [[ "$got" == "$want" ]] && ok "$img id $got" || bad "$img id is '$got', expected $want"
  rev="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")"
  [[ "$rev" == "$NEW_REV" ]] && ok "$img revision label $rev" || bad "$img revision label '$rev'"
  [[ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$img")" == linux/amd64 ]] && ok "$img is linux/amd64" || bad "$img platform"
done
[[ "$(docker image inspect -f '{{.Id}}' xpertapply-api:nav02-gated-1516f23)" == "$OLD_API_ID" ]] && ok "rollback API image intact ($OLD_API_ID)" || bad "rollback API image changed"
[[ "$(docker image inspect -f '{{.Id}}' xpertapply-staging-web:stage50d-cb76c3d)" == "$OLD_WEB_ID" ]] && ok "rollback web image intact ($OLD_WEB_ID)" || bad "rollback web image changed"
[[ "$(sha256sum "$BACKUP" | cut -d' ' -f1)" == "$BACKUP_SHA" ]] && ok "staging backup intact (sha256 $BACKUP_SHA)" || bad "staging backup checksum mismatch"
[[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$OLD_API_ID" ]] && ok "staging API currently runs the rollback image" || bad "staging API is not on the expected current image"
[[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$OLD_WEB_ID" ]] && ok "staging web currently runs the rollback image" || bad "staging web is not on the expected current image"

echo "== 2. Migration chain inside the NEW API image (isolated one-off: no network, no volumes, no env, read-only; removed on exit)"
docker run --rm --network none --read-only --cap-drop ALL --entrypoint alembic "$NEW_API" heads 2>&1 | tail -1 | sed 's/^/      heads: /'
docker run --rm --network none --read-only --cap-drop ALL --entrypoint alembic "$NEW_API" history -r 0033_prod_auth_identities:head 2>&1 | grep -- '->' | sed 's/^/      /'
h="$(docker run --rm --network none --read-only --cap-drop ALL --entrypoint alembic "$NEW_API" heads 2>&1 | tail -1)"
[[ "$h" == "0034_password_reset (head)" ]] && ok "single head 0034_password_reset" || bad "unexpected head: $h"
cur="$(docker exec xpertapply-staging-api alembic current 2>/dev/null | tail -1)"
[[ "$cur" == "0036_application_doc_snapshots (head)" ]] && ok "staging database is at 0036_application_doc_snapshots (read-only check)" || bad "staging database revision is '$cur'"

echo "== 3. Render the staging configuration (no values are printed)"
dc() { "${CLEAN[@]}" docker compose --project-name xpertapply-staging --project-directory "$INFRA" --env-file "$INFRA/.env.staging" \
  -f "$INFRA/compose.staging.yml" -f "$API_OVR" "$@"; }
printf 'services:\n  api:\n    image: %s\n' "$NEW_API" > "$WORK/api.new.yml"
printf 'services:\n  web:\n    image: %s\n' "$NEW_WEB" > "$WORK/web.new.yml"
dc --profile web --profile workers config --format json > "$WORK/base.json" 2> "$WORK/base.err" && ok "base configuration renders" || { bad "base configuration does not render"; sed 's/=.*/=<redacted>/' "$WORK/base.err" | head -5; }
dc -f "$WORK/api.new.yml" -f "$WORK/web.new.yml" --profile web --profile workers config --format json > "$WORK/new.json" 2>/dev/null && ok "candidate configuration renders" || bad "candidate configuration does not render"
python3 "$INFRA/staging_guard.py" rendered-config < "$WORK/new.json" > "$WORK/guard.out" 2>&1 && ok "repository staging guard accepts the candidate configuration" || { bad "staging guard refused the candidate configuration"; sed 's/=.*/=<redacted>/' "$WORK/guard.out" | head -8; }

python3 - "$WORK/base.json" "$WORK/new.json" "$NEW_API" "$NEW_WEB" <<'PY' || fails=$((fails+1))
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3]); api, web = sys.argv[3:5]
sa, sb = a["services"], b["services"]
bad = 0
def say(ok, msg):
    global bad
    print(("PASS  " if ok else "FAIL  ") + msg)
    bad += (not ok)
say(set(sa) == set(sb), "same services before/after: " + ", ".join(sorted(sb)))
diffs = []
for name in sorted(sb):
    x, y = dict(sa.get(name, {})), dict(sb[name])
    for k in sorted(set(x) | set(y)):
        if x.get(k) != y.get(k):
            diffs.append((name, k))
say(sorted(diffs) == [("api", "image"), ("web", "image")], "the ONLY effective differences are api.image and web.image: " + str(diffs))
say(sb["api"]["image"] == api and sb["web"]["image"] == web, "candidate images are the verified pui-9dbf283 tags")
print("INFO  old images: api=%s web=%s" % (sa["api"]["image"], sa["web"]["image"]))
say(sb["web"].get("container_name") == "xpertapply-staging-web" and sb["api"].get("container_name") == "xpertapply-staging-api", "container names are the staging ones")
for n in ("api", "web", "postgres", "redis"):
    s = sb.get(n, {})
    ports = [(p.get("host_ip"), p.get("published"), p.get("target")) for p in s.get("ports", [])]
    vols = sorted((v.get("source"), v.get("target")) for v in s.get("volumes", []))
    print("INFO  %-8s restart=%s ports=%s volumes=%s networks=%s" % (n, s.get("restart"), ports, vols, sorted(s.get("networks", {}))))
    say(all(p[0] == "127.0.0.1" for p in ports), "%s publishes only on 127.0.0.1" % n)
env = sb["api"].get("environment", {})
backend = str(env.get("EMAIL_BACKEND", "<unset>"))
say(backend in ("<unset>", "", "disabled"), "password recovery stays DISABLED: EMAIL_BACKEND=%s" % backend)
say(not any(str(env.get(k, "")).strip() for k in ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD")), "no SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD configured on staging api")
print("INFO  api environment variable NAMES: %d (values not printed)" % len(env))
sys.exit(1 if bad else 0)
PY

echo "== 4. Rendered configuration vs the RUNNING containers (names and match/mismatch only)"
python3 - "$WORK/base.json" <<'PY' || fails=$((fails+1))
import hashlib, json, subprocess, sys
cfg = json.load(open(sys.argv[1]))["services"]
bad = 0
def h(v): return hashlib.sha256(str(v).encode()).hexdigest()[:10]
for svc, cname in (("api", "xpertapply-staging-api"), ("web", "xpertapply-staging-web")):
    ins = json.loads(subprocess.check_output(["docker", "inspect", cname]))[0]
    run = dict(e.split("=", 1) for e in ins["Config"]["Env"] if "=" in e)
    want = {k: ("" if v is None else str(v)) for k, v in cfg[svc].get("environment", {}).items()}
    missing = sorted(k for k in want if k not in run)
    changed = sorted(k for k in want if k in run and h(run[k]) != h(want[k]))
    print("%s %-6s env: %d rendered names; %d not in running container %s; %d value mismatches %s" %
          ("PASS " if not missing and not changed else "FAIL ", svc, len(want), len(missing), missing, len(changed), changed))
    bad += bool(missing or changed)
    hc = ins["HostConfig"]
    rp = hc["RestartPolicy"]["Name"]; want_rp = str(cfg[svc].get("restart", "no")).split(":")[0]
    print("%s %-6s restart policy running=%s rendered=%s" % ("PASS " if rp == want_rp else "FAIL ", svc, rp, want_rp)); bad += rp != want_rp
    pub = sorted((p, v[0]["HostIp"], v[0]["HostPort"]) for p, v in (hc.get("PortBindings") or {}).items() if v)
    rend = sorted(("%s/tcp" % p["target"], p["host_ip"], str(p["published"])) for p in cfg[svc].get("ports", []))
    print("%s %-6s ports running=%s rendered=%s" % ("PASS " if pub == rend else "FAIL ", svc, pub, rend)); bad += pub != rend
    mounts = sorted(m.get("Name") or m.get("Source") for m in ins["Mounts"])
    rendm = sorted(v.get("source") for v in cfg[svc].get("volumes", []))
    print("INFO  %-6s mounts running=%s rendered=%s" % (svc, mounts, rendm))
sys.exit(1 if bad else 0)
PY

echo "== 5. Compose dry runs (literal output; --no-deps --no-build --pull never)"
dc -f "$WORK/api.new.yml" up --dry-run -d --no-deps --no-build --pull never api > "$WORK/dry.api" 2>&1; rc_api=$?; echo "dry-run api exit=$rc_api"
cat "$WORK/dry.api"
dc -f "$WORK/web.new.yml" --profile web up --dry-run -d --no-deps --no-build --pull never web > "$WORK/dry.web" 2>&1; rc_web=$?; echo "dry-run web exit=$rc_web"
cat "$WORK/dry.web"
api_cid="$(docker inspect -f '{{.Id}}' xpertapply-staging-api | cut -c1-12)"; web_cid="$(docker inspect -f '{{.Id}}' xpertapply-staging-web | cut -c1-12)"
info "current short ids: api=$api_cid web=$web_cid (Compose prefixes the container being replaced with its own id)"
if r="$(validate_dry_run api "$WORK/dry.api" "$rc_api" "$api_cid")"; then ok "api dry run: only xpertapply-staging-api (plain or prefixed with its own id $api_cid), exit 0"; else bad "api dry run rejected: $r"; fi
if r="$(validate_dry_run web "$WORK/dry.web" "$rc_web" "$web_cid")"; then ok "web dry run: only xpertapply-staging-web (plain or prefixed with its own id $web_cid), exit 0"; else bad "web dry run rejected: $r"; fi
grep -qiE 'Recreate' "$WORK/dry.api" && ok "api would be recreated" || bad "api dry run shows no Recreate (is the image already in use?)"
grep -qiE 'Recreate' "$WORK/dry.web" && ok "web would be recreated" || bad "web dry run shows no Recreate"
grep -qiE 'xpertapply-staging-(postgres|redis)|xpertapply-(api|web|worker|scheduler|postgres|redis)-1|veotrex' "$WORK/dry.api" "$WORK/dry.web" && bad "a database/cache, production or veotrex container appears in the dry run" || ok "no postgres, redis, production or veotrex container appears in the dry runs"

echo "== 6. Nothing changed while this script ran"
docker ps -a --format '{{.Names}} {{.ID}} {{.Image}}' | sort > "$WORK/after.txt"
if [[ -r "$OUT_DIR/containers.before.txt" ]]; then
  diff <(sed 's/ Up .*//' "$OUT_DIR/containers.before.txt") "$WORK/after.txt" > /dev/null && ok "all 14 container names, ids and images equal the pre-backup snapshot" || bad "container set differs from the pre-backup snapshot"
fi
[[ "$(wc -l < "$WORK/after.txt")" == 14 ]] && ok "14 containers" || bad "container count is $(wc -l < "$WORK/after.txt")"
[[ "$(docker inspect -f '{{.Image}}' xpertapply-staging-api)" == "$OLD_API_ID" && "$(docker inspect -f '{{.Image}}' xpertapply-staging-web)" == "$OLD_WEB_ID" ]] && ok "staging api and web still run their previous images" || bad "a staging image changed"
curl -fsS https://api-staging.xpertapply.com/healthz >/dev/null && ok "staging API healthy" || bad "staging API health check failed"

echo
if [[ $fails -eq 0 ]]; then echo "DRY RUN VERDICT: PASS (nothing was changed). Report: $REPORT"; else echo "DRY RUN VERDICT: BLOCKED ($fails failing checks). Nothing was changed. Report: $REPORT"; fi
exit $(( fails > 0 ))
