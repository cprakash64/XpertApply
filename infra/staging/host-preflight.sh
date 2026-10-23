#!/usr/bin/env bash
# READ-ONLY host assessment: may staging share this machine with production?
# Changes nothing: no docker run/pull/build, no file writes, no nginx reload, no certbot. Run it on the
# candidate host as the deployment user, from the staging checkout:
#     infra/staging/host-preflight.sh
#
# Each line is   OK | STOP | NOT VERIFIED   <check>: <detail>
# Exit status:   0 every check OK   1 at least one STOP (same-VPS deployment BLOCKED)
#                2 no STOP, but something could not be measured (treat as NOT VERIFIED; do not proceed)
#
# Thresholds come from the staging stack's own budget (compose.staging.yml), not from a guess:
#   RAM   = sum of the container mem_limits (postgres 512 + redis 128 + api 768 = 1408 MB, +worker/scheduler
#           768 MB and web 512 MB when enabled)  + 512 MB for the OS/Docker build + 25% headroom so production
#           is not pushed into swap.                    => MemAvailable must be >= 1.25 * (1408 + 512) = 2400 MB
#   DISK  = images (api ~1 GB, postgres+redis ~0.4 GB; ESTIMATES, replace with `docker image ls` after the first
#           build) + build cache 2 GB + volumes 1 GB + two backups 1 GB => 6 GB, doubled for slack => 12 GB free
#           on the Docker root, and the Docker root filesystem must stay under 80% used afterwards.
#   CPU   = staging is capped at 1 core for the API and 1 for Postgres; the 15-minute load average must be
#           <= 60% of the core count so that production keeps >= 40% headroom while staging builds.
# These figures are budgets to be corrected with measurements, not measurements.
set -uo pipefail

readonly PROD_PROJECT="xpertapply"
readonly PROD_API_PORT=8020
readonly PROD_WEB_PORT=3000
readonly STAGING_PORTS=(8021 3001)
readonly STAGING_HOSTS=(staging.xpertapply.com api-staging.xpertapply.com)
readonly MIN_RAM_MB=2400
readonly MIN_DISK_GB=12
readonly MAX_DISK_USED_PCT=80
readonly MAX_LOAD_FRACTION=0.60

stop=0; unknown=0
ok()   { printf 'OK            %s\n' "$*"; }
halt() { printf 'STOP          %s\n' "$*"; stop=1; }
nv()   { printf 'NOT VERIFIED  %s\n' "$*"; unknown=1; }
have() { command -v "$1" >/dev/null 2>&1; }

printf '== host ==\n'
printf 'host=%s user=%s kernel=%s\n' "$(hostname)" "$(id -un)" "$(uname -sr)"

# ---- Docker -----------------------------------------------------------------------------------------------
printf '== docker ==\n'
if ! have docker; then halt "docker: not installed"; else
  if docker info >/dev/null 2>&1; then ok "docker: daemon reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
  else nv "docker: daemon not reachable by this user"; fi
  docker compose version >/dev/null 2>&1 && ok "docker compose: $(docker compose version --short 2>/dev/null)" || halt "docker compose v2 plugin missing"
fi

# ---- Disk ---------------------------------------------------------------------------------------------------
printf '== disk ==\n'
root_dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
if [[ -z "${root_dir}" ]]; then nv "docker root dir: unknown"; root_dir="/"; fi
if read -r avail_kb pct < <(df -Pk "${root_dir}" 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $4, $5}'); then
  avail_gb=$(( avail_kb / 1024 / 1024 ))
  if (( avail_gb < MIN_DISK_GB )); then halt "disk: ${avail_gb} GB free on ${root_dir}, need >= ${MIN_DISK_GB} GB"
  else ok "disk: ${avail_gb} GB free on ${root_dir} (need >= ${MIN_DISK_GB})"; fi
  (( pct > MAX_DISK_USED_PCT )) && halt "disk: ${pct}% used on ${root_dir}, limit ${MAX_DISK_USED_PCT}%" || ok "disk: ${pct}% used (limit ${MAX_DISK_USED_PCT}%)"
else nv "disk: could not read df for ${root_dir}"; fi
if docker system df >/dev/null 2>&1; then printf '%s\n' "$(docker system df 2>/dev/null | sed 's/^/              /')"; else nv "docker storage usage: unreadable"; fi

# ---- Memory and CPU -------------------------------------------------------------------------------------------
printf '== memory / cpu ==\n'
if [[ -r /proc/meminfo ]]; then
  avail_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  swap_used_mb=$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{print int((t-f)/1024)}' /proc/meminfo)
  (( avail_mb < MIN_RAM_MB )) && halt "ram: ${avail_mb} MB available, need >= ${MIN_RAM_MB} MB" || ok "ram: ${avail_mb} MB available (need >= ${MIN_RAM_MB})"
  (( swap_used_mb > 256 )) && halt "swap: ${swap_used_mb} MB already in use; the host is memory-constrained" || ok "swap: ${swap_used_mb} MB in use"
else nv "ram: /proc/meminfo unreadable (non-Linux host?)"; fi
cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"
if [[ -r /proc/loadavg && "${cores}" -gt 0 ]]; then
  load15="$(awk '{print $3}' /proc/loadavg)"
  limit="$(awk -v c="${cores}" -v f="${MAX_LOAD_FRACTION}" 'BEGIN{printf "%.2f", c*f}')"
  awk -v l="${load15}" -v m="${limit}" 'BEGIN{exit !(l>m)}' && halt "cpu: 15-min load ${load15} exceeds ${limit} (${MAX_LOAD_FRACTION} x ${cores} cores)" \
    || ok "cpu: 15-min load ${load15} <= ${limit} (${cores} cores)"
else nv "cpu: load average or core count unreadable"; fi

# ---- Production must be healthy and untouched ---------------------------------------------------------------------
printf '== production (read-only) ==\n'
if have curl; then
  curl -fsS --max-time 5 "http://127.0.0.1:${PROD_API_PORT}/healthz" >/dev/null 2>&1 \
    && ok "production api: /healthz on 127.0.0.1:${PROD_API_PORT} answers" \
    || halt "production api: /healthz on 127.0.0.1:${PROD_API_PORT} does not answer; do not add load to an unhealthy host"
else nv "production api: curl not installed"; fi
if docker info >/dev/null 2>&1; then
  running="$(docker ps --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | sort | uniq -c | tr '\n' ' ')"
  ok "running compose projects: ${running:-none}"
  docker ps --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -qx "${PROD_PROJECT}" \
    && ok "production project '${PROD_PROJECT}' is running" || nv "production project '${PROD_PROJECT}' not seen running (is this the right host?)"
  if docker ps --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -qx "xpertapply-staging"; then
    nv "a staging project is already running here; this is a re-check, not a first install"
  fi
  vols="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -c '^xpertapply-staging-' || true)"
  (( vols > 0 )) && nv "${vols} staging volume(s) already exist: data from an earlier install would be reused" || ok "no staging volumes exist yet"
  nets="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -c '^xpertapply-staging-' || true)"
  (( nets > 0 )) && nv "${nets} staging network(s) already exist" || ok "no staging networks exist yet"
  # Subnet overlap: a new bridge network picks from the same pool as existing ones.
  printf '              existing networks: %s\n' "$(docker network ls --format '{{.Name}}' 2>/dev/null | tr '\n' ' ')"
fi

# ---- Ports -------------------------------------------------------------------------------------------------------------
printf '== ports ==\n'
listeners=""
if have ss; then listeners="$(ss -ltnH 2>/dev/null)"; elif have lsof; then listeners="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null)"; else nv "ports: neither ss nor lsof available"; fi
if [[ -n "${listeners}" ]]; then
  for port in "${STAGING_PORTS[@]}"; do
    printf '%s\n' "${listeners}" | grep -Eq "[:.]${port}[[:space:]]" && halt "port ${port} already has a listener" || ok "port ${port} is free"
  done
  printf '%s\n' "${listeners}" | grep -Eq "(0\.0\.0\.0|\[::\]|\*):(5432|6379)[[:space:]]" \
    && halt "PostgreSQL or Redis is listening on a public address on this host" || ok "no public PostgreSQL/Redis listener"
fi

# ---- Nginx / TLS conflicts (read-only) ---------------------------------------------------------------------------------------
printf '== nginx / tls (read-only) ==\n'
if [[ -d /etc/nginx ]] && [[ -r /etc/nginx/nginx.conf ]]; then
  conflicts=0
  for host in "${STAGING_HOSTS[@]}"; do
    if grep -RIl --include='*' -e "server_name[^;]*${host}" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -q .; then
      halt "nginx: ${host} is already declared in an active server block"; conflicts=1
    fi
  done
  (( conflicts == 0 )) && ok "nginx: no active server block names the staging hosts"
  grep -RIq "default_server" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null \
    && ok "nginx: a default_server exists (unknown hosts will not fall into production)" \
    || nv "nginx: no default_server found; verify unknown Host headers cannot reach a production vhost"
else nv "nginx: /etc/nginx not readable by this user"; fi
for host in "${STAGING_HOSTS[@]}"; do
  if [[ -d "/etc/letsencrypt/live/${host}" ]]; then nv "tls: a certificate directory for ${host} already exists"; else ok "tls: no existing certificate for ${host}"; fi
done
for host in "${STAGING_HOSTS[@]}"; do
  if have getent; then
    resolved="$(getent hosts "${host}" 2>/dev/null | awk '{print $1}' | head -1)"
    [[ -n "${resolved}" ]] && printf '              dns: %s -> %s\n' "${host}" "${resolved}" || printf '              dns: %s does not resolve yet (expected before the DNS step)\n' "${host}"
  fi
done

printf '== result ==\n'
if (( stop )); then printf 'STOP: same-VPS deployment BLOCKED. Fix the STOP lines or use a separate machine.\n'; exit 1
elif (( unknown )); then printf 'NOT VERIFIED: some capacity could not be measured; do not deploy to this host until it is.\n'; exit 2
else printf 'OK: measured capacity is sufficient for staging alongside production.\n'; exit 0; fi
