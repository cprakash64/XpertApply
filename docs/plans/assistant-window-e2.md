# Assistant Window E2 implementation plan

## E1 findings and decision

E1 qualified `e15fc04d77d3dbfd4da51140a31dd9179c50d320` as the integration base. It contains the Chrome Web Store/security lineage and later Web authentication work while retaining the Store-qualified extension tree. The current Side Panel resolves its context using current-window semantics, which cannot safely identify a job tab from a separate assistant window.

## E2 scope

E2 adds a packaged `assistant.html`/`assistant.js` shell and a service-worker-owned window manager. Assistant-window identity and bound-job-tab identity are separate session-scoped hints. The manager validates real windows and tabs after worker wake, focuses an existing assistant, prevents same-worker duplicate creation, and clears only the relevant identity when a window or bound tab closes.

## Non-goals

E2 does not change toolbar behavior, remove the Side Panel, migrate fill controls, implement auto-open, request host permission, inspect employer DOM, change authentication, change submission behavior, bump version, package a Store ZIP, deploy, or modify Store metadata.

## State and authority model

`xpertapplyAssistantStateV1` in `chrome.storage.session` contains only optional `assistantWindowId` and `boundJobTabId` numbers. It contains no token or personal data. Stored IDs are hints: assistant identity is reconstructed with `windows.getAll({populate:true})` and the exact extension-owned assistant URL; bound tabs are re-read with `tabs.get` and accepted only for HTTP(S) URLs. Extension and internal URLs are rejected. The service worker owns mutations and the assistant requests an authoritative snapshot through a sender-checked runtime message.

## Duplicate and wake policy

Discovery precedes creation. One in-memory creation promise serializes same-worker calls. On later wakes, actual window discovery supersedes stale storage. If verified assistant duplicates exist, the lowest window ID is deterministic and the other extension-owned assistant windows are closed. Unrelated popup windows are never touched and no duplicate receives independent job authority.

## Test strategy

Focused unit tests exercise URL identity, bounds/type, stale and unrelated windows, duplicate convergence, state separation, tab validation, close/navigation handling, restoration, forbidden privileged API calls, sender trust and Side Panel retention. Existing security/handoff/permission/manifest regressions and the full extension suite, typecheck and production build are required.

## Preserved security invariants

Sender/runtime authority, exact tab/frame/document authority, manual final submission, legal/sponsorship fail-closed rules, session-only secrets, logout/account fencing, no unauthorized DOM probing, private-fill isolation, restricted XpertApply Web bridge, clear/reset semantics and ledger/submission authority remain unchanged.

## Known risks

MV3 suspension can stale IDs; multiple requests can race; assistant focus can confuse current-window selection; a bound tab can close or navigate; and an unrelated popup can reuse an old numeric ID. Reconstruction and exact URL/tab validation address these risks. Cross-worker simultaneous creation remains reconciled on the next discovery without persistent locking.

## E2 acceptance criteria

- One assistant page is present in development and production builds.
- Creation uses a focused 460×800 popup and the exact extension URL.
- Stored window IDs are never trusted without discovery.
- Job-tab bindings accept only existing HTTP(S) tabs and never the assistant.
- Closing the assistant preserves a valid job-tab binding; closing or invalidating the job tab clears it.
- The assistant never uses `currentWindow:true`, requests permission, injects scripts, or changes auth/fill/submission state.
- Side Panel manifest, code and toolbar behavior remain intact.
- Focused regression and full extension qualification pass.

## E2-FLAKE-R1 cleanup qualification

Checkpoint qualification exposed a pre-existing test-harness lifecycle gap in
the field-status presentation singleton. Fill-oriented tests could leave a
MutationObserver or scheduled positioning callback owned by one jsdom Window;
Vitest could then tear down that Window before the cached module disposed its
listeners. Production receives a real Window with matching event methods, so
the correction belongs at the test-environment boundary: the shared Vitest
setup now calls the existing idempotent presentation reset after every test.
A two-test regression proves no presentation state crosses a test boundary.

Qualification after the fix: 20 consecutive repeater runs passed without an
unhandled error; the related DOM/fill group passed 71/71; E2-focused tests
passed 30/30; and two independent complete suites each passed 77 files and
1,211 tests with zero unhandled errors. Typecheck, production build, generated
manifest validation, and `git diff --check` also passed. No production behavior,
permission, authentication, submission, Side Panel, version, or Store setting
changed.
