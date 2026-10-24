# XA-RC-06 B — Tracker document downloads

Status: implemented on `integrate/xa-core1-backend-onto-prod-ceb8314` (the production-integrated line: production `ceb8314` plus the XA-CORE1 backend and web). Not pushed, not deployed, **no database touched**: the migration was exercised only on throwaway in-memory databases.

## What the existing labels were
"Tailored resume" and "Cover letter" in the Tracker were inert chips. They were driven by `_tracker_documents`, which returned the **latest `GeneratedDocument` per (user, job)**. That is not the document prepared for an application: tailoring again changes it, and `PUT /jobs/documents/{id}` edits a document in place. So the labels were not reusable as a download and could name a different document than the one used. `ApplicationSession.tracker_id` is only set when a session completes, so it cannot be relied on either; sessions are tied to an application through (user, job).

## Contract
* **Association** (`app/applications/document_association.py`): (1) the immutable snapshot written when the application first becomes `applied`; (2) for older applications, the documents of the newest session for that user and job created at or before the application date (completed sessions first), reported `frozen: false`; (3) otherwise nothing. There is no "latest for the job" fallback.
* **Snapshot** (`application_document_snapshots`, migration `0036_application_doc_snapshots`, additive, reversible): written once inside `mark_application_applied` (the only path to `applied`), best effort in a savepoint so a copy failure can never cost the confirmation. Holds title, content, plain text, source document id, and `attached_by_extension`. No file path.
* **Download**: `GET /jobs/tracker/{tracker_id}/documents/{resume|cover-letter}?fmt=pdf|docx`. Authenticated; scoped by the application's owner. Someone else's application, an unknown id, an invalid kind and a missing document all answer 404 with the same body shape, so ids cannot be probed. The file is rendered from the stored copy in memory (nothing cached on disk), sent as an attachment with `Cache-Control: private, no-store` and `nosniff`. A stored copy that cannot be rendered answers 409 "This saved document can't be opened"; it is never regenerated. Filename `Company_Resume_YYYY-MM-DD.pdf`, built only from sanitized parts.
* **Tracker payload**: `documents.{resume,cover_letter}` is `null` ("Not available") or `{id, title, created_at, prepared_for_application, attached_by_extension, frozen, formats, download_path}`. No storage path or file URL. One set of queries for the whole list.
* **Prepared is not uploaded**: `prepared_for_application` is always true for a present document. `attached_by_extension` is true only if the extension's `autofill_summary` reported that kind in `documents_uploaded`. The UI says "Prepared for this application", plus either "XpertApply reported attaching it on the employer's form (not confirmed by the employer)" or "Not confirmed as uploaded to the employer". Marking Applied implies neither.

## UI (`TrackerClient.tsx`, `lib/api.ts`)
"Download resume" / "Download cover letter" (PDF) plus a "Word" button, a per-document loading state ("Preparing…", others disabled), readable per-status errors (404, 409, 401, network/5xx) that never show server detail, "Not available" for a missing document, 40px+ tap targets, stacked on phones. The file is saved from an authenticated fetch as a Blob; no URL with a token exists.

## Users can download
For each tracked application: the tailored resume and the tailored cover letter that were prepared for it, as PDF or DOCX, as they were when it was marked Applied (older records: the saved copies of their preparing session, labelled as the current saved copy).

## Limits
* Applications confirmed before this change have no snapshot until a deploy-time backfill is run (none is written here); they use the session fallback and are not immutable against later edits.
* A user who edits a document **before** applying gets the edited version (that is what was prepared).
* User-uploaded original resume files are not part of this.

## Rollout
Backend first (migration `0036`, additive), then web. **Staging deployment requires** running `alembic upgrade head` on the staging database; the old web ignores the new fields, so order matters only in that direction. Nothing was run against staging or production.

## Rollback
`alembic downgrade 0035_extension_auth` drops only the snapshot table. The route and payload fields are additive; the web falls back to "Not available" if the fields are absent.

## R1 release verification (XA-RC-06-B-R1)

Verified on a disposable PostgreSQL 16.13 (never staging or production): the migration up/down/up on a populated 0035 schema, constraints, indexes and delete rules from the PostgreSQL catalog, the whole download suite re-run on an Alembic-built schema, concurrent Applied transitions, a real savepoint failure, account deletion, and the browser flow against the real API.

Defects found and fixed here:
* **Duplicate-insert race (pre-existing, production code).** Eight simultaneous confirmations on PostgreSQL made the losing side of `_insert_or_reload` raise `InvalidRequestError` ("Instance is not present in this Session") and answer 500. SQLite cannot race, so the suite never saw it. The handler is now idempotent.
* **Association by guess.** The first version fell back to the newest session for the job. Association now needs evidence (the confirming session, the completed session linked to the application, or the only prepared session); several candidates and no evidence means no association and `documents_availability: "unknown_association"`.
* **Misleading wording.** Downloads are the saved content re-rendered, not the file once attached: two renders of identical content differ in bytes (PDF carries a creation time; DOCX bytes are not guaranteed). The UI and API now say "Saved document prepared for this application" and "Re-created from the saved text, so the file can differ from the one you attached".
* **Snapshot failure handling.** Failures are logged, counted and audited (`document_snapshot_failed`), never raise into the confirmation, and "frozen" is derived from the snapshot rows themselves. (A first draft of the handler called an unregistered metric and would have failed the confirmation; caught by a test before commit.)
* **CORS.** The API did not expose `Content-Disposition`, so a browser on another origin saved "Resume.pdf" instead of the server's filename. Found only by the live-API browser run; the mocked spec had masked it.
* **Privacy export** now includes the user's snapshots.

`0036_application_doc_snapshots` was edited in place to add `association_basis`: it has never been applied outside disposable databases (staging is at 0035).

Document states a user can tell apart: `frozen` (immutable copy), `historical` (older record, saved copy as it is now), `unknown_association`, `none`.

## R2: provenance and linkage (XA-RC-06-B-R2)

### Staging report: "Resume / Cover letter: Not available"
Reconstructed from the code and reproduced on PostgreSQL 16 over real HTTP (a real `uvicorn`, no OpenAI key, synthetic users):

| Question | Finding | Class |
| --- | --- | --- |
| Does "AI disabled" explain it? | No. `generate_resume` / `generate_cover_letter` fall back to a deterministic template when there is no key, so both a website-launched session and a direct-entry draft end up with a prepared resume and cover letter (scenarios A, B). | Hypothesis rejected |
| Does autofill imply a document was prepared or attached? | No. Filling employer fields records nothing about documents; only `documents_uploaded` on an extension `autofill-results` report marks a file as attached (scenario R). | Expected behaviour |
| Direct-entry drafts | Documents are prepared by a background task after the response, once per draft, and a failure is recorded and not retried. A draft whose preparation failed has none. | Expected missing-data behaviour |
| Is the Applied transition archived? | Yes: `complete_session`, `submission-confirmed`, the Tracker dropdown and `confirm-applied` all reach `mark_application_applied`, which snapshots (A, B, E, F, P). | Verified |
| A document the user made in the Jobs workspace (no session) | Was unreachable after R1: nothing linked it. Now kept at confirmation when it is the unique document of its type for that exact job (`job_document`); several of them are not guessed (P, Q). | Confirmed defect, fixed |
| Sessions pointing at the same documents (a draft reopened after its TTL) | R1 called two sessions ambiguous. They name one set of documents, so they are one answer (E2). | Confirmed defect, fixed |
| A session that raised the confirmation (`tracker_id` set by `confirmation-required`) | R1 ignored it unless completed. It is evidence (E3). | Confirmed defect, fixed |
| The submission date a client claims | R1 used it to exclude sessions "created after" it. A claimed or skewed date must never choose a session (E4). | Latent defect, fixed |
| The actual cause on the user's staging application | **Not determinable from here.** No staging data was accessed. The user's flow matches several of the above; the Tracker now states which one applies (`documents_unavailable_reason`). | Unverified |

### Migration correction
R1 edited `0036_application_doc_snapshots` in place to add `association_basis`, on the stated belief that 0036 had not been applied outside disposable databases. Staging **is** at 0036, so that edit would have left staging without the column (the API would fail to read snapshots). 0036 is restored byte-for-byte to the deployed revision and the column now arrives in `0037_snapshot_association_basis` (additive, reversible; existing rows read `sole_session`).

### Contract changes
* Tracker rows: `documents_availability` (`frozen | historical | unknown_association | none`) and `documents_unavailable_reason` (`no_session | documents_not_prepared | job_documents_not_linked | unknown_association | null`). Document `association`: `confirming_session | linked_session | sole_session | job_document`.
* The UI shows the reason beside "Not available".

### Not changed, and why
* **Original files.** Uploaded resumes are read for profile import and discarded (`/profile/import/file`); XpertApply holds no copy of an original file, so there is nothing authorised to associate. A download is always the saved content re-rendered, and the API and UI say so. Nothing from the employer page or the user's disk is ever captured.
* **Letting the user attach a saved document to an application** is not supported by the product today. Minimal safe design, as a separate follow-up: an explicit "Attach saved document" action on a Tracker row, owner-scoped, offering only that user's own `GeneratedDocument` rows for that job, snapshotting at the moment of the click with basis `user_selected`, never claiming the file was submitted. Not implemented here.
* The extension needed no change: both flows already name the confirming session.

### Staging acceptance procedure (real staging, no data inserted by us, AI settings untouched)
1. Use a dedicated staging test account. Do not use a production-like account.
2. **Website-launched**: Jobs → pick a job → *Apply with XpertApply*. In the dialog the resume and cover letter should read "ready" (template mode is fine). Let the extension fill the employer page, then mark it applied. Tracker → Applied: expect **Saved document prepared for this application**, both downloads, and PDF/Word files that open.
3. **Direct entry**: open an employer application page with the extension connected. Wait for the assistant's document line to settle (a minute at most), submit or confirm "I applied". Expect the same.
4. Edit the resume in the Jobs workspace afterwards: the Tracker download must not change.
5. If a document shows "Not available", the reason beside it names the cause. Report that text. To see the facts behind it, an operator with staging access can run read-only (no PII selected):
   `SELECT t.id, t.status, t.applied_source, (SELECT count(*) FROM application_sessions s WHERE s.user_id=t.user_id AND s.job_id=t.job_id) AS sessions, (SELECT count(*) FROM application_sessions s WHERE s.user_id=t.user_id AND s.job_id=t.job_id AND (s.tailored_resume_id IS NOT NULL OR s.tailored_cover_letter_id IS NOT NULL)) AS sessions_with_docs, (SELECT count(*) FROM generated_documents d WHERE d.user_id=t.user_id AND d.job_id=t.job_id) AS job_docs, (SELECT string_agg(kind||':'||association_basis, ',') FROM application_document_snapshots x WHERE x.tracker_id=t.id) AS snapshots FROM application_tracker t WHERE t.id = <tracker id>;`
   and `SELECT created_at FROM audit_logs WHERE action = 'document_snapshot_failed' AND user_id = <user id>;`
6. If no legitimate document source exists on staging (no profile, or generation disabled in a way that raises), say so; do not seed documents into a live account.

### Rollout
Run `alembic upgrade head` (0037) on staging **before** deploying this API; the new code reads the `association_basis` column. Then the web.
