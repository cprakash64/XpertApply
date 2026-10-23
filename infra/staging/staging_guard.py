#!/usr/bin/env python3
"""Static guardrails for the staging stack. Standard library only; never prints a secret value.

  staging_guard.py env-file <env file> [<production .env to compare against>]
  staging_guard.py rendered-config            (reads `docker compose config --format json` on stdin)

Exit status 0 = accepted, 1 = refused (reasons on stderr, naming settings, never values).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys

PROJECT = "xpertapply-staging"
PREFIX = "xpertapply-staging-"
PROD_ROOT = "/home/luna/apps/XpertApply"
FORBIDDEN_PUBLISHED_PORTS = {20, 21, 22, 25, 80, 443, 3000, 5432, 6379, 8000, 8020}
ALLOWED_SERVICES = {"postgres", "redis", "api", "worker", "scheduler", "web"}
EXTENSION_ID = re.compile(r"^[a-p]{32}$")
KNOWN_WEAK = {
    "dev-only-change-me", "change-me", "changeme", "secret", "secret-key", "dev", "development", "test", "jobpilot",
    "jobpilot_dev_password", "postgres", "password", "passwd", "admin", "root", "please-change-this",
}
REQUIRED = (
    "APP_ENV", "STAGING_API_HOST", "STAGING_WEB_HOST", "STAGING_API_PORT", "STAGING_WEB_PORT", "SECRET_KEY",
    "POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "WORKDAY_CREDENTIALS_ENCRYPTION_KEY",
    "PEOPLE_DATA_ENCRYPTION_KEY", "EXTENSION_ALLOWED_IDS", "CORS_ORIGINS", "STAGING_AI_MODE", "STAGING_BACKUP_DIR",
)
# Settings that must never equal the production value.
MUST_DIFFER_FROM_PRODUCTION = (
    "SECRET_KEY", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "WORKDAY_CREDENTIALS_ENCRYPTION_KEY",
    "PEOPLE_DATA_ENCRYPTION_KEY", "DEMOGRAPHICS_ENCRYPTION_KEY", "OPENAI_API_KEY",
)


def parse_env(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def check_env_file(path: str, production_env: str | None) -> list[str]:
    problems: list[str] = []
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        problems.append(f"{os.path.basename(path)} must not be readable by group/others (chmod 600)")
    env = parse_env(path)
    for key in REQUIRED:
        if not env.get(key):
            problems.append(f"{key} is missing or empty")
    for key, value in env.items():
        if "REPLACE_ME" in value:
            problems.append(f"{key} still holds the REPLACE_ME placeholder")
    if env.get("APP_ENV") != "staging":
        problems.append("APP_ENV must be exactly 'staging'")
    if env.get("STAGING_API_HOST") != "api-staging.xpertapply.com":
        problems.append("STAGING_API_HOST must be api-staging.xpertapply.com")
    if env.get("STAGING_WEB_HOST") != "staging.xpertapply.com":
        problems.append("STAGING_WEB_HOST must be staging.xpertapply.com")
    for key in ("STAGING_API_PORT", "STAGING_WEB_PORT"):
        value = env.get(key, "")
        if not value.isdigit() or not (1024 <= int(value) <= 65535) or int(value) in FORBIDDEN_PUBLISHED_PORTS:
            problems.append(f"{key} must be an unprivileged port that production and databases do not use")
    if env.get("STAGING_API_PORT") and env.get("STAGING_API_PORT") == env.get("STAGING_WEB_PORT"):
        problems.append("STAGING_API_PORT and STAGING_WEB_PORT must differ")
    secret = env.get("SECRET_KEY", "")
    if secret and (len(secret) < 32 or len(set(secret)) < 8 or secret.lower() in KNOWN_WEAK):
        problems.append("SECRET_KEY is too short, too uniform, or a documented default")
    for key in ("POSTGRES_PASSWORD", "REDIS_PASSWORD"):
        value = env.get(key, "")
        if value and (len(value) < 24 or value.lower() in KNOWN_WEAK or not re.fullmatch(r"[A-Za-z0-9_\-]+", value)):
            problems.append(f"{key} must be >=24 URL-safe characters and not a known default")
    for key in ("WORKDAY_CREDENTIALS_ENCRYPTION_KEY", "PEOPLE_DATA_ENCRYPTION_KEY"):
        if env.get(key) and len(env[key]) < 32:
            problems.append(f"{key} is too short")
    if env.get("POSTGRES_USER") in {"jobpilot", "postgres"} or env.get("POSTGRES_DB") == "jobpilot":
        problems.append("POSTGRES_USER/POSTGRES_DB must not reuse the production or development names")
    try:
        ids = json.loads(env.get("EXTENSION_ALLOWED_IDS", "[]"))
        if (
            not isinstance(ids, list) or not ids or len(ids) > 5 or len(set(ids)) != len(ids)
            or not all(isinstance(i, str) and EXTENSION_ID.match(i) for i in ids)
        ):
            raise ValueError
    except (ValueError, TypeError):
        problems.append("EXTENSION_ALLOWED_IDS must be a JSON list of 1-5 distinct 32-character a-p extension ids")
    try:
        origins = json.loads(env.get("CORS_ORIGINS", "[]"))
        if origins != [f"https://{env.get('STAGING_WEB_HOST', '')}"]:
            raise ValueError
    except (ValueError, TypeError):
        problems.append("CORS_ORIGINS must be exactly the staging web origin (no wildcard, no production origin)")
    mode_ai = env.get("STAGING_AI_MODE")
    if mode_ai == "disabled" and env.get("OPENAI_API_KEY"):
        problems.append("STAGING_AI_MODE=disabled but OPENAI_API_KEY is set")
    elif mode_ai == "capped" and not (env.get("OPENAI_API_KEY") and env.get("STAGING_AI_CAP_NOTE")):
        problems.append("STAGING_AI_MODE=capped needs OPENAI_API_KEY and STAGING_AI_CAP_NOTE (the provider-side spend cap)")
    elif mode_ai not in {"disabled", "capped"}:
        problems.append("STAGING_AI_MODE must be 'disabled' or 'capped'")
    joined = "\n".join(env.values())
    if PROD_ROOT + "/" in joined or "@postgres:5432/jobpilot" in joined or "api.xpertapply.com" in joined.replace(
        "api-staging.xpertapply.com", ""
    ):
        problems.append("a value points at a production path, database or hostname")
    if production_env:
        try:
            prod = parse_env(production_env)
        except OSError:
            print("staging_guard: production .env not readable here; secret-reuse comparison skipped", file=sys.stderr)
        else:
            for key in MUST_DIFFER_FROM_PRODUCTION:
                if env.get(key) and prod.get(key) and _digest(env[key]) == _digest(prod[key]):
                    problems.append(f"{key} equals the production value")
    return problems


def check_rendered(config: dict) -> list[str]:
    problems: list[str] = []
    if config.get("name") != PROJECT:
        problems.append(f"Compose project name must be {PROJECT}")
    services = config.get("services", {})
    for name in services:
        if name not in ALLOWED_SERVICES:
            problems.append(f"unexpected service {name}")
    for required in ("postgres", "redis", "api"):
        if required not in services:
            problems.append(f"missing service {required}")
    for name, svc in services.items():
        if svc.get("privileged"):
            problems.append(f"{name} is privileged")
        if svc.get("network_mode") == "host" or svc.get("pid") == "host" or svc.get("ipc") == "host":
            problems.append(f"{name} shares a host namespace")
        if svc.get("cap_add"):
            problems.append(f"{name} adds capabilities")
        if svc.get("env_file"):
            problems.append(f"{name} uses env_file (every variable must be listed explicitly)")
        if not str(svc.get("container_name", "")).startswith(PREFIX):
            problems.append(f"{name} container_name must start with {PREFIX}")
        if not svc.get("mem_limit"):
            problems.append(f"{name} has no memory limit")
        if "no-new-privileges:true" not in (svc.get("security_opt") or []):
            problems.append(f"{name} does not set no-new-privileges")
        for volume in svc.get("volumes", []) or []:
            # `source` is the compose key; the real Docker volume name is the top-level entry's `name`.
            declared = (config.get("volumes") or {}).get(str(volume.get("source", ""))) or {}
            source = str(declared.get("name", volume.get("source", "")))
            if volume.get("type") != "volume" or not source.startswith(PREFIX):
                problems.append(f"{name} mounts something other than a staging-named volume")
            if "docker.sock" in source or "docker.sock" in str(volume.get("target", "")):
                problems.append(f"{name} mounts the Docker socket")
        for port in svc.get("ports", []) or []:
            published = int(port.get("published") or 0)
            if port.get("host_ip") != "127.0.0.1":
                problems.append(f"{name} publishes a port on a non-loopback address")
            if published in FORBIDDEN_PUBLISHED_PORTS:
                problems.append(f"{name} publishes a reserved/production port")
        nets = set((svc.get("networks") or {}).keys()) if isinstance(svc.get("networks"), dict) else set(svc.get("networks") or [])
        if not nets <= {"internal", "edge"}:
            problems.append(f"{name} is attached to an unexpected network")
        if name in {"postgres", "redis"}:
            if svc.get("ports"):
                problems.append(f"{name} must not publish ports")
            if nets != {"internal"}:
                problems.append(f"{name} must be on the internal network only")
    for key, volume in (config.get("volumes") or {}).items():
        if not str((volume or {}).get("name", "")).startswith(PREFIX) or (volume or {}).get("external"):
            problems.append(f"volume {key} must be a staging-named, non-external volume")
    for key, network in (config.get("networks") or {}).items():
        if not str((network or {}).get("name", "")).startswith(PREFIX) or (network or {}).get("external"):
            problems.append(f"network {key} must be a staging-named, non-external network")
    internal = (config.get("networks") or {}).get("internal") or {}
    if internal.get("internal") is not True:
        problems.append("the internal network must be internal (no outbound route)")
    api_env = (services.get("api") or {}).get("environment") or {}
    if api_env.get("APP_ENV") != "staging":
        problems.append("api APP_ENV is not staging")
    if str(api_env.get("RUN_MIGRATIONS_ON_STARTUP", "")).lower() != "false":
        problems.append("api startup migrations must be disabled")
    db = api_env.get("DATABASE_URL", "")
    if "@postgres:5432/" not in db or db.rstrip("/").endswith("/jobpilot"):
        problems.append("api DATABASE_URL does not point at the staging database")
    return problems


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[1] == "env-file":
        problems = check_env_file(argv[2], argv[3] if len(argv) > 3 else None)
    elif len(argv) == 2 and argv[1] == "rendered-config":
        problems = check_rendered(json.load(sys.stdin))
    else:
        print(__doc__, file=sys.stderr)
        return 2
    for problem in problems:
        print(f"staging_guard: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
