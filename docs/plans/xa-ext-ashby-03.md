# XA-EXT-ASHBY-03 — authentication state, autofill safety, assistant layout

Status: implemented on `feature/xa-core1-direct-autofill` after `bfce88e`. Not pushed, not deployed. RELEASE BLOCKED until a real-Chrome staging retest.

## Findings
* Reproduced locally (real Chromium, local fixtures): a direct draft stays rendered (completed_with_review, enabled Fill/Continue) after the extension credential is gone, while the account row says "Not connected". Cause: a refused refresh / revoke / other-tab disconnect removed the credential with no workflow teardown, and the overlay trusted the cached view.
* No unauthorized mutation was found in that path: with the credential gone there were zero authenticated API calls and zero field writes. Whether the reported name-only fill was Ashby's own prefill, Chrome autofill or a prior session is **unproven**; no incident is declared.
* Badges overlapped the assistant (2 to 5 badges over the panel at 1366x768 / 1440x900, 100% and 125%); badge layer sat above the assistant and ignored scroll containers.
* "Preparing…" for the cover letter never resolved; "Filled" count label did not say who filled.

## Changes
* `extensionAuth` `onSignedOut`; worker tears down direct drafts (notice view DIRECT_SIGNED_OUT), refuses session-touching messages from a tab whose draft the credential no longer owns, sweeps ownership on auth-state reads (open / refresh / focus).
* Assistant trusts the account row over a stale direct view; no documents text without a prepared application; "Filled by XpertApply".
* Badge layer below the assistant, clipped to scroll ancestors and viewport, avoids the assistant rect; event driven (`xpertapply:overlay-layout`), no timers (existing no-periodic-timer contract kept).
* Heading focus ring removed (programmatic focus target, not a control).

## Validation
vitest 99 files / 1518 pass; tsc clean; browser: full suite 210 pass + 7 load/orphan-`next-server` failures that pass serially (12/12 re-run); new `xa-ashby-state` (6) and `xa-ashby-visual` (8 sizes x zooms, measured rects). Evidence: `docs/plans/evidence/ashby-visual-{before,after}`.

## Rollout / rollback
Extension-only; ship the previous build to roll back. No backend or production contract change.

## Limitations
No real-Chrome staging run; ATS-prepopulated vs XpertApply attribution is by verified writes only (counts), not per-field provenance labels.
