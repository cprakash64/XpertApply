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

## E4O-A in-page overlay foundation

The separate popup-window E4 product direction was rejected after manual UX
testing. Its uncommitted diff was preserved outside the repository for forensic
reference, and the branch was restored to the qualified E3B checkpoint before
E4O-A began. The popup assistant and Side Panel remain dormant/qualified
fallbacks; toolbar behavior, permissions, manifest, authentication, filling,
submission, and Store metadata are unchanged.

`src/content/applicationOverlay.ts` is the dormant foundation for the future
in-page assistant. It is intentionally not imported by the production content
entrypoint in this stage. Tests instantiate it through direct module calls, so
there is no runtime message, page global, action listener, or other production
test hook. The module owns one `#xpertapply-assistant-overlay-v1` host per
document and an open ShadowRoot. Its small state contract is `ABSENT`, `OPEN`,
`MINIMIZED`, and `HIDDEN`, exposed through idempotent ensure/show/minimize/
restore/hide/focus/destroy operations. User-facing close destroys the host and
listeners but does not touch authentication, workflow, ledger, permissions, or
session state.

The host is a fixed viewport layer with `pointer-events:none` and an intentional
author-stack z-index of `2147483000`; only the 400px panel or 44px restore pill
uses `pointer-events:auto`. The panel is top/right 16px, at most 420px wide and
`calc(100dvh - 32px)` tall, with a 100vh fallback, a 20px radius, near-white 96%
surface, 18px/120% backdrop treatment with a solid fallback, restrained border
and shadow, system typography, navy/cyan accents, and narrow-viewport rules.
Shadow CSS begins with `:host { all: initial; }` and never styles employer DOM.
The shell has no backdrop and never changes page scrolling.

The shell is a labelled `role="complementary"` aside, not a dialog. It has no
`aria-modal`, inert state, focus trap, or global keyboard handling. Minimize,
close, and restore are native buttons with explicit accessible names. Showing
does not steal focus; an explicit focus operation targets the labelled heading.
Focus indicators, forced-colors behavior, status text that is not color-only,
and reduced-motion rules are part of the foundation.

The existing `src/content/widget.ts` remains the production workflow UI for the
qualified content script. It uses `#jobpilot-assisted-apply`, a closed
ShadowRoot, and is created only after application workflow activation. It is
deeply coupled to filling, review actions, application answers, diagnostics,
and ledger/submission state, so changing it in E4O-A would exceed the shell-only
scope. The new foundation is never activated in production and therefore
cannot appear beside it. E4O-B must generalize the shared application
controller for a scoped ShadowRoot, integrate it into this foundation, define
the existing widget feature migration, preserve sender/tab/frame/document
authority, and prove behavioral parity before any toolbar cutover or widget
retirement.

## E4O-B canonical in-page assistant integration

E4O-B makes `#xpertapply-assistant-overlay-v1` the single production assistant
surface after the existing, qualified content workflow activates. The shell
retains its open ShadowRoot and now mounts the shared application-assistant
controller against that root. Controller DOM lookup is explicitly scoped to a
`Document` or `ShadowRoot`, and confirmation is supplied by the host adapter so
popup, Side Panel, and in-page behavior remain testable and independent.

The former `#jobpilot-assisted-apply` outer host is retired. Its workflow-only
review, teaching, transaction, and submission-confirmation renderers remain as
a temporary compatibility surface nested inside the canonical panel; duplicate
status, count, and standard-action chrome is hidden. This preserves the mature
workflow features while enforcing one visible outer panel and one canonical
application status/action owner. The compatibility surface can be removed in a
later stage after those specialized renderers move into shared components.

Overlay worker commands contain no caller-selected tab id. The service worker
derives tab, top-frame, URL, and document identity exclusively from
`MessageSender`, requires the exact top-document `documentId` registered by the
current frame probe, and then reuses the active workflow URL authorization.
Navigation therefore invalidates the old document immediately; the replacement
document becomes authoritative only after normal registration. Session and
permission actions additionally require equality with the current worker view.

User close is a UI dismissal only: it destroys the host and subscriptions but
does not clear binding, session, ledger, grants, or submission state. Passive
workflow updates target the detached compatibility surface and never recreate
the overlay. Minimize likewise survives passive updates. The reserved explicit
reopen adapter is the only future toolbar path allowed to recreate a dismissed
assistant. This stage deliberately leaves toolbar behavior, popup and Side
Panel fallback, manifest permissions, authentication, autofill, and submission
authority unchanged.

Validation covers scoped ShadowRoot lookup, injected confirmation, canonical
host uniqueness, legacy-host absence, close/minimize persistence, structural
sender rejection, stale-document denial and navigation re-registration, module
reachability, TypeScript, the extension suite, production build, manifest
inspection, and repository release checks. Rollback is a code revert to the
E4O-A dormant shell plus the former widget host; no migration, stored state, or
permission rollback is required.

## E4O-C exact-tab toolbar cutover

The normal toolbar action now belongs to a service-worker `action.onClicked`
listener. Chrome's clicked `Tab` is validated as an HTTP(S) document and used
directly; there is no active-tab query, current-window reconstruction, popup
binding, or cross-tab fallback. The action uses the gesture-scoped `activeTab`
grant plus the existing `scripting` permission to inject
`overlayBootstrap.js` and the qualified `content.js` workflow engine into frame
0 of that exact tab, then sends the payload-free
`SHOW_APPLICATION_OVERLAY` command to frame 0.

The dedicated bootstrap registers one listener in the document's extension
isolated world and marks the subsequent workflow activation as toolbar-initiated.
Repeated injection is idempotent. SHOW registers Chrome's sender-supplied tab/document/URL as a
transient in-memory toolbar document, then explicitly reopens, restores, and
focuses the canonical overlay. Full navigation destroys the document and its
listener; the next document is not opened until another toolbar click. Same-
document navigation retains the document fence and revalidates Chrome's URL.

Toolbar documents receive a synthetic, non-persistent view only when no real
workflow view exists. It deliberately treats `activeTab` as distinct from a
persistent exact-origin grant, so the existing access-required disclosure and
button remain authoritative. Toolbar open never calls `permissions.request`;
the worker still verifies `permissions.contains` before recording a grant.
Once an authorized workflow begins, its `LaunchViewState` replaces the
transient presentation and both paths reuse the same host and controller.

Side Panel action ownership is explicitly disabled on every worker start, while
its permission, declaration, source, and build asset remain as rollback code.
The popup assistant likewise remains packaged but is not opened by the toolbar.
There is no auto-open on activation, navigation, update, startup, or content
bundle load. Each document owns its own overlay lifecycle, so tab dismissal and
minimization are independent; an explicit toolbar click restores or reopens.

Automated acceptance covers exact-tab targeting, internal-page refusal,
idempotency, close/reopen, minimize/restore, per-document isolation, workflow
convergence, no permission request, no scan/mutation/submission call graph,
fallback regression, generated-manifest permissions, and bundle reachability.
Owner acceptance in real Chrome remains required for toolbar, visual, and
keyboard behavior before checkpointing. E4O-D must not begin until that manual
gate and the E4O-C checkpoint are complete.

## E4O-C-R1 owner-reported functional and visual repair

Owner acceptance rejected the first toolbar cutover because it mounted only
the presentation shell. The worker consequently returned a synthetic
`HANDOFF_NOT_FOUND` view with zero fields: the toolbar path never loaded the
qualified engine that registers the document, attaches the prepared workflow,
selects the ATS adapter, discovers fields, and performs user-requested fill.

The repaired call graph is action click → exact top-frame overlay bootstrap →
exact top-frame canonical workflow engine → existing `CONTENT_READY`/reconnect
attachment → read-only ATS/root/field discovery → canonical overlay view. The
isolated-world toolbar marker selects this mode. Toolbar open may identify the
ATS and enumerate application structure, but it does not invoke fill, upload,
change controls, advance the form, or submit. The explicit Fill action enters
the same qualified fill engine and retains sender tab, frame, and document
fencing.

The consumer overlay no longer mounts diagnostics, and technical failure codes
are translated to consumer guidance. The panel is bottom-right anchored at
18px (12px at narrow widths), grows upward, and uses a responsive 410px frosted
surface with 24px radius, layered neutral shadow, and 22px/145% backdrop
filtering. The minimized pill remains bottom-right. Side Panel and popup assets
remain dormant fallbacks. Manual owner acceptance must confirm real prepared
workflow attachment, nonzero discovery, fill parity, visual quality, and
keyboard behavior before checkpointing.

## E4O-C-R2 first-party presence bridge repair

Owner retesting found that the installed unpacked extension worked on employer
pages while xpertapply.com still advertised installation. The root cause was ID
coupling: Web presence detection used only browser-routed external messaging to
the configured Store ID. An unpacked build has a different Chrome ID, so Chrome
reported no receiving extension even though the declarative first-party content
script was active. Handoff itself already used that content script and remained
intact.

Presence now begins with a replayable, request-correlated
`XPERTAPPLY_EXTENSION_PRESENCE_PING` over the existing content-script bridge.
Only exact build-profile-approved first-party origins load and activate that
bridge. It answers `XPERTAPPLY_EXTENSION_PRESENCE_READY` with installed=true,
extension version, protocol version, and capability names—no tokens, session
identifiers, answers, documents, profile data, or employer values. The Web page
registers its listener before every ping, validates the matching request ID and
payload shape, and can repeat the check after focus, extension reload, or page
reload. Browser-routed Store-ID detection remains a compatibility fallback and
continues to own privileged auth-session teardown; presence is not authority.

The modal keeps its initial null state as CHECKING, maps a compatible response
to CONNECTED, a low protocol to INCOMPATIBLE, a clean timeout/unavailable result
to NOT_INSTALLED, and malformed/channel failures to ERROR. Install guidance is
rendered only for NOT_INSTALLED, never while checking, connected, incompatible,
or errored. The existing staged launch token and acknowledged handoff path are
unchanged. Manual acceptance must cover connected site UX followed by prepared
launch, employer attachment, discovery, and fill before checkpointing.

## E4O-C-R3 autonomous real-browser acceptance

Persistent Chromium acceptance now covers replayable Web PING/READY,
exact-tab toolbar-equivalent activation, overlay discovery, before-fill DOM
immutability, explicit DOM fill, review and submit safety, lifecycle isolation,
responsive layout, and keyboard escape. The test-only scenario lives in
`apps/extension/e2e/e4oc-r3-overlay.spec.ts` and uses an isolated profile plus
the existing nonshipping granted build.

The browser run exposed a stale-overlay race: the worker reached
`discovering_fields` with ten controls while the visible assistant retained its
initial snapshot. Chrome does not reliably deliver `storage.session` change
events to this isolated content-script surface under the default access policy.
The mounted overlay therefore performs a read-only worker refresh every 1,000 ms
and clears the timer on disposal; worker authority and form-mutation gates are
unchanged.

Deterministic results: ten eligible/discovered controls, no mutation before
Fill, verified text/email/phone/city/LinkedIn/select/radio population, privacy
and motivation left manual, zero submit clicks, and passing minimize/restore,
close/reopen, reload, two-tab isolation, 340/375/400/420 px, and keyboard gates.
A read-only live AECOM SmartRecruiters attempt reached OneClick, where Datadome
served a captcha before application controls hydrated. No data was entered and
no submission was attempted. Sanitized evidence remains outside the repository
under `/tmp/xpertapply-e4oc-r3-evidence`.

## E4O-D event-driven view synchronization and post-cutover hardening

The qualified E4O-C overlay refreshed worker context and view state every
1,000ms because `storage.session` change events are not available to ordinary
content scripts under Chrome's default trusted-context policy. An exact-SHA
Chromium baseline measured 60 timer callbacks, 60 context requests, and 60 view
requests during a 60-second idle window: 120 worker message handlers, with zero
network requests and no employer-DOM mutation.

E4O-D replaces that interval with one authoritative initial fetch plus a
payload-free `XPERTAPPLY_OVERLAY_VIEW_CHANGED` invalidation. All user-visible
workflow state already converges through the single `viewStates` session map;
the service worker observes changes to that map, identifies only changed tab
keys, and sends the invalidation only to the affected tab. The canonical
top-frame overlay consumes it; child frames do not own an overlay. The event
carries no answers, profile values, documents, tokens, session identifiers, or
business state. The receiving overlay accepts only its own extension runtime,
coalesces duplicate invalidations, and fetches context and view again. Existing
controller generations reject stale or out-of-order responses; worker sender,
tab, top-frame, URL, and registered-document checks remain authoritative for
the fetch and for every action.

Missed events converge deterministically on mount, explicit toolbar reopen,
document `pageshow`, return to visible state, and window focus. Full navigation
destroys the old isolated world, host, and listeners; the replacement document
does not auto-open. A sleeping or restarted worker is woken by the recovery
fetch and reconstructs state from `storage.session`. There is no recovery
interval. Close removes subscriptions and recovery listeners, passive updates
do not reopen, and minimize retains the same controller so state changes remain
available on restore.

The event-driven Chromium run measured zero overlay context/view requests and
zero network requests during the same 60-second idle window, a 100% idle-message
reduction. A real authoritative session-map mutation triggered an immediate
refetch/render; timing evidence is recorded with the browser acceptance output
under `/tmp/xpertapply-e4od-evidence`. Twenty minimize/restore/close/reopen
cycles ended with one host and no duplicate controller. Discovery remained
read-only before explicit Fill, ten fields were discovered, fill mutated only
the intended controls, manual-review fields remained untouched, and final
submit count remained zero.

UX hardening keeps the restrained bottom-right glass shell and makes secondary
actions contextual instead of presenting five disabled full-width controls.
The clear action is visually distinct, site-access disclosure is shorter while
retaining page/form-reading and service-transfer language, identical status
text is not rewritten into the polite live region, unknown internal error codes
map to consumer guidance, and forced-colors boundaries cover warnings and
actions. The quiet manual-submit reminder remains. Popup and Side Panel source,
assets, permissions, and rollback behavior remain unchanged.

Rollback is a source revert to the E4O-C interval implementation; no migration,
stored-data change, host-permission change, or Store operation is involved.
Legacy fallback removal is not part of E4O-D and remains subject to the
checkpoint review plus a fresh E4O-E acceptance decision.


## E4O-D-R1 qualification — 2026-09-29

**Historical R1 result: PASS — E4O-D QUALIFICATION COMPLETE.** The later
checkpoint invalidated R1's worker-recovery claim: its undeclared
`webNavigation` dependency threw before the intended fallback. R3 below
supersedes that recovery architecture and evidence. Repository-wide Playwright is
**BASELINE-EQUIVALENT PRE-EXISTING FAILURE**, not a clean suite PASS: the final
162-test attempt completed with 137 passed, seven failed, and 18 dependency
skips. All seven failures reproduced consistently on an independent, Git-clean
worktree at `738523e56bed89cbccad5d24afa5e12266927351`. No unresolved E4O-D
regression or UNKNOWN failure remains. Checkpoint review must explicitly assess
the debt; no commit, push, deployment, or Store operation was performed.

### Architecture, defects, and decisions

Payload-free exact-tab/frame invalidation, authoritative fetches, generation
protection, and event-based recovery remain. The one-second view interval stays
removed. Real isolated-world instrumentation exposed two controller subscriptions
because toolbar and workflow are separate bundles with separate module maps.
The old interval incidentally disposed the detached controller; removing polling
left it subscribed until focus recovery. Document-keyed WeakMap/WeakSet ownership
now lives in the extension isolated world, shared across those bundles, with no
page-world API and no cross-document ownership. A separate-module regression
proves identical controller identity and subscription cleanup.

A scrolling employer page exposed a 3px left overflow at 340px width. A real
Chromium A/B using both revisions' actual overlay CSS confirmed the baseline
also overflowed: viewport 340px, layout width 325px, native scrollbar 15px,
panel left -3px. Changing the two panel width calculations from `100vw` to
containing-block percentages restores left 12px without changing employer
scrollbars. This is a qualification-driven defect repair, not discretionary UX.

The initial reload host-count mismatch was treated conservatively as an E4O-D
regression, not labeled flaky. Baseline reload acceptance passed four runs
(one initial and three repetitions). After ownership repair, fresh E4O-D
acceptance and the final full run pass reload; no auto-open was added.

### Real-browser validation

The isolated persistent extension harness uses Chromium 151.0.7922.34 from the
same installed Playwright test runtime on both revisions. Local Web returned
HTTP 200 and the isolated API returned healthy before cleanup. Session endpoints
and employer applications use synthetic fixture data; this is not a live
employer or production-account acceptance claim.

The extension registration was physically stopped through
`chrome://serviceworker-internals` and observed STOPPED. The surviving overlay
recovered on focus, retained one host/controller/subscription, reacquired content
frame authority, and explicitly filled the employer DOM after restart. Initial
recovery plus an intentional duplicate-focus coalescing check required two
READY requests, two context requests, and two view requests in total; the duplicate
focus pair alone coalesced to one READY/context/view sequence. Restart emitted
zero additional state-change notifications and no retry storm. Recovery assertions
wait for ordinary bounded render convergence, rather than mistaking handler-entry
counters for rendered readiness; normal assertion timeouts are unchanged. Removing the
synthetic authoritative workflow records, stopping the worker again, and
recovering produced the safe Idle view with Fill disabled.

500/600/700/900px height gates pass with bottom-right anchoring, reachable header,
close/minimize, internal body scrolling, primary action scrolling, and actual
employer-page scrolling. 80/100/125/150/200% native `chrome.tabs.setZoom` gates
pass; zoom was read back with `getZoom`, controls were operated with real clicks,
and minimized restore remained usable. Forced-colors and reduced-motion browser
media gates pass with keyboard minimize/restore. Screenshots at 500/700/900px
were visually reviewed.

Two distinct normal Chrome windows pass independent open, close, minimize,
focus, and authority checks. Authoritative mutation A caused one A view fetch
and zero B fetches; mutation B caused one B fetch and no additional A fetch.
No manual invalidation was injected to make the cross-window check pass.

Twenty complete minimize/restore/close/reopen cycles finish with one host and
one active controller. Every counter sample retains one notification
subscription, three lifecycle registrations, and zero periodic view timers. The complete 60-second idle window
measured zero context/view messages, zero context-wide network requests, zero
employer discovery queries, and zero form mutations. Before explicit Fill,
form mutations were also zero. Intended fields verify; privacy and free-text
review remain manual; final submit activation remains zero.

Direct MutationObserver render timing measured 15ms versus 30ms when sampled
after the harness wait. Other fresh runs measured 14–32ms. The prior 501ms was
not reproduced, and its raw original measurement is unavailable, so its precise
cause is not asserted. The view event path uses microtasks, not a 500ms debounce;
the existing 500ms employer-DOM rediscovery debounce is a separate path. No
latency optimization was made.

### Playwright A/B analysis and existing debt

Both revisions use normal one-worker Chromium configuration, retained failure
traces, unchanged timeouts, and zero retries. The full command is
`npm run test:e2e -- --max-failures=0`; final runs add an isolated `--output`
directory, and baseline comparisons select the failing specs. Dependency links
are inside an ignored real node_modules directory; the authoritative baseline
comparison starts with empty Git status and the exact SHA. No E4O-D source was
copied into the baseline.

The final seven failures are PREEXISTING_DETERMINISTIC:

- `application-answer.spec.ts`: unanswered work-authorization answer/apply/verify;
  old top-level widget host is absent.
- `xa09-real-extension.spec.ts`: 5,000-control refusal; obsolete widget selector
  times out after 20 seconds.
- `xa10-real-extension.spec.ts`: production Clear; obsolete widget selector
  times out at 60 seconds.
- `xa11-status-coherence.spec.ts`: confirmation totals; obsolete widget selector
  times out at 60 seconds.
- `xa12-account-replacement.spec.ts`: replacement-auth purge ACK; expected
  `XPERTAPPLY_EXTERNAL_SESSION_END` is absent on both revisions.
- `xa16-xa19-widget.spec.ts`: production semantics/constrained viewport;
  obsolete widget selector times out at 180 seconds.
- `zz-3c2-frame-discovery.spec.ts`: Stage 3C-3 frame grant; unscoped `#ats`
  matches both employer and overlay elements, producing the same strict-mode
  violation on both revisions.

These tests were not casually repaired. The 18 skips are serial dependencies
of the first application-answer failure and the Stage 3C-3 failure, not passes.
Web presence has additional PREEXISTING_FLAKE evidence: three baseline repeats
produced one pass and two identical presence timeouts. Fresh final targeted and
full E4O-D presence checks pass. Initial Web connection refusal is ENVIRONMENTAL,
reproduced on baseline with the local Web service stopped.

The initial 162-test run completed 131 passed / 10 failed / 21 skipped. Concurrent
runs initially shared Playwright output and deleted each other's artifacts,
causing B-03 trace ENOENT and an extra XA-16 trace error. This validation mistake
was corrected by isolated output directories. An intentionally isolated clean-
baseline collision control reproduced the same ENOENT; isolated B-03 repeated
three times passes, and the final full B-03 passes. These artifact errors are
ENVIRONMENTAL, not product or pre-existing-test claims.

### Fresh regressions, static checks, and evidence

Web: 51 files / 970 tests / zero failures or unhandled errors. Extension: 83 files /
1,288 tests / zero failures or unhandled errors. Focused overlay/event/authority:
47 tests in four files. Security: 180 tests in ten files. Separately rerun
functional groups: ATS 16, SmartRecruiters-related 67, discovery 54, autofill 59,
dropdown 56, radio/checkbox 34, review 49, documents/resume/cover-letter 39;
all pass, in addition to the complete Extension suite. API: 2,120 tests pass in
an isolated Python 3.12 environment (`make test-api API_PYTHON=/tmp/xpertapply-e4od-r1-api-venv/bin/python`).

Web lint/typecheck/production build, Extension typecheck/production/development
builds, `make test-extension`, manifest asset/permission validation, Compose
configuration, and diff whitespace validation pass. No API schema or migrations
changed; migration-specific feature checks are not applicable. The complete API
suite includes existing migration coverage.

Sanitized evidence: `/tmp/xpertapply-e4od-r1-evidence`, including the full
55-item audit report, exact changed paths, failure messages/timings, baseline
comparison logs, direct worker/lifecycle counters, screenshots, native zoom,
window identities, and latency results. Raw payload-bearing traces and browser
profiles are excluded from retained evidence; sanitized error extracts preserve
failure proof. Temporary baseline removal uses normal Git worktree tooling.
Historical auth-evolution, Store-release, and prod-auth worktrees remain clean;
the canonical protected design-system plan remains untouched.

### Rollout, rollback, and next stage

Changes remain unstaged and uncommitted on `feature/assistant-window` at the
qualified SHA. Shipping permissions, hosts, fallbacks, auth requirements, and
manual-submit boundaries are unchanged. Production access: NONE.

Fallback-removal recommendation: **NOT READY**. Keep both fallbacks until
checkpoint review and a fresh E4O-E acceptance decision; explicitly dispose of
or accept the documented baseline test debt. Rollback remains a source revert
to the qualified E4O-C revision, restoring its interval; there is no migration
or stored-data rollout. R1's isolated-world ownership and scrollbar fixes can
also be reviewed independently in the unstaged diff.

NEXT: EXTENSION RELEASE STAGE E4O-D-CHECKPOINT — FINAL REVIEW AND COMMIT
OF EVENT-DRIVEN STATE / UX / ACCESSIBILITY HARDENING. This R1 performs no commit.


## E4O-D-R3 permissionless all-frame recovery — 2026-09-29

Checkpoint found that the R1 recovery call used `chrome.webNavigation.getAllFrames` without its required permission. A real production-bundle probe confirmed the namespace was undefined. R2 stopped before edits because trusted child ATS registrations participate in fill arbitration and exact-document submission authority; top-frame overlay ownership does not eliminate those roles. Manifest expansion remains rejected.

R3 reuses `JOBPILOT_CONTENT_RECONNECT` as a payload-free, non-authoritative signal. After all worker listeners install synchronously, a microtask starts one bounded tab inventory pass using existing `tabs` permission. Each HTTP(S) tab receives at most one `tabs.sendMessage` without a frame/document option, reaching surviving content contexts in all frames. Broadcast responses are discarded. Each current frame independently sends existing `CONTENT_READY`; normal sender-derived tab/frame/document/origin, workflow, host-permission and document-targeted probe gates reconstruct the existing registry. The content receiver checks extension identity, coalesces an in-flight registration and replaces unavailable local session state; it does not discover, fill, inject, request permission or open UI.

The coordinator runs once per worker lifetime, coalesces concurrent calls, clears its in-flight marker on success/failure, handles missing receivers quietly and adds no timer. Candidate inventory does not rely on lost worker-local registrations. No frame enumeration, Port architecture, passive script injection or additional registration protocol is introduced. Existing explicit toolbar bootstrap and fallbacks remain. Production permissions stay `activeTab`, `sidePanel`, `storage`, `scripting`, `tabs`; hosts and version 0.2.0 remain unchanged.

Before implementation, isolated Chromium proved one untargeted tabs message reached one top and two child contexts, each independently returning a sender-derived registration; `webNavigation` was undefined in that browser. Sanitized evidence: `/tmp/xpertapply-e4od-r3-evidence/all-frame-message-proof.json`.

### R3 validation and related narrow repair

The first actual child-frame run exposed a child overlay: read-only child discovery called the widget facade without a top-frame guard. The facade now returns inert UI methods for child documents while existing worker progress/fill remains active. A unit regression and all-frame browser topology prove only frame 0 owns host/controller/subscriptions. This is required by the recovered-role policy, not a UI redesign.

Chromium 151.0.7922.34 physically stopped the exact extension registration in `chrome://serviceworker-internals`, observed STOPPED, and woke it by focus without reloading employer documents. Five cycles preserve all current qualified documents and independently successful CONTENT_READY responses. Each surviving context receives exactly one recovery signal per startup; normal registration creates one canonical map entry per tab/frame. Each top keeps host/controller/notification/lifecycle/timer counts 1/1/1/3/0; every child keeps 0/0/0/0/0. Two normal windows retain distinct tab identities. An injected untrusted child remains rejected by normal origin qualification. A removed child and replaced document disappear from topology; a new explicitly bootstrapped trusted frame registers through normal CONTENT_READY without another recovery broadcast. Explicit fixture bootstrap is test setup, not passive production reinjection.

An independently filled child verifies expected synthetic first-name/email values after explicit Fill, with free text/consent preserved, zero pre-Fill form mutations and zero final-submit activation. The connected Web/top-frame workflow also passes actual DOM fill. Missing-receiver ordinary tabs remain without UI/state and produce no recovery console error. Session-unavailable physical restart converges to Idle with Fill disabled. The post-recovery 60-second interval across both tabs reports zero context/view messages, recovery signals/registration messages, network requests, discovery calls and form mutation. Twenty open/minimize/restore/close/reopen cycles remain bounded. Height 500/600/700/900, native zoom 80/100/125/150/200%, forced colors, reduced motion and keyboard/employer-page reachability pass.

The older duplicate-focus measurement initially overlapped legitimate startup CONTENT_READY view transitions (3 context/view requests instead of the separate focus-pair target 1). The harness now waits for bounded startup message convergence within its unchanged five-second assertion limit before measuring the independent focus pair, which still coalesces to 1 context + 1 view. No product polling/retry/timeout workaround was added. One targeted presence attempt reproduced the independently documented baseline presence flake; the full-suite presence check passes.

Fresh focused tests: 7 files / 110 tests PASS. Security expanded to 20 files / 401 tests PASS, including consequential/legal/sponsorship/jurisdiction and session/privacy coverage. Eight separate functional groups pass: ATS 16, SmartRecruiters 67, discovery 54, fill 59, dropdown 56, radio/checkbox 34, review 49, documents 39. Full Web: 51 files / 970 PASS, zero failures/unhandled errors; full Extension: 84 files / 1,298 PASS, zero failures/unhandled errors; API: 2,120 PASS. Standard Web lint/typecheck/build, Extension typecheck/production/development builds, make test-extension, both generated manifests/assets, Compose and diff checks pass. Browser harness typecheck also passes using existing Node types. No migrations or API changes; full API includes migration tests.

The final repository-wide Playwright run completes with **138 passed / 7 failed / 18 dependency skips** (163 tests, 14.5 minutes, one worker, zero retries). Result: **BASELINE-EQUIVALENT PRE-EXISTING FAILURE**, not suite PASS. All seven exact failing test names and error mechanisms match the independent clean baseline at `738523e56bed89cbccad5d24afa5e12266927351`; the extra pass is the new R3 recovery acceptance. Web presence, E4O-C/E4O-D owned workflow and R3 child recovery pass in that full run. No new/UNKNOWN failure remains, and none of the seven historical failing test files, timeouts or retries was changed. The targeted presence timeout remains transparently recorded as the baseline-proven flake rather than erased.

**PASS — ALL-FRAME PERMISSIONLESS RECOVERY QUALIFIED.** Changes remain unstaged/uncommitted on the starting branch/SHA with upstream 0 ahead / 0 behind. The final reviewed scope is 15 tracked modifications plus 3 new recovery source/test files (18 paths); no unrelated path. Historical auth-evolution, Store-release and prod-auth worktrees stay clean/unchanged; the canonical protected design-system modification and its SHA256 are unchanged. Local test services are stopped after qualification. Production access NONE. Popup/Side Panel KEPT; fallback-removal NOT READY. NEXT: EXTENSION RELEASE STAGE E4O-D-CHECKPOINT — FINAL REVIEW AND CHECKPOINT COMMIT. R3 does not commit or push.

Sanitized evidence lives at `/tmp/xpertapply-e4od-r3-evidence`: all-frame message semantics, current before/after topology, five physical restarts, child rejection/removal/replacement/new registration, child fill, idle metrics, top workflow/UX/stress, security/functional/full suite logs, permission proof and per-hunk diff review. Test instrumentation stays in e2e source and never enters production bundles. Runtime recovery has no webNavigation/getAllFrames call. Production/development permission lists remain exactly the five existing permissions; only existing development loopback differences remain. No Port architecture.

Rollout: leave E4O-D/R3 unstaged and uncommitted; no push/deployment/Store mutation. Rollback before eventual release: revert the eventual qualified checkpoint; retain Popup and Side Panel. Fallback-removal recommendation remains NOT READY.


## E4O-D checkpoint qualification — 2026-09-30

Starting branch `feature/assistant-window`, HEAD/upstream
`738523e56bed89cbccad5d24afa5e12266927351`, staging empty, 0 ahead / 0 behind.
Fresh Git reproduces exactly 15 tracked modifications and 3 new files (18 paths).
The complete source/test/plan diff is reviewed by hunk: event-driven state,
recovery, frame authority, performance, UX, accessibility, tests and plan; no
unexpected hunk. Two comments are corrected to describe untargeted affected-tab
delivery and canonical top-frame consumption accurately; executable behavior is
unchanged. R3 structured evidence is independently consistent with its report.

Fresh focused qualification passes: recovery/event 7 files / 110 tests; security
20 files / 401; ATS 16, SmartRecruiters 67, discovery 54, fill 59, dropdown 56,
radio/checkbox 34, review 49, documents 39. Full Extension passes 84 files / 1,298
tests with no failures or unhandled errors. API passes 2,120 tests (1,788 existing
warnings), including migration coverage; no API/schema/migration edits.

The first two `make test-web` attempts pass lint/typecheck/production build but
fail varying unchanged jobs-workspace tests: first two missing-result assertions,
then the large-list test's existing 20-second timeout. The unchanged file passes
24/24 in isolation. The complete Web suite passes 51 files / 970 with two workers,
then passes again with its default parallelism after the other unit suites finish.
No test/assertion/timeout/configuration was changed. Both failed attempts are
retained; resource contention is the supported timing explanation, not a product
repair. Final full Web has zero failures/unhandled errors.

Fresh targeted browser qualification passes all three tests: connected Web
presence/replay/reload, top workflow and permissionless all-frame recovery. Five
physical Stop/restart cycles without employer reload reconstruct current qualified
documents, preserve top counts 1 host / 1 controller / 1 notification / 3 lifecycle
listeners / 0 periodic timers and child counts all zero. The fifth cycle's immediate
child snapshot precedes its callback; the subsequent settled `after` snapshot
records the successful registration before idle/Fill. This is asynchronous
sampling, and is preserved transparently in the evidence audit. Untrusted children
remain rejected; removed/replaced IDs are absent; new frames register normally.
Child first-name/email fill occurs after explicit Fill, manual text/consent remain
untouched, pre-Fill mutations and final submits are zero. Recovered 60-second idle
measures zero context/view/registration/recovery messages, network, discovery and
form mutations. Session-invalid physical restart produces Idle with Fill disabled.
Width, 500px height, native 200% zoom, keyboard, forced-colors/reduced-motion and
20-cycle ownership checks pass; the fresh 500px screenshot is visually reviewed.

Extension production/development builds and typecheck, browser-harness typecheck,
`make test-extension`, manifest/asset validation, Compose and diff checks pass.
Both manifests remain MV3 / 0.2.0 with exactly activeTab, sidePanel, storage,
scripting and tabs; no optional webNavigation or host expansion. Source/bundles
have no executable webNavigation/getAllFrames dependency or test instrumentation.
Existing finite explicit-activation/probe delays are unrelated to view polling.

**BLOCKED — PLAYWRIGHT REGRESSION.** The single fresh repository-wide run
finishes with **136 passed / 8 failed / 19 skipped** (163 total, 17.1 minutes),
plus one worker-teardown error. One worker, zero retries; no test/assertion/timeout
changes. The seven known failures retain their exact names and error mechanisms.
The additional `question-resolution.spec.ts:345`, “enumeration never activates
Submit or consent”, times out after 60 seconds while setting up its browser
`context`, before form-safety assertions execute. Its worker teardown also times
out at 30 seconds and “the ledger reconciles and drives one consistent summary”
is skipped. Thus the skips are 18 baseline dependencies plus one additional
worker-failure skip. Trace errors establish the setup/teardown location, but
this eighth failure has no exact-clean-baseline equivalence established here;
it cannot be silently added to the accepted set or erased by rerunning the full
suite. The unchanged test subsequently passes alone in 8.1 seconds (8.7-second
run), supporting an intermittent browser-startup problem; that diagnostic does
not replace the blocking full-run result or establish baseline equivalence. This is a blocking qualification result, not proof of a product safety
assertion failure.

The full run independently passes connected Web presence, top workflow and
all-frame recovery. Settled per-document counters record five new successful
registrations in each qualified context; one cycle-3 top snapshot is sampled
before its callback and the following snapshot contains both completed results.
Both asynchronous snapshot notes remain in structured audits.

The explicit seven-failure table above remains accepted baseline debt and is
not suite PASS. Fallback-removal recommendation remains NOT READY; Popup and
Side Panel are KEPT. Exact-path staging and commit are NOT performed. HEAD
remains 738523e with 0 ahead / 0 behind and all 18 paths unstaged. No push.
NEXT: Investigate/requalify the additional browser-context startup failure
before checkpoint staging/commit; this blocked result does not advance to push.

Evidence: `/tmp/xpertapply-e4od-checkpoint-r3-evidence`. Historical worktree
HEAD/status and protected canonical file hash match R3. Production access NONE.
Only after a future qualification passes every gate may the explicit reviewed
18 paths be staged for a checkpoint with parent 738523e and message
`perf(extension): use event-driven assistant state updates`. No push, deployment,
Store mutation, fallback removal, auto-open, permission/host expansion, auth
weakening or final-submit automation. Rollback is a revert of this checkpoint;
no data migration is involved.


## E4O-D-R4 startup/teardown investigation — 2026-09-30

R4 investigates the additional checkpoint browser-context setup timeout and
30-second worker-teardown timeout without staging, committing or changing
product/test source. Starting HEAD/upstream remains 738523e, 0 ahead / 0 behind,
with the same 18 unstaged paths. Original sanitized extracts preserve the
context-fixture boundary and worker-teardown error, but not the original browser
PID, exact launch operation/timestamp, profile path or stderr. Those details
remain unknown rather than reconstructed as facts.

A detached, source-unmodified temporary worktree at the exact baseline SHA uses
the same installed Playwright/Chromium dependencies. Five normal current and
five baseline isolation runs pass; an initial exploratory skip-build matrix is
also retained separately. Normal global setup is enabled identically for the
qualified A/B matrix. The identical immediate-predecessor frame spec followed
by the entire question-resolution spec passes 20/20 on both revisions.

Structural telemetry records launched browser PIDs/children, driver processes,
profiles, locks, local listeners and resource counts without browsing records.
No owned surviving browser process or teardown timeout is observed in these
completed comparisons. Separate concurrent headless-shell processes are kept
distinct from R4-owned browser PIDs; their counts alone do not establish an R4
leak. Existing unlocked named overlay profiles are retained by both revisions;
R3 recovery deletes its unique profile after closing the context.

Cleanup review identifies candidate launch-before-finally and sequential-cleanup
risks, including the inherited baseline overlay pattern. No causal current-only
regression is proven, so no runtime or harness repair is authorized by evidence
yet. All six repeated producer→question sequences pass (overlay, recovery and
both, twice each), with no owned browser/helper survivors or global errors.
Current and baseline each create and close ten fresh persistent contexts, then
pass the disputed test. Success/body-failure cleanup covers control pages through
context.close; launch-before-try and sequential cleanup remain unproven candidate
failure paths, not grounds for an unqualified repair.

Both complete Playwright runs use unchanged normal setup, one worker, zero
retries and original timeouts: each **138 passed / 7 failed / 18 skipped / 163**,
zero global worker-teardown errors and zero launched browser survivors. All seven
failures exactly match previously qualified clean-baseline debt; the original
extra context failure and associated teardown are not accepted baseline debt.
Both disputed-test and following-ledger tests pass in both runs. Full recovery
acceptance passes five physical stop/restart cycles in each run, all qualified
living documents recover, removed/replaced documents stay absent, child DOM fill
preserves manual/consent choices, submit count is zero, and 60-second idle
context/view/ready/recovery/discovery/network deltas are zero. Immediate snapshots
can precede an asynchronous callback; settled counters qualify all five cycles.

Fresh Web qualification passes 970 tests (51 files, bounded two unit workers);
fresh Extension passes 1298 (84 files). Extension and strict browser-harness
typechecks pass; normal global setup rebuilds the E2E artifacts. API 2120 passes
are carried forward from the immediately preceding checkpoint because API source,
dependencies and environment are unchanged. No migration changes. Earlier
production/development/manifest checks remain applicable to unchanged R4 source.
All 17 runtime/test hashes match R4 preflight. Per-hunk review retains the existing
release categories; no TEST-HARNESS-CLEANUP repair hunk was added. The same 18 paths
remain unstaged, HEAD/upstream 738523e, 0/0; diff check passes.

**Classification UNKNOWN; verdict BLOCKED — UNKNOWN PLAYWRIGHT FAILURE.**
Passing isolation, sequence, churn and full reruns does not prove a preexisting
flake or environmental exhaustion. The original exact awaited operation,
browser PID/profile/stderr and incident resource telemetry were not retained.
Later resource samples and absent readable crash reports do not establish the
original cause. No E4O-D product regression or harness leak is demonstrated, but
the unresolved original incident still blocks checkpoint advancement. Recover
original diagnostics or capture an instrumented recurrence before classifying.
Do not stage, commit or push. Only the living plan changed during R4; no product
or test repair, timeout/retry change or feature relaxation occurred.

The R4 detached baseline was removed with normal git worktree remove after a
clean source-status check. Owned fixture services and named profiles are cleaned
up after qualification; unrelated browsers/listeners and historical worktrees
remain untouched, with protected HEAD/status/file hashes matching the checkpoint.
Production access NONE. Popup and Side Panel KEPT; fallback removal NOT READY.
Evidence: `/tmp/xpertapply-e4od-r4-evidence`, including separate disclosure of the
exploratory skip-build matrix and partial original exploratory raw retention.
Rollout remains blocked; eventual rollback remains a checkpoint revert with no
data migration.


## E4O-D-R5 prospective qualification — 2026-10-01

Branch/HEAD/upstream remain `feature/assistant-window` /
`738523e56bed89cbccad5d24afa5e12266927351`, 0 ahead / 0 behind, staging empty.
Starting scope is the same 18 paths. No product/runtime/test source repair is
made. All captured product/test source hashes match preflight; generated granted
builds and TypeScript caches are excluded from source identity. Next dev's
managed AGENTS/CLAUDE files were removed after verifying they were newly generated;
the fresh production build restored next-env.d.ts to its original bytes. R5 only
updates this plan in the repository. Instrumentation/evidence lives outside it
at `/tmp/xpertapply-e4od-r5-evidence`.

Prospective instrumentation uses an external NODE_OPTIONS preload, public
Playwright reporter, pw:browser launch stderr and a 500ms owned-process ancestry
sampler. Every launch records test identity, worker/Node PID, launch timestamps,
browser version, root PID/profile identity, context/page/serviceworker availability,
close boundaries, exit and post-run resource audits. No business payload logging
is added to the consumer extension. Initial instrumentation verification is
separate from the three qualified sanity runs. All runs retain normal global
setup, one worker, zero retries and unchanged timeouts/order. Installed Playwright
is 1.63.0; Chromium is 151.0.7922.34 throughout.

Disputed sanity: 3/3 PASS. Context launch/create durations: 3387 / 2979 / 2926ms;
test durations: 8674 / 8372 / 8623ms; close durations: 193 / 249 / 317ms.
Both ordered overlay → physical all-frame recovery → disputed-test contamination
sequences pass 3/3, with zero global errors, survivors and fixture-port leaks.

Full Playwright results (163 total each):

| Run | Passed | Failed | Skipped | Global/worker-teardown errors | Owned survivors/leaks |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 138 | 7 | 18 | 0 | 0 |
| 2 | 135 | 8 | 20 | 0 | 0 |
| 3 (triggered) | 138 | 7 | 18 | 0 | 0 |

The seven documented PREEXISTING_DETERMINISTIC failures retain their exact
names/mechanisms in all three runs. Full suite is NOT PASS. Run #2 additionally
fails question-resolution.spec.ts:325, “a resolved answer whose actuator cannot
open becomes a technical issue”: `interaction_failed` is absent when sampled.
The serial group skips the disputed test and following ledger test, explaining
two extra skips and three fewer passes. No context startup or worker teardown
timeout occurred. The extra assertion passes in runs #1/#3 and 3/3 current isolated
comparisons; the exact clean baseline archive also passes it 3/3 with the same
installed dependencies and normal setup. That does not prove baseline flakiness.

Retained structural trace establishes that enumeration completes about 5719ms
after the first fixed wait starts; roughly 2280ms remain before the assertion.
R5 originally interpreted the actuator budget as a single 2500ms menu wait.
R6 corrects that interpretation: openCustomControl uses seven 420ms waits, plus
settling and scheduling. Pending actuator work at the assertion remains the
retained observation; exact T1/T3/T5 timestamps were not captured in R5. The test and actuator source are byte-identical
to HEAD. The origin of the delayed progression/current-only relevance remains
unproven; no product repair, assertion rewrite or timeout change is made.
Classification of this NEW current incident: UNKNOWN. Do not add it to the seven
accepted failures or erase it because the third run is favorable. Three full
executions are the R5 maximum; no fourth suite was run.

Resource audits show every owned Chromium root/child and test worker gone,
all temporary profiles removed and no profile lock/abandoned fixture server or
port. Named overlay profiles are intentionally retained unlocked by the existing
harness and removed after qualification. The separately maintained port-3000
Web fixture is explicitly stopped after each complete run and final acceptance;
the immediate audit's intentional live fixture and subsequent zero-listener
cleanup audit are both retained. No unrelated user browser/server is killed.
All 141/139/141 contexts emit close events. Three post-await wrapper completion
markers are absent in each run, only for the same known XA-10/XA-11/XA-16 timeout
workers; their context close events and process exits are captured and no global
teardown error or survivor occurs. No new lifecycle anomaly is inferred from
those interrupted wrapper continuations.

Historical original context/teardown event: HISTORICAL_UNREPRODUCED_INCIDENT.
It is acknowledged, causally unknown, not reproduced prospectively and retained
as historical diagnostic debt. This is not PASS, PREEXISTING_DETERMINISTIC or
PREEXISTING_FLAKE; it is not an eighth accepted deterministic baseline failure.
Missing old diagnostics alone no longer block checkpoint advancement. The current
R5 block is solely the newly observed actuator assertion, not that historical event.

Targeted final product/browser acceptance: 3/3 PASS. Connected Web presence,
prepared handoff, top discovery/explicit DOM Fill, five physical Stop/restart
cycles, all-frame living-document reconstruction, stale/removed/replaced document
exclusion and child DOM Fill pass. Manual/review/consent fields are preserved.
Pre-Fill input/form mutations = 0; final submit = 0. Recovered 60-second idle has
context/view/recovery/ready/discovery/network/mutation deltas all 0. Periodic view
timers = 0. Payload-free XPERTAPPLY_OVERLAY_VIEW_CHANGED → authoritative fetch →
render is qualified (fresh top latency sample 92ms). Isolation, viewport/height,
native zoom, keyboard, forced colors, reduced motion and 20 ownership cycles pass.

Fresh make test-web passes lint/typecheck/production build and 51 files / 970
unit tests; make test-extension passes typecheck/84 files / 1298 unit tests and
production build. Development build and strict browser-harness typecheck pass;
the initial harness CLI invocation's TypeScript-6 --ignoreConfig syntax error is
retained separately and corrected without source edits. Compose config and diff
checks pass. Immediately qualified API 2120 PASS (including migration coverage)
is carried forward: API source/dependencies/environment are unchanged; no R5 API
or Alembic changes. Fresh generated manifests remain 0.2.0 with exactly activeTab,
sidePanel, storage, scripting, tabs, no webNavigation or host expansion.

### Release policy superseding the R4 infinite historical gate

E4O-D may checkpoint when current E4O-D-owned browser acceptance and unit/security/
build gates pass; two fully instrumented complete suites demonstrate no new or
UNKNOWN current failure; only the seven proven deterministic baseline failures
remain; and the unrepeatable old context/teardown event does not recur and remains
historical diagnostic debt. Retrospective causal proof from discarded evidence
is not required. An optional third run may investigate disagreement but cannot
silently erase a new current failure. R5 does not meet that policy because run #2
contains the newly observed, not-baseline-proven actuator assertion.

**BLOCKED — NEW UNKNOWN PLAYWRIGHT FAILURE.** No E4O-D product regression or test
harness resource leak is demonstrated, but the new current assertion still needs
causal/baseline disposition before checkpoint. Historical auth-evolution,
store-release and prod-auth remain clean/unchanged; canonical's protected design
file and unrelated status remain untouched. Production access NONE. Popup and
Side Panel KEPT; fallback removal NOT READY. No staging, commit, push, deployment,
Store change, auto-open, permission/host expansion, auth weakening or final-submit
automation. Next: bounded investigation/disposition of the newly captured actuator
assertion, then requalification in a separately authorized stage; checkpoint is
not authorized by this R5 result. Eventual rollback remains a checkpoint revert
with no migration.


## E4O-D-R6 actuator synchronization qualification — 2026-10-01

R6 preserves HEAD/upstream 738523e, the original 18 unstaged paths and all 17
R5 product/test hashes. No runtime repair is justified by the investigation.
External, in-memory test-bundle instrumentation captures T0 navigation, T1
applyResolvedAnswer, T2 openCustomControl, T3 actual menu_not_opened result, T4
interaction_failed classification, T5 existing failure log and synchronous ledger
record, and T6 the original one-shot displayed() sample. No field values,
credentials or application payloads are recorded. The untouched baseline is an
actual detached worktree at 738523e with the same installed dependencies.

Current original test: 20/20 PASS. Baseline original test: 17 PASS / 3 FAIL, all
three at the same early actuator assertion. Two baseline failures retain the
subsequent correct log and ledger technical issue. Baseline repeat index 6 was
censored by the initial diagnostic teardown observation: T6 preceded even T1,
and no T3 settlement was observed before context cleanup. It is not evidence
of a failed actuator that never publishes its result. Later diagnostic observers
wait conditionally within the existing normal test deadline, preserving the
original assertion failure. Controlled fixture delays also reproduce the exact
race on current with eventual correct ledger classification. Full matrices and
qualification gates are in progress; checkpoint is not yet authorized.

The original test uses the helper's 4500ms wait followed by another 3500ms wait
and a one-shot displayed() evaluation. Neither orders the assertion after the
actuator. Correcting the R5 interpretation: openCustomControl tries seven
OPEN_ATTEMPT_TIMEOUT_MS=420 waits (nominal 2940ms), rather than a single
MENU_TIMEOUT_MS=2500 wait. Enumeration, resolver round trip, DOM settling and
scheduling precede or surround these waits. The narrow existing completion
signal is option_ref_returned followed by the same interaction_failed log
containing menu_not_opened. The ledger records that terminal issue synchronously
in that turn; a subsequent browser evaluation follows it.

Classification supported so far: TEST_SYNCHRONIZATION_DEFECT and
BASELINE_TIMING_DEBT=YES. Product failure after settled actuator: none observed.
A narrow repair will replace only the additional 3500ms sleep with condition-based
expect.poll, bounded by the unchanged normal test deadline, retaining every
original selection/gesture/failure/enumeration assertion. No test timeout or
retry setting is increased. Runtime, permission, host, auth and fallback changes
remain outside this stage. R6 remains qualification only: no staging/commit/push,
deployment or Store mutation. Rollout requires the later explicit checkpoint
review; rollback would revert that checkpoint, with no data migration.

R6 progress: the narrow test repair is now applied only in
apps/extension/e2e/question-resolution.spec.ts. Current repaired stress passes
30/30, with all 30 samples after the exact terminal log/ledger issue. Natural
current T1-T5 min/median/p95/max: 3017.4/3042.8/3075.1/3213.3ms (20 retained
latencies). Natural baseline: 3026.7/3044.0/3351.5/3351.5ms (19 retained latencies;
one pre-settlement-censored trial, explicitly excluded rather than imputed).

Controlled before-repair trials use a declared 1500ms mock resolver response
delay in every row, plus 0/50/100/250/500/1000ms test-only holding of the real
failed actuator result in an external instrumented bundle. Current results:
FAIL/PASS/PASS/FAIL/FAIL/FAIL. Baseline: PASS/FAIL/FAIL/FAIL/FAIL/FAIL. All 12
retain correct interaction_failed/menu_not_opened terminal ledger classification,
unchanged employer choice, no consent and no submit. Scheduling variation makes
the smallest increments non-monotonic; all 250/500/1000ms rows fail early on
both revisions. Baseline natural failures independently establish the race
without any injected delay.

After repair, all six delays pass on current AND baseline runtime (12/12),
using an external copy of the baseline test with the same narrow patch. Baseline
source is untouched; three normal baseline-copy trials also pass. The initial
external copy lacked type=module and failed to load before any test ran. That
external harness setup error is retained and corrected solely with a package.json
in the external copy; it is not a product/test behavior failure. Missing/wrong
signal negative controls and neighboring/full-suite qualification remain pending.

All four external observer-only negative controls fail at the semantic assertion
under the unchanged 60000ms test deadline: missing attempt marker, missing
completion (pending), substituted non-interaction failure, and wrong issue reason.
The independent diagnostic collector sees the real correct ledger state in each;
these are deliberate assertion failures, not product defects or accepted suite
failures. All original safety assertions are byte-identical outside the replaced
wait block. No timeout/retry inflation or arbitrary sleep was introduced.

Three complete question-resolution repetitions pass 45/45, with zero global
errors or owned browser/worker/fixture leaks. The R4 immediate-predecessor sequence
embedded-application-frame.spec.ts -> question-resolution.spec.ts passes 20/20
with the same clean resource audit. Contamination, fresh product acceptance and
the two final full suites remain pending.

Contamination gates now pass: full E4O-C overlay/presence -> physical all-frame
recovery -> entire question-resolution spec, 18/18; then recovery -> exact
actuator, 2/2. Both contexts/workers/profiles/listeners audit clean, and each
owned port3000 Web fixture is stopped with zero remaining listeners. Recovery
evidence retains zero pre-Fill input/form mutation, zero final submit, stale/
removed/untrusted frame safety and recovered idle 60s with all context/view/
recovery/ready/discovery/network deltas 0. Fresh standalone product acceptance
and exactly two complete Playwright suites are still pending.

Fresh standalone E4O-C/E4O-D acceptance passes 3/3. Five physical worker Stop/
restart cycles reconstruct living top/trusted child contexts; child-fill and
stale/removed/untrusted safety pass. Pre-Fill input/form mutations 0, final submit 0,
recovered idle 60s all deltas 0, canonical idle 60s unchanged, consumer polling 0.

Final full Playwright #1: 138 passed / 7 failed / 18 skipped / 163 total; #2: 138
passed / 7 failed / 18 skipped / 163 total. Both exact file/title/status failure
sets AND mechanisms match the seven retained PREEXISTING_DETERMINISTIC cases.
No new/unknown current failure, global error or worker-teardown error. The
repaired actuator passes in both, with terminal issue before sample (T1-T5
3039.1ms/3037.5ms; T5-T6+131.7ms/+87.7ms). Exactly two full suites were run.

Both full runs create 141 contexts and emit 141 close events; the same 3 known
legacy timeout workers lack post-await wrapper-completion markers, while their
close events and process exits remain captured. Owned root/child/test-worker
survivors 0 and profile locks 0. Immediate audits intentionally see the external
owned port3000 Web fixture; post-shutdown boundaries have 0 listeners, and its
recorded root/listener PIDs are verified gone before the next fixture/run.
No unrelated process is terminated.

One final baseline-only 20-trial original-source timing matrix is collecting
complete prospective clocks with the corrected conditional diagnostic observer.
This addresses the initial baseline observer's pre-T3-censored trial; original
17-pass/3-fail evidence remains authoritative and retained. It is not another
full-suite run or a favorable-result loop. Fresh unit/build/static gates follow
serially; final source/diff/historical-worktree guards are still pending.

### R6 final qualification and disposition

The final original-source baseline matrix passes 20/20 with all 20 complete
terminal timelines and no early samples, global errors or resource leaks.
T1-T5 min/median/p95/max is 3021.1/3038.3/3066.4/3110.5ms
(nearest-rank p95). This completes prospective timing coverage and does not erase
the first natural baseline matrix's 17 PASS / 3 early FAIL result or its one
pre-T3-censored diagnostic observation. Baseline source and original spec are
verified pristine at 738523e before the temporary detached worktree is removed.

Fresh make test-extension: 84 files / 1,298 PASS, typecheck and production build
PASS. Focused question-ledger/batch/dropdown/assistant/overlay: 5 files / 92 PASS.
Fresh make test-web: 51 files / 970 PASS, lint/typecheck/production build PASS.
Strict browser TypeScript covers both acceptance specs and the repaired question
spec: PASS. Compose config and diff checks PASS. API 2,120 PASS remains carried
forward under the explicit unchanged-source/dependencies/environment rule; no
API or Alembic change/run. Separate security 401 and broad functional matrices
are not required for this test-only patch; existing qualified scope remains
unchanged, with fresh full Extension unit and product-acceptance coverage.

Only the extra 3,500ms test sleep/comment block changes; every other spec byte
including the helper, original assertions, fixtures and normal 60,000ms timeout
is identical. expect.poll observes the existing resolved marker plus the exact
interaction_failed/menu_not_opened event, bounded by that same runner deadline.
Four observer-only fault controls reject missing attempt, pending, missing
interaction failure and wrong reason at that unchanged deadline. No retry or
sleep workaround, consumer polling or new production event is introduced.

Final debt categories remain distinct: seven PREEXISTING_DETERMINISTIC failures;
HISTORICAL_UNREPRODUCED_INCIDENT (original context/teardown cause unknown, no
recurrence); TEST_SYNCHRONIZATION_DEFECT_RESOLVED (actuator assertion, confirmed
baseline timing debt=YES). No observed failed actuator misses the correct terminal
classification; the censored first-baseline trial never reached observed T3 and
is not imputed as evidence either way. No runtime repair is needed.

Generated Next AGENTS/CLAUDE artifacts are removed only after exact content
comparison; fresh production build restores next-env to HEAD bytes. The closed,
unlocked owned fixture profile is removed. All original 17 product/test hashes
must match R5; final authoritative scope is the original 18 paths plus only
question-resolution.spec.ts (19). Final source/historical/status proof and the
mandatory 68-item report are saved under /tmp/xpertapply-e4od-r6-evidence. Every
path/hunk has an allowed classification; no unrelated source change is allowed.

R6 result: PASS — ACTUATOR ASSERTION DISPOSITIONED; E4O-D READY FOR CHECKPOINT.
Qualification preserves empty staging, branch/HEAD/upstream 738523e and 0/0.
Production access NONE. Popup and Side Panel fallbacks remain. No commit, push,
deployment, Store mutation, auto-open, permission/host expansion, auth weakening
or final-submit automation. Rollout requires the separately authorized exact-path
checkpoint review/staging/commit; rollback would revert that checkpoint, with no
data migration. NEXT: EXTENSION RELEASE STAGE E4O-D-CHECKPOINT — FINAL EXACT-PATH
REVIEW, STAGING, AND COMMIT. DO NOT COMMIT OR PUSH IN R6.

Verified detailed actuator storage/rendering and async graph:

```text
R6 call graph, unchanged repository runtime

resolveAndFillQuestions(root, runId)
  await recoverApplicationOverrides() [content -> worker runtime request / API recovery]
  discoverQuestionFields(root) [synchronous DOM discovery]
  await enumerateClosedControls(fields) [DOM opening/enumeration, bounded waits, no answering]
  buildQuestionBatch()
  await resolveAndApply(root, prepared, runId)
    emitStage(resolver_requested)
    await sendRuntime(RESOLVE_QUESTIONS) [content -> worker -> mocked backend /resolve-questions -> worker -> content]
    validate schema, active resolution generation, options, client semantics
    emitStage(option_ref_returned) [existing marker before T1 attempted actuator]
    questionLedger.record(answer_resolved), record(selecting), publishStage()
    T1: await applyResolvedAnswer(...)
      client semantic/consequential gates; live re-discovery; reacquire callback
      await selectApprovedOption(...)
        await fillCustomSelect(...)
          T2: await openCustomControl(...)
            await dismissForeignMenus()
            click -> await waitForMenu(420ms)
            pointer sequence -> await waitForMenu(420ms)
            press-only sequence -> await waitForMenu(420ms)
            Enter / Space / ArrowDown / Alt+ArrowDown -> four await waitForMenu(420ms)
            all synthetic opens refused by existing ?gesture=1 fixture -> null
          T3: real transaction failure result {ok:false, reason:menu_not_opened}
          test-only delay experiment may hold this result (0-1000ms); no timeout constant altered
      T4: classify result.status=interaction_failed (user_value_present would differ)
    active-run guard; T5: emitStage(interaction_failed,{reason:menu_not_opened}) -> existing log.info -> page console -> test states[]
    synchronous questionLedger.record(interaction_failed,menu_not_opened) -> technical_issues count
    update execution trace/outcomes; return; publishStage() from resolveAndFillQuestions
      ledger stage/counts -> widget.update() -> transaction panel -> qualified overlay/state producer

The existing failure log is emitted just before the synchronous ledger record in the same JavaScript turn. A subsequent CDP page evaluation occurs after that turn. No production event is added. Narrow semantic condition: resolved attempt marker observed, then the SAME existing failure log contains apply.stage.interaction_failed AND menu_not_opened. Instrumented ledger-terminal additionally confirms state/reason/technical count for qualification.

Important correction to R5 interpretation: MENU_TIMEOUT_MS=2500 exists but is not the seven-step openCustomControl budget. OPEN_ATTEMPT_TIMEOUT_MS=420 is used seven times (nominal 2940ms), plus foreign-menu dismissal, polling/DOM work and scheduling. Neither fixed 4500ms shared setup wait nor extra 3500ms test wait is a completion acknowledgement.

Async boundaries: override recovery; enumeration/open waits using window timers; runtime message promise; backend request/fixture fulfill; Promise continuation; repeated DOM actuator waits; selection promise; console event transport; final page evaluation. Ledger classification after the result is synchronous; render/publication follows the normal controller path. A fixed sleep is not ordered after those boundaries.

Verified source locations for the graph (current source unchanged):
bootstrap.ts:2389 emitStage; 2461 resolveAndFillQuestions; 2493 resolveAndApply;
2669 option_ref_returned; 2674/2675 resolved/selecting ledger entries;
2685 interaction_failed publication; 2694 terminal ledger record;
3271 applyResolvedAnswer; 3397 result classification.
dropdownTransaction.ts:145 OPEN_ATTEMPT_TIMEOUT_MS=420;
640 waitForMenu (observer/timer cleanup); 765 openCustomControl;
791/794/802/815 seven bounded open waits; 964 fillCustomSelect;
978 menu_not_opened failure; 1064 selectApprovedOption.
background.ts:985 RESOLVE_QUESTIONS; 995 await resolveQuestions.
api/client.ts:342 resolveQuestions; 348 mocked session resolver endpoint.
No evidence of a periodic polling boundary in this actuator path. expect.poll
is test-process condition observation, distinct from prohibited consumer 1s polling.

Exact storage/rendering: content/questionLedger.ts:167 QuestionLedger.record
updates the existing same-field entry. counts()/stage() at268/272 derive from
that entry; bucketFor interaction_failed at294/295 is technical_issues, and
stageFor states containing interaction_failed at391/392 is waiting_for_you,
not ready_for_review. bootstrap.ts:3111 publishStage reads ledger stage/counts,
maps waiting_for_you to widget review presentation, calls widget.update and
publishTransactionPanel. That panel derives finalStatus technical_issue from the
execution trace and publishes existing transaction rows. Bootstrap's existing
authoritative diagnostic snapshot at3775 includes stage/counts/reasons. These
are stored/rendered consequences; this E2E assertion's direct observable is the
existing console failure event, not an elapsed timer or a new rendering event.
```


## E4O-D-R7 actuator safety coverage — 2026-10-02

The final checkpoint stopped at Phase G: the exact failed-actuator scenario
observed privacy/submission state but did not assert either. Executing its R6
predicate/postconditions with consent=true or submitted=true still passed.
This is missing scenario coverage, not evidence of an observed product safety
regression. The neighboring enumeration-safety scenario has no resolved answer
and lacks gesture=1, so it cannot substitute for this scenario's assertions.

R7 changes only question-resolution.spec.ts and this plan. A scenario-local
addInitScript installs observers before navigation. DOMContentLoaded records
the actual unchecked privacy checkbox before asynchronous actuator execution;
submit-event and final-submit-button click counters start at zero. The original
R6 resolved-attempt + interaction_failed/menu_not_opened semantic polling and
all original selection/gesture/failure/enumeration assertions remain intact.
Additional post-actuator assertions require initialPrivacy=false, actual final
checkbox checked equal to initialPrivacy, submitEvents=0, submitClicks=0, and
the existing fixture's submit-handler marker submitted=false. No runtime hook,
production source edit, timeout/retry increase or arbitrary wait is added.

External-only qualification mutations prove both assertions: actual checkbox
checked=true fails the consent comparison at line 368; clicking the actual
fixture Submit button (test-only noValidate bypass, existing preventDefault
handler retained) records a real submit event and fails submitEvents=0 at line
369. These are intentional test faults, not product submissions. Normal initial
acceptance passes with privacy unchanged and no submission. Instrumented clocks
record initial checkbox observation before applyResolvedAnswer begins. Neither
fault is present in repository source; subsequent positive runs have neither
fault environment flag. Evidence stays in /tmp/xpertapply-e4od-r7-evidence.

The 30-consecutive actuator stress, six supported 0/50/100/250/500/1000ms delayed
completion rows, three whole-question repetitions, focused event/recovery and
full unit/static gates, targeted E4O-C/E4O-D acceptance and exactly one final
full Playwright suite are in progress. R7 PASS requires all these gates plus
runtime/manifest/hash/historical-worktree integrity; no qualification claim is
made before completion. API 2,120 PASS may be carried only under unchanged API
source/dependencies/environment. The final seven baseline failures must retain
their exact names/mechanisms; repository-wide Playwright must not be called green.

Keep distinct: PREEXISTING_DETERMINISTIC (seven),
HISTORICAL_UNREPRODUCED_INCIDENT (old context/worker event),
TEST_SYNCHRONIZATION_DEFECT_RESOLVED (R6 timing), and the newly repaired
ACTUATOR_SAFETY_COVERAGE_GAP_RESOLVED (R7 assertion coverage, pending qualification).
Rollout remains a separately authorized checkpoint after R7 gates pass; R7 never
stages, commits or pushes. Rollback of this test-only repair removes only these
scenario observers/assertions and this stage record, preserving R6 synchronization.
Popup/Side Panel remain KEPT; fallback removal NOT READY; no deployment, Store,
production, permission/host/version/auth changes or automatic final submission.


R7 stress result: **29 passed / 1 timed out / 0 skipped / 30 total**. Repeat
index 11 timed out at the unchanged 60,000ms deadline in the existing seed()
Worker.evaluateExpression (question-resolution.spec.ts:150), after fixture setup
and the new scenario addInitScript completed, before navigation, actuator execution
or safety assertions. The trace retains the exact unfinished browser operation;
launch/root/profile/close/exit clocks are captured. All 29 terminal-observed runs
have correct interaction_failed/menu_not_opened, initial false consent observed
before T1, final false consent, submit-event count 0, submit-button click count 0
and submitted=false. Global/worker-teardown errors, owned survivors and fixture
port leaks are 0. This batch was not retried or replaced by favorable repetitions.

The seed timeout is a NEW current qualification failure with root cause UNKNOWN,
not an accepted eighth deterministic baseline failure, not the old historical
context/teardown incident, and not an observed product consent/submission defect.
It blocks the required 30/30 stress gate and any R7 PASS. Independent remaining
requested gates continue once to provide bounded evidence; none can erase this
failure. Production/runtime source remains unchanged. No staging/commit/push.


### R7 final results and blocking disposition

All six supported actuator-completion delays (0/50/100/250/500/1000ms, same
1500ms mock resolver delay) pass: 6/6. Each observes the exact terminal technical
issue, initial checkbox false before T1, final false consent, zero submit events
and clicks, and submitted=false. Delays exist only in external in-memory build
copies; production timing/source stays unchanged. Old R6 postconditions pass
both unsafe synthetic assertion inputs; new R7 assertions fail both. The actual
browser negative controls separately fail at the intended consent and submit
assertions, with correct actuator classification retained. All negative contexts
close, mutations are absent from positive runs and repository source, and external
instrumented bundle copies are removed after qualification.

Three complete question-resolution repetitions pass **45/45**. Focused event/
recovery/changed-unit coverage passes **6 files / 106 tests**. Fresh full Extension
passes **84 files / 1,298 tests**, typecheck and production build; fresh Web passes
**51 files / 970 tests**, lint/typecheck/production build. Strict browser-harness
TypeScript (all three affected acceptance/question specs), Compose and diff
checks pass. API **2,120 PASS carried forward** under unchanged API source,
dependencies and environment; no API/migration execution or edits in R7.

Fresh targeted E4O-C/E4O-D acceptance passes **3/3**: connected prepared workflow,
canonical overlay/read-only discovery, zero pre-Fill mutations, explicit top Fill,
trusted child Fill, manual/consent preservation, zero final submit, five physical
all-frame Stop/restart cycles, removed/replaced/untrusted rejection, and recovered
60-second idle with all synchronization/discovery/network deltas zero.

Exactly **one** final full Playwright suite runs with one worker, zero retries
and normal timeouts: **138 passed / 7 failed / 18 skipped / 163 total**. Exact
seven failure names/statuses/mechanisms match the established baseline table.
No new/UNKNOWN full-suite failure or global/worker-teardown error; the strengthened
actuator passes in this full run. Repository-wide Playwright is not green. All
141 contexts emit close events; the same three legacy timeout cases lack only
post-await wrapper-completion markers. Owned browser/worker survivors and profile
locks are zero. The intentionally owned Web fixture present at immediate audit
is stopped afterward; its root PID is gone and port 3000 has zero listeners.

The four prior facts remain separate: PREEXISTING_DETERMINISTIC (seven),
HISTORICAL_UNREPRODUCED_INCIDENT (old context/teardown event),
TEST_SYNCHRONIZATION_DEFECT_RESOLVED (R6), and
ACTUATOR_SAFETY_COVERAGE_GAP_RESOLVED (R7 assertions and unsafe-state detection).
The NEW current R7 stress seed timeout remains separately unresolved. The final
full-suite success of this scenario does not erase the **29/30** stress result,
establish baseline equivalence, or identify its cause. No actual consent or
submission product defect was observed; no runtime repair was made.

**BLOCKED — TEST REGRESSION.** R7 cannot satisfy its required 30/30 stress gate
and does not advance to checkpoint. Next: investigate the retained Worker.evaluate
seed timeout, then explicitly requalify before staging/commit. No favorable-result
stress/full rerun, deadline/retry inflation or assertion weakening occurred.

Final integrity: all 643 captured product/runtime/API/Web/shared/manifest hashes
and all 17 original E4O-D product/test hashes match preflight. Manifest source,
version 0.2.0, five permissions and host surface remain unchanged. Normal Web
production build restores generated next-env bytes; only the exact known newly
generated AGENTS/CLAUDE files are removed. Closed, unlocked owned profile cleanup
and source/diff/historical checks are recorded externally. R7 repository changes
are only this plan and the exact actuator scenario; the authoritative E4O-D union
remains 19 unique unstaged paths, staging empty, HEAD/upstream 738523e, 0/0.
Historical worktrees and both protected canonical checkouts remain untouched.
Production access NONE; Popup/Side Panel KEPT; fallback removal NOT READY.
No staging, commit, push, deployment, Store mutation, version/permission/host/auth
change, auto-open or product final-submit automation. The deliberate synthetic
Submit-button negative control is isolated test evidence, not employer automation.
Evidence and mandatory report: /tmp/xpertapply-e4od-r7-evidence/R7-report.txt.

## E4O-D-R8 — finite disposition of the pre-navigation seed incident

R8 is qualification only. Worktree `XpertApply-assistant-window`, branch
`feature/assistant-window`, HEAD/upstream `738523e56bed89cbccad5d24afa5e12266927351`,
0 ahead / 0 behind, empty staging, initial authoritative union 19 paths.
No product/runtime or release-test helper repair is justified or made.

### Captured R7 facts and exact setup boundary

Repeat/worker index 11, Node 90084, Chrome root 90091, profile identifier
`4f860feef42f6599`: context created 2026-10-02 08:40:41.925 UTC; one initial page
and one initial worker. The R7 safety `addInitScript` completes at trace clock
125398.655ms; seed API begins 125403.793ms; `Worker.evaluateExpression` begins
125404.369ms without a captured completion. The entire test's 60,000ms deadline
expires; teardown starts at trace clock 183475.547ms. Context close starts
08:41:40.025 UTC, close event 08:41:40.920, Chrome exits code 0 at 08:41:42.670,
context close completes 08:41:42.777, fixture server closes 08:41:42.780, Node
exits code 0 at 08:41:42.859. Global errors, owned survivors, profile locks and
fixture listener leaks are zero. Employer page creation/navigation and actuator
T1 were never reached. Worker callback entry, storage operation entry, worker
URL/target/liveness and actual page URL at timeout were **not captured**. Launch
arguments containing `about:blank` do not establish the timeout URL. R8 does not
infer that `storage.set` itself entered or hung, or retrospectively identify an
unobserved lifecycle/environmental cause.

Exact call graph: local synthetic fixture server and mocked API routes → fresh
`launchPersistentContext("")` (initial about:blank page) → existing worker lookup,
or `serviceworker` event wait capped at 15s → R7 safety `addInitScript` → `run()` →
`seed(worker,url)` → one awaited `worker.evaluate(async callback,url)` → Date/URL
construction → one awaited `(chrome.storage.session ?? chrome.storage.local).set`
→ callback completes → evaluation acknowledgment → employer `context.newPage()`
→ console observer → `page.goto()` → form ready → existing unchanged helper wait
→ actuator assertions. The initial browser page precedes seed; the employer page
is created **after** acknowledgment. The 60s owner is the whole Playwright test;
Worker.evaluate adds no independent 60s timer.

Seed writes only `activeAssistedApplyHandoffV1`: synthetic prepared handoff and
its application/job/request/session identifiers, official URL/origin, creation/
expiry timestamps, waiting-for-content-script state and protocol version 3.
It does not establish real authentication, fetch a package or use network,
runtime messaging, IndexedDB, localStorage or an application promise lock.
The raw Chrome storage write bypasses `withAuthorityMutation`; background revival
can execute concurrently but seed does not await it or its mutation fence. The
only callback await is Chrome storage.set; the outer await is Playwright evaluate.
Playwright's implementation may wait for its worker execution context before
entering a callback, but no R7 evidence identifies that as the historical cause.

### Prospective instrumentation, A/B and isolation

External test-only instrumentation records Node-relative S0 context/initial page,
S1 worker identity/URL, S2 requested evaluation plus CDP live/attached target ID,
S3 first callback line, S4 storage start/end, S5 callback completion, S6 evaluate
acknowledgment and S7 navigation. Callback markers contain stages only; timestamps
are received on the common Node monotonic clock. Target creation/change/destruction,
worker close, browser/process/profile ownership and context/server teardown are
recorded. The target lookup is observation, with no target-readiness polling,
reacquisition, evaluation retry or swallowed failure. The evaluated callback keeps
its exact sole storage await. Isolated cases verify persisted synthetic state
through a separate storage read and never navigate, Fill or run an actuator.

One fixed current isolated batch: **50/50 PASS**. One fixed clean-baseline runtime
isolated batch: **50/50 PASS**. One fixed current R7 actuator batch: **30/30 PASS**.
One fixed baseline-runtime externally copied qualified R7 actuator batch:
**30/30 PASS**. Same Playwright 1.63.0, Chromium 151.0.7922.34, machine, configuration,
60s test timeout, one worker and zero retries. Baseline tracked source stays at
exact HEAD; two temporary dependency symlinks supply identical installed libraries
and are removed before clean normal `git worktree remove`, without force.

Seed evaluate latency, min / median / p95 / max, milliseconds:

| Batch | min | median | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| Current isolated 50 | 4.315 | 12.605 | 110.656 | 808.424 |
| Baseline isolated 50 | 3.837 | 12.744 | 30.059 | 48.866 |
| Current actuator 30 | 4.807 | 8.851 | 39.821 | 1633.318 |
| Baseline actuator 30 | 6.595 | 10.619 | 37.287 | 65.445 |

Actuator T1–T5 durations are recorded separately from seed evaluation. All 60
actuator cases retain exact `interaction_failed` / `menu_not_opened`, one attempt,
initial false consent before T1, final consent unchanged, zero submit events and
clicks, and submitted=false. All 160 fixed seeds acknowledge on a live attached
current target; no stale-target or worker-detach anomaly. All fixed batches have
zero global errors, owned survivors, profile locks and fixture listener leaks.

Each isolated case and each normal actuator repeat owns a distinct generated
profile: 50/50 and 30/30 unique profiles per corresponding batch. Chrome storage,
worker globals and mocked fixture state are isolated; identical synthetic IDs do
not imply shared storage. Fresh-profile comparison equals the normal strategy;
no alternate shared-profile experiment is relevant. R7 repeat 11 could not inherit
profile state from repeats 0–10. The standalone stress owns new contexts and has
no deliberate physical restart before seed, even if restart tests ran previously
in the session. No restart correlation is observed.

A fixed controlled matrix of four modes × three repetitions passes **12/12 on
current and 12/12 on baseline**: no churn, explicit `ServiceWorker.startWorker`
wake, native chrome://serviceworker-internals Stop followed by explicit CDP Start,
and five repeated normal worker lookups. This Chrome build preserves Playwright's
Worker object across Stop/Start; reacquisition uses the existing fixture contract,
not a catch/retry around seed. Seed still evaluates once on the inspected live
attached target after each controlled lifecycle operation.

External instrumentation pilots are retained, separate from release qualification:
three initial seed-instrumentation construction failures occurred before callback
execution because Babel transpiles nullish coalescing; the storage-await anchor
was corrected externally before the four fixed A/B batches. Churn construction
pilots assumed an available native Start button on a running registration and/or
an immediate Worker.close after Stop. These assumptions were false. Three pilots
and an invalid close-event matrix produced setup failures before seed; the latter
was gracefully cancelled through its verified owned Playwright CLI PID. All were
cleaned without owned leaks. Corrected lifecycle mechanics were fixed before the
final 12/12 matrices. No release helper repair or historical seed-cause inference
follows from these independently authored experiment errors. No repository-wide
suite or required 50/30 stress batch was repeated for a favorable result.

### Disposition, regression, rollout and rollback

Three complete question-resolution repetitions pass **45/45**; all 15 question
cases in the single full suite also pass with 15/15 captured seed acknowledgments.
Consent and submission unsafe-state controls each fail once at their exact R7
assertion; the following normal case passes with unchanged false privacy, zero
submit events/clicks and submitted=false. No negative-control mutation persists.
Fresh Extension passes **84 files / 1,298 tests**, typecheck and production build;
fresh Web passes **51 files / 970 tests**, lint/typecheck/production build. Focused
changed event/recovery coverage passes **6 files / 106 tests**. Strict harness
TypeScript covers the three affected repository specs and three external harness
specs; Compose and final diff checks pass. API **2,120 PASS carried forward**:
336 captured API source/dependency files and API environment unchanged, no API
or migration work in R8.

Fresh targeted E4O-C/E4O-D acceptance passes **3/3**, including zero pre-Fill
mutation, explicit top/child Fill, five physical Stop/restart cycles, all-frame
recovery and stale/removed/untrusted rejection, manual/legal/consent preservation,
final submit 0, and recovered 60s idle with all measured deltas zero.

Exactly **one** final full Playwright run: **137 passed / 8 failed / 18 skipped /
163 total**, one worker, zero retries, unchanged normal timeouts. All seven
PREEXISTING_DETERMINISTIC failures remain with matching mechanisms, plus one NEW
full-suite failure: `E4O-C-R3 canonical toolbar overlay discovers then explicitly
fills the real DOM`, at `e4oc-r3-overlay.spec.ts:494`. After awaited `page.reload()`,
the soft `reload must not auto-open` assertion expects overlay host count 0 but
observes 1, before the following explicit SHOW message. The same targeted test
passed earlier. The new failure is **UNCLASSIFIED**; targeted success does not
erase it or prove an environmental, harness or product cause. Its paired reload/
count/assertion trace and report are retained. No source repair or favorable-result
full-suite rerun occurs. Repository-wide Playwright is not green; checkpoint is
blocked by this separate current failure, not the dispositioned seed incident.

Full suite global/worker-teardown errors 0; all 141 contexts emit close events,
138 have wrapper-completion markers (the same three legacy timeout gaps); owned
survivors, profile locks and unexpected fixture listeners 0. The intentionally
owned Web fixture is stopped after its immediate audit, with port 3000 empty.
Seed acknowledgments show no full-suite recurrence or stale/detach anomaly.


Final categories remain separate:
`PREEXISTING_DETERMINISTIC` (seven full-suite failures),
`HISTORICAL_UNREPRODUCED_INCIDENT` (older context/teardown event),
`TEST_SYNCHRONIZATION_DEFECT_RESOLVED` (R6),
`ACTUATOR_SAFETY_COVERAGE_GAP_RESOLVED` (R7), and this seed incident
`HISTORICAL_UNREPRODUCED_CURRENT_INCIDENT` (R8 finite disposition).
Separate `NEW_FULL_SUITE_FAILURE_UNCLASSIFIED` records the reload/no-auto-open
failure without merging it into any historical category.
No current reproducible unknown seed behavior or seed-related product/release-helper
harness defect is observed. A separate new full-suite reload/no-auto-open failure
remains unclassified and blocks checkpoint. Its historical root cause remains unknown. The fixed seed
and lifecycle gates pass; that absence of reproduction supports disposition rather than a claim
that the historical cause has been proven. No repair means seed-negative and
post-repair 100/30 gates are not applicable.

All 643 captured product/runtime/API/Web/shared/manifest hashes, the qualified
question-resolution source and the other existing E4O-D files remain unchanged.
R8's only repository change is this plan addition; external diagnostics are kept
under `/tmp/xpertapply-e4od-r8-evidence`. Exact generated Next guidance files are
removed only after content matching; normal production build restores next-env.
Closed owned profiles and external instrumented bundle copies are cleaned. The
19-path union is fully classified with no UNEXPECTED hunks. All historical roots
and both protected canonical design-system modifications remain untouched.

**BLOCKED — NEW PLAYWRIGHT FAILURE.** The seed incident is dispositioned under
the finite rule, but the new reload/no-auto-open failure prevents checkpoint.
Qualification does not publish or stage. Next is a separately scoped investigation
of the retained new failure, with no favorable-result full-suite rerun in R8.
Final exact-path review, staging and commit remain deferred. Rollback of R8 documentation is removal
of this section; there is no runtime change to reverse. Existing E4O-D rollback
and fallback strategy remain in force. Popup and Side Panel kept; no auto-open,
permission/host/auth change, final-submit automation, staging, commit, push,
deployment, Store mutation or production access. Mandatory 62-item report:
`/tmp/xpertapply-e4od-r8-evidence/R8-report.txt`.

## E4O-D-R9 — reload/no-auto-open repair; qualification blocked

R8's retained failure is `E4O-C-R3 canonical toolbar overlay discovers then explicitly fills the real DOM`, at the immediate post-`page.reload()` soft assertion (`reload must not auto-open`, expected host count 0, observed 1). The test is OPEN before reload: toolbar-equivalent injection/SHOW → discovery → physical worker restart → explicit Fill → Minimize → Restore → Close → explicit SHOW → viewport/zoom loops (including Close and explicit SHOW) → keyboard Minimize/Restore → employer input focus → reload. Close occurs earlier but is followed by explicit reopening. The documented E4O-C contract explicitly says full navigation destroys the document and the next document requires another toolbar click. There is no reload semantics contradiction. OPEN, CLOSED/ABSENT, HIDDEN, and MINIMIZED all become ABSENT on a fresh document; same-document passive events retain the existing state. Minimize remains distinct from Close within a document.

The creation call graph was toolbar `action.onClicked` → exact-tab validation → `overlayBootstrap.js` + `content.js` injection → trusted payload-free SHOW → `TOOLBAR_OVERLAY_READY` sender/document registration → explicit reopen → mount → show → ensure/append host (EXPLICIT_USER_OPEN). The defective passive graph was tab load completion → pending workflow `ensureContentReady`/content injection → `initAtsPage` → CONTENT_READY → `checkHandoffAndStart` → `ensureWidget` → `createWidget` → mount/show/ensure/append (INVALID_AUTO_OPEN). Recovery/CONTENT_RECONNECT independently re-registers content; view invalidations fetch state; pageshow/visibility/focus refresh an already-connected mount (RECOVERY_ONLY/STATE_REFRESH). They do not replay toolbar SHOW. The root defect is workflow presentation creation granting UI opening authority, rather than persisted OPEN state or surviving old-document DOM.

Worker `viewStates` is keyed by tab and describes workflow state (`completed_with_review` before reload, `fetching_package` during new startup); it does not store overlay OPEN/CLOSED/MINIMIZED. The transient toolbar authority map binds tab to Chrome's sender-derived documentId and URL. The controller/overlay/dismissal registries are document-local WeakMaps/WeakSet shared in the extension isolated world. Chrome full reload produced distinct IDs: one current proof changed `A31E3CE7F6CDA8B2A2746F17B6C54612` → `4FA8616B8C01427CE7E4587CCC539539`. The observed new host was created at epoch ms 1790981456936 by content.js, with bootstrap marker false. The creation stack explicitly includes `initAtsPage → checkHandoffAndStart → ensureWidget → createWidget → mountApplicationAssistantOverlay → showOverlay → ensureOverlay`. Historical R8 document IDs were not captured and are not inferred.

Current fixed 20-case isolation: 0 pass / 20 fail; 18 cases captured real new-document passive mounting; 2 expired before lifecycle measurement. Baseline fixed 20-case isolation at detached 738523e: 0 pass / 20 fail; 17 captured the same product defect; 3 expired before measurement. External startup completion instrumentation corrects the first interrupted diagnostic's premature 'settled' sample. Those interrupted construction batches are not counted as qualification. Missing per-run facts remain missing. Baseline reproduction does not excuse violation: classification PRODUCT_AUTO_OPEN_DEFECT (preexisting, prohibited). No TEST_EXPECTATION_DEFECT or TEST_SYNCHRONIZATION_DEFECT explains the product behavior; the historical immediate assertion could pass before actual passive mounting.

The two full-spec normal-order runs before repair passed 4/4 immediate assertions. Both specs delete their persistent profile before launch and own/close a distinct context. The fixed matrices likewise clear profiles; fixed synthetic IDs do not share Chrome storage across cases. Cross-test persistent view contamination is not required for reproduction. Two external worker-contamination attempts expired before usable lifecycle proof and are not claimed as completed restart qualification.

The narrow repair makes `createWidget` register a detached document-local workflow facade. It may attach to an already-open overlay; it cannot create a host/controller/subscription. Explicit SHOW mounts the assistant and attaches that document's retained facade, including after Close. Passive updates continue on the detached facade. No worker/session/tab storage is cleared, no toolbar intent is replayed, and no new permission or opening trigger is added. Canonical keyboard propagation containment moves into the mounted assistant's lifecycle; facade keyboard containment and pointer interaction behavior remain. Focused regressions cover passive startup, events, Close/update/reopen, and document isolation. Visible-widget tests now explicitly open UI in setup. The browser acceptance retains its immediate zero-host check and adds a second zero-host check after authoritative workflow completion, so later passive mounting is detected.

Validation so far: extension typecheck/production build and 84 files / 1300 unit tests pass; focused lifecycle/authority/recovery/manifest 7 files / 119 tests pass; development build and Compose configuration pass. One external negative-control bundle deliberately reinstates passive widget mounting and fails the zero-host assertion (expected 0, observed 1). The mutation is absent from repository source and positive-run bundles. The first repaired stress batch was 28/30 pass, with 2 failures before Close/reload because the external setup clicked Fill before workflow initialization completed. Its record is retained. A corrected fixed batch waits for external startup acknowledgment before explicit Fill, without increasing timeouts, retrying, or adding sleeps.

Evidence: `/tmp/xpertapply-e4od-r9-evidence`. Final stress, passive events, OPEN/MINIMIZED reload, physical all-frame restart, security/API/Web/build checks, three full-overlay repetitions, and the single full Playwright result are pending. No checkpoint is authorized by these intermediate results. Rollout remains deferred. Rollback must reverse only R9's detached-facade, keyboard containment, regression/setup, browser assertion and plan additions, preserving all preexisting E4O-D changes; do not reset these paths to HEAD. Popup and Side Panel fallbacks remain packaged. No staging, commit, push, deployment, Store action, production access, permission/host expansion, auth weakening or final-submit automation.

### R9 final validation and blocked disposition

**BLOCKED — NEW PLAYWRIGHT FAILURE.** The original reload failure is classified as PRODUCT_AUTO_OPEN_DEFECT, reproduced in fresh documents on both current and 738523e baseline, and repaired by the detached-facade authority boundary. It is not an allowed baseline behavior, expectation defect, or synchronization excuse. Explicit OPEN/CLOSED/MINIMIZED full-navigation semantics remain ABSENT until another toolbar action; same-document Minimize/Close remain distinct. No observed repaired lifecycle case passively creates a host; explicit SHOW reattaches the facade and opens one controller. The final browser assertion synchronizes on the new document's private facade registration, without reading stale tab state or requiring unrelated autofill.

The reduced external diagnostic has a 60-second whole-test deadline; the canonical acceptance's existing 360-second deadline remains unchanged. Those reduced probes are not claimed as fully equivalent normal-timeout qualification. Fixed original current/baseline matrices each attempted 20 cases with one worker and retries 0: current 18 actual auto-open proofs + 2 failures before measurement; baseline 17 proofs + 3 before measurement. All attempted cases failed; missing lifecycle facts are explicitly absent in the twenty-row evidence files. Diagnostic construction/readiness limits are retained, not hidden or used to classify missing facts.

Repaired stress: the first extended probe was 28/30 with two failures before Close/reload while waiting for explicit Fill; the startup-ack variant was 26/30 with four pre-reload setup failures. The narrowly scoped Close→reload→settle→explicit reopen batch was 28/30; two 60-second timeouts occurred while resolving the fixture tab before lifecycle measurement. Every measured case had zero passive hosts and one explicit reopening. Required 30/30 qualification is NOT achieved. OPEN→reload 2/2, MINIMIZED→reload 2/2, and empty-path fresh-profile 2/2 pass. Passive event bursts include 20 focus/pageshow/visibility events, activation/reconnect/view-invalidations/CONTENT_READY, and a physical worker Stop/restart: 1/2 passed with no passive reopen and successful explicit reopen; the other could not observe STOPPED. Its physical-stop result is not claimed as qualified.

The full repaired overlay spec passes three repetitions (6/6 tests), covering prepared handoff, discovery, zero pre-Fill mutations, explicit Fill, consent, final-submit zero, UX/accessibility/viewport/zoom, physical restart and 60-second zero idle polling. Separate all-frame acceptance passes 1/1, including five physical native Stop/restart cycles, trusted child Fill, rejection/isolation and zero idle polling. Focused unit 119/119; full extension 1300/1300, typecheck and production/development builds pass. Focused security 180/180. API 2120/2120 using the existing complete test environment. The default API interpreter and an incomplete existing environment initially failed dependency checks/collection; no dependency installation or API source repair occurred. Web confirmation passes 970/970, lint/typecheck/build pass. The first Web run had all assertions pass plus two unhandled React teardown exceptions (`window is not defined`); privacy isolation 2/2 and the full confirmation have zero unhandled errors. Web source remains unchanged. Browser harness strict typecheck, Compose validation and diff check pass. No relevant migration source change; no database migration execution was needed.

The single repository-wide Playwright run uses freshly built uninstrumented bundles, one worker, retries 0 and unchanged release timeouts: **140 passed / 7 failed / 16 skipped / 163 total**. Six failures match established debt. The prior Stage 3C-3 grant result case passes in this run; it is not removed from historical debt solely on that observation. The seventh current failure is NEW/UNKNOWN: canonical overlay's physical-stop assertion, before Fill/reload, expects `stopped` but Chrome stays `stopping` through the unchanged 5000ms semantic poll. The canonical reload assertions are therefore not reached in that full-suite case. Three isolated passes do not erase it; no favorable-result full-suite rerun occurs. The new STOPPING cause remains unclassified, separate from the original reload defect and historical seed/context incidents.

Resource audit: full run 143 created contexts / 143 close events / 140 wrapper completions; three legacy timeout wrapper-marker gaps have no surviving owned process or profile lock. Reporter global errors 0; context-close errors 0; owned survivors 0; fixture-port leaks 0; profile locks 0; final local Web port 3000 empty. All-frame acceptance likewise has zero survivors/locks/fixture leaks. Temporary baseline dependency links were removed; detached baseline verified clean at exact 738523e before normal worktree removal. The forced passive-mount negative bundle was removed after retaining its effective failure and trace. Production/development/e2e shipping artifacts contain no external trace/startup marker or negative mutation.

R9 changes seven repository files: two runtime files (applicationOverlayAssistant.ts, widget.ts), the canonical browser assertion, overlay_bootstrap.test.ts, visible-widget test setup in widget.test.ts and samsara_ledger.test.ts, and this plan. Final union: 21 unstaged paths (18 tracked modified, 3 untracked), empty index, HEAD/upstream unchanged with 0 ahead/behind. Every final diff hunk is classified; UNEXPECTED 0. The 643-file inventory has two intentional runtime deltas, three focused test deltas, and five ignored API synthetic document outputs regenerated by the required API tests; no unexpected runtime/source drift. Historical auth-evolution/store-release/prod-auth worktrees and both canonical protected design-system states remain byte/status unchanged. Manifest permissions remain activeTab/sidePanel/storage/scripting/tabs; webNavigation absent; no host or optional-permission expansion.

Incident categories remain separate: PREEXISTING_DETERMINISTIC (seven historical cases, six reproduced now); HISTORICAL_UNREPRODUCED_INCIDENT (older context/teardown); TEST_SYNCHRONIZATION_DEFECT_RESOLVED (R6 actuator); ACTUATOR_SAFETY_COVERAGE_GAP_RESOLVED (R7 consent/submission); HISTORICAL_UNREPRODUCED_CURRENT_INCIDENT (R7 seed dispositioned in R8); RELOAD_NO_AUTO_OPEN (PRODUCT_AUTO_OPEN_DEFECT repaired candidate). Additionally retain NEW_FULL_SUITE_FAILURE_UNCLASSIFIED (physical Stop stuck STOPPING) and unqualified external setup/readiness observations. Do not merge them or infer root causes.

Rollout/checkpoint remains blocked. Next scope: disposition the retained physical STOPPING failure and complete faithful 30/30 closed-reload qualification; preserve this narrow no-auto-open repair and all preexisting E4O-D work. Rollback reverses only R9 additions, never resets these paths to HEAD. No staging, commit, push, deployment, Store action, production access, fallback removal, auto-open addition, permission/host expansion, auth weakening, timeout/retry inflation, arbitrary sleep workaround or final-submit automation. Evidence and complete 65-field report: `/tmp/xpertapply-e4od-r9-evidence`.

Final generated-artifact restoration: the post-browser normal Web production build passes and restores next-env.d.ts to its R9 initial hash. Two Next dev-generated boilerplate files (apps/web/AGENTS.md and CLAUDE.md), absent initially, were retained under external evidence and removed from the release worktree. No Web product source changed; final union remains 21 paths.

## E4O-D-R10 — physical-worker/reload qualification (2026-10-04)

R10 starts at feature/assistant-window, HEAD/upstream
738523e56bed89cbccad5d24afa5e12266927351, 0 ahead/behind, 21 unstaged unique
paths, empty index and passing diff check. Evidence is retained under
`/tmp/xpertapply-e4od-r10-evidence`. The R9 evidence directory and report are
absent on this host. Only facts retained above in this plan are historical
evidence; original stop timestamps, registration/target IDs, messaging/evaluate
results, exact setup call stacks, profile identities and per-incident cleanup
cannot be reconstructed. R9's final full-suite record here is six historical
failures plus one NEW STOPPING failure, rather than seven reproduced historical
failures. The seven-case historical debt list remains separate.

Physical-stop call graph: canonical overlay test after idle/view-latency checks
and its invalid-session recovery section, plus recovery spec stopAndWake,
open internals -> filter exact extension registration -> require one -> click
native Stop -> poll innerText lowercased for literal stopped (5000ms default)
-> close internals -> dispatch focus -> evaluate available worker -> measure
re-registration/UI. The original success gate depends on literal STOPPED: YES.
Worker availability uses reusable Playwright wrappers and does not itself prove
a new lifetime. Local Playwright CRServiceWorker handles Inspector.targetCrashed
by destroyExecutionContext('Service worker restarted'), then accepts a new
Runtime.executionContextCreated on the same wrapper/session.

Semantic contract: a native Stop must physically remove the old execution
context from service, independently observed by disappearance from CDP target
listing; a legitimate event must produce a fresh context (increased
performance.timeOrigin and absence of an old worker-local marker), then surviving
qualified top/child documents must independently CONTENT_READY/re-register.
Neither a clicked button, a label, nor a reusable Worker object's identity is
sufficient alone. No mocked restart is substituted.

The isolated complete 20-row matrix uses local Chromium 149.0.7827.55 and the
existing five-second stop observation deadline. It observes STOPPED 20/20,
STOPPING 0/20 (transitions before observation may be missed), target-list absence
20/20 and fresh context generation 20/20. Wrapper identity and target ID are
reused on wake; close events occur during final context cleanup, not physical
Stop. Old evaluate rejects within the observation window in 5/20 and remains
pending in 15/20; pending operations may evaluate the fresh context after wake,
so an old handle's successful evaluation is not old-context survival proof.
Per-stop registration recovery was not measured in this minimal matrix. A
separate closed-overlay top/child recovery probe verifies increased registration
counts in both frames, new time origin, vanished local marker, absent UI and
successful explicit reopen. The 20 runs do not reproduce R9's persistent
STOPPING or prove what was happening underneath its historical label.

Worker-stop classification remains UNKNOWN. No product worker-lifetime defect
is proven and no keepalive source is established. Static inspection of detached
facade, notification subscription and bounded recovery coordinator finds no
Port, offscreen document or persistent polling introduced by R9. No worker-stop
harness repair is made while classification is unresolved. R9 runtime hashes
are captured at R10 entry and preserved; historical R9 hash evidence is absent.

R9 setup evidence retained above identifies the two narrow close/reload failures
as fixture-tab resolution before lifecycle measurement, under an external
60-second whole-probe deadline. Exact API operation and underlying profile/PID
records are unavailable. Prospective C0-C13 records cover launch, worker
acquisition, fixture readiness, seed, navigation, explicit open, close, reload,
settled absence, explicit reopen and finally cleanup. Each current trial owns a
fresh profile/context/server, records worker URL/time origin and tab identity,
and retains error/timeout stage. Owned browser OS PID was not instrumented.
Current exploration is 50/50; the distinct formal release batch is 30/30. Both
use the existing external 60-second deadline, normal assertion timeouts and
zero retries. No failed fixed iteration is skipped. Exact R9 external harness
and normal-profile comparison are unavailable. Historical setup classification
remains UNKNOWN until the required final browser/no-leak/no-lifecycle gates
complete; successful current stress alone does not satisfy the finite gate.

Separate closed-overlay passive matrix passes focus, visibilitychange, pageshow,
tab activation, CONTENT_READY/reconnect, authoritative view invalidation and
native physical Stop/recovery. Top/child recovery passes, closed UI remains
absent, settled reload remains absent and explicit SHOW restores one host.
OPEN/MINIMIZED/CLOSED reload semantics remain those specified in R9: a fresh
document stays ABSENT until explicit toolbar SHOW. No runtime source changes.

Validation in progress: full Extension 84 files/1300 tests passes with typecheck
and production build; full Web 51 files/970 tests passes with lint/typecheck/
production build; focused lifecycle/authority selection 7 files/80 tests passes;
selected security/authority 12 files/171 tests passes. The exact prior 180-test
selection command is absent; this selection is not represented as that matrix.
Browser harness typecheck passes using TypeScript 6 --ignoreConfig and existing
Web Node type roots. Development build, Compose config and diff check pass.
API source is unchanged; R9's recorded 2120 pass is carried forward per request,
without a migration change. Three overlay repetitions, all-frame acceptance,
final single full-suite execution and resource audit are pending.

Diagnostic construction errors are retained separately: premature wrapper-based
wake expectations, an incorrect exact Close accessible name, and two construction
processes continuing after SIGTERM and overwriting shared JSON. Exact processes
were terminated and the 20-stop record reconstructed in an isolated directory.
These construction attempts are not qualification passes. No full-suite run has
been rerun for a favorable result. No production action, staging, commit, push,
deployment or Store mutation. Popup and Side Panel remain packaged; permissions,
hosts, auth and user-submit boundaries remain unchanged. Rollout/checkpoint is
deferred while stop classification is UNKNOWN. Rollback of R10 only removes this
plan section and external diagnostics; preserve every preexisting R9 diff.

### R10 final disposition

**BLOCKED — NEW PLAYWRIGHT FAILURE.** The three complete overlay repetitions
pass 6/6 with zero reporter errors. Separate all-frame acceptance passes 1/1
with five open-overlay physical restarts, child Fill/consent/submit-zero and
60-second zero idle polling. Independent OPEN and MINIMIZED reload probes pass
1/1 each after settled facade creation, then explicit reopen. A second native
Stop sequence measures top/child registration recovery on all 20 cycles, with
new time origins/absent old markers and closed host counts 0 throughout; each
observed stop sample is STOPPED. Literal persistent STOPPING remains unreproduced
and historically unexplainable with the missing R9 target/context trace. Its
classification remains UNKNOWN; no repository harness or runtime repair.

The single final full-suite attempt completes 111 passed /
12 failed / 40 skipped / 163 total, reporter global
errors 0. It is INVALID for release qualification: R10's command set
XA_E2E_SKIP_BUILD=1 without also setting XA_E2E_DIST. The early return bypasses
globalSetup's granted-bundle assignment; specs with a production-dist fallback
therefore ran with incorrect fixture permission setup. This is an R10 command
configuration defect, not proof of product regression. Additional closed-browser
and assertion failures remain currently unclassified. Exact twelve failures,
errors and traces are retained in full-playwright.json/full-failures.json. No
favorable-result rerun occurs. The seven historical cases remain separate; this
attempt does not establish the required exact historical failure set. R9 setup
incidents remain UNKNOWN because the complete finite gate is not satisfied,
despite the fixed prospective 50/50 and separate formal 30/30 passing.

Full-suite/generated-artifact cleanup retains Next dev-created AGENTS.md and
CLAUDE.md externally and removes them from the worktree because absent at entry.
next-env.d.ts is restored to its clean entry/HEAD content; no Web source repair.
Owned local Web PIDs are stopped. Final runtime/harness/lifecycle hashes match
R10 entry; final unique path set returns to 21 with an empty index. R10 repository
change is only this living-plan section. Final report is
/tmp/xpertapply-e4od-r10-evidence/R10-report.md. Exact per-context OS-PID creation
accounting was not instrumented; completed-context/final-process observations
must not be represented as the absent R9-style complete resource journal.

Next scope requires a correctly configured fresh final browser qualification
authorized in a later stage, plus disposition of the persistent STOPPING
evidence/semantic gate. This stage does not checkpoint, stage, commit, push,
deploy or touch the Store. Rollback removes only R10 plan additions and external
diagnostics, preserving all R9 runtime and inherited E4O-D work.

## E4O-D-R11 — final prospective qualification (2026-10-04)

R11 preserves the 21-path unstaged E4O-D worktree at feature/assistant-window,
HEAD/upstream 738523e56bed89cbccad5d24afa5e12266927351, 0 ahead/behind,
empty index and passing diff check. No product/runtime change is planned.
Evidence: `/tmp/xpertapply-e4od-r11-evidence`.

Release policy is prospective: accepted R10 50/50 exploration, separate 30/30
formal closed/reload batch, passive matrix, 20-cycle semantic physical recovery,
all-frame and overlay repetitions remain qualified and are not repeated. Missing
R9 raw evidence does not independently block release. The invalid R10 full-suite
execution is a command-configuration incident and is not product-failure evidence.
Historical context/teardown, R7 seed, R9 setup and STOPPING observations remain
documented separately and only a prospective recurrence can independently block.

Bundle contract: normal `npm run test:e2e` invokes playwright.config.ts's
globalSetup. It builds e2e/bundle/harness.js, builds dist-e2e-granted with loopback
fixture grants, then assigns XA_E2E_DIST to the absolute granted bundle path.
The skip-build early return is unsafe without a separately established assignment;
R11 unsets both inherited XA_E2E_SKIP_BUILD and XA_E2E_DIST and runs normal setup.
No manual production-dist substitution. An external observer reporter prints and
records the effective path before test execution; no production bundle hook.
Effective path is `/Users/cprakash/Developer/XpertApply-assistant-window/apps/extension/dist-e2e-granted`.

Tiny smoke passes 2/2: real content-script Apply and session logout/purge. Both
retained successful launch traces include that exact --load-extension path.
Normal setup proof says correct=true, skipBuild=null, one worker. This is bundle
configuration evidence, not disposition of historical debt.

Fresh unit/static results: Extension 84 files/1300 tests passes with typecheck and
production build; Web 51 files/970 tests passes with lint/typecheck/build. Current
security/authority selection covers overlay sender/tab/document authority, frame
coordination/trust, run/session fencing, external messaging, private fill, site
permission handling, answer integrity and final-submit/consent safety: 14 files /
263 tests / zero failures. Exact command is retained in the final report.
Development build, strict browser harness typecheck, Compose and diff check pass.
Source/production/development manifests preserve exactly activeTab, sidePanel,
storage, scripting, tabs; no webNavigation, host expansion or version change.

One current semantic physical Stop/recovery probe passes: CDP running context
disappears; legitimate wake creates new timeOrigin with no old local marker;
top/child registration counters advance and accept; closed overlay stays absent;
explicit SHOW reopens. A single complete overlay spec and actuator-safety sanity
are in progress, followed by exactly one correctly configured full suite with
one worker, retries 0 and unchanged deadlines. No historical stress reruns.

Review confirms passive createWidget retains only a detached workflow facade;
the trusted explicit SHOW receiver owns mounting. Recovery/content registration
does not replay SHOW; affected-tab invalidations fetch worker authority; no
one-second polling, auto-submit, consent automation or new privilege. Existing
test-only metrics remain in e2e/test sources, not shipping runtime. Popup and Side
Panel fallbacks are retained. Historical worktrees remain read-only/clean and
canonical protected design-system state is unchanged. No staging, commit, push,
deployment, production access or Store mutation. Rollout remains deferred until
the final prospective gate; rollback removes only R11 plan additions/external
evidence and preserves all inherited runtime repairs.

### R11 final disposition — 2026-10-04

Correct granted-bundle full run executed exactly once: 141 passed, 6 failed, 16 skipped, 163 total; zero global errors, retries 0, one worker, normal timeouts. Five failures are established obsolete widget selectors. Stage 3C-3 passed. Account replacement passed trusted external teardown, forged-ACK rejection, purge and replacement-token activation, but newly failed its final staged-handoff session assertion (expected 2202, received null). This differs from the historical missing EXTERNAL_SESSION_END failure; it is not silently waived as baseline debt. Trace/source investigation confirms valid payload and no launch API request; dashboard summary 404 is unrelated fixture traffic. The precise post-login bridge/staging cause remains unproven. Verdict: BLOCKED — NEW PLAYWRIGHT FAILURE. No full-suite rerun, no historical-debt repairs, and no runtime source changes in R11.

All other gates passed: bundle smoke 2/2; overlay/actuator sanity 3/3; one native semantic worker recovery; extension 1300/1300; Web 970/970; security 263/263; production/development builds, static checks, manifest, compose and diff check. R10 prospective matrices remain accepted; missing R9 artifacts are not an independent blocker.

Evidence and mandatory 49-field report: /tmp/xpertapply-e4od-r11-evidence/R11-report.md; seven-case preparation: baseline-debt-disposition.md. Next work is limited investigation of the changed account-replacement mechanism; checkpoint staging/commit/push remains deferred. Rollout/deployment/Store operations were not performed. Rollback remains the existing explicit-overlay lifecycle and retained popup/Side Panel fallback strategy; no rollback needed because R11 changed only this plan.

## E4O-D-R12 — account replacement / handoff diagnosis (2026-10-04)

Scope: diagnose R11 XA-12 staged-handoff null, retain account isolation and trusted ACK fencing; no unrelated overlay/recovery, permission, fallback or submission changes. No staging/commit/push/deployment/Store operations.

Classification before repair: TEST_FIXTURE_OWNERSHIP_DEFECT, specifically fixture origin mismatch. R11 trace used localhost:3001; external teardown accepts 3001 but the development/E2E page handoff bridge accepts localhost:3000 and 127.0.0.1:3000 only. Therefore trusted ACK and token activation succeed while STAGE_LAUNCH is never forwarded and no write occurs. The current activeAssistedApplyHandoffV1 expectation is valid: 2202 denotes the synthetic prepared application for user 702; it is not a Web authentication session. Staging metadata is not a private authenticated package; actual package adoption crosses token exchange and runtime account checks.

Repair architecture: test-only supported fixture origin guard; production login destination and native bridge-readiness synchronization; sanitized timeline and structural purge snapshots; replayed old-token negative control versus replacement-user private-package positive control; two stale old-document references; A→B→A-new-session and independent current handoff browser controls. Runtime remains untouched.

Progress: original current scenario 20/20 PASS on port3000. Observer configuration error produced 41 reporter-only errors; retained explicitly and not claimed a zero-global-error qualification. Detached HEAD baseline at 738523e passed3/3 with isolated dependencies; two earlier setup attempts invalid because Turbopack rejects escaping node_modules symlinks. Historical missing SESSION_END did not recur. First complete handoff control smoke passed, old-token denied/new package adopted/no submissions. An early partial stress batch was interrupted to add required controls and is not counted as a complete qualification.

Validation pending: complete control set, final30 replacement runs, focused units/security, full extension/Web, static/build/manifest/compose gates, exactly one full correctly configured Playwright run after XA12 resolution. API sources unchanged: carry forward2120 PASS. Evidence root /tmp/xpertapply-e4od-r12-evidence. Rollout remains deferred; rollback of R12 is reverting only its XA12 test/plan changes while preserving all preexisting release diffs.

### R12 final qualification disposition

PASS — ACCOUNT REPLACEMENT/HANDOFF QUALIFIED; E4O-D READY FOR FINAL LEGACY-TEST MIGRATION. Classified fixture-origin defect repaired in the XA12 test only; no runtime/auth/API changes. Complete replacement30/30, direct handoff/A→B→A/logout control set4/4, focused security189/189 and Web auth/handoff38/38, full Extension1300/1300 and Web970/970, strict browser harness/static/manifest/compose/diff checks PASS. API2120 carried forward under the explicit unchanged-source rule.

One full correctly granted-bundle run:143 passed,6 failed,16 skipped,165 total, zero global errors, retries0/one worker/normal timeouts. All XA12 cases and Stage3C-3 pass. Five failures still target the retired widget before their semantics assertions. The additional first-party presence-test failure was ERR_CONNECTION_REFUSED because the required localhost3000 Web server was not running; this orchestration error is acknowledged, retained and not attributed to product code. The exact presence test passed1/1 with its owned Web prerequisite, subsequently closed. No full-suite rerun was performed; full result is not described as green or baseline-debt-only. Per R12 phaseAH, differing failure set is reported explicitly; no unresolved product/new unknown failure remains after targeted diagnosis.

R12 repository changes: XA12 spec and this plan only; other release diff/runtime hashes preserved. Evidence/65-field report: /tmp/xpertapply-e4od-r12-evidence/R12-report.md. Temporary detached baseline removed after retention; generated Next boilerplate restored to entry; final index empty. No staging/commit/push/deployment/Store mutation.

NEXT: EXTENSION RELEASE STAGE E4O-D-R13 — MIGRATE/RETIRE THE FIVE OBSOLETE WIDGET PLAYWRIGHT TESTS TO THE CANONICAL IN-PAGE OVERLAY. Include a compatible owned first-party Web fixture prerequisite in future suite orchestration; it must release port3000 before XA12 owns that supported origin. This is an environment prerequisite, not an auth/permission expansion. Rollout remains deferred, popup/Side Panel fallbacks retained, and R12 rollback remains test/plan-only.


## E4O-D-R13 — canonical browser migration (in progress)

Runtime remains frozen. R12 report reviewed: XA12 is repaired and outside the five legacy migrations. Inventory: application-answer uses WidgetDriver action cards and hidden legacy totals; XA09 waits for automatic old-host attachment/message; XA10 waits for autofill and legacy Clear; XA11 reads hidden legacy summary and AX review statuses; XA16/XA19 uses old box/body/footer geometry, completion keyboarding and density stress. All assertions require semantic migration; none retired.

First migration: XA09 opens through the existing e4oc native worker scripting + trusted SHOW path. New test-only canonical driver asserts no passive UI and exact employer-tab launch. The refusal scenario retains 5000 controls, the 1000-budget storage code, zero input/submit, and adds employer-form mutation and submit-click counters. Current canonical terminal status/error/disabled Fill replace obsolete legacy wording. Qualification pending. Rollback: restore only R13 test/plan hunks; no runtime change or publication authorized.

### R13 STOP — current product defect

Migrated XA09 native-toolbar browser diagnostic proves stored APPLICATION_FORM_TOO_LARGE, 1860 ms refusal, no filled controls and zero input/submit/submit-click/form-mutation events. Canonical error is generic preparation failure and omits the original 1000-control safe-limit explanation; production UI lacks this failure mapping. Final targeted result 0/1 PASS, zero skips. Initial two executions failed earlier at hidden errors; diagnostic synchronization now awaits stored failure before visible error, and preserves safe-limit assertion. Per user Phase K/AA, stop migration and qualification; do not rewrite away invariant or alter runtime. No full R13 suite, negative controls, stress qualification or remaining migrations performed. Runtime tracked entry hashes unchanged. Report/evidence: /tmp/xpertapply-e4od-r13-evidence/R13-report.md. Checkpoint blocked.

## E4O-D-R14 — safe-limit presentation repair

R13 proved the 5000-control refusal and zero employer mutations/submissions; only canonical explanation was missing. Trace: ats/formRoot.ts resolveApplicationRoot budget refusal -> content/bootstrap.ts AUTOFILL_FAILED -> background.ts validated sender handler/failPending patchView -> session viewStates.failureCode -> shared applicationAssistant render FAILURE_LABEL -> textContent. APPLICATION_FORM_TOO_LARGE was missing; generic fallback handled it. Existing state subscriptions refresh on later authoritative code; R13 observed the generic error appear, proving refresh. No synchronization runtime repair justified. Other safety/discovery codes can also use generic fallback (e.g. APPLICATION_FORM_AMBIGUOUS); no broadened repair without evidence.

Add one explicit trusted-code copy mapping: deliberate safe limit of 1,000 form fields, nothing filled, manual completion. Add delayed-code subscription and unknown fallback/safe-text unit regressions; retain existing SESSION_UNAUTHORIZED copy check. Browser assertion accepts formatted 1,000 and confirms nothing filled. Remove R13 proposed disabled-Fill assertion: authoritative failureRecoverable is true and existing policy permits retry; disabling actions was not the original budget invariant and would broaden product behavior. No budget, Fill, sender, lifecycle, permission or authentication change. Validation pending. Rollback: revert R14 mapping/test/plan hunks only; no deployment or publishing in this stage.

### R14 qualification evidence — presentation repaired, state gate unresolved

Focused semantic/safety: 11 files/247 tests PASS. Full Extension: 84 files/1302 tests PASS, including typecheck/production build. Full Web: 51 files/970 tests PASS, fresh lint/typecheck/build. Negative mapping control: safe-limit test fails with mapping removed; exact bytes restored in finally. Independent granted-bundle XA09: 1/1 PASS, refusal 1550 ms, all employer mutation/submission counters zero. Initial 10-run diagnostic: 4 PASS/6 FAIL (one-shot authoritative storage read). After replacing that snapshot race with normal-timeout expect.poll on authoritative failureCode: 6 PASS/4 FAIL, zero retries/skips. Failed runs still have terminal state failed with null failureCode at the normal assertion deadline; this is not proven to be a simple delayed UI refresh. No timeout increase, added sleep, product polling, or extra favorable stress loop. Mapping only cannot satisfy required 10/10. Preserve failed logs/traces under /tmp/xpertapply-e4od-r14-evidence. UI subscription delayed-code unit passes; state persistence failure requires further diagnosis before any broader background/authority change. No underlying budget or mutation defect demonstrated. Browser helper unchanged; current toolbar injects production bootstrap/content exactly as native toolbarOverlay.ts does.

The R13 proposed disabled Fill assertion was removed only because existing authoritative failureRecoverable=true and action policy is unchanged; required safe-limit/no-fill/no-mutation/submit assertions remain. The safe-limit mapping is explicit textContent and preserves known SESSION_UNAUTHORIZED plus unknown generic fallback. Other legacy migrations remain untouched. Rollout blocked until state qualification reaches 10/10; rollback the single copy mapping and R14 test/plan hunks only.

R14 final: BLOCKED — STATE-SYNCHRONIZATION DEFECT. Canonical browser regression1/1PASS; strict required six-file harness typecheckPASS; fresh extension prod/dev and Web lint/typecheck/buildPASS; manifest/compose/diffcheckPASS. Runtime delta exactly one presentation-map entry. Final24paths/indexempty; historical worktrees clean and canonical protectedplan unchanged. No owned ChromeTesting processes left. Mandatory59-field report: /tmp/xpertapply-e4od-r14-evidence/R14-report.md. Next step diagnoses authoritative null-code failure before10/10 or R13B; do not stage/commit/push.

### R14 continuation — exact missing-code origin

Read-only discoverForToolbar resolves an oversized form but discards resolved.reason; empty fields produce failed AUTOFILL_PROGRESS only. Prior content instance can sometimes emit AUTOFILL_FAILED before toolbar reinjection claims ownership, accounting for intermittent presence; replacement toolbar instance does not emit the code itself. Temporary buffered/live diagnostic6casesPASS confirms prior-instance failure followed by toolbar failed progress; source analysis proves missing branch, not a generic renderer refresh defect. Narrow repair: after trusted progress publication, when existing resolved.reason is APPLICATION_FORM_TOO_LARGE, await existing AUTOFILL_FAILED with that code. No budget calculation, scope, fill, auth, listener or recovery change. Temporary diagnostics restored byte-exact; next validation includes explicit-toolbar-first fixture so no prior instance can supply refusal.

### R14 corrected qualification

Toolbar-only fixture now stages after page navigation, so no earlier automatic workflow can mask a missing toolbar code. Removing the propagation branch causes the exact browser scenario to fail; restore verified byte-identical. Independent repaired case1/1PASS. Post-repair batch concurrently with full checks:7PASS/3FAIL, all three failures only elapsed<10000 (30967/13315/17040ms), authoritative code and zero employer counters present; retain evidence. Running timing-sensitive qualification after builds/units complete, same source/assertions/timeouts/retries:10/10PASS, 601–1732ms, zero filled inputs/input/form mutations/submit clicks/submit events. Resource-contention explanation is an inference from the changed scheduling and retained timing failures, not a claim the failed executions passed. No threshold/timeouts/retries changed; no30/50run qualification loop.

Fresh fullExtension84files1302testsPASS, fullWeb51files970testsPASS, focused11files247testsPASS, six-file strict harness typecheckPASS, fresh extensionprod/dev andWeblint/typecheck/buildPASS; source/prod/dev manifests0.2.0/exactpermissions unchanged; compose/diffcheckPASS. Prior negative mapping unit evidence remains valid with unchanged UI mapping/test and fresh passing suite; added deterministic browser negative verifies state propagation. Runtime delta only bootstrap.ts failure metadata publication and applicationAssistant.ts copy mapping. Original R14 blocked evidence retained; final report will supersede status after canonical overlay regression. Other migrations untouched.

R14 final superseding status: PASS — SAFE-LIMIT EXPLANATION REPAIRED; READY TO RESUME LEGACY MIGRATION. Fresh canonical overlay1/1PASS; final qualifiedXA09 10/10PASS and all employer mutation/submit counters0; historical worktrees clean, protectedplanSHA unchanged, final24paths/indexempty, no owned TestingChrome processes. Mandatory59-field final report: /tmp/xpertapply-e4od-r14-continuation/R14-report.md. NEXT: EXTENSION RELEASE STAGE E4O-D-R13B — RESUME MIGRATION OF application-answer, XA10, XA11, AND XA16/XA19, THEN FINAL PLAYWRIGHT RELEASE GATE. No stage/commit/push/publication.

## E4O-D-R13B — final four browser migrations

Entry24paths/emptyindex, HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351/divergence0/0; runtime hashes captured. Driver reviewed: same native toolbarBootstrap/content/SHOW as production path; no direct mount. Inventory: application-answer legacy host via WidgetDriver, detached-root CDP and hidden summary; XA10 auto-filled controls + old Clear/message; XA11 old-host observer/summary and confirmation count; XA16/XA19 old box/body/footer geometry, zoom/live semantics, key traversal,500carddensity, forcedcolors/reducedmotion, idlemutations, required-review confirmation, completionfailure/manualsubmit. All unique safety assertions must migrate; none retired yet. Application migration uses one extended canonical driver, current nested answer/review facade via fresh CDP root, canonical visible counters vs worker authoritative state. Internal ledger used explicitly only for optional-defer invariant, not labelled visible. ExplicitSHOW/discovery/Fill before review; original legal/consent/override/targetedresolver/control verification retained. Qualification pending. Rollback restores R13B test/plan hunks only; qualifiedR14runtime frozen.

### R13B STOP — current canonical count coherence defect

Migrated application-answer core1/1PASS; saved-answer rerender1/1PASS after removing an unnecessary new terminal-stage prerequisite and retaining original4500ms fixture settling interval. Complete migrated answer run:11PASS/1FAIL/5not-run,17total. Failure: canonical count-coherence test reports discovered0 despite completed saved-answer application. Exact targeted diagnostic:0PASS/1FAIL/0skip; normal5s expect.poll still0. Retained evidence shows visible Detecting application / discovered0 / filled0 / review0; current workflow ledger Discovered9/Filled2/Requiredverified2; actual employer authYes/backingtrue/sponsorNo/sourceCompanywebsite, consentfalse/submittedfalse. Earlier full run worker view alsofieldsDiscovered0. This is a demonstrated canonical/workflow coherence product defect, not oldhost debt. Under user PhaseAF stop immediately; no runtime repair, assertion retirement, timeout/retry increase, or full-release rerun.

Partial migrations retained for review: application17cases currentnativeSHOW/discovery/explicitFill; XA10 exact choice snapshots incl checkbox/consent and canonicalClear/events; XA11 canonicalvisible review vs worker/AXreview status; XA16productionJS/viewport/zoom/density/keyboard/forcedcolors/idle/completionrejection/manualsubmit semantic port. XA16 obsolete styling/region labels map to current named complementary assistant, polite status and manual-submit warning; inline canonicalactions must be scroll-reachable rather than obsolete fixedfooter geometry. No assertions retired as exact duplicates; remaining equivalence mapping requires qualification. Web bridge spec now owns loopback3000HTTP fixture, explicitbind/readiness/error/finally cleanup, no reuse/kill/fallback; NOT RUN/qualified because stop. Current helper single driver, no second driver or productionAPIs. Other migrations/3runs/negativecontrols/firstparty/XA09/XA12/Stage3C/recovery/fullunits/build/finalPlaywright NOT QUALIFIED inR13B. No negativecontrol introduced; temporary diagnostic console removed, logs/traces remain /tmp/xpertapply-e4od-r13b-evidence. Runtime frozen to qualifiedR14 entry hashes. Checkpoint NOT ready. Next must be separately authorized narrow canonical/workflow coherence fix, then resume R13B; no speculative extra stage ifR13B eventuallypasses.


## E4O-D-R15 — count repair verified; release qualification blocked

Scope: narrow count/stage product repair; no staging, commit, push, deployment,
Store mutation, migration completion, polling, or final repository Playwright run.
Entry: feature/assistant-window, HEAD/upstream 738523e56bed89cbccad5d24afa5e12266927351,
0/0 divergence, empty index, 28 changed paths; diff check passed.

The exact R13B scenario reproduced: current question ledger 9 discovered / 2
verified fills, correct synthetic authorization and sponsorship employer controls,
untouched consent/no submission, worker and canonical overlay 0/0 Detecting.
Primary classification: **STALE_OVERWRITE**. Structural evidence under
`/tmp/xpertapply-e4od-r15-evidence/reproduce.log` shows nonzero discovery at +873ms,
completed result at +2119ms, committed worker completed state at +2130ms,
then mutation-observer `emitProgressOnly()` at +2328ms publishing hardcoded
zero/detecting and worker overwrite at +2337ms. Fresh canonical view requests
followed each invalidation. The failure is before the adapter/renderer, not a
missing event or rejected generation. Background storage change callbacks run
only after the authoritative storage mutation; equal-timestamp listener output
is registration ordering, not invalidation-before-write.

Ownership/call graph: explicit toolbar SHOW mounts one top-document canonical
controller; explicit Fill routes through registered workflow authority and the
selected application-frame lease to discoverAndFill -> resolveAndApply and scalar
runAutofill -> absorbScalarLedger -> final live verification -> questionLedger.
QuestionLedger is the semantic count authority. Progress/result enter the worker
through validated runtime sender/frame/session/generation authority -> applyProgress
-> serialized patchView in session storage -> storage.onChanged -> payload-free
OVERLAY_VIEW_CHANGED -> trusted top receiver -> coalesced fresh GET_CONTEXT/GET_VIEW
-> shared applicationAssistant render. Its refresh generation rejects stale responses.
Child frames retain workflow authority without mounting canonical UI; worker progress
is mirrored to the top. No security fence or message authority is changed.

Repair: shared pure projectWorkflowProgress projects the existing question count
buckets into accepted completed progress, preserving document and ATS metadata.
The completed result uses this same projection rather than scalar ledger counters.
A later DOM mutation republishes current ledger progress only after an accepted
completion snapshot exists and while no Fill is active. Initial read-only discovery
still owns its legitimate zero/detecting states. Explicit review ledger mutations
publish through the same existing worker path. A new resolution run clears only
its local completion snapshot, preventing prior-run progress from being reused.
No new timers, polling, permissions, hosts, UI copy, or persistence model.

Semantics: discovered = unique QuestionLedger entries; filled = filled_and_verified;
skipped = optional_skipped; reviewRequired = needs_information + needs_confirmation
+ needs_user_gesture + technical_issues + legal_manual_actions + unsupported.
Each completed unresolved question belongs to exactly one bucket. In-flight states
are not completed review outcomes. The legacy hidden detail grid overrides its
technical count with separate final-control diagnostics; browser qualification
therefore reads only numeric authoritative diagnostic counts, never user values,
using a temporary restored isolated-world clipboard interceptor. Completed or
completed_with_review state preserves final live verification's conservative
completion decision; unresolved review cannot become completed.

Validation and rollout/rollback: final results below. Negative unit control
removed count projection and failed on stale counts; repair restored byte-for-byte.
Rollback consists of reverting only the R15 bootstrap/projection edits. No external
rollout authorized. Next stage returns directly to R13B once all R15 gates pass.


R15 physical probe exposed another **STALE_OVERWRITE**: after trusted child Fill,
nonzero ledger-derived child progress = worker = top UI, and counts survived an
actual worker Stop (CDP target absent, fresh timeOrigin and old marker absent).
However the normal CONTENT_READY handshake unconditionally replaced the accepted
completed_with_review stage with fetching_package. The normal five-second stage
assertion failed; retained in `child.log`/`child-traces`. This is stage coherence,
not a child aggregation defect. The original three complete stability runs had
already passed 17/17 each before this additional required probe.

Repair extension: CONTENT_READY now passes contentReadyViewPatch to patchView.
The patch is evaluated against the current view **inside** withAuthorityMutation,
after existing generation/session checks, avoiding a read/write race. An initial
unloaded package still enters fetching_package; an accepted package preserves its
current workflow state. Object patches keep their existing behavior. No broader
background lifecycle or permission/auth changes. Local completed progress is also
bound to its accepted session ID before it can be republished, so recovery into a
different session cannot reuse prior counts.

The focused unit now uses the actual putView/getView/patchView storage path and
a storage-change invalidation adapter into the production shared renderer. It
proves initial0/0, real committed9/2/7, event-driven fresh fetch/render, initial
fetching state, and preservation of completed state on readiness. Zero/stage
coverage also retains detecting, discovery, package-ready, filling, review and
failure nomenclature. All 28 assistant unit cases pass after this extension.
The failed unit during development had an incorrect packageLoaded=true fixture;
corrected to false without changing production semantics.

First completed-result divergence precedes the later zero overwrite: the old
result writer used scalar-ledger filled=3 while the authoritative question ledger
said2. The final result writer and mutation path now share the question projection.
The old hidden grid's technical display substituted final-live technical=3 for
question-ledger technical=5; authoritative review is7 in this fixture, not the
sum5 obtained from that diagnostic detail display. No hidden-grid redesign.
Final runtime qualification must use the post-readiness-repair build; repeat the
three complete stability runs after the worker/child probe passes.
Rollback now reverts only R15 bootstrap/projection/background/state hunks, retaining
all qualified earlier stages and inherited test migrations. No external rollout.


### R15 final qualification record

Verdict: **BLOCKED — PRODUCT REGRESSION**. The original post-Fill count/stage
repair is proven in isolation, but the required consecutive application-answer
qualification and complete normal-overlay regression are not green. This verdict
records failed regression gates; it does not establish that R15 introduced the
intermittent initial-readiness or Chrome worker-stop behavior. Do not resume R13B
yet, create another intermediate stage, or consume the final repository-wide
Playwright gate.

Final runtime is four files: background.ts, content/bootstrap.ts, state.ts and
new content/workflowProgress.ts. Entry-vs-final source reconstruction/hash audit
finds only those three existing runtime changes plus the new projection helper.
No API, Web or shared runtime changed. Classification: VIEW-STATE-COHERENCE and
STATE-ORDERING; existing EVENT-INVALIDATION reused. No proven frame aggregation
fault, security weakening, new polling/timer, permission/host change, UI redesign,
or unexpected runtime change. R15 test changes: application_assistant.test.ts,
application-answer.spec.ts, and new r15-workflow-coherence.spec.ts. Experimental
owned-API and overlay Stop-assertion changes were reverted. The latter is verified
byte-identical to reconstructed R15 entry source. All timeline/negative hooks
were restored, and final runtime hashes still match the qualified four-file set.

Exact coherence on final runtime: ledger = worker = visible **9 discovered,
2 filled, 7 requiring review**, worker completed_with_review, existing visible
"Filled — some items need your review". Synthetic employer authorization Yes,
sponsorship No, consent unchecked, **0 submit clicks and 0 submit events**.
The full application-answer spec passed **17/17** once on final runtime. The
required three consecutive complete passes were NOT achieved: a first attempt
failed during worker-storage setup (0 passed/1 failed/16 serial blocked), the next
passed17/17, and the next failed the normal five-second pre-Fill readiness
assertion (3 passed/1 failed/13 blocked; Loading instead of Reading the form).
A synthetic owned-API experiment also failed initial readiness (2 passed/1 failed/
14 blocked; Detecting before Fill); reverted rather than retained as an unproven
repair. Earlier three17/17 passes predate the additional readiness-stage repair
and do NOT substitute for final-runtime stability. No retry or timeout inflation.

Focused assistant units:28/28. Negative count projection and unconditional
CONTENT_READY state controls each fail the integration case (1 failed/27 skipped),
then restore exact source; positive28/28 passes. Browser stale-zero negative
control keeps ledger/worker9/2/7 but freezes only fresh canonical view progression;
the migrated positive-discovered assertion fails after its normal5000ms deadline.
Repair and harness restored. Partial XA11 ran exactly once: PASS1/1, visible and
worker3 discovered/1 filled/2 review, existing completed-with-review status,
AX review/verified totals2/1, no private employer markers or submit actions.
No XA10/XA11/XA16 migration completion was attempted.

Sanitized final timeline (relative to explicit SHOW, milliseconds), retained in
/tmp/xpertapply-e4od-r15-evidence/timeline-checkpoints.json:
C0 SHOW0; C1 first application discovery traversal40; C2 first nonzero committed
view953; C3 Fill1251; C4 first nonempty employer input event1757; C5 ledger filled
projection2386; C6 completed ledger result2697; C7 completed worker view2714;
C8 invalidation2714; C9 top receipt2744; C10 fresh view fetch2746; C11 returned
9/2/7 view2748; C12 identity adapter same numeric values2748; C13 final rendered
9/2/7 observation6437. C1 is an observable traversal boundary, not a measurement
of internal function entry. C12 shares C11's numeric observation and is supported
by the unchanged production identity adapter and C13 render; C13 is the final
sample, not first-render latency. Storage onChanged listeners run after commit;
equal-timestamp callback logging order does not reverse write-before-event.
No tokens or user values in timeline records.

Focused trusted-child/post-Fill physical recovery: PASS1/1. Ledger-derived child
result = worker = top canonical **4 discovered/2 filled/1 review/1 optional skip**,
completed_with_review before and after native exact-registration Stop. CDP proved
worker target absent; performance.timeOrigin1791149715515.9 ->1791149764908.2 and
old worker marker absent prove a new worker. Same surviving current documents,
one top host, zero child hosts. Following bounded existing recovery settling,
60 seconds idle: both frames context/view messages0, discovery queries0, form
mutations0, periodic timers0; network requests0; submit clicks/events0. Existing
session-storage persistence is preserved; no new persistence introduced.

Normal overlay: initial legitimate zero/stage cases covered by six focused unit
cases (detecting, discovering, package_ready, filling, completed_with_review,
failed). The broader native overlay browser run reached discovery, Fill, height/
zoom matrices, two-window isolation and ownership cycles, then failed its final
five-second Chrome internals Stop label assertion (stopping rather than stopped).
A stronger target-absence assertion experiment failed the earlier Stop gate
(target still present); restored to entry bytes. These are retained failures,
not a complete normal-overlay PASS. The independent post-Fill physical probe
above remains qualified. Stop/restart and initial readiness need further diagnosis
within R15 before complete release qualification can be claimed.

Focused security:11 files/189 tests PASS. Full Extension:84 files/1309 tests PASS,
typecheck and fresh production build PASS. Full Web:51 files/970 tests PASS,
lint/typecheck/fresh production build PASS. The final exact Make targets used
supported VITEST_MAX_WORKERS=2 with all original assertions and deadlines.
Uncapped attempts retained: Extension1307 pass/2 timing failures; Web962 pass/
8 failures in4 files under parallel resource pressure. No source/config changes
were used to obtain the capped full runs. API2120 PASS carried forward because
entry hashes prove API unchanged; no migration/schema work, so Alembic checks
are not applicable. Strict browser harness compilation PASS after type-only
metric annotations and numeric browser interval-ID handling in the new test.
Extension development build, generated manifest validation, Compose quiet and
diff check PASS. Source/prod/dev/E2E all exact five permissions and version0.2.0;
webNavigation absent; production hosts unchanged, existing dev/E2E loopback
profile differences retained. Popup and Side Panel fallbacks kept.

Final branch/HEAD/upstream unchanged, divergence0/0,31 authoritative changed paths,
empty index. Historical auth-evolution e15fc04d77d3dbfd4da51140a31dd9179c50d320,
store-release861427de804a9a4650d9284e3c1b5bfaa2bf213e,
prod-authceb8314ed69be130f591fb6c90df045fadca7fe8 all clean/read-only unchanged.
Canonical protected design-system plan SHA256 remains
30ef03b091e39dc9dbed6ad555047a6e46eda4313b9340a9777aa81b96e38cb0.
Owned browser process cleanup count0. Production access NONE; no staging, commit,
push, deployment, Store action, or repository-wide Playwright execution.

Rollback: revert only the four R15 runtime hunks/helper and R15-specific test
changes, preserving all entry work. Rollout remains blocked. Next work stays in
R15 to diagnose the bounded initial-readiness/worker-stop qualification failures;
after R15 genuinely passes, return directly to R13B for XA10, XA11, XA16/XA19,
remaining application-answer and Web fixture qualification, and the one final
repository-wide Playwright release run. No new intermediate stage.


### E4O-D-R15 final continuation — readiness remains blocked (2026-10-04)

**Verdict: BLOCKED — READINESS SYNCHRONIZATION UNRESOLVED.** Do not resume R13B or create R16. No staging, commit, push, deployment, Store mutation, production access, or repository-wide Playwright release run occurred.

Entry Git preflight retained feature/assistant-window at HEAD/upstream `738523e56bed89cbccad5d24afa5e12266927351`, 0 ahead/0 behind, 31 authoritative changed paths, empty index, and passing diff check. The four R15 runtime repair files and the five relevant harness files were hashed and remained byte-identical throughout this continuation. The first narrow coherence rerun passed before readiness investigation: ledger = worker = canonical UI = 9 discovered / 2 filled / 7 review, completed_with_review; authorization Yes, sponsorship No, consent unchecked, submit clicks/events zero. The existing count repair is preserved.

Readiness trace: current-document content bootstrap and explicit toolbar SHOW obtain bound context; CONTENT_READY passes sender/document/session/generation/probe fences and records registration; the view moves detecting_ats -> fetching_package; package acceptance sets contentReady/packageLoaded for session 55; read-only toolbar discovery publishes discovering_fields with nine discovered fields; canonical event-driven refresh converges and Fill is enabled. Fill alone is insufficient, because the renderer may enable it before package/discovery readiness. The diagnostic ready condition required bound available context, accepted matching session registration, contentReady and packageLoaded, nonrunning/nonfailure discovering_fields with nonzero discovered fields, matching canonical discovered count, and enabled Fill. No detecting/loading state counted as ready. The numeric authority generation is not publicly exposed; current Chrome document IDs and matched session/request IDs were recorded, with generation fences inspected in source rather than a fabricated diagnostic generation.

The first 30 observations passed but inserted extra awaits between seeding and SHOW; those results are retained as instrumentation-development evidence, not the final matrix. A corrected observer registered at document_start before navigation preserved the original navigation -> seed -> SHOW action sequence. The corrected consecutive matrix passed 30/30, one worker, retries zero, existing 90-second cases and five-second post-SHOW readiness assertion, without concurrent builds. SHOW-acknowledgement-to-ready latency: min 216 ms, median 868 ms, p95 1710 ms, max 1932 ms; readiness timeouts zero. Structural R0-R7 timelines included worker commits, registration/context/view replies, discovery traversal, current document/session/request IDs, package flags and Fill-disabled state. R8 was deliberately absent because this matrix stops before Fill.

The mandatory uninstrumented full application-answer three-run gate used one fresh build, no builds between runs, identical bundle hashes, one worker, retries zero, normal deadlines. Runs #1 and #2 passed 17/17. Run #3 passed two, failed Cancel before Fill at the original five-second readiness assertion, and serially blocked fourteen. Expected Reading the form; observed Loading your prepared application. Its trace shows CONTENT_READY reaching package_lookup but does not prove package acceptance or all authoritative prerequisites at the failure. The earlier startup-timeout trace stalled at storage seeding before SHOW. Therefore the provisional ENVIRONMENTAL_STARTUP_TRANSIENT classification was withdrawn: final classification **UNKNOWN**, no product or synchronization repair justified. There is no proven product-ready stale overwrite, no proof that semantic readiness had arrived while only text lagged, and no invented favorable timing explanation. A separate diagnostic copy passively recorded storage/fetch phase timing and retained the exact original assertion; it passed 17/17 without reproducing the failure. That diagnostic pass does not substitute for three consecutive uninstrumented full passes. Readiness negative control is not applicable because no readiness repair was made.

Native worker Stop semantics require exact registration Stop, disappearance of the exact prior CDP target, fresh execution epoch/timeOrigin and absent old worker marker after legitimate focus wake, preserved completed state, and advancing matched top/child registration counters. Chrome can reuse the target ID after its observed disappearance; neither URL counts nor wrapper identity establish prior execution survival. Test-only diagnostic code recorded S0-S6 and used the original five-second termination assertion and the broad harness's existing fifteen-second wake assertion. An initial diagnostic mistakenly used five seconds for wake; its retained failure snapshot showed a fresh epoch and missing old marker, not old survival. Corrected headless twenty-cycle runs passed 20/20. A headed combined run completed fifteen cycles then hit its unchanged 240-second combined-case deadline; retained, not counted as twenty passes. Twenty separately reported serial headed observations sharing the owned fixture then passed 20/20 with the same normal per-case deadline, one worker and retries zero. At S3: stopping 0, stopped 20; exact old-target absence 20, old-marker absence 20, new epoch 20, recovery 20, top/child registrations advanced in every cycle. No old-context survival after semantic termination was observed. Target-destruction event observation was attempted but Chrome did not expose that event in the probe; the actual exact-target absence samples remain the proof. The no-Stop negative failed at target absence, with the same old epoch, present old marker and live old execution, as required.

A full normal-overlay diagnostic retained both literal stopped assertions and recorded execution evidence only on failure; both complete cases passed, so label-lag-at-failure was not reproduced. The final broad overlay harness remains byte-identical: no unsupported harness repair. The three mandatory complete original overlay runs each passed 2/2 sequentially on identical bundle bytes, covering discovery, Fill, height, native zoom, two-window isolation, lifecycle, close/reopen, no-auto-open, native restart and unavailable-session recovery. Native stop qualification is positive; the historical literal-label failure mechanism remains unreproduced rather than falsely claimed as proven label lag.

Focused post-Fill child/restart/idle rerun passed 1/1: before/after worker and UI 4 discovered / 2 filled / 1 review, one optional skipped, completed_with_review, top overlay one, child overlay zero, old target absent, fresh epoch and missing marker. Both frame registrations recovered. During sixty-second idle: periodic context/view messages, discovery queries, timers, form mutations, sync-caused network requests all zero; submit clicks/events zero. XA11 was run once: worker/UI 3 discovered / 1 filled / 2 review and its assertions completed, but context/server teardown exceeded the original sixty-second case deadline; report the run as failed, not passed. XA11 migration/cleanup work remains R13B, not undertaken here.

Validation: focused coherence/overlay/bootstrap/recovery/ledger units 6 files / 89 tests PASS; focused sender/frame/document/session/private-Fill/submission security 11 files / 189 tests PASS. `VITEST_MAX_WORKERS=2 make test-extension`: 84 files / 1309 tests PASS, including typecheck and production build. `VITEST_MAX_WORKERS=2 make test-web`: 51 files / 970 tests PASS, including typecheck, lint and production build. API unchanged: carry forward the qualified 2120 PASS. Extension development build, strict browser-harness typecheck, manifest validation, Compose quiet configuration and final diff checks PASS. No API/schema changes, so no new migration cycle applies.

Temporary readiness, Stop, negative and full-overlay diagnostic source files were archived with hashes under `/tmp/xpertapply-e4od-r15-final/diagnostic-source/` and removed from repository test discovery. No continuation runtime or final harness repair remains. Continuation retained hunks are PLAN only; original R15 runtime changes remain limited to coherence/state precedence. Final authoritative path set remains 31, index empty. Source/production/development/E2E manifests retain version 0.2.0 and exactly activeTab, sidePanel, storage, scripting, tabs; webNavigation absent and existing host grants unchanged. Popup and Side Panel fallbacks kept. Historical auth-evolution, store-release and prod-auth-release worktrees remained clean at their original commits; canonical protected design-system file hash unchanged.

Evidence and full 72-field report: `/tmp/xpertapply-e4od-r15-final/`. Preserve all failed/aborted observations, not only passes. Rollback for this continuation is removal of this appended plan record only; no product rollback is warranted by an unclassified pre-Fill failure. R15 remains open. Required next work is to capture the pending package/registration/storage prerequisite at the failing uninstrumented readiness boundary and establish its cause, without timeout/retry inflation, then obtain the full three-consecutive-pass application gate. R13B and its one repository-wide final release run remain reserved; no intermediate stage is created.


### E4O-D-R15 package/readiness investigation — fixture repair under qualification

The exact prior failing title is **Cancel sends nothing and leaves the question answerable**, ordinal 3 after **an unanswered work-authorization question is answerable, applied and verified** and **the displayed value persists after the page re-renders**. Expected synthetic application m2, request m2, session 55, current owned loopback tab/frame 0/document, authority generation 0. Entry remained feature/assistant-window, HEAD/upstream 738523e56bed89cbccad5d24afa5e12266927351, 0/0 divergence, empty staging, 31 paths, clean diff check; four runtime and three relevant harness hashes captured.

Prospective instrumentation in a diagnostic test copy and ignored E2E worker bundle decomposed registration, handoff, lookup, HTTP request/response, metadata mapping, session authority, package write and view publication. No product source was edited to diagnose. Isolated exact-case pre-repair: **9 PASS / 1 FAIL across ten consecutive runs**. Thus serial-only contamination was disproven. Ten normal ordered prefixes: **10/10 prefixes, 30/30 cases PASS**, without additional state resets. Every case has a fresh temporary persistent browser context, override store, route set and loopback page fixture. No old document, stale handoff, ended session, changed generation, one-shot token exhaustion or shared backend store won selection.

The isolated failure proved **first missing prerequisite P6**, the required session-metadata response. At the original five-second failure boundary, P1 registration, P2/P3 correct active and pending handoff, P4 ensurePackage initiation and P5 metadata request initiation had occurred. Frame/document/session/request and generation were correct; package lookup remained in flight. GET /application-sessions/55 began before the boundary, but its browser-intercepted fixture handler was dispatched approximately 1.07 seconds after the boundary and its 200 response arrived approximately 1.84 seconds after it. No metadata mapping completion, package-acceptance session fence, sessionPackages write, packageLoaded publication, discovery or semantic Fill readiness had occurred. View was fetching_package, contentReady true, packageLoaded false, counts 0/0/0; visible Loading your prepared application; the renderer's button could be enabled, which alone is not semantic readiness. The product was correctly awaiting its missing response, not rejecting an already accepted package. No credentials or real account values were emitted by instrumentation.

Classification before repair: **FIXTURE_BACKEND_STATE_DEFECT**. The fixture response-delivery actor (per-request Playwright browser-protocol interception) did not deliver the required metadata response within the unchanged readiness window. Separately, route ownership was deterministically wrong: the later generic **/application-sessions/* route shadowed /application-sessions/token, returning no session credential even in passing cases. This secondary defect is recorded separately; it is not falsely described as the sole causal explanation for the timed-out response.

Test-only architecture repair: `e2e/owned-package-fixture.ts` owns a listening loopback HTTP backend per case, serves the existing fixture response handlers directly over HTTP, issues a unique synthetic session credential, enforces that credential on protected fixture endpoints, records structural request/response timing only, and closes owned connections during teardown. `application-answer.spec.ts` configures the owned backend before use and sets apiBase only in its temporary test profile; the generic session endpoint is narrowed to session 55 so token exchange has one handler. Existing override/resolution semantics, all assertions, five-second readiness limit, ninety-second cases and existing settling intervals remain unchanged. No global storage clearing, worker restart, page reload, overlay reopen, retry or timing inflation was introduced. No production runtime, permission, host or account/document/session fence changed.

Focused backend integration units: **2/2 PASS**, proving token/session endpoint ownership and rejection of a different fixture's credential. Strict repaired-harness typecheck PASS. The temporary P6 negative withheld the correct owned metadata response: the original readiness assertion **FAILED** with fetching_package, empty package cache and packageLoaded false, reproducing the missing-response boundary. No sleep or retry was added. Negative source was archived outside repository discovery and positive mode restored.

Qualification is in progress: twenty exact-case runs, ten ordered prefixes, one complete application-answer run, then three consecutive complete application-answer runs on identical pristine bundle bytes. Carry qualified 20/20 physical Stop, 3/3 complete overlay, child and sixty-second idle evidence forward because runtime is unchanged. XA11 teardown/migration remains R13B. After relevant units, capped Extension/Web targets and static validation pass, the finite gate requires R15 PASS and direct return to R13B; no additional intermediate stage. Rollback for this test-only repair is restoring the entry application-answer fixture and removing the new backend/helper units, preserving all four already-qualified runtime repair files and retained evidence. No staging, commit, push, deployment, Store access or repository-wide Playwright release run is authorized here.


### R15 readiness continuation — proven synchronization defect (2026-10-04)

The HTTP-only fixture repair passed the exact case 20/20 but the ordered prefix passed 29/30 tests (9/10 complete prefixes). Retain this failed intermediate result. In the failure all P1–P11 completed: valid unique fixture credential, token/metadata/answers 200, current document and m2/session55/requestm2 ownership, package cache write, packageLoaded and discovery. The first unmet test prerequisite was P12 observation. The canonical Reading the form/discovered9/Fill-enabled snapshot completed 4817.459ms after assertion start, inside its existing 5000ms budget. The preceding Node sample ended at 4537.532ms. Playwright's local pollAgainstDeadline implementation breaks when its next 1000ms backoff exceeds the deadline, leaving the remaining window unobserved. This independently proves TEST_SYNCHRONIZATION_DEFECT; no product readiness or authority defect was found. The earlier P6 fixture-response failure and shadowed token route remain separately documented as repaired fixture defects.

Repair is test-only: observe canonical Reading the form, discovered>0 and enabled Fill in the browser throughout the same 5000ms budget, then assert one current-tab worker snapshot for package/session/handoff acceptance. No second readiness wait, timeout increase, retry, fixed sleep, authority/fencing weakening, production polling or runtime edit. Temporary negative control withholds Fill enablement while allowing package readiness and visible status; it must fail and be removed. Final exact20/prefix10 and complete-once plus three identical-bundle full runs remain pending. Rollback restores only the continuation's application harness/owned fixture/unit changes; all prior qualified runtime fixes remain intact.


Instrumented final prefix attempt completed 7/10 full prefixes (21 passed, 3 failed, 6 serially blocked). All23 cases reaching pre-Fill observation passed P1–P12; one case timed out during context setup before readiness and two cases failed existing post-answer override/refresh assertions. These failed traces remain retained and are not counted as successful qualification. Exact Cancel20/20 is retained. The temporary observer/spec were archived/removed and the original qualified E2E background restored before running the retained complete spec. Complete once/three-run acceptance and a ten-prefix check on that retained uninstrumented harness remain pending; no runtime change or deadline/retry workaround was made for these failures.


### R15 final readiness result — BLOCKED (2026-10-05)

Verdict: BLOCKED — TEST SYNCHRONIZATION UNRESOLVED. The finite PASS condition is not satisfied; do not return to R13B and do not create R16. Two defects were proven before their respective test-only repairs: initial P6 fixture response delivery (FIXTURE_BACKEND_STATE_DEFECT, plus shadowed token endpoint), and the HTTP-only prefix's P12 observation miss (TEST_SYNCHRONIZATION_DEFECT, actual ready observation4817.459ms inside5000ms while Node poll stopped after4537.532ms). Those repairs remain reviewable; neither is claimed to resolve every subsequent full-spec failure.

Final exact Cancel matrix:20/20 complete passes and P1–P12 complete for all20. Final instrumented prefix:7/10 complete prefixes (21 passed,3 failed,6 serially blocked);23 cases reached pre-Fill and all23 passed P1–P12. Failures:90s context setup, zero post-answer override calls, zero post-answer refresh batches. These failed artifacts remain retained.

Diagnostics removed and pristine qualified E2E background restored. Complete-once:15 passed,1 pre-Fill failure in ordinal16 keyboard-input case,1 serially blocked. Its trace records token/metadata/answers200 before the readiness deadline, and Reading the form only in a snapshot afterward; worker package acceptance at the exact boundary was not captured. Mandatory gate on identical bytes, no builds/concurrency/retries:run1 0 passed/1 failed/16 blocked (90s toolbar/receiving-end failure),run2 0/1/16 (5000ms pre-Fill timeout, last snapshot Loading prepared, no recorded package HTTP requests),run3 3/1/13 (90s worker fixture setup timeout in ordinal4). No favorable rerun of these outcomes. No retained-harness prefix rerun was performed after the three-run gate failed. Residual full-serial root classification is UNKNOWN: these traces do not prove the first missing worker prerequisite, and no further source repair was made on an assumed cause. Future investigation must capture prospective P1–P12 at the failing full-spec boundary before any additional repair; do not weaken deadlines, authority, session/account/document fencing or add retry/sleep workarounds.

One complete-once passing coherence scenario reconfirmed ledger=worker=canonical9/2/7, completed_with_review, authorizationYes, sponsorshipNo, consentunchecked, zero submit clicks/events. Runtime4 source hashes, canonical driver and global setup are unchanged. Qualified Stop20/20, overlay3 full passes, child coherence and60s zero-idle traffic carry forward. XA11 teardown remains reserved R13B work; no migration/fix here.

Focused units7files/91tests PASS. Full capped Extension85files/1311tests PASS with typecheck and production build. Its first typecheck exposed the new Node-only fixture unit being included in the browser tsconfig; following the existing convention, exclude only that unit while strict Node/Chrome harness types validate the helper and unit. No Node globals added to browser source. Full capped Web51files/970tests PASS with typecheck/lint/build. Strict retained browser harness, Compose quiet, manifest checks and diff checks PASS. API unchanged2120 qualified passes carried, no schema/migration cycle. Development qualification carried because runtime unchanged. Test-only runtime observer and temporary negative/spec removed. Both metadata-withheld and Fill-disabled negative controls failed as required and were reverted.

Final continuation paths:application-answer.spec.ts (FIXTURE-OWNERSHIP,TEST-SYNCHRONIZATION),owned-package-fixture.ts (FIXTURE-OWNERSHIP,TEST-CLEANUP),application_answer_fixture.test.ts and tsconfig.json (TEST),this living plan (PLAN). UNEXPECTED=0. Entry31 paths preserved; final34 paths comprise those31 plus fixture, fixture unit and tsconfig. Historical worktrees/protected canonical audit unchanged; Git HEAD/upstream unchanged0/0,indexempty. No production access, staging,commit,push,deployment,Store mutation,final repository-wide Playwright,timeout/retry inflation,new fixed sleep,production polling,host/permission expansion,auth weakening or final-submit automation.

Rollout is blocked. R15 requires proof and resolution of the residual full-serial readiness/setup failures and the specified qualification gates before R13B can resume. Preserve current qualified runtime changes and failed evidence. Rollback of this continuation is limited to the test fixture/synchronization/unit/tsconfig/plan hunks; do not remove prior qualified count/Stop/overlay repairs. Evidence:/tmp/xpertapply-e4od-r15-readiness. No new intermediate release stage.


Final prerequisite-label correction: the original first missing prerequisite is P5 under the user's definition (request reaches fixture/backend), not merely P6. Fetch invocation was recorded before boundary1791175748889.983, but the actual metadata route callback began1791175749963.5408 (after boundary), and response arrived1791175750734.2. Earlier P5 instrumentation/parser used fetch invocation; it is corrected to require fixture receipt before boundary. Raw prospective evidence predates repair and is unchanged; corrected parser retains prior output versions. Thus initial classification remains FIXTURE_BACKEND_STATE_DEFECT, firstP5 missing and P6 also absent. Initial acceptance answers:requeststartedYES,fixture-receivedNO,responseNO,metadata-mappingNO,ownercheckNO,cachewriteNO,packageLoadedNO. Final exact20 and23 reached prefix observations still have allP1–P12 complete. Residual full-serial causes remain unproven; do not infer a root cause from absent retrospective worker snapshots.

### E4O-D-R15 final harness-stability continuation — evidence gap remains (2026-10-05)

**BLOCKED — UNKNOWN SERIAL FAILURE REMAINS.** R15 is not closed; do not create R16 or resume R13B. Current passing diagnostics do not identify historical failure causes. The referenced raw `/tmp/xpertapply-e4od-r15-readiness` evidence is absent on this machine, as are other referenced R15 temporary directories. A search of the release worktree's ignored test-results recovered only an unrelated overlay trace. Asked for another evidence/archive location; none supplied during this continuation. Historical rows below derive from the retained plan, not recovered raw traces. Missing facts remain explicitly unknown.

Entry: feature/assistant-window; HEAD/upstream 738523e56bed89cbccad5d24afa5e12266927351, 0/0 divergence; 34 authoritative paths, empty index, diff check PASS. Four runtime and four retained harness files hashed. No production or retained harness source changed in this continuation.

| Run | Test title | Ordinal | Failure phase | Last successful checkpoint | Failed operation | Product state reached? | Readiness reached? | Semantic assertions reached? | Context cleanup completed? | Root cause known? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Instrumented post-repair prefix: setup failure | Not recorded in available summary | Not recoverable | context/worker setup, 90s | Not recoverable | setup completion | Not established | No | No | Unknown | No: UNKNOWN |
| Instrumented post-repair prefix: override failure | Not recorded in available summary | Not recoverable | H12, post-answer | H11 readiness passed | expected override call; actual zero calls | Yes | Yes | Yes | Unknown | No: UNKNOWN |
| Instrumented post-repair prefix: refresh failure | Not recorded in available summary | Not recoverable | H12, post-answer | H11 readiness passed | expected refresh; actual zero batches | Yes | Yes | Yes | Unknown | No: UNKNOWN |
| Prior complete-once | keyboard input inside the widget cannot submit the application | 16 | pre-Fill H11/P12 observation | token/metadata/answers HTTP 200 | five-second semantic readiness | Partial; acceptance at boundary unknown | No at deadline | No test-specific action | Unknown | No: UNKNOWN |
| Prior mandatory full #1 | an unanswered work-authorization question is answerable, applied and verified | 1 | toolbar/receiving end, 90s | Not recoverable | SHOW setup | Not established | No | No | Unknown | No: UNKNOWN |
| Prior mandatory full #2 | an unanswered work-authorization question is answerable, applied and verified | 1 | pre-Fill H11 | Loading prepared; no recorded package HTTP requests | five-second semantic readiness | Partial | No | No | Unknown | No: UNKNOWN |
| Prior mandatory full #3 | answering No selects No, not a qualified variant | 4 | worker fixture, 90s | Prior three tests passed | worker fixture completion | Not established | No | No | Unknown | No: UNKNOWN |

These are seven distinct reported failures. The available summary does not preserve individual prefix iteration numbers or failed-test titles; it cannot support a fabricated every-run reconstruction. First missing H# for toolbar and first missing F# for worker setup are **not established**. A timeout reported in worker fixture is insufficient to distinguish F0/F1/F2/F3/F4/F5. Pre-Fill observation H11 was missing, but the earliest prerequisite P# is not established for the residual complete/full failures. Earlier repaired P5 fixture receipt and P12 polling observation defects remain separately qualified historical findings; they do not explain these residuals.

Lifecycle reference: H0 start; H1 owned fixture construct; H2 listener ready; H3 context created; H4 extension worker acquired; H5 employer page created; H6 handoff seeded; H7 employer navigation complete; H8 current content registration accepted; H9 trusted SHOW acknowledged; H10 package request accepted; H11 semantic prepared readiness; H12 case action/assertions; H13 context teardown begins; H14 owned backend teardown; H15 owned resources released; H16 end. In the retained helper, navigation H7 occurs before handoff seed H6, and SHOW can be acknowledged while content/package work continues; these labels are checkpoints, not proof of a strict numeric event order. No cause is inferred from that ordering.

Fixture setup reference: F0 construct; F1 bound socket; F2 HTTP listener readiness verified; F3 context created; F4 extension worker found; F5 worker responds; F6 employer form ready; F7 cleanup completed. New setup-only observations verify actual HTTP response, worker responsiveness and employer form, and cases pass only after framework fixture teardown returns.

Isolation audit: OverrideStore, resolver batches, backend route list/request log, random fixture bearer credential, ephemeral listening port and persistent browser context are newly allocated per test. Literal application/request m2, session55, launch/handoff l/h and job1 are reused inside isolated browser/backend owners; no shared mutable store was found. Worker wrapper is scoped to its context, with no cross-context or cross-test cache. Driver caches a CDP session per page but resolves its current shadow-root remote object on every call. The context fixture awaits context.close after use; backend close stops owned connections and awaits server close. Absence of historical teardown traces prevents proof that these barriers completed in failed runs. Backend socket closure alone is not evidence that arbitrary asynchronous handler code has drained; current handlers have no external deferred dependency, and no crossed-case handler activity was demonstrated. No test-state contamination, fixture/context/worker/bootstrap/assertion defect or current product defect was newly proven. Unknown is retained rather than classified as environmental transient.

New diagnostics, one fixed attempt each: exact Cancel **1/1 PASS**; complete application-answer **17/17 PASS (2.9m)**, including current coherence ledger=worker=canonical 9/2/7, completed_with_review, authorization Yes, sponsorship No, consent unchecked, submit clicks/events 0. Complete diagnostic is not a final qualification run: a focused unit invocation overlapped part of it. Focused owned-fixture unit **1 file/2 tests PASS**. No timeout, retry, fixed sleep or assertion changed.

Setup-only matrices on identical retained E2E bundle, no build/concurrent test workload: **toolbar trusted SHOW 30/30 PASS; fixture/worker 30/30 PASS**, 60 tests total, normal 90-second cases, workers1, retries0, max-failures1. Thirty fresh repetitions interleave the two cases. Toolbar cases stop after existing native-equivalent driver obtains trusted SHOW acknowledgement; worker cases verify owned HTTP and worker responsiveness then employer form. Temporary diagnostic was copied from the retained spec, archived outside repository test discovery and removed. No repair category was introduced, so no new repair negative control was warranted. Existing metadata-withheld and Fill-disabled controls remain carried historical FAIL results, not newly rerun controls.

Cancel10, ordered-prefix10, override10, refresh10 and the final exactly-three full gate are **NOT RUN/NOT QUALIFIED** in this continuation. Further passing repetitions cannot meet the explicit no-UNKNOWN requirement without the historical evidence or a directly reproduced causal failure; do not substitute these passing diagnostics for missing classifications. The full complete diagnostic supplies new passing evidence only. Worker Stop20/20 and overlay3/3 remain carried qualified; no matrix reopened.

Evidence and archived temporary setup spec: `/private/tmp/xpertapply-r15-harness-stability/`. Installed diagnostic runner was Playwright1.63.0/Node24.7.0. No build occurred during browser diagnostics; XA_E2E_SKIP_BUILD=1 and explicit retained dist-e2e-granted path used. Runtime/retained harness hashes unchanged. Rollout remains blocked; rollback for this continuation removes only this plan addendum, preserving all qualified prior runtime/fixture changes. No staging, commit, push, deployment, Store mutation, production access, final repository-wide Playwright, permission/host expansion, polling or final-submit automation. Popup/Side Panel fallbacks retained. Next remains R15 evidence recovery/causal disposition; R13B cannot resume yet.

Validation completed: capped Extension85files/1311tests PASS (typecheck, units, production build); capped Web51files/970tests PASS (lint, typecheck, build, units); strict browser harness typecheck PASS using installed Node types from Web and Chrome types from Extension, with TypeScript6 --ignoreConfig; development build PASS; all three manifests structurally valid, version0.2.0, permissions activeTab/sidePanel/storage/scripting/tabs, no webNavigation; Compose config quiet PASS; diff check PASS. Initial strict harness command was corrected for TypeScript6 config handling and Node type discovery; no source/dependency change required. API source/schema unchanged; qualified2120 PASS carried. Historical auth-evolution/store-release/prod-auth worktrees are clean and unchanged; protected canonical design-system audit file has no HEAD diff. Final continuation classification PLAN only; TEST diagnostic removed/archived; all other categories and UNEXPECTED zero; NO NEW RUNTIME CHANGE. Authoritative paths remain34, indexempty.

### E4O-D-R15 prospective finite closure gate — current serial failure (2026-10-05)

**BLOCKED — CURRENT SERIAL FAILURE.** This continuation applies the user's superseding prospective policy: historical raw artifacts are unavailable and cannot be reconstructed, but their absence is not a permanent blocker. If all specified current finite gates pass, classify the old unreproduced incidents HISTORICAL_UNREPRODUCED_SERIAL_INCIDENTS and close R15 directly to R13B. No extra qualification matrix may be added. That condition was not met because a current final run failed; this verdict does not rely on the missing old archive.

Entry branch feature/assistant-window, HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351, divergence0/0,34paths,emptyindex,diffcheckPASS. Eight runtime/retained harness hashes match the previous closure attempt. All granted E2E bundle files were hashed; sourcemaps match current sources. Process/listener inventory before qualification found no stale owned Chrome/fixture or concurrent build. XA_E2E_DIST was explicitly the retained apps/extension/dist-e2e-granted; XA_E2E_SKIP_BUILD=1; workers1,retries0,existing90s cases/5s readiness unchanged. Bundle hashes were verified before and after every browser phase. No browser gate overlapped another build/test workload.

| Prospective gate | Result |
| --- | --- |
| Toolbar SHOW sanity | 5/5 PASS; prior30/30 carried |
| Fixture/worker sanity | 5/5 PASS; prior30/30 carried |
| Exact Cancel | 10/10 PASS |
| Ordered prefix | 10/10 prefixes /30/30 tests PASS |
| Override scenario | 10/10 PASS |
| Refresh scenario | 10/10 PASS |
| Keyboard/no-submit | 10/10 PASS; explicit clicks/events0 in every case |
| Complete application-answer once | 17/17 PASS |
| Final full #1 | 17/17 PASS |
| Final full #2 | 1PASS/1FAIL/15didnotrun;90s context setup timeout, ordinal2 |
| Final full #3 | NOT RUN; stopped on current failure |
| Three consecutive complete passes | NO |

Both override-call and refresh-batch assertions reside in the first prefix test, `an unanswered work-authorization question is answerable, applied and verified`; separate ten-run gates use that exact scenario with unchanged original assertions. Setup sanity uses the previous archived setup-only tests copied from the current retained fixture. A temporary observation copy additionally asserts the existing keyboard audit counters are `{clicks:0,submits:0}`; original keyboard/consent assertions are preserved. The observation spec was archived outside repository discovery and removed. No retained test/harness/product source change or speculative repair was made.

Current failure: final full#2, `the displayed value persists after the page re-renders`, ordinal2/application-answer.spec.ts:441. Trace records owned packageFixture setup complete13828.683ms and context launch beginning13829.182ms at line112, with no launch completion. The90,000ms case deadline expires during context setup. First missing H3/F3 = context created; worker, employer page/document, registration, SHOW, package prerequisites, readiness and test-specific assertions were never reached. Thus no current count/package/product defect is established. Backend teardown completes103984.176ms; listener inventory finds no surviving owned backend.

Context-resource cleanup was incomplete: no context handle was returned, and Chrome launch processes outlived the timed-out worker. Read-only samples were captured before any cleanup. Chrome151.0.7922.34 on macOS27.2: parent13550 main thread waits in __wait4; child13551 is inside fork/libSystem_atfork_child/xpc_atfork_child/OS_xpc_object dealloc and pthread mutex wait. This locates a browser-startup fork-child stall before context delivery; the upstream trigger/lock ownership and a safe repair are not established. No Chromium flag workaround, timeout inflation, retry, sleep, global state wipe or product change was introduced. Precisely identified owned processes, with unique profile playwright_chromiumdev_profile-Bd0r0v and matching granted extension launch path/time, received TERM only after trace/sample retention. Subsequent process check confirms their exit. No unrelated process was terminated.

The fixed runner stopped on this current failure and did not seek green via reruns. Historical missing-archive causes remain honestly unreconstructed; the all-prospective-pass condition for their final HISTORICAL_UNREPRODUCED_SERIAL_INCIDENTS disposition is not fulfilled. Product coherence from passing finalfull#1: ledger=worker=canonical9/2/7,completed_with_review,authorizationYes,sponsorshipNo,consentunchecked,submitclicks/events0. Runtime/harness and E2E bundle hashes are unchanged, including across failedfull#2. Stop20/20 and overlay3/3 remain qualified and were not rerun.

Validation: focused fixture/application-answer/security8files/203tests PASS, covering sender/document authority,session/generation fences,privateFill,legal/consent and submit safety; capped Extension85files/1311tests PASS withtypecheck/productionbuild; capped Web51files/970tests PASS withlint/typecheck/build. Strict retained browser harness typecheck,developmentbuild,three-profilemanifestvalidation,Composequiet,diffcheck PASS. API/schema unchanged;2120qualifiedPASS carried. Manifests version0.2.0,exactpermissionsactiveTab/sidePanel/storage/scripting/tabs,webNavigationabsent;nohostexpansion.

Continuation retained changes: PLAN only. TEST-HARNESS/TEST-FIXTURE/TEST-SYNCHRONIZATION/runtime deltas NONE; temporary TEST observation archived/removed;UNEXPECTED0. All34 authoritative entry paths preserved;indexempty. Auth-evolution/store-release/prod-auth remain clean at recorded commits. Both canonical protected design-system plan hashes remain30ef03b091e39dc9dbed6ad555047a6e46eda4313b9340a9777aa81b96e38cb0. ProductionaccessNONE;popup/SidePanelKEPT. No staging,commit,push,deployment,Storemutation,repository-widefinalPlaywright,timeout/retryinflation,arbitrarysleep,polling,permission/hostexpansion,authweakening,final-submitautomation or unrelatedruntime redesign.

Evidence: `/private/tmp/xpertapply-r15-prospective/`, including per-phase logs/JSON, failed trace, native samples, current-failure analysis, source/bundle hashes and owned-cleanup record. Rollout is blocked by current full#2, not archive availability. Rollback removes only this plan addendum; no product/harness rollback is needed. Remain in R15 to address the proven current browser-startup boundary safely; no R16 and no R13B until the decisive gate passes.

### E4O-D-R15 browser-launch disposition — launch not reproduced; final gate failed (2026-10-05)

**BLOCKED — BROWSER LAUNCH INCIDENT UNRESOLVED.** The retained native launch incident has a known H3/F3 boundary and fork/XPC mutex blocking path, but its causal classification remains UNKNOWN. All three fixed minimal launch matrices passed; they do not establish an upstream-versus-extension-specific trigger or a process-churn defect. A separate current H12 assertion failure also prevents the required three-consecutive full passes. No favorable rerun was made and no new qualification matrix is added.

Preflight: feature/assistant-window, HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351, divergence0/0,34 authoritative paths, empty index, diff check PASS. Four runtime files, four retained harness files and tsconfig.json hashed unchanged against entry. Environment: Playwright1.63.0, bundled Chromium151.0.7922.34, Node24.7.0, macOS27.2 build26B5091g. One existing coherence case passed before runtime investigation was frozen: ledger=worker=canonical9/2/7,completed_with_review,authorizationYes,sponsorshipNo,consentunchecked,submitclicks/events0. No count/package/overlay repair was reopened.

Diagnostics live outside repository test discovery under `/private/tmp/xpertapply-r15-browser-launch/`. They use the same Playwright installation, bundled Chromium channel, default headless mode, serviceWorkers allow, unique disposable profile prefix/location and existing extension launch flags. Bare mode omits extension flags; minimal mode changes only the extension path to an owned MV3 manifest/service worker with no permissions, hosts, content scripts, network or XpertApply code. Bundle mode loads the unchanged granted bundle and performs only a harmless worker identity evaluation. No fixture, employer navigation, handoff or toolbar action runs in these matrices. DEBUG=pw:browser was enabled for launch/PID telemetry; this is an observational environment difference, not a browser flag or workaround. Other inherited environment and launch configuration were preserved. Each diagnostic launch had a90s bound, without retry; a pre-deadline native sampler was armed but never fired because no launch stalled.

| Mode | PASS | FAIL | H3 stall | XPC child stall | Other failure |
| --- | --- | --- | --- | --- | --- |
| BARE_PERSISTENT_CONTEXT | 30/30 | 0 | 0 | 0 | 0 |
| MINIMAL_EXTENSION_PERSISTENT_CONTEXT | 30/30 | 0 | 0 | 0 | 0 |
| XPERTAPPLY_GRANTED_BUNDLE_LAUNCH_ONLY | 30/30 | 0 | 0 | 0 | 0 |

Every passing row records B0 launch requested, B1 root PID, B2 observed child PIDs, B3 context/page delivery, B4 close begins, B5 close returns, B6 root absent, B7 owned children absent, B8 profile removed. Child inventory occurs after context delivery in successful launches; these are timestamped observations rather than an assumed numeric event order. No diagnostic owned process/profile remains. No native stall was reproduced outside XpertApply; none occurred in bundle-only launches either. Do not claim UPSTREAM_CHROMIUM_PERSISTENT_CONTEXT_INCIDENT, PLAYWRIGHT_CHROMIUM_EXTENSION_LAUNCH_INCIDENT, XPERTAPPLY_EXTENSION_STARTUP_DEFECT or PER_TEST_BROWSER_CHURN_DEFECT from these nondifferential passing results. Retain UNKNOWN for the causal class of the original parent __wait4 / child fork -> libSystem_atfork_child -> xpc_atfork_child -> OS_xpc_object dealloc -> Chrome framework -> pthread mutex/__psynch_mutexwait observation.

Topology decision: no change justified. The original test-scoped context fixture launches17 independent persistent contexts/profiles per complete17-test spec,51 across three runs. Passing90 rapid launch lifecycles does not prove churn caused the earlier stall. Fresh process isolation remains the existing qualification baseline; changing it would introduce a new shared-worker/state contract without a proven harness defect. No worker/file-scoped context, reset helper, storage wipe, cached cross-test Worker or route sharing was added. Shared-context contamination negative, order perturbation and20 shared-spec-fixture lifecycle gates are conditional and NOT APPLICABLE because no shared-context architecture was implemented.

Isolation inventory: PER-TEST local apiBase; session activeAssistedApplyHandoffV1,pendingLaunches,sessionPackages,viewStates; worker authority/cache memory; private Fill state; DOM/page listeners/submit counters; backend routes, request log, resolver batches, override store and unique random credential. Each belongs to a fresh browser/profile or owned backend. PER-SPEC readonly fixture HTML, question/canonical mapping constants and bundle path/bytes. Extension manifest/build assets are READ-ONLY. Literal m2/requestm2/session55/l/h values remain scoped to separately disposable profiles/backends; no previous profile state is actionable in the next test. No reset/deletion of unrelated extension storage occurs. No normal cross-test contamination was demonstrated.

One fixed complete run and exactly three final executions used identical granted-bundle bytes, XA_E2E_SKIP_BUILD=1,workers1,retries0,existing90s cases/5s readiness and unchanged semantic assertions. No concurrent build/test workload ran. Results:

| Application-answer execution | Result |
| --- | --- |
| Complete once | 17/17 PASS |
| Final full#1 | 17/17 PASS |
| Final full#2 | 17/17 PASS |
| Final full#3 | 3PASS/1FAIL/13didnotrun |
| Three consecutive complete passes | NO |

Current full#3 failure is separate from H3/F3: ordinal4, `answering No selects No, not a qualified variant`, application-answer.spec.ts:490. `store.calls[0]` is undefined at the original `{value:false}` assertion after the unchanged3500ms settling interval. Context, worker, package acceptance, discovery and readiness completed. Trace records token/metadata/answers/override-list/resolver200, then no override write request after the No action; last snapshot shows disabled review actions. This establishes a current H12 post-action failure, not whether eventual work was late or stalled. No proof of a synchronization-only defect or a product cause was available before teardown; the assertion was not weakened and no speculative wait/runtime repair was made. Context teardown completed43688.403ms and owned backend teardown43688.667ms; final process/listener inventory found no stale owned resource. Failed trace/log/JSON are retained. The runner stopped and no favorable replacement full run was attempted.

Passing full#2 retained ledger=worker=canonical9/2/7,completed_with_review,authorizationYes,sponsorshipNo,consentunchecked,submit0/0. No current count/overlay regression was proven. Four runtime, all retained harness/tsconfig hashes and every granted-bundle file remain unchanged. No new XpertApply startup defect is established; the new H12 outcome remains unresolved and is not waived.

Validation: focused fixture/application-answer/security8files/203tests PASS; capped Extension85files/1311tests PASS including typecheck/production build; capped Web51files/970tests PASS including lint/typecheck/build. Strict browser-harness typecheck, development build, production/development/granted manifests, Compose quiet and diff check PASS. API/schema unchanged;2120qualified passes carried. Permissions exactlyactiveTab/sidePanel/storage/scripting/tabs,webNavigationabsent,version0.2.0,nohost expansion. No added unsupported browser flag, timeout, retry, sleep, polling, authority weakening or final-submit automation.

Continuation change classification: PLAN only; diagnostic TEST/BROWSER telemetry is outside the repository; TEST-BROWSER-LIFECYCLE,TEST-CONTEXT-SCOPE,TEST-STATE-ISOLATION,TEST-FIXTURE and runtime source deltas NONE;UNEXPECTED0. Exact34 entry paths remain unchanged, stagingEMPTY. Historical auth-evolution/store-release/prod-auth remain clean at their recorded commits. Both canonical protected design-system hashes remain30ef03b091e39dc9dbed6ad555047a6e46eda4313b9340a9777aa81b96e38cb0. ProductionaccessNONE;Popup/SidePanelKEPT. No staging,commit,push,deployment,Store mutation or final repository-wide Playwright. Rollback removes only this appended plan record; no product/harness repair exists to revert. R15 remains BLOCKED; noR16 and noR13B. Further work must resolve the current H12 failure and honestly disposition the launch cause, without adding favorable repetition loops or reopening qualified product areas speculatively.


### E4O-D-R15 H12 final disposition attempt — BLOCKED at current N0 readiness (2026-10-05)

The finite final H12 continuation preserves the old H3/F3 causal classification UNKNOWN and the valid 90/90 bare/minimal/granted launch non-reproduction. Retrospective XPC/fork proof is no longer a closure requirement. No H3/F3 recurred in this continuation; the launch incident is not an independent blocker. No additional launch, Stop, overlay, XA09, XA12, Cancel-only, or keyboard matrices were run. Fresh test-scoped persistent contexts, one worker, retries zero, existing deadlines, and granted shipping bundle bytes were preserved.

The original retained full #3 H12 failure remains distinct: application-answer.spec.ts:490 sampled store.calls[0] undefined after choosing No, with no PUT before the original assertion. A complete production call graph and truthiness audit found no proven false-dropping operation. Explicit No is a literal boolean false from widget.ts renderChoiceBlock/onChoose, through applicationAnswer.ts strict validation/current session/consent checks, bootstrap.ts storeOverride/sendRuntime, messages.ts required boolean parser, background.ts override handler/validation/tab package resolution, client.ts JSON PUT, fixture receipt and OverrideStore.calls. The array records request receipt before response completion. Re-resolution preserves typed false and distinguishes null/undefined absence, then verifies exact No and records filled_verified. Full locations and audit are in the report linked below.

Test-only observation used a separate copied diagnostic bundle with synchronous structural array records and a temporary spec retaining original assertions, original 3500 ms settle, 90000 ms case deadline, and original first-four order. No credentials or personal answers were captured. N0 readiness, N1 question/action, N2 enabled No, N3 actual dispatch, N5 callback, N6 boolean false, N7 intent, N8 runtime send, N9 worker receipt, N10 existing validation/current tab package acceptance, N11 API entry, N12 serialized false, N13 fetch, N14 fixture receipt, N15 store push, N16 response, N17 callback acknowledgment, N4 actual employer No, N18 filled_verified were all observed in every completed No case. N4 logically follows acknowledgment. N10 does not invent frame/document/generation comparisons absent on the legacy override branch; actual sender identities and captured generation were recorded separately. No authority was relaxed or redesigned.

Pre-repair exact matrix: **20/20 PASS**. Original-order first-four prefix: **9/10 complete prefixes, 39/40 PASS, one FAIL**. Prefix four ordinal four failed before No dispatch, in original waitForPreparedApplication's 5000 ms readiness observation. Trace shows worker/context/overlay present, final canonical stage “Loading your prepared application…”, and token POST beginning near deadline (response status 200); no metadata/discovery/Fill/No action before failure. First missing checkpoint N0, not a false-value divergence. Causal mechanism remains UNKNOWN_CURRENT_H12_FAILURE; serial contamination, false-value loss, authority rejection, fixture receipt failure, and No-assertion synchronization were not proven. Initial runner stopped on that failure; only the six unexecuted prefixes were subsequently completed, all 24 tests passing. The failed prefix was not rerun or replaced. The failed N0 case's final structural audit was not captured; this observation gap is stated in the report, not filled by inference.

Across all 29 No cases that reached readiness (20 isolated + 9 prefix), all N0–N18 timestamps are retained, no missing checkpoint, store calls 1 at original assertion and 1 at teardown, employer exact No/hidden false, internal filled_verified, consent unchecked, submit clicks/events 0/0. No repair is justified; no differential or negative control applies. The historical-unreproduced H12 disposition requires the prefix gate to pass and therefore is NOT granted. Post-disposition exact/prefix, complete spec once, and final three complete gates were NOT advanced after this failed prerequisite. No favorable replacement or fourth final run was attempted.

Validation: focused answer/fixture units **2 files / 79 PASS**, strict four-file harness typecheck PASS, git diff --check PASS. Carry same-source Extension 85/1311, Web 51/970, API 2120, security 203, production/development builds/static gates. Current manifest checks confirm exact activeTab/sidePanel/storage/scripting/tabs, no webNavigation, version 0.2.0, unchanged host authority. All nine source/harness/config hashes and original granted bundle file hashes unchanged. Temporary spec archived externally and removed; no instrumentation remains in shipping bundles. Authoritative changed path set remains exactly 34, index EMPTY, continuation retained delta PLAN only, UNEXPECTED 0. Three historical release worktrees clean at unchanged HEADs; both protected design-system files unchanged SHA256. Production access NONE. No staging/commit/push/deployment/Store mutation/repository-wide final Playwright. Popup and Side Panel fallbacks KEPT. Qualified coherence 9/2/7 completed_with_review, authorization Yes/sponsorship No, consent untouched/submit 0/0 are carried for their original seeded scenario; distinct No-only inputs are not mislabeled as that scenario.

**R15 BLOCKED — CURRENT H12 FAILURE UNRESOLVED.** Next action remains causal disposition of current N0 prepared-package readiness failure within R15, preserving existing timing/authority. R13B remains unresumed; no R16. If the required gates later pass, close R15 immediately and return directly to R13B; checkpoint only after R13B's own final release gate. No runtime rollback needed because no runtime repair was retained.

Evidence/report: [R15 H12 81-field report](/private/tmp/xpertapply-r15-h12/R15-H12-override-closure-result.md); [per-execution checkpoints](/private/tmp/xpertapply-r15-h12/checkpoint-matrix.md). Diagnostic archive includes original failed prefix trace, exact and prefix JSON reports, observer specification, source/bundle inventory, and read-only historical integrity results.


### E4O-D-R15 N0 readiness disposition and final closure — PASS (2026-10-05)

This append preserves all historical failed records. The only current investigation target was the previous H12-stage prefix four ordinal four readiness timeout before No dispatch: existing 5000 ms helper missed N0, canonical “Loading your prepared application…”, browser/worker/overlay present, token request beginning near boundary, metadata/discovery/Fill unproven. Old post-click H12 and false-value handling were not reopened.

Current source inspection confirmed all five retained test setup repairs: owned per-case HTTP backend; unique random synthetic fixture credential; exact token endpoint not shadowed by generic routes; browser-side page.waitForFunction semantic readiness across the SAME 5000 ms; one current-tab worker view/package/pending session55/requestm2/applicationm2 assertion after UI readiness. Fresh per-test persistent contexts retained, no shared topology/global storage clearing.

P0–P12 prospective structural observation was outside shipping source, in a separate copied diagnostic bundle and temporary spec/driver. P0 existing SHOW acknowledgment; P1 accepted current top document/content registration; P2 selected active/pending handoff; P3 selected session/request/application; P4 ensurePackage entry; P5 ACTUAL owned-server receipt of token/metadata/answers; P6 actual responses; P7 package metadata mapping; P8 existing generation/session acceptance fence; P9 actual sessionPackages storage commit; P10 actual current contentReady/packageLoaded view commit; P11 authoritative nonfailure/nonrunning discovering_fields view with discovered>0; P12 canonical current tab/session/request render Reading the form… with discovered>0 and enabled Fill, independently accepted by original browser condition. Actual worker time origin, tab/frame/document/session/request/application and exposed authority generation retained. No invented view document/generation fields, credentials, response bodies, free-text answers or personal data in telemetry. No added await in production/test action sequence, sleep, timeout, retry, timer, polling, fence change or answer/API semantics change. Full awaited-boundary graph covers runtime registration/probe, HTTP/JSON mapping, authority mutation queues, storage.session commits, storage.onChanged invalidation, content receipt, microtask GET_CONTEXT/GET_VIEW refresh, generation-fenced canonical DOM render and Playwright browser observation.

The SINGLE fixed original-order first-four prefix matrix passed **10/10 prefixes / 40/40 tests**. Every ordinal-four execution reached P0–P12 before its original readiness boundary; no first divergence, all required HTTP operations 200, matching current packages/views, invalidation/fetch/render observed, 40 normal teardowns completed. No deterministic ownership/state/authority/observer defect was proven. No repair was invented; no differential investigation, negative control, post-repair prefix, exact No20 matrix repeat, or additional readiness stress matrix applies. Classify previous N0 causal UNKNOWN, release HISTORICAL_UNREPRODUCED_N0_READINESS_INCIDENT. Temporary spec/driver archived externally and removed from repository test discovery; shipping bundle never instrumented.

Final qualification against the original identical granted bundle, one worker/retries0/normal deadlines: **complete-once 17/17; full #1 17/17; full #2 17/17; full #3 17/17**. No blocked cases, favorable rerun, fourth run, builds between runs, or concurrent build/test workload. Bundle hash inventory before and after every run equals entry. Every complete/final run retains ledger=worker=canonical **9 discovered / 2 filled / 7 review**, worker completed_with_review, authorization Yes, sponsorship No, consent unchecked and submit clicks/events **0/0** through existing assertions/audit. No automatic legal/consent/submission action.

Final release incident taxonomy: browser causal UNKNOWN / HISTORICAL_UNREPRODUCED_BROWSER_LAUNCH_INCIDENT (prior90/90 valid, no H3/F3 in current108 fresh cases); prior H12 causal UNKNOWN / HISTORICAL_UNREPRODUCED_H12_INCIDENT (qualified false path carried and current ordinary No assertions pass); prior N0 causal UNKNOWN / HISTORICAL_UNREPRODUCED_N0_READINESS_INCIDENT. No current UNKNOWN release blocker remains under the finite pass policy. Stop20, overlay3, XA09/XA12 and false-path qualification are carried without reopening.

Validation: focused owned fixture **2/2 PASS**, preceding same-source answer/fixture79 carried, strict retained four-file harness tsc PASS, manifests/source hashes/git diff --check PASS. Carry same-source Extension1311, Web970, API2120, focused security203 and production/development builds/static gates. All nine source/config hashes unchanged, four runtime hashes unchanged; no repair/rollback required. Manifest permissions exactly activeTab/sidePanel/storage/scripting/tabs, webNavigation absent, version0.2.0, host/auth/consent/submit authority unchanged. Authoritative path set exactly34, new retained hunk PLAN only, UNEXPECTED0, index EMPTY. Historical auth-evolution/store-release/prod-auth-release clean/unchanged; both protected design-system hashes unchanged. Production access NONE; Popup/Side Panel fallbacks KEPT. No staging/commit/push/deploy/Store mutation/repository-wide final Playwright.

**PASS — R15 CLOSED; RETURN DIRECTLY TO R13B.** No R16 or additional R15 matrix. R13B is the next stage and completes remaining canonical migration and its one correctly configured repository-wide final release gate; checkpoint only after R13B passes. R13B has not been started in this continuation.

[Complete 80-field readiness closure report](/private/tmp/xpertapply-r15-n0/R15-N0-readiness-closure-result.md); [per-prefix checkpoint/timing evidence](/private/tmp/xpertapply-r15-n0/checkpoint-matrix.md).


### E4O-D-R13B final migration inventory — BLOCKED by required-review completion bypass (2026-10-05)

R15 closure is carried and remains CLOSED; no R15/R16 matrix reopened. Entry feature/assistant-window HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351,0/0 divergence,34authoritative paths,index EMPTY,diff check PASS. Current retained migration diffs were reviewed before editing; no historical migration hunk discarded. Pre-edit A/B/C/D equivalence inventory preserves unique semantics, maps outer-host/status/layout behavior to canonical overlay, explicitly justifies obsolete footer/body geometry/note grouping/diagnostics/exploratory modes, and identifies remaining XA10 text/Clear-state and XA16 outside-page/close/reopen/idle coverage. No retained assertion was deleted. Five migrated specs contain zero retired outer-host/WidgetDriver/old footer/count owner dependency; nested review facade is legitimately reached from canonical document path through the single unchanged production-equivalent toolbar scripting/SHOW driver.

Before advancing targeted migration or consuming the final repository-wide gate, source inspection showed canonical Complete had no unresolved-required-review prerequisite. A single temporary test-only probe reused the real XA11 synthetic scenario, current CanonicalOverlayDriver trusted toolbar path, explicit Fill and original deadline; no fake view, relaxed fence, product state injection or runtime modification. The token mock was kept separate by narrowing metadata route to exact911. Pre-completion canonical and worker both3discovered/1filled/2review, completed_with_review, accessible Needs review count2, first_name/last_name both required=true. Complete enabled. After accepting its manual “Confirm you submitted…” dialog, one mocked200 completion request occurred; worker purged view/sessionPackages/pendingLaunches. Employer submit clicks/events0/0. The required-review guard assertion expected0requests and FAILED with1. Source chain: applicationAssistant.ts:207 action gating ignores required review; :279 complete handler confirms/dispatches without review check; background.ts:785 authorized overlay/current-session branch calls completeActive; :2353 completes then :2562 purges; client.ts:199 POST confirmed:true. This is a current completion-tracking prerequisite defect, not an automatic employer submission, false-value or coherence regression. Live backend completion acceptance was NOT tested; completion route was explicitly mocked.

Per explicit R13B block policy, STOP migration after this evidence. **BLOCKED — CURRENT PRODUCT DEFECT** (CANONICAL_REQUIRED_REVIEW_COMPLETION_BYPASS). No product repair/test weakening. XA10/XA11/XA16 three-pass gates, negatives, remaining sanity/browser migrations, full units/security/build/static gates were not advanced; prior qualifications are informational carry, not substituted for R13B requirements. The ONE normal-globalSetup repository-wide Playwright release gate is UNCONSUMED; no favorable rerun. Checkpoint NOT READY.

Probe containment mistake: inherited XA11 fixtures left four subroutes unmatched. Network trace confirms production-origin override-list GET and resolver/events/autofill-results POST received404 with remote server address. Synthetic session/credential only; token/metadata/answers/completion were mocked. No successful authenticated production operation observed; no production completion request, no real credentials. Production access cannot be reported NONE. The unmatched routes should have been aborted; this is explicitly retained in the report. No further browser/network request was executed. Fixture network containment must be corrected before future release execution. No provider/production response body or real credential is committed.

Probe failed once in4.7s; normal context/server finally completed; worker36333 exited, fixture port57757 closed. Temporary observer spec archived externally and removed from repository discovery. All14inventoried runtime/harness files unchanged; new retained continuation hunk PLAN only; authoritative union34,index EMPTY,diff check PASS,UNEXPECTED0. Historical auth-evolution/store-release/prod-auth-release clean and unchanged; protected design-system SHA in both canonical paths unchanged. Popup and Side Panel KEPT. No staging/commit/push/deployment/Store mutation, permission/host expansion, product polling, consent/legal/submit automation or unrelated runtime redesign.

Next remains blocked R13B disposition of narrow required-review completion guard plus test network containment, not R15 or R16. E4O-D-CHECKPOINT cannot proceed. [75-field result](/private/tmp/xpertapply-r13b/R13B-final-migration-result.md); [assertion mapping](/private/tmp/xpertapply-r13b/assertion-equivalence.md); [structural product defect evidence](/private/tmp/xpertapply-r13b/defect-evidence.json). Historical failed records remain unchanged.


### E4O-D-R13B narrow required-review guard continuation — in progress (2026-10-05)

Scope: required completion prerequisite and synthetic-network containment only; R15 remains CLOSED, no R16, no migration matrices or repository-wide Playwright gate. Entry branch/HEAD/upstream unchanged, divergence0/0,34paths,indexempty,diffcheckPASS; entry snapshots at /private/tmp/xpertapply-r13b-guard.

Semantics: QuestionEntry.required is preserved by discovery/scalar absorption/final verification. QuestionLedger bucketOf assigns outcomes without consulting requiredness: needs_information, needs_confirmation, needs_user_gesture, technical_issues, legal_manual_actions and unsupported each can hold either optional or required controls. Each blocks completion only when required. optional_skipped is a legitimate nonblocking optional outcome; forged required optional_skipped must still block. In-flight required controls also block. Existing reviewRequired remains the six-bucket sum; optional_skipped remains separate. Requiredness does not reach worker aggregate views today (result C), so new optional typed requiredReviewRemaining is derived from questionLedger.all() and carried on existing trusted progress/result path. Missing projection fails closed. No DOM-copy authority, completion caller count, polling or new timer.

Architecture: worker completeActive checks current stored session views before completionHTTP/purge, keeping all surface authority gates and rechecking generation/session authority. Trusted projection reception additionally checks the existing registered session/document/host permission boundary. Shared applicationAssistant disables Complete, retains confirmation and existing status/review accessible guidance; popup/SidePanel share controller or worker guard. Rejection has no state mutation. Rollback: revert only continuation hunks against entry snapshots; retain original blocked evidence, do not publish an unguarded build.

Containment: owned loopback fixture serves token, metadata, answers, override list, resolver, events, autofill-results and completion; pre-navigation browser-context hard egress guard aborts every external HTTP(S) attempt, structurally records method/origin/path and fails the test. No production-body/real credential logging. One contained original reproduction against retained pre-guard bundle PASS:3/1/2, two required reviews, one local completion request, normalpurge,submit0/0,externalattempts0/responses0. Evidence pre-repair.log; temporary reproduction archived externally and removed. Focused regressions, negativecontrols,10blocked/5resolvedbrowser gates and runtime validation pending. Final releasegate remainsunconsumed.


### E4O-D-R13B narrow required-review guard continuation — qualified, return to R13B (2026-10-05)

**PASS — REQUIRED-REVIEW COMPLETION GUARD AND TEST NETWORK CONTAINMENT QUALIFIED; RESUME R13B MIGRATION.** STOP this narrow continuation. R15 remains CLOSED; no R16. R13B migration/checkpoint has not passed, and the one final repository-wide Playwright release gate remains UNCONSUMED. No staging/commit/push/deployment/Chrome Web Store mutation.

Authoritative semantics result C is proven: QuestionLedger entry.required preserves optional versus required, while QuestionCounts and reviewRequired do not. Each of needs_information/needs_confirmation/needs_user_gesture/technical_issues/legal_manual_actions/unsupported can contain either kind; only required entries block. Optional_skipped remains nonblocking for optional controls. In-flight required entries also block; malformed required optional_skipped remains blocked. New requiredReviewRemaining = required entries not filled_verified; derived from ledger entries, not UI copy/DOM counts or completion payload. Missing, invalid, running, unavailable or nonterminal projection fails closed. Existing six-bucket count formula, CONTENT_READY precedence, event invalidation and zero polling are preserved.

Worker completeActive checks all stored current session views before API/purge, keeps existing packaged sender/tab/document/session checks, and rechecks generation/ended-session authority. New projection receipt uses existing registered session/document/host authority. Typed failure leaves viewStates,sessionPackages,pendingLaunches,session authority and document registration intact. Shared applicationAssistant disables Complete using the same prerequisite, describes it with current stage/review guidance, retains manual employer-submission acknowledgment, and renders restrained required-field guidance for stale actions. Popup assistant and Side Panel packaged/shared-worker protections retained; no fallback redesign.

OwnedPackageFixture covers token, exact metadata, prepared answers, override list, resolver, events, autofill-results and local completion; safety fixture also owns override PUT. Pre-navigation containSyntheticNetwork aborts all external HTTP(S), records sanitized method/origin/path and fails on attempts/external responses. Missing owned routes fail local fixture teardown; no production fallback. XA11 and application-answer fixtures adopt the same containment without dropping retained semantic assertions.

Contained original reproduction once: PASS expected bypass3/1/2,two required reviews,one localcompletion,purge,submit0/0,production0. Product negative: removed only worker readiness check, real-listener regression FAILED with1mockedcompletion; background restored byte-exact, focused90positivePASS. Network negative: removed token fixture AND omitted ownedAPIbase, normal production-default token path attemptedtwice; both aborted before transmission,status-1/noIP/noresponse,egressassertionFAILED as required; temporaryspec removed. Prior R13B production404 incident remains historical; this continuation production access NONE. Product prerequisite incident and harness incident remain separate; employerSubmit and productionCompletion never observed.

Initial acceptance history preserved: manual employer name entry+Fill did not resolve explicit confirmation(required2); an interim mere-live-presence rule wrongly removed initial review(required0) and was entirely removed. Legitimate resolution instead uses existing individual review answer UI and its actual verified fill. Successful explicit review fills now update the same QuestionLedger and existing event-driven progress; user save-for-future can remain off. Automatic confirmation policy unchanged. Audit additionally makes grouped-name review inspect each fill outcome, so failed controls are not promoted. No fake final worker state or guard weakening.

Finite blocked gate **10/10 PASS**, oneworker,retries0,normal60scasedeadline,noaddedfixedsleeps; required2,Complete disabled,directregisteredworker bypass rejected,0completion/0purge,allstores/registration preserved,consentunchecked,submit0/0,external0. Finite resolved gate **5/5 PASS**, legitimate required0,worker/canonical3/3/0 coherent,Completeenabled,cancel retains0request/package,accept sends exactly1localcurrent-session200request,normalpurge,consentunchanged,submit0/0,external0. These matrices were not repeated. After separate grouped-name authority hardening, one supplemental final-source blocked+resolved browser smoke **1/1 PASS** confirmed unchanged individual resolution path. XA11 narrow smoke **1/1 PASS** exactlyonce at3/1/2,completed_with_review,noautomaticcompletion,submit0/0,production0. Minimum application-answer targeted-refresh/finalSubmit safety smoke **1/1 PASS**, activeprivacyunchecked/noSubmitfocusclick; current/stalesession authority covered by real-worker focused regressions. No R15matrix or XA migration3-run gate performed.

Validation: focused3files/90PASS; final security12files/294PASS; final capped VITEST_MAX_WORKERS=2 make test-extension **86files/1330tests PASS** includingtypecheck/productionbuild. Initial86/1330alsoPASS; repeat justified by audited grouped-name source fix. Finaldevelopmentbuild,strictsix-filebrowserharness,three-profilemanifest/filevalidation,Composequiet,diffcheckPASS. Compiler CLI setup errors corrected using TypeScript6 --ignoreConfig and existing Web Node typings; no dependency install. Web same-source51files/970 and API2120PASS carried; noWeb/API/schema/environmentchange,no migration. Permissions exactlyactiveTab/sidePanel/storage/scripting/tabs,webNavigationabsent,version0.2.0,nohost/optionalpermissionexpansion,no newtimer/polling/auto-open/consent/legal/finalSubmitautomation.

Exact runtime continuation paths: apps/extension/src/completionAuthority.ts; src/background.ts; src/messages.ts; src/content/questionLedger.ts; src/content/workflowProgress.ts; src/content/bootstrap.ts; src/ui/applicationAssistant.ts. TEST/containment paths: e2e/network-containment.ts; e2e/owned-package-fixture.ts; e2e/required-review-completion.spec.ts; e2e/xa11-status-coherence.spec.ts; e2e/application-answer.spec.ts; src/__tests__/completion_authority.test.ts; application_assistant.test.ts; frame_trust.test.ts. Prefixes under apps/extension unless explicitly full. Every new hunk classified REQUIRED-REVIEW AUTHORITY / COMPLETION UI GUARD / COMPLETION WORKER GUARD / COMPLETION STATE SIGNAL / TEST NETWORK CONTAINMENT / TEST / PLAN. UNEXPECTED0. Entry34→final39paths (newtrackedquestionLedger delta +4newfiles),indexEMPTY; temporaryprobes/evidenceuntrackedoutsidecheckout. state.ts,XA16/shareddriver unchangedentryhashes; historical planprefixappend-only. auth-evolution/store-release/prod-auth-release clean unchanged; protected design-system hashes unchanged30ef03b091e39dc9dbed6ad555047a6e46eda4313b9340a9777aa81b96e38cb0.

Rollout is not authorized/performed here. Rollback uses continuation-only diff and entry snapshots, preserving historical plan/evidence and all prior worktree changes; do not release the original unguarded implementation. Next remains R13B: complete XA10/XA11(teardown)/XA16-XA19 3/3, remainingnegativecontrols,first-partyWeb fixture,targetedsanity,fullapp/security/staticgates as applicable,then ONE correctly configured final repository-wide Playwright run. Checkpoint only after those pass; noR16/commit/push.

[Complete 69-field result](/private/tmp/xpertapply-r13b-guard/required-review-guard-result.md); [final network audit](/private/tmp/xpertapply-r13b-guard/final-network-audit.json); [continuation-only diff audit](/private/tmp/xpertapply-r13b-guard/continuation.diff). Historical failed evidence remains unchanged.


### E4O-D-R13B final canonical migrations resume — in progress (2026-10-05)

Entry39paths,feature/assistant-window HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351,0/0,indexempty,diffcheckPASS. Required-review guard/network containment qualified carried;R15CLOSED,noR16. Scope remaining XA10/XA11/XA16 canonical semantics,negatives,ownedfirst-partyWeb,sanity/unit/static then ONE finalnormal-globalSetup repositorywidePlaywright only after prerequisitegates. Pre-edit equivalence inventory and all39file snapshots preserved at /private/tmp/xpertapply-r13b-final; no historical migration hunks discarded. Runtime repair is outside this continuation: immediately STOP on current product defect, leave final releasegateunconsumed. No staging/commit/push/deploy/Store. Architecture remains one production-equivalent trustedtoolbar canonicaldriver, nested current review facade,ownedloopback APIs+hardexternal egressguard. Rollback test-only continuation hunks fromentrysnapshots whilepreservingallpriorwork.


### R13B final completion resume — product-defect stop (2026-10-05)

Required-review guard and network-containment qualification carried; R15 remains closed. XA10 and XA11 each completed3/3, with intended test-only snapshot/count negative failures and byte-exact restoration. XA11 required no teardown repair. XA16 canonical migration preserved density500 and focus semantics; fresh-focus and keyboard-modality harness preconditions were corrected without relaxing assertions. The subsequent targeted run reached close/passive/reopen and failed current canonical/worker count coherence: worker4 discovered/3 filled/1 review versus visible4 discovered/0 filled/4 review (xa16-keyboard.log, line222). This is a current product defect; mandatory stop policy applied immediately. No product repair, safety negative, later prerequisites, or final repository-wide Playwright run performed. Final run remains UNUSED. No staging/commit/push/deploy/Store mutation.

External retained evidence: `/private/tmp/xpertapply-r13b-final/final-completion-result.md` (102 fields), assertion-equivalence.md, all targeted logs/traces and source hashes. Final authoritative path count remains39; index EMPTY; diff-check PASS. Historical worktrees clean/unchanged and protected design-system hashes unchanged. No owned browser/test-worker or Node fixture listener observed at exit; port3000 clear. Full final hunk/network/resource qualification was not reached and is not claimed. Verdict: **BLOCKED — CURRENT PRODUCT DEFECT**. E4O-D-CHECKPOINT is not authorized by a failed R13B; R15/guard closure is preserved.

### R13B canonical reopen coherence repair — structural diagnosis (2026-10-05)

This is the authorized narrow continuation of R13B, not R16. Entry remains feature/assistant-window, HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351, divergence0/0,39 paths, empty index and clean diff-check. XA10/XA11 three-run qualification and R15/required-review guard remain carried. Final repository-wide Playwright remains unused and is explicitly excluded from this continuation.

One exact contained XA16 reproduction with test-only monotonic structural tracing proved the source: toolbar reinjects content.js, which unconditionally claimed a new instance and reentered checkHandoffAndStart/discoverForToolbar. Its fresh discovery payload sets filled0 and reviewRequired=fields.length, replacing the real worker4/3/1 view with4/0/4 via background.applyProgress/patchView. GET_VIEW first returned4/3/1 at performance.now3470.5, then an AUTOFILL_PROGRESS invalidation caused GET_VIEW to return4/0/4 at3474.1. The controller correctly rendered the new, destructively reset worker state; its generation rejection is not the fault. Synthetic toolbar fallback (0/0/0) is not involved. Facade-local rendering does not write canonical counters. Classification: **OTHER_PROVEN_PRODUCT_REOPEN_DEFECT — live same-document workflow reinjection resets authoritative progress**. The historical snapshot4/3/1 is valid before reinjection, not proof that storage remains4/3/1 afterward. Trace reproduction also disabled Complete after losing requiredness; no authority fence was relaxed.

Architecture: retain a live same-build document workflow owner through a captured-runtime liveness lease in content/instance.ts; duplicate bootstrap does not initialize an ATS/Web role or supersede its ledger. New builds and invalid/orphaned runtimes still replace old owners. Explicit SHOW retains the normal fresh presentation context/view fetch; no driver, worker projection, QuestionLedger, completionAuthority, Fill logic, permissions or auth change. Closed passive updates remain detached. Rollback only these new instance/bootstrap hunks and their focused regressions; preserve all earlier retained changes.

External evidence lives at /private/tmp/xpertapply-r13b-reopen: entry snapshots/hashes, structural-trace.json, trace.log/results, focused unit logs and negatives. Reopen gate10/10 PASS, one worker/retries0/original180-second deadline. Each complete XA16 run also exercised minimized worker count changes and restored convergence, closed worker state changes without host recreation, explicit single-host reopen4/3/1 with required0, retry safety and contained local endpoints. An initial new control omitted required document-status arrays; worker rejected the malformed harness payload, which was corrected and now explicitly asserts acceptance. That failed attempt is retained, not classified as flaky.

Focused integrated negative temporarily restored live-owner reclamation and produced canonical4/0/4 against expected4/3/1; repair restored byte-exact;21 focused tests PASS afterward. Test-only consent mutation failed the existing unchecked-consent assertion, then source restored byte-exact. Complete XA16 three-run and remaining unit/security/build gates are in progress. Temporary structural instrumentation is removed from source; no diagnostics ship. No staging/commit/push/deploy/Store operation.


### R13B canonical reopen coherence repair — qualified exit (2026-10-05)

PASS — CANONICAL REOPEN VIEW COHERENCE REPAIRED; RESUME FINAL R13B RELEASE GATES

Reopen10/10 and complete XA16/XA19 3/3 PASS. Minimize/update/restore and closed passive-state changes PASS. Required-review blocked smoke PASS (completion requests0, stores preserved), plus single XA10/XA11 shared-state smokes PASS; prior three-run matrices carried. Both focused reopen and local consent negatives failed at intended assertions and were removed with byte-exact restoration. Submit0/0, consent unchecked, production/external requests0 under owned loopback containment. Focused lifecycle8 files/140 tests PASS; security17 files/353 tests PASS; capped full Extension86 files/1336 tests PASS. Extension typecheck/production/development builds/strict harness/manifests/Compose/diff-check PASS. Initial manifest checker error applied production optional-host expectations to development; corrected the checker to the existing profiles without changing manifests. Qualified Web51/970 and API2120 carried unchanged.

Final continuation delta: bootstrap.ts and instance.ts (REOPEN VIEW AUTHORITY, OVERLAY LIFECYCLE); content_instance.test.ts and overlay_bootstrap.test.ts (TEST); xa16-xa19-widget.spec.ts (TEST, TEST SYNCHRONIZATION); this appended plan (PLAN). All new hunks reviewed, UNEXPECTED0. Final authoritative changed paths41; index EMPTY; HEAD/upstream/divergence unchanged. No owned browser/test-worker/Node fixture listener observed; port3000 clear. Historical worktrees clean/unchanged; protected hashes unchanged. No temporary trace instrumentation in product or harness source.

C0–C23 chronology, including explicit distinctions between directly captured events and source-derived lifecycle steps, is in `/private/tmp/xpertapply-r13b-reopen/reopen-coherence-result.md`; raw monotonic trace is structural-trace.json. First divergence is fresh read-only discovery progress from reinjection, not the canonical controller, facade, synthetic placeholder or R15 projection. Narrow rollback remains reverting only this continuation's live-instance/bootstrap hunks and regressions; earlier evidence preserved. Final repository-wide Playwright remains UNUSED. STOP here; next remains final R13B release-gate continuation, not checkpoint yet. No stage/commit/push/deploy/Store mutation.

### R13B final release-gate continuation — entry and first-party prerequisite (2026-10-05)

Entry verified feature/assistant-window, HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351, divergence0/0,41 exact paths, index EMPTY, diff-check PASS. Entry snapshots/hashes captured externally at /private/tmp/xpertapply-r13b-release. Canonical reopen10/10, XA10/XA11/XA16 three-run qualification, required-review guard, full Extension86/1336 and security353 are carried; no matrices reopened. Final repository-wide Playwright remains UNUSED pending every prerequisite.

First-party presence/handoff1/1 PASS: existing harness explicitly owns127.0.0.1:3000 and uses the bridge-supported localhost:3000 document, performs readiness before navigation, correlates/replays presence READY, posts a real prepared STAGE_LAUNCH through the Web bridge, and attaches an owned loopback employer/API fixture. Explicit canonical toolbar opening creates one host; consent unchecked; submit0; contained external attempts/responses0. Finally closes browser, listener connections and both owned servers; port3000 released. Expanded first-party test retains all previous presence assertions; no runtime/auth changes. XA09 harness preparation converts only its API fixture to owned loopback/exact session route and containment, retaining safe-limit and zero-mutation assertions. Complete application-answer17-case current-source accounting is running once with no rerun permitted if it fails. All evidence remains external; no staging/commit/push/deploy/Store mutation.


### R13B final release-gate continuation — application-answer block (2026-10-05)

**BLOCKED — APPLICATION-ANSWER REGRESSION**. The required complete application-answer regression was invoked exactly once with one worker/retries0 and max-failures0. Result:17 selected,6 passed,1 failed,10 serial-dependent cases not run. Failure at application-answer.spec.ts:607 (a reinjected content script still applies the answer): after a full page reload and toolbar reopen, expected Reading the form… but received Filled — some items need your review. Its local fixture teardown additionally rejected an unconfigured GET /application-sessions/55/resume. Both failures retained; no rerun or source repair attempted. The current-source accounting is therefore NOT17/17 qualified. R15 historical qualification remains closed, but does not override this current-source failure.

Mandatory block/no-rerun policy applied. Final repository-wide Playwright remains UNUSED. XA09 owned-loopback harness preparation retained but smoke NOT RUN. XA12/Stage3C/overlay/recovery/question-resolution/guard/fresh Web/final static gates NOT RUN after the block. Reopen/XA10/XA11/XA16, Extension86/1336 and security353 prior qualified evidence carried; no runtime/unit edits in this continuation. First-party Web presence/handoff1/1 PASS with released port3000. Containment records for targeted browser exit contain no blocked external attempts/responses; the missing resume request was local, not production. No owned browser/test worker or Node fixture listener observed at exit. Index EMPTY, diff-check PASS, HEAD/upstream0/0 unchanged; historical worktrees and protected design-system hashes unchanged. Authoritative path count41. No staging/commit/push/deploy/Store mutation.

Full86-field report and exact first-failure logs/traces: /private/tmp/xpertapply-r13b-release/final-release-gate-result.md. This continuation changed only e4oc-r3-overlay.spec.ts (FIRST-PARTY WEB FIXTURE/NETWORK CONTAINMENT/TEST CLEANUP), xa09-real-extension.spec.ts (XA09 MIGRATION/NETWORK CONTAINMENT; not yet qualified), and this appended plan. Broader final all-hunk release audit not reached and not claimed. Stop here; R13B remains blocked, so checkpoint is not ready.

### R13B application-answer reload continuation — source/trace disposition (2026-10-05)

Entry41 paths, HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351, divergence0/0, index EMPTY, diff-check PASS; snapshots in /private/tmp/xpertapply-r13b-reload. Exact current title: “a reinjected content script still applies the answer”. Diagnostic title filter initially selected no tests; corrected filter executed the exact case once without repair. New Chrome document ID D0C2123611B6284F23B9BC7891A19A73 replaced F28ACADCFA9B702F3392A6A4CF3E0AA1, with a distinct document-local owner, toolbar marker absent and host0. Same-document owner lease did not cross reload. Fresh answer resolution/events/autofill-results after reload produced current terminal counts9/1/8 required4; retained DOM snapshot confirms restored authorization display/backing value and safety counters0/0, consent unchecked. Canonical GET_VIEW/render agrees with this freshly produced terminal view; no stale terminal replay or cross-document ownership defect.

Source contract: HEAD bootstrap already calls checkHandoffAndStart(automatic_launch) for a new declarative document and discoverAndFill for a valid prepared handoff without the toolbar marker. The qualified owner-preservation repair retains that legitimate live workflow when SHOW is subsequently requested, rather than destructively reconstructing read-only progress. Thus the old Reading the form… assertion relied on the old erroneous reinjection reset; classification **TEST_EXPECTATION_REGRESSION**, with a separate **OWNED_FIXTURE_RESUME_ENDPOINT_DEFECT**. /application-sessions/:id/resume is a PDF document-download route, not workflow resume. REQUEST_DOCUMENT→background.fetchDocument sends authorized GET withfmt=pdf; prepareDocumentUploads requests it when a resume upload target exists. API returns authenticated FileResponse/PDF and filename, or404 for unavailable/nonowned document. It does not transition session/view state itself. Legitimacy here is CONDITIONAL on prepared resume/upload target, and this fixture meets that condition.

Fixture-only repair adds current-session PDF download registration with actual content type/content disposition/bytes and rejects unknown session, wrong credential, invalid method/format. Synthetic blank PDF has no personal content. Exact reload assertion now requires distinct trusted Chrome document IDs and owner identities, preserved same-document owner after SHOW, current prepared package/session, current terminal canonical==worker counts, saved Yes persistence without extra override PUT, consent unchanged and submit0/0. Removed the exact case’s old3500/4500ms waits in favor of semantic conditions; no runtime change, timeout increase, retry or product polling. Initial shared helper’s historical settling interval remains pending final synchronization review. Fixture tests3 PASS. Missing resume handler negative failed with local missing-endpoint evidence; source restored byte-exact. Reload10-run gate in progress; final repository-wide gate remains unused, no staging/commit/push/deploy/Store mutation.


### R13B application-answer reload continuation — qualified repair / XA09 block (2026-10-05)

Reload10/10 PASS (one worker/retries0/original90-second deadline), same-document reopen smoke1/1 PASS, complete current application-answer17/17 PASS once with zero dependent skips, unconfigured endpoints or cleanup errors. Saved authorization/sponsorship, saved No, optional unresolved, cold-worker, expiry/refusal, count coherence and targeted-refresh Submit safety all PASS. Missing local resume handler negative failed as intended and was restored byte-exact; fixture contract tests3 PASS. Shared readiness now accepts source-supported discovery or resumed terminal state while retaining current package/session/request authority; original common4500ms settling wait replaced by semantic terminal wait. No new fixed sleep/retry/timeout increase/product polling. Strict harness typecheck PASS after adding explicit null/Chrome identity guards; successful semantics unchanged. Production runtime hashes match entry; Extension86/1336/security353/Web51/970/API2120 CARRIED, NOT RERUN under fixture-only policy.

The authorized single XA09 smoke then FAILED before form discovery: workerSESSION_UNAUTHORIZED instead ofAPPLICATION_FORM_TOO_LARGE. Read-only source proof: token route returns hardcodedxa09-test-token while OwnedPackageFixture requires its randomsessionToken for nonexchange requests. The local metadata request is therefore unauthorized. No runtime defect is inferred. Failure log/trace retained, no XA09 rerun or source repair made. **BLOCKED — XA09 REGRESSION** is the continuation verdict despite the reload/application-answer repair being qualified. Final repository-wide Playwright remains UNUSED; no Stage3C/overlay/recovery/question-resolution/full Web/final release gates consumed.

Final delta is application-answer.spec.ts (TEST SYNCHRONIZATION/TEST), owned-package-fixture.ts (RESUME FIXTURE), application_answer_fixture.test.ts (RESUME FIXTURE/TEST), and this appended plan (PLAN). All new hunks reviewed, UNEXPECTED0; final authoritative path count41, empty index, diff-check PASS, HEAD/upstream0/0 unchanged. Temporary reload trace instrumentation removed; current trusted identity checks are permanent regression assertions. No owned browser/test-worker/fixture listener observed; port3000 clear. Historical worktrees and protected design-system hashes unchanged. Full104-field report and R0–R24 trace distinctions are external at /private/tmp/xpertapply-r13b-reload/application-answer-reload-result.md. No staging/commit/push/deploy/Store mutation. Next remains same R13B, blocked on XA09 fixture authority before remaining final release gates; no R16/checkpoint yet.

### R13B XA09 fixture authority / final release gate continuation (2026-10-05)

Entry verified branch feature/assistant-window, HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351, divergence0/0, authoritative41paths, empty index and clean diff check. Entry hashes and external evidence: /private/tmp/xpertapply-r13b-xa09-final. Production runtime remains unchanged in this continuation.

X0 OwnedPackageFixture starts an owned loopback server; X1 public readonly sessionToken is synthetic-randomUUID; X2 token exchange has its own unprotected endpoint while protected metadata requires that exact bearer; X3 XA09 stages distinct single-use launchToken xa09-launch and session909; X4 worker ensurePackage exchanges launch then fetches session metadata with returned session_token before caching; X5 existing CONTENT_READY/exact-tab toolbar workflow binds the document; X6 package/session generation fences and backend credential check remain normal; X7 only authenticated package proceeds to discovery; X8 large form produces APPLICATION_FORM_TOO_LARGE. Previous hardcoded xa09-test-token cannot equal synthetic-prefixed fixture sessionToken. Classification TEST_FIXTURE_CREDENTIAL_AUTHORITY_DEFECT. Repair consumes apiFixture.sessionToken, preserves launch/bearer distinction and all production authority.

One controlled wrong-token run observed SESSION_UNAUTHORIZED, packageLoadedfalse, fieldsDiscovered0, filled0, input/form/submit counters0 and consentfalse. Its additional page-count assertion failed because the newly added outside-form unchecked checkbox defaults to value on. No auth weakening or employer write occurred. Permanent count now selects application inputs; independent consent assertion retained. An earlier shell path error left source unchanged and inadvertently invoked the prior failing mismatch test; retained negative.log is not a positive qualification. No favorable fourth positive run. Corrected source XA09 EXACT3 consecutive PASS (7.4s/4.8s/4.3s whole-run elapsed), worker1/retries0/60sec existingdeadline, APPLICATION_FORM_TOO_LARGE, safe-limit1,000/Nothing was filled, input0/formMutation0/submitClick0/submit0, consentfalse, containment PASS. Wrong credential and temporary negative assertions removed.

Focused fixture units4/4PASS prove fixture-owned token success, other fixture token rejection, authenticated session ownership/PDF constraints, and local missing-route404 plus close-time failure without fallback. OwnedPackageFixture/global credential plumbing unchanged: application-answer17/17, reload10/10, same-document reopen1/1, firstparty1/1 and XA12 qualified evidence carried; no repeated matrices. Unit-source edit means full Extension/security reruns required before a PASS under current policy. Stage3C-3 exact acceptance1/1PASS10.7sec; deliberate employer/ATS permission subset builds preserved, all HTTPS names (including API) explicitly mapped by Chromium to owned127.0.0.1 server; no real production destination.

Canonical overlay, all-frame recovery, question-resolution harnesses prepared to use OwnedPackageFixture protected API endpoints, apiBase loopback and fail-closed containment before navigation. Existing semantic/product assertions retained. Canonical overlay once currently running; remaining gates and final suite not yet consumed. Rollback only these new test hunks; leave prior qualified product repair intact. Final repository-wide Playwright remains UNUSED until all prerequisites pass.

Canonical overlay1/1PASS1.5min and all-frame recovery1/1PASS1.3min, including existing idle/recovery and safety assertions, contained external response/attempt checks. Question-resolution complete acceptance attempted ONCE: first Scenario A reaches teardown but fails local missing authenticated /application-sessions/55/resume GET;14 serial tests consequently not run. This is a fixture document-route omission exposed by removing the previous broad metadata mock, not evidence of product authentication/actuator regression. Added existing syntheticSessionPdf/document handlers for session55 resume and cover-letter as a concrete reviewable test-only repair; NOT rerun, NOT qualified. No favorable retry or full release invocation. Verdict BLOCKED — QUESTION-RESOLUTION REGRESSION. Final repository-wide Playwright remains UNUSED, checkpoint not ready. Remaining dependent release prerequisites cannot be claimed PASS. Mandatory Extension rerun in progress due fixture-unit source edit; independent validation will be reported separately.

Independent required-review final smoke1/1PASS5.1sec with R13B_RESOLVE=1: unresolvedrequired2 disables Complete, wrong-session/direct-count-bypass rejected, completionRequests0 and stores preserved; genuine review fills produce3/3/0 and required0, Complete enabled, dismiss confirmation preserves package, accept confirmation sends exactly1 LOCAL completion request then purges current stores; employerclicks0/submits0/privacyfalse/networkblocked[]/externalResponses[]. No stress matrix repeated.

Fresh full Extension86files/1338PASS (74.57sec), security17files/355PASS (11.92sec), fixture4/4PASS. Compared with previous carried86/1336 and17/353, two fixture tests added across reload and this continuation explain current totals; no old count misrepresented as rerun. Fresh VITEST_MAX_WORKERS=2 make test-web51files/970PASS29.17sec unit duration; make also lint/typecheck/build PASS. Sequential final static checks all PASS: Extensiontype/prodbuild/devbuild, strict changed browser harness, Webtype/lint/prodbuild, MV3manifest profiles/artifact validation, composequiet, diffcheck. Production version0.2.0, exactfivepermissions activeTab/sidePanel/storage/scripting/tabs, webNavigationABSENT, hosts/optional unchanged. No new runtime/auth/polling/timer/consent/legal/final-submit changes. Popup/SidePanel fallback artifacts preserved.

Final41paths/indexEMPTY/HEADupstream0/0/diffcheckPASS. Comparison against previous qualified exit hashes changes only e4oc overlay harness, recovery harness, question harness, XA09 harness, fixture unit and this appended plan; runtime hash changesNONE. New hunks classified NETWORK CONTAINMENT/RESUME FIXTURE/XA09 FIXTURE AUTHORITY/TEST CLEANUP/TEST/PLAN, unexpectednewhunks0. Full retained306nonplanhunk inventory saved externally; comprehensive final release hunk audit deferred because question acceptance blocked (not claimed completed). Active migratedfive-spec legacy selectors/drivers/outerfooter/hiddenauthority search0. No temporary diagnostic observer spec or negative credential retained. Owned TestingChrome/browserchildren0, release testworkers0, port3000listeners0, ownedfixtureleaks0 and profilelocks0 at final audit; unrelated CADFixer test processes preserved. Historical three worktrees clean unchanged and protecteddesignSHA30ef03b091e39dc9dbed6ad555047a6e46eda4313b9340a9777aa81b96e38cb0 unchanged. No stage/commit/push/deploy/Store operations or production modification.

Final repository-wide Playwright NEVER INVOKED in this continuation; normal globalSetup/effectivegrantedpath/actualfinalChromiumarguments proof and final suite accounting remain NOT EXECUTED, not PASS. Current targeted question acceptance has1fixtureteardownfailure/14failure-causedserialskips; each release relevant and not independent. Retained repair is source/static validated only. **BLOCKED — QUESTION-RESOLUTION REGRESSION**. R13B remains open; E4O-D-CHECKPOINT not ready; no R16 or invented qualification stage. Full mandatory94-field report: /private/tmp/xpertapply-r13b-xa09-final/final-result.md. Rollback limited to new fixture/harness/unit/plan hunks, never discard previously qualified runtime repairs or rewrite prior history.

### R13B question-resolution fixture qualification / single final release continuation (2026-10-05)

Entryfeature/assistant-window HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351,0/0,41paths,indexEMPTY,diffcheckPASS. Captured allsrc and named fixture/global hashes externally at /private/tmp/xpertapply-r13b-question-final. Prior missing local GETsession55/resume failure and14serialskips preserved. Retained remedy uses exactly the application-answer qualified document(55,resume,syntheticSessionPdf()) helper, no handler rewrite: contract equivalence13/13YES (external contract-equivalence.md). Trigger real resume upload target→prepareDocumentUploads→REQUEST_DOCUMENT→workerfetchDocument current cached bearer, GET?fmt=pdf, nonemptyPDF+filename. Unknown session404; wrong bearer401; invalidfmt422; wrongmethod405; missingroute local404 and fixture-close error, no production fallback.

External focused negative control using the same question OwnedPackageFixture/document registration: wrong bearer401/nonPDF; nonowned56session404/nonPDF; current55PDF200/applicationPDF/disposition/exactstructuralbytes; unconfiguredownedroute404/local and expectedclosefailure; requestsrecorded, production0. Fixtureunits4/4PASS, no unit changes. Existing fixed4500/2500ms sleeps in question spec replaced with trusted current-tab worker terminal/package readiness and mutation-caused newer workerupdatedAt. Original60secdeadline retained; handler unchanged; commonemployer safety checks assert privacyfalse/submitclicks0/submitevents0. Fixture acceptance requires all actual API responses200 and resumeGET200, logs sanitized structural evidence. Changes are TEST SYNCHRONIZATION/QUESTION-RESOLUTION FIXTURE/TEST, runtimeNONE. ScenarioAexactONCE1/1PASS9.1sec, all8localAPIrequests200 includingresume, externalattempts/responses[], teardownclean. Threecomplete15casequalifications now underway, no fourth if failure. Carryallpreviousqualifiedgates/Web51/970/Extension86/1338/security17/355/API2120. Final repository-wide run remainsUNUSED until prerequisites and cleanup pass. Rollbackonlynewtestsync/log/safety hunks; retain priorqualifiedPDFhandler and productrepairs.

### E4O-D-R13B FINAL release result — BLOCKED (2026-10-05)

**Verdict: BLOCKED — NEW PLAYWRIGHT FAILURE.** The single final repository-wide release invocation has been consumed. E4O-D-CHECKPOINT is not ready. No R16, additional intermediate qualification stage, favorable rerun, staging, commit, push, deployment, or Store action occurred.

The previous question-resolution Scenario A missing authenticated LOCAL GET `/application-sessions/55/resume?fmt=pdf` failure and its 14 dependent skips remain in the historical record above. The retained remedy was reviewed without rewriting its handler: question-resolution and qualified application-answer both register `document(55, "resume", syntheticSessionPdf())` on OwnedPackageFixture. All 13 contract fields match: GET/path/exact-session ownership/current fixture bearer/fmt/status/PDF content type/filename disposition/exact structural PDF/missing-session404/wrong-token401/sanitized request recording/fail-closed network containment. Focused negative authority controls PASS: wrong bearer401 non-PDF, nonowned56 session404 non-PDF, valid current55 PDF200, unconfigured authenticated routeLOCAL404 and expected fixture-close rejection without production fallback. Focused unchanged fixture units4/4PASS.

Exact Scenario A ran ONCE, worker1/retries0/original60secdeadline:1/1PASS9.1sec with all8 local API responses200, including the genuine current-session resume download, clean teardown, unchecked consent and employer submitclicks0/events0. Then the entire15-case question-resolution suite ran EXACTLY3 consecutive complete times: run1 15/15PASS1.8min; run2 15/15PASS1.8min; run3 15/15PASS1.7min. Total45/45, skips0, teardownerrors0, externalattempts/responses0. No fourth targeted run. Authorization Yes/No, combined sponsorship and qualified options, missing-answer preservation, verification failure, contradictory custom control, idempotence, closed/delayed/read-only enumeration, unopenable-actuator failure, ledger coherence and consent/submit safety all passed. Existing question fixed4500/2500ms sleeps were replaced with current-tab worker terminal/package authority and mutation-driven newer workerupdatedAt, without deadline increases. Added common consent/submit checks and sanitized fixture acceptance logs. PDF handler/owned fixture/unit/globalSetup unchanged; runtime/unit source hashes match entry.

Prior qualified browser gates and fresh Web51files/970, Extension86files/1338, security17files/355 and API2120 were carried without repeating their large matrices. Fresh strict browser-harness/config typecheck, production/development/granted manifest validation, docker compose config--quiet and diffcheck PASS. Prior product/dev/Web builds carried; normal final globalSetup itself freshly built both injectable adapter harness and granted extension. Added test-only release-network-boundary/config import to deny unmatched Chromium DNS, retain explicit owned-loopback mappings and fulfilled origin mocks, and audit response destination addresses. This source is not part of the shipped extension.

Final command used normal playwright.config/globalSetup and normal order/deadlines, worker1/retries0/max-failures0/list+JSON reporting. Explicitly unset XA_E2E_SKIP_BUILD and XA_E2E_DIST, plus all known diagnostic/negative flags. Setup assigned exact `/Users/cprakash/Developer/XpertApply-assistant-window/apps/extension/dist-e2e-granted`. Before the first test body the launch record showed skipBuildnull, effectiveDist exact and matching load-extension/disable-extensions-except exact. The baseline was freshly built, not substituted with production or stale output. Existing permission-specific fixtures retained their distinct manifests: handoff subset3 launches, production bridge-negative dist3, Stage3C employer subset1 and Stage3C granted subset3; these are separately reported and are not claimed to be ordinary exact-granted contexts. XA13 also prepares a disposable instrumented copy, which exposed the new launch-guard defect below. No concurrent external build workload.

**Exact sole final Playwright result:167 total /77PASS /90FAIL /0SKIP, exit1,12.2min.** No flaky classification, retries or second full invocation. Failure breakdown:89 injectable-harness initialization failures and1 XA13 launch-guard failure. The freshly built `src/e2e-harness.ts` imports questionLedger from content/bootstrap; retained bootstrap.ts:147 captures `chrome.runtime` at module initialization. Ordinary fixture/file pages lack the chrome global, causing ReferenceError `chrome is not defined` before JobPilotHarness publishes; semantic calls then fail on an undefined harness. Seven crossframe evaluate calls report the initialization exception directly;82 uncaught browser page-error events are recorded in retained failure traces. This is concrete retained-source/harness dependency evidence, not a flaky result. No product correction was made in this continuation.

The additional XA13 failure was introduced here by the new network-boundary allowed-build basename assertion: it rejects the legitimate `xa13-dist-*` instrumented bundle copy before launch. This test-harness defect is retained and explicitly reported rather than hidden, weakened, fixed after the final source snapshot, or favorably rerun. The two blocking findings are recorded in comprehensive-hunk-audit.json and final-failure-analysis.md. No claim that the full current-source browser release gate passed.

Final release-invariant gates that did pass within the sole full invocation include application-answer17/17, question-resolution15/15, first-party/canonical overlay2/2, all-frame recovery1/1, worker/frame coherence1/1, real-extension5/5, required-reviewguard1/1, session-handoff4/4, Stage2F9/9, XA09real1/1, XA10real1/1, XA11 1/1, XA12account3/3 andteardown1/1, XA15 4/4, XA16/XA19 1/1 andStage3C7/7. These positives do not override the90 failures. No final skip was present; skip table has no rows, failure-caused skips0.

Final reporter/globalSetup errors0; teardown error indicators0. There were162 completed browser-context network audit records,70 extension launch records and0 external destination observations. Final transmitted requests to api.xpertapply.com/xpertapply.com/www.xpertapply.com0, successful external0; synthetic fulfilled mocks and explicitly mapped loopback HTTPS are distinguished from production. Final owned browser roots/children/workers0, temporary profilelocks0, port3000listeners0, other fixture/Node listeners0. No unrelated process was killed. Resource/listener inventory is retained externally.

Comprehensive retained-hunk review COMPLETE:43 paths,311 non-plan hunks and1 append-only plan hunk, every hunk inventoried/classified with header/hash; UNEXPECTED0. This scope classification does not certify the two identified functional defects. Reviewed runtime changes concern event-driven invalidations, bounded recovery, frame/current-worker authority, passive auto-open repair, safe-limit presentation, workflow/required-review/completion coherence and live content-instance ownership; tests preserve original semantic and safety assertions; documentation preserves prior failures. No generated artifact or external evidence file is tracked. Final active retired outer-widget dependencies0; unused widget-driver/manual tooling literals are explicitly classified, and the current nested review facade is distinct from retired outer-host authority.

ManifestV3/version0.2.0; exact permissions activeTab/sidePanel/storage/scripting/tabs, webNavigationABSENT, production/optional hosts unchanged, no new shipping privilege/auth weakening/periodic polling or timer/consent/legal/final-submit automation. Popup and SidePanel fallbacks kept. Exitmanifest profiles PASS. Entry41 paths grew to43 only through playwright.config import and new release-network-boundary helper; question test and this plan were edited within existing paths. Runtime/unit deltasNONE. IndexEMPTY, HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351, ahead0/behind0, diffcheckPASS. Historical auth-evolution/store-release/prod-auth-release read-only clean unchanged; both protected design-system SHA256 values remain30ef03b091e39dc9dbed6ad555047a6e46eda4313b9340a9777aa81b96e38cb0. No production modification.

Mandatory98-field report, exact43 changed paths, all90 failure titles/errors, empty skip table, equivalence table and source/hash audits: `/private/tmp/xpertapply-r13b-question-final/final-result.md`. Raw sole invocation final.json/final.log/final-results, targeted run logs, fixture negatives, units, static gates, network/resource/historical/cleanliness and per-hunk evidence remain outside Git under the same directory. Rollback scope for this continuation is limited to question synchronization/safety/logging, the new test-only network-boundary helper/config import and this append-only record; retain previously qualified product and fixture work. R13B remains blocked; checkpoint not ready; final full run is consumed and cannot be described as unused or silently repeated.

Final post-run cleanliness correction: the owned XA12 next-dev server generated apps/web/AGENTS.md and CLAUDE.md and changed next-env.d.ts imports to .next/dev/types. Creation timestamps match that test, and Next generate-agent-files.js confirms the producer. Archived all3 generated byte sequences externally, restored next-env.d.ts to exact verified clean-entry HEAD bytes, and removed only the2 generated untracked files. No unrelated work removed. Recomputed retained set43paths/311nonplan/1plan/UNEXPECTED0,2 disclosed blocking findings; stagingEMPTY/diffcheckPASS/runtimehashesunchanged. Protected/historical read-only exit checks PASS.

### R13B demonstrated final-Playwright blocker repair — in progress (2026-10-05)

The previous sole full release run remains167total/77PASS/90FAIL/0SKIP, with89 ordinary-page bootstrap initialization failures and1 XA13 launch-basename failure. This continuation explicitly repairs only those roots and does NOT authorize a repository-wide Playwright run. Entry43paths/HEADupstream738523e56bed89cbccad5d24afa5e12266927351/ahead0behind0/indexEMPTY/diffcheckPASS, byte snapshots and evidence under /private/tmp/xpertapply-r13b-blocker-repair.

B0harness imported bootstrap for questionLedger; B1bootstrap module read bare chrome.runtime at147 before harness publication; B2ordinary pages lack extension APIs; B3pure DOM harness functions need only a ledger; B4real content ownership liveness needs the genuine isolated-world runtime. Moved the pure singleton into workflowLedger, imported/re-exported it from bootstrap and imported it directly from the harness. Runtime ownership initialization is conditional on runtime capability and captures requireWorkflowRuntime only inside that extension path; required absent-capability calls throw EXTENSION_RUNTIME_UNAVAILABLE. Genuine runtime liveness, worker-derived sender/session/frame/document/generation checks and same-document ownership retained. Existing content-script isolation structurally separates page fake Chrome from production Chrome authority; pure harness loading/algorithms with fake runtime invoke no fake messaging or manifest API. All33 existing harness exports unchanged; no new privileged export in JobPilotHarness. Runtime bare Chrome references6→5; module-initialization bare references1→0, all remaining references inside required extension paths.

Added focused absent-Chrome bootstrap/import/export, required-runtime-negative, fake-page Chrome and isolated-manifest tests. Temporary exact bare chrome.runtime restoration failed the ordinary bootstrap regression with ReferenceError chrome is not defined. Restored repaired bootstrap byte-exact in finally; positive4/4PASS. Initial new test tooling failures (jsdom/esbuild realm, Node URL environment, macOS /var→/private/var canonicalization, absent disposable permission fixtures) were corrected before any browser qualification; retained debug logs are not claimed as positive qualification. Focused5files/75PASS; security19files/325PASS; full Extension88files/1344PASS77.19sec versus prior86/1338. Static Extensiontype/prodbuild/devbuild/strictbrowserharness/manifests/composequiet/diffcheck allPASS. Web970 andAPI2120 carried; no Web/API source changes.

XA13 copies exact approved dist-e2e-granted to creator-allocated canonical tempdir and instruments probeFrame plus an owned loopback manifest grant. Replaced broad basename matching with exact normal source path; exact existing permission builds are additionally restricted to their owning Playwright spec. A dedicated XA13 creator owns allocation/copy/known instrumentation and stores exact canonical derivative path, approved source and unambiguously framed SHA256 digest in a private registry; no arbitrary-path registration API. Guard requires current XA13 spec and unchanged symlink-free derivative bytes. Normalbuild and deliberate fixture paths accepted only in their existing scope; arbitrary sibling/same-basename/temp copy/traversal/symlink/mutated derivative/wrong-owner/wrong-source controls rejected. Canonical /private temp allocation retains alias rejection. XA13 cleanup now covers creator/launch errors and closes server connections. XA13run1 1/1PASS7.0sec; run2 1/1PASS5.6sec; run3underway; no fourth. DormantDOMprobes0/mutationObservers0, real authorizedprobe1, transmittedexternal0 in both completed runs. Next is the exact14-family group from retained89-failure inventory, once only, with stop on first new semantic failure. No previous green large browser matrix is rerun.

### R13B final-Playwright blocker repair — targeted exit BLOCKED (2026-10-05)

**BLOCKED — NEW SEMANTIC BROWSER FAILURE.** XA13 completed EXACT3 consecutive positives:1/1PASS7.0sec,1/1PASS5.6sec,1/1PASS6.9sec. Every run used normal fresh globalSetup,worker1/retries0/original60secdeadline, exact approved source→creator-owned canonical instrumented derivative, dormantprobe0/mutationobserver0/authorizedprobe1, loopbackresponses2/external0; derivative disposed and owned server closed. No fourth.

Affected-family group ONCE selected only the14 retained bootstrap-failure specs (92planned cases:89previously failed+3green cases in those same families), normalglobalSetup/order/deadlines,worker1/retries0/max-failures1 to implement the required immediateSTOP. Result76PASS/1FAIL/15didnotrun, exit1,32.6sec. Of89previously blocked cases,73nowPASS,1fails during an actual initialized harness operation and15remainunqualified. Chrome-is-not-defined failures0 and missing-JobPilotHarness-method failures0. All33 export names remain byte-source inventory equivalent; no privileged harness expansion.

Current failure: roleless-dropdowns.spec.ts:125 “both answers commit through a mousedown-toggled trigger and a role-less portaled menu,” at132 page.evaluate→JobPilotHarness.tiktokActuate. Actual error “Target page, context or browser has been closed.” Harness initialization succeeded; the preceding role-less discovery test passed and the failing evaluation entered the current method. This is a NEW current browser execution failure, not the old bootstrap cause. Its cause is not established and no product semantic root cause is asserted or called flaky. Qualification stopped immediately; no source repair, extra browser invocation or favorable rerun after this failure. Fifteen remaining cases are failure-caused unexecuted cases, not independent intentional skips; all titles/reasons are in the mandatory report. Reporter records one max-failures stop annotation, disclosed separately from a diagnosed product/global exception.

Prior full release failure remains167total/77PASS/90FAIL/0SKIP. Repository-wide Playwright was NOT invoked in this continuation. It is not ready under this continuation’s finite pass policy; no R16/intermediate stage or checkpoint. Future continuation must first address/dispose the current browser failure and remaining affected qualification before claiming readiness for the explicitly separate one post-repair repository-wide gate.

Focusedunits5files/75PASS; explicit temporary bare-runtime negativeFAIL with ReferenceError chrome-is-not-defined, restored repaired bytes exactly and positive4/4PASS. Focusedsecurity19files/325PASS; fullExtension88files/1344PASS77.19sec/typecheck/prodbuildPASS. Test-only derivative digest framing was subsequently tightened and covered by fresh focused security/provenance tests and3XA13 browser passes. Final sequential Extensiontype/prodbuild/devbuild/strictharness/manifestvalidation/composequiet/diffcheckPASS; Web970/API2120carried, unchanged. No additional heavy or browser qualification after requiredSTOP.

Final network audit:api.xpertapply.com/xpertapply.com/www.xpertapply.com transmitted0, successfulexternal0 across all targeted browser contexts. Final ownedbrowserroots/children/workers0, profilelocks0, port3000listeners0, ownedfixturelisteners0; no unrelated termination. Permissions exactactiveTab/sidePanel/storage/scripting/tabs, MV3/version0.2.0,webNavigationABSENT,production/optionalhostsunchanged,popup/sidepanelfallbacksKEPT,no newauthweakening/polling/timer/consent/legal/final-submit automation. instance/messages/background/config/globalSetup entryhashes unchanged; shared ledger moves no authority into page-main-world; required runtime absent fails explicitly, fake page runtime cannot control isolated content/worker sender authority.

New/directly modified continuation hunk audit COMPLETE:10continuationpaths,18hunks (17nonplan+1append-onlyplan), allowedBOOTSTRAPCAPABILITYBOUNDARY/HARNESSINITIALIZATION/XA13FIXTUREPROVENANCE/RELEASELAUNCHGUARD/TEST/PLAN; UNEXPECTED0. Prior311-hunk historical audit carried, not repeated. Finalauthoritative49paths (entry43+previouslycleantrackedharness/XA13spec+4newpure-ledger/provenance/unitfiles), stagingEMPTY,diffcheckPASS,HEADupstream738523e56bed89cbccad5d24afa5e12266927351,0/0. Historical3worktrees clean/unchanged and protecteddesignSHA30ef03b091e39dc9dbed6ad555047a6e46eda4313b9340a9777aa81b96e38cb0 unchanged. No liveproductionaccess/modification,stage,commit,push,deploy,Store action.

Complete83-field report/exact49paths/affectedfailure/15unexecutedtitles/sourceinventories/negativeprovenance/units/security/fullExtension/static/XA13/group/network/resource/historical/newhunk evidence remains outsideGit at /private/tmp/xpertapply-r13b-blocker-repair/final-result.md and sibling artifacts. Rollback is limited to these narrow bootstrap/ledger/harness and launch-provenance/fixture/test/tsconfig hunks; preserve all previously qualified product work and historical failed full-run record. The root repairs are retained as reviewable candidates; complete affected-family acceptance is NOT claimed PASS.

### R13B roleless lifecycle investigation and launch repair (2026-10-05)

Retained prior affected-family76PASS/1FAIL/15notrun remains unchanged. Entry49paths/feature/assistant-window/HEADupstream738523e56bed89cbccad5d24afa5e12266927351/ahead0behind0/indexEMPTY/diffPASS; entry byte/hash snapshots outside Git at /private/tmp/xpertapply-r13b-roleless. Roleless cases have fresh test-owned Playwright page/context; only browser is worker-scoped. No fixture server, shared DOM, harness globals, menu nodes or DOM listeners. Actuator uses bounded dropdown transactions, no navigation/close/submit/window.close/anchor path; network boundary audits only existing context teardown and DNS containment, no spontaneous cleanup.

Standalone uninstrumented diagnostic1PASS6.4sec (initial instrumentation script path error disclosed); traced standalone1PASS and exact ordered pair2PASS6.1sec. Neither success dismisses retained failure. Retained trace first actuator succeeds and all authorization assertions pass; sponsorship evaluate fails96ms after start, before After Hooks. Instrumented original prefix reproduces76PASS/1FAIL/1notrun: L0-L8 healthy, L9 starts; pageclose31688.270ms, contextclose31689.075ms, browserdisconnect31689.299ms; cleanupfalse on all; worker alive. L10-L14 not reached. Root browser70749 exitscode0/signalnull; no pagecrash/popup/navigation/download; page/context dead, browserdisconnected.

macOS unified logs prove original68984 and reproduced70749 received loginwindow forcequit/callback then Quit AppleEvent; original21:21:28.595, reproduced21:43:55.527; AppKit approves termination then proc_exit. Reproduced LaunchServices CHECKIN70749 identifies com.openai.codex, inherited desktop host identity; OS exit record labels ChatGPT.app. No assertion that a human or specific external app requested the quit: requestor not disclosed by OS logs. Root classification BROWSER_PROCESS_EXIT_DEFECT: unbundled macOS headless shell registers under host app identity and is externally terminated ~30sec after check-in. This is not test synchronization or product semantics.

Narrow test-config repair: on darwin set channel chromium, using same installed Playwright Chromium1243 revision in its own bundled application identity. No runtime/provenance/network/authority helper changes; same DNS confinement, fresh globalSetup/harness/grantedbuild, workers1/retries0/original deadlines. LaunchServices CHECKIN70974 proves com.google.chrome.for.testing. Repaired exact-prefix diagnostic78/78PASS1.1min, all roleless controls commit, browser healthy beyond prior exit boundary.

Negative controls: temporarily restore ONLY original config default unbundled-headless launch, original prefix fails77PASS/1FAIL in third roleless case with browserclosed; restored repaired config byte-exact finally. Temporal OS exit means that restoration alone cannot deterministically choose a specific test at the thirty-second boundary. Additional exact second-case failure-mode negative closes ONLY its test-owned browser at sponsorshipL9, causing same page.evaluate Target page/context/browserclosed; restored spec byte-exact finally. This is an explicitly scoped failure-mode control, not a claimed reproduction of the Quit AppleEvent sender mechanism. No OS desktop app quit, unrelated process kill, arbitrary sleep, timeout increase, retry, automatic reopen or swallowed closed-target exception.

Retained test-only roleless observations capture monotonic L0-L14, sanitized URL, healthy/disconnected/pageclosed/context count, workerPID, close/crash/error/navigation/popup/newpage/download. Added final healthybrowser/context/page, no unexpectedlifecycleevents and no-submit assertions for every roleless case. L1 is setContent on about:blank; LIVE_URL is adapter classification metadata, not production navigation. L3 now verifies discovered controls. Architecture/rollout: only local E2E config/spec qualification; shipping extension unchanged; rollback only darwinchannel selection and roleless observation/assertion hunks, retain prior qualified areas and history. Ten complete roleless runs, one neighbor smoke, and one exact14family92case run underway; repository-wide gate deliberately not invoked.

### R13B roleless lifecycle final result — PASS (2026-10-05)

**PASS — AFFECTED BROWSER FAMILY FULLY QUALIFIED; READY FOR ONE POST-REPAIR REPOSITORY-WIDE PLAYWRIGHT RUN.** Root classified BROWSER_PROCESS_EXIT_DEFECT with macOS Quit AppleEvent/incorrect headless-shell LaunchServices identity evidence and post-repair own bundled browser identity proof. No UNKNOWN lifecycle cause remains; the OS does not disclose the requestor behind loginwindow's quit callback, so no human/application requestor is invented. Product defectNO; test-browser launch defectYES. Original/reproduced page→context→disconnect before cleanup atL9 preserved, browser exitscode0, worker alive; roleless has no fixture server. Standalone/orderedpair positives were diagnostics, not a flakiness dismissal. Repaired78/78prefixdiagnostic and both negative controls/byte-exact restoration recorded above. No runtime/harness/authority/network source changes.

Exactly10 complete roleless qualification invocations, fresh normalglobalSetup,worker1/retries0/originaldeadline: run13/3PASS11.22sec, run23/3PASS10.96sec, run33/3PASS9.62sec, run43/3PASS9.61sec, run53/3PASS12.29sec, run63/3PASS12.34sec, run73/3PASS10.96sec, run83/3PASS10.74sec, run93/3PASS10.73sec, run103/3PASS10.47sec. Total30/30PASS; each3case suite completes; healthybrowser/context/page through final assertions; unexpectednavigation/crash/close/popup/newpage/download0; submit events0. Page/context close only during owned Playwright teardown, browser gracefulexitcode0/signalnull. No eleventh roleless qualification loop.

TikTok neighbor specs ONCE: applicationadapter2/2PASS, portal4/4PASS, total6/6PASS7.58sec. Both approved host metadata, currentcontrol reacquisition, authorization/sponsorship, decoratedtrigger, overlappingstaleportal, contradictoryvalue rejection, privacyunchecked/manualconsent and nosubmit assertions preserved.

Exact SAME14 affected families ONCE, fullcaseaccounting without maxfailure truncation: **92planned/92PASS/0FAIL/0SKIP/0notrun,94.21sec,exit0**. NormalglobalSetup built harness+exactdist-e2e-granted; skipbuildunset; worker1/retries0/normaldeadlines; no favorable individual rerun. Chrome-not-defined0, missingharnessAPI0, ordinaryharnessinitfailures0, newsemanticfailures0; XA13 not rerun (prior3/3/provenance qualification carried). Previously15 interrupted cases all executed successfully.

Focused existingunits5files/79PASS14.93sec; security19files/325PASS and fullExtension88files/1344PASS carried because runtime/unit source unchanged and authority helpers unchanged. Web970/API2120 and all named priorqualifiedmatrices carried without repeating. Fresh strictbrowserharness/config/roleless typecheck, Extensiontypecheck, productionbuild, developmentbuild, production/development/grantedmanifestvalidation,composequiet,diffcheckPASS. No migrations applicable.

All positivequalification networkaudit128records/externaldestinations0; api.xpertapply.com/xpertapply.com/www.xpertapply.com transmitted0, successful external0. Fulfilledmockoriginresponses and ownedloopback remain distinguished.12positive browserroot exits allcode0/signalnull after gracefulownedcleanup. Exitownedbrowserroots/children/testworkers0,profilelocks0,port3000listeners0,fixtureleaks0; unrelatedlisteners/processes preserved. Historical3worktrees clean/unchanged and bothprotecteddesignSHA30ef03b091e39dc9dbed6ad555047a6e46eda4313b9340a9777aa81b96e38cb0 unchanged. Shippingruntime/source/permissions/hosts/fallbacks unchanged; no consent/legal/final-submit automation.

Continuationhunkreview13hunks across3paths: rolelessspec(TESTPAGE/CONTEXTOWNERSHIP,TESTCLEANUP,PORTALLIFECYCLE,TEST),playwrightconfig(TESTCONTEXTOWNERSHIP,TEST),appendonlyplan(PLAN); UNEXPECTED0. Entry49/final50authoritativepaths; exactlyone previouslycleantrackedrolelessspec added to retained changedset. Prior311historicalhunkreview carried, not repeated. IndexEMPTY;branchfeature/assistant-window;HEADupstream738523e56bed89cbccad5d24afa5e12266927351;ahead0behind0;diffcheckPASS. No stage,commit,push,deploy,Store,liveproductionaccess or R16.

Complete97-field report/exact50paths/lifecycleL0-L14/OSlogs/negativecontrols/10roleless/neighbors/92cases/unit/static/network/resource/historical/hunk evidence: /private/tmp/xpertapply-r13b-roleless/final-result.md. Original blocked histories remain intact. Rollback only macOS bundledchannel selection and test-only lifecycle observations/assertions; preserve previouslyqualifiedruntime. **STOP. Repository-wide Playwright NOT RUN in this continuation. NEXT: SAME R13B — ONE POST-REPAIR REPOSITORY-WIDE PLAYWRIGHT RELEASE RUN**, separately authorized, normalglobalSetup, XA_E2E_SKIP_BUILDunset, XA_E2E_DISTsuppliedbysetup,exactdist-e2e-granted,worker1,retries0,nofavorablererun. IfthatPASS,nextE4O-D-CHECKPOINT. No R16/commit/push.

### R13B one post-repair repository-wide release result — PASS (2026-10-05)

**PASS — R13B COMPLETE; E4O-D READY FOR CHECKPOINT. NEXT: EXTENSION RELEASE STAGE E4O-D-CHECKPOINT. STOP.** Exactly one post-repair repository-wide Playwright invocation consumed; no second invocation, individual favorable rerun, retry, stress loop, new R16, staging, commit, push, deployment or Store action. Existing targeted work is complete and carried; no product/test/config repair in this observation stage. Prior failed full-release and targeted lifecycle histories remain unchanged.

Preflight exact50authoritativepaths; branchfeature/assistant-window; HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351; ahead0behind0; indexEMPTY/diffcheckPASS. Byte-exact qualified darwinchannelchromium1243/ownbundledidentity, bootstrap/workflowLedger ordinary-harness boundary, exactsource/owner/canonical/digest XA13provenance, failclosednetwork, currentquestionresumePDF/currentfixtureauthority, XA09fixturecredential, requiredreview/currentworker guard, same-document liveowner preserved. All temporary negative mutations absent and XA/E4OD diagnostic flagsunset; no temporaryobserver/processmonitor/reporter loaded or shippingtrace instrumentation added. Ownedroots/children/testworkers/Webservers/APIfixtures/profilelocks/port3000/otherfixturelisteners0 beforelaunch; unrelatedprocesses untouched.

Command from apps/extension: ./node_modules/.bin/playwright test --workers=1 --retries=0 --max-failures=0 --reporter=list,json --output=/private/tmp/xpertapply-r13b-postrepair-final/final-results. Normal playwright.config.ts/globalSetup, normalrepositoryorder/timeouts, no fixedsleep/timeoutinflation or parallelbuild. XA_E2E_SKIP_BUILDunset and XA_E2E_DISTunset beforeglobalSetup. Setup freshlybuilt injectableharness and grantedextension, selected exact /Users/cprakash/Developer/XpertApply-assistant-window/apps/extension/dist-e2e-granted.71extensionlaunchrecords allskipBuildnull/effectiveDistexact/load-onlymatching.60ordinarylaunches exactgranted; deliberateowner-scoped exceptions handoff3,productionbridge-negative dist3,Stage3Csubset1,Stage3Cgranted3,XA13creator-ownedcanonicalderivative1. No authorization broadened or arbitraryderivative accepted.

**Sole full result167total/167PASS/0FAIL/0SKIP, exit0,1031.25sec (17.19min).** FirstfailureNONE/rootgroupsNONE/failurecausedskips0/globalerrors0/worker-teardownfailures0. All32release-specfiles execute. Applicationanswer17/17,questionresolution15/15,affected14families92/92,roleless3/3,TikTokneighbors6/6,XA09real1/1+performance1/1,XA10real1/1+clear2/2,XA11 1/1,XA12account3/3+teardown1/1,XA13 1/1,XA16/XA19 1/1,Stage3C7/7,canonicaloverlay2/2,allframerecovery1/1,requiredreview1/1,workflowcoherence1/1,realextension5/5,handoff4/4,Stage2F9/9,XA15origins4/4 andremainingATS/navigation/dropdown/WebcomponentwatchlistPASS. Chrome-not-defined0,undefined/missingharness0,pureharnessEXTENSION_RUNTIME_UNAVAILABLE0,XA13provenancefailure0,roleless-targetclosed0,newsemanticfailure0. XA13MV3telemetry dormantprobe0/dormantobserver0/authorizedprobe1. ResumePDF fixture and manualconsent/submit safety assertionsPASS.

Built-in Playwright browser/protocol observation preserves actual lifecycle evidence without changing suite source.272unique observedpageTargets/289page-targetdetachments, every detach matched preceding ownedclose/contextdisposal/inspector-detach/gracefulshutdown; unexpectedtargetloss0.92explicitcontextdisposals plus71persistentcontexts;163completedcontextnetworkaudits.72browserroot exits allcode0/signalnull afterownedgracefulclosestart; unexpectedbrowserexit/disconnect0. Rolelessprecleanupclose/crash/navigation/popup/download events0. macOS ownedPID audit:72CHECKINidentitiescom.google.chrome.for.testing,QuitAppleEvent0,forcequit0. No future failure automatically attributed to repaired macOS issue.

Actualuncaughtpage-targeterrors0. Protocol recorded24runtimeexceptionevents, ALLservice_worker, identical Error:The browser is shutting down; EACHbound to its exactowningrootPID alreadyinownedgracefulshutdown. These expected cleanup-only worker exceptions are explicitly disclosed in report/accounting, not hidden as zero totalruntimeevents; no active test assertion or invariant affected.8Inspector.targetCrashed-shapedserviceworker events correspond exactly to existing explicitphysicalStopoperations: canonicaloverlay2/allframerecovery5/workflowcoherence1; targettype/root/completing-spec evidence retained, no unexpected/excesscrash0. These intended worker restart controls are distinct from page/browsercrash.

Finalnetwork163contextaudits:553ownedloopbackresponses+150fulfilledmockresponses, externaldestinationobservations0; api.xpertapply.com/xpertapply.com/www.xpertapply.com transmitted0, successfulexternal0. Production-shaped hosts mapped to ownedloopback and fulfilled mocks identified separately. Exitownedbrowserroots/children/testworkers/profilelocks/port3000/fixturelisteners0; no unrelatedtermination. CurrentmanifestV3/v0.2.0/exactactiveTab,sidePanel,storage,scripting,tabs;webNavigationABSENT; sourceproduction/optionalhostsbyteunchanged; grantedonlyexistingloopbackadditions; Popup/SidePanelfallbackfilesKEPT. No newpermission/authweakening/pollinginterval/runtime-timerworkaround/consentlegalautomation/employerfinalsubmitautomation.

Finallegacyactivecount0. All6retiredliteralexceptions explicitlyclassified:4unusedWidgetDriverrollbacksource lines and2manualpages-tooling lines; noactive-specimports. Currentnestedcanonicalcompatibility/reviewfacade separatelyclassified; currentoverlay/ATSgeometrychecks do not resolve retiredouterhost or obsoletefooter/bodysummaryauthority.

OwnedXA12Nextdevserver generated apps/web/AGENTS.md,CLAUDE.md andnext-env.d.ts .next/dev/types imports. These are known generator artifacts, not product/test/config repair. Capturedcleanentrynext-env bytesbeforeWebserver startup; archived all3generated byte sequences externally, verifiedexactgeneratorheader/@AGENTS.md contents and deterministic types-pathrewrite, restored trackedentrybyte-exact and removedonly2ownedgenerateduntracked files. No unrelatedworkremoved. Premature accounting attempt before finalJSON existed produced an externalscript FileNotFoundError only; no test failure, source change or rerun; finalactualreporterJSON was subsequently parsed successfully.

Finalexactpathset equalsentry50; all entryruntime/harness/test/config hashes unchanged; newcodehunks0, oneappend-onlyplanhunkreviewed,UNEXPECTED0; indexEMPTY/diffcheckPASS. Historicalauth-evolution/store-release/prod-auth-release worktrees clean/exactheadsunchanged; bothprotecteddesignSHA25630ef03b091e39dc9dbed6ad555047a6e46eda4313b9340a9777aa81b96e38cb0 unchanged. Productionaccess/modificationNONE. No extraqualification afterPASS.

Carriedtargetedquestion45/45,applicationanswer17/17,fullreload10/10,same-documentreopenqualified,XA09/XA10/XA11/XA13/XA16-XA19 each3/3,canonicalreopen10/10,firstpartyWeb1/1,Stage3C/overlay/recovery/requiredreviewPASS,roleless10complete/30cases,TikTok6/6,affected92/92;focusedunits79/79,security19files/325,Extension88files/1344,Web970,API2120 andpriorstatic/buildPASS withoutrepeatinglarge matrices.

Mandatory106-field report/exact50paths/full167titles/fileaccounting/emptyskiptable/24shutdownworkerexceptions/8explicitstops/launchprovenance/network/OS/resources/legacy/manifest/source/historical/protected/audit/generatedcleanup evidence outsideGit: /private/tmp/xpertapply-r13b-postrepair-final/final-result.md andsiblings. Rollout remainslocalreleasequalification; rollback in this observation continuation onlythisappend-onlyresult, preserveallqualifiedsource. NEXT E4O-D-CHECKPOINT mayconsumeallR14/R15/R13Bevidence andreview/stageexplicitpaths only underseparatecheckpointauthorization; NEVERgitadddot/add-A; expectedparent738523e56bed89cbccad5d24afa5e12266927351, exactfuturecommitmessage perf(extension): use event-driven assistant state updates, thenverifyclean/ahead1/behind0;DO NOTPUSH. No checkpointcommit performed in this stage.


### E4O-D checkpoint diagnostic cleanup — qualified (2026-10-05 Phoenix)

The checkpoint stopped before staging because the qualified roleless test retained investigation instrumentation. Removed only its lifecycle event/console observers, checkpoint state and L0–L14 logs, timestamp collection, PID/browser trace output and diagnostic event array. No negative-control support remained. Replaced the tracing fixture with direct permanent after-test assertions for connected browser, live owned page, one-page context, unchanged about:blank URL and no submit event. Preserved semantic discovery, both eligibility actuations, verified display/backing values, portaled-menu behavior and final required-control counts; consent remains manual and no employer Submit is automated.

Strict TypeScript covering cleaned roleless/config/network/provenance helpers and git diff --check PASS. Clean roleless source passed exactly ten consecutive complete runs, each 3/3 (30/30); TikTok neighbors passed once 6/6; the exact fourteen-spec affected family passed once 92/92, failed0/skipped0/retries0 with normal setup/deadlines and the unchanged macOS bundled Chromium identity. No eleventh run or repository-wide rerun. No chrome-not-defined, missing harness API, target-closed or new semantic failure. All 128 completed context network audits reported external0; api.xpertapply.com/xpertapply.com/www.xpertapply.com transmissions0 and successful external0. Twelve owned browser roots exited code0/signalnull; owned roots/children/workers/profile locks/port3000/fixture listeners0 at exit.

All 192 extension src file hashes (including all shipping runtime) unchanged from entry; playwright.config.ts, bootstrap, workflowLedger, e2e-harness, release-network-boundary and extension-build-authority unchanged. Only roleless test cleanup and this append-only plan record changed in this continuation. Source/repository diagnostic marker search returned0; final roleless tracing helpers/process logs/negative controls/only/skip0, timeout/retry changes0. Reviewed cleanup hunks as TEST DIAGNOSTIC CLEANUP, PERMANENT SAFETY ASSERTION, TEST and PLAN; UNEXPECTED0. Entry/exit changed set50, added0/removed0 because permanent roleless assertions remain. Historical worktrees and protected copies unchanged; indexEMPTY, HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351, ahead0/behind0. No stage/commit/push/deploy/Store action or production access.

Carry the closed global release run167/167, Extension88files/1344, Security325, Web970 and API2120; no runtime/config change warrants repeating them. Evidence remains outside Git at /private/tmp/xpertapply-checkpoint-cleanup. Rollout: return to checkpoint review; rollback for this continuation is only the test cleanup and this append, preserving qualified product repairs. PASS — CHECKPOINT DIAGNOSTIC CLEANUP QUALIFIED; RETURN TO E4O-D-CHECKPOINT. NEXT: EXTENSION RELEASE STAGE E4O-D-CHECKPOINT. No commit in this cleanup stage.


### E4O-D final checkpoint hygiene sweep — blocked on clean-source readiness (2026-10-06)

Checkpoint residue R15_BOOTSTRAP was output-only: its storage/frame queries returned solely to console and neither asserted nor mutated fixture state. The complete50-path sweep removed that snapshot, spec checkpoint/console dumps, evidence writes/screenshots/report-only queries/arrays, timestamp-only observers and XA12 sender/timeline recording. Removed retired E4OD polling-baseline controls and XA13 eager-probe negative mode; positive canonical path/owner/digest provenance remains intact. Required-review's temporary environment selector became two explicit permanent cases preserving both unresolved-form and user-confirmed resolution/completion branches. Owned profiles use tmpdir allocations and existing cleanup. Retained all permanent semantic/safety assertions and assertion-backed readiness, native Stop/epoch, document topology, idle/query/timer, submit/consent and request/response mechanisms. Remaining console calls are only RELEASE_NETWORK/RELEASE_LAUNCH, required for fail-closed destination/provenance accounting; historical plan text preserved. Detailed path/line/classification of all remaining lexical hits is outside Git.

Strict TypeScript across all13 edited spec/helper paths and diff check PASS. All192 src files (shipping runtime plus units), Playwright config, network boundary and owned-package fixture unchanged; only the test build-authority helper changed to delete its temporary eager-probe parameter/branch, with positive authority checks retained. No unit source edits. Exact entry/exit set50, added0/removed0. Reviewed60 source cleanup hunks as TEST DIAGNOSTIC CLEANUP / PERMANENT TEST ASSERTION / TEST and this append as PLAN; UNEXPECTED0. Final AST/search: active only/skip/debugger0, diagnostic-only executable logs/observers/queries/timing/negative/process tracing0, source evidence artifacts/absolute diagnostic paths/real-secret findings0; no timeout/retry increase. The existing sixty-second windows remain measured idle assertions; five-second diagnostic dump pause removed.

Clean R15 runs1–6 each passed1/1. Run7 failed the unchanged matched CONTENT_READY readiness assertion at r15-workflow-coherence.spec.ts:74: expected2 current matched frames, observed0 within existing5000ms. Global runner errors0; seven network audits external0 and all seven owned roots exited code0/signalnull. This is an observed clean-source readiness qualification failure; causality remains unproven and must not be labeled a generic test flake. The runner stopped on failure: runs8–10, other cleaned specs, directly dependent provenance tests and selected required-review neighboring smoke NOT RUN. No favorable rerun or inline repair. Exit owned browser roots/children/workers/profilelocks/port3000/fixturelisteners0. Qualification input hashes remained frozen throughout seven invocations.

Carry closed global167/167, Extension88files/1344, Security325, Web970 and API2120 because product/runtime/config did not change; the broader cleaned test source remains unqualified. Evidence and full74-field result outside Git at /private/tmp/xpertapply-final-hygiene. Automatic review rejected proposed broad rewrites before execution; dependency proof and explicit context-checked patches subsequently approved, so no rejected action was bypassed. Rollout is blocked before checkpoint; rollback, if separately requested, is only this test/helper cleanup and append while preserving all qualified product work. HEAD/upstream738523e56bed89cbccad5d24afa5e12266927351, ahead0/behind0, indexEMPTY; no stage/commit/push/deploy/Store action. BLOCK — R15 CLEAN-SOURCE REGRESSION. Next requires separately authorized targeted investigation of matched-frame readiness; E4O-D-CHECKPOINT is not yet ready. No R16 or repository-wide rerun.


### E4O-D R15 clean readiness investigation — qualified (2026-10-06)

Retained clean-source run7 reported 0 matched frames within 5000ms. Its trace proves both worker registrations were accepted before the assertion; both matched callbacks had completed by +595.671ms. The fourth all-frame scripting observation then remained pending beyond the deadline and was rejected only during teardown. First divergence/root: **READINESS_OBSERVATION_DEFECT**, in the test observation transport. Chrome’s internal reason for that pending API is not asserted. The old predicate counted callback Booleans, not the worker registry. Sender/document/epoch/session/permission qualification remains unchanged.

The removed storage getter and exact all-frame metrics getter are active awaited scheduling boundaries and were not assumed inert. A finite one-run-per-condition matrix (clean / storage only / exact script only) passed all three complete cases. Both restored operations completed before the matched callbacks, so neither was a completion barrier in the observed comparison. No deterministic hidden diagnostic dependency was established; neither operation is retained.

R15 alone now publishes the existing CONTENT_READY callback through a document event/Playwright binding and waits for the exact current top/child Frame and URL, invalidating publications on navigation. The one 5000ms deadline is unchanged. There are no observation scripting/storage warmups, retries, fixed sleeps, or weakened workflow assertions. Negative control withheld only child publication and failed with exactly one frame at 5000ms; repaired source was restored byte-exact. **Ten consecutive complete R15 runs passed**, with readiness completion 23.278–47.553ms, including physical worker restart/coherence/no-submit/consent and the existing 60s idle window. No eleventh run.

Direct recovery passed once; the remaining cleaned-source bounded group passed **44/44**, including both required-review cases, with no duplicated R15/recovery execution. Build-authority focused tests passed 2/2; supplemental creator-derivative checks accepted XA13 and rejected missing/unrelated owners. Strict harness typecheck across the 13 cleaned executable paths and diff check passed. All 192 src files remain byte-unchanged: carry Extension1344 / Security325 / Web970 / API2120. No production runtime repair or broader rerun.

Final hygiene has zero diagnostic-only logging/observers/warmups/temporary modes/only/skip/debugger. Permanent readiness event observation and timing annotations serve the asserted deadline contract. All 59 owned browser contexts recorded external[]; all 59 browser roots exited gracefully. Resource inventory found no owned browser/child/worker, profile/lock, port3000, or fixture survivor. XA12’s owned Next dev fixture generated two exact framework guidance files and changed two generated next-env type paths; their verified generated-only delta was backed up externally and restored to entry state. Exact 50 changed paths and empty index remain; historical/protected files are unchanged. No stage/commit/push/deploy/Store action.

Evidence/full 88-field report: `/private/tmp/xpertapply-r15-readiness/result.md`; retained proof/matrix, negative, ten timing reports, bounded qualifications, provenance/typecheck, integrity/network/resource audits are alongside it. Rollout: test-only readiness observation, no shipping runtime change. Rollback: restore this investigation’s R15 entry bytes (reopens the clean-readiness gate); preserve the prior hygiene changes. **PASS — R15 CLEAN READINESS QUALIFIED; RETURN TO FINAL E4O-D CHECKPOINT**. Next: **EXTENSION RELEASE STAGE E4O-D-CHECKPOINT**; stop here, no R16 or repository-wide Playwright rerun.
