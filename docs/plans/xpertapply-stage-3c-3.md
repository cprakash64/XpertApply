# XpertApply Stage 3C-3 — post-grant embedded ATS activation

## Objective

Repair XA-06's post-grant transition without broadening host authority or weakening frame and sender trust. A newly granted embedded ATS origin must be rediscovered as a concrete Chrome frame, injected only after exact-origin and workflow checks, and allowed to obtain data only through the existing sender-trust and fill-lease gates.

## Confirmed root cause

`applySiteAccessResult()` rechecks Chrome's effective permission and then calls `ensureContentReady(tabId)`. That helper checks the top-level tab URL and sends an untargeted ping. On an employer page whose top-frame content script is already active, the ping succeeds immediately, so the helper returns without rediscovering or injecting the newly granted ATS frame. The observed ATS record remains `frameId: null`; a later manual retry reaches the employer frame and falls through to `ADAPTER_NOT_DETECTED`.

## Design

For a frame-scoped permission result only:

1. Recheck the exact Chrome permission.
2. Re-enumerate currently injectable frames on every bounded attempt.
3. Accept only real, non-top Chrome frame IDs whose canonical origin exactly matches the granted pattern and whose origin joins the active workflow.
4. Recheck permission immediately before targeted injection.
5. Inject `content.js` only into those concrete frame IDs and confirm frame-local liveness.
6. Leave session/profile/résumé authorization to the existing Chrome `MessageSender`, workflow-trust, and fill-lease gates.
7. If confirmation or bootstrap does not complete, retain a recoverable pending-frame failure rather than misclassifying the application as unsupported.

Page-scoped permission behavior remains unchanged.

## Validation

- Regression coverage for observed-to-confirmed reconciliation, exact targeted injection, unrelated and workflow-untrusted exclusion, missing concrete frames, navigation, revocation, executeScript failure, bootstrap non-response, and legitimate ATS activation.
- Negative control by temporarily disabling the reconciliation call and proving the key regression fails.
- Local multi-origin fixture validation with ATS granted and ads ungranted.
- Full typecheck, unit, build, Playwright E2E, manifest authority checks, and `git diff --check`.

## Rollout and rollback

This stage is extension-only and remains uncommitted pending review. Rollback is removal of the new reconciliation helper and restoration of the previous frame-scoped branch in `applySiteAccessResult()`. No manifest or permission declaration changes are allowed.

## Progress

- [x] Native production defect reproduced.
- [x] Root cause traced through permission result, top-frame ping, fallback.
- [x] Regression tests added and shown failing before the fix (the worker returned granted while making zero ATS injection calls).
- [x] Minimal concrete-frame reconciliation implementation completed.
- [x] Negative control demonstrated (8 focused failures when concrete Chrome frame IDs were excluded), then reverted.
- [x] Real multi-origin fixture validated: ATS activated, ad frame untouched, wildcard absent, and no submission.
- [x] Full validation passed: typecheck, 965 unit tests, production build, 135 Playwright tests, manifest authority audit, and `git diff --check`.
