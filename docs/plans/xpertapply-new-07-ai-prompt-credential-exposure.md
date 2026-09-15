# NEW-07 — Workday credential ciphertext transmitted in AI prompt payloads

**Status** OPEN
**Severity** MEDIUM
**Priority** P1 — release blocker
**Origin** Pre-existing. Present at baseline `04bf8afa3ba4155157835ade69232726cbf2e9b9`.
**Found** Stage 2G-D-R2 (as an observation); confirmed and scoped at the Stage
2G-D final checkpoint, attempt 3.
**Not remediated** in Stage 2G-D. Tracked separately from NEW-06.

---

## 1. Summary

`UserProfile.workday_password_ciphertext` — the encrypted employer-portal
password — is included in the profile dictionary that is serialized whole into
the **user message of every OpenAI chat completion** the document pipeline makes.
The ciphertext and its field name leave the server on four confirmed request
paths. The same value is also persisted into every generated document's
`source_profile_snapshot`.

The plaintext password is **not** exposed and the Fernet key is **not**
transmitted, so this is not an immediate credential compromise. It is an
unnecessary transmission of credential-derived secret material to a third-party
processor, and it contradicts the stated invariant of the module that owns the
field.

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

## 6. Suggested remediation (not performed here)

Not done in Stage 2G-D: it touches a shared helper on the document-generation
path, which is outside an authorization/serialization stage and needs its own
regression pass.

1. Exclude the column at the helper, not at each call site — add
   `workday_password_ciphertext` to the exclusion set in
   `app/services/documents.py:public_dict()`, so every consumer
   (`profile_payload`, prompts, snapshots) is covered at once. Verify no caller
   depends on the field being present.
2. Prefer an **allow-list projection** for prompt payloads over
   `json.dumps(payload)` of an ORM-derived dict. The current shape re-exposes
   every future column added to `UserProfile` automatically; this finding will
   recur otherwise.
3. Backfill: existing `GeneratedDocument.source_profile_snapshot` rows still
   contain the ciphertext. Decide whether to scrub them.
4. Separate the credential encryption key from `secret_key` so the fallback
   cannot couple JWT-secret disclosure to credential decryption.
5. Add a regression test asserting the field never appears in a payload handed
   to `AIProvider.json_task`.

---

## 7. Relationship to Stage 2G-D

Stage 2G-D neither introduced nor widened this. Every file on the dataflow is
byte-identical to the committed baseline:

`app/services/documents.py` · `app/ai/provider.py` ·
`app/documents/cover_letter_generation_service.py` ·
`app/documents/resume_generation_service.py` · `app/documents/store.py` ·
`app/profile/credentials.py` · `app/models/entities.py`

Stage 2G-D's only contact with the field **reduced** exposure: the NEW-06
privacy-export fix serializes `UserProfile`, and excluding the column there
(`EXPORT_EXCLUDED_COLUMNS` in `app/routes/privacy.py`) prevented the repair from
adding a client-facing disclosure path. Discovering NEW-07 is a consequence of
that work, not of a regression in it.
