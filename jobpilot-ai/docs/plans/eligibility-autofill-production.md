# Eligibility autofill production plan

## Objective

Ship a generic, verified application-question pipeline that fills confirmed work-authorization
and sponsorship answers on TikTok-style and equivalent ATS controls. Keep narrative drafting
separate and grounded. Never submit an application or invent a factual/legal answer.

## Repository and safety baseline

- Branch: `feature/actionable-people-foundation` (do not change it).
- The worktree was already heavily modified before this task, including the profile, application
  session, question resolver, extension content script, dropdown transaction, tests, and three
  untracked migrations. These files are user work and must be preserved.
- No reset, clean, stash, rebase, branch change, commit, or push is permitted for this task.
- Changes made for this plan must be minimal and reviewed against the pre-existing diff.

## Architecture and observed flow

1. Profile persistence
   - `PUT /profile/application-eligibility` writes the user's explicit legal choices through
     `eligibility_service.set_eligibility_answer`.
   - The server, not the browser, stamps legal-answer source, verification, confirmation time,
     and autofill permission.
2. Profile/session API
   - `answer_vault_service.build_safe_answers` admits legal answers only through the explicit
     legal gate.
   - Application creation snapshots safe answers; `/application-sessions/{id}/answers` refreshes
     the snapshot when `profile_revision` changes.
3. Extension hydration
   - The MV3 background exchanges the one-time launch token, caches the session-scoped package,
     refreshes answers through the authenticated backend, and never exposes provider secrets.
4. Field discovery
   - `fields/discovery.ts` collects the visible/associated label, ARIA name, nearby text, section
     heading, role/control type, options, required state, validation state, and frame id.
5. Question resolution
   - `questionBatch.ts` sends a bounded descriptor and opaque field/option references.
   - `question_resolver.py` performs exact aliases and bounded deterministic rules.
   - `answer_resolution_service.py` applies application override > confirmed reusable answer >
     deterministic derivation > unresolved.
6. Ledger/review
   - `questionLedger.ts` records one state per opaque field reference and maps missing answers,
     confirmation, user gestures, technical failures, consent, and verified fills into distinct
     counters.
7. DOM actuation and verification
   - `dropdownTransaction.ts` enumerates closed custom menus without choosing, handles portaled
     listboxes, actuates only a backend-approved visible option, waits for framework settlement,
     and verifies the displayed/backing state before recording `filled_verified`.

## Root-cause evidence

The committed pre-task flow had multiple broken boundaries:

- `answer_vault_service.py` derived legal answers from `work_authorization` and from a
  `requires_sponsorship` boolean whose default `false` could mean either “No” or “unanswered.”
  This violated authoritative provenance and could both omit a real answer and manufacture one.
- `fields/mapping.ts` mapped a combined “now or in the future” sponsorship prompt to
  `sponsorship_required_future`. It did not preserve the two required source keys or apply
  boolean OR.
- A custom dropdown with no options until opened could not enter a safe option-aware resolution
  batch. The old dropdown path intentionally skipped probing when it had no target, leaving this
  discovery/answer boundary circular.
- Success and failure reporting did not expose all four stages distinctly enough to tell “answer
  missing” from “answer present but control did not commit.”

The current in-progress implementation already addresses these with explicit eligibility rows,
a combined canonical question, pre-resolution option enumeration, a verified transaction, and an
authoritative question ledger. Focused baseline validation on 2026-08-05 passed 111 extension
tests and 155 API tests. The built-extension Playwright fixture passed all 14 cases, including the
exact authorization=Yes and combined sponsorship=No scenario, a portaled closed combobox,
framework reversion, consent exclusion, and ledger reconciliation.

## Exact TikTok fixture trace

The deterministic local fixture models the available evidence because live TikTok credentials are
not available:

| Attribute | Work authorization | Combined sponsorship |
| --- | --- | --- |
| Raw/accessible label | Are you legally authorized to work in the US without restriction? | Will you now or in the future require visa sponsorship or a visa transfer? |
| Section heading | Eligibility | Eligibility |
| Control | Custom ARIA combobox, portaled listbox | Native select |
| Options | Yes / No | Yes (`y`) / No (`n`) |
| ATS | Generic fixture (TikTok DOM shape) | Generic fixture (TikTok DOM shape) |
| Canonical candidate/selection | work-authorization-without-restriction | combined current-or-future sponsorship |
| Method/confidence | normalized exact alias / deterministic high confidence | normalized exact alias / deterministic high confidence |
| Authority | confirmed reusable legal answer | deterministic OR of confirmed current and future answers |
| Resolved answer | Yes | No (`false OR false`) |
| Actuator | ARIA/listbox transaction | native-select transaction |
| Display/backing after fill | Yes / Yes | No / `n` |
| Ledger | filled and verified | filled and verified |
| Failure code | none | none |

If actuation is forced to revert, the trace ends at DOM verification and the ledger records a
technical failure (`selected_value_not_persisted`), never `needs_information` or a verified fill.

## Decisions

- Maintain one reusable source of truth: explicit, verified application-answer rows. Legacy
  profile immigration fields never originate legal answers.
- Derive combined sponsorship every time from current and future components; do not store an
  independently editable reusable combined value.
- Keep application overrides session-scoped and higher authority without mutating reusable rows.
- Keep semantic resolution on the authenticated backend and DOM actuation in the extension.
- Use opaque option references across the boundary. Never send the complete profile for question
  classification.
- Treat legal ambiguity as review. Model confidence alone never permits a legal fill.
- Generated prose remains editable/reviewable and must carry grounding metadata.

## Remaining implementation work

- Preserve the full field descriptor (accessible name and supporting metadata) through the
  resolver boundary instead of collapsing it to one label string.
- Make backing-value verification accept a semantically equivalent machine value (`y/n`,
  `true/false`) while rejecting contradictory or unknown values.
- Normalize transaction failures to stable production error codes and expose a redacted per-field
  trace with stage, source, revision, actuator, verification, and failure code.
- Strengthen deterministic resolver variants and non-equivalent/ambiguous cases without fuzzy
  legal matching.
- Strengthen grounded narrative result metadata and reject/fallback on unverified claims.

## Validation matrix

- API resolver/eligibility/override/answer-policy tests.
- Extension unit tests for batch descriptors, option mapping, backing values, React reversion,
  ledger precedence, and stable technical failures.
- Built-extension Playwright fixture for native selects, a TikTok-shaped custom combobox,
  portaled/closed/delayed menus, and failed commit.
- Narrative tests with deterministic mocked model output.
- `make test-api`, `make test-web`, `make test-extension`, extension Playwright tests, type checks,
  lint, production builds, `docker compose config`, and Alembic upgrade/downgrade checks.
- Inspect `apps/extension/dist/content.js` and its build metadata for the new resolver/transaction
  code after the production build.

## Rollout

1. Deploy the reversible database migrations and backend contract.
2. Deploy web eligibility controls and backend before distributing the extension build.
3. Publish the extension only after it reports compatible registry/answer-contract versions.
4. Monitor low-cardinality resolver outcomes and technical failure codes; never log questions,
   answer values, tokens, resume text, or profile contents.
5. Validate manually on TikTok with a non-submitting test application.

## Rollback

- Roll back the extension first; it remains compatible with safe session answers and never
  submits.
- Roll back web/backend only after confirming the older client will not treat unanswered legacy
  values as explicit legal answers.
- Use each migration's downgrade only in a disposable/staged database first. The documented
  nullable-to-false downgrade reintroduces legacy ambiguity and therefore requires product signoff
  before production use.

## Progress

- [x] Safety audit and existing-work preservation recorded.
- [x] Complete profile-to-DOM flow traced.
- [x] Original failure boundaries identified from repository history/diffs.
- [x] Exact built-extension browser fixture reproduced and passing against current worktree.
- [x] Remaining contract/observability/narrative gaps implemented.
- [x] Full required validation completed and production artifact inspected.

## Final validation (2026-08-05)

- `make test-api`: 1,563 passed, 2 PostgreSQL-marked cases skipped, 1 dependency warning.
- `make test-web`: lint, typecheck, production build, and 369 tests passed (26 files).
- `make test-extension`: typecheck, 584 tests passed (40 files), production MV3 build passed.
- `npm run test:e2e`: 82 cases passed on the first full run; one fixture expectation failed
  because it still expected the hidden value `Yes` instead of the intentionally different
  machine value `true`, and 16 serial cases were skipped after that failure. After correcting
  that expectation, the complete 17-case application-answer file passed. Together every one of
  the 99 unique browser cases passed.
- Exact question-resolution browser fixture: 15 passed, including visible/backing disagreement
  classified as technical failure.
- `docker compose config --quiet`: passed. A prior non-quiet invocation expanded local secrets
  into command output; those values are not recorded here and must be rotated.
- Isolated PostgreSQL migration verification: fresh upgrade through
  `0029_session_answer_overrides`, downgrade to `0027_applied_lifecycle`, re-upgrade to head, and
  `alembic current` all passed. The temporary database was dropped.
- Production artifact inspection confirmed `accessible_name`, `profileRevision`,
  `questionTraces`, `backing_value_mismatch`, and `CONTROL_VALUE_VERIFICATION_FAILED` in
  `dist/content.js`; `dist/manifest.json` carries build id `44364f1-dirty-3d265fb`.

## Production-only follow-up (2026-08-06)

### Live boundary reproduced

The authenticated TikTok run reported `needs_information`, not a technical issue. Inspection of
the active PostgreSQL database showed user 3 has three explicit, verified, autofill-enabled legal
answers: work authorization Yes, current sponsorship No, and future sponsorship No. Session 66 is
owned by the same user and has the current profile revision.

Running the two exact live labels through the resolver against that active session isolated the
loss point: with no submitted options, both canonical keys resolved correctly but the API returned
`status=missing, reason_code=no_options`; with Yes/No options, both returned `resolved`. TikTok's
closed custom controls can expose no option DOM before opening, so option discovery was incorrectly
being used as evidence that the profile answer was absent. The extension also dropped optionless
choice controls from the resolver batch, making the same coupling possible one boundary earlier.

### Correction

- Contract v3 separates semantic answer resolution from option mapping. Confirmed booleans carry
  `typed_answer`, `display_answer`, and tri-state `source_values`; `false` is checked by type, never
  truthiness.
- Optionless closed comboboxes are sent to the backend. A resolved boolean without enumerated
  options reaches the actuator using the backend-approved canonical Yes/No label.
- If opening, selection, displayed readback, backing readback, or validation fails, the field ends
  in `interaction_failed` / `technical_issues`; it cannot become `needs_information` merely because
  the menu was closed.
- A lower-authority unresolved pass cannot overwrite a verified fill.
- The copyable eligibility diagnostic now records the complete accessible descriptor, contract and
  build identities, source tri-state values, actuator reachability, verification, and stable failure
  code. The side panel publishes its own build identity so content, worker, and panel staleness are
  independently visible.

### Validation

- Focused API resolver contract: 54 passed before the final false-override hardening; the added
  boolean-JSON override case is run in the final focused verification.
- Full API suite: 1,564 passed, 2 skipped.
- Full extension unit suite: 591 passed; typecheck and production build passed.
- Full web suite: lint, typecheck, production build, and 369 tests passed.
- Full built-extension Playwright suite: 99 passed, including the forced actuator-failure case.
- Final-build resolver + session-handoff Playwright suites: 19 passed after adding exact API/account
  identity propagation.
- Rebuilt extension: `44364f1-dirty-d658c3c` (version 0.2.0).
- Final rebuilt API image: `51ffcda8a528`; `/readyz` reports database and Redis connected, schema current,
  and Alembic current/head both `0029_session_answer_overrides`.
- Rebuilt web image: `bc1e8768ed0b`; the handoff now reports its exact API base and authenticated
  user id so the extension can block a same-environment but different-port/account mismatch.

### Rollout / rollback note

Deploy API contract v3 before reloading the extension build. The extension parser remains tolerant
of contract-v2 responses, but only v3 can carry a semantic boolean when a closed menu has no option
references. Roll back the extension first if needed; no schema change was introduced by this
follow-up. Do not downgrade the user's active database.

## Final live-actuator hardening (2026-08-06)

The contract-v3 correction proves the authenticated semantic answers, but it does not prove that
the currently loaded TikTok content script reaches or operates the real controls. The live widget's
unchanged `Filled 1 / Needs information 10 / Technical issues 0` aggregate therefore remains an
open production acceptance failure until a fresh diagnostic from the authenticated browser is
captured.

### Newly isolated actuator gaps

- The eligibility transaction assumed the discovered wrapper was clickable. The real interactive
  trigger can instead be a nested combobox, menu button, `aria-controls` owner, or focusable child.
- Opening used one pointer sequence and searched one visible listbox/menu. It did not progressively
  try click, pointer, and keyboard behavior, or observe dynamic portal insertion.
- Verification read the original element. A React render that replaced the trigger after open or
  selection could be misclassified or read from a detached node.
- Retry did not assign a question-resolution run identity or reject a late response from the prior
  run. Cached option enumeration and unresolved entries could survive the user's retry.
- The diagnostic recorded actuator reachability but did not expose the complete transaction state
  trail or provide a separate capture of an already-open live control/listbox.

### Implementation

- `dropdownTransaction.ts` now runs a bounded generic choice transaction with explicit states from
  `DISCOVERED` through `FILLED`; locates the real trigger; tries click, complete pointer, then
  keyboard opening; observes dynamic/owned/body-portaled listboxes; performs polarity-safe Boolean
  matching; selects through page behavior; reacquires after framework renders; and verifies display
  plus backing state.
- `resolutionRun.ts` gives every retry a build-bound run ID and creation time. The content script
  clears prior per-run option probes, traces, and ledger entries and ignores late responses whose
  run ID is no longer active.
- The widget includes a developer-only per-field transaction panel and a separate **Capture current
  control** action. The capture is restricted to eligibility controls, hashes class names, redacts
  backing values, and records closed/open control structure, ARIA ownership, visible options,
  descriptor, redacted resolver result, ledger item, and actuator reachability.
- Resolver schema/answer-contract mismatches now block actuation visibly. A known semantic result
  that loses its display handoff becomes `INTERNAL_HANDOFF_FAILURE / technical_issue`.

### Acceptance status

- [x] Focused transaction, optionless Boolean, ledger, runtime identity, and stale-run tests pass.
- [ ] Capture the real authenticated TikTok closed and manually opened control structures.
- [ ] Prove the loaded content/worker/panel build, exact API base, account 3, session, and profile
  revision from one fresh diagnostic.
- [ ] Prove both fields reach `QUEUED_FOR_ACTUATION` and then either `FILLED` or an honest stable
  technical failure code.
- [ ] Only after both committed values verify may this production-only issue be called fixed.

### Automated validation for this hardening

- `make test-extension`: typecheck, 603 tests in 42 files, and production build passed.
- Full Playwright suite: 99/99 passed after rerunning outside the macOS sandbox; the sandboxed
  attempt failed before assertions with loopback/Mach-port permission errors.
- Final artifact targeted Playwright: 23/23 question-resolution, shipped-extension, and session
  handoff cases passed after the final unsafe-submit-trigger guard.
- `make test-api`: 1,565 passed, 2 PostgreSQL-marked tests skipped, 1 dependency deprecation warning.
- `docker compose config --quiet` and `git diff --check`: passed.
- Final extension artifact: version `0.2.0`, build `44364f1-dirty-7da8532`, containing the explicit
  transaction states, stale-run protection, contract/runtime mismatch codes, control capture, and
  developer transaction panel.

## ATS resume-parse takeover architecture (2026-08-06)

### Newly proven production boundary

The authenticated TikTok run established that the resume upload itself succeeds. TikTok then
parses the document, populates fields, inserts sections, and replaces React control nodes. The old
extension order was inverted: employment/education repeaters and legal-question resolution ran
before `runAutofill`, while `runAutofill` filled scalar fields before uploading the resume. Once
that first pass set `automaticRunSettled`, the generic mutation observer would not start another
authoritative fill. The visible 11-field ledger was therefore a pre-parse snapshot.

### Lifecycle decision

The content script now owns an explicit `AtsLifecycleRun`:

1. discover only enough of the initial page to find document controls;
2. upload and verify the resume;
3. observe the full application document for relevant ATS mutations;
4. require a bounded quiet window rather than a fixed sleep;
5. invalidate the pre-parse DOM generation and all stale resolver/ledger state;
6. reacquire the application root and scan it from scratch;
7. reconcile ATS-populated values against the session snapshot;
8. fill legal questions and remaining scalar fields from the current generation;
9. fill safe supported repeatable sections idempotently;
10. verify and publish a provenance-aware final ledger.

Every transition records the lifecycle run ID, timestamp, session ID, safe page fingerprint, DOM
generation, extension build, reason, and counts. Async work must retain the post-parse token; late
pre-parse results fail the run/generation check and cannot update the ledger.

### Reconciliation and repeatable sections

- ATS-populated values are classified as match, conflict, unverifiable, empty/resolvable,
  empty/missing, or unsupported. Matching values are preserved; conflicts are never overwritten.
- Phone, URL, country, date, case, and whitespace normalization is conservative and field-aware.
- The session snapshot now includes user-saved structured projects, awards, and professional links
  in addition to employment and education. No PDF text is sent to the page.
- Generic section discovery uses accessible headings and relative structure. Editors may be modal,
  portaled, or inline; Add/Save actions are scoped to the identified section and final application
  submission controls are forbidden.
- Projects, awards, languages (only when an explicit proficiency exists), work samples, SNS links,
  and grounded self-introduction have explicit policies. Internship remains review-only because the
  current profile model does not store a confirmed employment-type classification.
- Normalized record fingerprints make retry idempotent. Existing ATS records are not duplicated.
- Optional empty fields and Add sections are `optional_skipped`, not `needs_information`.

### Rollout and rollback

- Roll out the API session-snapshot expansion before the extension. Older extensions ignore the new
  keys, so the API change is backward-compatible and requires no migration.
- Monitor only lifecycle states, counts, DOM generations, section enums, and stable failure codes.
  Never log field values, resume text, tokens, or profile records.
- Roll back the extension first if ATS settling produces regressions. The previous API response
  shape remains compatible. No database downgrade is involved.

### Live acceptance status

- [x] Local real-browser fixture proves initial discovery, async ATS replacement, stale-node
  invalidation, post-parse rediscovery, live authorization actuation, project creation, duplicate
  prevention, and optional-section skipping.
- [ ] Authenticated TikTok trace proves `WAITING_FOR_ATS_PARSE` through `REVIEW_READY`.
- [ ] Authenticated TikTok verifies authorization Yes and combined sponsorship No on generation 1.
- [ ] Authenticated TikTok verifies existing education/experience remained intact and no duplicate
  repeatable records were created.

### Automated validation for ATS takeover

- `make test-extension`: typecheck, 623 tests in 46 files, and production build passed.
- Full Playwright suite: 102/102 passed in real Chromium, including async ATS DOM replacement,
  generation invalidation, post-parse authorization actuation, project idempotency, and optional
  section skipping.
- `make test-api`: 1,565 passed, 2 PostgreSQL-marked tests skipped, 1 dependency deprecation
  warning.
- `docker compose config --quiet`, import-order lint for the changed API service, and
  `git diff --check`: passed.
- Final extension artifact: version `0.2.0`, build `44364f1-dirty-b7d5b58`, containing the ATS
  lifecycle, post-parse invalidation and rediscovery, reconciliation classes, repeatable-section
  policies and fingerprints, optional-section classification, rescan action, and generation-aware
  diagnostics.
- Web code was not changed by this lifecycle task, so the web gate was not rerun.

## Final-live-DOM completion gate (2026-08-06)

### Release-blocking false-completion diagnosis

The authenticated trace showed the privacy checkbox but no work-authorization or sponsorship
transactions. The disappearance occurred in discovery before resolution: a generated ancestor
class matching the broad `[class*="-control"]` fallback could wrap multiple semantic comboboxes.
The old collapse logic kept the outermost wrapper, and `insideCustomControl` used the unfiltered
wrapper set, so both legal controls could be absorbed into one ambiguous pseudo-control while the
native privacy checkbox survived. Because required detection relied primarily on native/ARIA
attributes, the remaining legal controls could also be classified optional when TikTok expressed
requiredness only through question semantics. Historical ledger counts then allowed the lifecycle
to publish ready without a fresh inventory of the live post-parse form.

### Architecture and decisions

- Discovery retains semantic controls and only accepts a nearest React-style wrapper when it owns
  exactly one semantic control. A broad section wrapper containing multiple controls is excluded
  before native-control suppression runs.
- Required classification records independent evidence: native/ARIA required state, ATS metadata,
  visible markers, native validation, and conservative known authorization/sponsorship semantics.
- `FINAL_LIVE_DOM_RESCAN` reacquires the application root after scalar and repeater work. The new
  verifier inventories the current DOM generation, assigns a value-independent structural
  fingerprint, replaces detached historical entries, and requires exactly one final ledger entry
  per live control.
- A required control absent from the historical ledger becomes
  `REQUIRED_FIELD_MISSING_FROM_LEDGER`; a traced control lost during merge becomes
  `FIELD_DROPPED_DURING_MERGE`; a known answer that never reaches actuation becomes
  `INTERNAL_HANDOFF_FAILURE`. Display text without a committed custom-control backing value is not
  verified.
- Consent is a separate manual action (`CONSENT_REQUIRES_USER`), never eligibility success and
  never a technical autofill failure. It may remain for user review but still blocks the explicit
  “Mark application complete” action until the employer control is satisfied.
- Repeaters now report precise terminal reasons. Confirmed candidates with no Add control are
  `ADD_CONTROL_NOT_FOUND`, not an optional skip. A reusable application session refreshes its
  structured profile snapshot so project/award/link candidates cannot remain frozen at zero.
- Structured candidate counts are emitted at the database/session snapshot, parsed extension
  state, and repeater-selection boundaries. Reviewed resume extraction remains zero because there
  is no reviewed structured-extraction contract; generated PDF content is not promoted into
  application facts.

`REVIEW_READY` is permitted only when the final rescan is current, at least one non-consent
required live control exists, every required live control is verified, every known answer has a
terminal outcome, no final technical or application-validation issue remains, and every repeater
candidate has a terminal result. Historical success cannot satisfy this predicate.

### Validation and release evidence

- `make test-extension`: typecheck, 47 files / 636 tests, and production build passed.
- Built-extension Chromium coverage: all 103 scenarios passed across the full run and the complete
  rerun of the affected 17-test serial file. This includes two blank legal comboboxes plus privacy,
  known-answer handoff failure, empty custom-control backing state, DOM-generation replacement,
  consent separation, and project candidate without an Add control.
- `make test-api`: 1,565 passed, 2 expected PostgreSQL-marked skips, 1 dependency warning.
- `make test-web`: lint, typecheck, production build, and 26 files / 369 tests passed.
- `docker compose config --quiet` and `git diff --check`: passed.
- Artifact inspection found the final rescan, missing-ledger/merge failures, consent reason,
  precise repeater reason, and structured candidate counts in `dist/content.js`; build
  `44364f1-dirty-0bf68c2`.

### Rollout, rollback, and live acceptance

- Deploy the backward-compatible session-snapshot API change before the extension. No schema or
  migration change was introduced by this gate.
- Roll back the extension first if the conservative classifier produces excess manual review; the
  API additions are safe for older clients. Roll back the API refresh/count metadata separately if
  necessary; no database downgrade is involved.
- [x] Automated TikTok-shaped fixture proves the prior false-ready state is blocked.
- [x] Automated fixtures prove authorization Yes and sponsorship No can each actuate and verify.
- [x] Privacy is shown separately and cannot be the sole eligibility trace.
- [ ] A fresh authenticated TikTok diagnostic must prove the loaded build/account/session,
  post-parse generation, one trace for each legal field, candidate counts at every boundary, and
  committed display/backing values. Until that trace exists, do not claim live TikTok success.

## First-class TikTok legal adapter (2026-08-06)

### Scope and activation

Generic discovery still omitted both visible legal controls in the latest authenticated page,
producing the impossible `required verified 0 / required remaining 0` state. The final release
blocker is therefore handled by a narrow `TikTokApplicationAdapter`, not another generic wrapper
heuristic. It activates only for HTTPS `careers.tiktok.com/position/<id>`, `/detail`, or `/apply`
paths and only when an exact visible `Work Authorization` section exists. Repeatable sections are
out of scope and unchanged.

### Detection, identity, and interaction

- Exact normalized alias tables identify authorization and combined sponsorship question text.
- The adapter finds the smallest row that owns each complete question, then ranks native selects,
  ARIA comboboxes, listbox buttons, controlled/expanded elements, inputs, and focusable descendants.
  It may inspect an aligned adjacent cell but rejects any container holding both legal questions.
- Fixed identities are `tiktok:work_authorization:authorization` and
  `tiktok:work_authorization:sponsorship_now_or_future`; DOM generation remains a separate trace
  dimension. Broad wrappers and generic legal descriptors are removed before merging the adapter
  fields into the resolver/final inventory.
- Both fields are required independent of native required metadata. Missing rows/controls remain
  explicit inventory entries and become `TIKTOK_LEGAL_CONTROL_NOT_FOUND`, never optional skips.
- The authenticated backend resolver remains the semantic authority. The adapter passes its fixed
  fields through the existing question batch and dropdown transaction; it does not infer answers
  or use an LLM.
- The bounded transaction recognizes already-open menus, reports the successful open strategy,
  searches owned/local/portaled options, and reacquires the adapter identity after open and after
  selection. Final verification accepts display or backing as the authoritative TikTok source
  when only one exists, while rejecting a contradictory known source.
- Known resolved answers that fail synthetic interaction receive an assisted widget action such as
  `Select Yes for work authorization`. The action synchronously scrolls, highlights, focuses, and
  opens the exact trigger using the user's gesture, then selects only the resolver-approved option
  and reruns final live verification. It never stores a new answer or submits the application.

### Focused pre-live validation

- TypeScript typecheck: passed.
- Focused Vitest: 4 files / 128 tests passed. Coverage includes exact URL gating, aliases, two
  distinct required identities, privacy separation, click/pointer/keyboard opening, portaled
  options, React replacement after open and selection, assisted opening, precise missing/open/
  option/commit failures, 0/2, 1/1, and 2/0 final inventory, and no optional-skip failures.
- Focused real-Chromium fixture: 1 passed. The adapter inventoried both blank controls, blocked
  readiness at 0/2, selected authorization Yes and sponsorship No, reacquired replaced triggers,
  verified 2/0, and left privacy unchecked.
- Production extension build passed: version `0.2.0`, build `44364f1-dirty-1737857`.

### Acceptance gate

- [ ] Reload the produced unpacked extension and reopen the authenticated TikTok application tab.

## Final TikTok inventory and application-launch handoff blockers (2026-08-06)

### Production evidence and root cause

- The legal section could be visibly present while the adapter was absent because section discovery
  was gated behind one historical `careers.tiktok.com/position/<id>` pathname expression. Locale,
  portal, application, query, hash, and SPA route variants therefore returned no adapter inventory;
  final merging had nothing authoritative to merge and could incorrectly report zero required legal
  controls.
- Application-surface phrases covered Apply/Start/Continue but not the reported “I’m interested”.
  Durable navigation state was created for URL-first activation only, after destination extraction;
  a script-driven or user-assisted CTA could navigate or open a tab before the worker had a pending
  application-launch record.

### Architecture and decisions

- TikTok activation now requires the exact approved HTTPS `careers.tiktok.com` origin, an
  application-shaped route, and the visible normalized Work Authorization section in the scoped
  application root. Section inspection is never suppressed by a pathname mismatch, so diagnostics
  can distinguish origin/route activation failure from section/row/control failure.
- The adapter owns exactly two stable identities and final verification reports their inventory,
  actuator, and verification boundary explicitly. Privacy consent remains a separate manual action.
- Application-start selection is semantic and confidence-scored. “I’m interested”, “Submit
  interest”, “Join us”, and “Apply externally” are recognized; referral/share/save/history/similar
  jobs and final Submit controls are rejected.
- Before any navigation, synthetic click, or user-assisted click, the content script asks the worker
  to persist a bounded `PENDING_NAVIGATION` record with launch/session/source/job/build metadata.
  URL-first same-tab/new-tab navigation updates that record, popup adoption carries the existing
  session package, redirects remain bounded, and approved external ATS origins can rebind without
  exchanging the single-use launch token again.

### Validation and acceptance

- [x] Focused adapter/surface/handoff/launch unit tests pass (80 tests in the combined focused run;
  72 tests in the final modified-file rerun).
- [x] Focused Chromium TikTok fixture passes using a locale/portal/query/hash URL variant.
- [x] Focused Chromium “I’m interested” fixture rejects “Refer a friend”, opens a new-tab external
  ATS destination, finds the application root, and exposes the resumable handshake state.
- [x] TypeScript passes.
- [ ] Authenticated TikTok smoke proves both committed values and the adapter health trace.
- [ ] Authenticated ServiceNow-style smoke captures the actual CTA click outcome and complete worker
  launch trace. Fixtures are not evidence of the live outcome.

### Rollout and rollback

- Roll out only as a new unpacked extension build for the two authenticated, non-submitting smoke
  tests. Do not run broad suites or declare release-ready until both live traces pass.
- Roll back by restoring the prior TikTok route gate and removing the pre-click prepare message plus
  launch-record enrichment; no API/database contract or migration is involved. If live CTA
  confidence is ambiguous, retain the durable launch record and fall back to the user-assisted Open
  application action rather than lowering the threshold.
- [ ] Prove authorization visibly commits Yes and sponsorship visibly commits No, automatically or
  through the assisted actions.
- [ ] Prove required verified is 2, required remaining is 0, privacy consent is one manual action,
  neither legal identity is optional-skipped, and no false ready state appears while either is blank.
- [ ] Only after this authenticated result run full extension, Playwright, API/web-if-changed,
  lint, and repository hygiene gates. Fixtures alone are not production acceptance.

## Unfillable control shapes and the unnamed Easy Apply dropzone (2026-08-08)

### Reported production state

Two authenticated runs, both ending `TECHNICAL_REVIEW_REQUIRED`:

- **TikTok** (`lifeattiktok.com`): the adapter activated and inventoried both legal identities
  (`required remaining 2`, `needs information 0`), so the semantic answers were present and the
  failure was actuation — the Yes/No menu was never driven, automatically or through the assisted
  action.
- **ServiceNow / SmartRecruiters**: `ATS populated 0 · JobPilot filled 9 · section records added 0`,
  with the "Easy Apply" dropzone still empty and Experience/Education blank. No document ever
  reached the ATS, so nothing was parsed and neither section could be populated from a parse.

### Root causes isolated by inspection

1. **Trigger refinement was narrower than trigger discovery.** `locateChoiceTrigger` matched
   `role="combobox"`, `aria-controls`, `aria-expanded`, `button`, and `tabindex`. The application
   adapter deliberately accepts a wider set, including a bare readonly `<input>` and a
   `<div aria-haspopup="listbox">`. A control the adapter had positively located was therefore
   rejected by the transaction, which returned `control_not_found` — mapped to
   `TIKTOK_LEGAL_CONTROL_NOT_FOUND` — without a single click being sent.
2. **A press-driven widget could never be opened.** Open order was plain `click`, then the full
   pointer sequence, then keyboard. A widget that opens on `mousedown` ignores the plain click, and
   the full sequence's trailing `click` dismisses the menu the press had just opened. Both attempts
   ended closed, and the keyboard attempt is not offered by such widgets.
3. **A role-less portaled menu was invisible to menu discovery.** Every lookup keyed on
   `role="listbox"`, `role="menu"` or `role="option"`. A `<div class="…-dropdown"><ul><li>Yes` gets
   none of those, and a menu plainly on screen was reported as `menu_not_opened`.
4. **A document dropzone that never says "resume" was skipped entirely.** Upload classification
   required the words resume/CV/cover letter in the control's own context. The live Easy Apply block
   reads "Easy Apply / Choose an option to autocomplete your application / Choose a file or drop it
   here / 10MB size limit". It was the only upload control on the page and it was not offered, which
   is the whole ServiceNow chain.
5. **Document discovery was confined to the scored question root.** An Easy Apply block frequently
   sits above that root.
6. **A pre-rendered empty entry form was ignored.** The live Experience and Education sections ship
   a blank editor beside their "+ Add" button; pressing Add appends a second blank row and leaves
   the visible one untouched.

### Changes

- `locateChoiceTrigger` accepts `[aria-haspopup]` on any element and, when nothing inside refines
  the discovered element, drives that element itself. Ambiguity between two plausible triggers, and
  a default-submit button, remain refusals.
- A press-and-release open strategy (`openStrategy: "mouse"`) is tried after click and the full
  pointer sequence, so it costs nothing on the paths that already worked.
- `findMenu` gains a bounded role-less fallback used only after every role-based lookup has failed
  and never inside the mutation-observer hot path: the page's top-level portal containers and the
  trigger's own row, requiring a floating/menu-named container, short choice-shaped children, AND a
  box drawn against the trigger (≤48px horizontal, ≤24px vertical gap). Without a declared ARIA
  relationship, position is the only evidence of ownership, so a list elsewhere on the page is
  never clicked whatever its class name says. Wrapper descent in `roleLessOptions` is now
  depth-generalized.
- Option activation uses the coordinate-bearing pointer sequence with hover, exactly one click.
- `enumerateOptions` drives the same trigger the fill will, uses the same option extraction, and
  falls back to the press-only open.
- `discoverUploadInputs` admits an unnamed document dropzone: document-only `accept` (never images)
  plus application wording in the surrounding block, used only when it is the sole such control and
  the page named no resume field. `resolveUploadTargets` consults the whole document once when the
  scored root offered no resume target.
- `openEditor` fills an entry form the section already shows when it holds at least two controls and
  none of them has a value; anything else still presses Add.

### Validation

- `make test-extension`: typecheck, 54 files / 793 tests, and the production MV3 build passed
  (`44364f1-dirty-9d709b2`).
- Full Playwright suite in real Chromium: 129/129, including three new `roleless-dropdowns` cases
  covering the div trigger, the mousedown-toggled widget, and the role-less portaled menu.
  One earlier full run failed `question-resolution.spec.ts` Scenario A on its fixed 4.5s wait; the
  press-only attempt was reordered after the full pointer sequence to remove the added latency, and
  three subsequent full runs passed.
- `make test-api`: 1,567 passed, 1 dependency deprecation warning.
- Every new test was confirmed to fail against the unfixed code before being kept, including the
  anchoring guard.
- No API or web source changed, so the web gate was not rerun.

## Search pickers, Experience descriptions (2026-08-08, second pass)

### Reported production state

A second authenticated ServiceNow run: JobPilot types the stored Title/Company/Institution, the
picker opens its suggestion list, nothing is selected, and the field ends up **empty** — Institution
even showed "Arizona State University" above a red "Value is required". The Experience Description
box stayed blank. Education rendered two editors with the record written into the second and the
first left empty.

### Root causes

1. **A suggestion list with no exact match ended the attempt.** In `fields/dropdown/index.ts`, free
   text was only ever attempted when the menu was *completely empty*. The live pickers do produce
   suggestions — just not ones equal to the stored value ("Machine Learning Engineer" offered for
   "Machine Learning Engineer, Contract"). `matchOption` failed, the attempt ended
   `OPTION_NOT_AVAILABLE`, and the adapter's `close()` (Escape + blur) discarded the typed text.
2. **`commitFreeText` could not tell "kept" from "accepted".** A lookup that requires a picked
   record holds the typed text and marks itself `aria-invalid`. Reporting that as filled would be a
   false success on a required field.
3. **The Experience Description had no source at all.** `Experience` stores `bullets`,
   `technologies` and `measurable_impact` — there is no `description` column — and the session
   snapshot in `session_service.build_session_payload` omitted all three. The extension's
   `getCandidateRecords` therefore always produced `description: ""`.

### Changes

- When suggestions exist but none matches, `attemptFill` now tries, in order: `nearestUniqueOption`
  (an option that extends the stored value, or that the stored value extends, at a word boundary,
  and **only when exactly one** option stands in that relationship), then the exact stored value as
  free text. Ambiguity — "Veotrex Labs" and "Veotrex Systems" for "Veotrex" — stays a failure the
  user resolves; nothing is guessed.
- `commitFreeText` rejects a control that is holding the text while reporting itself invalid,
  recording the new `FREE_TEXT_REJECTED` event instead of claiming a fill.
- The session snapshot carries each experience record's reviewed `bullets` and `technologies`
  (additive and backward-compatible; older extensions ignore them). `experienceDescription` builds
  the Description from an explicit description if present, otherwise from those bullet lines, and
  leaves the box empty when the record carries neither. Nothing is generated and no resume document
  text is sent to the page.

### Validation

- `make test-extension`: typecheck, 55 files / 799 tests, production build `44364f1-dirty-2db41ee`.
- `make test-api`: 1,567 passed.
- Full Playwright suite: 129/129.

## Lookup selection and visible failure codes (2026-08-08, third pass)

The Description now populates on the live form, which confirms the build and the API snapshot
change reached the browser. Two things remained.

- **A lookup stores a RECORD, not text.** Title, Company, Institution and the location fields show
  "Value is required" under text that is plainly there, because nothing was chosen from the
  suggestion list. `attemptFill` now tries `onlySearchResultFor` after `nearestUniqueOption`: when
  the remote search returned exactly ONE usable suggestion and it is the same thing said with more
  or fewer words (every significant word of one appears in the other), it is selected. A shared
  leading word is explicitly not enough — "Arizona State University" and "Arizona Western College"
  share "Arizona" and are different schools, and a test pins that refusal.
- **`commitFreeText` judged the invalid state too early.** These components flip to
  `aria-invalid` on each keystroke and clear it when their own validation runs, so the check now
  waits for the control to settle before condemning a value it was about to accept.
- **The failure code was invisible.** It was reachable only by expanding the transaction trace, so
  the one fact that says WHY a required field did not fill did not appear in any screenshot of a
  stuck application. Each unresolved review card now shows its stable, low-cardinality reason code
  inline (no answer value, selectable for copying).

### Validation

- `make test-extension`: typecheck, 55 files / 801 tests, production build `44364f1-dirty-2ed538d`.
- Full Playwright suite: 129/129.

### TikTok: still unresolved, and what is now known

Three real defects on that path are fixed and regression-tested (trigger refinement, the
press-driven open, the role-less portaled menu), and the live page is unchanged: `Filled 1 of 15`,
`required remaining 2`, `technical issues 9`, `needs information 0`. The semantic answers therefore
resolve; the failure is in the transaction, and it is NOT any of the three fixed causes.

Because the counts are byte-identical across every run, the next candidate is that actuation never
starts — `INTERNAL_HANDOFF_FAILURE`, raised when the resolver returns `status: resolved` with a
boolean but `matchResults` produces no `approvedLabel` (a `selected_option_ref` that is not in
`labelByRef`). That path records a technical issue without touching the DOM, which matches "I don't
see anything happening" exactly. The inline reason code shipped above distinguishes it from
`LISTBOX_NOT_OPENED` / `TIKTOK_LEGAL_CONTROL_NOT_FOUND` on sight.

### Live acceptance still outstanding

- [ ] A fresh authenticated TikTok diagnostic showing `openStrategy`, `listboxFound`, and the
  per-field failure code for both legal identities.
- [ ] A fresh authenticated ServiceNow diagnostic showing the resume upload target resolving and
  `resumeCommitted`, then whether the ATS parse populates Experience/Education.
- Neither destination may be called fixed on fixture evidence alone.
