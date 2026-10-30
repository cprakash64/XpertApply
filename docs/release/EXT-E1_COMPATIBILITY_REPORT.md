# EXT-E1: extension "0.3.0" integration gate: compatibility and security report

Status: **read-only investigation plus one local API fix. Nothing pushed, deployed, migrated, published or run against a live staging account.** Production stays NO-GO.
Staging assumed (from the brief, API/web re-probed read-only below): web `1b26947`, API `aa5bc2f`, DB `0034_password_reset`.

## 1. Which "0.3.0"? (identity)
Three different source lines all carry `version: 0.3.0`. None is a tagged or published artifact, and **no 0.3.0 build exists in the working tree** (`apps/extension/dist` and both zips are 0.2.0; this branch's extension tree is 0.2.0). I built from `git archive` into the session scratchpad only.

| Line | Commit | Where | Staging-capable | What it is |
|---|---|---|---|---|
| A | `890892d` | `origin/release/chrome-web-store` | **No** | Store line: website launch handoff only (`/application-sessions/*`), production origins only |
| B | `5b7367f` | local `verify/cws-prepub` (not pushed) | **No** | A + first-use disclosure, isolated text entry, restored launch, ATS auto-activation |
| C | `6458b2d` | local `feature/xa-core1-direct-autofill` (not pushed) | **Yes** (`build:staging`) | B + direct autofill, PKCE connect through `/extension/connect`, staging build profile, direct-entry grant flow, status/teardown fixes |

The brief's flow (connect an account, already-connected detection, disconnect, direct autofill, first-visit overlay) exists **only in line C**. Lines A and B have no account connection at all: each application is launched from the website with a one-time launch token, and their manifest, bridge, sender trust and default API are hard-wired to `xpertapply.com` (`assertProductionBridgeOrigins` and a unit test enforce that). They cannot connect to staging by design, not by defect.

Line C build (scratch, from `git archive`): manifest `0.3.0`, `version_name 0.3.0 (nogit-3a9aaee …; staging)`. `nogit-3a9aaee` is a content fingerprint of the sources, so it is reproducible; the timestamp differs per build. Pinned staging extension ID `cglmdonbfbadfbggkpajpkjgpekhkall`: I re-derived it from the manifest `key` (SHA-256 of the DER key, mapped to a-p) and it matches. Chrome Web Store package: none published or found, so there is nothing to diff against; the local zips are 0.2.0.

## 2. Staging API compatibility
### Line C contract vs staging
Staging API source (`aa5bc2f`) equals this branch's `apps/api` byte for byte. `routes/extension.py` and `applications/direct_sessions.py` are also byte-identical to line C's copies, so the server side C needs is the code staging runs. Routes C calls: `POST /extension/auth/code` (website bearer), `POST /extension/auth/token` (code and refresh), `POST /extension/auth/revoke`, `GET /extension/me`, `POST /extension/direct-sessions`, plus the `/application-sessions/*` set.

**Read-only unauthenticated probes of `https://api-staging.xpertapply.com` (no credentials, no state change):**

| Request | Result | Meaning |
|---|---|---|
| `GET /healthz` | 200 | up |
| `GET /extension/me` | 401 | route exists, auth required |
| `POST /extension/auth/code` `{}` | 401 | exists, website auth required |
| `POST /extension/auth/token` `{}` | 422 | exists, body validated first |
| `POST /extension/auth/revoke` `{}` | 422 | exists |
| `POST /extension/direct-sessions` `{}` | 401 | exists |
| `GET /extension/nonexistent` | 404 | unknown routes do 404, so the above are real |
| `POST /application-sessions/token` `{}` | 422 | exists (lines A, B) |
| `GET /application-sessions/1`, `POST …/1/autofill-results` | 401 | exist |
| `GET /openapi.json` | 404 | docs disabled |
| CORS preflight, origin `https://staging.xpertapply.com` | allowed | |
| CORS preflight, origin `https://xpertapply.com` | 400 | production site not allowed on staging |
| `GET https://staging.xpertapply.com/extension/connect` | 200 | page deployed; its source equals line C's |

For lines A and B all 14 verb/path pairs their API client uses exist at `aa5bc2f`, including the document download. **No missing contract was found.** I did not need to STOP.

### Migrations
**None required.** `0035_extension_auth` is already in staging's chain (0033 → 0035 → 0036 → 0034, head 0034). Nothing newer than 0034 exists in the repo.

### Not provable from outside
`EXTENSION_ALLOWED_IDS` on the staging API. CORS reflects any `chrome-extension://[a-p]{32}` origin (regex), so it says nothing about the allowlist. `/extension/auth/code` enforces it but needs a signed-in test user. Operator check (read-only): `sudo docker exec xpertapply-staging-api printenv EXTENSION_ALLOWED_IDS` must be empty (non-production accepts any well-formed ID) or contain `cglmdonbfbadfbggkpajpkjgpekhkall`, and nothing else. The staging web's empty `NEXT_PUBLIC_CHROME_EXTENSION_ID` is harmless: the web uses it only to validate a store URL, never for connect.

## 3. Architecture (line C)
- **Connect:** the extension opens `chrome.identity.launchWebAuthFlow` on `staging.xpertapply.com/extension/connect?challenge&redirect_uri&state`. The signed-in website page calls `/extension/auth/code`; the browser is redirected to `https://<id>.chromiumapp.org/…?code&state`. The extension checks exact origin and path, then `state`, then error, then exchanges code and PKCE verifier at `/extension/auth/token`.
- **Credentials:** 30-minute access JWT (`typ ext`, own audience and issuer, no `sub`, so it cannot be a website token) plus a rotating 30-day refresh credential in the extension origin's IndexedDB. Content scripts and employer pages cannot read it. Access tokens are attached only by the service worker.
- **Staging isolation:** the staging build replaces host permissions with the two staging hosts, trusts only `https://staging.xpertapply.com` as a bridge and sender, defaults to and accepts only `https://api-staging.xpertapply.com` (a stored `apiBase` override that is not exactly that origin is ignored), and has no production host and no loopback.
- **Employer pages:** no host permission at install. Origins come from the user's per-site grant (`optional_host_permissions https://*/*`, one origin at a time). A supported application URL triggers a Chrome access request plus a `!` badge; nothing is read before the grant.
- Lines A and B: `window.postMessage` handshake validated by `event.source === window` and approved origin, one-time launch token exchanged at `/application-sessions/token`, session package kept in `chrome.storage.session`.

## 4. Security review
Verified in code, by tests, or by the probes above:
- MV3, no CSP override, no remote code. Staging manifest: `activeTab, identity, sidePanel, storage, scripting, tabs`; hosts staging-only; no `<all_urls>`; `externally_connectable` and content script match staging web only.
- PKCE S256, `state`, exact redirect match, code single use decided by an atomic database UPDATE (a failed verifier still burns it), redirect must be the one authorized, refresh rotation with replay revoking the whole family, refresh refused for a different account (`account_changed` signs out), explicit disconnect revokes server-side. API unit tests cover all of this.
- The extension cannot silently switch staging to production: no production host permission, strict API origin list, bridge and sender trust limited to staging. Real-browser test A4 confirms no production host is contacted. A second account replaces, never inherits, the first account's draft (specs G3 and E).
- Logging allow-lists keys; no token is logged (API test and `logger.ts`).
- No code path clicks a final submit control: the only automatic clicks are the apply CTA after a user gesture, repeaters, dropdown/radio/checkbox activation, and Workday "next" with an exact allow-list that excludes Submit. Voluntary self-identification stays unanswered (spec G3).

Findings:

| # | Sev | Finding | Status |
|---|---|---|---|
| F1 | **P2, proven** | Password reset set `password_changed_at` (killing website tokens) but did **not** revoke extension credentials, so a stolen refresh credential survived a reset for up to 30 days. A failing test showed `/extension/me` still 200 after reset. | **Fixed locally, `3454d5f`** (reset revokes the user's live extension families; test added; 83 API tests pass). Needs an API release; no migration. |
| F2 | P3 | `/extension/auth/token` uses one global unauthenticated rate bucket (`exttoken`, 120/min). Anyone can exhaust it and block every extension connect and refresh. | Not changed. Proposal: key it by client address, keep the per-token ceiling. |
| F3 | P2 risk, unverified | Workday auto-advances by clicking "Autofill with resume / Create account / Save and continue / Next / Continue / Apply" once nothing is pending. Review-page detection is by English heading/step text. A tenant whose last control is labelled "Apply" or "Continue" and whose review step is not recognised could be advanced past the point intended. Support level is "limited". | Needs real-tenant acceptance stopping at review; consider disabling auto-advance for Workday until then. |
| F4 | P3 | Staging CORS allows any extension origin. Not a boundary (bearer tokens; the allowlist is enforced at `/auth/code`). | Informational. |
| F5 | info | The staging bundle still contains dead production literals (`true ? staging : production`, production origin sets behind a staging early return). Behavior verified, not reachable. | Informational. |
| F6 | info | `fieldentry.html` is web-accessible on `https://*/*` with `use_dynamic_url` (needed for the employer-page text-entry iframe). | By design; keep reviewed. |

Previously known and not re-tested here (see memory notes): privacy-policy and terms wording for `activeTab`, `/terms` 404.

## 5. Automated results
Environment: scratch export of line C `6458b2d` (and line A `890892d`), Node 22.22.2, Chromium 1228, Playwright 1.61.1, local throwaway API and web servers. **Nothing ran against the staging hosts.**
- **Line A `890892d`:** typecheck, production and e2e builds ok; 89 files, 1356 tests: 1355 passed first run; `ats_lifecycle` timing test failed under load (load average ~45) and passed alone.
- **Line C `6458b2d`:** typecheck ok; production and staging builds ok; 104 files, 1553 tests: 1550 passed first run; 3 failures were my setup omissions (no `dist-e2e-granted`, no `apps/api` for a test that reads the API source) and the 37 tests in those two files pass once supplied.
- **API:** `test_extension_auth`, `test_jwt_algorithm_security`, `test_password_reset` (with the new test): 83 passed (Python 3.12).
- **Real Chromium specs, line C: 51 tests, 0 genuine failures.** The first run failed 17 only because `dist-staging-granted` had not been built; after `build-staging-granted.mjs` the same specs passed. No external traffic in any run (`RELEASE_NETWORK external: []`).

Your brief's items, mapped to evidence (all local fixtures, not staging):

| | Evidence |
|---|---|
| A install/init | extension loads in every real-browser spec; staging manifest and ID tests |
| B connect | `xa-core1-connect` 1: consent page, PKCE, fill, Disconnect revokes (real API, real web page, only Chrome's native window replaced) |
| C already connected | `xa-direct-entry` B3, `xa-ashby-state` B |
| D refresh/restart | `xa-core1-direct` H (credential survives a Chrome restart), `xa-direct-entry` B3 |
| E worker suspension | `xa-direct-entry` B3 ("service worker can be restarted"), `xa13` dormancy |
| F disconnect/reconnect | `xa-core1-connect` 1, `xa-ashby-state` D |
| G expired/revoked | `xa-core1-direct` G2, `xa-ashby-state` C |
| H wrong account/origin/state | `xa-core1-connect` 2 (declined, closed window, forged state, wrong extension ID, network failure), `xa-core1-direct` G3, `xa-ashby-state` E, `xa15` origins |
| I permission denied/revoked | `cws-act1`, `xa-direct-entry` A1-A3 and B4, `xa-core1-direct` F (no grant, nothing read, no network) |
| J no production requests | `xa-direct-entry` A4 and the network audit |
| K no submission | `xa-ashby-state` B, `xa-gh04` G3, `xa13` |

## 6. ATS adapters
| ATS | Support level | Evidence run here | Not shown |
|---|---|---|---|
| Greenhouse | adapter | direct open (B), 7 badge/dropdown/voluntary/disconnect/retry specs pass | real board, resume upload, cover letter |
| Lever | adapter | direct open (C) | multi-field forms, uploads, real board; Lever "truthful autofill" commit is in the line, its dedicated specs were not run |
| Ashby | adapter | direct open (D), 6 state/visual specs pass | real board, uploads |
| Workday | **limited** | simple fixture only (D) | real tenant, multi-step, review stop (see F3) |
Not run (about 150 specs in the full suite): resume upload and cover-letter attachment, dropdown/checkbox/radio matrices, required-versus-optional ledger, partial-fill recovery, duplicate-application detection. I do not claim these. A broad support claim needs the full gate and real forms.

First-visit behavior (fixtures): with no grant, a supported application page causes one Chrome access request and a `!` badge, once per tab and origin; after the grant, one assistant appears (Connect XpertApply if disconnected, fill if connected); no extra window; unrelated pages stay silent. The "stuck detecting" state is covered by specs G6/G7 (preparation failure is reported with a retry).

## 7. Performance (bounded, local)
`xa09` (real Chromium, hostile large forms): 100 controls probe 6 ms, discover 4 ms; 500: 27/15 ms; 1000: 90/45 ms; 2000 and 5000 are refused with `APPLICATION_FORM_TOO_LARGE` in 15 and 37 ms (bounded refusal, not a hang). Not measured: popup responsiveness, first-visit latency in real Chrome, memory growth, API throttling under repeated visits. No load was applied to staging.

## 8. Failures and root causes
No product failure in line C. Environment causes found and handled: missing granted builds and sibling `apps/api` in the export (read as fake failures, as in earlier E2E notes), and one load-sensitive unit test in line A. One proven defect, F1, fixed.

## 9. Proposed minimal corrections
1. Release F1 (`3454d5f`) with the next API release. Code only, no migration.
2. F2: per-client rate key for `/extension/auth/token`.
3. F3: before real-tenant acceptance, either disable Workday auto-advance or require an explicit user click for the final step; accept only with a stop at review.
4. Operator: confirm `EXTENSION_ALLOWED_IDS` as above.
5. Lines A and B are not staging test artifacts; do not try to point them at staging by adding origins.
6. Line C is unpushed and sits on the old premium-less branch tree. Decide how it is integrated before any release; this gate did neither.

## 10. GO / NO-GO
- **Line C staging build (`npm run build:staging`, `6458b2d`): GO for a real-Chrome staging acceptance run**, conditional on the `EXTENSION_ALLOWED_IDS` check and an approved throwaway staging account (none exists or was created here).
- **Line A/B 0.3.0 against staging: NO-GO** (production-only by design).
- **Anything for production or the Chrome Web Store: NO-GO.** No store build was made.

## 11. Manual Chrome acceptance (dedicated Chrome profile, staging test account only)
Build once (clean tree; do not pipe the build into `head`):
```bash
cd /Users/cprakash/Documents/Jobs/XpertApply
git archive feature/xa-core1-direct-autofill apps/extension packages | tar -x -C "$HOME/xa-ext-stg"   # any empty folder
cd "$HOME/xa-ext-stg/apps/extension" && npm ci && npm run build:staging > /tmp/xa-staging-build.log 2>&1; echo exit=$?
```
1. `chrome://extensions`, Developer mode, Load unpacked `dist-staging`. The card must read **XpertApply (STAGING)** with ID `cglmdonbfbadfbggkpajpkjgpekhkall`. Any other ID: stop.
2. In its service worker console: `chrome.runtime.getManifest().host_permissions` must be exactly the two staging hosts; `chrome.identity.getRedirectURL("x")` must start `https://cglmdonbfbadfbggkpajpkjgpekhkall.chromiumapp.org/`.
3. Sign in to `https://staging.xpertapply.com` with the throwaway account; set a synthetic profile (including any work-authorization and demographic answers you want, explicitly).
4. Open a public Greenhouse application URL: expect Chrome's access notice and a `!` badge within seconds, nothing on the page yet. Click the icon, Allow. Expect one assistant reading "Not connected" with **Connect XpertApply**.
5. Connect: Chrome's sign-in window opens on `staging.xpertapply.com/extension/connect`; it names the signed-in email. Approve. The assistant then fills. Count the fields that visibly changed against the count shown. **Do not click Submit.**
6. Reload, restart Chrome, wait 5 minutes (worker suspends): still connected, still one assistant, no second window.
7. Disconnect: assistant says "Not connected" at once; reload: same. In the staging web, sign in as a second account, connect again: the first account's draft and values never appear.
8. Repeat 4-5 on Lever, Ashby, and Workday up to, but not past, the review step. Record where Workday stops. Upload a synthetic resume and cover letter where the form asks; do not submit.
9. DevTools Network on the employer page and the worker: requests only to the employer site and `api-staging.xpertapply.com`; none to `api.xpertapply.com`.
10. Report with screenshots, Chrome version, and any step that differed.
