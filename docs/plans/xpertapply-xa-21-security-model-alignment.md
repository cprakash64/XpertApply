# XA-21 — Extension security-model documentation alignment

## Scope and decision

XA-21 is documentation-only remediation. Production behavior, manifests, and the
15 pre-existing protected worktree paths are out of scope. The authoritative
operator/developer document is `apps/extension/README.md`.

Pre-fix classification: **PARTIALLY PRESENT**. Three historical findings were
already remediated in production behavior (session storage, no profile/form PII
in local storage, and fail-closed legal-answer handling). The README's permission
summary still described a fixed ATS allowlist, while production uses exact-origin
optional grants. Several absolute statements also needed narrower wording to
describe employer-DOM visibility and minimal local runtime metadata accurately.

## Historical mismatch recovery

| Historical README claim | Current implementation | XA-21 disposition |
| --- | --- | --- |
| Pending workflow state was presented as session-scoped while the audited runtime used local storage | `state.ts` now uses `chrome.storage.session` for launch, package, and view state; local is only a compatibility fallback unavailable in supported production Chrome | Retain and clarify restart boundary |
| Candidate/profile/application PII was presented as absent from local storage while the audited runtime persisted it there | Sensitive workflow packages are session-only; local holds configuration/minimal runtime coordination metadata | Replace the over-broad absolute claim with an enumerated boundary |
| Required host permissions were described as supported ATS hosts plus local development | Production requires only API + first-party bridge origins and declares employer HTTPS as optional | Correct required/optional/current-authority distinction |
| Legal attestations were presented as manual while the audited runtime could infer an affirmative answer | Attestations are manual; work authorization/sponsorship require explicit answers plus jurisdiction and polarity proof | Document the precise legal-answer boundary |

## Claim/evidence matrix (captured before editing)

| README claim area | Production evidence | Pre-fix result | Required wording |
| --- | --- | --- | --- |
| First-party bridge origins | `src/bridge-origins.mjs`, generated production manifest `content_scripts` and `externally_connectable` | Missing from summary | Name both canonical origins |
| Required hosts | generated production manifest `host_permissions` | Stale | API + two first-party Web origins only |
| Employer site access | manifest `optional_host_permissions`; permission request path in `background.ts`/`content/bootstrap.ts` | Incorrect | Optional declaration is not current authority; exact origin, user gesture |
| Per-frame DOM authority | `handleContentReady`, sender trust, frame probes, repeated `permissions.contains` | Missing | Each frame independently gates against the workflow |
| PendingLaunch and view storage | `src/state.ts` workflow storage | Accurate but terse | Session storage and restart boundary |
| Session package/token storage | `src/state.ts` package storage | Accurate but incomplete | Include answers/document metadata and isolated-world boundary |
| Local storage | `src/config.ts`, side-panel/background runtime keys | Over-broad | Enumerate excluded sensitive data and allowed metadata |
| Logging | structured logger call sites and PII-free result payloads | Accurate | Low-cardinality states/reason codes, no candidate data |
| Employer-page visibility | content receives package; runner writes native controls | Over-broad | Page sees intentionally written native values/files/events, not token/package |
| Token scope | package exchange and authenticated API client | Accurate | Session token is not login token |
| Legal attestations | sensitive policy, mapping, review actions, temporal tests | Accurate | Never infer/affirm attestations |
| Work authorization | answer semantics jurisdiction checks | Missing nuance | Explicit answer plus proven jurisdiction |
| Sponsorship | answer semantics polarity checks | Missing nuance | Explicit answer plus proven polarity |
| Submission | runner/bootstrap and submission evidence tests | Accurate | User clicks Submit; extension may observe evidence only |
| Internal field identity | WeakMap-backed discovery/status state | Missing | Internal ledger private; widget host/native changes observable |
| Logout/account replacement | `purgeSessionState`, authority generation, Web teardown ACK | Missing | Invalidate, purge, best-effort tab cleanup |
| PII-free result summary | report payload construction | Accurate | Preserve |
| Supported ATS/Workday limitation | adapter registry/runtime | Accurate | Preserve |
| Upload failure behavior | upload verification/error paths | Accurate | Preserve |
| Multi-step safety | safe application-surface controls and runner | Accurate | Preserve |

## Changes

- Replace the stale security summary with an evidence-bounded security and
  privacy model.
- Correct development configuration guidance so first-party required access and
  optional employer access cannot be conflated.
- Add a focused documentation consistency test with an in-memory negative
  control for the known stale blanket-access statement.

## Validation and rollback

Run the focused documentation test, production manifest/config tests, extension
typecheck, extension unit suite, production build, `git diff --check`, and
`git fsck --full`. The negative control must make the checker reject the stale
statement `requires access to all HTTPS sites`, while the final README passes.

Rollback is removal of this plan/test and restoration of the prior README only;
no runtime or data migration is involved.

## Independent release-readiness issue

**ASYNC-01 — Vitest asynchronous status-presentation cleanup after environment teardown**

- Severity candidate: Medium (test-reliability/release-gate defect; no production
  exploit or runtime regression established).
- Reproduction: the full extension suite at committed HEAD
  `0e5bd9967a63e2303f17cca3d2cff26b1eec78a0` passes all 1,060 assertions and then
  exits non-cleanly with `ReferenceError: window is not defined`.
- Stack: the `setTimeout(..., 0)` fallback scheduled by `schedulePosition` in
  `src/fields/statusPresentation.ts` fires after jsdom teardown, enters
  `positionAll`, and reaches `resetLayer` after `window` has been removed. The
  baseline run attributes the originating asynchronous work to
  `src/__tests__/temporal.test.ts`; the XA-21 worktree run attributed it to
  `src/__tests__/runner.test.ts`.
- Independence evidence: the committed baseline reproduces the same application
  stack without any XA-21 files. Three current-tree and three baseline isolated
  runner executions were clean, as were the README test alone and both combined
  README/runner invocations. The XA-21 test performs synchronous file reading and
  string assertions, creates no timers, mutates no globals, and shares no runtime
  modules with status presentation. The narrow `tsconfig.json` exclusion affects
  `tsc --noEmit` input only; Vitest discovers/transforms tests from
  `vitest.config.ts` independently.
- Release disposition: independent of XA-21 and therefore does not block its
  documentation checkpoint, but the complete extension suite remains non-clean.
  ASYNC-01 must be resolved before integrated production release acceptance.
