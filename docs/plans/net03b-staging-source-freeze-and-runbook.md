# NET-03B — source freeze, staging safety and release runbook

Status: source frozen locally, images built and archived, **nothing deployed**. No staging or production
service, secret, database or Hunter endpoint was touched. Provider evidence in tests is synthetic.

## Source identity
- History: `5ac17f6` (production baseline) → `be1c584` (P1D) → `13f7609` (NET-01) → `9dae512` (NET-02) →
  `9350e36` (NET-03A) → `e22e59b` (NET-03B application) → NET-03B staging configuration commit.
- The NET-03A images were built from a tree object that was never committed (`8fa3e01…`). `apps/api` and
  `apps/web` at `9350e36` are byte-identical to that build input (`f64e315…` / `260cdc3…`), but the image label
  said `9dae512`. The NET-03B images replace them and carry the real commit, tree and subtree ids as labels.
- `apps/extension` is identical to `5ac17f6` (`74fcfb6…`). No Alembic, production Compose or Dockerfile change.

## Safety decisions
- A deliverability check proves an address accepts mail, not that it belongs to the named person. The UI says
  "Deliverable work email" with an explanatory title; the internal status value `verified` is unchanged.
- Hunter `inferred` addresses are never shown or sent to the paid verifier.
- Application defaults of `0` for the daily and per-user email budgets mean **unlimited**. The hourly limit is an
  in-process counter that resets on restart and is not shared between workers; the budgets are the durable control.
- Different keys on one Hunter account share one credit pool. Key inequality is not billing isolation.
- Staging is on `internal` rollout, which allows named testers only, with caps of 4 credits a day, 4 per user, and
  2 lookups per hour. `staging_guard.py` refuses discovery without a key, internal rollout, 1–3 testers and non-zero caps.

## Staging configuration source (this commit)
`infra/staging/compose.staging.yml`: `HUNTER_API_KEY`, the discovery flag, caps and people-rollout variables are
default-safe variables (off, keyless, capped). `staging.env.example` documents them. `staging_guard.py` adds the
refusals above, requires the staging key to differ from production's, and keeps `EMAIL_BACKEND` disabled and Google
OAuth off in the rendered configuration. Password-recovery email stays off because `EMAIL_BACKEND` is not set.

## Runbook (operator, not executed)
Baseline (unchanged at NET-03B): API `xpertapply-api:f2-aa5bc2f-amd64` `sha256:c7a15f1ea23b…`, web
`xpertapply-staging-web:s3-1b26947-amd64` `sha256:50c24a560f19…`, staging DB `0034_password_reset` (also this
source's head: no migration). The live project `xpertapply-staging` is run from `/home/xpertapply/apps/staging/infra/staging`
with three files: `compose.staging.yml`, `/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml` and a
per-release override that pins image tags. Docker access is root-only.

1. Review: read the existing release override and confirm it sets no environment that would shadow the new variables.
2. Backup: take the staging backup with the existing `infra/staging` backup procedure; record the file and checksum.
3. Sync the committed `infra/staging` files into the staging checkout; run the guard against the real env file (no values printed).
4. Load the archived images and confirm their ids against `images.sha256`.
5. Write a release override pinning `api` and `web` to the NET-03B tags; apply with
   `docker compose -p xpertapply-staging … up -d --no-deps api web` (never `postgres` or `redis`; no `--force-recreate` of others).
6. Health: API `/healthz` and `/readyz`, web `/login`; confirm container image ids; confirm discovery is still disabled.
7. UI acceptance with discovery disabled: Networking tabs, "Email unavailable" state.
8. Hunter test-key acceptance (below), then credit-limited real-provider acceptance (below).

Stop conditions: any health check failing, staging DB head ≠ `0034_password_reset`, the guard refusing, a request
to the production API host, any credit use above the written test budget, any real address in a log or screenshot.

Rollback: restore the previous override (or retag the baseline images from the archived tars), recreate only `api`
and `web`, set the discovery flag false and remove the key from the env file. Never `alembic downgrade` or `down -v`.

## Hunter test-key acceptance (staging, synthetic data only)
Hunter documents a `test-api-key` that validates parameters and returns a fixed dummy response
(https://help.hunter.io/en/articles/7048972-can-i-use-a-test-api-key). With it set as `HUNTER_API_KEY`, use one
seeded synthetic contact at a synthetic company domain and click Get Email once. Expected: HTTP success without a
retry loop; parsing without error; a second click answered from cache with no new request. The dummy address will
almost certainly not be on the synthetic domain, so `not found` is the correct safe outcome and must not be read as
proof that a real professional email was discovered. Record the request count from the app logs and the run table.

## Credit-limited real-provider acceptance (separate authorization)
Needs a separately managed staging key, a consenting professional, a seeded recommendation for them, and the caps
above. One Finder request, one Verifier only if the Finder returns a sourced (not inferred) address, no automatic
retry, no outreach. Expected cost: 0 credits if nothing is found, about 1.5 if found. Verify usage from the Hunter
account's credit balance before and after and from the app's run records; never log or screenshot the key or address.

## Candidate images (built from commit `e22e59b`, not deployed)
Archive on the VPS: `/home/luna/xpertapply-release-candidates/net03b-e22e59b-20261031T211649Z/` (images, `images.sha256`,
`ctx.sha256`). Rollback baseline tars: `net03b-staging-rollback-baseline-20261031/`.
- API `xpertapply-api:net03b-e22e59b-staging-amd64` `sha256:7509387f02d5d00610b6cc3836940832dc7ea248c19b6d6ee81f1a10765cb48e`
- Web `xpertapply-staging-web:net03b-e22e59b-amd64` `sha256:d5c43538f477e43d66576fdc7d681395f12f94b59b9ef4181879c5ca1d32ec4d`
- Built with a 3 GB / 2 CPU / idle-I/O limit; staging API and site URLs baked in; no production API host in the bundle.
