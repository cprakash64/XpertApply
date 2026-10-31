# NET-01: Networking work-email discovery and contact categories

Status: implemented locally, uncommitted, not deployed. Base: production 5ac17f6 plus the P1D patch
(`p1d-fix.patch`, sha256 e6b7093b…df49ab, applied unchanged to the working tree).

## Architecture
- Contacts: `GET/POST /jobs/{id}/people[/discover]` return three categories (`likely_recruiters`,
  `potential_hiring_managers`, `potential_referrers`), classified server-side from title/department/company
  evidence in `app/people/scoring.py`. Employment validation gates every displayed contact.
- Work email: `POST /jobs/{id}/people/{rec}/email` -> `service.find_email` -> `HunterEmailProvider`
  (finder, then verifier). Gated by `PEOPLE_EMAIL_DISCOVERY_ENABLED` and `HUNTER_API_KEY`.
  Only a Hunter-verified address on the employer domain is ever shown; results are cached per person
  for `PEOPLE_EMAIL_RESULT_TTL_DAYS`.

## Decisions
- No schema change, no new dependency, no new provider.
- Transient provider states (rate limit, unavailable, credentials) are returned to the caller but no
  longer written to the shared person row; legacy rows holding them read as `not_requested`.
- Hunter `status` is preferred over the deprecated `result`; 202/222 are retryable; 451 is final.
- Names are cleaned (titles, credentials, initials); single-token names are not sent to the finder.
- UI: category tabs (Hiring Managers | Recruiters | Referral Candidates) with counts and empty states.

## Validation
- `app/tests/test_people_email_net01.py` (30 tests, synthetic Hunter responses; 23 failed before the fix).
- `apps/web/__tests__/networking-categories-net01.test.tsx`; updated tab-aware web and e2e specs.
- A mocked Hunter response is NOT evidence that real discovery works. Real-provider acceptance is open.

## Rollout
Deploy API and web together (web expects the unchanged response shape; API changes are additive).
Staging first with a real Hunter key and a disposable contact; confirm one verified lookup, one not-found,
and that a second click makes no provider call.

## Rollback
Redeploy the previous API/web images (production-rollback.sh). No migration, so no database rollback.
