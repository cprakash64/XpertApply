# XA-11 — ledger-derived field and widget status coherence

## Finding and scope

XA-11 is the Medium finding that the widget can report every field verified and
zero needing confirmation while employer controls are visibly marked for
review. This plan is limited to extension status derivation and its regression
coverage. XA-12 and later findings are out of scope.

## Evidence and root cause

At checkpoint `036b4bf`, the shipped MV3 extension filled a label/name-only
three-field application. First and last name received orange
`data-jobpilot-status="review"` markers and email received a green `verified`
marker, while the widget reported `Filled 3 of 3`, `Needs confirmation: 0`, and
`All required live controls are verified`.

The runner chose the outline from `mapping.requiresReview`, but a successful
fill lost that flag when converted to `FieldFillResult`. The field ledger and
the question ledger therefore classified the same control as
`filled_verified`; final live verification reinforced that classification.

## Decision

- Carry successful-but-review-required fills into the existing
  `filled_needs_review` ledger status.
- Count that status as filled and needing confirmation, but not blank.
- Derive the final filled-control outline from its ledger entry rather than the
  mapping flag.
- Preserve review-required status through the final live-DOM verification pass.
- Keep technical DOM verification separate from user confirmation and block a
  ready claim until confirmation is complete.

## Validation

- Original three-field production-MV3 reproduction.
- High-confidence boundary remains verified/green.
- Filled-but-review-required ledger counts reconcile.
- Final verification cannot upgrade an unconfirmed value to verified.
- Review list and widget counts describe the same controls.
- No submit event.
- Mandatory negative control.
- Full extension typecheck, unit, build, E2E, diff-check, and fsck.

Completed at checkpoint `036b4bf`:

- TypeScript typecheck passed.
- Focused regression set passed: 5 files, 51 tests.
- Full unit suite passed: 65 files, 1,006 tests.
- Production build passed: `036b4bf-dirty-60a2efa`.
- Full MV3 E2E suite passed: 143 tests, including the XA-11 runtime
  reconciliation (`2` review markers = `2` needs-confirmation, `0` submits).
- The mandatory negative control failed when the low-confidence result signal
  was removed, then the identical runtime test passed after restoration.

## Rollout and rollback

This is presentation and in-memory ledger state only. It adds no permissions,
storage, network requests, answer transmission, dependencies, or submission
behavior. Rollback is a revert of the XA-11 files.

## Progress

- [x] Recovered authoritative finding.
- [x] Reproduced and classified current behavior before production edits.
- [x] Implement single-source status derivation.
- [x] Add focused coverage and negative control.
- [x] Complete full validation.
