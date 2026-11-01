#!/usr/bin/env bash
# XpertApply release monitor. READ-ONLY: curl GETs, docker inspect/logs/stats, pg_isready, redis-cli llen, free, df.
# Run as a user in the docker group (luna). Installs nothing, schedules nothing, writes only to stdout (and the baseline file you name).
# Exit: 0 all OK | 1 warnings | 2 FAIL (rollback-escalation criteria met).
set -uo pipefail
PHASE=pre; WINDOW=2m; BASELINE=""; INIT=0; INTERVAL=30; COUNT=1
WEB=https://xpertapply.com; API=https://api.xpertapply.com
while [ $# -gt 0 ]; do case "$1" in
  --phase) PHASE=$2; shift 2;; --window) WINDOW=$2; shift 2;; --baseline) BASELINE=$2; shift 2;; --init-baseline) INIT=1; shift;;
  --interval) INTERVAL=$2; shift 2;; --count) COUNT=$2; shift 2;; -h|--help) sed -n 2,6p "$0"; exit 0;; *) echo "unknown arg $1" >&2; exit 64;; esac; done
case "$PHASE" in pre|api-new|post|rollback) ;; *) echo "phase must be pre|api-new|post|rollback" >&2; exit 64;; esac
CONT=(xpertapply-web-1 xpertapply-api-1 xpertapply-worker-1 xpertapply-scheduler-1 xpertapply-postgres-1 xpertapply-redis-1)
# NET-PROD-01 has no migration: /readyz must be 200 at 0034_password_reset in every phase (including rollback).
EXP_REV=0034_password_reset; EXP_CODE=200
worst=0; ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
emit() { local sev=$1 name=$2 msg=$3; local tag=OK; [ "$sev" = 1 ] && tag=WARN; [ "$sev" = 2 ] && tag=FAIL; [ "$sev" -gt "$worst" ] && worst=$sev; printf '%s %-5s %-24s %s\n' "$(ts)" "$tag" "$name" "$msg"; }
probe() { # url -> "code time"
  curl -sS -o /dev/null -m 6 -w '%{http_code} %{time_total}' "$1" 2>/dev/null || echo "000 6.0"; }
need_docker() { timeout 15 docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || { emit 2 docker "cannot talk to Docker (run as a docker-group user)"; exit 2; }; }
baseline_get() { grep -E "^$1 " "$BASELINE" 2>/dev/null | awk '{print $2}'; }
check_once() {
  worst=0
  # 1 availability
  read -r c t < <(probe "$WEB/");            [ "$c" = 200 ] && emit 0 web_home "HTTP 200 ${t}s" || emit 2 web_home "HTTP $c (${t}s)"
  read -r c t < <(probe "$WEB/login");       [ "$c" = 200 ] && emit 0 web_login "HTTP 200 ${t}s" || emit 2 web_login "HTTP $c"
  read -r c t < <(probe "$API/healthz");     if [ "$c" = 200 ]; then awk "BEGIN{exit !($t>2)}" && emit 1 api_healthz "HTTP 200 slow ${t}s" || emit 0 api_healthz "HTTP 200 ${t}s"; else emit 2 api_healthz "HTTP $c"; fi
  body=$(curl -sS -m 6 -w '\n%{http_code}' "$API/readyz" 2>/dev/null || printf '\n000'); code=${body##*$'\n'}; json=${body%$'\n'*}
  rev=$(printf '%s' "$json" | python3 -c 'import sys,json
try: d=json.load(sys.stdin).get("checks",{}); print(d.get("current_revision"),d.get("head_revision"),d.get("database_connected"),d.get("redis_connected"))
except Exception: print("? ? ? ?")')
  set -- $rev
  if [ "$code" = "$EXP_CODE" ] && [ "$1" = "$EXP_REV" ]; then
    emit 0 api_readyz "HTTP $code rev=$1 head=$2 db=$3 redis=$4"
  else emit 2 api_readyz "HTTP $code (expected $EXP_CODE) rev=$1 head=$2 db=$3 redis=$4 (expected rev $EXP_REV)"; fi
  # 2 containers
  for c in "${CONT[@]}"; do
    info=$(timeout 15 docker inspect "$c" --format '{{.State.Status}} {{.RestartCount}} {{.State.OOMKilled}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Image}}' 2>/dev/null) || { emit 2 "ctr_$c" "not found"; continue; }
    set -- $info; st=$1; rc=$2; oom=$3; hl=$4; img=${5:0:19}
    base=$(baseline_get "$c"); sev=0; note="$st restarts=$rc health=$hl image=$img"
    [ "$st" != running ] && sev=2
    [ "$oom" = true ] && { sev=2; note="$note OOMKilled=true"; }
    if [ -n "$base" ]; then set -- $base; [ "$rc" -gt "$1" ] 2>/dev/null && { sev=2; note="$note RESTARTED(baseline $1)"; }; fi
    case "$hl" in healthy|none) ;; starting) [ $sev -lt 1 ] && sev=1;; *) sev=2;; esac
    emit $sev "ctr_${c#xpertapply-}" "$note"
  done
  # 3 API logs: 5xx and auth failures in window (uvicorn access format: "METHOD /path HTTP/1.1" STATUS)
  logs=$(timeout 20 docker logs --since "$WINDOW" xpertapply-api-1 2>&1)
  n5=$(printf '%s\n' "$logs" | grep -c -E '" 5[0-9][0-9] ' || true); n401=$(printf '%s\n' "$logs" | grep -c -E 'POST /auth/login HTTP/[0-9.]+" 401' || true)
  nex=$(printf '%s\n' "$logs" | grep -c -E 'Traceback|Exception in ASGI|ERROR:' || true); nreq=$(printf '%s\n' "$logs" | grep -c -E '" [0-9]{3} ' || true)
  [ "$n5" -ge 3 ] && emit 2 api_5xx "$n5 server errors in last $WINDOW (of $nreq requests)" || { [ "$n5" -ge 1 ] && emit 1 api_5xx "$n5 server error(s) in last $WINDOW" || emit 0 api_5xx "0 in last $WINDOW ($nreq requests)"; }
  [ "$nex" -ge 1 ] && emit 1 api_exceptions "$nex traceback/ERROR lines in last $WINDOW (inspect: docker logs --since $WINDOW xpertapply-api-1)" || emit 0 api_exceptions "none"
  [ "$n401" -gt 60 ] && emit 2 auth_failures "$n401 failed logins in $WINDOW" || { [ "$n401" -gt 20 ] && emit 1 auth_failures "$n401 failed logins in $WINDOW" || emit 0 auth_failures "$n401 failed logins in $WINDOW"; }
  # 4 database / queue / worker
  timeout 15 docker exec xpertapply-postgres-1 sh -c 'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' && emit 0 db_ready "pg_isready ok" || emit 2 db_ready "pg_isready failed"
  conns=$(timeout 15 docker exec xpertapply-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from pg_stat_activity"' 2>/dev/null || echo -1)
  [ "$conns" -ge 85 ] && emit 2 db_connections "$conns of 100" || { [ "$conns" -ge 60 ] && emit 1 db_connections "$conns of 100" || emit 0 db_connections "$conns of 100"; }
  ql=$(timeout 15 docker exec xpertapply-redis-1 redis-cli llen celery 2>/dev/null || echo -1)
  [ "$ql" -ge 500 ] && emit 2 queue_length "$ql" || { [ "$ql" -ge 100 ] && emit 1 queue_length "$ql" || { [ "$ql" -lt 0 ] && emit 2 queue_length "redis unreachable" || emit 0 queue_length "$ql"; }; }
  wl=$(timeout 20 docker logs --since "$WINDOW" xpertapply-worker-1 2>&1 | grep -c -E 'ERROR|Traceback|raised unexpected|Task .* failed' || true)
  [ "$wl" -ge 1 ] && emit 1 worker_errors "$wl error line(s) in last $WINDOW" || emit 0 worker_errors "none in last $WINDOW"
  # 5 capacity
  avail=$(free -m | awk '/^Mem:/{print $7}'); [ "$avail" -lt 800 ] && emit 2 mem_available "${avail}MB" || { [ "$avail" -lt 1500 ] && emit 1 mem_available "${avail}MB" || emit 0 mem_available "${avail}MB"; }
  du=$(df --output=pcent / | tail -1 | tr -dc 0-9); [ "$du" -ge 92 ] && emit 2 disk_root "${du}%" || { [ "$du" -ge 85 ] && emit 1 disk_root "${du}%" || emit 0 disk_root "${du}%"; }
  am=$(timeout 15 docker stats --no-stream --format '{{.MemUsage}}' xpertapply-api-1 2>/dev/null | cut -d/ -f1 | tr -d ' ')
  mb=$(printf '%s' "$am" | python3 -c 'import sys,re
m=re.match(r"([\d.]+)(KiB|MiB|GiB)",sys.stdin.read().strip()); print(int(float(m.group(1))*{"KiB":1/1024,"MiB":1,"GiB":1024}[m.group(2)])) if m else print(-1)')
  [ "$mb" -ge 2560 ] && emit 1 api_memory "${mb}MiB (idle ~1000MiB; candidate peak 283MiB)" || emit 0 api_memory "${mb}MiB"
  return $worst
}
need_docker
if [ "$INIT" = 1 ]; then
  [ -n "$BASELINE" ] || { echo "--init-baseline needs --baseline FILE" >&2; exit 64; }
  [ -e "$BASELINE" ] && { echo "refusing to overwrite $BASELINE" >&2; exit 64; }
  umask 077; for c in "${CONT[@]}"; do echo "$c $(docker inspect "$c" --format '{{.RestartCount}} {{.Image}}')"; done > "$BASELINE"; echo "$(ts) baseline written: $BASELINE"; exit 0
fi
final=0
for i in $(seq 1 "$COUNT"); do
  echo "--- check $i/$COUNT phase=$PHASE window=$WINDOW"; check_once; r=$?; [ "$r" -gt "$final" ] && final=$r
  [ "$i" -lt "$COUNT" ] && sleep "$INTERVAL"
done
case $final in 0) echo "$(ts) RESULT OK";; 1) echo "$(ts) RESULT WARN (investigate; no automatic rollback)";; *) echo "$(ts) RESULT FAIL -> evaluate rollback criteria (release runbook section 7)";; esac
exit "$final"
