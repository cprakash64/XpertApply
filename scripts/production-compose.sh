#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_USER="luna"
readonly EXPECTED_HOST="srv738314"
readonly REPO_ROOT="/home/luna/apps/XpertApply"
readonly ENV_FILE="${REPO_ROOT}/.env"
readonly BASE_COMPOSE="${REPO_ROOT}/docker-compose.yml"
readonly PRODUCTION_COMPOSE="${REPO_ROOT}/compose.production.yml"
readonly SAFE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

fail() {
  printf 'production-compose: %s\n' "$*" >&2
  exit 1
}

if [[ "$(id -un)" != "${EXPECTED_USER}" ]]; then
  fail "must run as ${EXPECTED_USER} (use: sudo -iu ${EXPECTED_USER} ${REPO_ROOT}/scripts/production-compose.sh ...)"
fi

[[ "$(hostname)" == "${EXPECTED_HOST}" ]] || fail "unexpected production host"

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "${script_root}" == "${REPO_ROOT}" ]] || fail "unexpected repository path: ${script_root}"
[[ "$(pwd -P)" == "${REPO_ROOT}" ]] || fail "run from the authoritative checkout: ${REPO_ROOT}"
[[ -d "${REPO_ROOT}/.git" ]] || fail "expected Git checkout is missing: ${REPO_ROOT}"
[[ -r "${ENV_FILE}" ]] || fail "production environment file is missing or unreadable"
[[ -r "${BASE_COMPOSE}" ]] || fail "base Compose file is missing or unreadable"
[[ -r "${PRODUCTION_COMPOSE}" ]] || fail "production Compose file is missing or unreadable"

# Compose gives invoking-shell variables precedence over --env-file. Run it in
# a minimal environment so host-global values (especially DATABASE_URL from
# /etc/environment) cannot override XpertApply's private production .env.
compose_command=(
  env -i
  "HOME=/home/${EXPECTED_USER}"
  "USER=${EXPECTED_USER}"
  "LOGNAME=${EXPECTED_USER}"
  "PATH=${SAFE_PATH}"
  docker compose
  --env-file "${ENV_FILE}"
  -f "${BASE_COMPOSE}"
  -f "${PRODUCTION_COMPOSE}"
)

preflight() {
  "${compose_command[@]}" config --quiet
  "${compose_command[@]}" config --format json | env -i "PATH=${SAFE_PATH}" python3 -c '
import json
import sys
from urllib.parse import urlsplit

config = json.load(sys.stdin)
if config.get("name") != "xpertapply":
    raise SystemExit("production-compose: unexpected Compose project name")

expected = {
    "web": {"host_ip": "127.0.0.1", "published": "3000", "target": 3000, "protocol": "tcp"},
    "api": {"host_ip": "127.0.0.1", "published": "8020", "target": 8000, "protocol": "tcp"},
}
for service, required in expected.items():
    ports = config.get("services", {}).get(service, {}).get("ports", [])
    normalized = [
        {key: port.get(key) for key in required}
        for port in ports
    ]
    if normalized != [required]:
        raise SystemExit(f"production-compose: unexpected {service} port mapping")

api_environment = config.get("services", {}).get("api", {}).get("environment", {})
if api_environment.get("APP_ENV") != "production":
    raise SystemExit("production-compose: API APP_ENV is not production")
if str(api_environment.get("RUN_MIGRATIONS_ON_STARTUP", "")).lower() != "false":
    raise SystemExit("production-compose: API startup migrations must be disabled")

database = urlsplit(api_environment.get("DATABASE_URL", ""))
if (
    database.scheme != "postgresql+psycopg"
    or database.hostname != "postgres"
    or database.path != "/jobpilot"
):
    raise SystemExit("production-compose: unexpected production database identity")

web_environment = config.get("services", {}).get("web", {}).get("environment", {})
if web_environment.get("NEXT_PUBLIC_API_URL") != "https://api.xpertapply.com":
    raise SystemExit("production-compose: unexpected public API URL")
if web_environment.get("NEXT_PUBLIC_SITE_URL") != "https://xpertapply.com":
    raise SystemExit("production-compose: unexpected public site URL")

print("production-compose: preflight passed (project=xpertapply web=127.0.0.1:3000 api=127.0.0.1:8020 database=postgresql+psycopg://postgres/jobpilot)")
'
}

case "${1:-preflight}" in
  preflight)
    [[ "$#" -eq 0 || "$#" -eq 1 ]] || fail "preflight accepts no additional arguments"
    preflight
    ;;
  config)
    fail "direct config output is disabled because the merged output contains secrets; use preflight"
    ;;
  -h|--help|help)
    printf '%s\n' \
      "Usage: scripts/production-compose.sh preflight" \
      "       scripts/production-compose.sh <docker compose arguments...>" \
      "" \
      "Every Compose operation runs the production preflight first."
    ;;
  *)
    preflight
    exec "${compose_command[@]}" "$@"
    ;;
esac
