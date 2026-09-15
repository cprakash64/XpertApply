# Stage 2G-D — B-01 Two-User Authorization Matrix (IDOR / BOLA)

**Branch** `recovery/stage3-security`
**Base HEAD** `04bf8afa3ba4155157835ade69232726cbf2e9b9`
**Status** implemented, validated, not committed
**Targets** B-01
**Revision** Stage 2G-D-R2 — NEW-06 response-serialization fix plus the final
four owner controls. R1 corrected the coverage claim (the Stage 2G-D final
checkpoint measured 27/51 against a claimed 51/51)

---

## 1. Threat model

An authenticated XpertApply user who already holds a valid identifier belonging
to someone else — a session id, tracker id, snapshot id or document id — tries
to use it. Identifiers are sequential integers, so possession is not a secret;
guessing one is trivial. The only thing standing between an attacker and another
person's résumé, cover letter, application history and answers is server-side
ownership enforcement.

B-01 was **partially** remediated: ownership filters existed and a handful of
cross-user assertions were scattered across the suite, but nothing exercised the
private object graph as a matrix. This closes that with a dynamic two-user suite
over the real HTTP boundary.

Stage 2G-D claimed that suite covered all 51 applicable operations. It did not —
an independent replay at the final checkpoint measured 27/51, and the shortfall
was not random: the People family was asserted against a disabled feature flag,
two session lifecycle mutations were absent entirely, three answer-vault
operations were never called, and two job-scoped routes were never invoked.
Stage 2G-D-R1 closes the evidence gap and replaces the prose claim with a gate
that derives the number from recorded traffic. **No authorization defect was
found in either pass** — every operation the original matrix missed refuses
correctly; what was missing was the proof.

---

## 2. Route inventory

Taken from the live OpenAPI schema, not from grep — the previous count of 45 was
an undercount.

| | |
|---|---|
| published operations | **91** |
| ID-bearing (path parameter) | **53** |

Classification of the 53:

| class | count | examples | evidence required |
|---|---|---|---|
| **foreign-id** | 35 | `/application-sessions/{id}/*`, `/jobs/tracker/{id}/snapshots*`, `/jobs/documents/{id}/*`, `/jobs/{job_id}/people/{recommendation_id}/*` | B presents a type-correct identifier owned by A and is refused |
| **shared-id / private-effect** | 12 | `/jobs/{job_id}/match`, `/save`, `/generate-*`, `/documents/{doc_type}`, `/tracker`, `/applications/confirm-applied`, `/people`, `/people/discover` | both users may invoke; the effect must land only on the caller's rows |
| **caller-scoped key** | 4 | `/application-answers/{canonical_key}` | no object id exists; B sends A's exact key and A's row must be untouched |
| **shared catalogue (excluded)** | 2 | `/jobs/{job_id}`, `/jobs/companies/{key}/logo` | not BOLA — both users may legitimately read a JobPosting |

The three covered classes sum to 51, the applicable owner-private set. Class is
declared per operation in the test and re-checked against recorded traffic; a
`shared-id` operation cannot be satisfied by a refusal, and a `foreign-id`
operation cannot be satisfied by an isolation argument.

`{canonical_key}`, `{fmt}` and `{doc_type}` are vocabulary, not object
identifiers, and carry no ownership.

---

## 3. Method

Two real users via `POST /auth/signup`, each with a genuine Bearer token from
the PyJWT stack Stage 2G-C installed. **No** mocked authentication, **no**
monkeypatched `current_user`, **no** direct `user_id` substitution — every
attack crosses the same boundary a real client would.

User A's graph is built entirely through ordinary API calls: profile → session
→ generated résumé and cover letter → artifact-use → `submission-confirmed` →
tracker → snapshot. B is provisioned identically so that a refusal can be
distinguished from a broken route.

Three properties keep the suite honest:

1. **Owner control.** Every path B is refused, A is asserted to reach with 200.
   Without this the matrix could pass because the routes are simply broken.
2. **Token swap.** Identical method, path and body; only the identity differs.
3. **Side-effect verification.** Every rejected mutation is followed by a
   re-read *as A*, and by direct row inspection. A 403 that changed the row
   anyway does not pass.

4. **Measured coverage.** `b01_coverage.py` records every request the suite
   issues — method, resolved OpenAPI template, JWT subject, and the *typed*
   ownership of each identifier carried — and the gate compares that against
   the live private-operation set. A coverage claim with no matching request is
   reported as missing. Only the `sub` claim, the template, extracted integer
   ids and the status code are retained; passwords, whole tokens, résumé and
   cover-letter text and answer values are never recorded.
5. **Type-correct ownership.** Identifier collisions across resource types
   caused false coverage in Stage 2G-D: in this fixture A's
   `cover_letter_document_id` and B's `session_id` are both `2`, so a flat
   "did the path contain one of A's ids" test scored a foreign-session attack
   that never happened. Ownership is tracked as `(kind, id) -> user_id` and a
   path parameter counts only when the kind the route expects matches.
6. **Genuinely reachable routes.** A route whose feature flag is off answers 404
   before authorization runs, so "B was refused" proves nothing. The People
   family and `app_env` are therefore enabled through `monkeypatch` for the
   matrix, and each People route gets an owner control that must NOT return
   404 — which is the assertion Stage 2G-D could not make.

Database: in-memory SQLite created and dropped per test, with an explicit
assertion that the engine is `:memory:` before the matrix runs. No production
or shared database was touched.

---

## 4. Two ownership guards

The API enforces ownership in two distinct places, which is why the matrix had
to cover both:

| guard | used by | absent id | foreign id |
|---|---|---|---|
| `applications._resolve_session` | the session family | 404 | **403** |
| `applications._owned_session` | some session mutations | 404 | 404 |
| `people.owned_recommendation` | People recommendation routes | 404 | 404 |
| `jobs.py` query filters (`user_id == user.id`) | tracker, snapshot, document | 404 | 404 |

Session routes accept **either** a session-scoped token or the owning user's
access token, and check both against `session.user_id`.

---

## 5. Results

Every B → A operation was refused, and A's graph was intact afterwards.

| surface | result |
|---|---|
| session detail, answers, overrides, résumé, cover letter | refused |
| snapshot list, snapshot detail | refused |
| document download (pdf, docx), export, metadata update | refused |
| session lifecycle: cancel, complete, confirmation-required/dismissed, refresh, regenerate ×2, artifact-use, autofill-results, events | refused |
| `submission-confirmed` on A's session | refused — **no** snapshot created, **no** tracker transition, **no** tracker gained by B |
| `resolve-questions` against A's session | refused |
| tracker status mutation, `cancel-deletion` | refused, retention fields unchanged |
| answer override PUT/GET, session answer PUT, profile name PUT | refused |
| nested substitution: B-parent+A-child, A-parent+B-child, absent-parent+A-child, A-parent+absent-child | refused |
| foreign `resume_document_id` / `cover_letter_document_id` offered as B's provenance | not adopted |
| client-supplied `user_id` / `owner_id` on session creation | ignored; row owned by the authenticated principal |
| private collections (`/jobs/tracker/submitted`) | contain only the caller's rows |
| shared job reachable by both | carries no private state across |
| `PATCH .../status` on A's session — **absent from Stage 2G-D** | refused 403, A's status unchanged |
| `POST .../map-option` on A's session — **absent from Stage 2G-D** | refused 403, no answer written for A |
| People: `save`, `contacted`, `feedback`, `email`, `outreach-draft`, `outreach-draft/improve`, `DELETE save` against a **real A-owned recommendation** | refused 404; `saved_at`, `contacted_at`, ownership unchanged; no feedback row filed for B |
| People: `GET /people`, `/diagnostics`, `discover`, `broaden` on A's shared job | 200 for B, but A's recommendation and identity absent from every body |
| vault `verify`, `disable-autofill`, `DELETE` with A's exact canonical key | A's row untouched; B's own row is the one affected |
| `generate-materials` on the shared job | effect lands on the caller; A's document set unchanged; B cannot read A's documents |
| `/privacy/export` | A's export carries A's profile and documents and none of B's; B's carries B's and none of A's; document id sets disjoint |
| `DELETE /privacy/account` | self-scoped — B's deletion removed B and left A's account intact |
| `documents/{doc_type}` on the shared job | B receives a **B-owned** document; A's set unchanged; B still refused on A's document ids |

See §8.1 for the negative controls.

---

## 6. Findings

### NEW-05 — ownership oracle on the session family

**Severity: Low. OPEN. P2. Reported, deliberately not remediated here.**

**Scope correction.** Stage 2G-D documented this as "`/application-sessions/{id}`
and 4 sub-routes" — 5 routes. The real surface is **20 of the 22 private
session-family operations**, enumerated from the live schema and pinned by
`test_new05_scope_is_exactly_the_routes_documented`:

| | foreign id | absent id | |
|---|---|---|---|
| 20 session-family operations (all 5 GETs, 11 of 13 POSTs, the PATCH, all 3 PUTs) | **403** | 404 | distinguishable |
| `POST .../regenerate-resume`, `POST .../regenerate-cover-letter` | 404 | 404 | conceals |
| tracker, snapshot, document families | 404 | 404 | conceals |

The 20 distinguishing operations:

`GET /application-sessions/{session_id}` · `GET .../answers` ·
`GET .../answers/override` · `GET .../cover-letter` · `GET .../resume` ·
`PATCH .../status` · `POST .../artifact-use` · `POST .../autofill-results` ·
`POST .../cancel` · `POST .../complete` · `POST .../confirmation-dismissed` ·
`POST .../confirmation-required` · `POST .../events` · `POST .../map-option` ·
`POST .../refresh-from-profile` · `POST .../resolve-questions` ·
`POST .../submission-confirmed` · `PUT .../answers/override/{canonical_key}` ·
`PUT .../answers/{canonical_key}` · `PUT .../profile/name`

`_resolve_session` fetches the row (404 when missing) *before* deciding
authorization (403 when foreign), so the two cases are structurally
distinguishable. An attacker walking the integer id space can learn which
session ids exist under *some* account.

Boundary, re-verified across all 20 routes:

- **content disclosure: NO.** Every refusal body is checked for A's name and
  email; both absent throughout.
- **mutation authority: NO.** Every mutating route is followed by a re-read of
  A's session state, which is unchanged.
- **private state: NO.**
- **existence only: YES.**

Why it is not fixed in this stage: 403 is this repository's "authenticated but
not entitled" signal, and accepted Stage 2A–2E tests across three files assert
it explicitly. Converging on 404 is an API-contract decision, not the narrow
authorization change this stage permits.

Recommended for a later stage: make `_resolve_session` answer 404 for both
cases and update the asserting tests, as one deliberate contract change.

### NEW-06 — routes returning raw ORM rows answered 500 for everyone

**Severity: Medium (availability / compliance). RESOLVED in Stage 2G-D-R2.**

Two endpoints were annotated `-> dict` but returned unserialized SQLAlchemy
entities, so pydantic v2 raised and FastAPI answered 500 — for every caller,
the owner included:

| route | returned | before | after |
|---|---|---|---|
| `GET /privacy/export` | `UserProfile`, `Education`, `Experience`, … | **500** for every authenticated user, with or without a profile | **200**, JSON-safe |
| `POST /jobs/{job_id}/documents/{doc_type}` | `GeneratedDocument` | **500** for every caller; row committed before the crash | **200**, `{"document": …}` |

Both were found because the R1 matrix required these routes to be *genuinely*
reachable. Neither had any other test in the suite;
`POST /jobs/{job_id}/documents/{doc_type}` also has no caller in the web app or
the extension. `GET /privacy/export` is the GDPR/CCPA subject-access endpoint,
so a silent total failure was a compliance exposure, not a cosmetic bug.

**Fix.** Both routes now serialize through the representation the rest of the
API already uses — no new competing document shape and no `response_model=None`
escape hatch:

- `POST /jobs/{job_id}/documents/{doc_type}` returns
  `{"document": serialize_document(record)}`, identical to `update_document`,
  `generate-resume` and `generate-materials`. `serialize_document` deliberately
  omits the internal `*_file_path` columns and exposes `download_urls` instead.
- `GET /privacy/export` serializes each category through `public_dict`, this
  repository's existing row-to-dictionary helper (the one
  `services.documents.profile_payload` uses), and its documents through
  `serialize_document`. Export scope, category names and per-user filters are
  unchanged; `user` is still hand-built so only id/email/created_at are exposed.

**Credential exclusion.** `public_dict` drops `hashed_password` but knew nothing
about `UserProfile.workday_password_ciphertext` — the encrypted third-party ATS
credential — so serializing the profile row would have placed that ciphertext in
the export body. That same unfiltered helper also feeds
`profile_payload`, which is transmitted to an external AI provider — tracked
separately as **NEW-07** (`xpertapply-new-07-ai-prompt-credential-exposure.md`,
OPEN / MEDIUM / P1). NEW-07 is pre-existing and outside this stage; the
exclusion below is what kept the NEW-06 repair from adding a second exposure
path. That is a stored credential, not user content, and is now
excluded through an explicit, tested `EXPORT_EXCLUDED_COLUMNS`. An audit of all
eleven exported models found no other credential column
(`Certification.credential_url` and `JobMatch.job_content_hash` are legitimate
user data and are retained).

**Transaction and retry behaviour.** The commit lives inside
`generate_document`, before the response is built, so the row was persisted and
the caller still saw a 500. With serialization fixed, a successful mutation now
yields a successful response and the ambiguity is gone for valid requests; no
transaction restructuring was needed. Repeat calls still create a new document
per call — measured: three calls, three rows — but that is the existing
behaviour of every generation route (`generate-resume` behaves identically), so
it is product versioning semantics rather than a NEW-06 regression. The crash
was what made it dangerous, because a client retrying an apparently failed
request accumulated a document per attempt; removing the 500 removes the retry
driver. No idempotency system was introduced. `test_job_document_creation
_versions_rather_than_deduplicates` pins the behaviour so a future change to it
is deliberate.

**Evidence.** `app/tests/test_new06_response_serialization.py` — 13 cases
asserting the response *contract* rather than `status_code < 500`: success and
empty-state export, category shape, full `json.dumps` round-trip, credential and
storage-path exclusion, authentication still required (401), document envelope
and usable `download_urls`, cover-letter type, 422 on an unknown type,
caller-scoped effect on a shared job, cross-user document denial, and version
semantics. Two negative controls restore the defect under `monkeypatch` and
require the contract tests to fail, proving they are load-bearing.

## 7. Coverage

Every number below is produced by `test_every_private_operation_is_dynamically
_covered`, which compares the live OpenAPI private set against the requests the
suite actually issued. The Stage 2G-D edition of this section asserted 51/51 in
prose; an independent replay measured 27/51. Prose is no longer the source.

| | |
|---|---|
| published operations | 91 |
| ID-bearing operations | 53 |
| shared/catalogue, excluded with reason | 2 |
| owner-private requiring coverage | **51** |
| dynamically covered | **51** |
| uncovered | **0** |
| operations with an owner control | **51** |
| operations with a recorded foreign-identifier attack | 36 |
| operations with a post-attack state re-read | 39 |
| matrix cases | 45 |

Refusals observed on foreign-identifier attacks: **403 ×20, 404 ×15**. No
operation is counted as protected on the strength of a 422 — schema rejection
proves a malformed body, not an ownership check, so every foreign-id row above
carries a 403 or a 404.

Every one of the 51 now has a **meaningful owner success control**. R1 had 47;
the four gaps were `PUT .../answers/override/{canonical_key}`,
`PUT .../answers/{canonical_key}`, `PUT .../profile/name` and
`POST .../resolve-questions` — all session writes with a real success path, now
paired with an owner control that asserts the write actually landed. There is no
operation whose authorization evidence rests on the route failing for everyone.

### 7.1 Operation-level coverage

| # | method | operation | class | owner control | B evidence | side-effect |
|---|---|---|---|---|---|---|
| 1 | DELETE | `/application-answers/{canonical_key}` | caller-scoped key | yes | isolation asserted | yes |
| 2 | PUT | `/application-answers/{canonical_key}` | caller-scoped key | yes | isolation asserted | yes |
| 3 | POST | `/application-answers/{canonical_key}/disable-autofill` | caller-scoped key | yes | isolation asserted | yes |
| 4 | POST | `/application-answers/{canonical_key}/verify` | caller-scoped key | yes | isolation asserted | yes |
| 5 | GET | `/application-sessions/{session_id}` | foreign-id | yes | refused 403 | — |
| 6 | GET | `/application-sessions/{session_id}/answers` | foreign-id | yes | refused 403 | — |
| 7 | GET | `/application-sessions/{session_id}/answers/override` | foreign-id | yes | refused 403 | yes |
| 8 | PUT | `/application-sessions/{session_id}/answers/override/{canonical_key}` | foreign-id | yes | refused 403 | yes |
| 9 | PUT | `/application-sessions/{session_id}/answers/{canonical_key}` | foreign-id | yes | refused 403 | yes |
| 10 | POST | `/application-sessions/{session_id}/artifact-use` | foreign-id | yes | refused 403 | yes |
| 11 | POST | `/application-sessions/{session_id}/autofill-results` | foreign-id | yes | refused 403 | yes |
| 12 | POST | `/application-sessions/{session_id}/cancel` | foreign-id | yes | refused 403 | yes |
| 13 | POST | `/application-sessions/{session_id}/complete` | foreign-id | yes | refused 403 | yes |
| 14 | POST | `/application-sessions/{session_id}/confirmation-dismissed` | foreign-id | yes | refused 403 | yes |
| 15 | POST | `/application-sessions/{session_id}/confirmation-required` | foreign-id | yes | refused 403 | yes |
| 16 | GET | `/application-sessions/{session_id}/cover-letter` | foreign-id | yes | refused 403 | — |
| 17 | POST | `/application-sessions/{session_id}/events` | foreign-id | yes | refused 403 | yes |
| 18 | POST | `/application-sessions/{session_id}/map-option` | foreign-id | yes | refused 403 | yes |
| 19 | PUT | `/application-sessions/{session_id}/profile/name` | foreign-id | yes | refused 403 | yes |
| 20 | POST | `/application-sessions/{session_id}/refresh-from-profile` | foreign-id | yes | refused 403 | yes |
| 21 | POST | `/application-sessions/{session_id}/regenerate-cover-letter` | foreign-id | yes | refused 404 | yes |
| 22 | POST | `/application-sessions/{session_id}/regenerate-resume` | foreign-id | yes | refused 404 | yes |
| 23 | POST | `/application-sessions/{session_id}/resolve-questions` | foreign-id | yes | refused 403 | — |
| 24 | GET | `/application-sessions/{session_id}/resume` | foreign-id | yes | refused 403 | — |
| 25 | PATCH | `/application-sessions/{session_id}/status` | foreign-id | yes | refused 403 | yes |
| 26 | POST | `/application-sessions/{session_id}/submission-confirmed` | foreign-id | yes | refused 403 | yes |
| 27 | PUT | `/jobs/documents/{document_id}` | foreign-id | yes | refused 404 | yes |
| 28 | GET | `/jobs/documents/{document_id}/download/{fmt}` | foreign-id | yes | refused 404 | — |
| 29 | POST | `/jobs/documents/{document_id}/export/{fmt}` | foreign-id | yes | refused 404 | yes |
| 30 | POST | `/jobs/tracker/{tracker_id}/cancel-deletion` | foreign-id | yes | refused 404 | yes |
| 31 | GET | `/jobs/tracker/{tracker_id}/snapshots` | foreign-id | yes | refused 404 | — |
| 32 | GET | `/jobs/tracker/{tracker_id}/snapshots/{snapshot_id}` | foreign-id | yes | refused 404 | — |
| 33 | POST | `/jobs/{job_id}/applications/confirm-applied` | shared-id / private-effect | yes | isolation asserted | yes |
| 34 | POST | `/jobs/{job_id}/documents/{doc_type}` | shared-id / private-effect | yes | isolation asserted | yes |
| 35 | POST | `/jobs/{job_id}/generate-cover-letter` | shared-id / private-effect | yes | isolation asserted | yes |
| 36 | POST | `/jobs/{job_id}/generate-materials` | shared-id / private-effect | yes | isolation asserted | yes |
| 37 | POST | `/jobs/{job_id}/generate-resume` | shared-id / private-effect | yes | isolation asserted | yes |
| 38 | POST | `/jobs/{job_id}/match` | shared-id / private-effect | yes | isolation asserted | yes |
| 39 | GET | `/jobs/{job_id}/people` | shared-id / private-effect | yes | isolation asserted | — |
| 40 | POST | `/jobs/{job_id}/people/broaden` | shared-id / private-effect | yes | isolation asserted | — |
| 41 | GET | `/jobs/{job_id}/people/diagnostics` | shared-id / private-effect | yes | isolation asserted | — |
| 42 | POST | `/jobs/{job_id}/people/discover` | shared-id / private-effect | yes | isolation asserted | — |
| 43 | POST | `/jobs/{job_id}/people/{recommendation_id}/contacted` | foreign-id | yes | refused 404 | yes |
| 44 | POST | `/jobs/{job_id}/people/{recommendation_id}/email` | foreign-id | yes | refused 404 | yes |
| 45 | POST | `/jobs/{job_id}/people/{recommendation_id}/feedback` | foreign-id | yes | refused 404 | yes |
| 46 | POST | `/jobs/{job_id}/people/{recommendation_id}/outreach-draft` | foreign-id | yes | refused 404 | yes |
| 47 | POST | `/jobs/{job_id}/people/{recommendation_id}/outreach-draft/improve` | foreign-id | yes | refused 404 | yes |
| 48 | DELETE | `/jobs/{job_id}/people/{recommendation_id}/save` | foreign-id | yes | refused 404 | yes |
| 49 | POST | `/jobs/{job_id}/people/{recommendation_id}/save` | foreign-id | yes | refused 404 | yes |
| 50 | POST | `/jobs/{job_id}/save` | shared-id / private-effect | yes | isolation asserted | yes |
| 51 | PUT | `/jobs/{job_id}/tracker` | shared-id / private-effect | yes | isolation asserted | yes |

### 7.2 What coverage does NOT accept

Stage 2G-D counted several of these as covered. The gate now rejects each one:

- a route whose feature flag is off, so the 404 is the flag rather than ownership
- a nonexistent identifier (`999999`) in place of a real foreign one
- an identifier of the wrong resource type that happens to collide numerically
- a sibling route sharing a service helper
- source inspection
- a setup request that happened to hit the route as its owner
- a 422 schema rejection
- a route that answers 500 to everyone, owner included (NEW-06 — now fixed, so
  both affected operations carry functional owner controls instead of pins)

## 8. Validation

B-01 matrix **45/45** (0 skipped, 0 blocked) · coverage gate **51/51 covered,
51/51 owner controls, uncovered 0** · NEW-06 focused **13/13** · JWT/auth
**44/44** · application/people/profile/privacy/tracker/snapshot/document/
vault/jobs/session families **1290/1290** · NEW-01 retention **58/58** ·
PostgreSQL `-m migration` **9/9** (disposable server; never a production DB) ·
full API ×2 **2018/2018** each, exit 0 (Stage 2G-D baseline 1985, R1 2004,
R2 +14) · Ruff `ruff check app` PASS.

### 8.1 Negative controls

Stage 2G-D's controls edited production source by hand and left no artefact, so
nothing prevented the matrix from being decorative. They are now test-level,
reproducible, and each FAILS if the breach does not appear:

| family | control | result |
|---|---|---|
| sessions | `_resolve_session` monkeypatched to skip its ownership comparison | B reads A's session → 200; matrix would have caught it |
| documents | `Session.get` patched so A's `GeneratedDocument` reports B as owner | B downloads A's résumé → 200 |
| people | `owned_recommendation` resolved as the row's owner instead of the caller | B saves A's recommendation → 200 |

All three run under `monkeypatch`, so nothing survives teardown and no unsafe
source is committed. The coverage gate excludes exactly these three tests from
its "no stranger ever received a 2xx" scan; a breach recorded anywhere else
fails the suite.

The NEW-06 contract tests carry the same kind of control, in
`test_new06_response_serialization.py`:

| target | control | result |
|---|---|---|
| job documents | `serialize_document` patched to return the ORM row | route answers 500; the contract test catches it |
| privacy export | `_export_dict` patched to return the ORM row | route answers 500; the contract test catches it |

---

## 9. Scope

| path | kind |
|---|---|
| `apps/api/app/routes/privacy.py` | **NEW-06 fix** — serialize export rows; exclude the stored credential |
| `apps/api/app/routes/jobs.py` | **NEW-06 fix** — one line: return `serialize_document(record)` |
| `apps/api/app/tests/test_new06_response_serialization.py` | NEW-06 regression (new) |
| `apps/api/app/tests/test_b01_two_user_authorization.py` | matrix (extended) |
| `apps/api/app/tests/b01_coverage.py` | coverage instrumentation (new) |
| `docs/plans/xpertapply-stage-2gd-b01-authorization-matrix.md` | this document |

Production change is confined to the two response paths NEW-06 names. No
migration (NEW-06 is serialization, not schema), no dependency change, no Web or
extension change, and no change to any authorization code — B-01 required none
in R1 and required none here.

Test-only configuration: the People feature and `app_env` are enabled through
`monkeypatch` inside a fixture, which restores them at teardown. Production
defaults are unchanged — `people_recommendations_enabled=False`,
`people_rollout_mode="disabled"`.

## 10. Rollback

Deleting the test files removes evidence, not behaviour. The two NEW-06 route
changes are the only runtime edits; reverting either restores a 500 for every
caller of that endpoint, which is why they should not be reverted
independently of the finding.
