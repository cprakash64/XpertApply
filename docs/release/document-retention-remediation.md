# Materialized document retention remediation

Status: locally qualified release checkpoint, 2026-09-18. This is an
internal operator note, not the public privacy policy.

## Defect and lifecycle

A generated document is a database row in `generated_documents`. A requested
PDF, DOCX, Markdown, or JSON export writes a deterministic
`document-{document_id}.{format}` entry directly beneath the generated root,
derived from `UPLOAD_DIR` (normally `/app/generated` in the API container).
The Compose `generated_files` volume persists those entries.

Before this fix, `DELETE /privacy/account` deleted the user database graph
without removing exports. Editing a mutable generated document cleared
`file_path`, `pdf_file_path`, and `docx_file_path` without removing files.
Changing the generic export format could replace `file_path` while leaving the
old format's file behind. Repeated export of the *same* format overwrote its
deterministic filename, rather than creating a new filename.

Lifecycle graph:

`generated_documents row -> authorized export/download -> deterministic file
-> edit / re-export / account deletion -> file cleanup -> DB reference change`

Uploaded resume import uses a separate, spooled temporary upload. The import
route closes that form after parsing; it does not materialize the uploaded
source in the generated-document directory. Job-logo caching and maintenance
artifacts are outside the owned document filename namespace.

## Ownership and corrected lifecycle

The cleanup service accepts only an immediate child of the configured
generated root whose name exactly matches the owning document ID and a
supported format. It rejects traversal, a sibling prefix, an outside absolute
path, non-file entries, and a symlinked root. An entry that is itself a symlink
is unlinked without following its target. Live references in all three path
columns are checked across document rows before deletion; another document's
reference blocks cleanup. Missing entries are idempotent.

Account deletion gathers the caller's documents while their rows still exist.
It removes each document's deterministic formats, including older exports
whose path fields were previously cleared, before deleting the user row. A
filesystem failure returns a generic 503 and leaves the database association
intact. The filesystem and database do not share a transaction: if a later DB
commit fails, the document row remains but its export can be regenerated.
That order avoids a successful deletion response with a known file left behind.

Editing a mutable document removes its obsolete exports before clearing path
fields. Editing an immutable document creates a new version; the original
document and its exports remain associated with the account. Re-exporting the
same format atomically replaces one deterministic entry. Re-exporting another
generic format removes the old generic export unless a format-specific path
still references it. The writer renders to a temporary entry in the same root
and atomically replaces the final path, so an existing symlink is not followed.

## Historical orphans

Run `python -m app.maintenance.reconcile_generated_documents` only in a
separately authorized maintenance stage. It is dry-run by default. `--apply`
is required for deletion; `--max-files` bounds one pass. It examines only
immediate children of the generated root, classifies referenced files,
controlled-name orphan candidates, and unsafe/unknown entries, and reports
counts plus reclaimable/deleted bytes. It never prints filenames or content.
Apply mode rechecks DB references and entry type immediately before unlink.
Partial deletion failures are counted and produce a nonzero exit. A subsequent
run is idempotent. Directories, symlinks, and unrelated maintenance artifacts
are never deleted by this tool. An unreferenced file with a still-live document
row is ambiguous because the download route can materialize an export without
recording its path; it is counted as unsafe/unknown and left in place. The tool
only applies deletion to controlled filenames whose document row is absent.

**Historical production cleanup has NOT been performed.** This code fix does
not prove production historical orphans are gone. Deploying the fix and
reviewing a dry-run report are separate authorized operations. Only then
should an operator consider a bounded `--apply` run.

## Qualification and impact

Focused tests cover account deletion, document edits and re-exports, missing
files, cross-user references, traversal, symlinks, failure propagation, and
reconciliation. Final local qualification: 20 focused retention tests passed;
the full API suite passed 2,064 tests with 0 failures and 0 skips (1,780
warnings). Ruff passed across `apps/api/app`, and the API Dockerfile built
successfully as a local image. Compose config could not run in this checkout
because its required local `.env` file is absent; no environment file was
created for this stage.

No schema migration, new table, queue, configuration, or volume change is
required. The public privacy-policy rewrite remains a later stage.
