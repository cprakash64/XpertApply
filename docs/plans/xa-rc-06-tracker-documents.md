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
