# XA-09 — bounded application-form scanning

## Finding and scope

XA-09 is the Medium production-readiness finding that DOM scanning scales
super-linearly and can block a page for many seconds on a 5,000-control form.
This plan is limited to the extension scan/root-resolution path. XA-10 and later
findings are out of scope.

## Evidence and decision

At accepted HEAD `4e5563e`, real Chromium measured the production-function
harness at 100/500/1,000/2,000/5,000 controls. `probeFrame` took
13.8/25.8/81.8/234.2/1,245.9 ms and `discoverFields` took
5.0/14.6/46.1/153.0/826.4 ms. The historical 26-second symptom has improved,
but the curve remains super-linear and unbounded. XA-09 is therefore partially
present.

Root cause: root resolution repeatedly scans the whole deep DOM and computes
per-control labels/visibility before establishing whether the candidate is a
reasonable application form. Discovery has the same missing guard.

Decision: allow at most 1,000 actionable controls in one application root. This
is five times the audit's upper realistic ATS range (20–200). At 1,001 controls,
root resolution returns the explicit recoverable reason
`APPLICATION_FORM_TOO_LARGE`; direct discovery returns no fields plus a
`tooLarge` ledger signal. The production UI must show review-required failure,
not false readiness or a truncated success.

## Implementation

- Centralize the actionable-control selector and budget inspection.
- Short-circuit application-root resolution before candidate scoring.
- Guard direct discovery as defense in depth.
- Propagate the named reason through readiness, frame coordination, diagnostics,
  and the user-visible failure state.
- Add unit, real-Chromium performance, and production-MV3 regression coverage.

## Validation

- Original 5,000-control case and 2,000-control adjacent case fail safely within
  a bounded wall-clock budget.
- Exactly 1,000 controls remain accepted; 1,001 are rejected.
- Repeated scans stay deterministic and do not create stale success.
- Temporarily raising/disabling the ceiling makes the principal regression fail;
  restoring it passes.
- Run extension typecheck, all unit tests, production build, all E2E tests,
  `git diff --check`, and `git fsck --full`.

## Rollout and rollback

Ship as an extension-only fail-closed guard with no permissions, storage,
network, credential, or submission changes. Monitor the named failure code in
existing diagnostics. Roll back by reverting only the XA-09 files if legitimate
ATS forms exceed the ceiling; do not silently increase the budget without new
runtime evidence.

## Progress

- [x] Recovered authoritative finding and historical evidence.
- [x] Reproduced and classified current behavior before production edits.
- [x] Implement explicit budget and failure propagation.
- [x] Add regressions and negative control.
- [x] Complete full extension and repository integrity validation.
