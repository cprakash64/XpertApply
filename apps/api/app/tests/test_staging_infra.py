# ruff: noqa: E501
"""Guardrail tests for the staging stack (infra/staging). Local and side-effect free: they render Compose
configuration and run the wrapper in its read-only self-test mode; no container is built or started."""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[4]
STAGING = ROOT / "infra" / "staging"
EXT_ID = "abcdefghijklmnopabcdefghijklmnop"
HAS_DOCKER = shutil.which("docker") is not None and subprocess.run(
    ["docker", "compose", "version"], capture_output=True
).returncode == 0

sys.path.insert(0, str(STAGING))
import staging_guard as guard  # noqa: E402


@pytest.fixture()
def tree(tmp_path: Path) -> Path:
    """A copy of the staging files at a path named like the real checkout, with a fake 'production' beside it."""
    root = tmp_path / "apps" / "XpertApply-staging"
    shutil.copytree(STAGING, root / "infra" / "staging", ignore=shutil.ignore_patterns(".env.staging", "__pycache__"))
    (root / "apps").mkdir()
    return root


def run(tree: Path, *args: str, prod: Path | None = None, selftest: bool = True, extra: dict | None = None):
    env = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "USER": "tester"}
    if selftest:
        env["XA_STAGING_SELFTEST"] = "1"
        env["XA_STAGING_FAKE_EXPECTED_ROOT"] = str(tree.resolve())
        env["XA_STAGING_FAKE_PROD_ROOT"] = str((prod or tree.parent / "apps" / "XpertApply").resolve())
    env.update(extra or {})
    return subprocess.run(
        [str(tree / "infra" / "staging" / "staging-compose.sh"), *args], capture_output=True, text=True, env=env, cwd=tree
    )


def make_env(tree: Path, **overrides: str) -> Path:
    assert run(tree, "init-env").returncode == 0
    path = tree / "infra" / "staging" / ".env.staging"
    text = path.read_text().replace('["REPLACE_ME"]', json.dumps([EXT_ID]))
    for key, value in overrides.items():
        text = re.sub(rf"^{key}=.*$", f"{key}={value}", text, flags=re.M)
    path.write_text(text)
    return path


# ---- static files ------------------------------------------------------------------------------------------------
def test_scripts_parse() -> None:
    for script in ("staging-compose.sh", "host-preflight.sh"):
        assert subprocess.run(["bash", "-n", str(STAGING / script)]).returncode == 0
    compile((STAGING / "staging_guard.py").read_text(), "staging_guard.py", "exec")


def test_compose_is_valid_yaml_with_the_expected_shape() -> None:
    data = yaml.safe_load((STAGING / "compose.staging.yml").read_text())
    assert data["name"] == "xpertapply-staging"
    assert {"postgres", "redis", "api", "worker", "scheduler", "web"} == set(data["services"])
    for name in ("worker", "scheduler", "web"):
        assert data["services"][name]["profiles"], f"{name} must not start by default"
    assert all(v["name"].startswith("xpertapply-staging-") for v in data["volumes"].values())
    assert all(n["name"].startswith("xpertapply-staging-") for n in data["networks"].values())
    assert data["networks"]["internal"]["internal"] is True
    for name in ("postgres", "redis"):
        assert "ports" not in data["services"][name]


def code_only(path: Path) -> str:
    return "\n".join(line.split(" #")[0] for line in path.read_text().splitlines() if not line.strip().startswith("#"))


def test_compose_mentions_nothing_of_production() -> None:
    code = code_only(STAGING / "compose.staging.yml")
    for needle in ("/home/luna", "docker.sock", "privileged", "network_mode", "env_file", "0.0.0.0", ":8020", ":3000:", "jobpilot"):
        assert needle not in code, needle


def test_every_required_compose_variable_is_in_the_template() -> None:
    required = set(re.findall(r"\$\{([A-Z_]+):\?", code_only(STAGING / "compose.staging.yml")))
    template = {
        line.split("=", 1)[0] for line in (STAGING / "staging.env.example").read_text().splitlines()
        if "=" in line and not line.startswith("#")
    }
    assert required <= template, required - template
    assert set(guard.REQUIRED) <= template, set(guard.REQUIRED) - template


def test_template_holds_placeholders_not_secrets() -> None:
    values = dict(
        line.split("=", 1) for line in (STAGING / "staging.env.example").read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    for key in ("SECRET_KEY", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "WORKDAY_CREDENTIALS_ENCRYPTION_KEY", "PEOPLE_DATA_ENCRYPTION_KEY"):
        assert values[key] == "REPLACE_ME"
    assert values["OPENAI_API_KEY"] == "" and values["STAGING_AI_MODE"] == "disabled" and values["APP_ENV"] == "staging"
    assert "jobpilot" not in (STAGING / "staging.env.example").read_text().lower().replace("jobpilot.", "")


def test_nginx_templates_are_exact_host_loopback_only_and_balanced() -> None:
    expectations = {
        "api-staging.xpertapply.com": "127.0.0.1:8021",
        "staging.xpertapply.com": "127.0.0.1:3001",
    }
    for host, upstream in expectations.items():
        tls = (STAGING / "nginx" / f"{host}.conf").read_text()
        boot = (STAGING / "nginx" / f"{host}.http-bootstrap.conf").read_text()
        for text in (tls, boot):
            assert text.count("{") == text.count("}")
            assert f"server_name {host};" in text
            assert "default_server" not in text.replace("never default_server", "")
            assert not re.search(r"server_name[^;]*(?<!-)\bapi\.xpertapply\.com", text.replace(host, ""))
        assert f"proxy_pass http://{upstream};" in tls
        assert "return 301 https://" in tls and "ssl_certificate " in tls and "X-Forwarded-Proto" in tls
        assert "includeSubDomains" not in "\n".join(  # must not pin the production parent domain
            line for line in tls.splitlines() if not line.strip().startswith("#"))
        assert "proxy_pass" not in boot


# ---- guard: env file ---------------------------------------------------------------------------------------------
@pytest.mark.skipif(not HAS_DOCKER, reason="docker CLI not available")
def test_generated_environment_passes_and_prints_no_secret(tree: Path) -> None:
    path = make_env(tree)
    secret = re.search(r"^SECRET_KEY=(.+)$", path.read_text(), re.M).group(1)
    ok = run(tree, "preflight")
    assert ok.returncode == 0, ok.stderr
    assert secret not in ok.stdout + ok.stderr
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert run(tree, "init-env").returncode != 0  # never overwrites


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"SECRET_KEY": "short"}, "SECRET_KEY"),
        ({"SECRET_KEY": "jobpilot"}, "SECRET_KEY"),
        ({"POSTGRES_PASSWORD": "jobpilot_dev_password"}, "POSTGRES_PASSWORD"),
        ({"POSTGRES_USER": "jobpilot"}, "POSTGRES_USER"),
        ({"APP_ENV": "production"}, "APP_ENV"),
        ({"STAGING_API_HOST": "api.xpertapply.com"}, "STAGING_API_HOST"),
        ({"STAGING_API_PORT": "8020"}, "STAGING_API_PORT"),
        ({"STAGING_WEB_PORT": "3000"}, "STAGING_WEB_PORT"),
        ({"EXTENSION_ALLOWED_IDS": "[]"}, "EXTENSION_ALLOWED_IDS"),
        ({"EXTENSION_ALLOWED_IDS": '["*"]'}, "EXTENSION_ALLOWED_IDS"),
        ({"EXTENSION_ALLOWED_IDS": '["short"]'}, "EXTENSION_ALLOWED_IDS"),
        ({"EXTENSION_ALLOWED_IDS": '["ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"]'}, "EXTENSION_ALLOWED_IDS"),
        ({"CORS_ORIGINS": '["https://xpertapply.com"]'}, "CORS_ORIGINS"),
        ({"CORS_ORIGINS": '["*"]'}, "CORS_ORIGINS"),
        ({"OPENAI_API_KEY": "sk-not-real"}, "STAGING_AI_MODE=disabled"),
        ({"STAGING_AI_MODE": "capped"}, "capped"),
        ({"STAGING_AI_MODE": "unlimited"}, "STAGING_AI_MODE"),
    ],
)
def test_unsafe_environment_values_are_refused(tree: Path, override: dict, message: str) -> None:
    path = make_env(tree, **override)
    problems = guard.check_env_file(str(path), None)
    assert any(message in p for p in problems), problems
    result = run(tree, "preflight")
    assert result.returncode != 0 and "refused" in result.stderr


def test_placeholders_and_loose_permissions_are_refused(tree: Path) -> None:
    run(tree, "init-env")
    path = tree / "infra" / "staging" / ".env.staging"
    problems = guard.check_env_file(str(path), None)
    assert any("REPLACE_ME" in p for p in problems)
    path.chmod(0o644)
    assert any("chmod 600" in p for p in guard.check_env_file(str(path), None))


def test_a_value_copied_from_production_is_refused_without_printing_it(tree: Path) -> None:
    path = make_env(tree)
    staging = guard.parse_env(str(path))
    fake_prod = tree.parent / "prod.env"
    fake_prod.write_text(f"SECRET_KEY={staging['SECRET_KEY']}\nPOSTGRES_PASSWORD=different-different-different-1234\n")
    problems = guard.check_env_file(str(path), str(fake_prod))
    assert problems == ["SECRET_KEY equals the production value"]
    assert staging["SECRET_KEY"] not in " ".join(problems)


def test_a_value_pointing_at_production_is_refused(tree: Path) -> None:
    path = make_env(tree)
    path.write_text(path.read_text() + "SOME_URL=postgresql+psycopg://u:p@postgres:5432/jobpilot\n")
    assert any("production" in p for p in guard.check_env_file(str(path), None))


# ---- guard: rendered configuration -----------------------------------------------------------------------------
@pytest.fixture()
def rendered(tree: Path) -> dict:
    if not HAS_DOCKER:
        pytest.skip("docker CLI not available")
    make_env(tree)
    out = subprocess.run(
        ["docker", "compose", "--project-name", "xpertapply-staging", "--project-directory", str(tree / "infra" / "staging"),
         "--env-file", str(tree / "infra" / "staging" / ".env.staging"), "-f", str(tree / "infra" / "staging" / "compose.staging.yml"),
         "--profile", "workers", "--profile", "web", "config", "--format", "json"],
        capture_output=True, text=True, env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"]},
    )
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_the_real_rendered_configuration_is_accepted(rendered: dict) -> None:
    assert guard.check_rendered(rendered) == []
    assert rendered["services"]["api"]["ports"][0]["host_ip"] == "127.0.0.1"
    assert not rendered["services"]["postgres"].get("ports") and not rendered["services"]["redis"].get("ports")
    assert rendered["services"]["postgres"]["networks"].keys() == {"internal"}
    assert {s: v["container_name"] for s, v in rendered["services"].items()}["api"] == "xpertapply-staging-api"


MUTATIONS = {
    "privileged container": lambda c: c["services"]["api"].update(privileged=True),
    "host networking": lambda c: c["services"]["api"].update(network_mode="host"),
    "docker socket": lambda c: c["services"]["api"].__setitem__("volumes", [
        {"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"}]),
    "production bind mount": lambda c: c["services"]["api"].__setitem__("volumes", [
        {"type": "bind", "source": "/home/luna/apps/XpertApply/uploads", "target": "/app/uploads"}]),
    "production volume name": lambda c: c["volumes"]["postgres_data"].update(name="xpertapply_postgres_data"),
    "external volume": lambda c: c["volumes"]["postgres_data"].update(external=True),
    "public api port": lambda c: c["services"]["api"]["ports"][0].update(host_ip="0.0.0.0"),
    "production api port": lambda c: c["services"]["api"]["ports"][0].update(published="8020"),
    "published database": lambda c: c["services"]["postgres"].__setitem__("ports", [
        {"host_ip": "127.0.0.1", "published": "5433", "target": 5432}]),
    "database on edge network": lambda c: c["services"]["postgres"].__setitem__("networks", {"internal": None, "edge": None}),
    "production network": lambda c: c["networks"]["edge"].update(name="xpertapply_default"),
    "wrong project": lambda c: c.update(name="xpertapply"),
    "container name collision": lambda c: c["services"]["api"].update(container_name="xpertapply-api-1"),
    "env_file leak": lambda c: c["services"]["api"].update(env_file=[{"path": "/home/luna/apps/XpertApply/.env"}]),
    "startup migrations": lambda c: c["services"]["api"]["environment"].update(RUN_MIGRATIONS_ON_STARTUP="true"),
    "production database": lambda c: c["services"]["api"]["environment"].update(
        DATABASE_URL="postgresql+psycopg://u:p@postgres:5432/jobpilot"),
    "no memory limit": lambda c: c["services"]["redis"].pop("mem_limit"),
    "capability added": lambda c: c["services"]["api"].update(cap_add=["SYS_ADMIN"]),
    "non-internal db network": lambda c: c["networks"]["internal"].update(internal=False),
    "discovery on without a key": lambda c: c["services"]["api"]["environment"].update(PEOPLE_EMAIL_DISCOVERY_ENABLED="true"),
    "password recovery email on": lambda c: c["services"]["api"]["environment"].update(EMAIL_BACKEND="smtp"),
    "google oauth on": lambda c: c["services"]["api"]["environment"].update(GOOGLE_OAUTH_ENABLED="true"),
}


@pytest.mark.parametrize("name", sorted(MUTATIONS))
def test_unsafe_rendered_configuration_is_refused(rendered: dict, name: str) -> None:
    MUTATIONS[name](rendered)
    assert guard.check_rendered(rendered), f"'{name}' was not refused"


# ---- wrapper ------------------------------------------------------------------------------------------------------------
def test_wrapper_refuses_a_wrong_checkout_path(tree: Path) -> None:
    result = run(tree, "preflight", selftest=False)
    assert result.returncode != 0 and "unexpected checkout path" in result.stderr


def test_wrapper_refuses_to_run_from_the_production_checkout(tree: Path) -> None:
    result = run(tree, "preflight", prod=tree)  # pretend this very tree IS production
    assert result.returncode != 0 and "production checkout" in result.stderr


@pytest.mark.parametrize("command", ["up", "status", "migrate", "backup", "build"])
def test_selftest_mode_cannot_run_mutating_commands(tree: Path, command: str) -> None:
    result = run(tree, command)
    assert result.returncode != 0 and "unexpected checkout path" not in result.stdout


@pytest.mark.parametrize(
    "args",
    [
        ("down", "-v"), ("down", "--volumes"), ("down", "--rmi", "all"), ("down", "--remove-orphans"),
        ("volume", "rm", "xpertapply-staging-postgres-data"), ("system", "prune", "-af"), ("rm", "-f"),
        ("exec", "api", "sh"), ("run", "--rm", "api", "alembic", "downgrade", "base"), ("config",), ("unknown",),
    ],
)
def test_destructive_or_unlisted_commands_are_refused(tree: Path, args: tuple) -> None:
    # Even from the exact expected path (no self-test), these must never reach Docker.
    result = run(tree, *args, selftest=False)
    assert result.returncode != 0
    assert "not permitted" in result.stderr or "refused" in result.stderr or "unexpected checkout path" in result.stderr


def test_wrapper_source_has_no_volume_deletion_or_broad_cleanup() -> None:
    lines = [ln for ln in (STAGING / "staging-compose.sh").read_text().splitlines() if not ln.strip().startswith("#")]
    # Lines that REFUSE a flag (they call fail) may name it; no other line may.
    executable = "\n".join(ln for ln in lines if "fail " not in ln)
    for banned in ("docker system", "volume rm", "volume prune", "image prune", "container prune", "down -v", "--volumes",
                   "rm -rf", "network rm", "--rmi"):
        assert banned not in executable, banned


def test_wrapper_refuses_a_docker_host_override(tree: Path) -> None:
    # Reaches require_local_docker only outside self-test, so assert the guard text and behaviour by source.
    source = (STAGING / "staging-compose.sh").read_text()
    assert 'DOCKER_HOST' in source and "default" in source


# ---- host preflight ---------------------------------------------------------------------------------------------
def test_host_preflight_is_read_only_and_reports_a_verdict(tmp_path: Path) -> None:
    source = (STAGING / "host-preflight.sh").read_text()
    code = "\n".join(line for line in source.splitlines() if not line.strip().startswith("#"))
    for mutating in ("docker run", "docker pull", "docker build", "docker rm", "docker stop", "docker compose up", "certbot", "systemctl",
                     "nginx -s", "rm ", "mkdir", "tee ", " > /"):
        assert mutating not in code, mutating
    result = subprocess.run(["bash", str(STAGING / "host-preflight.sh")], capture_output=True, text=True, timeout=120)
    assert result.returncode in (0, 1, 2)
    assert re.search(r"^(OK|STOP|NOT VERIFIED): ", result.stdout, re.M)


# ---- NET-03B: work-email discovery stays off, keyless and capped unless every control is set -------------------------
SAFE_DISCOVERY = {
    "PEOPLE_EMAIL_DISCOVERY_ENABLED": "true",
    "HUNTER_API_KEY": "synthetic-staging-key-not-a-secret",
    "PEOPLE_RECOMMENDATIONS_ENABLED": "true",
    "PEOPLE_ROLLOUT_MODE": "internal",
    "PEOPLE_INTERNAL_EMAILS": "tester@example.test",
    "PEOPLE_EMAIL_DAILY_CREDIT_BUDGET": "4",
    "PEOPLE_EMAIL_PER_USER_DAILY_LIMIT": "4",
    "PEOPLE_EMAIL_RATE_LIMIT_PER_HOUR": "2",
}


def test_discovery_is_disabled_and_keyless_by_default(tree: Path) -> None:
    values = guard.parse_env(str(make_env(tree)))
    assert values["PEOPLE_EMAIL_DISCOVERY_ENABLED"] == "false"
    assert values["HUNTER_API_KEY"] == ""
    assert values["PEOPLE_ROLLOUT_MODE"] == "disabled"
    assert guard.check_email_discovery(values) == []
    assert "EMAIL_BACKEND" not in (STAGING / "compose.staging.yml").read_text()


def test_a_complete_internal_discovery_setup_is_accepted() -> None:
    assert guard.check_email_discovery(SAFE_DISCOVERY) == []
    assert guard.check_email_discovery({**SAFE_DISCOVERY, "PEOPLE_INTERNAL_EMAILS": '["a@example.test","b@example.test"]'}) == []


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"HUNTER_API_KEY": ""}, "HUNTER_API_KEY"),
        ({"PEOPLE_RECOMMENDATIONS_ENABLED": "false"}, "PEOPLE_RECOMMENDATIONS_ENABLED"),
        ({"PEOPLE_ROLLOUT_MODE": "all"}, "PEOPLE_ROLLOUT_MODE"),
        ({"PEOPLE_ROLLOUT_MODE": "disabled"}, "PEOPLE_ROLLOUT_MODE"),
        ({"PEOPLE_INTERNAL_EMAILS": ""}, "PEOPLE_INTERNAL_EMAILS"),
        ({"PEOPLE_INTERNAL_EMAILS": "*"}, "PEOPLE_INTERNAL_EMAILS"),
        ({"PEOPLE_INTERNAL_EMAILS": "a@x.test,b@x.test,c@x.test,d@x.test"}, "PEOPLE_INTERNAL_EMAILS"),
        ({"PEOPLE_EMAIL_DAILY_CREDIT_BUDGET": "0"}, "PEOPLE_EMAIL_DAILY_CREDIT_BUDGET"),
        ({"PEOPLE_EMAIL_DAILY_CREDIT_BUDGET": "50"}, "PEOPLE_EMAIL_DAILY_CREDIT_BUDGET"),
        ({"PEOPLE_EMAIL_PER_USER_DAILY_LIMIT": "0"}, "PEOPLE_EMAIL_PER_USER_DAILY_LIMIT"),
        ({"PEOPLE_EMAIL_PER_USER_DAILY_LIMIT": ""}, "PEOPLE_EMAIL_PER_USER_DAILY_LIMIT"),
        ({"PEOPLE_EMAIL_RATE_LIMIT_PER_HOUR": "0"}, "PEOPLE_EMAIL_RATE_LIMIT_PER_HOUR"),
    ],
)
def test_partial_or_uncapped_discovery_is_refused(override: dict, message: str) -> None:
    problems = guard.check_email_discovery({**SAFE_DISCOVERY, **override})
    assert any(message in p for p in problems), problems


def test_the_wrapper_refuses_an_uncapped_enablement_and_prints_no_key(tree: Path) -> None:
    path = make_env(tree, **{**SAFE_DISCOVERY, "PEOPLE_EMAIL_DAILY_CREDIT_BUDGET": "0"})
    problems = guard.check_env_file(str(path), None)
    assert any("PEOPLE_EMAIL_DAILY_CREDIT_BUDGET" in p for p in problems)
    result = run(tree, "preflight")
    assert result.returncode != 0 and "refused" in result.stderr
    assert SAFE_DISCOVERY["HUNTER_API_KEY"] not in result.stdout + result.stderr


def test_a_staging_key_equal_to_the_production_key_is_refused_without_printing_it(tree: Path) -> None:
    path = make_env(tree, **SAFE_DISCOVERY)
    fake_prod = tree.parent / "prod.env"
    fake_prod.write_text(f"HUNTER_API_KEY={SAFE_DISCOVERY['HUNTER_API_KEY']}\n")
    problems = guard.check_env_file(str(path), str(fake_prod))
    assert problems == ["HUNTER_API_KEY equals the production value"]
    assert SAFE_DISCOVERY["HUNTER_API_KEY"] not in " ".join(problems)


@pytest.mark.skipif(not HAS_DOCKER, reason="docker CLI not available")
def test_enabling_discovery_renders_only_staging_values_and_changes_no_other_service(tree: Path) -> None:
    def render(env_path: Path) -> dict:
        out = subprocess.run(
            ["docker", "compose", "--project-name", "xpertapply-staging", "--project-directory", str(tree / "infra" / "staging"),
             "--env-file", str(env_path), "-f", str(tree / "infra" / "staging" / "compose.staging.yml"),
             "--profile", "workers", "--profile", "web", "config", "--format", "json"],
            capture_output=True, text=True, env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"]},
        )
        assert out.returncode == 0, out.stderr
        return json.loads(out.stdout)

    off = render(make_env(tree))
    on_path = tree / "infra" / "staging" / ".env.staging"
    on_path.write_text(on_path.read_text() + "".join(f"{k}={v}\n" for k, v in SAFE_DISCOVERY.items()))
    # Later assignments win in an env file, so the appended block is the effective one.
    on = render(on_path)
    assert guard.check_rendered(on) == []
    api = on["services"]["api"]["environment"]
    assert api["PEOPLE_EMAIL_DISCOVERY_ENABLED"] == "true" and api["PEOPLE_ROLLOUT_MODE"] == "internal"
    assert "api.xpertapply.com" not in json.dumps(on).replace("api-staging.xpertapply.com", "")
    for name in ("postgres", "redis", "worker", "scheduler", "web"):
        if name == "worker" or name == "scheduler":
            continue  # these share the API environment block by design; the guard checks them as the API
        assert on["services"][name] == off["services"][name], name
    assert off["services"]["api"]["environment"]["PEOPLE_EMAIL_DISCOVERY_ENABLED"] == "false"
    assert off["services"]["api"]["environment"]["HUNTER_API_KEY"] == ""
