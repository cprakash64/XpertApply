# Profile persistence failure investigation

Status: diagnosis complete; no production repair implemented in this stage.

Stage 2 status (2026-08-14): backend profile-URL invariant implemented and
focused validation complete. Legacy-data repair remains explicitly deferred.

Stage 3 status (2026-08-14): true partial main-profile update contract and
focused-editor isolation implemented and validated.

Stage 4 status (2026-08-14): structured validation feedback, small frontend URL
normalization parity, canonical response synchronization, and retry behavior
implemented and validated.

Stage 5 status (2026-08-14): production-safe legacy profile-URL audit,
compare-and-set repair, private rollback manifest, and conflict-safe rollback
utility implemented. It has not been run against production.

Stage 6 closure status (2026-08-15): infrastructure reconciliation proved one
production deployment and established the intended loopback port contract.
Final closure adds a tracked, secret-free production Compose overlay and a
fail-fast deployment wrapper. The wrapper requires the `luna` deployment user
and authoritative checkout, launches Compose with a minimal environment,
loads the production `.env` explicitly, and asserts the merged project name,
web port, and API port before every operation. Backup verification,
authenticated product smoke testing, and the final URL invariant audit remain
gated production steps.

## Objective and scope

Determine why saving **My Profile -> Job preferences** can fail on an unrelated
stored `portfolio_url`, identify every contract and write path involved, measure
the blast radius, and recommend a production repair without weakening URL
validation or performing the repair prematurely.

This stage is intentionally diagnostic. It makes no route, schema, UI, database,
or data changes.

## Worktree and repository safety

- Branch at investigation start: `main`, tracking `origin/main`.
- `git status --porcelain=v1 -uall`: clean.
- No unrelated modified or untracked files were present before this plan was
  added.
- Recent path history available from `main`: `ed3cfd1` and `1814ef1`. Commands
  that enumerate all refs report a pre-existing broken ref,
  `refs/heads/backup/main-before-remote-sync-20260728`; it was not modified.
- No commit, push, reset, stash, clean, checkout, migration, or production-data
  operation was performed.

## Confirmed call chain

1. `apps/web/app/profile/[section]/page.tsx` maps `/profile/preferences` to the
   focused `SectionEditor`.
2. `SectionEditor` selects `PreferencesEditor` and supplies the shared
   `useProfileEditorData()` state/save implementation.
3. `useProfileEditorData()` loads `GET /profile`, `GET /profile/career`, and
   `GET /auth/me`. `normalizeProfile()` copies every profile field, including
   stored links, into one `ProfileForm`.
4. `PreferencesEditor` changes only `target_roles`, `target_levels`,
   `preferred_locations`, or `remote_preference` in that full form object.
5. Save calls `saveProfile()`, which calls `profileToWire(current.form)` and
   submits `PUT /profile`.
6. `profileToWire()` emits the whole profile document, including
   `portfolio_url`; it does not trim or normalize a non-empty link.
7. FastAPI binds the request to `UserProfileIn`. Its `linkedin_url`,
   `github_url`, `portfolio_url`, and `x_url` are `HttpUrl | None`.
8. Pydantic rejects `cpandey.com` before `upsert_profile()` executes, so the
   whole replacement receives HTTP 422 and no preference is persisted.
9. The shared `api()` helper retains a FastAPI validation-array response as the
   raw JSON response string. The focused editor copies `ApiError.message` into
   `SaveState`, and `SaveBar` renders `Error saving - {state.message}`. Its
   `Retry` button calls the same `saveProfile()` with unchanged state, so it
   deterministically resends the same invalid payload.

## Payload evidence

The preferences save is structurally a complete profile replacement:

```json
{
  "full_name": "...",
  "application_email": null,
  "phone": "...",
  "location_city": "...",
  "location_state": "...",
  "location_postal_code": "...",
  "location_country": "...",
  "linkedin_url": null,
  "github_url": null,
  "portfolio_url": "cpandey.com",
  "x_url": null,
  "additional_links": [],
  "work_authorization": "...",
  "work_authorization_status": "...",
  "requires_sponsorship": false,
  "open_to_relocation": false,
  "target_roles": ["Backend Engineer"],
  "target_levels": ["Mid"],
  "preferred_locations": ["New York"],
  "remote_preference": "hybrid",
  "work_preference": "hybrid",
  "skills": []
}
```

The exact optional values vary by user; the key fact is that `profileToWire()`
always emits every key above.

## Root causes and bad-data origin

There are two independent defects plus one UX amplifier:

1. **Over-coupled persistence:** all focused profile sections backed by the
   profile record use the same full-document `PUT /profile`. A field outside the
   visible section can invalidate the save.
2. **Inconsistent write boundaries:** `/profile/import/apply` validates imported
   named links as unrestricted `str` fields in `ImportProfileDraft` and assigns
   them directly to `UserProfile` string columns. It never passes them through
   `UserProfileIn`/`HttpUrl`. AI parser output and values edited in
   `ImportProfilePreview` are neither normalized nor URL-validated at apply
   time. The deterministic parser does add `https://`, but that does not protect
   the AI/import-review path. A frontend regression test explicitly documents
   that this route can persist even script-capable schemes.
3. **Raw validation UX:** focused editors do not map FastAPI validation arrays
   to fields and offer Retry even though `ApiError.retryable` is false for 422.

The initial `HttpUrl` fields and the bypassing import-apply assignment both date
to the repository's original profile implementation, so this is not evidence
of validation being tightened after legacy rows were created. Direct database
writes remain possible because the columns are plain `VARCHAR(500)`, but code
provides a concrete in-product origin; no direct-write hypothesis is needed to
explain the incident.

## URL contract audit

| Field group | Frontend | API write schema | Storage | Finding |
| --- | --- | --- | --- | --- |
| `linkedin_url`, `github_url`, `portfolio_url`, `x_url` | Focused Links editor uses `isValidOptionalUrl`, a prefix-only `http(s)` check; other focused sections do not revalidate loaded links. The full wizard checks only the original three. | `HttpUrl | None` on `UserProfileIn` | Four nullable `VARCHAR(500)` columns | Strict normal PUT, but import apply bypasses it. Any invalid stored named link can block Personal, Preferences, Skills, Links, or Application Preferences saves. |
| `additional_links[].url` | Same prefix-only check in focused Links editor | `AdditionalLinkIn.url: HttpUrl` | Nullable JSON list | Normal PUT is strict. Import currently does not persist `other_links`, so the confirmed bypass applies to the three original named links, not this list. |
| Publication `url` | Prefix-only check | `PublicationIn.url: HttpUrl | None` | `VARCHAR(500)` | A bad stored publication can block saving an unrelated Experience/Education/Project/Credential section because `PUT /profile/career` replaces all career records. |
| Project `links[]` | Prefix-only check in focused editor; import preview accepts strings | `list[str]` | JSON | No authoritative URL validation. Unsafe/malformed values can be persisted; they do not cause this 422 class because the backend accepts them. |
| Certification `credential_url` | Unvalidated text field | `str | None` | `VARCHAR(500)` | Frontend/backend agree on permissive strings, but the URL-labeled field lacks the safety contract used for publications/profile links. |
| Job/company/application/source/logo/profile URLs | Mostly provider/ingestion or read-only application data, not profile form input | Separate job/people contracts and safety helpers | Separate tables | Outside this profile-save payload and not causal here. |

`isValidOptionalUrl()` is also weaker than `HttpUrl`: any value beginning with
`http://` or `https://` passes client validation even if it is otherwise
malformed. It does not normalize whitespace or bare domains.

## Deterministic reproduction

An isolated TestClient/SQLite run performed this sequence:

1. Create a profile through valid `PUT /profile` (`200`).
2. Simulate a bypass/legacy row by setting the ORM column to `cpandey.com`.
3. `GET /profile` returns `cpandey.com` unchanged.
4. Resubmit that profile with only `target_roles` changed.
5. `PUT /profile` returns the production-equivalent `422`:

```json
{
  "detail": [{
    "type": "url_parsing",
    "loc": ["body", "portfolio_url"],
    "msg": "Input should be a valid URL, relative URL without a base",
    "input": "cpandey.com",
    "ctx": {"error": "relative URL without a base"}
  }]
}
```

Replacing only that value with `https://cpandey.com` makes the same request
succeed (`200`) and Pydantic stores `https://cpandey.com/`.

Current `HttpUrl | None` matrix:

| Input | Current result |
| --- | --- |
| `null` | accepted as absent |
| `""` | rejected: empty URL |
| `"   "` | rejected: relative URL without a base |
| `www.cpandey.com` | rejected: relative URL without a base |
| `cpandey.com` | rejected: relative URL without a base |
| `https://cpandey.com` | accepted, serialized with trailing `/` |
| `http://cpandey.com` | accepted, serialized with trailing `/` |
| `javascript:alert(1)` | rejected: scheme must be HTTP(S) |
| `file:///etc/passwd` | rejected: scheme must be HTTP(S) |
| `not a url` | rejected: relative URL without a base |

The frontend converts exact empty strings to `null` in `profileToWire()`, but it
does not trim whitespace, so a whitespace-only value remains invalid.

## Test-gap analysis

Existing tests cover structured target updates, normal valid profile PUTs,
unsafe schemes for `x_url`/additional links, focused-editor happy-path payloads,
prefix validation on the Links screen, and safe rendering of imported unsafe
stored links. They do not combine the conditions that trigger production:

- a persisted invalid named link created through import/direct ORM;
- loading that value into the shared profile form;
- changing only Job Preferences;
- submitting the full profile PUT;
- asserting that the unrelated value cannot block the preference update; and
- asserting field-safe error handling rather than raw FastAPI JSON/identical
  Retry.

Tests use empty or canonical profile links in preference-editor fixtures, and
the backend target-update test omits invalid existing data. The rendering test
acknowledges the bypass but stops at safe display; there is no persistence
regression test crossing both write paths.

## Architecture decision for the repair stage

### Approach A: retain full-profile PUT everywhere

This can be made less fragile only by normalizing/backfilling every stored value,
closing every bypass, and validating every field on every save. It preserves
correct PUT replacement semantics, but unrelated fields remain coupled, stale
tabs can overwrite newer data, every client must know the complete document,
and future schema tightening can recreate the incident. Keep PUT for compatible
full-document clients, but do not use it for focused editors.

### Approach B: generic partial profile PATCH (recommended)

Add an all-optional update schema whose route applies only `model_fields_set`
(`exclude_unset=True`) and validates each supplied field with the same
authoritative validators as the full input schema. Focused editors submit only
the fields they own; the wizard may continue using full PUT. This matches the
existing single profile aggregate, avoids endpoint proliferation, preserves
strict per-field validation, and sharply limits stale overwrite/validation
blast radius. Explicit `null` must remain distinguishable from omitted, and
list replacement semantics must be documented and tested.

### Approach C: dedicated subsection PATCH endpoints

This gives the clearest ownership and can encode section-specific authorization
or side effects, as existing `/profile/name`, `/workday-credentials`,
`/demographics`, and `/application-eligibility` already do. For ordinary
profile scalar/list groups, however, one endpoint per UI section would bind API
architecture to UI navigation and duplicate schemas/routes. Reserve dedicated
subresources for materially distinct security/lifecycle domains, not every
editor card.

Recommended Stage 2 design: Approach B for ordinary profile fields, retain the
existing dedicated security/identity subresources and PUT compatibility, and
consider the same partial-update principle for career subsections separately.

## URL normalization and data repair design

- Accept user-entered bare domains for website-like profile inputs by trimming
  first and, only when no scheme is present, defaulting to `https://` before
  final `HttpUrl` validation.
- Keep explicit `http://` as HTTP; never rewrite an explicit scheme silently.
- Reject non-HTTP(S) schemes and malformed values. Do not use a custom URL regex.
- Treat missing as omitted, `null` as clear, and trimmed empty input as clear.
- Use frontend normalization for immediate UX plus one authoritative backend
  normalizer shared by PUT, PATCH, and import apply. The backend must not rely on
  the frontend or parser.
- Preserve paths, queries, fragments, IDNs, and Pydantic canonicalization. SSRF
  controls are not currently required because profile links are stored/rendered,
  not fetched; add network-destination policy if fetching is introduced.

Existing data needs an audited one-time repair/backfill, not only lazy
normalization. The import bypass can store bare domains and unsafe schemes;
silently prepending HTTPS to every invalid string would incorrectly transform
garbage or dangerous schemes. Classify rows, canonicalize values that validate
after safe missing-scheme normalization, and quarantine/clear only with an
explicit product policy. Make the script dry-run capable, aggregate-reporting,
idempotent, and reversible through a before-value audit/export. No schema
migration is needed for column types; an Alembic data migration or separately
controlled repair command is needed depending on operational policy.

The available local Postgres contains no `user_profiles` rows, so it cannot
measure prevalence. Production data was not queried or modified.

## Rollout and rollback proposal (future stage)

1. Add shared backend normalization/validation and close import apply first.
2. Add PATCH and regression/contract tests while retaining PUT.
3. Dry-run the production data audit; review only aggregate classifications.
4. Backfill recoverable bare domains with reversible audit records.
5. Deploy focused-editor PATCH calls behind a compatibility flag and monitor
   profile validation failures by safe field/type (never submitted value).
6. Roll back clients to PUT if needed; keep normalized data and closed write
   boundaries because both are independently safe. Roll back data only from the
   captured before-values if policy requires it.

## Progress and validation log

- [x] Worktree/branch safety checked.
- [x] Frontend render/state/save/API call chain traced.
- [x] Backend route/schema/ORM/migration contract traced.
- [x] All profile update callers and related subsection dependencies audited.
- [x] URL-like fields and import/parser/direct-ORM paths audited.
- [x] Pydantic input matrix reproduced in the running API container.
- [x] End-to-end FastAPI 422 reproduced with isolated TestClient/SQLite state.
- [x] Local Postgres checked using aggregate-only queries; no profile rows exist.
- [x] Error propagation, Retry behavior, and test gaps identified.
- [x] Final repository validation commands recorded after this document was added.

### Validation results (2026-08-14 America/New_York)

- Focused web profile suites: 119/119 passed.
- Focused API profile/import suites: 61/61 passed in a disposable API-image
  container with the host source mounted.
- `make test-web`: passed ESLint, TypeScript, production Next build, and 749/749
  tests. JSDOM printed its known navigation-not-implemented diagnostics, but the
  command exited zero.
- `make test-extension`: passed TypeScript, 819/819 tests, and the extension
  build. An earlier concurrent run timed out one keyboard dropdown test; that
  exact file passed 31/31 in isolation and the complete gate then passed when
  rerun without resource contention.
- Backend `ruff check app` in the disposable API image: passed.
- Full backend equivalent (`compileall` plus all pytest tests in the disposable
  API image): 1,676 passed, 2 skipped, 2 failed. Both failures are artifacts of
  the fallback container mount, not this change: the document export lacks the
  Compose generated-files volume, and an environment-example test assumes the
  normal repository parent depth while the source was mounted at `/src`.
- The literal `make test-api` host path could not run because macOS File
  Provider reports pytest/Pydantic virtualenv modules as evicted and does not
  hydrate them after `brctl download`. The disposable-image run was used rather
  than modifying or reinstalling the environment.
- `docker compose config -q`: passed.
- `git diff --check`: passed.
- No Alembic migration was added or changed, so upgrade/downgrade validation is
  not applicable in this diagnostic-only stage.

## Stage 2: canonical backend profile-URL contract

### Architecture and decision

One reusable Pydantic normalization type now owns user-entered profile web URL
semantics in `app/profile/urls.py`:

```text
raw input
-> trim and blank-to-null
-> preserve explicit scheme
-> add HTTPS only to qualified scheme-less hosts
-> Pydantic HttpUrl validation/canonicalization
-> JSON-mode string at the ORM boundary
```

`ProfileUrl` is required for a populated additional-link row;
`OptionalProfileUrl` represents nullable named links. Both use the same
`normalize_profile_url_input` pre-validator. Field-specific host restrictions
were deliberately not added: these fields hold general user web links, and the
backend does not fetch them.

Qualified scheme-less input means a dotted hostname, IP address, or localhost.
This accepts the documented bare-domain/path cases but does not promote an
arbitrary single word into a web URL. Pydantic remains the actual URL parser and
HTTP(S)-scheme authority; no custom URL regex was introduced.

### Write-path enforcement

- `PUT /profile`: `UserProfileIn` uses `OptionalProfileUrl` for LinkedIn,
  GitHub, portfolio, and X. `AdditionalLinkIn.url` uses required `ProfileUrl`.
  The route's existing `model_dump(mode="json")` writes canonical strings.
- `POST /profile/import/apply`: both possible named-link sources
  (`BasicInfoDraft` and `LinksDraft`) use `OptionalProfileUrl`. FastAPI validates
  the complete request before route execution, so malformed non-empty input
  returns 422 before any profile mutation. The route dumps those nested models
  in JSON mode before assigning ORM columns.
- Signup creates no URL values. All other backend occurrences found in the
  audit are reads, provider/people records with separate contracts, or
  test-only direct ORM writes. No second normal profile-URL bypass remains.

Blank import values normalize to null and retain the import route's existing
"do not overwrite with absence" merge behavior. Invalid values are never
silently discarded.

### Persistence, compatibility, and transaction behavior

`cpandey.com` becomes the Pydantic canonical string
`https://cpandey.com/`, is stored as that string in `VARCHAR(500)`, and is
returned unchanged by `GET /profile`. Additional-link JSON stores the same
canonical string representation.

Legacy reads remain deliberately transparent. `serialize_profile()` still
returns a pre-existing bare domain exactly as stored, and GET does not rewrite
the row. Passing that value into the canonical input schema produces the
canonical in-memory value, but no backfill or lazy write occurs in Stage 2.

Invalid import requests are transactional for this change because request-model
validation completes before `apply_profile_import()` executes. No new commit or
flush can occur for a rejected URL, and regression tests prove an existing
profile remains unchanged.

### Tests and executable invariant

`app/tests/test_profile_url_contract.py` covers:

- the complete direct-PUT valid/blank/invalid matrix;
- identical policy across all four named profile URLs;
- canonical scheme-less additional links and invalid additional-link rejection;
- import normalization across LinkedIn, GitHub, and portfolio, including the
  basic-info fallback source and blank import values;
- rejection-before-write for malformed/unsafe imports;
- DB string value and GET representation for both supported write paths;
- canonical-schema consumption of values produced by direct PUT and import;
- a direct-ORM legacy bare-domain row remaining visible and unchanged on GET.

The parity test also records a separate pre-existing contract mismatch:
signup/import may expose nullable `requires_sponsorship`, while `UserProfileIn`
takes a bool. It applies the same `Boolean(value)` canonicalization used by the
current frontend before checking the URL invariant; that unrelated legal-answer
model is not changed in this stage.

### Stage 2 validation

- Focused API URL/profile/import/parser suites: 119 passed.
- Ruff on every affected backend file: passed.
- `git diff --check`: passed.
- Full backend equivalent (`compileall` plus all 1,738 API pytest tests in the
  existing disposable API image): 1,735 passed, 2 skipped, 1 failed. Every
  profile, profile-import, and URL-contract test passed. The sole failure is the
  previously observed container-only DOCX download MIME mismatch in
  `test_resume_docx_export_is_clean`: without the Compose generated-files
  volume the endpoint returns its text fallback instead of a DOCX response.
  The source was mounted at the normal repository depth for this run, so the
  Stage 1 environment-example mount artifact did not recur.

### Rollout and rollback

Rollout requires no database migration. Deploying the API closes new writes at
both normal boundaries; monitor safe validation metadata (field/type only,
never submitted values) for import 422 changes. Existing rows are untouched.

Rollback is application-code-only: revert the shared type/schema/route changes.
Canonical strings written during Stage 2 remain valid under the prior contract
and require no data rollback. Do not roll back by weakening columns or editing
production rows.

### Deferred after Stage 2

- Stage 3 generic partial profile PATCH and focused-editor payload isolation.
- Audited dry-run plus reversible repair/backfill of legacy production rows.
- Frontend bare-domain normalization parity, field error mapping, and Retry UX.
- The analogous career-document coupling and inconsistent project/certification
  URL contracts identified in Stage 1.

## Stage 3: partial main-profile updates

### Architecture and API semantics

The main-profile API now has two deliberately different write contracts:

```text
PUT /profile
-> explicit full-document replacement
-> defaults for omitted fields participate in replacement
-> retained for the full Profile Wizard

PATCH /profile
-> focused partial update
-> only fields present in model_fields_set are serialized and mutated
-> used by focused main-profile section editors
```

`UserProfilePatch` subclasses `UserProfileIn`, so supplied values reuse the
same email, authorization, list, workplace, and Stage 2 URL validators. Its
route uses `model_dump(mode="json", exclude_unset=True)`; inherited defaults
therefore never become writes. Unknown fields are rejected. An empty object is
an intentional 200 no-op returning the current resource.

Omitted fields remain untouched. Explicit null clears fields whose canonical
input annotation permits null. Explicit `[]` clears a list. PATCH adds one
strict boundary around the full-input list compatibility validator: null is
rejected for lists, so a typo cannot become a destructive clear. Other
non-nullable scalar annotations, including bool and full name, reject null
through normal Pydantic validation.

Request-model validation completes before route execution. A mixed payload with
one valid preference and one unsafe URL therefore returns 422 before any ORM
mutation. The route commits once after applying all supplied values.

### Dependent-column behavior

Structured phone columns are recalculated only if raw phone or location country
is supplied, using the stored counterpart when only one source changes.
Application-email confirmation columns are recalculated only when application
email is supplied. These are derived columns of the edited field, not unrelated
profile resubmission.

PATCH responses use the existing manual `serialize_profile()` path, just like
GET and PUT. A successful preference PATCH can therefore return a legacy bare
URL or nullable sponsorship value without revalidating or rewriting it.

### Focused-editor ownership

`profilePatchForSection()` constructs each payload directly; it never creates a
full profile object and removes keys afterward.

- Personal Details: `application_email`, `phone`, `location_city`,
  `location_state`, `location_postal_code`, `location_country`,
  `work_authorization`, `linkedin_url`, `github_url`, `portfolio_url`, `x_url`,
  and `additional_links`.
- Job Preferences: `target_roles`, `target_levels`, `preferred_locations`, and
  `remote_preference`.
- Skills: `skills`.
- Links: `linkedin_url`, `github_url`, `portfolio_url`, `x_url`, and
  `additional_links`.
- Application Preferences: `work_authorization` and `open_to_relocation`.

Application Eligibility, demographics, and Workday credentials retain their
existing dedicated endpoints. Career-focused editors retain the current full
`PUT /profile/career` behavior and its known whole-document coupling. The full
Profile Wizard retains `profileToWire()` plus `PUT /profile` because it is the
explicit full-document onboarding/import editor.

Personal Details still performs PATCH for its owned main-profile fields and
then `PUT /profile/name` when confirmed first/last parts are present. This keeps
the structured-name confirmation invariant but leaves the pre-existing
two-request atomicity concern for later work.

### Isolation and compatibility guarantees

The executable production regression creates a row directly with
`portfolio_url = "cpandey.com"` and `requires_sponsorship = NULL`, then PATCHes
only Job Preferences. The request succeeds, preferences change, both legacy
values remain byte-for-byte unchanged, no unrelated column is rewritten, and
the response remains usable.

Explicitly PATCHing that same portfolio value invokes Stage 2 normalization and
stores `https://cpandey.com/`. An unsafe explicit replacement returns 422 and
preserves the legacy value. A stale-write regression first changes skills, then
PATCHes only target roles and proves the newer skills survive.

The nullable sponsorship inconsistency remains deferred. Its explicit PATCH
input stays a non-nullable bool, but an omitted stored NULL never participates
in PATCH validation and cannot block an unrelated update.

### Stage 3 tests

`app/tests/test_profile_patch.py` covers scalar/list updates, explicit empty
lists, nullable clears, non-nullable null rejection, multi-field updates,
legacy URL/sponsorship isolation, explicit legacy URL repair and rejection,
stale-field isolation, empty PATCH, unknown fields, mixed-payload atomicity,
authentication, and PUT canonical regression behavior.

Frontend tests prove every section ownership object, inspect the actual Job
Preferences request with a loaded legacy bare-domain URL, verify unrelated keys
are absent, and prove Retry invokes PATCH again. The Wizard regression remains
on PUT.

### Stage 3 validation

- Focused backend PATCH/profile/URL/import/auth suites: 99 passed.
- Focused frontend editor/form/Wizard suites: 119 passed.
- `make test-web`: passed ESLint, TypeScript, the production Next build, and all
  754 tests. JSDOM emitted its known navigation-not-implemented diagnostics;
  the command exited zero.
- Full backend equivalent (`compileall` and all 1,757 API pytest cases in the
  disposable API image): 1,754 passed, 2 skipped, 1 failed. The sole failure is
  the previously observed container-only DOCX MIME fallback in
  `test_resume_docx_export_is_clean`; all PATCH/profile/URL/import/auth tests
  passed. The literal host `make test-api` again hung at its virtualenv import
  check because of the known macOS File Provider issue.
- Ruff and ESLint on affected files: passed.
- `make test-extension`: typecheck and all 819 tests passed. The extension build
  then hung without output in both the combined gate and one standalone retry;
  both processes were stopped. No extension file changed in Stage 3.
- `docker compose config -q`: passed.
- `git diff --check`: passed, including explicit trailing-whitespace checks for
  the untracked Stage 2/3 files.

### Rollout and rollback

No migration or production-data mutation is required. Deploy API support before
or atomically with the web client so focused PATCH calls are accepted. Monitor
PATCH status/error metadata without submitted profile values. Rollback is an
application-code revert; PATCH writes are ordinary canonical values and need no
data rollback.

### Deferred after Stage 3

- Audited dry-run and reversible legacy profile-URL backfill.
- Stage 4 frontend normalization parity, structured errors, field messages, and
  retry/error UX.
- Career whole-document coupling and its project/certification URL contracts.
- Personal profile/name two-request atomicity.
- Canonical nullable-versus-boolean sponsorship-domain reconciliation.

## Stage 4: validation feedback and canonical client state

### Existing path and architecture decision

FastAPI already returns the required machine-readable 422 structure for both
`PUT /profile` and `PATCH /profile`: each Pydantic error contains a `loc` array,
message, and type. Import apply uses the same request-model validation boundary.
No backend error envelope or second validation framework was needed.

Before Stage 4, the shared web API client stringified a validation array into
`ApiError.message`. The Wizard reparsed that human-facing string locally, while
focused editors could show only a generic save-bar error. Focused PATCH success
also ignored the returned profile, leaving a scheme-less value in client state
even after the backend stored its canonical form.

Stage 4 moves response interpretation to the existing shared API boundary. An
`ApiError` now carries typed `fieldErrors` plus an optional `formError`; React
consumers do not inspect raw Pydantic payloads. No backend production route or
schema changed in this stage. A backend regression assertion records the
standard location contract exactly.

### Validation-error contract

For example, an invalid focused request remains standard FastAPI:

```json
{
  "detail": [
    {
      "loc": ["body", "portfolio_url"],
      "msg": "Value error, URL scheme is not permitted",
      "type": "value_error"
    }
  ]
}
```

The API client converts that to the UI-facing shape:

```json
{
  "fieldErrors": {
    "portfolio_url": "URL scheme is not permitted"
  }
}
```

Nested locations are preserved as stable paths such as
`additional_links.0.url`. Multiple errors remain independent. Body/model-level
errors become a form error; non-validation HTTP errors retain a concise server
message; malformed/non-JSON bodies safely fall back to the HTTP status rather
than exposing raw HTML.

Focused editors filter field errors through the exact keys owned by the current
PATCH payload, preventing errors from leaking onto another section. Editing a
field clears its own stale server error (including nested additional-link
paths). Successful save clears all errors associated with that request.

### Frontend URL normalization

`normalizeOptionalProfileUrl()` is intentionally small. It trims input, uses
the platform `URL` parser, prefixes `https://` only for plausible qualified
bare hosts, and canonicalizes supported HTTP(S) URLs. Empty/whitespace input
keeps the form's existing empty-string semantics. Examples:

```text
cpandey.com                 -> https://cpandey.com/
 github.com/cprakash        -> https://github.com/cprakash
https://example.com/foo     -> https://example.com/foo
""                          -> ""
```

Explicit unsupported schemes (`javascript:`, `data:`, `file:`, `ftp:`),
scheme-relative input, arbitrary single words, whitespace-containing values,
and malformed text are left visibly invalid and fail local checks or the
authoritative backend check. There is no large regular-expression URL parser.

Normalization occurs when constructing an intentional owner payload, never
while typing and never across unrelated loaded fields. It covers the four
actual named fields (`linkedin_url`, `github_url`, `portfolio_url`, `x_url`)
and each `additional_links[].url` for the Links/Personal owners and Wizard.

### Response synchronization and retry

Focused main-profile saves use the canonical `PATCH /profile` response as the
new local form and saved baseline. The existing account email is retained for
the client-only form field. Thus a user can type `cpandey.com`, save it, and see
`https://cpandey.com/`; dirty state clears only after success. Personal Details
still performs its documented name PUT after the profile PATCH and uses the
last successful canonical profile response.

An in-flight guard prevents duplicate concurrent section requests in addition
to the existing saving-state UI. On a 422, every owning field message is
rendered adjacent to its control with `aria-invalid` and `aria-describedby`;
unsaved input remains editable and the section remains unsaved. Editing the
affected value clears its stale message and Retry sends another PATCH. On a
network or server failure, the save bar shows a concise form-level error,
retains input, and offers the same retry path. Success adopts the response,
clears messages and dirty state, and preserves the existing success feedback.

### Wizard and import behavior

The full Profile Wizard remains an explicit `PUT /profile` consumer. It reuses
the shared typed errors, URL helper, accessible field rendering, and canonical
server response without a redesign. Its name endpoint remains unchanged.

Import apply also reuses `ApiError` rather than displaying a serialized
Pydantic array. When structured field errors are returned, it names the
affected imported fields in a concise review message; other failures retain a
safe form-level message. The import workflow and backend canonical contract are
otherwise unchanged.

### Regression coverage

- Shared API tests cover field and nested location extraction, message cleanup,
  simultaneous errors, model/form errors, non-validation errors, and malformed
  response fallback.
- URL-helper tests cover scheme-less, explicit HTTP/HTTPS, blank/whitespace,
  unsafe schemes, and malformed input.
- Focused-editor tests cover simultaneous named URL errors, nested additional
  link errors, unsaved-value retention, correction, PATCH retry, canonical
  response adoption, error clearing, and dirty-state clearing.
- Ownership regressions still prove a Job Preferences PATCH contains exactly
  its four fields and neither normalizes nor rewrites a loaded legacy URL.
- Wizard tests prove profile submission remains PUT and adopts canonical URL
  output.
- Backend tests prove standard 422 locations for one and multiple URL fields
  and rejection without mutation.

### Stage 4 validation

- Focused web validation/error/URL/editor/form/Wizard/preferences suites: 140
  passed.
- Focused backend PATCH/profile/URL/import suites: 94 passed.
- `make test-web`: ESLint, TypeScript, production Next.js build, and all 775
  tests passed. JSDOM emitted its known navigation-not-implemented diagnostics;
  the command exited zero.
- Ruff on the affected backend test: passed.
- Full backend suite in the disposable API image: 1,754 passed, 2 skipped, 2
  failed out of 1,758. One failure is the previously observed container-only
  DOCX MIME fallback. The other was the known shallow-mount `.env.example` path
  artifact; its exact test passed when rerun with the repository mounted at its
  normal depth. Neither failure touches profile code, and all Stage 2--4
  profile suites passed.
- `docker compose config -q`: passed.
- `git diff --check`: passed in final repository verification.

No Alembic migration applies: Stage 4 changes no storage contract. The
extension gate is not rerun because Stage 4 explicitly excludes extension work
and no extension file changed; the immediately preceding Stage 3 gate already
had green typecheck and 819 tests, with only its documented environment/build
hang.

### Rollout, rollback, and deferred work

Deploy the API and web changes together or API-first as already required by
Stage 3. Monitor status, field name, and validation type only; never log entered
profile values. Rollback is application-code-only and needs neither a database
migration nor data rollback.

Deferred work remains unchanged: audited legacy-data backfill, career
whole-document coupling and project/certification URL contracts, Personal
Details/name transactional redesign, sponsorship-domain reconciliation, and
broad import or profile UI redesign.

## Stage 5: legacy profile-URL backfill utility

### Existing patterns and architecture

The profile table has exactly four scalar URL columns governed by Stage 2:
`linkedin_url`, `github_url`, `portfolio_url`, and `x_url`. Its
`additional_links` column is JSON/JSONB and normally contains an ordered list of
objects with required `label` and `url` properties. Other keys may exist and
must survive maintenance unchanged.

Existing maintenance commands use `argparse`, `SessionLocal`, explicit apply
flags, concise count-oriented output, and nonzero exit status for execution
failure. Runtime data belongs under `generated/`, which is already gitignored.
Application configuration exposes `APP_ENV` and `DATABASE_URL`; database URLs
must be rendered without credentials. There was no generic safe-update or
rollback-manifest abstraction suitable for this job.

Stage 5 adds one standalone command:

```text
python -m app.maintenance.profile_url_backfill
```

It is not imported by the web application, startup, Alembic, deployment, or a
scheduler. It selects only the profile primary key and five in-scope URL
columns, so unrelated legacy values such as nullable sponsorship never enter a
Pydantic profile model and cannot block the audit.

### Scope and authoritative classification

Each scalar and nested URL is evaluated independently through the existing
`OptionalProfileUrl` or `ProfileUrl` Pydantic type from
`app.profile.urls`. The utility contains no second URL parser or regex policy.
Classifications are:

- `already_canonical`: the stored value exactly equals Stage 2 serialization;
  nullable named URLs already set to NULL are included here.
- `safely_normalizable`: Stage 2 accepts the value but serializes it
  differently, such as `cpandey.com` to `https://cpandey.com/`.
- `empty_to_null`: a blank optional named URL maps to NULL.
- `invalid_manual_review`: Stage 2 rejects unsafe or malformed input. It is
  reported and never rewritten or deleted.
- `unexpected_storage_shape`: a scalar is not string/NULL, or
  `additional_links` is not a valid bounded list of labeled objects with string
  URL values. The complete JSON column remains unchanged.

An additional-link URL is required by `AdditionalLinkIn`; therefore a blank
nested URL is manual review, not a conversion to nested NULL. When a structurally
valid list mixes safe and unsafe URLs, safe URLs may be normalized atomically
while unsafe siblings remain value-equivalent JSON values and are
reported. Ordering, labels, IDs, metadata, and unrelated keys are preserved by
copying the stored structure and replacing only the safe `url` properties.

Nothing touches identity, phone, authorization/sponsorship, preferences,
skills, demographics, application-email state, career data, credentials, or
any timestamp except the ORM's ordinary `updated_at` metadata for a successful
profile-row update.

### Dry-run, APPLY, and reporting

No flag means DRY RUN. `--dry-run` is available for explicit automation, and
`--apply` is the only flag that enables writes. Startup JSON states `DRY RUN`,
`APPLY`, `ROLLBACK DRY RUN`, or `ROLLBACK APPLY` and includes `APP_ENV` plus a
credential-free database identity. `--apply` and `--dry-run` are mutually
exclusive, batch size must be positive, and an existing manifest is never
overwritten.

The final safe summary includes profiles scanned, URL values inspected, all
five classification counts, applied mutations, concurrent conflicts, update
failures, and per-column breakdowns. Manual-review and conflict samples contain
only profile IDs and field paths; stored URL values never enter console output.
Manual-review findings and compare-and-set conflicts are successful audit
outcomes (exit 0). Invalid CLI usage exits 2 through `argparse`; database,
manifest, or execution failure exits 1.

### Optimistic concurrency and transaction model

Profiles are scanned by ascending primary-key keyset pagination with a bounded
default batch of 100. The tool never loads the entire profile table. For each
profile, all proposed URL-column changes are issued as one SQL UPDATE whose
WHERE clause compares every targeted column with its exact audited old value.
`additional_links` compares the entire old JSON value. If any target changed
after the read, row count is zero and every proposal for that profile is a
reported conflict; a newer user edit is never overwritten. Unrelated columns
are absent from both SET and comparison clauses.

Each batch is a transaction. Classifying one bad value cannot abort the batch;
it creates a manual-review result. SQL/database failures roll back the whole
current batch, remain visible as execution failures, and leave earlier
committed batches described by the manifest. Rerunning is safe because
canonical values are no-ops and every mutation is compare-and-set guarded.

### Private rollback manifest and interruption behavior

APPLY creates a new JSON manifest at an explicit path or, by default, under:

```text
generated/maintenance/profile-url-backfill-<UTC>-<pid>.json
```

`generated/` is gitignored. Directories are restricted to mode `0700` and the
manifest to `0600` where supported. The file contains sensitive old/new values
only because exact restoration requires them; those values are never printed.
Each committed profile record contains its profile ID and column changes. A
scalar change records its exact old/new values and path. An additional-links
change records the exact complete old/new JSON values plus the nested URL paths
actually normalized.

Before a batch commit, proposed successful compare-and-set records are durably
written with state `prepared`. After commit they become `committed`. A failed
commit removes its prepared records from the failed manifest. If interruption
occurs in the narrow post-commit artifact window, the prepared record retains
the exact recovery data; rollback treats both prepared and committed records
with the same database compare-and-set safety. A completed manifest contains
only committed records. Artifact write failure before commit rolls back the
database transaction, and an existing artifact is never truncated.

### Rollback behavior

Rollback is also dry-run by default:

```text
python -m app.maintenance.profile_url_backfill --rollback <manifest>
```

Mutation requires the additional explicit `--apply`. For every record, rollback
restores the exact old scalar or JSON value only when every current targeted
column still equals the manifest's new value. Missing profiles are reported.
Values already equal to the old state are idempotent `already_restored` results.
Any different current value is a conflict and remains untouched, including a
new URL saved by the user after backfill. Rollback uses the same bounded batch
transactions and never updates unrelated columns.

### Idempotence and executable coverage

After a successful APPLY, a second audit proposes no mutation for those values.
Invalid/manual-review values remain visible until separately resolved. Focused
tests cover default dry-run, safe apply, restrictive manifest permissions,
canonical and blank values, all specified unsafe schemes/malformed text,
nullable sponsorship isolation, multiple scalar fields, JSON ordering and
metadata preservation, malformed JSON shapes, idempotence, online-edit
conflicts, exact scalar and nested rollback, rollback conflict/missing rows,
artifact failure before commit, recovery data after a post-commit artifact
failure, and refusal to overwrite an existing manifest.

### Stage 5 validation

- New Stage 5 backfill suite: 27 passed.
- Combined Stage 2--5 profile/backfill/PATCH/URL/import suite: 121 passed.
- Ruff on the command and its tests: passed.
- CLI help/import smoke test: passed.
- Default manifest path verified as ignored by the repository's `generated/`
  rule.
- Full backend suite from the repository's normal container mount depth: 1,782
  passed, 2 skipped, and 1 failed out of 1,785. The sole failure is the same
  pre-existing container-only DOCX MIME fallback in
  `test_resume_docx_export_is_clean`. The earlier shallow-mount `.env.example`
  failure did not recur, and every Stage 2--5 profile test passed.
- `docker compose config -q`: passed.
- `git diff --check` plus explicit trailing-whitespace inspection of every
  cumulative untracked Stage 2--5 file: passed.

No Alembic validation applies because Stage 5 adds no schema or data migration.
The online PUT, PATCH, and import implementations are unchanged by Stage 5.

### Prepared production runbook (do not execute in Stage 5)

Run from the deployed release's `apps/api` directory using its normal secured
runtime identity. Replace `/secure/operations/...` with an encrypted,
access-controlled path outside the source checkout.

1. Confirm the deployed version contains Stages 2--5 and record its commit SHA.
2. Confirm a restorable database snapshot and record its backup identifier.
3. Audit only:

   ```bash
   python -m app.maintenance.profile_url_backfill --dry-run --batch-size 100
   ```

4. Review aggregate and per-field counts plus ID/path-only manual-review items.
   Resolve every unexpected-storage-shape finding before APPLY.
5. Apply with a new private manifest path:

   ```bash
   python -m app.maintenance.profile_url_backfill --apply --batch-size 100 \
     --manifest /secure/operations/profile-url-backfill-YYYYMMDD.json
   ```

6. Confirm exit 0, manifest mode `0600`, status `complete`, applied/conflict
   counts, and secure transfer into the restricted operations vault.
7. Audit again with the dry-run command. Confirm zero
   `safely_normalizable` and zero `empty_to_null` findings except proposals
   explicitly blocked for manual remediation; review conflicts individually.
8. Run targeted authenticated GET/PATCH profile and import smoke tests without
   submitting unrelated fields.
9. Retain the encrypted rollback artifact with access logging for 30 days after
   verification, or longer if the organization's incident-retention policy
   requires it; then securely destroy the operational copy.
10. If rollback is required, audit it first:

    ```bash
    python -m app.maintenance.profile_url_backfill \
      --rollback /secure/operations/profile-url-backfill-YYYYMMDD.json
    ```

    Review missing/conflict counts, then explicitly apply:

    ```bash
    python -m app.maintenance.profile_url_backfill \
      --rollback /secure/operations/profile-url-backfill-YYYYMMDD.json --apply
    ```

    Run another dry-run and application smoke test. Never force rollback
    conflicts; they represent newer user values.

### Rollout, rollback, and deferred work

Stage 5 is mechanism-only: no production database was contacted, no APPLY or
rollback command was run against a shared environment, and nothing is deployed
or scheduled. A future human-controlled production operation must follow the
runbook above.

Deferred work remains career-document partial updates, project/certification
URL contracts, Personal Details/name transactionality, sponsorship NULL/bool
reconciliation, broad import redesign, extension work, and deployment or
production execution.
