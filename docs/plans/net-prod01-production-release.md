# NET-PROD-01 — direct production release of the Networking fixes

Status: prepared, **not deployed**. Staging was skipped at the owner's request. Nothing on production was changed by the
preparation: the only production reads were `docker inspect`, one read-only database dump with an isolated restore test, and
the non-secret settings report.

## Source and images
- Approved source `528c37c`; runtime source `e22e59b`. `apps/web` is byte-identical at both; `apps/api` differs only by a staging
  guard test file; `apps/extension` is identical to the production baseline `5ac17f6`. No migration (Alembic head and production
  database are both `0034_password_reset`). P1D, NET-01, NET-02, NET-03A and NET-03B changes are all contained.
- API `sha256:06234270dba8…` and web `sha256:c79dc3495171…`, built on the VPS with a 3 GB / 2 CPU limit; web built for
  `https://api.xpertapply.com` / `https://xpertapply.com` with the existing extension id, 0 staging references. Archived with SHA-256.

## Email-discovery rollout and limits
- Production is already internal-only: `PEOPLE_ROLLOUT_MODE=internal`, one listed tester. Route tests prove unauthenticated 401,
  non-listed user 404 with no provider call, listed user reaches the lookup. The allowlist gates all of Networking; there is no
  email-only allowlist.
- Limits count **credits**, not lookups: a found lookup is finder + verifier = 2 credits, a not-found lookup is 1. The checks run
  before each call. Production values to apply: daily budget 5 (at most 3 found lookups, 6 counted), per-user 3 (exactly 2 found
  lookups; a value of 2 would allow only 1), hourly 2 (uncached attempts per user; in-process, resets on API restart).
  Today's values are 100 / 10 / 5. The shared Hunter pool was last seen at 50 credits.
- Applied through a Compose override; the `.env` file is never edited, so rollback restores the previous values.

## Live acceptance (after the operator applies the release)
Use a real browser as the one internal tester; do not submit applications.
1. Public: homepage and `/login` 200, HSTS present, no `staging` text, robots excludes signed-in pages.
2. Sign in and out; Dashboard; Jobs list, search, filters, fit scores; Tracker; resume and cover-letter downloads; Profile; Settings.
3. Network panel: every API request goes to `api.xpertapply.com`; no `api-staging` request; no request to any provider from the browser.
4. Networking on a real job with stored results: three tabs present with counts; each card shows the same employer as the job,
   a role title that fits the tab, evidence and the "not confirmed" caveat; no person appears in two tabs; empty tabs show their message.
   Cross-check three cards against `GET /jobs/{id}/people` response categories (`potential_hiring_managers`, `likely_recruiters`,
   `potential_referrers`) and the employer domain. Click "Find people" only if it is within the existing discovery budget.
5. Email: with lookups disabled the state reads "Email unavailable"; with lookups enabled it reads "Find work email". Do not click it.
6. Monitor: `production-monitor.sh --phase post` for 15 minutes; no 5xx, no restarts, queue empty.

## Controlled Hunter acceptance (not executed)
1. Test key: in a **non-production** API process only, set `HUNTER_API_KEY=test-api-key` and use a synthetic contact at a synthetic
   domain. Hunter documents it as validating parameters and returning a fixed dummy response
   (https://help.hunter.io/en/articles/7048972-can-i-use-a-test-api-key). It proves transport and parsing only; "not found" is the
   expected safe outcome because the dummy address will not be on the synthetic domain. Production credentials are not changed.
2. Real lookup, separately authorised: one consenting professional who is the internal tester's own contact, with a recommendation that
   has validated employment at the exact company domain. One Finder request; one Verifier only if the Finder returns a sourced
   (not inferred) address; no automatic retry; no outreach. Record the Hunter balance and the application's credits (`people_discovery_run`
   rows with provider `hunter`) before and after; expected cost 0 credits if nothing is found, about 1.5 if found. Never print the key,
   the address or the contact record. Only a verified, on-domain, sourced address counts as "Get Email works"; "not found" does not.
