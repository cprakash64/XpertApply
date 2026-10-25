# XA-EXT-NAV-02-R — multi-application session isolation and grounded answers to open-ended questions

Status: in progress on `feature/xa-core1-direct-autofill` after `cec67c4`. Not pushed, not deployed. Backend work lives on a **separate branch and worktree**, never mixed with extension commits.

## P0 — a launch started while another application is open

### Evidence and classification
Reproduced in a real Chromium with the real e2e extension build against an owned backend and TLS fixtures under real hostnames (`jobs.ashbyhq.com` as the ElevenLabs shape, `job-boards.greenhouse.io` as the SoFi shape). Spec: `e2e/xa-nav02-multiapp.spec.ts`.

| Scenario | Result before | Result after |
| --- | --- | --- |
| Launch B while A is open and unfinished (sequential) | works | works |
| Worker suspended between the two launches | works | works |
| Launch A and B in the same instant | **B filled but no assistant opened in ~4 of 8 runs; one run left A unfilled** | 8/8 (+16/16 spec repeats) assistant opens and fills in both tabs |
| Two different jobs on the same employer host launched together | intermittent | each tab bound to its own application |

**Confirmed cause (race, not a data leak).** `chrome.tabs.create()` resolves after the new tab's first document may already have reported ready. The worker only recorded the tab afterwards (`putPending` + `putView`). In that window the document bound itself from the single global `ACTIVE` launch, which:
1. carried no `userStarted` (the staged record never had it), so the automatic assistant was skipped, and
2. was later **overwritten** by the launch's own `putPending`/`putView`, resetting the tab's progress; nothing re-triggered the assistant.
`ACTIVE` also holds only the *newest* launch, so a second launch erased the first one's only unclaimed record.

**Not found:** no cross-job data or document leak was reproduced. Filled values, views and packages stayed per tab in every run. Whether the user's SoFi failure had exactly this cause cannot be proven from here; it is the only failure reproduced, and it matches the symptom (form present, assistant absent).

### Fix
* `state.ts`: `unboundLaunchesV1` registry keyed by the immutable `requestId` (superseded only by a newer launch of the *same* application); `claimTabForLaunch` claims the tab in one serialized mutation and keeps a binding/progress the first document already made.
* `background.ts`: `stageHandoff("opening")` marks the launch `userStarted`; an unclaimed document is resolved through `resolveUnboundLaunch` — exactly one matching candidate binds, several **fail closed**; no "latest launch" fallback; `DRAFT_ANSWERS` verifies the tab's package belongs to the named session.
* Cleanup paths (`clearAllWorkflowState`, `clearWorkflowSession`, `cleanupExpired`) maintain the registry; clearing one session never touches another.

### Invariants checked
1 unique immutable launch id — `requestId` keys the registry. 3/4/11 launching or ending one never replaces or removes another — unit + e2e. 5/6 tab switches do not change ownership — e2e. 8 late completion cannot cross sessions — drafts are dropped when the document's session changed. 9/10 same-domain different job, ambiguous ownership — fail closed (e2e + NAV-01 specs). 12 survives worker suspension — e2e.

## P1 — grounded drafting of open-ended answers

### What already existed
`apps/api/app/applications/generated_answer_service.py` drafts **one** fixed question ("Why are you interested in {company}?") at session creation with the configured OpenAI models (`gpt-5.6-sol` / `gpt-5.6-terra`, server-side key, `ai_provider.json_task`). Nothing answered arbitrary employer questions, which is why the four ElevenLabs narrative questions stayed empty.

### Backend (separate branch `feature/xa-nav02-answer-drafting`, based on staging `6640e0b`)
`POST /application-sessions/{id}/draft-answers` — session-authenticated, user and job derived from the session, ≤8 questions, 600-char questions, rate limited, no migration. Candidate facts only (no contact data, authorization or demographics) go to the model; output is validated in code (sources must exist and match exactly, unsupported specifics/URLs/contacts rejected, field limit respected at a sentence boundary, a draft must cite a profile/resume fact). Legal, consent, compensation, authorization and demographic questions are never drafted. Provider failure/timeout/malformed output yields `unavailable`/`invalid_response`, never a template.

### Extension
After the deterministic fill, empty visible textareas whose label is a real question are sent (labels only) to the worker; verified drafts are inserted, shown as "Suggested — review", counted as needing review, never marked verified, never overwriting text the applicant has typed.

## Validation, rollout, rollback
See the handoff for results. Extension rollback: ship the previous build (new registry key is ignored by old builds). Backend rollback: remove the route; no data is stored.

## XA-EXT-NAV-02-V1 verification (final gate)
* Extension `cbe3b14` (on `22c9c80`), backend `acf8d8b` (on `0f9c8ef`, base `6640e0b`). Full Playwright, one worker, zero retries: **263 passed, 0 failed, 0 skipped**, exit 0 (includes the real-FastAPI/PostgreSQL 16 spec and the compatibility test against the current staging backend code). Vitest 1553. Backend 2156 passed, 0 skipped with a disposable local PostgreSQL 16 (the 82 earlier skips were all missing-Postgres/env guards).
* Defects found and fixed by the real-backend run: drafting was accepted on an expired session (now 410); multi-paragraph answers were flattened (paragraphs kept); the user's per-origin auto-open off switch was ignored on website launches (now honoured).
* Findings, not changed: names/email/links are filled only when verified in the answer vault; the real backend publishes email, GitHub and LinkedIn as unverified, so they stay for the applicant. Live OpenAI and native Chrome acceptance remain NOT VERIFIED.
* Deployment order: review backend, back up staging, deploy backend, verify the endpoint, load the staging extension, native Chrome acceptance. The new extension also works against the current staging backend (drafting simply unavailable), so installing it first is safe.
