# XA-EXT-GREENHOUSE-04 — real-Chrome defects: badge layout, disconnect behaviour, honest failure and status wording

Status: implemented on `feature/xa-core1-direct-autofill` after `7d35cce`. Not pushed, not deployed. **RELEASE STAYS BLOCKED until a real-Chrome staging retest** (no live staging run was possible from this environment; every result below is a real Chromium against local fixtures and an owned mock API).

## Event timeline and what is established

The four screenshots were taken at different moments, so no simultaneity is assumed.

| Observation | Established by | Status |
| --- | --- | --- |
| Chrome asked for `job-boards.greenhouse.io` | per-site grant workflow, covered by `cws-p1-permission`, `xa-direct-entry` | working |
| 21 discovered / 3 filled / 18 review, plus "Something went wrong while preparing…" | `ui/applicationAssistant.ts`: the text is the **fallback for any failure code the UI has no label for**, shown even when a session exists and the form was read | **confirmed** presentation defect |
| Which code the user hit | not recoverable offline; candidates are every unlabelled code (`VALUE_DID_NOT_STICK` from the broad `catch` in `discoverAndFill`, `APPLICATION_DISCOVERY_TIMEOUT`, `INTERNAL_HANDOFF_FAILURE`, …) | **hypothesis** |
| "Not connected to XpertApply" beside live progress and Fill/Continue | A website-launched session runs on its own session credential, not on the extension account (by design, `signOutDirectWorkflows` leaves it alone); the account row said only "Not connected". For a *direct* draft the ASHBY-03 teardown already forces the single Connect state. | **confirmed** for website launches (wording), already fixed for direct drafts |
| Website "Extension connected", "Tailored resume ready", "24 verified answers" | `AutoApplyModal.tsx`: "extension connected" is the presence/version handshake (`detectExtensionState`), never an account; the rest is the website's own prepared session | **confirmed**: none of these is evidence of an authenticated extension account |
| Overlapping Invalid / Verified / Needs review badges | `.status{display:flex}` in the badge layer overrode the `hidden` attribute, so every badge the layout "hid" stayed painted at its last (or 0,0) position; old placement also clamped onto the viewport edge and ignored labels, other controls, menus, sticky headers and other badges | **reproduced and measured** |

### Authorization and unauthorized writes
* No field write or authenticated API call was found without authorization: with the credential gone there are zero `/extension/direct-sessions` or `/application-sessions/` calls and zero writes (`xa-ashby-state` A/C/E, new G4).
* **One unrequested mutation was found and reproduced** (G4 failed on the previous build): Disconnect (and sign-out teardown) sent `CLEAR_SESSION` to the employer tab, which reverts XpertApply-written values. It was removed from the disconnect path.
* Whether the user's name-only fill was the employer's own prefill, Chrome autofill or a prior session remains **unproven**; no incident is declared.

## Changes
* `messages.ts`, `background.ts`: new worker→tab `SESSION_DETACH`. Direct sign-out and Disconnect now detach (stop writing, forget the in-memory package, drop annotations) instead of reverting values. `CLEAR_SESSION` is kept for the user's own "Clear" and for account replacement and website session end (another person's data must not stay on the form).
* `fields/fill.ts`, `fields/upload.ts`, `content/dropdownTransaction.ts`: one write-authority gate. Once withdrawn, `fillField`, uploads and approved-option selection refuse, including calls already queued behind an `await` when the credential disappeared. A new authorized session restores it.
* `ui/applicationAssistant.ts`: honest failure text (specific labels for the run-stage codes; the generic text says "preparing" only when no application is open, otherwise "stopped before it finished… nothing already on the form was changed"); the submit-step notice no longer says "review everything, then submit" while items are outstanding; the account row separates a website launch from the extension account.
* `fields/statusPresentation.ts`, `fields/badgePlacement.ts`: collision-aware layout. Obstacles are every visible control, question label text (tight text rects), heading, open menu/listbox/option, fixed/sticky layer and the assistant; badges already placed are obstacles too. A custom dropdown is annotated at its visible control, not at React-Select's 2px input. A field under a sticky header is not annotated. No clamping onto the viewport edge or onto anything. When nothing is clear the mark is withheld and the assistant says how many (`#suppressedMarks`). Event driven only (scroll, resize, DOM mutation, `aria-expanded`, assistant layout); one read phase then one write phase per frame; no timers.
* No broadened permissions, no backend change, no production contract change.

## Decisions
* A website-launched session is still operable with the extension signed out, because its authority is the launch's own session token, validated by the backend on every call (`SESSION_UNAUTHORIZED` stops it). Disabling it would break the website flow for anyone who has not connected the extension. The UI now says plainly that it is a website launch. Flip this decision if product wants the extension account to be mandatory.
* Sensitive demographic fields are untouched by any of this and remain answered only by the applicant (G3).

## Validation
See the final report and `docs/plans/evidence/`:
* `gh04-before/`, `gh04-after/`: screenshots and `FINDINGS.json` (32 states: 4 viewports × 2 zooms × 4 scroll positions), measured from DOM rectangles.
* `xa-gh04-playwright-full.log`: final full suite, one worker, zero retries, no exclusions: **224 passed, 0 failed** (21.3 min). The first full run (`...-run1-5fail.log`) had 5 failures: one was a real regression of this change (a second `role=status` region, fixed), four passed when rerun alone (load sensitivity noted in ASHBY-03).
* vitest 100 files / 1529 tests pass; `tsc` clean; production, staging, development, e2e and staging-granted builds succeed.
* Previous build (7d35cce), same fixture, 32 states: 608 painted badges, 16 over labels, 24 over controls, 351 over the sticky header, 1766 over other badges, 118 over the assistant, 90 outside the viewport; G2 (open menu) and G4 (disconnect keeps values) fail. New build: 228 badges, 0 in every collision category; all 7 new specs pass.

## Rollout / rollback
Extension-only (plus one wording change on the website if committed). Roll back by shipping the previous extension build; nothing is stored or migrated.

## Known limits
* Not run against live staging or real Chrome UI (permission prompt, `launchWebAuthFlow` stay manual).
* The service-worker-restart and website-launch handoff cases are covered by the existing specs (`xa-core1-direct` H, `session-handoff`, `xa12-*`), not by new Greenhouse-specific ones.
* Mid-fill revocation is covered at the unit level (write gate) and by teardown specs, not by a timed end-to-end race.
* Zoom is emulated through the device-metrics override, as in the existing visual specs.
