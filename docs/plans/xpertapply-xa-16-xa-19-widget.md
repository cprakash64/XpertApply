# XA-16 + XA-19 widget remediation

Scope: widget live-region/name semantics and constrained-height action reachability only. No XA-21, suspected findings, blocked reconciliation, staging, commit, push, or release.

## Preflight

Authoritative checkout `/Users/cprakash/Developer/XpertApply`, branch `recovery/stage3-security`, HEAD and remote `c2fcf769c1f55be26a38dbb9402cdbcde007b9b7`. Index empty; exactly 15 protected dirty paths; zero unexpected paths. Initial diff check and fsck passed. Protected paths must remain byte-identical.

## Current structure

Host `div#jobpilot-assisted-apply`, closed shadow root. Fixed section `.box`, no role or accessible name, `aria-live=polite`, no atomic/tabindex. Header contains decorative dot, dynamic span `.title` (no heading), collapse button. `.body` overflow auto contains message (plain div), lifecycle, count, counts grid, review toggle, action/review/teach lists, and `.actions` including completion, More options and transaction details. Shell maximum `min(82vh,780px)`, overflow hidden, bottom/right 18px (12px narrow); flex column. No dedicated footer or sticky region. Body lacks explicit min-height. Native controls retain native tab order.

## Progress

Production pre-fix reproduction confirmed both findings (Low). At 1280×720: shell y=111.61–702, body clientHeight=530 / scrollHeight=654, completion y=714.16–749. At 125/150/200% actual browser zoom, CSS viewports were 1024×576, 853×480, 640×360 and the action was clipped. One unnamed broad polite region and three static field notes were observed. No evidence establishes an unreachable enabled keyboard action; clipping is the confirmed defect. Production acceptance uses a disposable build copy with only the synthetic loopback origin permission added; production JavaScript remains byte-identical. Browser zoom uses chrome.tabs.setZoom, not deviceScaleFactor. No actual screen-reader spoken output is claimed.

## Architecture / validation / rollback

Implemented named nonmodal section associated with the single visible h2 “XpertApply assisted application”; dynamic stage is a separate static span. Message uses role=status (implicit polite), aria-atomic=true; identical repeated text is not reinserted. Counts, review panels and auxiliary actions remain static. Header/footer do not shrink; body flexes with min-height:0, overflow:auto, scroll-padding:6px. Completion footer is a normal-flow sibling, not sticky or overlay. Height is min(780px, 100dvh − 36px), with vh fallback; narrow widths use 12px insets. No observers, RAF or polling added. Forced colors use system boundary/button/focus colors. Existing next-issue smooth scrolling respects reduced motion. Completion rejection now reports fixed user-facing copy through the intended status node, guarded against stale session/widget responses. Validate production MV3, geometry, keyboard, actual browser zoom, negative controls and full suites. No workflow authority moves from the ledger. Rollback only this stage's explicitly reviewed diff; preserve protected work. No rollout performed.


## Acceptance progress

- Production MV3 passed 1280×720, 1366×768, 1440×900, 1280×640/600, widths 320/375/768; actual zoom 100/125/150/200%. The completion action is entirely visible, including y=294.16–329 at the 640×360 CSS viewport at 200%.
- Supplemental density stress clones 500 production review cards using DevTools only. This is presentation stress, not a claim that cloned cards are ledger entries or the supported discovery limit. Long unbroken labels and a long status message remain within the scroll body. Tall→short→tall resizing and newly focused last-card controls pass.
- Native Tab reaches review controls, Clear via More options, enabled completion after actual required-name confirmation, then leaves the widget. Enter on completion causes one synthetic internal bookkeeping request, deliberately rejected with HTTP 409; status reports failure, action remains enabled/reachable, employer submission count stays zero.
- Forced-colors and reduced-motion computed styles passed; screenshots visually inspected. Widget-only mutation observation recorded zero changes over a 500ms settled interval.
- Unit semantics cover preparation, filling, filled, review, failure, manual completion, counter-only refreshes, stable naming and explicit completion gating. No claim of actual screen-reader audio testing.
- Initial full unit run: 69 files / 1060 assertions passed but two uncaught asynchronous statusPresentation teardown callbacks (window missing after jsdom teardown in identity_fill/runner tests) prevented a clean run. The subsequent complete `make test-extension` passed with 69 files / 1060 tests, no uncaught errors, typecheck and production build. No out-of-scope changes were made to that code. The initial result is not counted as PASS.
- Web lint/typecheck/build and 46 files / 908 tests passed. API dependencies were provisioned under `/tmp/xa1619-api-venv`; `make test-api API_PYTHON=/tmp/xa1619-api-venv/bin/python` passed all 1826 tests. No schema changed, so a new Alembic upgrade/downgrade exercise is not applicable. Compose structural validation passes with --no-env-resolution; ordinary config cannot resolve absent .env.
- Both negative controls mutated only disposable production copies and failed at the intended assertions: legacy section live ownership failed the semantic equality assertion; legacy action-inside-body layout failed actionVisible at 1280×720. The restored focused production + XA-11 + XA-13 run passed 3/3. Copies were removed in finally; production source and dist retained the final implementation.


## Supplemental production state inspection

After initial reproduction and remediation, the original `HEAD` widget/bootstrap sources were rebuilt in a disposable artifact (source fingerprint `9481bc7`, matching the original pre-edit production build). Final production fingerprint is `95959e4`. A test-only isolated-world handle was assigned to the factory's returned widget object in disposable bundle copies. It exercised the actual production `update` method for preparing/loading, starting autofill, filled, review, error and manual-completion-ready messages. All six original states had one unnamed broad polite region. All six final states had one named section/region, one h2, one implicit-polite atomic status, and three static field notes. This is direct widget-API state testing, not six independent end-to-end backend workflows and not a screen-reader audio test. Ordinary E2E acceptance uses unchanged production JavaScript, with only fixture-origin permission added to a disposable manifest.

Original layout scrolling was confirmed separately: body scrollTop 89 (clientHeight 530 / scrollHeight 619) exposed the completion action fully. Thus keyboard unreachability was not established; Low remains appropriate. On final production, the real Jump to next issue action focused employer `first_name`; focus return uses normal Tab traversal, with no new focus trap or automatic activation.

## Geometry evidence

All dimensions below are CSS pixels. Initial positions are measured with the widget open at its initial scroll position. Browser zoom uses `chrome.tabs.setZoom`.

| Browser viewport | Zoom | CSS viewport | Original action bottom / visible | Final action bottom / visible |
|---|---:|---|---|---|
| 1280×720 | 100% | 1280×720 | 749.00 / False | 689.00 / True |
| 1280×720 | 125% | 1024×576 | 719.24 / False | 545.20 / True |
| 1280×720 | 150% | 853×480 | 699.21 / False | 449.33 / True |
| 1280×720 | 200% | 640×360 | 684.26 / False | 329.00 / True |
| 1366×768 | 100% | 1366×768 | 757.64 / False | 737.00 / True |
| 1440×900 | 100% | 1440×900 | 805.56 / True | 869.00 / True |
| 1280×640 | 100% | 1280×640 | 734.59 / False | 609.00 / True |
| 1280×600 | 100% | 1280×600 | 727.39 / False | 569.00 / True |
| 320×720 | 100% | 320×720 | 1097.53 / False | 695.00 / True |
| 375×720 | 100% | 375×720 | 1078.69 / False | 695.00 / True |
| 768×720 | 100% | 768×720 | 749.00 / False | 689.00 / True |


## Worktree classification

Each stage path is unstaged. A/B overlap is classified once under C.

- A (XA-16 only): none separately; semantic work is in the joint widget.
- B (XA-19 only): none separately; layout work is in the joint widget.
- C (joint production/support): `apps/extension/src/content/widget.ts`; `apps/extension/src/content/bootstrap.ts` (completion rejection status only).
- D (unit tests): `apps/extension/src/__tests__/widget.test.ts` (+8 tests; no deletions).
- E (E2E/manual support): `apps/extension/e2e/widget-driver.ts`; `apps/extension/e2e/xa16-xa19-widget.spec.ts` (+1 production acceptance scenario).
- F (documentation): this plan.
- G (protected API, 6): `apps/api/app/routes/profile.py`, `apps/api/app/services/document_parser.py`, `apps/api/app/services/upload_guard.py`, `apps/api/app/tests/test_profile_import.py`, `apps/api/app/tests/test_profile_upload_security.py`, `apps/api/requirements.txt`.
- H (protected Web, 8): `apps/web/__tests__/api-payload-too-large.test.ts`, `apps/web/__tests__/application-status.test.ts`, `apps/web/__tests__/tracker.test.tsx`, `apps/web/app/tracker/page.tsx`, `apps/web/components/DashboardClient.tsx`, `apps/web/components/TrackerClient.tsx`, `apps/web/lib/api.ts`, `apps/web/lib/applicationStatus.ts`.
- I (protected design plan, 1): `docs/plans/xpertapply-design-system-audit.md`.
- J (unexpected): 0. The Web build's generated next-env.d.ts change was undone, restoring its original bytes.

All 15 protected paths passed SHA-256 comparison after validation. No staging, commit, push, merge, deployment or publication. XA-21 remains untouched/PARTIAL; previously closed low findings remain closed. Overall NOT READY FOR PRODUCTION. Next, after final full-suite result: combined XA-16/XA-19 checkpoint only.
