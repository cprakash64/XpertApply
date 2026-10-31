# EXT-E2 Phase B: staging account connection acceptance

Status: **Stages 1 and 2 executed. Stage 3 (real desktop Chrome with staging accounts) NOT executed.** The brief allows Stage 3 only after the founder explicitly authorizes disposable test accounts; this brief does not contain that authorization, so no account was created, no sign-in was performed, and desktop Chrome was not operated. Nothing was pushed, deployed, migrated, published or changed on any server. Production was not contacted. Every browser check below was run in **Chrome for Testing 149 under Playwright, which is not desktop Chrome**, and is labelled as such.

## 1. Stage 1: artifact (executed)
| | |
|---|---|
| Source | commit `212aee3` on `feature/xa-core1-direct-autofill`; tree `d31737b99ab8140b0694dffb25f79e056a5b2d01`; `apps/extension` subtree `f2bf9357ed9a5e5888012e0e2427e52182ae6492` |
| How built | clean `git archive 212aee3 apps/extension packages` into an empty scratch folder (no `.git`, no worktree), `npm ci`, `npm run build:staging`. The canonical premium UI worktree was not touched (still `feature/premium-ui-overhaul`; its untracked files are unchanged) |
| Build id | `nogit-4df4b86` (not the `647c57c` artifact's `nogit-4bf77f2`; that artifact was not reused) |
| Artifact path | `/private/tmp/claude-501/-Users-cprakash-Documents-Jobs-XpertApply/1c58020f-faa8-4586-8961-6ea6a0a780c9/scratchpad/e2d/artifact/xpertapply-staging-nogit-4df4b86` |
| Checksums | 20 files in `…/scratchpad/e2d/artifact/SHA256SUMS.txt`, whose own SHA-256 is `0a41ddd796bcca379c932bee4757b9064b3b3131d0b753e2484aa02d00f39cbe`. `background.js` `30f47ce7914e…`, `content.js` `bac0867bd803…`, `sidepanel.js` `3d536f9142b1…` (full values in the file), `manifest.json` `1f7a26662160…`. File bytes embed the build time, so verify by build id and manifest, not by hash across builds |
| Version and profile | `name` `XpertApply (STAGING)`, `version` `0.3.0`, `version_name` `0.3.0 (nogit-4df4b86 2026-10-31T01:15:14.681Z; staging)` |
| Permissions | `activeTab, identity, sidePanel, storage, scripting, tabs`; host permissions exactly `https://api-staging.xpertapply.com/*` and `https://staging.xpertapply.com/*`; optional per-site `https://*/*`; `externally_connectable` and the content script only `https://staging.xpertapply.com/*`. **Identical to the `647c57c` artifact's manifest apart from `version_name`: no host or API permission added** |
| Extension ID | the manifest `key` derives `cglmdonbfbadfbggkpajpkjgpekhkall`; loaded in Chrome for Testing 149 (isolated empty profile, **not desktop Chrome**), `chrome.runtime.id` and the `chrome://extensions` card both read it: exact match; card ENABLED, UNPACKED, 0 errors; redirect URL `https://cglmdonbfbadfbggkpajpkjgpekhkall.chromiumapp.org/xpertapply` |
| Network at start | 0 requests of any kind with every hostname forced to fail DNS; service worker stayed alive and logged only `service worker active` |
| Production strings | the bundles contain the same production URL strings in the same counts as before (one `api.xpertapply.com` per bundle, from the unreachable branch of the staging-profile switch); nothing resolves to a production host at run time (E2B/E2C network-containment and `xa-direct-entry` A4 checks) |
Source gate on the clean archive: typecheck clean; 1,596 unit tests pass (section 5).

## 2. Stage 2: server preflight (read-only, unauthenticated)
| Check | Result |
|---|---|
| API health | `GET https://api-staging.xpertapply.com/healthz` 200 `{"status":"ok"}` |
| Database revision | `/readyz`: ready, database and Redis connected, `current_revision` = `head_revision` = `0034_password_reset`, schema up to date |
| Extension routes present | `GET /extension/me` 401 "Missing token"; `POST /extension/direct-sessions` 401; `POST /extension/auth/code` 401; `POST /extension/auth/token` 422 (body required); `POST /extension/auth/revoke` 422; an unknown `/extension/…` route 404. All five exist and demand credentials |
| Password reset | `GET /auth/password-reset/availability` 200 `{"available":false}`: routes exist, email recovery off on staging |
| CORS | preflight from `chrome-extension://cglmdonbfbadfbggkpajpkjgpekhkall` is allowed for `authorization, content-type`; a preflight from `https://evil.example` returns 400 |
| Web | `https://staging.xpertapply.com/extension/connect` 200; enforced CSP `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`, Report-Only CSP naming only `api-staging`, HSTS `max-age=300`, `X-Frame-Options: DENY`. The connect page takes the redirect from the request and validates its shape; it needs no extension ID in the web build |
| Compatibility with the build | the routes the staging build uses (`/extension/auth/*`, `/extension/direct-sessions`, `/application-sessions/*`) all exist; `extension.py` is byte-identical between the premium branch and line C (E1); no migration is needed |
| **Extension allowlist** | **NOT verifiable from here.** `POST /extension/auth/code` needs a signed-in user before it checks the redirect, and no unauthenticated route reveals `EXTENSION_ALLOWED_IDS`. Staging compose requires the variable and `staging_guard` validates 1 to 5 IDs, so it is set; whether it contains the pinned ID needs either the operator's read-only `sudo docker exec xpertapply-staging-api printenv EXTENSION_ALLOWED_IDS`, or test C4 below (which proves it from the browser) |
Staging web and API *image* identities (`1b26947`, `aa5bc2fa`) cannot be read from outside the host; they were taken from the S3 and API release records. Nothing was deployed or changed.

## 3. Stage 3: real desktop Chrome (NOT RUN; protocol ready)
### Preconditions (founder)
1. Explicit written authorization for up to **two** disposable staging accounts (A and B), synthetic names, controlled deliverable aliases, no real documents.
2. A dedicated desktop Chrome profile, Chrome 133 or newer; **record the exact version** (`chrome://version`). No other extensions.
3. Operator confirms `EXTENSION_ALLOWED_IDS` (command above), or accepts test C4 as the proof.

### Install
Remove any old XpertApply card; `chrome://extensions`, Developer mode, **Load unpacked**, choose the artifact folder above. Expect name `XpertApply (STAGING)`, ID `cglmdonbfbadfbggkpajpkjgpekhkall`, version `0.3.0 (nogit-4df4b86 …; staging)`, Errors 0. In the service-worker console, `chrome.runtime.getManifest().host_permissions` must list only the two staging hosts.

### Tests and what to send back
Send a screenshot or copied text for each; **never send tokens, passwords or raw network exports** (strip `Authorization` and cookies from any HAR).

| # | Test | Steps | Pass condition |
|---|---|---|---|
| C1 | Native sign-in window | On a supported application page that is not submitted, allow the site, click **Connect XpertApply** | Chrome's own window opens on `staging.xpertapply.com/extension/connect`, shows the signed-in staging email and an Approve / Cancel choice |
| C2 | Approval | Approve as account A | Window closes; assistant shows `Connected as <A's email>` |
| C3 | Denial | Disconnect, connect again, choose Cancel; repeat by closing the window | Assistant stays "Not connected" with the declined/cancelled text; no credential exists (service-worker console: `indexedDB.databases()` shows the auth DB empty of a record, checked without printing values) |
| C4 | Wrong extension ID (also proves the allowlist) | Signed in to staging in a normal tab, open `https://staging.xpertapply.com/extension/connect?redirect_uri=https%3A%2F%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org%2Fx&code_challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&state=x`, click Approve | The page reports failure and Chrome never hands anything to that ID; the request is rejected as invalid (400) |
| C5 | Worker restart | `chrome://serviceworker-internals`, stop the XpertApply worker, reload the application page | Still connected as A, one assistant |
| C6 | Browser restart | Quit and reopen Chrome, same profile | Still connected as A (credential persisted); no sign-in prompt |
| C7 | Disconnect and reconnect | Click Disconnect, confirm; reload; connect again | "Not connected" immediately and after reload; reconnect works; the web connect page issues a new code |
| C8 | Expired session | In the service-worker console set the stored access token's `expiresAt` to the past (script supplied on request; it edits only the local record) and use the assistant | One silent refresh, still connected as A; no new window |
| C9 | Revoked session | From a second Chrome profile signed in as A, disconnect, or the operator revokes A's credential family in the staging database only | The next action in the first profile signs the extension out ("Not connected"), nothing is filled |
| C10 | Cross-account isolation | Connect as B after disconnecting A; open the same application URL | B's data only; A's draft and values never appear; account row shows B |
| C11 | Wrong-origin and forged messages | On the employer tab console run `window.postMessage({type:"JOBPILOT_LAUNCH_REQUEST",payload:{sessionId:1,officialUrl:"https://evil.test/apply"}},"*")` and the same for `XPERTAPPLY_OVERLAY_DISCONNECT` | Nothing happens: no draft, no disconnect, account row unchanged |
| C12 | No token exposure | On the employer tab console: `JSON.stringify([localStorage, sessionStorage, document.cookie, document.documentElement.outerHTML]).includes("eyJ")` | `false` (access tokens are JWTs starting `eyJ`) |
| C13 | No production requests | DevTools Network (employer tab and service worker), filter `xpertapply.com` | Only `api-staging.xpertapply.com` (and employer hosts); zero requests to `api.xpertapply.com`, `xpertapply.com` or `www.xpertapply.com` |
| C14 | Nothing submitted | Never click the employer's submit control | The employer form is never submitted |

### Results (to be filled by the tester)
Chrome version: _not recorded_. C1 to C14: **NOT RUN**.

## 4. Failures and root causes
None observed. Nothing in Stages 1 and 2 failed. The only open item is that the allowlist content could not be confirmed (section 2).

## 5. Verification detail and automated stand-ins
Automated real-Chromium evidence from earlier gates still applies to this source (same tree as `647c57c` plus the stale-failure fix): `xa-e2c-isolation` (disconnect, account change, worker stopped, expired token, forged messages), `xa-core1-direct` G1 to G3, H, `xa-direct-entry` B2 (native sign-in invoked with the staging site and the staging redirect). These are **Chrome for Testing**; Chrome's own consent window cannot be automated and has never been exercised against the staging hostnames, which is why C1 to C4 are mandatory.
Clean-archive source gate for `212aee3`: typecheck clean; unit suite **106 files, 1,596 tests, all pass**. The first run showed 4 failures that were missing prerequisites in the bare archive, not defects: no production build (`dist/`), no e2e build (`dist-e2e-granted`), and no `apps/api/app/routes/extension.py` for the redirect-rule test. After `npm run build`, `npm run build:e2e` and adding that one file to the archive, all 1,596 pass.

## 6. Remaining risks
- Stage 3 not run: the native sign-in window, the real grant prompt, the `!` badge, token refresh against the real API and Chrome restart persistence are unproven in desktop Chrome.
- Allowlist content unverified (C4 or the operator command settles it).
- The embedded-form limitation, an unbounded quiet fill, Workday auto-advance (F3), Greenhouse phone and location widgets, and the Reddit email/phone/location/documents rows from the production report remain open.
- Line C is unpushed; candidate `ec714fd` is unmerged (not merged here, as instructed).
- Password recovery stays unavailable on staging, so A and B cannot recover a forgotten password; use passwords the tester records.

## 7. GO / NO-GO for subsequent ATS testing
**NO-GO until Stage 3 passes in desktop Chrome.** What Phase B has established: the artifact is the intended source, pinned ID, staging-only permissions, no production traffic at start, and staging is healthy and route-compatible. What it has not: any real account connection. After C1 to C14 pass (C1 to C4 and C13 are the gating ones), ATS testing may begin with Greenhouse and Lever first, Workday at the review step only, none submitted.
