# XA-07 — Submission confirmation remediation

## Finding and evidence

- **Finding:** XA-07 (Medium), the missing submission-confirmation feature.
- **Authoritative repository evidence:** `apps/extension/src/__tests__/module_reachability.test.ts`
  records that Stage 3B-R1 removed `ats/submissionEvidence.ts` because it had no
  production producer and explicitly says XA-07 remains open until the logic is
  reimplemented on the live path.
- **Current reproduction:** the shipped content entrypoint, message schema,
  service worker, API client, and backend endpoint contain a complete consumer
  chain, but no production content module emits `SUBMISSION_CONFIRMED` or
  `MANUAL_CONFIRMATION_REQUIRED`. A real user submission reaching a deterministic
  success page therefore makes no confirmation API request.
- **Classification:** CONFIRMED.

## Root cause

The content script never observes post-submit navigation or DOM evidence, so it
cannot invoke the existing confirmation chain. The former evidence evaluator
was tested in isolation but never imported by a production entrypoint; Stage 3
correctly removed that dead code while leaving XA-07 open.

## Architecture and decisions

1. Restore one pure, fail-closed evidence evaluator and import it from the live
   content bootstrap.
2. Evaluate only deterministic ATS-produced evidence: a narrowly qualified
   post-submit URL, or deterministic past-tense confirmation copy while the
   application form/submit control is absent. A click, disappearance, ordinary
   navigation, disabled control, timeout, or error/review copy never confirms.
3. Observe DOM mutations and full-page navigation/reconnect without ever
   activating the final submit control. The user remains the only submitter.
4. Bind the privileged background action to Chrome's `MessageSender` tab/frame,
   that tab's pending workflow, and its cached session package. The message's
   session id must match; it never selects an arbitrary cached package.
5. Keep retry safety at both layers: one content instance sends once, the
   service worker deduplicates best-effort, and the backend remains authoritative.
6. Do not intercept page `fetch`/XHR from a main-world script. Chrome content
   scripts run in an isolated world; adding a main-world bridge would broaden
   the attack surface and is unnecessary for the deterministic URL/DOM cases.

Authoritative platform references:

- Chrome documents that content scripts execute in an isolated world:
  <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- Chrome's messaging security guidance says content-script messages must be
  treated as attacker-crafted and privileged actions must be narrowly scoped:
  <https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations>
- `runtime.MessageSender` supplies the browser-derived tab, frame, URL, and
  origin used by the service-worker gate:
  <https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender>

## Validation

- Unit tests for accepted and refused evidence, reference extraction, and
  evidence-only payloads.
- Background trust tests for sender-tab/session binding and refusal cases.
- Production-build Chrome test: a trusted user click submits the fixture,
  navigation reaches a confirmation page, and exactly one evidence-only API
  request is sent. The existing no-auto-submit test remains green.
- Mutation negative control: disable the live observer call and prove the
  targeted production-build regression fails, then restore it.
- Extension typecheck, unit suite, build, full E2E suite, diff check, and fsck.

## Rollout and rollback

Ship with the normal extension release after validation. Monitor confirmation
outcomes by evidence type and failures by machine reason only; do not log page
copy, URLs, tokens, or candidate data. Rollback is removal of the live observer
and evidence module; the manual “Mark as applied” path and backend endpoint are
unchanged and remain available.

## Progress

- [x] Resolve authoritative XA-07 definition and check for conflicts.
- [x] Reproduce the missing producer on current HEAD and classify CONFIRMED.
- [x] Document root cause and minimum design before production edits.
- [x] Add failing production-path regression (current HEAD: 0 confirmation
  requests after a real user submission and deterministic success navigation).
- [x] Implement the minimum live-path remediation.
- [x] Run mutation negative control and required validation.

## Validation record

- Pre-fix production-build regression: **failed as expected**, received 0 API
  confirmations where 1 was required.
- Restored implementation production-build regression: **passed**.
- Mutation control (`evaluateCurrentSubmission` bypassed): **failed as
  expected**, again receiving 0 confirmations; source restored afterward.
- `make test-extension`: **passed** — typecheck, 64 files / 996 unit tests, and
  production build.
- Full `npm run test:e2e` final acceptance run: **137/137 passed**. An earlier
  run had one unrelated delayed-dropdown timing failure and three serial skips;
  its focused rerun passed **4/4** before the final clean full run.
- Final fresh-build Chrome checks: **2/2 passed** (never auto-submit; report one
  user-submitted application).
- `docker compose config --quiet`: the direct command was blocked by the
  intentionally absent gitignored `.env`; validation with a temporary
  credential-free `!reset []` env-file override: **passed**.
- No database schema changed, so Alembic upgrade/downgrade checks are not
  applicable.
