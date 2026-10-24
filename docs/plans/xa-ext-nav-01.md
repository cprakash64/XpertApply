# XA-EXT-NAV-01 — multi-step application navigation and auto-launch

Status: implemented on `feature/xa-core1-direct-autofill` after `a36fb22`. Not pushed, not deployed. **Native Chrome acceptance on the real Waymo job is NOT VERIFIED** (not possible from this environment); every result below is a real Chromium with the real unpacked extension against local TLS fixtures under real hostnames.

## Failure and confirmed causes

Observed (Waymo job 5357): the website launch opens a job-details page; the user (or the extension) presses "Apply now"; the real form appears but the assistant shows "This page doesn't match the prepared application", Fields found 0, Resume/Cover letter "Preparing…", Fill disabled, and nothing opened by itself.

| Suspected cause | Verdict | Evidence |
| --- | --- | --- |
| Navigation race: the destination document sends `CONTENT_READY` before the launch has learned where the tab is going, is judged against the listing URL and gets a **terminal** `HANDOFF_URL_MISMATCH` | **CONFIRMED** | same-tab anchor/button specs failed on the previous build; fixed by adopting the destination from a live, bounded activation (`adoptActivationDestination`) |
| SPA `pushState` into the form: Chrome's `sender.url` stays the original document URL while `sender.tab.url` is current | **CONFIRMED** | SPA spec; `currentTopFrameUrl` uses the tab URL only when it is on the sender's own origin |
| New tab: destination tab had a launch but no view, so the assistant had nothing to render | **CONFIRMED** | `bindTabToLaunch` now seeds the view |
| Path heuristic accepted any two jobs sharing a word ("engineer") | **CONFIRMED** (it let an unrelated job be filled) | `urlsMatchForHandoff`: generic-title stoplist, explicit job-id rule (`gh_jid` …), apply-suffix rule |
| Apply-now click was not tied to the launch when the control had several plausible candidates | **CONFIRMED** | trusted-click observer sends `PREPARE_APPLICATION_LAUNCH` for the control the user chose |
| Content-script flag initialised after `initAtsPage()` ran (module evaluation order) disabled the observer | **CONFIRMED, found by test** | the observer no longer reads late-initialised module state |
| Document status stuck on "Preparing…" | **PARTLY CONFIRMED**: genuinely pending while the launch was unresolved; it cleared once the launch resolved. Nothing reports UPLOADED merely because a file input exists (spec asserts it). |
| Missing host permission | **REJECTED** for this path (no manifest change) |

## Design
* One session system. The existing `PendingLaunch`, the 90 s `PendingActivation` (source tab, destination tab, redirect sequence ≤ 6) and the tab view are reused.
* `adoptActivationDestination` (worker): only the top frame, only the launch's own tab (or a tab the live activation opened), only the same session id, only https (or loopback http), only an origin that joins the launch workflow. Same employer domain alone is never enough: with no live Apply activation a different job is refused.
* Ambiguous listing (several plausible Apply controls to different destinations): nothing is clicked for the user. The assistant says "Click Apply now to continue. XpertApply will follow you to the application form." and a user click on one of the controls keeps the session. While following a hop it says "Opening the employer's application form…".
* Listing-stage failures (`HANDOFF_URL_MISMATCH`, `APPLICATION_CTA_AMBIGUOUS`, `NAVIGATION_NEEDS_USER_GESTURE`, `APPLICATION_CTA_NOT_FOUND`) recorded before the real form arrives are cleared when the form matches.
* `tabHasLaunchEvidence` gates `reconnectWorkflow`: a tab with no launch evidence is not part of the launch.
* No new permissions, no manifest change, no backend change.

## Validation
* `e2e/xa-nav01-multistep.spec.ts` (10 tests, real extension, one worker, zero retries): same-tab anchor sharing the slug; anchor sharing no token; button with script navigation; `target=_blank`; cross-origin ATS; SPA route; ambiguous buttons plus manual click; same-domain unrelated page refused; unrelated navigation after the hop refused and stale activation not reusable; worker suspended between click and navigation, then reload.
* `src/__tests__/nav01_multistep.test.ts`: tab-URL trust, job identity rules.
* vitest: 103 files / 1547 tests. Full Playwright results and builds: see the handoff.

## Known unsupported
* Login walls, CAPTCHA, multi-job listings with no distinguishing control: the user is told what to do; nothing is bypassed or guessed.
* Scenarios from the mission list not covered by a dedicated new test (permission revoke/regrant, auto-open disabled, expired session, two jobs open, resume/cover preparing→ready) rely on the existing `cws-p1-*`, `xa-direct-entry`, `session-handoff`, `xa12-*` specs.

## Native Chrome acceptance (manual, NOT VERIFIED)
1. `npm run build:dev` (or the staging profile) in `apps/extension`; `chrome://extensions` → Reload the unpacked extension; **close and reopen** the employer tab.
2. Start "Apply with XpertApply" for the Waymo job from the website. Expect the assistant to open on the job page or right after Apply now, and then show fields found, no "doesn't match" text.
3. Check the build id in the assistant diagnostics matches the one just built.
4. Do not submit.

## Rollback
Extension-only; ship the previous build. Nothing is stored or migrated.
