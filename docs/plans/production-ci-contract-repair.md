# Production CI contract repair — PROD-READY-01

## Architecture and decisions
Production Compose intentionally uses both interpolation from the private `.env`
and service `env_file: .env`. The wrapper loads that file in an isolated process
and validates production runtime settings; backend startup rejects weak/missing
credentials. Preserve those contracts. The test copies the two tracked Compose
files into a temporary directory and generates synthetic `.env` there, never in
the checkout. Missing service `.env` remains a tested failure.

This qualification checkout intentionally makes the proxy the sole enforced CSP
authority. Static `next.config.mjs` headers are empty; the Report-Only helper is a
strict policy template, not an installed response header here. Test the actual
proxy's server nonce, forwarded authority, strict sources, single enforced policy,
no Report-Only duplication and existing cache rules. Preserve prior template and
injection rejection assertions. No production config, CSP or R13 code changes.

## Progress and validation
Both original failures reproduced on checkpoint 778f0aa5 and parent 686c1b75:
11 passed, 2 failed with identical contract signatures. Repairs affect two tests
only. Validate focused tests, full make test-web/test-api/test-extension, CI ruff,
Compose config/build availability, clean archive and frozen R13 offline parity.
Record full results and environment limitations in external prod-ready-01 evidence.
No production migration or standalone Alembic operation was performed. The first
authoritative backend run automatically executed the first scratch-database migration
test file; it was stopped when this was identified. Cleanup was verified (zero
remaining scratch databases), and the complete rerun excluded all migration tests.

## Rollout and rollback
Local validation only. Commit only if required CI/security/parity checks pass.
No push, deployment, server restart or live qualification. Roll back these test
changes by restoring the two tests and this plan; production behavior is unchanged.

## Validation result and checkpoint decision
Focused contracts: 14 passed (Compose 9, security 5). Clean archive `make test-web`:
1,033 passed, lint/typecheck/production build passed. Extension: 809 passed,
10 skipped, typecheck/build passed. Backend non-migration suite: 1,935 passed,
7 migration tests deselected; CI Ruff passed. Existing frontend stylesheet lint
warning and parent-reproduced jsdom navigation warnings remain non-blocking.

Compose parsing, loopback port assertions, missing-service-env rejection, wrapper
syntax and Docker build-definition generation passed. `docker compose build`
failed on both checkpoint and parent because the local Docker daemon socket is
unavailable. Image builds were not verified; no daemon/server restart was attempted.
Frozen R13 checks passed: 1,022 gate replays, 1,536 legacy comparisons, 25 label
tests, four Observer integrations and 14 known-failure controls. Historical RSC
qualification stays BLOCKED.

Stage verdict: BLOCKED — Docker image-build validation unavailable. The narrow
repair is left uncommitted because required full CI validation did not pass.
Next: repeat Docker image builds in an authorized disposable environment with a
running daemon; review and commit only after all required checks pass. Then
perform final readiness qualification separately. No dependency/configuration
change, push or deployment.
