# XpertApply Application Memory — Stage 2B

## Scope and architecture

Stage 2B creates an immutable `ApplicationSnapshot` only from the authenticated
application-session confirmation flow. The client cannot name a user, job,
Tracker, or document ID. Those identifiers are derived from the server-owned
`ApplicationSession`; the existing `mark_application_applied` function remains
the only Applied transition.

Confirmation, Tracker transition, document freezing, snapshot insertion,
session completion, and confirmation-state clearing share one database
transaction. A repeated `source_session_id` returns the same snapshot. Distinct
sessions lock their shared Tracker row before allocating `max(attempt_number) +
1`; database uniqueness constraints remain the final guard.

## Artifact provenance and truthfulness

`ApplicationSession.tailored_resume_id` and `tailored_cover_letter_id` are the
only document-ID sources. Ownership, job association, and document type are
validated before use. Resume availability is recorded as
`selected_for_session`; `resume_used=true` requires a prior session-scoped,
server-persisted successful artifact-use/autofill record and cannot be asserted
by the confirmation body alone. Cover letters have three modes: `file`,
`pasted_text`, and `unused`. An available cover letter defaults to `unused` and
is never represented as submitted merely because it was generated.

Pasted text is newline-normalized, trimmed, and limited to 40,000 characters.
Its prior use record contains only the canonical content hash; confirmation
text must match that hash before the dedicated historical text field is stored.
Job descriptions are taken from the session snapshot when available, otherwise
the normalized job record, and limited to 100,000 characters. Answer snapshots
remain empty until exact submitted-answer evidence is durable; profile, vault,
credential, and unrelated answer data are never copied speculatively.

## Immutability, hashing, and exports

First proven use sets `GeneratedDocument.immutable_at` and a SHA-256 digest. The
hash input is canonical UTF-8 JSON with sorted keys, compact separators, a
version marker, normalized line endings, document type, format version,
structured content, Markdown, and plain text. It excludes row IDs, paths,
timestamps, and generated PDF/DOCX bytes.

Editing an unfrozen document preserves existing update-in-place behavior.
Editing a frozen document creates a new row whose `source_document_id` points
to the historical version; derived export paths and hashes start empty. Existing
exports are already stored as `generated/document-{document_id}.{format}`, so a
new version cannot overwrite a frozen version. Exports may be regenerated later
from frozen canonical content without mutating that content. Snapshot document
foreign keys use `RESTRICT`, preventing historical references from dangling.

## API and authorization

The additive read-only surfaces are:

- `GET /jobs/tracker/{tracker_id}/snapshots?limit=1..100`
- `GET /jobs/tracker/{tracker_id}/snapshots/{snapshot_id}`

Both require the owning user; detail validates the parent/child association.
Foreign resources return the same 404 behavior as missing resources. Responses
exclude storage paths, launch/session tokens, browser identifiers, credentials,
and raw evidence payloads. There is no public snapshot create, update, or delete
route. Existing owner-checked document downloads retrieve exact historical
document IDs.

The eventual B-01 matrix must cover `tracker_id`, `snapshot_id`,
`resume_document_id`, `cover_letter_document_id`, and `source_session_id`.

## Compatibility and deferred provenance

Old confirmation payloads remain valid. Their new fields default to
`resume_used=false` and `cover_letter_mode=unused`; snapshots contain only
server-proven job/session context and selected-resume provenance. Exact
extension upload auditing and exact submitted-answer capture remain deferred to
Stages 2D/2F. No automatic submission inference is introduced.

## Migration, rollout, and rollback

Migration `0033_snapshot_provenance` adds nullable lazy-computed hash/freeze and
copy-source columns to `generated_documents`, plus truthful usage-mode columns
to `application_snapshots`. Existing documents remain unfrozen and are not
backfilled. Rollout requires upgrading from `0032_application_memory`; rollback
drops only these additive columns and the self-referential source foreign key.
PostgreSQL upgrade, downgrade, re-upgrade, and concurrent allocation tests are
required before checkpointing.

## Validation status

- Stage 2B domain and HTTP coverage: implemented.
- PostgreSQL migration and concurrent attempt allocation: implemented.
- Stage 2A lifecycle regression: retained.
- Full Python 3.12 API suite: required before checkpoint review.
