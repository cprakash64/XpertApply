# XpertApply production launch GO / NO-GO (2026-10-30)

Nothing was deployed, pushed, migrated, published or changed on production, staging or the VPS. Production evidence is limited to four unauthenticated read-only GETs/HEADs of public endpoints (section 3). Code changed in one place: `212aee3` on `feature/xa-core1-direct-autofill` (local). Evidence base: staging web `1b26947`, API `aa5bc2fa`, extension `647c57c` + `212aee3`, E2C report `2fa5cdb`. The assistant's screenshot analysis uses the findings you described; the screenshot file itself was not available to me.

## 0. Decision
| Scope | Decision |
|---|---|
| Public launch of the extension (Chrome Web Store) | **NO-GO** |
| Public launch of the web product with the premium UI plus API fixes, password recovery OFF | **CONDITIONAL GO**, as a controlled production canary only, after the conditions in section 7 |
| Production canary of the extension | **NO-GO now** (no safe canary path exists, section 6) |
| Anything touching VeoTrex or other VPS services | none proposed |

Shortest path to unblock the extension: section 9.

## 1. The real autofill result (Reddit Greenhouse: 24 detected, 3 filled, 21 review)
Not every review item is a defect. Classification, each with its basis:

| Observation | Classification | Basis |
|---|---|---|
| Email empty | **Intentionally requiring review, or missing profile data. Unverified for this account.** | The backend never puts a reserved or fixture address on an application: `resolve_application_email` refuses `example.*`, `*.test`, `invalid`, `localhost` and known fixture emails, and `_redact_dev_fixture_identities` removes them and leaves an `unresolved` entry. A synthetic account using such an address gets an empty email by design. `test_application_email.py` 33 pass. Check: the account's profile application email and whether it is confirmed. |
| Phone, location empty | **Missing user profile data, or Unsupported field. Unverified.** | Values come only from saved profile fields (`derive_profile_answers`: phone from stored phone parts, city/state/country from location fields). A profile without them yields nothing. Separately, Greenhouse's phone (country-code widget) and location (async typeahead) are not covered by the synthetic fixtures, which use a plain phone input, so real-widget behavior is unverified. |
| Required selections (work authorization, sponsorship, demographics) empty | **Intentionally requiring review.** | Never guessed: `test_legal_answer_policy.py` passes; e2e `xa-gh04` G3 (voluntary self-identification stays unanswered) and `xa-core1-direct` (`#auth`, `#spons`, `#gender`, `#why` stay empty) pass. They fill only from an answer the user saved explicitly. |
| Only 3 filled | **Unverified**, consistent with the three rows above. | Names are filled from the profile; the rest is gated as described. |
| Page-reading warning beside 24 detected fields | **Proven defect (mechanism); the screenshot instance is Unverified.** | `applyProgress` updated state and counts but never the failure recorded earlier, so a detection-stage failure (a frame that had no form yet, a probe that missed, a discovery timeout) stayed visible after a later scan read the form. Reproduced by a unit test that failed before the fix (`FORM_NOT_RENDERED`, `NO_MATCHING_FRAME`, `APPLICATION_DISCOVERY_TIMEOUT`). Fixed in `212aee3`. Whether your warning was that one cannot be proven without its text or the worker's stored failure code. |
| Résumé / cover letter "Attach manually" while files show on the form | **Intentionally conservative, by design, with a timing race. Screenshot instance Unverified.** | A direct draft returns first; the tailored documents are generated afterwards, once, up to 120 s (`prepare_direct_documents`). The extension requests each document live at fill time and marks it review if the download fails or the upload cannot be verified (`prepareDocumentUploads`); it never claims uploaded without verifying. A fill a few seconds after opening therefore often finds no document, and the label does not say "still preparing". Retrying Fill later re-requests live (by code reading; not exercised). If files are visibly attached, either the employer or the browser attached them, or the upload verification failed: Unverified. |
| No automatic submission | **Verified.** | 14 e2e files assert zero submit clicks and zero submits; no code path clicks a submit control. |

To settle the Unverified rows without exposing personal data: have the tester, on a throwaway profile, record (a) whether the profile has a real application email, phone and location, (b) the worker's stored failure code (two console commands in the E2B report, section 4), and (c) whether the visible files were attached by XpertApply, the employer or Chrome.

## 2. Release-line compatibility
Git facts (read-only):
- `feature/premium-ui-overhaul` (`2fa5cdb`) already contains production's `ceb8314` (Google auth), the nav02 gate `1516f23` (migration 0036), staging API `aa5bc2fa` and the password-reset fix `3454d5f`. It has **zero** changes under `apps/extension` relative to `main`.
- `feature/xa-core1-direct-autofill` (`212aee3`) is a parallel line from `main` (`ced7562`): 77 commits, 252 extension files, 66 API files, 41 web files. Its own migrations (`0033_snapshot_artifact_provenance`, `0034_external_identities`, `0035_extension_auth`) collide with premium's chain.
- A full merge of the two is **not safe**: `git merge-tree` reports about 40 conflicting files (API config and security, models, routes, web auth and tracker, lockfiles, `0035_extension_auth` add/add), and resolving them risks regressing production hotfixes.
- The Chrome Web Store line `origin/release/chrome-web-store` (`890892d`, version 0.3.0) is an ancestor of line C. Line C adds `identity` and 22 commits.
Safe integration, verified without touching any branch or worktree: take premium and replace **only** `apps/extension` with line C's. I built that as an unreferenced commit, `ec714fd9a265db375b00ee86a4e66297682f48a5` (parents `2fa5cdb`, `212aee3`): 252 files differ from premium, all under `apps/extension`; `apps/extension` equals line C exactly; everything else equals premium exactly. It needs no API or web change because line C's `extension.py` is byte-identical to premium's and the web connect page already exists in premium. It has no ref and was not checked out; creating a real branch and merging needs your approval.
API compatibility: **production already serves the extension routes.** `GET /extension/me` and `POST /extension/direct-sessions` answer **401** (route present, credential required), and production is at Alembic `0036_application_doc_snapshots` (head). Line C therefore needs **no migration**. The password-reset routes answer **404** on production (`/auth/password-reset/availability`).
Unreleased password-reset fix `3454d5f`: 2 files (`routes/auth.py`, test), no migration; ends every extension connection when a password is reset; 83 tests pass. Password recovery as a whole is **not on production**: it needs migration `0034_password_reset` (additive: one nullable column, one table; the chain is 0036 to 0034), the routes, and a working email backend.

## 3. Production readiness audit (read-only)
Live, unauthenticated, read-only: `GET /readyz` 200 (database connected, current and head revision `0036_application_doc_snapshots`), `GET /healthz` 200, `GET /auth/password-reset/availability` 404, extension routes 401, `HEAD https://xpertapply.com/` 200. Everything else is from the repository or documents; the host itself was not inspected (no access from here).

| Area | Finding | Status |
|---|---|---|
| Auth and session isolation | Extension credentials (30-min access, rotating 30-day refresh with replay revocation), session tokens scoped to one session and account; E2B/E2C tests prove no cross-account reuse; F1 fix local | Good; F1 unreleased |
| Account isolation vs website record | Fixed and tested (`d6768f2`, `647c57c`) | Good on line C only |
| Password-reset email | **Not verified.** No SMTP on staging (recovery disabled there), no delivery to a real mailbox, no SPF/DKIM/DMARC evidence; Resend settings documented, not exercised | **Blocker for recovery** |
| Nginx / headers (production web) | Report-Only CSP only, no enforced CSP; HSTS `max-age=86400` (one day); `Referrer-Policy: strict-origin-when-cross-origin`. The S1 runbook states the recovery pages need `no-referrer` (reset token in the URL) via an nginx map before they ship | Gap for recovery; acceptable if recovery stays off |
| Database migrations and backups | Production head is 0036. Only manual `pg_dump` procedures exist in `docs/deployment.md` and the staging scripts; **no scheduled backup, no restore test and no off-host copy is evidenced** | **Blocker until verified** |
| API performance and memory | Compose sets no memory or CPU limits; worker concurrency 2; no load test evidence for production | Risk, unverified |
| Container isolation | API image runs as uid 10001; the web image runs as root (known, unchanged since earlier staging webs); no read-only root or capability drops in compose | Hardening, not a blocker |
| Secrets and data protection | Secret-pattern scan of both branches: no hits; only `.env.example` tracked; provider secrets backend-only | Good |
| Reproducible build artifacts | Extension build id is a content hash and is stable; file bytes are not (timestamp embedded). Web and API images pinned by layer fingerprint in the staging scripts | Acceptable |
| Error monitoring | **None in the repository** (no Sentry or equivalent); logs only | Gap; minimum viable uptime check and log review needed |
| Rollback | Image alias and fingerprint-pinned rollback scripts exist for staging web; API rollback is "recreate the old image; never `alembic downgrade`" | Good for staging; production scripts not yet written for this release |
| No automatic submissions | Verified (section 1) | Good |
| VeoTrex and other services | Staging scripts act only on `xpertapply-staging-*` containers and refuse unexpected state; no change to anything else is proposed | Preserved |

## 4. Test evidence (this task)
| Check | Result |
|---|---|
| Extension typecheck | clean |
| Extension unit suite (`212aee3`) | 106 files, 1,596 tests pass; 17 in `ready_refusal_settles`, including the two new stale-failure tests (the three FORM/NO_MATCHING/TIMEOUT cases failed before the fix) |
| Playwright (real Chromium, synthetic fixtures): `xa-gh04-greenhouse`, `xa-core1-direct`, `xa-e2c-isolation`, `xa-e2b-api-failures`, `xa11`, `ats-lifecycle`, `required-review-completion` | 38 pass, 0 fail |
| Backend: `test_application_email`, `test_legal_answer_policy`, `test_demo_fixture_boundary`, `test_password_reset`, `test_extension_auth` | 33 + 95 pass |
| Not run | Other e2e files, real-API specs, any real employer page, desktop Chrome, a signed-in staging run of the extension, production-profile builds against production |
Authenticated staging and Chrome evidence available: the E2A identity check (Chrome for Testing, not desktop Chrome), the Reddit screenshot, and the Workday permission prompt you observed. That is **partial Greenhouse** and **permission-only Workday**. **Lever and Ashby have synthetic-fixture evidence only. Workday filling and its auto-advance (E1 F3) are unverified.** No complete coverage is claimed for any of the four.

## 5. Critical blockers for public release
1. **Chrome Web Store.** Line C adds the `identity` permission to the published 0.3.0 line (`activeTab`, `sidePanel`, `storage`, `scripting`, `tabs`, optional all-sites). A permission increase triggers a new review and disables the extension for existing users until they accept. Store disclosures and the privacy policy must describe the sign-in flow, per-site access and what leaves the browser. Review time is outside our control.
2. **No production extension identity.** Production allowlist `EXTENSION_ALLOWED_IDS` must hold the Store item's ID, which exists only after the item is created. Unset or empty means every well-formed ID is accepted outside production and none in production, so the extension cannot sign in until it is set.
3. **No real authenticated acceptance** of the extension on staging beyond the partial Greenhouse screenshot. Four rows of section 1 remain Unverified.
4. **Backups are unverified** for a production database that holds users' résumés and profiles.
5. **Password recovery is not shippable**: no verified email delivery, nginx `no-referrer` map pending, routes absent on production.
6. **Line C is not integrated** and untested in the release line (a clean candidate exists, `ec714fd`).

## 6. Is a controlled production canary safe?
- **Web + API canary (recovery off): yes, conditionally** (section 7). The change is additive, the data layer needs one additive migration, and rollback is an image swap.
- **Extension canary: no.** A production-profile build has no pinned ID, so a tester's unpacked copy would need its path-derived ID added to the production allowlist, which is a production configuration change that widens who can mint tokens; the safe alternative is to finish acceptance on staging (pinned ID, staging-only permissions) and then use a Store "trusted testers" or unlisted submission.

## 7. Minimal fixes and conditions before the web + API canary
| # | Item | Code or evidence |
|---|---|---|
| 1 | Release API at `aa5bc2fa` plus `3454d5f` (image built from a clean archive, fingerprint pinned) with migration `0034_password_reset` and `EMAIL_BACKEND=disabled`; the recovery pages then say recovery is unavailable | `docs/plans/password-recovery.md` rollout; `Settings.password_reset_available`; tests above |
| 2 | Release the web at `1b26947` (S1 to S3 accepted on staging) | `PUI-S3_RUNBOOK.md`, 117 header checks, Safari and Firefox acceptance |
| 3 | A verified backup and a restore test of the production database immediately before the migration | procedures in `docs/deployment.md`; **not yet evidenced** |
| 4 | An uptime check on `/readyz` and `/healthz` and a named person reading API logs for the canary window | no monitoring exists |
| 5 | Pin the rollback images (current production API and web) under aliases before changing anything | pattern from the staging scripts |
Deferred (noncritical): the document-status wording for "documents still preparing", Greenhouse phone and location widgets, enforced CSP, HSTS lengthening, container limits, the web image user, extension byte-reproducibility.

## 8. Deployment order (to run only after your explicit approval; nothing executed)
1. Verify production state read-only: `curl -s https://api.xpertapply.com/readyz` shows `0036_application_doc_snapshots`; record running image ids.
2. Backup: custom-format `pg_dump` of production, copy off the host, `pg_restore --list` on the copy, and a restore into a disposable database.
3. Pin rollback aliases for the running API and web images.
4. Apply migration `0034_password_reset` on the production database (additive).
5. Recreate **only** the API container from the new image with `EMAIL_BACKEND=disabled`; verify `/readyz` reports head `0034_password_reset`, `/auth/password-reset/availability` reports unavailable, login and signup work, extension routes still return 401.
6. Recreate **only** the web container from the premium image; verify header contract and the signed-in smoke list in `PUI-S3_RUNBOOK.md` section 5.
7. Observe for the canary window; keep the old images under their aliases.
Rollback: recreate the web, then the API, from the pinned aliases. Do **not** run `alembic downgrade` on production (the extra column and table are harmless to the old image). Commands: the staging scripts' `rollback-web` pattern, adapted for production, to be written and reviewed before step 4.

## 9. Chrome Web Store readiness, and the shortest path to unblock the extension
**Not ready.** Shortest evidence-backed path:
1. Founder approves EXT-E2 Phase B: a throwaway staging account, the repaired artifact (`nogit-4bf77f2` is `647c57c`; rebuild from `212aee3` to include the stale-failure fix), real Greenhouse and Lever first, Workday review-step only. Settle the four Unverified rows of section 1 with a throwaway profile that has a real-looking application email, phone and location.
2. Approve creating a branch from candidate `ec714fd` (extension only) and run `make test-extension`, `make test-web`, `make test-api` on it.
3. Update the Store listing, permission justification and privacy policy for `identity` and per-site access; build the production profile from a clean archive; upload as an unlisted or trusted-tester item.
4. After the item exists, set production `EXTENSION_ALLOWED_IDS` to its ID (a production configuration change needing its own approval), then run the canary with the founder's account.
5. Promote to public only after Lever, Ashby and Workday evidence is real, not synthetic.

## 10. Final decision
- Extension public launch: **NO-GO**.
- Web + API canary with recovery off: **CONDITIONAL GO**, conditions 1 to 5 of section 7, starting with a verified backup.
- Execution waits for your explicit approval; no step above has been run.
