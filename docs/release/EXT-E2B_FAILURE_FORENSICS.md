# EXT-E2B: failure forensics (Workday permission prompt, Reddit "preparing" error)

Status: **repair committed locally on the line C branch; nothing pushed, deployed, migrated or changed on staging.** Extension source analysed: `6458b2d`. Repair: `d6768f2` on `feature/xa-core1-direct-autofill`. Staging stays web `1b26947`, API `aa5bc2fa`, DB `0034`. Production stays NO-GO.

## 1. Verdict
| | |
|---|---|
| Failure A, Workday site-access prompt | **Expected behavior.** Not a defect. |
| Failure B, Reddit "Detecting… / Preparing…" + generic error | **Mechanism reproduced exactly and fixed.** Whether it was the trigger on your machine is **not proven** (section 4). |
| API / migration gap | None. Every route the direct flow uses exists on staging `aa5bc2fa`; no migration. |

## 2. Failure B: what the screen means
The assistant showed: ATS `Detecting…`, fields 0, filled 0, résumé and cover `Preparing…`, and "Something went wrong while preparing this application."

Read from `ui/applicationAssistant.ts` (`render`, `genericFailureText`, `FAILURE_LABEL`):
- `Detecting…` and `Preparing…` are **initial-view defaults**, shown whenever a session exists and no ATS name has arrived yet. They are not progress; nothing was running.
- The generic sentence is shown when a failure code has **no text** and no field was read.
- So the state is: a draft/session existed, the worker recorded a failure with an unlabelled code, before the form was read.

Codes the worker or content script can raise that had no text: `RUNTIME_MISMATCH`, `RUNTIME_WORKER_UNREACHABLE`, `API_BASE_MISMATCH`, `AUTHENTICATED_USER_MISMATCH` (content `verifyRuntime`, `content/bootstrap.ts`), `NO_MATCHING_FRAME` and `PROTOCOL_MISMATCH` (`background.ts` `handleContentReady`, `validateLaunch`).

### Root cause reproduced
`background.ts` `launchWebRuntime()` returns the account and deployment recorded by the **last website launch** (`jobpilotWebRuntimeV2` in `chrome.storage.local`, written on `STAGE_LAUNCH` / `LAUNCH_REQUEST`, never expired). `RUNTIME_IDENTITY` handed it to `evaluateHandshake` for **every** run, including a direct draft the extension opened for its own account, which no website launched. If the website was last signed in as another account (`AUTHENTICATED_USER_MISMATCH`) or on another deployment (`API_BASE_MISMATCH`), `fill()` refused the run before reading the form.

Reproduced in real Chromium (isolated profile, synthetic employer, owned mock API): with that record seeded, the overlay read exactly `Detecting…`, `0`, `0`, `Preparing…`, `Preparing…` and the generic error; stored failure code `AUTHENTICATED_USER_MISMATCH` / `API_BASE_MISMATCH`. A record for the same account filled normally (control).

### What is NOT the cause (each reproduced, none matches the screen)
| Scenario (real Chromium) | Result |
|---|---|
| Signed out | `DIRECT_SIGNED_OUT`, "XpertApply isn't connected… Connect", ATS `—` |
| Direct draft 500 / 404 / 403 / 422 | `DIRECT_UNAVAILABLE`, "couldn't prepare… check profile and online", ATS `—`, one retry button |
| Package fetch 403 / 500 | same `DIRECT_UNAVAILABLE` text |
| Package fetch 401 (after one refresh) | `DIRECT_SIGNED_OUT` text |
| Embedded Greenhouse iframe on a custom careers domain, opened directly | No draft, no assistant (see risk R1) |

## 3. Repair (`d6768f2`)
1. `background.ts` `RUNTIME_IDENTITY`: for a tab whose stored workflow is a **direct draft** the website fields are answered unknown. Build-id, worker, API-base and environment checks between the extension's own parts are unchanged, so a mixed-build or wrong-backend runtime is still refused. Website launches are unchanged.
2. `ui/applicationAssistant.ts`: text for the six codes above; `Detecting…` and `Preparing…` are shown only while a run is under way, otherwise `—` and `Not started`. No error is swallowed; the code still reaches `failureCode`.
3. Nothing loosens host permissions, auth, CSP or token handling.

Regression tests (all fail before the repair, or assert the previously missing text):
- `src/__tests__/application_assistant.test.ts`: six code texts, no generic error, no Detecting/Preparing after failure, still shown while running.
- `e2e/xa-e2b-stale-web-record.spec.ts`: direct application fills with a stale other-account record and with a stale other-deployment record.
- `e2e/xa-e2b-api-failures.spec.ts`: 401/403/404/422/5xx end in a stated assistant with nothing filled.
- `src/__tests__/workday_site_access.test.ts`: which Workday URLs ask Chrome for access.

## 4. Remaining uncertainty on failure B
- The Reddit URL, the staging account used on the website and the extension account were not given, and the worker's stored failure code was not captured. The screen is **consistent** with the reproduced cause and with any other unlabelled code (`NO_MATCHING_FRAME`, `PROTOCOL_MISMATCH`, `RUNTIME_MISMATCH`); the repair now names whichever it was.
- The ATS adapter for Reddit is **not determined**: Reddit is not a listed provider (`ats/providers.ts`) and no source or fixture mentions it. If its careers page embeds a Greenhouse form in an iframe, see R1.
- To settle it, in the Reddit tab after reproducing, open `chrome://extensions` → XpertApply (STAGING) → service worker, and run:
  `(await chrome.storage.local.get('jobpilotWebRuntimeV2')).jobpilotWebRuntimeV2` and `JSON.stringify(await chrome.storage.session.get('viewStates')).match(/failureCode[^,]+/g)`. Share only those two values.

## 5. Failure A: Workday
`background.ts` `offerSiteAccessForSupportedApplication`: Chrome grants an extension nothing about employer sites at install, so the only way to be offered access is `permissions.addHostAccessRequest` plus a toolbar `!`. It runs **only** for an application page of a listed provider (`ats/providers.ts`: Workday `applicationPath` is `/apply`, `/applyManually`, `/autofillWithResume`, `/job/…/apply`). Verified by test: a tenant's job description, home page and look-alike hosts do **not** ask; `…/apply` URLs do. One request per tab and origin; a reload never repeats it.
- **Deny / ignore:** nothing is read or sent; the badge stays; Chrome's menu or the assistant button can ask again (`xa-direct-entry` A1, A3, B4; `xa-rc06-activation` R1).
- **Grant:** `permissions.onAdded` registers the per-site script; the direct flow takes over (`xa-direct-entry` B3; `xa-core1-direct` D Workday).
- **Restoration:** after a worker restart the registration and sign-in survive (`xa-direct-entry` B3 restarts the worker; `xa-core1-direct` H restarts Chrome). Removing a grant and revisiting is read from the code (the offer re-runs once per tab and origin) but was **not** exercised here.
- Workday remains **limited**: auto-advance (E1 finding F3) is untested on a real tenant and is not changed here.
- Unverified: Chrome's real prompt wording on desktop Chrome, and the exact GM URL you were on (the prompt implies it was an application URL; a plain job page would not have asked).

## 6. Tests run (scratch export of `d6768f2`, not the canonical tree)
| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 105 files, 1,569 tests, all pass |
| Playwright: `xa-e2b-stale-web-record`, `xa-e2b-api-failures` | 9 pass |
| Playwright: `xa-direct-entry` (staging builds), `xa-core1-direct` | 20 pass |
| Playwright: `embedded-application-frame`, `session-handoff`, `xa-rc06-activation`, `xa11`, `xa12-*`, `xa13` | 18 pass |
| Network containment (release harness) | zero external requests, zero production hosts |
Not run: ~130 other e2e specs, real FastAPI integration, Chrome stable on the founder's desktop, real Workday/Reddit/Greenhouse.

## 7. Risks left
- **R1 Embedded direct applications.** A direct draft is created only from a **top-frame** form. A careers page that embeds the ATS form in a cross-origin iframe, opened directly, gets no draft and no assistant, silently (reproduced). If Reddit is that shape, nothing will be offered until a website launch or a design change. Not changed here.
- **R2 Indefinite "detecting".** Worker responses `HOST_PERMISSION_MISSING`, `STALE_AUTHORITY` and `DOCUMENT_ID_UNAVAILABLE` in `handleContentReady` answer the page without recording a failure; if one fires after a draft was created the view can stay on its default. No timeout exists. Not reproduced; documented, not fixed.
- **R3 Stale record still applies to website launches** whose last website state differs; that is the intended check.
- **R4 Mixed signals:** with a 401 on the package fetch the assistant says "not connected" while the account row still says "Connected as…" until the next refresh (cosmetic, reproduced).
- Line C is unpushed and not integrated with the premium UI branch; F1 (`3454d5f`) is local, unreleased.

## 8. Retest in an isolated desktop Chrome (about 10 minutes)
1. Clean profile; build the extension from `d6768f2` with `npm run build:staging` in a clean `git archive`; Load unpacked; confirm ID `cglmdonbfbadfbggkpajpkjgpekhkall`.
2. Reproduce the condition: sign in to the staging website as account A, use **Apply with XpertApply** once, then connect the extension as account B. Open a supported application URL and allow the site. **Expected now:** the assistant fills (or states a specific problem), never `Detecting…` beside the generic error.
3. Workday: open a tenant job page (no prompt), then its `/apply` page (one Chrome prompt and a `!`); Deny, reload (no second prompt), then allow.
4. Do not submit anything; stop at review.

## 9. GO / NO-GO for EXT-E2 Phase B
**CONDITIONAL GO**, unchanged conditions from E2A plus: Phase B must use the repaired build (`d6768f2` or later), not `6458b2d`. Before Phase B, capture the two console values in section 4 if the Reddit screen recurs on the repaired build. Production: **NO-GO**.
