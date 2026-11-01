# EXT-FINAL-02: production identity and launch unblock

Nothing here was pushed, deployed, published or submitted. No production request other than anonymous GETs of public pages and the readiness probe was made. No Hunter or Networking change.

## 1. Extension identity (read-only audit)

| ID | What it is | Evidence |
|---|---|---|
| `gnibjomjfdobadlockphjiibbpmiehcj` | The Chrome Web Store item "XpertApply — Assisted Apply" (production). Owner-proven **Draft, unpublished**, uploaded package 0.2.0 | `docs/release/chrome-web-store/stable-id-handoff.md` (commit `099cff9`), PUI-STG2 report section D |
| `cglmdonbfbadfbggkpajpkjgpekhkall` | The separate `XpertApply (STAGING)` unpacked build, pinned by a public key whose private half was discarded | `apps/extension/STAGING.md`, `src/staging-extension-key.mjs` |

They are two different extensions. The staging ID must never be used for production, and no second Store item is needed or may be created.

Facts established:
- Production web (checked in the live page bundle) already embeds `NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjom…`. Install URL is unset, correctly, because the item is unpublished.
- No public key for the Store item is recorded anywhere in the repository. Chrome derives an ID from a key, so the ID cannot be reproduced for an unpacked build without it.
- The release ZIP (manifest has no `key`) is correct for Store upload: the Store assigns the key.
- Production API `EXTENSION_ALLOWED_IDS` cannot be read without production access. The API fails closed when it is empty, so Connect is refused until the Store ID is added. The `.env` that feeds it is private and is not in the repository.

### What the operator must do to obtain the public key (identity-dependent steps stop here)
1. Chrome Web Store Developer Dashboard, open the existing item `gnibjomjfdobadlockphjiibbpmiehcj` (do not create another).
2. **Package** tab, **Upload new package**, choose the ZIP in section 4, save as draft. Do **not** click Submit for review.
3. In the same **Package** tab choose **View public key** (the "Build your package" public key) and copy the base64 text. This is a public key; it is not a signing secret. Never copy or share any `.pem` private key.
4. In the worktree:
   ```bash
   cd /Users/cprakash/Developer/XpertApply-extfinal/apps/extension
   XA_STORE_PUBLIC_KEY="<paste key>" npm run store-id:unpacked
   ```
   The script derives the ID from the key and **refuses to build unless it is exactly `gnibjomjfdobadlockphjiibbpmiehcj`**. It writes `dist-store-id/` (production build plus `key`). Load that folder via `chrome://extensions` > Developer mode > Load unpacked and confirm the card shows that exact ID. `dist-store-id/` is for acceptance only and must never be uploaded; the ZIP stays keyless.

## 2. Integration changes in this commit
- Web sign-out / account-switch teardown: already ported in `8665fbe` (`extensionRuntime.ts`, `authSession.ts`). Verified in a real browser: `xa12-account-replacement`, `xa12-session-teardown` 4/4.
- `/support` page added (`apps/web/app/support/page.tsx`), linked from the public footer and sitemap, with a unit test. It uses only the contact address the site already publishes (`privacy@xpertapply.com`) and states no commitments. **Founder: confirm that is the support contact you want public**, or give another approved address.
- `/terms`: nothing in the repository links to it and no approved Terms text exists, so none was created. No broken Terms link was found on `/`, `/privacy`, `/login`, `/signup` or `/pricing`. If the Store listing or any worksheet cites a Terms URL, approved text is needed first.
- Privacy policy: live at `/privacy` (200), last updated 2026-09-26, names the extension, page access, extension storage, retention and Chrome Web Store Limited Use. Content matches the extension's behaviour as audited in EXT-FINAL-01. Re-confirm the "Last updated" date after you approve any wording change.
- Install links: `NEXT_PUBLIC_CHROME_EXTENSION_URL` must stay empty until the item is published and a canonical detail URL exists (the web validates that the URL's ID equals the configured ID).
- `apps/extension/src/store-identity.mjs`, `scripts/store-id-unpacked.mjs`, test `store_identity.test.ts` (4 tests): the ID guard above.

## 3. Real acceptance

Evidence collected here (no production account, no desktop Chrome UI):
- **Real backend drafting contract**: `xa-nav02-real-api` ran the real FastAPI code at `32a7d54` (the NET-PROD-08 line) on a disposable local Postgres 16 container (now stopped) with only the OpenAI endpoint stubbed: **9 passed, 1 skipped** (the skipped case compares against an older checkout, `XA_REAL_API_DIR_OLD`). It covers per-account authorization, cross-account isolation, expired sessions, provider rate limit, malformed output, fabricated evidence, contact details in drafts, reload races and the per-account rate limit. No job was submitted.
- Finding: `APPLICATION_ANSWER_DRAFTING_ENABLED` defaults to **false** and is not passed by `compose.production.yml`. In production the draft route therefore answers 503 `answer_drafting_disabled`, which the extension tolerates (autofill continues). Drafting is optional; leave it off for launch. Enabling it is a separate, guarded decision that also needs the OpenAI key and data-handling review.
- Earlier (EXT-FINAL-01, unchanged code): real-Chromium suite, connect 3/3 against real API code, account teardown 4/4, unit tests, production-build smoke.

**Native desktop Chrome with a production account (C1 to C14): PENDING.** I cannot sign in with a password, create accounts or drive your desktop Chrome, so these need you. They are only meaningful after both the API allowlist release and the web release below, and with the Store-ID unpacked build from section 1.

Production-adapted steps (use a disposable test account; never submit an application):

| # | Do | Expect |
|---|---|---|
| C1 | Load `dist-store-id/`; open a Greenhouse application page; allow the site; click Connect XpertApply | Chrome's own sign-in window opens at xpertapply.com/extension/connect |
| C2 | Approve as account A | Window closes; "Connected as A" |
| C3 | Disconnect, connect again, Cancel; repeat by closing the window | Stays "Not connected" with a clear message |
| C4 | Edit the connect URL's redirect to another ID, or load a second unpacked copy without the key | Refused (400); no code issued |
| C5 | `chrome://serviceworker-internals`, stop the XpertApply worker, reload the page | Still connected, one assistant |
| C6 | Quit and reopen Chrome | Still connected |
| C7 | Disconnect, reload, reconnect | Not connected immediately and after reload; reconnect works |
| C8 | Let or force the access token to expire | Silent refresh, or a clear reconnect prompt; no stuck state |
| C9 | Sign out on xpertapply.com in a tab | Extension immediately shows Not connected (the teardown fix) |
| C10 | Sign in as account B, connect, open the same job URL | Only B's data; none of A's |
| C11 | Employer-tab console `window.postMessage` forged launch request | Ignored |
| C12 | Employer-tab console: search `localStorage`, `sessionStorage`, cookie and DOM for the token | Not present |
| C13 | DevTools Network on the employer tab and the service worker | Only `api.xpertapply.com` / `xpertapply.com`, plus the employer's own hosts |
| C14 | Never press the employer's Submit | Nothing submitted |

Then per ATS: Greenhouse, Lever, Ashby: confirm auto-detect and overlay open, no extra window, fields filled from the profile, your edits not overwritten after refresh and on a repeat visit, sponsorship filled only if you saved that answer, demographics left blank, one assistant only. Workday: expect the manual / limited path.

## 4. Release artifacts

| | |
|---|---|
| Extension code commit | `8665fbecfa1ff49cbacf76aa845b95888afaa34c` (unchanged) |
| Release ZIP | `apps/extension/xpertapply-extension.zip`, copy `~/Developer/XpertApply-builds/xpertapply-extension-ext-final-01-8665fbe.zip` |
| SHA-256 | `18b98e1c690d8c3c41258694039008b106254887893b2836fea420c7012f279d` (unchanged: this commit adds only files outside the packaged build) |
| Extension ID | `gnibjomjfdobadlockphjiibbpmiehcj` |
| This commit | see `git log` on `release/ext-final-01` (hash is recorded in the final report) |

Checks run on this commit: extension unit tests (new file 4/4), web unit tests 1,245 pass including the new support test, `tsc` clean, production compose test passes.

## 5. Guarded releases (prepared, not run)

**Order: web, then API allowlist, then Store review, then connect test.**

1. **API allowlist (smallest release).** In the private production `.env`, set exactly:
   ```
   EXTENSION_ALLOWED_IDS=["gnibjomjfdobadlockphjiibbpmiehcj"]
   ```
   Back up the `.env` first. Then recreate **only** the API container (`env_file` is read at creation). Use the same compose file list as the live container's labels (the NET-PROD-08 image override included) so it keeps the current image; do not rebuild, do not touch the web, database, Hunter or Networking variables. Verify with: `/readyz` 200; a preflight from `chrome-extension://gnibjom…` accepted; an unlisted ID refused with 400; `/extension/me` still 401 unauthenticated.
2. **Web.** Rebuild web from this branch's `apps/web` (teardown fix plus `/support`) with `NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj` and `NEXT_PUBLIC_CHROME_EXTENSION_URL` unset, then replace only the web container. Verify `/support` 200, `/privacy` 200, home unchanged.
3. **Rollback.** API: restore the previous `.env` line (empty or prior value) and recreate the API container again; Connect then fails closed and nothing else changes. Web: redeploy the retained previous web image (`c79dc349`, NET-PROD-08 line). Store: an unreleased draft can be left unsubmitted or replaced; a published version can be superseded by uploading a higher version.

## 6. Chrome Web Store assets and declarations
- Listing: name "XpertApply — Assisted Apply", category Workflow & Planning, English, 128×128 icon present in the Dashboard. Homepage `https://xpertapply.com/`. Support URL `https://xpertapply.com/support` (after web release). Privacy policy `https://xpertapply.com/privacy`.
- Still missing: screenshots (at least one, 1280×800), small promo tile. Capture them from the C-run **after** a successful real connection; use the disposable test account and fake profile data, never real personal data.
- Single purpose: fill the user's own job applications from their XpertApply profile; the user reviews and submits.
- Permission justifications: `activeTab`, `tabs`, `scripting`, `storage`, `sidePanel`, `identity`, optional `https://*/*` per origin, and the three xpertapply hosts: see the checklist in `EXT-FINAL-01_REPORT.md`.
- Data disclosures: collects personally identifiable information (profile the user provided), authentication information (account sign-in), and website content (the application page's form fields) only to provide the feature. Not sold; not used for unrelated purposes or creditworthiness; no analytics; no remote code. Certify Limited Use compliance, which the privacy policy states.

## 7. Verdicts

| Workflow | Verdict |
|---|---|
| Real login against production | **BLOCKED**: API allowlist not yet set; Store public key not yet obtained; native run pending |
| Account switching / sign-out teardown | **PASS** in real Chromium (4/4); production confirmation **PENDING** native run and web release |
| Real API drafting | **PASS** against real backend code and disposable Postgres (9 pass); **off in production by design** |
| Greenhouse, Lever, Ashby | **PASS** on fixtures in real Chromium; native desktop run **PENDING** |
| Workday | Limited / manual fallback by design; native confirmation **PENDING** |
| Store readiness | **NOT READY**: needs screenshots, public key, native acceptance, `/support` live |

## 8. Actions still required from you, in order
1. Confirm `privacy@xpertapply.com` as the public support contact (or give another).
2. Upload the ZIP as a **draft** to the existing item and copy its public key (section 1). Send me the key, or run the `store-id:unpacked` command yourself.
3. Authorize the guarded web release, then the API allowlist release (section 5).
4. Run C1 to C14 and the ATS checks on a disposable account; capture screenshots.
5. Submit the Store review yourself.
