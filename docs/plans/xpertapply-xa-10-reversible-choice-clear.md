# XA-10 — reversible clearing for choice controls

## Finding and scope

XA-10 is the Medium finding that “Clear XpertApply-filled fields” removes its
markers but leaves native selects, radio answers, and custom dropdown selections
populated. This plan is limited to the extension fill/clear path. XA-11 and later
findings are out of scope.

## Evidence and root cause

At checkpoint `580a2f8`, real Chromium filled a native select (`Yes`), a radio
group (`Referral`), and a React-style custom control (`No`). Clear returned 3 and
removed every `data-jobpilot-filled` marker, but all three selected values
remained. XA-10 is confirmed.

Dropdown fill captures native original state only after verified mutation.
Custom wrappers have no meaningful `.value`, and Clear has no adapter path to
restore their selection. Radio restoration also needs the whole group state,
not only the representative input.

## Decision

- Snapshot adapter-reported selection before the first successful dropdown fill
  in a per-element `WeakMap`; never persist it.
- Add verified adapter restoration for native selects, radio groups, and custom
  controls.
- Make Clear asynchronous so framework-controlled state can settle and be
  verified.
- Remove fill markers only after restoration succeeds. A control that cannot be
  restored stays visibly marked and is reported as a clear failure.
- Traverse open shadow roots when locating marked controls.

## Validation

- Original native-select/radio/custom reproduction.
- Initially blank and initially populated choice controls.
- Repeated fill preserves the first pre-XpertApply state.
- Duplicate Clear is idempotent.
- Unsupported/inert restoration cannot claim success or remove its marker.
- Real Chromium and production MV3 widget acceptance.
- Mandatory negative control by moving snapshot capture back after mutation.
- Full extension typecheck, unit, build, E2E, diff-check, and fsck.

Completed evidence: typecheck passed; 1,003/1,003 unit tests passed; the
production MV3 bundle built as `580a2f8-dirty-4c73765`; and 142/142 Chromium E2E
tests passed. The production-widget acceptance ended with native and custom
choices blank, the radio group unchecked, zero fill markers, and zero submits.
The negative-control mutation made both focused XA-10 tests fail; restoring the
pre-interaction snapshot made the identical tests pass 2/2.

## Rollout and rollback

This is an extension-only in-memory restoration change. It adds no permission,
storage, network, profile, résumé, token, submission, or dependency behavior.
Rollback is a revert of the XA-10 files; failed restoration must never be
converted back into marker removal or false success.

## Progress

- [x] Recovered authoritative finding.
- [x] Reproduced and classified current behavior before production edits.
- [x] Implement verified choice restoration.
- [x] Add runtime coverage and negative control.
- [x] Complete full validation.
