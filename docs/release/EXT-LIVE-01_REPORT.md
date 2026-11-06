# EXT-LIVE-01 report: extension 0.3.1 (seamless access, auto-open reliability)

Source: branch `feature/ext-live-01` (child of `release/ext-final-01` dcfc59e), local only, not pushed.
Code commits: 6cf20c1, 7bbadf3. Production extension ID unchanged: `gnibjomjfdobadlockphjiibbpmiehcj`.
Published baseline: Chrome Web Store lists 0.3.0, build 8665fbe (Store page and update server checked 2026-11-06);
the local ZIP `xpertapply-extension-ext-final-01-8665fbe.zip` (sha256 18b98e1c...f279d) is that build. The Store CRX
itself was not downloaded, so byte identity with the Store package is not proven.

## Confirmed root causes (from source, then reproduced in real Chromium)

1. Exact-host permission model: one Chrome request and one registered script per ATS hostname. A second company
   on the same ATS, a second ATS host (boards/job-boards), or a Workday tenant is a new request.
2. Passive "wants access" requests were de-duplicated in an in-memory Set in the MV3 service worker; a suspended
   worker forgot it. Declined/revoked origins were not remembered.
3. The form watcher spent one of twelve looks on every debounced DOM mutation. Reproduced on 0.3.0 (spec L2): on a
   page with constant non-form DOM churn and a form that renders after 45 s, the form is never found. When a
   watch ended there was no message (spec L4 on 0.3.0: silent).
4. Not a defect on 0.3.0: a same-document route change with a 20 s render delay was found (spec L3 passes on
   0.3.0). The route re-arm is defence in depth, not a fix for a reproduced failure.

## Changes

See docs/plans/ext-live-01-seamless-autofill.md. Permissions requested are unchanged in the manifest; only
`options_ui` (page `access.html`) and the version were added. No autofill-engine change.

## Validation

- `tsc --noEmit`: clean apart from a pre-existing `node:crypto` typing error in store_identity.test.ts (also on dcfc59e).
- Unit: 108 files / 1613 tests pass (a pre-existing fixture in store_identity.test.ts tripped the staging
  private-key scan; rewritten to build the marker string at runtime).
- Real Chromium 149 (Playwright 1228), unpacked extension, owned loopback employer/API, TLS, DNS confined to loopback;
  every context asserts zero external traffic on close. Final full run: 268 passed, 10 skipped, 7 failed:
  - xa-core1-connect x3, xa12-account-replacement x2: environment (missing API venv path / apps/web fixture); not run.
  - xa-e2c-isolation "account changes while the worker is stopped": fails intermittently on 0.3.0 too (1 of 2 runs).
  - cws-toolbar-disclosure: failed once under load in the full run, passed 2/2 on isolated rerun.
- New: ext-live-01.spec.ts L1-L7 (group grants, late form, SPA route, fallback + retry, non-application pages,
  access page, fresh install).

## Not done (blocked or out of reach)

Fresh Chrome profile with the Store-installed package; Chrome's native consent dialog, revocation through
chrome.google.com UI; real Greenhouse/Lever/Ashby/Workday employer pages (fixtures only, no submissions);
service-worker suspension in a real browser for the new persisted markers (unit-tested only); Phase 4 engine
changes (none made). See the report in the session summary for the verdict.
