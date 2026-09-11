# XpertApply Application Memory — Stage 2C

## Goal

Give a user an accurate, owner-scoped historical view of each confirmed application attempt from `ApplicationSnapshot`. The Tracker must not substitute current job content or current generated documents for what was recorded at application time.

## Architecture and decisions

- Keep Tracker cards compact. Rows with `snapshot_available=true` open an accessible application-details dialog; legacy rows do not fabricate an entry point.
- Fetch snapshots only when details are opened, select the latest attempt initially, and cache a successful list for the current Tracker session.
- Render snapshot fields as plain React text. Only `http:` and `https:` historical job links are active.
- View and download snapshot documents through the existing authenticated, owner-scoped document endpoint using the snapshot's exact `document_id`. No storage path or permanent public URL is exposed.
- Describe resume provenance precisely: `upload_verified` can be called used; a selected document without upload proof is called selected. Cover-letter file, pasted-text, and unused modes remain distinct.
- Merge Tracker mutation responses from the server. Deletion scheduling and cancellation are displayed from returned backend timestamps; Stage 2C adds no cleanup worker.
- Preserve no-automatic-submit behavior and session-scoped sensitive workflow state. No employer form interaction is added.

## Progress

- [x] Confirm Stage 2A/2B response shapes and owner-scoped routes.
- [x] Add frontend snapshot and lifecycle types plus API helpers.
- [x] Add on-demand application details with multi-attempt history.
- [x] Add historical resume, cover letter, job-description, answer, and confirmation presentation.
- [x] Add scheduled-deletion status and server-backed undo.
- [x] Complete focused, full, build, E2E, and responsive visual validation.
- [x] Review implementation before any commit.

## Validation

Required validation uses Node 20.20.2 and npm 10.8.2:

- focused Tracker/application-memory component and API tests
- full Web tests, TypeScript, lint, and production build
- Playwright coverage for a single snapshot, multiple attempts, deletion undo, and error/retry
- responsive visual checks at 1440, 1280, 768, 375, and 320 pixels
- `git diff --check` and final scope audit

Final checkpoint results (Node 20.20.2 / npm 10.8.2): focused tests 106/106; complete Web suite 927/927; TypeScript PASS; ESLint PASS; production build PASS; existing plus Stage 2C Tracker E2E 8/8. Review coverage includes missing artifacts, failed deletion cancellation, cache reuse, dialog unmount, and out-of-order Tracker response isolation. Visual inspection at 1440, 1280, 768, 375, and 320 pixels passed after tightening mobile artifact actions and filename truncation; automated horizontal-overflow checks also passed.

## Rollout and rollback

This is an additive Web-only experience over existing APIs. Roll out with the Web client after validation. Roll back by reverting the Stage 2C Web changes; snapshot storage and backend lifecycle behavior remain unaffected. No migration, worker, deployment, or publication is part of this stage.

## Open public-release prerequisites

- **DEPENDENCY-01:** reconcile Python advisories involving `python-jose`, transitive `ecdsa`, and development `pytest`; reconcile production npm findings affecting direct Next 16.2.10 and PostCSS plus transitive `sharp` and `nanoid` (currently 1 Critical, 3 High, 1 Moderate affected production packages).
- **PROXY-01:** confirm the deployed reverse-proxy request-size configuration supports the intended 5 MiB upload limit plus multipart overhead.

These prerequisites are recorded, not remediated, in Stage 2C.
