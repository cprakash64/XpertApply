# NET-03A — staging release preparation (Networking email + categories)

Status: prepared, **not deployed**. No staging or production service, secret, migration or Hunter paid
endpoint was touched. All provider evidence in tests is synthetic.

## Source identity
- HEAD `9dae512` (NET-02) on `be1c584` (P1D) on production baseline `5ac17f6`.
- Uncommitted NET-03A edits on top: `providers.py` (reject Hunter `provenance: inferred`), `service.py`
  (count credits spent before a verifier failure), `test_people_email_net01.py`, and the new
  `apps/web/e2e/networking-categories.spec.ts`.
- Build contexts come from `git archive` of a tree object built from HEAD plus those files, so the image
  identity is a tree hash, not a commit. Committing the same files reproduces the tree.
- Versus `5ac17f6`: no Alembic, Compose, Dockerfile or extension file changed.

## Decisions
- Hunter 403 = request rate limit (retryable); 429 = usage limit (`budget_exceeded`, no retry, budget
  circuit holds paid calls). 451 clears any stored address.
- Credits: Hunter's unified pool charges ~1 credit per email found, ~0.5 per verification (not charged when
  nothing is found); the app counts 1 per call, so it over-counts and stays conservative.
- **Verifier skip not implemented.** Skipping the verifier when the finder reports `verification.status=valid`
  would save ~0.5 of ~1.5 credits per found contact, but the finder's verification can be up to a month old and
  its shape is untested against a real account. Revisit after the single authorized real test shows whether
  `verification.status` and `date` are present; ship behind a setting, with regression tests.
- Hunter `provenance: inferred` (pattern-guessed) addresses are not shown and not sent to the verifier.
- `PEOPLE_EMAIL_DAILY_CREDIT_BUDGET` and `PEOPLE_EMAIL_PER_USER_DAILY_LIMIT` default to **0 = unlimited**.
  Production has no application-level cap until they are set; staging must set both.

## Staging findings
- `infra/staging/compose.staging.yml` hard-codes `HUNTER_API_KEY: ""` and does not list
  `PEOPLE_EMAIL_DISCOVERY_ENABLED`, so no env-file change can enable discovery. A prepared, unapplied patch
  (`net03a-staging-compose.patch`, `net03a-staging-guard.patch`) makes them default-safe variables with
  small caps (4 credits/day, 2 lookups/hour) and requires the staging key to differ from production's.
- Staging DB is at `0034_password_reset`, which is the Alembic head of this source (chain 0033 → 0035 → 0036 → 0034),
  and the candidate API image reports the same head. No migration is needed; the API never auto-migrates.
- Staging has no people-discovery provider keys, so a contact must be seeded (see the test plan).

## Validation
See the NET-03A report. API: full suite, 11 skips that need a disposable PostgreSQL or a deployed checkout.
Web: typecheck, eslint, vitest 1234/1234. Playwright against a production build, including the new
Networking spec with axe in light/dark and desktop/mobile.

## Rollout / rollback
Replace only the staging API and web containers after a fresh staging backup; roll back by pointing
the compose image tags at the previous images (`xpertapply-api:f2-aa5bc2f-amd64`,
`xpertapply-staging-web:s3-1b26947-amd64`) and recreating those two containers. Never `alembic downgrade`.
