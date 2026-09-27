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

## E3A shared-controller extraction

E3A extracts the existing Side Panel presentation and application-assistance
workflow into `src/ui/applicationAssistant.ts`. The shared controller owns DOM
rendering, view-state reactions, fill/review/clear/completion intents, the
permission-button gesture, and its own listener lifecycle. Its contract is
explicitly split into a tab-context adapter, a tab-keyed view adapter, typed
worker actions, an injected `Document`, and non-authoritative diagnostics.

The Side Panel remains the Chrome-specific bootstrap. It alone resolves the
legacy active tab with `tabs.query({ active: true, currentWindow: true })`,
publishes runtime identity, adapts session storage/runtime messages, and calls
`permissions.request` from the controller's direct click callback. The shared
controller contains no tab discovery and never infers authority from a browser
or DOM window. This preserves Side Panel fallback behavior while making the
future assistant-window adapter able to supply worker-owned `boundJobTabId`.

Controller disposal is explicit and idempotent. It removes every DOM,
context, and view subscription installed by the controller and fences pending
asynchronous refreshes by generation. Context loss clears controller authority
and disables actions, so a stale tab cannot be targeted after activation or
closure changes.

E3A qualification covers unauthenticated and failure presentation, supported
and unsupported pages, permission grant/denial/revocation, discovery/fill and
review status, clear/reset, manual completion confirmation, storage/context
updates, error presentation, stale-context rejection, and controller
disposal/recreation. The source gate requires the sole `currentWindow`
authority lookup to remain in `ui/sidepanel.ts`. Full security, E2 assistant,
manifest, typecheck, production-build, and complete-suite results are recorded
in the E3A stage report.

E3B prerequisites are: E3A review and checkpoint commit; a worker-authoritative
`boundJobTabId` context adapter; assistant-owned lifecycle subscription without
active-window discovery; reuse of the typed action/view contracts; and parity
qualification before any toolbar cutover. E3A does not wire the assistant UI,
change toolbar behavior, add auto-open, or alter permissions, authentication,
submission, version, packaging, or Store state.

## E3B persistent assistant integration

E3B replaces the dormant assistant shell with the same product markup contract
and `applicationAssistant` controller used by the Side Panel. The markup is
intentionally duplicated for now because each extension page must be a
self-contained MV3 artifact, while all rendering and workflow behavior remains
shared TypeScript. Parity tests pin the required element IDs. The 460×800
assistant layout supports 420–480px widths, wraps long labels, scrolls
vertically, preserves visible focus, and keeps status and error text semantic.

The assistant context adapter never queries tabs. It asks the worker through
`ASSISTANT_GET_CONTEXT`, accepts a tab only when the response is `bound`, and
reads the existing session-scoped `LaunchViewState` map under that exact tab
ID. `ASSISTANT_CONTEXT_CHANGED` immediately clears local action authority,
generation-fences any prior refresh, fetches a new worker snapshot, and then
loads only the newly bound tab's view. Missing, closed, internal, extension,
or absent tabs render non-actionable waiting guidance without active-tab
fallback.

Assistant UI intents use four narrow typed routes for autofill, clear,
completion, and site-access results. On every route the worker verifies the
exact assistant sender, reads its own `boundJobTabId`, requires equality with
the requested tab, calls `tabs.get`, accepts only a normal HTTP(S) tab, and
re-reads assistant state after that asynchronous validation. Completion also
requires the tab's current view session; permission results require the exact
current view pattern. Existing fill, permission, frame/document, session,
generation, ledger, and submission checks remain downstream authorities.

The assistant calls `permissions.request` only from the shared controller's
direct site-access button handler and only for the pattern in the bound tab's
view. When the prompt resolves, the worker repeats bound-tab validation and
pattern validation, so a binding change, closure, navigation invalidation, or
worker wake fails closed rather than redirecting work. Assistant focus and
unrelated active tabs are never consulted.

Both controller and assistant-owned runtime/storage subscriptions are disposed
on unload. Closing the assistant still preserves the worker binding, session,
ledger, and host grants. Side Panel toolbar fallback remains unchanged and
fully operational.

Toolbar cutover prerequisites are: final E3B checkpoint review; an explicitly
qualified action-click policy; no regression in Side Panel fallback; deliberate
manual browser acceptance of persistent-window focus and permission UX; and a
separate decision on auto-open. E3B does not alter toolbar behavior or add
auto-open.
