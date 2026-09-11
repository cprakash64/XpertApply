# XpertApply Application Memory — Stage 2D

## Objective

Make an application `Applied` only after either narrowly correlated ATS success evidence or an explicit user answer to “Did you submit it?”. XpertApply remains an assisted filler and never activates an employer submit control.

## Architecture and decisions

- The content script observes a conservative final-submit form event; it never clicks or submits.
- Strong success evidence must follow that gesture within a 15-second attempt window. A success URL/message already present before the gesture is rejected. Validation/error copy vetoes success.
- Gesture authority is bound in the background to the active session, tab, frame, immutable browser document ID, origin, host permission, and authority generation. A short-lived timestamp in `chrome.storage.session` permits correlation across an ATS navigation without placing application content or personal data in local storage.
- Weak or ambiguous evidence is persisted by the API as tracker confirmation state, then shown in the in-page extension widget. Reload recovers unresolved state from the server.
- “Yes” calls the existing authoritative session completion path, which atomically marks Applied and creates one immutable application snapshot. “Not yet” records dismissal, retains `applying`, and creates no snapshot.
- Snapshot artifact provenance continues to come only from the session-bound document IDs and verified upload audit events. Submitted-answer provenance remains empty when exact final ATS values cannot be proven.

## Security and privacy invariants

- No employer submission is triggered by extension code.
- Success pages, messages, responses, clicks, navigation, and form disappearance are never sufficient outside one correlated attempt.
- Content-script messages cannot select a different user, job, tracker, token, or document.
- Revoked permission, stale document, wrong tab/frame/origin, expired session, or cleared account authority fails closed.
- Server persistence stores lifecycle timestamps and bounded evidence metadata, not page HTML, provider payloads, credentials, or form values.

## Implementation progress

- [x] Correlated strong-evidence gate and validation-error veto
- [x] Server-backed ambiguous confirmation state
- [x] In-page Yes / Not yet prompt with retry-safe UI behavior
- [x] Authoritative Yes and non-submitting Not yet paths
- [x] Reload/navigation recovery and sender authority checks
- [x] Focused evidence, API-client, widget, frame-trust, and API lifecycle tests
- [x] Full validation recorded below

## Validation

Required before handoff:

- Extension focused tests and full unit suite
- Extension TypeScript check and production build
- MV3 browser test suite
- Focused API lifecycle tests and full API suite
- `git diff --check`

Final results (2026-09-11): focused Stage 2D/security/recovery extension validation passed 223 tests; focused API lifecycle validation passed 46 tests on Python 3.12.13; the full API suite passed 1,869/1,869. Extension TypeScript and production builds passed. The complete MV3 suite passed 151/151 twice from fresh starts (10.0 minutes and 9.3 minutes), with zero failures and zero skips. The application-answer file passed 17/17, the real-extension file passed 5/5, and the focused production-MV3 strong-confirmation scenario passed. The complete extension unit suite passed 1,073/1,073 twice with clean process exits and no post-run async diagnostics.

### Failure reconciliation

- XA-09’s former `< 2,000 ms` JSDOM assertion passed three isolated runs on both the clean baseline and Stage 2D tree, but failed only during the more heavily loaded full Stage 2D suite. The production limit and refusal path were unchanged. The test now asserts the stronger deterministic property: oversized-form readiness schedules no quiet/deadline timer, proving it exits before the asynchronous wait loop without depending on host scheduling.
- The real-extension CTA test’s `page.goto(..., waitUntil: "load")` raced the extension’s intended same-document transition and produced `ERR_ABORTED`. It now waits only for navigation commit and continues to prove one automatic primary-Apply activation and zero final-submit activation. Three isolated repetitions and the ordered three-test neighborhood passed.
- The application-answer combined-sponsorship failure did not touch Stage 2D paths. It passed three isolated repetitions and its ordered three-test neighborhood without source changes.
- The Stage 2D production-MV3 strong-confirmation case passes after preserving immutable frame registration across same-document URL changes; genuine document replacement remains rejected by Chrome `documentId` mismatch.
- `ASYNC-01` was reproduced as a delayed `positionAll()` callback entering `resetLayer()` after JSDOM teardown. The fallback scheduler used `globalThis.setTimeout`, while cancellation and listener removal guessed against ambient `window`/`document`; the Node-owned timer could therefore outlive the DOM environment that owned the presentation.
- The status layer now captures its owning `Window` and `Document`, records the exact scheduler kind and handle, cancels through that owner, unregisters owner-bound resize/scroll listeners, disconnects both observers, removes all presentation DOM, clears private registries, and invalidates callbacks with a generation fence. Reset is explicit and idempotent. A stale callback from presentation A cannot mutate replacement presentation B.
- Deterministic regression coverage proves reset-before-fire cancellation, double-reset safety, replacement-instance isolation, zero remaining timers, no DOM resurrection, and clean environment teardown. Five focused fresh-process runs passed; `repeaters.test.ts` passed alone and beside the status-presentation suite; two full unit runs passed 1,073/1,073 with clean exits.
- The lifecycle correction applies to production SPA navigation, application-root replacement, content-script environment teardown, and layer replacement—not only JSDOM. XA-14 private `WeakMap`/`WeakSet` state and XA-17 closed-shadow, non-destructive presentation remain intact.

### Final async ownership review

- The Stage 2D submission timeout is bounded to two seconds, retained in `manualConfirmationTimer`, cleared before replacement, after strong confirmation, and after either explicit user answer; its callback also requires the current content-script instance.
- The document submit observer has document-lifetime ownership and cannot act after instance invalidation. Widget click handlers are owned by the closed-shadow widget nodes and disappear with that widget.
- Status-presentation animation frames/timeouts, listeners, `ResizeObserver`, and `MutationObserver` are all released by the explicit reset lifecycle described above.
- No new `setInterval` or long-running polling was introduced.

## Rollout and rollback

Roll out the API endpoints before or with the extension build so ambiguous prompts can persist. Existing completion and snapshot contracts remain compatible. Rollback consists of reverting this Stage 2D change set; no migration or dependency change is introduced. Existing application snapshots and tracker lifecycle records remain valid.

## Deferred release prerequisites

- `DEPENDENCY-01` — OPEN. Reconcile production dependency advisories before public release.
- `PROXY-01` — OPEN. Confirm the deployed reverse-proxy request-size limit supports the intended 5 MiB upload plus multipart overhead.

Neither prerequisite is remediated in Stage 2D.
