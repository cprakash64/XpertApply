# NEW-07 — Workday credential ciphertext transmitted in AI prompt payloads

**Code remediation** COMPLETE — see §8.
**Production data remediation** PENDING AUTHORIZATION — see §9.
**Severity** MEDIUM
**Priority** P1
**Release blocker** YES, until historical production rows are inspected and sanitized.
**Origin** Pre-existing. Present at baseline `04bf8afa3ba4155157835ade69232726cbf2e9b9`.
**Found** Stage 2G-D-R2 (as an observation); confirmed and scoped at the Stage
2G-D final checkpoint, attempt 3; remediated on top of
`d003cd9227ff5ab5b5a10b55c6352d90c05bc58c`.

---

## 1. Summary

`UserProfile.workday_password_ciphertext` — the encrypted employer-portal
password — **was** included in the profile dictionary serialized whole into the
user message of every OpenAI chat completion the document pipeline makes. The
ciphertext and its field name left the server on four confirmed request paths,
and the same value was persisted into every generated document's
`source_profile_snapshot`.

The plaintext password was **not** exposed and the Fernet key was **not**
transmitted, so this was not a credential compromise. It was an unnecessary
transmission of credential-derived secret material to a third-party processor,
and it contradicted the stated invariant of the module that owns the field.

Sections 2–5 describe the defect as measured before remediation. Section 6
describes the fix, §7 its validation, and §9 the historical rows that remain.

---

## 2. Dataflow

| step | location |
|---|---|
| source column | `app/models/entities.py:191` — `UserProfile.workday_password_ciphertext` |
| serialization helper | `app/services/documents.py:22` — `public_dict()`, which excludes only `hashed_password` |
| payload builder | `app/services/documents.py:30` — `profile_payload()` returns `{"profile": public_dict(profile), …}` |
| caller (cover letter) | `app/documents/cover_letter_generation_service.py:36` → `:96` `ai_provider.json_task("cover_letter.md", payload, smart=True)` |
| caller (resume) | `app/documents/resume_generation_service.py:45` |
| caller (generic) | `app/services/documents.py:138` — `generate_document()` |
| caller (session) | `app/applications/session_service.py:293` |
| AI client | `app/ai/provider.py:72` — `AIProvider.json_task()` |
| **external call site** | `app/ai/provider.py:120-128` — `self.client.chat.completions.create(model=…, messages=[{"role": "system", …}, {"role": "user", "content": json.dumps(payload, default=str)}])` |

The decisive line is `app/ai/provider.py:126`: the **entire payload** is
`json.dumps`-ed into the user message. No field allow-list, no redaction, no
projection — whatever `profile_payload` contains is transmitted.

Secondary persistence: `app/documents/store.py:41` stores
`source_profile_snapshot=_json_safe(profile_payload(db, user_id))`, so the
ciphertext is also copied into `GeneratedDocument` rows.

---

## 3. Evidence

Measured by intercepting the OpenAI client at its exact call site with a fake
client that records outgoing `messages`. A canary plaintext password was stored
through `PUT /profile/workday-credentials`, then each route was exercised. No
real network call was made; no credential value is reproduced here.

| route | external calls | ciphertext in messages | plaintext in messages | field name in messages |
|---|---|---|---|---|
| `POST /jobs/{job_id}/generate-cover-letter` | 1 | **YES** | no | yes |
| `POST /jobs/{job_id}/documents/cover_letter` | 1 | **YES** | no | yes |
| `POST /jobs/{job_id}/generate-resume` | 1 | **YES** | no | yes |
| `POST /application-sessions` | 3 | **YES** (2 of 3) | no | yes |

Also confirmed: `GeneratedDocument.source_profile_snapshot` contains the
ciphertext for documents produced on these paths.

The reported scope was the cover-letter path alone. The actual scope is wider —
résumé generation and session creation transmit it too, and session creation
does so twice per call.

---

## 4. What is and is not exposed

| question | answer | basis |
|---|---|---|
| ciphertext transmitted externally? | **YES** | intercepted at the call site on four paths |
| plaintext password transmitted? | **NO** | canary plaintext absent from every captured message |
| encryption key transmitted? | **NO** | key is derived in-process from `settings.workday_credentials_encryption_key or settings.secret_key` (`app/profile/credentials.py:18`); it is never part of any payload |
| ciphertext reversible by the recipient? | **NO** — not without the server key | Fernet (AES-CBC + HMAC) over a SHA-256 digest of server-side key material |
| reachable through any client-facing API response? | **NO** | `serialize_document` omits `source_profile_snapshot`; the privacy export excludes the column explicitly (NEW-06 work) |

---

## 5. Why it is still a release blocker

1. **It contradicts its own module contract.** `app/profile/credentials.py`
   states: *"Plaintext is accepted only by the dedicated write endpoint … It is
   never placed in profile JSON, logs, application snapshots, or reusable
   answer-vault rows."* The ciphertext is in profile JSON and in application
   snapshots. The invariant as written covers plaintext; the clear intent covers
   the credential.
2. **Third-party processing of credential material.** Prompt payloads reach an
   external provider and may be retained, logged, or used per that provider's
   terms. A credential-derived secret has no business in a résumé prompt.
3. **Key-separation weakness raises the consequence of any key disclosure.** The
   Fernet key falls back to `settings.secret_key`, the same secret used to sign
   JWTs. If that one secret leaks, previously exported prompt payloads become
   decryptable. The ciphertext being out of the trust boundary is what turns a
   single-secret disclosure into a credential disclosure.
4. **Zero functional need.** No prompt template consumes the field; it is
   transmitted purely because `public_dict` copies every column.

Severity stays **MEDIUM** rather than HIGH precisely because the plaintext and
the key stay server-side. If either were transmitted this would be HIGH/P0.

---

## 6. Remediation as built

### 6.1 Where the boundary went, and why there

Every one of the five production callers of `profile_payload` is an AI prompt or
a persisted snapshot — the résumé and cover-letter services, `generate_document`,
`session_service`, and `store.persist_document`. **None is a user-facing API
response.** That made `profile_payload` the single authoritative choke point:
narrowing the profile section there covers all five at once, and cannot narrow
any user-facing payload.

`public_dict` was deliberately **not** changed globally. Its other callers
serialize `JobPosting` (shared catalogue data, no credential columns) and the
career models, and the privacy export already filters through its own
`_export_dict`. Changing the shared helper would have altered those contracts
for no security gain.

### 6.2 Allow-list, not deny-list

`app/services/profile_projection.py` is new and holds the boundary:

* `AI_PROFILE_FIELDS` — an explicit allow-list of the 37 `UserProfile` columns
  that may reach a prompt or a snapshot. Each was verified against actual
  consumption (`profile.get(...)` call sites and prompt templates), not assumed.
* `AI_PROFILE_EXCLUDED_FIELDS` — the withheld columns, each with its reason.
  Currently one entry: `workday_password_ciphertext`.
* `safe_profile_dict(profile)` — the projection `profile_payload` now uses.

The direction of the filter is the actual fix. A deny-list over a generic
serializer is fail-OPEN: every future column is exposed by default, which is
precisely how this incident occurred. An allow-list is fail-CLOSED.

### 6.3 Fail-closed for future columns

`test_a_new_profile_column_is_fail_closed` compares the live `UserProfile`
columns against `AI_PROFILE_FIELDS | AI_PROFILE_EXCLUDED_FIELDS` and fails if
any column is in neither. Adding a column to the model therefore breaks the
build until someone classifies it — the decision is forced rather than
defaulted. This is the closure requirement that stops NEW-07 from recurring
under a different column name.

### 6.4 Defense in depth at the provider boundary

`AIProvider.json_task` now scrubs credential-shaped keys recursively before
model selection and before `_call`, so the guard covers any future provider, not
just the current OpenAI client. It is explicitly **secondary** — the allow-list
is the control — and exists to catch credential material arriving from some
other model or helper. Matching is on **exact** key names
(`CREDENTIAL_KEY_NAMES`), never substrings: substring matching would destroy
legitimate user data such as `Certification.credential_url` or
`JobMatch.job_content_hash`. A strip is logged as a count only; values are never
inspected or logged.

### 6.5 Snapshot writes and the copy path

New `GeneratedDocument.source_profile_snapshot` writes inherit the safe
projection through `profile_payload`. Separately, `copy_document_for_edit` now
scrubs the snapshot as it copies: rows written before this fix still hold the
ciphertext, and editing such a document would otherwise mint a brand-new row
carrying it — re-creating the exposure faster than a one-time cleanup could
retire it. No new write can inherit the credential regardless of what the source
row contains.

`application_sessions.profile_snapshot` was **never affected**:
`session_service._profile_snapshot` has always hand-built an explicit field list.
A test pins that so it stays true.

### 6.6 What was deliberately not changed

* The credential's authoritative store. `UserProfile.workday_password_ciphertext`
  still holds it and `app/profile/credentials.py` still encrypts and decrypts it
  for the Workday flow that needs it. Data minimization removes the credential
  from payloads that never needed it, not from the column that owns it.
* The `secret_key` fallback for the encryption key (§10.2). Separating them is a
  key-management change with rotation implications, outside this stage.

---

## 7. Validation

`apps/api/app/tests/test_new07_credential_minimization.py` — **26 cases, all
passing**:

| group | what it holds |
|---|---|
| projection | allow-list names are real columns; credential excluded; a non-allow-listed attribute is not picked up implicitly |
| **fail-closed** | every `UserProfile` column must be classified, or the suite fails |
| scrub | nested dict/list removal; exact-name matching does **not** strike `credential_url` / `job_content_hash`; path reporting never returns values |
| provider boundary | `generate-resume`, `generate-cover-letter`, `documents/cover_letter`, and **every** call made by `POST /application-sessions` |
| guard | credential keys injected downstream of the projection are stripped before the provider call, while legitimate content still travels |
| snapshots | new document snapshots clean **and still useful**; session snapshot clean; editing a legacy unsafe document yields a clean copy |
| non-regression | Workday store/decrypt/delete still work; `/profile` still returns its fields; privacy export still excludes the credential |
| cleanup | dry-run, apply, idempotency, batching, `--max-rows` bound, **bounded-run resumption and convergence**, malformed-row skip |

Canaries are distinct for the ciphertext, the plaintext, and the encryption key,
so a failure names which class of material escaped. Interception is at the
OpenAI client itself — after prompt assembly and after `json.dumps` — so a
renamed or re-nested key cannot pass by changing shape. Key **names** are
asserted absent alongside the values, giving complementary coverage.

Pre-fix, the same harness measured the ciphertext in 6 of 6 relevant provider
calls and in the document snapshot. Post-fix: 0 of 6, and snapshots clean.

Wider suites: B-01 **45/45** with coverage still **51/51, missing 0** · NEW-06
**13/13** · JWT/auth **44/44** · document/session/profile/privacy/people/jobs/
tracker/snapshot/application/retention/vault families **1326/1326** ·
PostgreSQL `-m migration` **9/9** · Ruff `ruff check app` and the script PASS.
Full API ×2 counts are recorded in the checkpoint report.

### 7.1 Same-class audit

NEW-07 arose from generic ORM serialization of a credential-bearing model, so
every comparable pattern was checked rather than assumed clean:

| finding | verdict |
|---|---|
| `session_refresh._profile_columns` serializes all `UserProfile` columns | **Not a leak.** Its only consumer, `compute_profile_revision`, reads its own named allow-list and emits a truncated SHA-256. |
| `professional_people.professional_email_ciphertext` | **Not a leak.** Every use is an explicit `decrypt_email`/`encrypt_email` at a named site; absent from all prompt and provider modules. |
| `users.hashed_password` | Already excluded by `public_dict`, and the privacy export builds `user` by hand. |
| `application_sessions.launch_token_hash` | Not serialized into any payload. |
| `app/people/openai_web.py` (second AI sink, `responses.create`) | **Off the NEW-07 path** — no `UserProfile`, `profile_payload`, or `public_dict` reference. |

Provider error logging was checked: `AIProvider` logs a classified reason and
the model name only, never the payload or the key.

---

## 8. Code remediation status

**COMPLETE.**

| # | criterion | status |
|---|---|---|
| 1 | AI profile payloads use an explicit safe projection | yes |
| 2 | new `UserProfile` columns cannot auto-enter AI payloads | yes — enforced by test |
| 3 | `workday_password_ciphertext` absent from all external AI requests | yes |
| 4 | plaintext credential absent | yes |
| 5 | encryption key absent | yes |
| 6 | every confirmed affected flow covered | yes |
| 7 | all `POST /application-sessions` AI calls clean | yes |
| 8 | all new `source_profile_snapshot` writes clean | yes |
| 9 | old unsafe snapshots cannot propagate into new rows | yes — copy path scrubs |
| 10 | privacy export remains clean | yes |
| 11 | Workday credential functionality intact | yes |
| 12 | historical rows discoverable without revealing values | yes — paths only |
| 13 | tested dry-run cleanup | yes |
| 14 | tested explicit apply cleanup | yes |
| 15 | cleanup idempotent | yes |
| 16 | cleanup bounded and batched | yes — OFFSET→keyset defect found and fixed at checkpoint |
| 17 | production cleanup **not** executed | correct — not authorized |
| 18 | provider-side residual documented | yes — §10.1 |

---

## 9. Historical data and the cleanup mechanism

### 9.1 Affected storage

One column retains the credential from before the fix:

| table.column | why |
|---|---|
| `generated_documents.source_profile_snapshot` | received the unfiltered `profile_payload` on every generation |

Every JSON snapshot column in the schema was enumerated and checked.
`application_sessions.profile_snapshot`, `generated_documents.job_snapshot`,
`application_sessions.job_snapshot`, `application_snapshots.answers_snapshot`
and `professional_person_sources.redacted_payload` are **not** affected —
session profile snapshots have always been a hand-written field list, and the
rest never carried the profile row.

### 9.2 The tool

`scripts/sanitize_profile_snapshots.py`, following the repository's existing
`scripts/` convention (`check_env.py`, `seed_demo_data.py`) with `main() -> int`.

**Why not Alembic.** This edits JSON data, not schema. An Alembic data migration
would execute destructive row rewrites automatically during ordinary
`make migrate` deploys — no dry-run, no batch bound, and no chance to review
candidate counts first. A deliberately invoked script keeps the operator in the
loop, which is the appropriate shape for a one-time credential scrub.

| property | behaviour |
|---|---|
| default mode | **dry-run** — `--apply` is required to modify anything |
| output | counts and key **paths** only; values are never read into output, so running it cannot print a credential |
| batching | `--batch-size` (default 200) rows per transaction |
| bound | `--max-rows` caps one invocation; pair with `--start-after-id` (the reported `last id scanned`) to resume |
| paging | keyset on the primary key, **not** OFFSET — see below |
| transactions | per batch; a failure rolls back that batch only and is counted |
| idempotency | sanitized rows stop matching — a second run reports 0 candidates |
| malformed rows | counted as `skipped`, left byte-for-byte; **never blanked** |
| re-runnable | yes, safe to stop and repeat |

**Defect found and fixed at the NEW-07 checkpoint.** The scan originally paged
with `OFFSET`, always starting at 0. A bounded run therefore re-examined the
same already-clean prefix on every invocation, reported "0 candidates", and
never reached the rest of the table — an operator chaining bounded runs would
have seen a clean result while credential material remained. Verified: 10 unsafe
rows, `--max-rows 3`, six repeated runs → 3 sanitized and **7 left untouched
while every run after the first reported zero**. Paging is now keyset on the
primary key with `last id scanned` as the resume token, and the cursor advances
past every row examined — sanitized, skipped or untouched — so a malformed row
can neither stall the walk nor be re-selected. Re-verified: the same 13-row
fixture converges to 0 unsafe across chained bounded runs, with 3 malformed rows
preserved. Two regression tests pin both the convergence and the
no-resume-is-not-progress contract.

Verified on disposable SQLite databases: dry run reported 6 candidates
(including a **nested** `api_key`, proving recursion) and changed nothing; apply
sanitized 6 and removed 12 keys; a second apply reported 0; safe content
survived (all 9 names, 9 skills, 6 experience blocks, and the unrelated nested
`city` value) and row ownership was unchanged; malformed snapshots stayed
byte-for-byte `["not","an","object"]`. An empty database and an already-clean
database both no-op with exit 0.

**Failure safety verified by simulation**: with the second of four batches forced
to fail, the run reported 6 sanitized and 1 failed batch, the failed batch's two
rows were rolled back rather than partially written (`sanitized + still_unsafe
== total`), the walk continued past the failure, and a plain re-run finished the
remaining two rows.

**Output secrecy verified from actual stdout**: zero occurrences of either
canary, of `full_name`, or of any snapshot value across dry-run and apply. The
report emits counts and key *paths* only.

### 9.3 Production status

**Production was not connected to, counted, or modified.** No production
database access, no beta-user cleanup, no deployment. Read-only production
candidate inspection requires its own written authorization, and historical
cleanup a further one.

---

## 10. Residual risk

### 10.1 Provider-side history

Requests already sent may exist in the provider's own request records under
whatever retention policy applied at the time. **This has not been verified and
is not claimed to be deleted.** No statement is made about retention duration.
What the evidence does establish is the *content* of that residual: encrypted
ciphertext and its field name — no plaintext password and no encryption key.

### 10.2 Credential rotation assessment

**Workday password rotation: not required on this evidence.** Only Fernet
ciphertext left the trust boundary. Fernet is AES-128-CBC with HMAC over a
SHA-256 digest of server-side key material that was never transmitted, so the
ciphertext is not reversible by a holder of the request logs alone.

**Encryption-key rotation: not required.**

An earlier draft of this document overstated the risk here, and the correction
matters. `app/profile/credentials.py` derives the Fernet key from
`workday_credentials_encryption_key` and falls back to `secret_key`, which
looked like a key-domain coupling: one secret disclosure would then decrypt the
residual ciphertext. **Production cannot reach that fallback.**
`config_validation._check_workday_credentials_key` emits a finding when the key
is absent, `collect_findings` includes it, and `enforce()` — called from
`main.py` at startup — raises `ConfigurationError` and aborts the process
whenever `app_env` names a production environment.

Verified directly: with `app_env="production"` and no dedicated key, `enforce()`
raises and names `WORKDAY_CREDENTIALS_ENCRYPTION_KEY`; with the key present
there is no finding; under `app_env="development"` it does not raise. The
fallback is therefore a development convenience only, and in production the
Workday Fernet key is necessarily distinct from the JWT signing secret.

Consequently a `secret_key` disclosure alone does **not** make the residual
provider-side ciphertext decryptable, and no key rotation is indicated by this
evidence. Tracked as **NEW-08 — credential encryption key domain separation:
NOT APPLICABLE**, on the basis above, rather than left as an open risk.

Had plaintext or key material been transmitted, the conclusion would have been
immediate forced rotation. It was not, and the measurement is recorded in §3.

### 10.3 Remaining release-blocker status

Code remediation is complete, so no *new* exposure can occur. NEW-07 should
remain release-blocking until historical production rows are inspected and
sanitized, because until then stored credential ciphertext still sits in
`generated_documents.source_profile_snapshot` — reachable by anything with
database access, and copied into backups.

---

## 11. Relationship to Stage 2G-D

Stage 2G-D neither introduced nor widened this. At the Stage 2G-D checkpoint,
every file on the dataflow was byte-identical to the committed baseline
`04bf8afa…` — `app/services/documents.py`, `app/ai/provider.py`,
`app/documents/cover_letter_generation_service.py`,
`app/documents/resume_generation_service.py`, `app/documents/store.py`,
`app/profile/credentials.py`, `app/models/entities.py` — which is what
established NEW-07 as pre-existing. Three of those files are modified by *this*
stage, which is the remediation described in §6.

Stage 2G-D's only contact with the field **reduced** exposure: the NEW-06
privacy-export fix serializes `UserProfile`, and excluding the column there
(`EXPORT_EXCLUDED_COLUMNS` in `app/routes/privacy.py`) prevented that repair
from adding a client-facing disclosure path. Discovering NEW-07 was a
consequence of that work, not a regression in it.
