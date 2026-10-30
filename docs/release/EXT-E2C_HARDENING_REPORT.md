# EXT-E2C: direct-autofill failure-state hardening and account-isolation gate

Status: **local commit on the line C branch; nothing pushed, deployed, migrated or changed on staging; no account created, no live authentication, no production request, no form submitted.** New commit: `647c57c` on `feature/xa-core1-direct-autofill` (parent `d6768f2`, EXT-E2B). Staging stays web `1b26947`, API `aa5bc2fa`, DB `0034`. The premium UI worktree (branch `feature/premium-ui-overhaul`) was not touched; this report is the only file committed there. Production stays NO-GO.

## 1. Root causes and changed functions
| Problem | Cause | Change in `647c57c` |
|---|---|---|
| A top-frame refusal answered to the page left the tab's view on its initial "detecting" state | `handleContentReady` (`background.ts`) answered `DOCUMENT_ID_UNAVAILABLE`, `HOST_PERMISSION_MISSING` (two places) and, on expiry, `STALE_AUTHORITY` with `sendResponse` only; nothing recorded why | New `settleReadyRefusal`; called from those four exits for top frames |
| A wait on a silent worker could last forever | Nothing bounded it: suspended worker, lost message, page that never reported back | `ui/applicationAssistant.ts`: `DETECTION_STALL_MS = 45_000`, `awaitingSince`, `armStallTimer`, new text for `DETECTION_STALLED` and `DOCUMENT_ID_UNAVAILABLE` |
| A late, older snapshot could replace a newer one | The push subscription applied every view unconditionally | Same file: an older `updatedAt` of the same request and session is ignored |
| A retry could keep showing the earlier verdict | `contentReadyViewPatch` does not clear `failureCode` | Success path of `handleContentReady` clears only the refusals this change records (`READY_REFUSAL_CODES`) and a revoked site-access state |

## 2. Security effect of the E2B repair (`d6768f2`)
The diff is two things: `RUNTIME_IDENTITY` in `routeRuntimeMessage` answers the three website fields as null when the sender tab's stored workflow is a **direct draft** (`directDraftSender`), and the assistant gained texts. Verified by search of the source:
- The remembered website record (`jobpilotWebRuntimeV2`, written only on `STAGE_LAUNCH` and `LAUNCH_REQUEST` by `rememberWebRuntime`) is read in exactly one place, `launchWebRuntime()`, whose only caller is the `RUNTIME_IDENTITY` handler, which feeds `evaluateHandshake` (`runtimeIdentity.ts`) through the content script's `verifyRuntime`. **That handshake is the only security decision that used it**, in three checks: web environment versus content environment, web API base versus content API base, web authenticated user versus the session's user.
- What a direct draft no longer gets from that record is a comparison against an unrelated earlier website launch. What guards a direct draft instead, all unchanged: `mintDirectPackage` rejects a session whose `authenticated_user_id` is not the signed-in account; `resolveDirectApplication` and `handleContentReady` require `signedIn.userId === pending.directUserId`; `directSessionStillOwned` guards every message that acts on a draft; the server scopes a session token to one session and one account; and the handshake still compares content script, worker, widget and side panel on build id, environment and API base.
- Website-launched drafts keep the record and every check. A page with no workflow is answered as before.

## 3. Account-isolation evidence
Direct and website-initiated drafts are tested separately. Real Chromium, synthetic accounts 7 and 9, owned mock backend that enforces the real token contract.

| Required property | Direct drafts | Website drafts |
|---|---|---|
| 1 Cross-account draft reuse | `xa-e2c-isolation` 1, 2; `xa-core1-direct` G3 (every credential-carrying request belongs to its own account's session) | `xa12-account-replacement` (A to B to A never revives a prior workflow) |
| 2 Résumé / cover letter reuse | Same requests: documents are fetched only through the session token of the owning draft; no request after a switch carries the old account's session credential (tests 1, 2, 3) | `xa12` |
| 3 Expired or revoked credentials | `xa-e2c-isolation` 4 (expired access token renewed once from the refresh credential, draft owned by the same account); `xa-core1-direct` G2 (revoked refresh signs the extension out, nothing filled) | `xa12` |
| 4 Staging / production mixing | Unit: `evaluateHandshake` refuses a worker on another environment, another build, or no answer, with the website fields null (`ready_refusal_settles`); `xa-direct-entry` A4 (staging build contacts no production host) | Unit: the record is still offered to a website launch and to an unbound page; a record for another deployment still refuses (E2B spec showed the refusal before the repair) |
| 5 Page messages impersonating the extension or another account | `xa-e2c-isolation` 5: an employer page posts 8 extension, bridge and account message types three ways and tries `chrome.runtime`; no draft, no session, no credential of account 9, no storage change, no website record written, account row unchanged | not exercised separately; the bridge is staging-web-only by manifest |
| 6 Previous-session data after disconnect | `xa-e2c-isolation` 1 (fields empty, "Not connected", zero requests as account 7, then account 9 starts clean); `xa-ashby-state` D, E | `xa12-session-teardown` (web logout purges every reference) |
| 7 State reuse after a worker restart | `xa-e2c-isolation` 2 (account changed while the worker was stopped; old draft never resumed); `xa-direct-entry` B3; `xa-core1-direct` H (Chrome restart) | `session-handoff` |
| 8 Account change during an active run | `xa-e2c-isolation` 3 (credential replaced under an open assistant; Fill uses no session credential of account 7 and writes none of its data) | `xa12` |
Not claimed: a mid-fill account switch timed to the millisecond is not reproduced; the guard (`directSessionStillOwned` on every acting message) is what protects it, exercised by test 3 between runs.

No stale-state dependency was restored and no authentication, origin, deployment or account check was removed.

## 4. The three worker-response paths
All three are in `handleContentReady`. Each answered the page and recorded nothing.
| Path | Trigger | Operation state | Terminal outcome now |
|---|---|---|---|
| `DOCUMENT_ID_UNAVAILABLE` | Chrome supplies no `documentId` for the sender | Cannot proceed, nothing running | View fails with a labelled, recoverable `DOCUMENT_ID_UNAVAILABLE` ("Chrome couldn't identify this page… reload"); a retry that succeeds clears it |
| `HOST_PERMISSION_MISSING` | The exact-origin grant is gone at either of two checks (before or after the probe) | Cancelled, nothing read | View shows site access removed with the button that asks Chrome again; a retry after the grant is back returns it to granted |
| `STALE_AUTHORITY` | Authority generation changed, session ended, tab re-bound, or launch expired during the probe | Mixed | Generation changed or session ended: the account was torn down, the view is gone, nothing to settle (a write would throw `StaleAuthorityError`, which is caught). Tab re-bound: a newer session owns it, **never overwritten**. Expired while probing: `HANDOFF_EXPIRED`, terminal, "reopen" |
Writes happen only for a top frame, only for the session that still owns the tab, and only while the account authority is current.

Delayed or missing worker response (suspension, lost message, page that never reports back) is covered by the bounded wait rather than by tracking each cause: a view in a waiting state (`detecting_ats`, `preparing`, `opening_tab`, `waiting_for_tab`, `waiting_for_content_script`, `fetching_package`) with no news for 45 s renders "taking longer than expected… reload, or Fill application", ATS `—`, documents "Not started", Fill enabled. The assistant re-renders at the limit with no event, a fresh snapshot from a retry restarts the wait and drops the verdict, and a wait for the user's decision in Chrome (site access) is not a stall. Limit chosen because the worker answers a page in well under a second; it is a constant, `DETECTION_STALL_MS`, and the tests assert both sides of it.
Not bounded: a fill that is `running` and then goes quiet (long fills are legitimate, and the content script reports its own discovery timeout). Left as a documented risk.
No field is marked filled by any of this; every new state has zero filled and nothing is written to the form.

## 5. Embedded-form limitation (documented, not fixed)
Reproduced and now pinned by `xa-e2c-embedded-limitation`: a careers page on a custom domain that embeds a cross-origin ATS form in an iframe, opened **directly** (no website launch), gets no draft, no assistant, no request to XpertApply, and the frame receives no data. Cause: a direct draft is created only from a top-frame form (`resolveDirectApplication`, top frame only; `judgeApplicationEvidence`). Website launches are different and handle embedded frames (`embedded-application-frame`, `zz-3c2-frame-discovery`).
Does it explain a known screenshot? **No.** The Reddit screenshot showed an open assistant with a session ("Detecting…", "Preparing…"). The reproduced embedded case shows no assistant at all, so it cannot have produced that screen. The Reddit URL and DOM were never supplied, so its structure is unknown and no ATS is inferred from the employer name. Supporting embedded direct applications needs per-frame grants and a separately reviewed design; none was implemented and no permission was widened.

## 6. Tests executed (scratch export of `647c57c`)
| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 106 files, 1,592 tests, all pass |
| New unit tests (`ready_refusal_settles`, `application_assistant`, `workday_site_access`) | 13 + 49 + 11; the three worker-path tests **fail on the pre-fix worker** and pass now (checked by running them against `d6768f2`'s `background.ts`) |
| Playwright, 14 files: `xa-e2c-isolation` (5), `xa-e2c-embedded-limitation` (1), `xa-e2b-stale-web-record` (2), `xa-e2b-api-failures` (7), `xa-core1-direct` (12), `xa-direct-entry` (8), `xa-rc06-activation`, `xa12-account-replacement`, `xa12-session-teardown`, `xa13-dormancy-gate`, `session-handoff`, `embedded-application-frame`, `xa11-status-coherence`, `xa-ashby-state` | **59 passed**, 0 failed, 0 flaky |
| `npm run build:staging` from a clean archive (section 8) | succeeds |
Test intent coverage: success, expired connection, account change, deployment change, disconnect, worker restart, permission loss and regrant, stale and out-of-order messages, repeated retries (fresh snapshot), unsupported provider and unknown host (no access request), empty or non-application page (`xa-core1-direct` A2: no draft), no automatic submission (every e2e asserts zero submits and zero submit clicks).
**Not run:** the other e2e files (for example `cws-*`, `xa-nav*`, `xa-gh04`, `xa09*`, `dropdowns`, the real-API specs), Chrome stable on a desktop, any real employer or ATS page. Permission removal and the Chrome access prompt are not automatable here: the granted e2e build cannot drop a grant, so permission loss is covered by unit tests only.

## 7. New local commit
`647c57c fix(extension): refusals answered to a page end the view in a stated state; waiting is bounded (EXT-E2C)`, 8 files, +745/-5: `src/background.ts`, `src/ui/applicationAssistant.ts`, three unit-test files, `e2e/xa-core1-harness.ts` (optional page override), two new e2e specs. Not pushed.

## 8. Repaired staging artifact (new; the E2A artifact was not touched or reused)
| | |
|---|---|
| Source | `647c57c`, clean `git archive` of `apps/extension` and `packages` (no `.git`, no worktree) |
| Build | `cd apps/extension && npm ci && npm run build:staging` |
| Build id | `nogit-4bf77f2` (the E2A artifact was `nogit-3a9aaee`; a second build produced the same id) |
| Artifact | `/private/tmp/claude-501/-Users-cprakash-Documents-Jobs-XpertApply/1c58020f-faa8-4586-8961-6ea6a0a780c9/scratchpad/e2c/artifact/xpertapply-staging-nogit-4bf77f2` |
| SHA-256 | list of all 20 files: `…/scratchpad/e2c/artifact/SHA256SUMS.txt`, whose own SHA-256 is `def56bef0e932f630ab3a253f3493115e0d59c40081830d41452b55eb6a2110a`. `background.js` `91e01149…ae9c1626`, `content.js` `db1dd567…63689c3c`, `sidepanel.js` `35adb532…08d4eafa`, `manifest.json` `dd1fadfe…dc9bc9f8` |
| Reproducibility | the content id is stable; file bytes are **not**, because `version_name` and the bundles embed the build time (a rebuild changed 5 files and the manifest). Verify by build id and manifest, not by file hash across builds |
| Manifest | name `XpertApply (STAGING)`, version `0.3.0`, `version_name` ends `; staging)`, permissions `activeTab, identity, sidePanel, storage, scripting, tabs`, host permissions exactly `https://api-staging.xpertapply.com/*` and `https://staging.xpertapply.com/*`, optional `https://*/*` (per-site grants), `externally_connectable` and content script only `https://staging.xpertapply.com/*`. **Identical to the E2A artifact's manifest apart from `version_name`**: no permission added |
| Identity | `key` derives `cglmdonbfbadfbggkpajpkjgpekhkall`; loaded in Chrome for Testing 149 (isolated profile): `chrome.runtime.id` equals it, card ENABLED, UNPACKED, 0 errors, service worker alive, 0 network requests with every hostname blocked, redirect `https://cglmdonbfbadfbggkpajpkjgpekhkall.chromiumapp.org/xpertapply` |
| Production endpoint | The bundles contain the same production URL strings in the same counts as the E2A artifact (one `api.xpertapply.com` per bundle, from the unreachable branch of the staging-profile switch recorded in E2A); the staging profile resolves the staging API only, and `xa-direct-entry` A4 shows no production host is contacted |
Everything above is for **Chrome for Testing 149**, not desktop Chrome.

## 9. Replace the artifact in desktop Chrome
1. In the dedicated test profile open `chrome://extensions`, remove **XpertApply (STAGING)** (the ID is pinned, so two copies cannot coexist). This also deletes its stored sign-in, which is fine: nothing is connected yet.
2. Developer mode on, **Load unpacked**, choose the artifact folder above.
3. Check the card: name `XpertApply (STAGING)`, ID `cglmdonbfbadfbggkpajpkjgpekhkall`, version `0.3.0 (nogit-4bf77f2 …; staging)`, **Errors 0**. Open **service worker**: the console shows only `service worker active`.
4. Console: `chrome.runtime.getManifest().host_permissions` must list only the two staging hosts.
5. Close and reopen every employer tab (an open tab keeps the old content script).
6. Rebuild from source instead if the scratch folder is gone: `git archive 647c57c apps/extension packages | tar -x -C <new empty dir>`, then `cd <dir>/apps/extension && npm ci && npm run build:staging`, and confirm build id `nogit-4bf77f2`.
Send back a screenshot of the card and the two console results.

## 10. GO / NO-GO for real account connection
**CONDITIONAL GO**, for the repaired artifact only (`647c57c`, build `nogit-4bf77f2`), on the conditions already set plus this one: (1) the operator confirms staging `EXTENSION_ALLOWED_IDS` is exactly `["cglmdonbfbadfbggkpajpkjgpekhkall"]`; (2) you repeat the identity check in desktop Chrome with this artifact; (3) you approve a throwaway staging account. Do not start Phase B until you say so.
Open risks that do not block a throwaway-account test but must be recorded in it: the embedded-form limitation (section 5); an unbounded quiet `running` fill (section 4); Workday auto-advance (E1 F3) unverified on a real tenant; Chrome's real grant prompt, sign-in window and `!` badge unseen; the Reddit trigger on your machine unconfirmed; line C unpushed and not integrated with the premium UI branch; password-reset fix `3454d5f` local and unreleased. Production: **NO-GO**.
