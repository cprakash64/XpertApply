# Stage 50A: tracker document downloads and answer drafting

Branch `feature/stage50a-doc-downloads-drafting`, cut from the production API release `1516f235746ab15aac42d19147496d1a8d9d4e92` (worktree `XpertApply-stage50a`). Nothing pushed, merged or deployed. No production or staging system was contacted. No migration.

## Findings

### A. Missing resume and cover-letter downloads
The feature is already implemented at `1516f23` (XA-RC-06 B, commits 29b8919, 959b994, ca1d7dd, 6640e0b; see `xa-rc-06-tracker-documents.md`): `GET /jobs/tracker/{id}/documents/{resume|cover-letter}?fmt=pdf|docx`, snapshot table `0036`, evidence-based association for pre-0036 rows, and the Download buttons in `TrackerClient.tsx`.

**Root cause (both documents): the web application serving production predates that code.** The download commits are not ancestors of the production-auth release `ceb8314` (`git merge-base --is-ancestor 29b8919 ceb8314` is false), and the NAV02 rollout deliberately did not recreate the production web container. Production therefore shows the inert labels from before XA-RC-06 B, while its API already has the route and the table. Resume and cover letter share one cause; the code treats them identically.

Not verified against production (not touched): that the live web image is the pre-29b8919 build. This follows from git history and the release state given in the brief; confirm with `docker inspect` on the web container before relying on it.

Other hypotheses, checked in code and tests:
- API responses or identifiers: present (`documents.{resume,cover_letter}.download_path`, `id`).
- Tracker/document mismatch: association uses the snapshot, else session evidence; never company name, fuzzy match or "latest for the job". Ambiguous history returns `unknown_association` and no file.
- Pre-0036 applications: no snapshot, so documents come from the evidence-linked session (`frozen: false`, labelled as the current saved copy). Applications with no evidence show a reason ("Documents exist for this job, but nothing links them to this application.").
- Missing/deleted files: documents are database content rendered on request, not files on disk, so there is no storage path to be missing or exposed. A deleted source document leaves the snapshot downloadable; a corrupt stored copy answers 409 and is never regenerated.

### B. Inaccessible AI answers
The backend is complete and gated: `question_drafting_service.draft_answers` (server-side OpenAI, source-cited, validated output, sensitive-question refusal), route `POST /application-sessions/{id}/draft-answers`, 503 `answer_drafting_disabled` when `APPLICATION_ANSWER_DRAFTING_ENABLED` is not literally true.

**Root cause: no client called it.** Nothing in the extension (or web) referenced `draft-answers`, so even with the flag on a user could not reach it. The flag is off by default, which is the second reason it is inaccessible today.

## Changes
Backend (cost and observability only; the provider integration is reused, not rebuilt):
- `routes/applications.py`: per-user daily ceiling `DRAFT_DAILY_LIMIT = 150` (after the existing 12/min), applied after the disabled gate, before any provider work. In-process like the existing limiter; per API worker.
- `question_drafting_service.py`: one info log per provider call with question count, source count, model, ai_used, reason code and elapsed ms. No questions, facts, drafts or key.

Extension (smallest end-to-end path):
- `api/client.ts` `draftAnswers`; `messages.ts` `MSG.DRAFT_ANSWERS`; `background.ts` handler. The worker holds the session token; 503 -> `DRAFTING_DISABLED`, 429 -> `RATE_LIMITED`, 410 -> `HANDOFF_EXPIRED`; no question or draft text is logged.
- `content/draftAssistant.ts` (pure rules): offers only empty, visible, enabled textareas with a real question; drops sensitive/authorization/demographic wording locally (mirrors the server list); caps at 8; strict response parsing; employer maxlength re-enforced; apply refused if the box now has text.
- `content/widget.ts` `showDrafts`: "Suggest answers for open-ended questions" button, loading/error states, per-question editable textarea, "Use this answer". `content/bootstrap.ts` wires it; the offer appears only if the page has a draftable box, and clicking when the feature is off shows "Answer suggestions aren't available right now."
- Nothing is written to the employer page until the user presses "Use this answer"; fill is not forced; nothing submits.

Web: no change. The Tracker download UI already exists and passes its tests; shipping it is a deployment action.

## Validation (local, mocked provider)
- API: `pytest` full 2162 passed, 10 skipped (includes 96 download/drafting/gate tests re-run first, then 2 new). `ruff` clean on touched files (repository has 288 pre-existing findings elsewhere).
- Web: lint, typecheck, build, vitest 1000 passed (51 files).
- Extension: `tsc`, vitest 831 passed + 10 skipped (56 files; 21 new in `draft_assistant.test.ts`), build OK.
- Not run: `docker compose config` (needs the missing `.env`), Alembic up/down (no migration; the existing head-pinning test passes), Playwright e2e, any staging or real-provider call.

## Rollout
1. Web: build and deploy the web image from this branch to **staging**, then production, with a web-only recreate. The API image needs no change for downloads.
2. API (optional, for the new limits/logging): redeploy image from this branch to staging first.
3. Extension: new build for staging testing only; no store submission in this stage.
4. Drafting stays off. To trial on staging: set `APPLICATION_ANSWER_DRAFTING_ENABLED=true` and a staging-only `OPENAI_API_KEY` in the staging API environment and restart only that container. Never copy the production key.

## Rollback
Web: redeploy the previous web image tag. API: redeploy the previous image (`1516f23`); no schema change to undo. Drafting: unset the flag and restart the API. Extension: reinstall the previous build.

## Remaining risks
- The daily limit is per process, not shared across workers or restarts.
- Drafting spend is bounded by 12/min and 150/day per user, but there is no global budget cap.
- Real-provider behavior (model name `gpt-5.6-sol`, JSON mode, latency) is unverified here.
- The extension only offers drafting for textareas in the top frame.
- Pre-0036 applications without session evidence will correctly show no documents; there is no backfill.
