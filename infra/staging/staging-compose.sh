#!/usr/bin/env bash
# Guarded Compose wrapper for the XpertApply STAGING stack only. Modelled on scripts/production-compose.sh,
# but pinned to the staging checkout, project, env file and ports. It cannot operate on production.
#
#   staging-compose.sh init-env | preflight | config-check | status | logs | up | stop | down
#                      build | migrate | alembic-info | backup | restore-test
#
# Anything else is refused. There is deliberately no volume removal, no `docker system/volume/image prune`,
# and no free-form `docker compose` passthrough.
set -euo pipefail

EXPECTED_ROOT="/home/luna/apps/XpertApply-staging"
PROD_ROOT="/home/luna/apps/XpertApply"
# Self-test hooks: honoured ONLY with XA_STAGING_SELFTEST=1, which in turn only permits read-only validation
# commands (and init-env). They let the guard tests prove the production-path and secret-reuse refusals.
if [[ "${XA_STAGING_SELFTEST:-}" == "1" ]]; then
  PROD_ROOT="${XA_STAGING_FAKE_PROD_ROOT:-${PROD_ROOT}}"
  EXPECTED_ROOT="${XA_STAGING_FAKE_EXPECTED_ROOT:-${EXPECTED_ROOT}}"
fi
readonly EXPECTED_ROOT PROD_ROOT
readonly PROD_ENV="${PROD_ROOT}/.env"
readonly PROJECT="xpertapply-staging"
readonly SAFE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

fail() { printf 'staging-compose: %s\n' "$*" >&2; exit 1; }

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly STAGING_DIR="${script_root}/infra/staging"
readonly ENV_FILE="${STAGING_DIR}/.env.staging"
readonly COMPOSE_FILE="${STAGING_DIR}/compose.staging.yml"
readonly GUARD="${STAGING_DIR}/staging_guard.py"

command_name="${1:-help}"
shift || true

# ---- 1. Where am I? --------------------------------------------------------------------------------------
if [[ "${script_root}" == "${PROD_ROOT}" || "${script_root}" == "${PROD_ROOT}/"* ]]; then
  fail "refusing to run from the production checkout (${script_root})"
fi
if [[ "${script_root}" != "${EXPECTED_ROOT}" ]]; then
  # A different path is allowed for local self-tests ONLY, and then only for read-only validation.
  if [[ "${XA_STAGING_SELFTEST:-}" == "1" && ( "${command_name}" == "preflight" || "${command_name}" == "config-check" || "${command_name}" == "init-env" ) ]]; then
    :
  else
    fail "unexpected checkout path ${script_root}; expected ${EXPECTED_ROOT}"
  fi
fi
[[ "$(id -u)" != "0" ]] || fail "do not run as root"
[[ -r "${COMPOSE_FILE}" && -r "${GUARD}" ]] || fail "staging files are missing"

# ---- 2. Is Docker pointed where I think it is? -----------------------------------------------------------
require_local_docker() {
  [[ -z "${DOCKER_HOST:-}" ]] || fail "DOCKER_HOST is set; staging runs only against the local default Docker context"
  [[ -z "${DOCKER_CONTEXT:-}" ]] || fail "DOCKER_CONTEXT is set; staging runs only against the local default Docker context"
  local ctx
  ctx="$(env -i "HOME=${HOME}" "PATH=${SAFE_PATH}" docker context show 2>/dev/null || true)"
  [[ "${ctx}" == "default" ]] || fail "Docker context is '${ctx:-unknown}', expected 'default'"
}

# Compose gives invoking-shell variables precedence over --env-file, so run it with a minimal environment:
# nothing from the host (DATABASE_URL, a production SECRET_KEY, ...) can override the staging file.
compose() {
  env -i "HOME=${HOME}" "USER=${USER:-staging}" "PATH=${SAFE_PATH}" \
    docker compose --project-name "${PROJECT}" --project-directory "${STAGING_DIR}" \
    --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

env_value() { grep -E "^$1=" "${ENV_FILE}" | head -1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'; }

# ---- 3. Static checks (no containers touched) ------------------------------------------------------------
static_checks() {
  [[ -r "${ENV_FILE}" ]] || fail "${ENV_FILE} is missing; run: infra/staging/staging-compose.sh init-env"
  python3 "${GUARD}" env-file "${ENV_FILE}" "${PROD_ENV}" || fail "environment file refused (see messages above)"
  compose config --quiet || fail "Compose configuration does not render"
  compose --profile workers --profile web config --format json | python3 "${GUARD}" rendered-config \
    || fail "rendered configuration refused (see messages above)"
}

port_in_use_by_other() {
  # Read-only. A staging container may already own the port; anything else owning it is a conflict.
  local port="$1" listener
  if command -v ss >/dev/null 2>&1; then
    listener="$(ss -ltnH "sport = :${port}" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    listener="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  else
    fail "cannot check port ${port}: neither ss nor lsof is available"
  fi
  [[ -z "${listener}" ]] && return 1
  env -i "HOME=${HOME}" "PATH=${SAFE_PATH}" docker ps --filter "name=xpertapply-staging-" --format '{{.Ports}}' 2>/dev/null \
    | grep -q "127.0.0.1:${port}->" && return 1
  return 0
}

port_checks() {
  local p
  for p in "$(env_value STAGING_API_PORT)" "$(env_value STAGING_WEB_PORT)"; do
    if port_in_use_by_other "${p}"; then fail "host port ${p} is already in use by something that is not staging"; fi
  done
}

# ---- 4. Commands -----------------------------------------------------------------------------------------
case "${command_name}" in
  help|-h|--help)
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;

  init-env)
    [[ ! -e "${ENV_FILE}" ]] || fail "${ENV_FILE} already exists; it is never overwritten"
    umask 077
    python3 - "${STAGING_DIR}/staging.env.example" "${ENV_FILE}" <<'PY'
import base64, secrets, sys
src, dst = sys.argv[1:3]
def token(n): return secrets.token_hex(n)
def fernet(): return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
gen = {"SECRET_KEY": token(32), "POSTGRES_PASSWORD": token(16), "REDIS_PASSWORD": token(16),
       "WORKDAY_CREDENTIALS_ENCRYPTION_KEY": fernet(), "PEOPLE_DATA_ENCRYPTION_KEY": fernet()}
out = []
for line in open(src, encoding="utf-8"):
    key, sep, value = line.rstrip("\n").partition("=")
    out.append(f"{key}={gen[key]}" if sep and key in gen else line.rstrip("\n"))
open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
    chmod 600 "${ENV_FILE}"
    printf 'staging-compose: wrote %s (mode 600). Secrets were generated and not displayed.\n' "${ENV_FILE}"
    printf 'Next: set EXTENSION_ALLOWED_IDS (and, only if wanted, STAGING_AI_MODE/OPENAI_API_KEY), then run preflight.\n'
    ;;

  preflight|config-check)
    static_checks
    if [[ "${XA_STAGING_SELFTEST:-}" != "1" ]]; then require_local_docker; port_checks; fi
    printf 'staging-compose: %s passed (project=%s api=127.0.0.1:%s web=127.0.0.1:%s database=%s)\n' \
      "${command_name}" "${PROJECT}" "$(env_value STAGING_API_PORT)" "$(env_value STAGING_WEB_PORT)" "$(env_value POSTGRES_DB)"
    ;;

  status)
    static_checks; require_local_docker
    compose --profile workers --profile web ps
    ;;

  logs)
    static_checks; require_local_docker
    tail_n=100; since="10m"; services=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --tail) tail_n="${2:?--tail needs a number}"; shift 2 ;;
        --since) since="${2:?--since needs a duration}"; shift 2 ;;
        postgres|redis|api|worker|scheduler|web) services+=("$1"); shift ;;
        *) fail "logs accepts --tail N, --since DURATION and service names only" ;;
      esac
    done
    [[ "${tail_n}" =~ ^[0-9]+$ && "${tail_n}" -le 500 ]] || fail "--tail must be a number <= 500"
    compose --profile workers --profile web logs --no-color --since "${since}" --tail "${tail_n}" ${services[@]+"${services[@]}"}
    ;;

  build)
    static_checks; require_local_docker
    targets=(api)
    [[ "${1:-}" == "--with-web" ]] && targets+=(web)
    compose --profile web build "${targets[@]}"
    ;;

  up)
    static_checks; require_local_docker; port_checks
    services=(postgres redis api); profiles=()
    for arg in "$@"; do
      case "${arg}" in
        --with-workers) profiles+=(--profile workers); services+=(worker scheduler) ;;
        --with-web) profiles+=(--profile web); services+=(web) ;;
        *) fail "up accepts --with-workers and --with-web only" ;;
      esac
    done
    compose ${profiles[@]+"${profiles[@]}"} up -d "${services[@]}"
    ;;

  stop)
    static_checks; require_local_docker
    compose --profile workers --profile web stop
    ;;

  down)
    for arg in "$@"; do
      case "${arg}" in
        -v|--volumes|--rmi|--rmi=*|--remove-orphans) fail "down never removes volumes, images or orphans (${arg} refused)" ;;
        *) fail "down takes no arguments" ;;
      esac
    done
    static_checks; require_local_docker
    # Removes the staging containers and networks only; the named volumes (and so the data) are kept.
    compose --profile workers --profile web down
    ;;

  alembic-info)
    static_checks; require_local_docker
    compose exec -T api alembic heads
    compose exec -T api alembic current
    ;;

  backup)
    static_checks; require_local_docker
    dir="$(env_value STAGING_BACKUP_DIR)"
    [[ "${dir}" != "${PROD_ROOT}"* && "${dir}" == /* ]] || fail "STAGING_BACKUP_DIR must be an absolute path outside the production checkout"
    umask 077; mkdir -p "${dir}"; chmod 700 "${dir}"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"; file="${dir}/xpertapply-staging-${stamp}.dump"
    compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "${file}"
    [[ -s "${file}" ]] || { rm -f "${file}"; fail "backup came out empty and was discarded"; }
    ( cd "${dir}" && { sha256sum "$(basename "${file}")" 2>/dev/null || shasum -a 256 "$(basename "${file}")"; } > "$(basename "${file}").sha256" )
    chmod 600 "${file}" "${file}.sha256"
    printf 'staging-compose: backup %s (%s bytes)\nsha256: %s\n' "${file}" "$(wc -c < "${file}" | tr -d ' ')" "$(cut -d' ' -f1 "${file}.sha256")"
    ;;

  restore-test)
    static_checks; require_local_docker
    file="${1:?usage: restore-test <backup .dump file>}"
    [[ -r "${file}" && -r "${file}.sha256" ]] || fail "backup or its .sha256 is missing"
    ( cd "$(dirname "${file}")" && { sha256sum -c "$(basename "${file}").sha256" >/dev/null 2>&1 || shasum -a 256 -c "$(basename "${file}").sha256" >/dev/null 2>&1; } ) \
      || fail "backup checksum does not match"
    scratch="xa_restore_test_$(date -u +%Y%m%d%H%M%S)"
    [[ "${scratch}" =~ ^xa_restore_test_[0-9]{14}$ ]] || fail "internal: bad scratch database name"
    compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE ${scratch}'"
    status=0
    compose exec -T postgres sh -c "pg_restore -U \"\$POSTGRES_USER\" -d ${scratch} --no-owner --exit-on-error" < "${file}" || status=$?
    if [[ "${status}" -eq 0 ]]; then
      compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d ${scratch} -At -c \"select 'tables='||count(*) from information_schema.tables where table_schema='public'\" -c \"select 'alembic='||coalesce((select version_num from alembic_version limit 1),'none')\"" || status=$?
    fi
    # Drops only the disposable database created above (name verified by the regex), never the staging one.
    compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -c 'DROP DATABASE IF EXISTS ${scratch}'" || true
    [[ "${status}" -eq 0 ]] || fail "restore test FAILED"
    printf 'staging-compose: restore test passed for %s\n' "$(basename "${file}")"
    ;;

  migrate)
    static_checks; require_local_docker
    dir="$(env_value STAGING_BACKUP_DIR)"
    fresh="$(find "${dir}" -maxdepth 1 -name 'xpertapply-staging-*.dump' -mmin -1440 2>/dev/null | head -1 || true)"
    [[ -n "${fresh}" && -r "${fresh}.sha256" ]] \
      || fail "no staging backup newer than 24h with a checksum in ${dir}; run: backup, then restore-test"
    compose exec -T api alembic heads
    compose exec -T api alembic upgrade head
    compose exec -T api alembic current
    ;;

  *)
    fail "command '${command_name}' is not permitted (allowed: init-env preflight config-check status logs build up stop down alembic-info backup restore-test migrate)"
    ;;
esac
