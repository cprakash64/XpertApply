# XpertApply Stage 3C-4 — persisted-grant restart reactivation

## Scope and acceptance boundary

This is the narrow XA-06 follow-up for an embedded ATS whose exact Chrome host
permission survives a browser restart. It does not broaden host authority,
change ATS trust policy, bypass sender trust or fill leases, or introduce any
submission behavior. XA-06 remains provisionally remediated until the final
native Stage 3C-V2 rerun.

## Reproduction and root cause

At HEAD `8881ac0`, the native Stage 3 fixture completed a first Greenhouse run
with the exact employer and ATS grants, safe identity fill, résumé delivery,
and no ad access or submission. After closing Chrome, reopening the same
profile, and starting a new workflow, both exact grants were still present and
no prompt appeared, but the new ATS frame stayed uninjected. The panel retained
the old completed counts and Retry ended in `ADAPTER_NOT_DETECTED`.

The trace established two coupled state-transition defects:

1. `inspectApplicationFrames()` only acted on
   `APPLICATION_FRAME_PERMISSION_MISSING`. When Chrome enumerated a fresh,
   trusted ATS frame under an already-present exact grant but its bootstrap was
   absent, discovery returned
   `APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE`; it never invoked the secure
   Stage 3C-3 activation primitive.
2. `START_AUTOFILL` and the in-page Retry callback called `fill()` in the frame
   that answered first. The employer top frame was already active, so Retry ran
   adapter detection there instead of performing fresh embedded-frame
   discovery. In addition, tab bindings/views/active handoff were stored in
   `storage.local`, and a new request for the same application id could reuse an
   old tab without replacing its completed view.

This proves H1/H3/H6/H8/H9. H2 is a contributing mechanism: the untargeted top
frame readiness ping can succeed while the permitted ATS remains inactive. H4
and H5 are eliminated by session-scoping runtime state and fresh Chrome
enumeration. H7 is corrected by routing Retry through discovery. No evidence
supports H10 as the initiating cause, but old-workflow updates are prevented
from replacing the current active generation.

## Architecture and decisions

- Chrome host permissions are the only persistent user authority.
- Pending tab bindings, active handoff, panel progress, packages, frame
  registry, bootstrap state, and fill leases are ephemeral runtime state.
  Storage-backed runtime records use `chrome.storage.session` (with a local
  fallback only for older test/dev mocks), while in-memory frame IDs and leases
  remain worker-local and are cleared on navigation/tab removal.
- `requestId` is the workflow-generation identity. Reusing the same backend
  application/session id does not reuse a tab or completed view; only an
  idempotent replay of the same request may do so.
- Newly granted and already-granted embedded origins call one canonical
  activation adapter. It rechecks the exact permission, refreshes Chrome frame
  enumeration, requires one trusted origin/path match with a concrete frame
  id, targets only that id, and requires a bootstrap ping before success.
- Inspection messages must come from the Chrome-authenticated top frame of the
  bound workflow. DOM observations remain hints and never provide frame IDs.
- Retry re-enters `discoverAndFill`, allowing the top frame to perform fresh
  frame reconciliation. It never treats its own adapter miss as a verdict on a
  child frame.

## Validation plan

- Add twelve restart-path regressions covering persisted exact grants, changed
  frame IDs, stale progress, no reprompt, absent/revoked frames, ads, duplicate
  same-origin frames, stale workflow generations, Retry, bootstrap timeout, and
  forged senders.
- Run a negative-control mutation that disables the existing-grant activation
  transition, prove the principal regression fails, restore the implementation,
  and prove it passes.
- Run the real local Stage 3 fixture through run 1, browser restart/new
  workflow, and run 2. Record tab/frame IDs, grants, bootstrap/fill, ads, and
  submission evidence.
- Run focused frame discovery, activation, sender-trust, site-access,
  revocation, and restart suites, then typecheck, all unit tests, build, and all
  extension E2E tests.

## Rollout and rollback

No deployment, publication, commit, or push is authorized in this stage. The
change is confined to extension runtime state, embedded-frame reconciliation,
Retry routing, tests/fixtures, and this plan. Rollback is the removal of the
Stage 3C-4 diff; Chrome grants are untouched, so rollback does not alter user
permissions.

## Progress

- [x] Exact native restart defect reproduced before production edits.
- [x] A–X restart trace completed and root cause established.
- [x] Persistent authority separated from ephemeral runtime state in design.
- [x] Required unit/integration regressions green (979/979 unit tests).
- [x] Negative control recorded and mutation removed: disabling the
  existing-grant transition made test 1 fail for absent targeted frame-9
  injection; restoring it passed.
- [x] Real fixture restart and revocation regression green. Full Chromium
  restart used distinct employer tab IDs; exact grants persisted, runtime state
  did not, both runs filled, ads stayed empty, and neither run submitted.
- [x] Full extension validation green: typecheck, build, 979 unit tests, and
  136 Playwright tests. `docker compose config --no-env-resolution -q` passed;
  plain `docker compose config` cannot resolve the intentionally absent local
  `.env`. Repository-wide API/Web guardrails were invoked but could not start:
  the API virtualenv lacks pytest and the Web workspace lacks eslint. No
  dependency installation or unrelated lockfile mutation was introduced.
  Final diff/fsck review is recorded in the remediation report.
