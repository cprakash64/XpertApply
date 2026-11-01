# XA-12 — extension workflow teardown on web-session end

## Finding and scope

XA-12 is the Medium finding that logout, account change, and session end do not
purge extension workflow state. This plan is limited to the first-party web
session signal, the extension bridge, and cleanup of state that can reference
the prior account. XA-13 and later findings are out of scope.

## Evidence and root cause

At checkpoint `3fd4bfc`, a production MV3 run seeded an active handoff, pending
launch, view state, token-bearing session package, and pending navigation for
user A. The approved XpertApply-origin page then performed its normal logout
invalidation. All seeded extension state remained available afterward.

The web auth-session module does not send session termination through the
extension bridge. The bridge/message contract has no such event, the worker has
no global purge operation, and `clearSession` only clears page fields and three
view counters. Expiration, tab close, and `storage.session` browser-restart
semantics bound the exposure but do not implement logout or account switching.

## Decision

- Emit a payload-minimal, closed-reason session-end request from the canonical
  Web auth invalidation path and when an existing token is replaced.
- Route auth teardown directly through Chrome's externally-connectable runtime:
  Web `chrome.runtime.sendMessage(extensionId, ...)` to worker
  `chrome.runtime.onMessageExternal`. The page-visible `window.postMessage`
  bridge cannot establish extension presence, teardown success, or replacement
  authorization.
- Permit external messaging in the shipped manifest only from
  `https://xpertapply.com/*` and `https://www.xpertapply.com/*`. The test-only
  granted build adds exact loopback hosts; employer and ATS origins remain
  excluded. This does not alter host permissions or grant browsing access.
- Validate Chrome-supplied `MessageSender.origin`, `url`, top-level `frameId`,
  and `tab`, reject extension senders, and compare exact parsed origins. Request
  payloads never supply identity.
- Advance a monotonic service-worker authority generation synchronously, clear
  in-memory authority, and serialize all account/workflow storage writes behind
  an epoch check. A write captured under generation N cannot commit after a
  global teardown advances authority to N+1.
- Remove all workflow bindings, views, session packages, pending navigation,
  account diagnostics, and related in-memory authority before best-effort page
  restoration. XA-10 restoration never gates security cleanup.
- For a different-token replacement, remove old Web authority immediately and
  do not store the replacement until Chrome returns the exact worker response
  for that external request. Chrome already correlates the callback to the
  originating request, so the external contract carries no request ID.
- Make teardown idempotent and best-effort for unreachable tabs, while storage
  removal remains authoritative.
- Purge the same state on `chrome.runtime.onStartup` as defense in depth.

## Race-safety authority model

- **Authority invalidation point:** `advanceAuthorityGeneration()` is the first
  synchronous operation in global teardown.
- **Storage purge point:** epoch-serialized removal of active, pending, view,
  package, pending-activation, and authenticated-Web diagnostic state.
- **Page restoration point:** after authoritative purge, fire-and-forget using
  XA-10 reversible `CLEAR_SESSION`; closed tabs cannot retain authority.
- **Acknowledgement point:** the worker replies through Chrome's external
  runtime request only after authoritative purge. No parallel postMessage ACK
  exists.
- **New-token activation point:** after an authoritative external PING succeeds
  and the subsequent external teardown returns the exact `{ok:true}` shape.
  Once PING establishes presence, failure, malformed response, connection loss,
  or the bounded 1,600 ms timeout leaves the user logged out. Chrome's explicit
  no-receiver error is treated as absence so Web-only users can proceed.
- **Session-specific versus global invalidation:** successful application
  completion synchronously tombstones that session, then performs an atomic
  queued removal. Already-running writes precede the removal, queued/later
  writes for the ended session fail, unrelated sessions remain authorized,
  and the account generation does not advance. Backend failure leaves retry
  state intact. Global account replacement clears session tombstones because
  numeric session IDs may be reused by a new account.
- **Service-worker lifecycle:** promises cannot survive worker destruction.
  The epoch protects every async operation within one worker lifetime;
  `storage.session` bounds persisted workflow authority and startup invokes the
  same global purge. Persisted Chrome host permission never creates workflow
  authority.

## Async writer inventory

| Writer | State | Async boundary | Protection | Disposition |
| --- | --- | --- | --- | --- |
| `stageHandoff` / launch request | active handoff, pending, view | storage/tab creation | captured generation plus serialized state writes | stale work rejected |
| tab create/update/remove handlers | tab binding, view, activation | Chrome tab/storage APIs | generation captured at event entry | stale work rejected |
| `prepareApplicationLaunch` | pending activation/navigation | workflow lookup | `withAuthorityMutation` | stale work rejected |
| `navigateToApplicationDestination` / `bindTabToLaunch` | activation, pending, package | tab create/update and storage reads | one generation threaded through the operation | stale work rejected |
| `reconnectWorkflow` / content-ready / pending lookup | pending, view, package, activation | origin checks, package fetch | one generation threaded through all writes | stale work rejected |
| `ensurePackage` | package, pending status, in-memory load | token exchange/session fetch | pre/post-await checks plus serialized writes; identity-safe map cleanup | stale work rejected |
| progress/result/failure/clear/site-access | pending and view | backend/permission/tab reads | handler generation threaded into state writes | stale work rejected |
| frame registry/fill lease | in-memory frame authority | frame probing | Chrome-sender launch validation plus account/session check immediately before write | stale work rejected |
| confirmed-session cache | in-memory completion cache | backend confirmation | current-generation check before insertion | stale work rejected |
| Web runtime diagnostic | local account/environment diagnostic | storage write | serialized generation check | stale work rejected |
| global purge | all account/workflow state | storage removal | advances generation first; purge is queued after any already-executing write | authoritative |
| session completion purge | one session only | backend completion/storage rewrite | synchronous per-session tombstone plus atomic queued removal | ended session cannot repopulate; concurrent sessions preserved |

## Validation

- Original production-MV3 logout reproduction.
- Token replacement/account-change web test.
- Logout, expiry, and account-deletion reason validation.
- Unapproved runtime sender refusal.
- All audited stores contain no reference to the prior user/session afterward.
- Repeated teardown remains successful.
- Existing user values are preserved by the XA-10 restoration path.
- Browser startup registration reaches the same purge routine.
- Mandatory negative control.
- Full extension and relevant web validation, diff-check, and fsck.

Completed at checkpoint `3fd4bfc`:

- Extension typecheck passed.
- Focused extension state/message tests passed: 15 tests.
- Full extension unit suite passed: 65 files, 1,009 tests.
- Production extension build passed: `3fd4bfc-dirty-fe6af70`.
- Full MV3 E2E suite passed: 144 tests.
- Production MV3 logout purge completed in 172 ms with zero audited stores
  remaining; an extension-page sender was refused and repeated teardown passed.
- Web focused auth-session tests passed: 14 tests.
- Full `make test-web` passed: lint, typecheck, production build, 46 files and
  898 tests.
- The mandatory negative control failed with all prior-user state retained when
  the bridge call was removed, then the identical runtime test passed after
  restoration.

Race-safety follow-up validation at the same uncommitted checkpoint:

- Deterministic pre-fix replacement test failed because user-B auth became
  active before any teardown acknowledgement; the corrected test waits for the
  exact correlated ACK and leaves auth empty on explicit failure or known-
  installed timeout.
- Deterministic authority-queue tests cover an already-executing write ordered
  before purge and queued stale active, pending/binding, package, and activation
  writers rejected after generation advance. New-generation state succeeds.
- Production Next.js Web plus production MV3 Chrome acceptance held teardown at
  the diagnostic-removal boundary: user-B auth remained absent before ACK,
  activated after release, user-B session 2202 survived, user-A state remained
  absent, and submission requests were zero.
- Production MV3 logout teardown returned its correlated ACK with zero audited
  stores remaining and an untrusted extension-page sender rejected (17 ms in
  the final full run).
- Ordering negative control is the captured pre-fix production-code regression.
  The automation safety reviewer refused a second temporary fire-and-forget
  production mutation, so no insecure mutation was applied.
- Generation negative control used an isolated test-only unfenced active-
  handoff write; the invariant failed with stale state present. Removing the
  bypass restored the focused suite to PASS.
- A deterministic per-session queue barrier proves a queued late write for a
  completed session is rejected while a concurrent unrelated-session write
  survives the same atomic cleanup.
- Final extension validation: typecheck PASS, 65 files / 1,011 unit tests PASS,
  build PASS (`3fd4bfc-dirty-fe6af70`), 145/145 Playwright E2E PASS.
- Final Web validation: lint PASS, typecheck PASS, production build PASS,
  46 files / 902 unit tests PASS; focused auth-session 18/18 PASS.
- Docker Compose configuration, `git diff --check`, and `git fsck --full` PASS.

Browser-provenance remediation (uncommitted):

- The retired postMessage ACK test deterministically demonstrates that a page
  observing the public request ID can activate token B. The production test now
  dispatches the same legacy PONG and exact-success ACK and proves they are inert.
- The shipped manifest's `externally_connectable.matches` contains only the two
  current production origins. `dist-e2e-granted` deliberately adds loopback for
  real-browser testing without changing shipped permissions.
- A real Chromium external request from the isolated loopback fixture reached
  `onMessageExternal`, purged all audited stores, and returned success in 47 ms
  in an earlier full run and 65 ms in the final current-code run.
  The same API was not exposed on `https://employer.example.test`.
- Production Next.js plus the production MV3 worker held token B absent before
  the real response and after forged legacy messages; after purge release token
  B activated, session 2202 survived, user-A state remained absent, and no
  submission request occurred.
- Focused provenance validation passes: extension 52/52 and Web 61/61.
- Final extension validation passes: typecheck, production build
  (`3fd4bfc-dirty-70eb0fc`), 66 files / 1,021 unit tests, and 145/145
  Playwright E2E tests. One prior full invocation observed an unrelated
  expired-session UI timing assertion at its intermediate saving label; the
  unchanged case passed alone, its complete 17-test file passed 17/17, and the
  correctly configured final full invocation passed 145/145. XA-09 remained
  below its unchanged 2,000 ms ceiling (1.2 s benchmark and 1,280 ms
  production-MV3 refusal in the final run).
- Final Web validation passes: lint, typecheck, production build, and 46 files /
  908 unit tests.
- Docker Compose configuration, `git diff --check`, and `git fsck --full` pass.

## External basis

Chrome's official `externally_connectable` reference states that `matches`
declares which Web pages may use `runtime.connect` or `runtime.sendMessage` and
that Web pages cannot connect when it is absent. Chrome's messaging guide uses
`onMessageExternal` for Web-originated requests and states that extensions
cannot initiate messages back to Web pages. The Runtime API documents
`MessageSender.origin` (Chrome 80+), `url`, `tab`, and `frameId`; external Web
Promise support begins in Chrome 118, so this implementation uses callbacks to
remain compatible with the Chrome 116 build target. Callback connection errors
arrive with no response and `runtime.lastError`; Chrome does not expose a
separate installed-but-not-connectable bit, so only an explicit no-receiver
error is the accepted absence fallback.

References:

- https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable
- https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- https://developer.chrome.com/docs/extensions/reference/api/runtime
- https://developer.chrome.com/docs/extensions/reference/manifest/key

## Rollout and rollback

No host permission, dependency, server API, employer-page data, or submission
behavior changes. `externally_connectable` grants only message delivery from
the two named first-party origins; it grants no ability to read or script those
pages. Deploy the updated extension before configuring/deploying the Web ID so
an older installed build is not mistaken for an absent receiver. The stable
production ID comes only from the build-time `NEXT_PUBLIC_CHROME_EXTENSION_ID`
value and is public routing metadata, not a secret. The separate Web Store
install URL is never inferred as a routing source. No stable release ID is
currently tracked, so supplying the final published ID is a release
prerequisite before enabling the Web integration.
Rollback must revert Web and extension provenance changes together; leaving the
new Web build pointed at an old non-receiving extension would use the documented
no-receiver absence behavior.

## Progress

- [x] Recovered authoritative finding.
- [x] Reproduced and classified current behavior before production edits.
- [x] Implement authenticated teardown path.
- [x] Add focused coverage and negative control.
- [x] Complete full validation.
- [x] Reproduce checkpoint replacement and stale-writer races.
- [x] Add correlated teardown ACK and fail-closed replacement ordering.
- [x] Fence all audited async workflow/account writers with a monotonic epoch.
- [x] Validate production Web + production MV3 replacement ordering.
- [x] Complete race-safety full validation and negative controls.
- [x] Verify Chrome external messaging and MessageSender semantics from official documentation.
- [x] Replace postMessage teardown authority with browser-routed external messaging.
- [x] Add exact production manifest allowlist and test-only loopback handling.
- [x] Add same-page forgery and hostile-origin regression coverage.
- [x] Complete final full-suite provenance validation and scope audit.
