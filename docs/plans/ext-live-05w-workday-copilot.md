# EXT-LIVE-05W — Workday-first continuous application copilot (extension 0.3.1 + follow-up)

Status: implemented locally on `feature/ext-live-01`. Not pushed, not published, not deployed. Extension ID unchanged.
The verified 0.3.1 candidate ZIP (`xpertapply-extension-0.3.1-44c107e.zip`, sha256 9dec55f0…5b3a) is NOT modified.

## Evidence and its limits
- No authorized live Workday session was available. Everything below is verified against OWNED Workday-shaped fixtures in jsdom and
  in real Chromium with the real extension. Nothing is verified against a live tenant.
- Competitor research (public pages only, no private implementation claimed): Simplify and Jobright both state Workday support; a 2026
  third-party review puts Simplify at roughly 70% of Workday fields with dropdowns on later steps partial (unverified). No source
  confirmed either tool's multi-page Workday behaviour. Third-party extension listings name `myworkdayjobs.com` and `myworkdaysite.com`.
- `data-automation-id` names come from public descriptions of Workday markup and from the fixtures; every use has a visible-text fallback.

## Findings that shaped the design
1. Existing code already had a Workday adapter, a one-shot "advance after fill" and a verified fill pipeline. The advance fired after
   any Workday autofill with no explicit user start, treated "Create Account" and "Autofill with Resume" as clickable, and de-duplicated
   with a module-level Set that did not survive a reload.
2. Production discovery (`discoverQuestionFields`) never calls `adapter.discoverFields`; adapter-level hints would have been dead code.
   The automation-id label fallback therefore lives in `resolveQuestion` (last resort, source `workday_automation_id`).
3. Workday steps without identity fields (My Experience, a one-question Application Questions) scored below the form-root bar and
   stalled the run. Added a `workday_step` signal (+5) when the progress bar/heading names a known step.
4. `canEnterReviewReady` requires at least one required control, so it can never be true on a step with none. The workflow uses the
   individual live-DOM checks instead.
5. Legal/eligibility controls are deliberately NOT accepted as verified from a value typed straight into the employer form. That policy
   is kept: such a question keeps the run paused until the person confirms it through XpertApply review (covered by an e2e test).

## Architecture
- `src/ats/workdayStep.ts` — pure step classification (job_description, start_choice, sign_in, create_account, verification/CAPTCHA,
  my_information, my_experience, application_questions, voluntary_disclosures, self_identify, review, unknown_step), final-Submit
  detection, the single safe Next target, validation-error count, automation-id labels.
- `src/application/workflowEngine.ts` — pure bounded state machine (IDLE, DETECTING, FILLING, VERIFYING, WAITING_FOR_USER, ADVANCING,
  REVIEW_READY, FAILED, CANCELLED). Caps: 40 steps, 30 advances, 45 min, 20 s wait for a page change. One advance per step signature;
  a repeated signature is a loop and fails. Run bound to origin + application + account + run id; persisted (no values) in the page's
  `sessionStorage` (per tab, survives reloads and worker sleep); discarded on any identity mismatch.
- `content/bootstrap.ts` — `driveWorkflowAfterFill` observes, asks the engine, performs the single action; `reconcileUserAnsweredQuestions`
  records a non-legal answer the person typed on the form (read back from the live control) when they press Resume.
- `content/widget.ts` — Complete application / Pause / Resume / Cancel and a status line, inside the existing overlay.
- Boundaries: sign-in, account creation, verification/CAPTCHA/MFA, start-choice, Voluntary Disclosures and Self-Identify are
  user-only. XpertApply never clicks Create Account, Sign In, Autofill with Resume, Apply, or any Submit. A visible Submit means review.
- Hosts: `myworkdaysite.com` added to the Workday provider and as a fifth optional group grant (`https://*.myworkdaysite.com/*`).
  No manifest change (the pattern is inside the existing `optional_host_permissions: https://*/*`). NEEDS PRODUCT APPROVAL: the
  one onboarding dialog now names five domains. Source for the host is third-party; unverified live.

## Validation
`npx tsc --noEmit` clean; `npx vitest run` 109 files / 1628 tests; real-Chromium `e2e/workday-complete.spec.ts` (3 tests); full
Playwright regression result recorded in the release report.

## Not done / unverified
Live Workday acceptance (any tenant); dropdown/typeahead/date-picker/phone-device widgets specific to Workday (the existing
dropdown transaction layer is used unchanged and was NOT exercised against Workday markup); resume parsing reconciliation and
duplicate-entry checks against real Workday parsing; repeatable work/education entries on Workday; per-step counts display
("Step 3 of 6", "18 fields completed") and the final-review summary panel; MFA/CAPTCHA against a real provider; reload-resume in
real Chromium (unit-tested only); account switching in the browser (unit-tested only).

## Rollout / rollback
Same as 0.3.1: a new Store version, review required. Rollback: re-upload the 0.3.0 ZIP under a higher version. The run record is a
single `sessionStorage` key (`xpertapply.workflow.v1`) and is ignored by older builds.
