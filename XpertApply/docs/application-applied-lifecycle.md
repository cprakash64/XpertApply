# The applied lifecycle: how a job moves to the Tracker

The application record (`application_tracker`) is the source of truth for "have I
applied to this?". The Jobs page and the Tracker page are two views of it — not
two copies of the job.

## The rule

A job leaves Jobs and appears in Tracker **only** after a submission is
confirmed, by exactly one of:

1. the extension observing a deterministic ATS success signal,
2. an internal auto-apply run reporting a confirmed submission,
3. the user explicitly answering "yes, I submitted this".

Clicking **Apply on official site** is *not* one of them.

## Status vocabulary

`ApplicationStatus` (`apps/api/app/models/entities.py`) is the only application
status vocabulary. `ApplicationSessionStatus` describes a single assisted-apply
*run*, not the application.

| Conceptual state | Repository status | In discovery? |
| --- | --- | --- |
| not started | *(no record)* | yes |
| saved | `saved` | yes — still an open opportunity |
| prepared | `ready_to_apply` | yes — nothing was submitted |
| started / in progress | `applying` | no — it has the Tracker + side panel already |
| applied | `applied` | no |
| interviewing | `interview` | no |
| offer | `offer` | no |
| rejected | `rejected` | no |
| withdrawn | `withdrawn` *(added in `0027`)* | no |
| failed | *(not an application status)* | yes — see below |

**Failure is not an application status.** A failed apply run is recorded on
`ApplicationSession.status = failed`; the application record is untouched, so the
job stays in discovery and remains retryable. This is deliberate: a failed
attempt is not an application.

`applying` is hidden from discovery on top of the submitted set. That is
pre-existing product behaviour (a mid-flight run already has its own surface) and
is preserved. It is never treated as submitted: an `applying` record has no
`applied_at` and never appears under Tracker → Applied.

## The one transition

`app/applications/mark_applied.py::mark_application_applied` is the only code
that may set `status = applied`. Everything else delegates to it, including
`complete_session` and the Tracker's own status dropdown.

* **Identity / idempotency key:** `user_id + canonical job_id`, enforced by the
  database via `uq_tracker_user_job`. Never a third-party URL.
* **Concurrency:** two confirmations that both miss on `SELECT` both `INSERT`;
  the constraint picks a winner and the loser re-reads and updates that row. The
  `INSERT` runs in a `SAVEPOINT` so a lost race never discards the caller's other
  work.
* **`applied_at`** records the *first* confirmed submission and is not moved by a
  later duplicate — it is the date the user shows an employer. It is refreshed
  only when the record was not previously in a submitted state (a genuine
  re-application after `withdrawn`).
* **Provenance** (`applied_source`) is written by the first confirmation and not
  rewritten by duplicates, so the strongest evidence is what is recorded.
* **Preserved, never written here:** notes, follow-up date, `opened_at`,
  `created_at`, and the tailored resume / cover letter (separate records keyed by
  user + job).
* **Never dragged backwards:** a late duplicate arriving after the user recorded
  an interview leaves them at `interview`.

## Opening is recorded, separately

`record_application_opened` stamps `opened_at` and `last_application_url` and
touches neither `status` nor `applied_at`. `opened_at` exists precisely so
"I opened this" is observable without ever being mistaken for "I applied".

## Endpoints

| Path | Credential | Source |
| --- | --- | --- |
| `POST /jobs/{job_id}/applications/confirm-applied` | user's main token | `user_confirmed` |
| `POST /application-sessions/{session_id}/submission-confirmed` | session-scoped token | `extension_confirmed`, `auto_apply_confirmed` |

Both derive ownership and job identity **server-side**. The browser never
supplies `user_id`, `job_id`, `status`, an owner, a resume id, company, or title;
the extension schema sets `extra="forbid"` so sending them is a 422, not a
silently-ignored field. The extension's job identity *is* the session it holds a
token for.

Repeats return the existing record with `already_applied: true` rather than
failing, so double-clicks, extension retries, two tabs, and an extension
confirmation racing a manual one are all safe.

## What counts as evidence (extension)

`apps/extension/src/ats/submissionEvidence.ts` is the gate. Accepted:

* `success_page` — the ATS navigated to a confirmation URL it only serves
  post-submission;
* `success_response` — a submission request returned an explicit 2xx success;
* `success_message` — a deterministic confirmation phrase **and** the form is
  gone.

Refused, because each fires routinely on applications that were never submitted:
submit-button click; disabled submit button; the form disappearing; a bare URL
change; a timeout after clicking. The server re-validates `evidence_type`
against the same closed set, so a client cannot invent a weaker justification.

When evidence is insufficient the extension emits
`MANUAL_CONFIRMATION_REQUIRED` with a machine reason code and marks nothing —
the user is asked in the web app instead.

The asymmetry is intentional: a false positive silently removes a job the user
still needs to apply to and they never find out; a false negative costs one
click.

## Discovery filtering

`_list_payload` in `apps/api/app/routes/jobs.py` excludes
`DISCOVERY_HIDDEN_STATUSES` for the requesting user with **one** indexed query
(`ix_tracker_user_status`), then does a hash-set lookup per job — no per-row
application query. Because it is server-side, the job cannot return after a
refresh, a re-login, another browser, or provider rediscovery (which updates the
`JobPosting` row, which this filter does not consult). The exclusion is
per-user; the `JobPosting` row is never deleted or deactivated.

## Frontend

Optimistic removal **with rollback**: the card is removed, the Tracker entry is
added, and the selection moves; on failure the previous jobs list, tracker map,
and selection are all restored and the error is shown as retryable. The success
toast is only shown after the backend transaction succeeds.

Next-selection rule: next visible job → previous visible job → no selection
(clear `?job=` and render the intentional empty state). The detail pane is never
left rendering a removed job.

## Observability

Metrics (`app/applications/observability.py`) carry only low-cardinality labels —
source, from/to status, ATS, evidence type, outcome, reason. User id, job title,
company, application URL, email, and document contents are excluded by
construction: `_DIMENSIONS` has no key for them. The audit trail (`AuditLog`,
user-scoped and access-controlled) carries the canonical job id, source,
timestamp, and previous/new status, and never notes or document contents.

## Not implemented

**Undo.** Deliberately out of scope for this change. Reversing an
extension-confirmed record would let the UI contradict a real submission the
employer has already received, and the manual-only variant is not worth a second
state-transition path until the product asks for it.
