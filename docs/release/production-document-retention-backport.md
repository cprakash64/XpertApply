# Production document-retention backport

Status: locally qualified, 2026-09-18. This is an internal
release note, not a public privacy policy.

## Provenance and compatibility

Production base: `ac2764181161ee3b439bd654424fac255a304c7b`.
Qualified source fix: `7e525894c03ed4c10897b5fccf47e0dc4c1ba9b5`.
The base includes the deployed confirmation contract and NEW-06/NEW-07 API
behavior. No Store branch code or schema was merged into this backport.

The production model has `file_path`, `docx_file_path`, and `pdf_file_path`,
the same deterministic export names, and the same generated storage root.
It does not have the Store branch's `immutable_at` or `content_hash` fields or
the `copy_document_for_edit` service. Production edits mutate a document row
in place, so the adapted route removes exports and clears all three path
fields on every edit. The source fix's immutable-version branch is omitted
because that lifecycle does not exist on the production model.

| Source fix behavior | Production backport location | Treatment | Reason |
| --- | --- | --- | --- |
| Root confinement, traversal and symlink safety | `app/documents/materialized_files.py` | Identical | Root, names, formats, and path columns match. |
| Cross-document reference protection | `app/documents/materialized_files.py` | Identical | All three live path columns are scanned. |
| Account deletion cleanup and failure response | `app/routes/privacy.py` | Identical | Production cascade and authorization flow match. |
| Edit invalidation cleanup | `app/routes/jobs.py` | Adapted | Production edits the same row; no immutable version or content hash exists. |
| Re-export cleanup | `app/routes/jobs.py` | Identical | Generic and format-specific path behavior match. |
| Atomic same-format replacement | `app/documents/store.py` | Identical | Renderer and deterministic filenames match. |
| Dry-run and bounded historical inventory | `app/maintenance/reconcile_generated_documents.py` | Identical | Same root and database model fields. |
| Apply revalidation and aggregate accounting | `app/maintenance/reconcile_generated_documents.py` | Identical | Same ownership rules; live-row ambiguity remains protected. |
| I/O failure propagation | helper and routes above | Identical | A failed unlink cannot report successful deletion or edit. |

## Lifecycle and ownership

Generated resume and cover-letter exports live under the configured generated
root (normally `/app/generated`) as `document-{id}.{format}`. The mounted
`generated_files` volume persists them. The helper removes only controlled
immediate entries belonging to the document, checks all live references, and
does not follow a symlink entry. Missing files are harmless; invalid paths or
I/O failures stop cleanup. Uploaded resume sources use a separate temporary
upload lifecycle.

Account deletion gathers the user's document rows before the database cascade
and removes controlled exports first. A cleanup failure yields a generic 503
and retains the database association. The filesystem and database cannot
share a transaction: if a later database commit fails, the retained row can
regenerate its missing export. Production edit cleanup uses that same order,
then clears path fields. Re-export removes an obsolete generic file before
replacing its reference; same-format rendering uses an atomic replacement.

The historical reconciliation tool is dry-run by default. `--apply` is
required to delete; `--max-files` bounds one pass. It reports aggregate counts
and bytes only, rechecks references and file type immediately before unlink,
and leaves referenced, live-row ambiguous, symlink, directory, and unrelated
entries untouched. Partial failures return nonzero.

## Release sequence and impact

No database migration, new table, durable queue, environment/configuration
change, or volume change is required. Historical production cleanup has
**not** been performed; this local code does not prove historical orphans are
gone. A later, separately authorized sequence is:

1. Push the qualified hotfix branch.
2. Perform production preflight and a fresh backup.
3. Deploy the exact backport.
4. Run a production orphan inventory in dry-run mode only.
5. Review the inventory with a human operator.
6. Obtain separate authorization for bounded cleanup.
7. Verify zero residual controlled orphan candidates.

Public retention claims must wait for production evidence. No production
access, deployment, inventory, or cleanup is part of this local backport.

## Local qualification

The 20 focused retention tests passed. Targeted production regressions for
confirmation, application-session lifetime, document contracts, NEW-06,
NEW-07, JWT, and authentication reported 134 passed, 0 failed, and 10 skipped
(the skipped tests require a local PostgreSQL test instance). The full
repository-standard API suite reported 1,876 passed, 0 failed, 0 skipped,
and 1,165 warnings. Ruff passed across `apps/api/app`. The API Dockerfile
built successfully as a local image from this exact worktree. `docker compose
config` could not complete because this checkout lacks its required `.env`;
none was fabricated.
