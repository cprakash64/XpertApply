# XA-STG0 — isolated staging environment

Status: files written and validated locally. **Staging is not running.** Nothing has been deployed, no DNS, nginx,
certificate or server change has been made, and no remote was pushed.

## Architecture
A second Compose project, `xpertapply-staging` (`infra/staging/compose.staging.yml`), self-contained rather than an
overlay on the development compose file: PostgreSQL 16 and Redis on an internal, outbound-less network with no published
ports; the API on `127.0.0.1:8021`; worker, scheduler and web behind profiles that are off by default. Named volumes
and networks are all prefixed `xpertapply-staging-`; every container variable is listed explicitly (no `env_file`).
All Compose commands go through `infra/staging/staging-compose.sh`, which checks the path, Docker context, environment
file (`staging_guard.py env-file`) and the rendered configuration (`staging_guard.py rendered-config`) first.

## Decisions (from the brief, unchanged)
Same VPS only if `infra/staging/host-preflight.sh` measures sufficient capacity (budgets are derived from the compose
memory limits, and are estimates until the first build is measured); otherwise a separate machine with the same files.
Hosts `staging.xpertapply.com` and `api-staging.xpertapply.com`. No production AI credentials; AI disabled by default
with an optional separate capped key. Extension ids come from an explicit allowlist (`EXTENSION_ALLOWED_IDS`).

## Progress
Done: compose, env template, guarded wrapper, host preflight, nginx templates, runbooks, guard tests (68).
Not done (needs separate authorization): host preflight on the real VPS, DNS, certificates, nginx install, backup,
migration, API start, section-8 acceptance checks.

## Validation
`apps/api/app/tests/test_staging_infra.py` (renders the real Compose file and mutates it 19 ways; env-file and
wrapper refusals; template completeness; nginx structure; preflight read-only). See the XA-STG0 report for results.

## Rollout / rollback
`infra/staging/RUNBOOK.md` and `infra/staging/DNS-TLS.md`. Rollback is redeploying the previous API image or
restoring the pre-migration dump into a new database; never `alembic downgrade`, never `down -v`.
