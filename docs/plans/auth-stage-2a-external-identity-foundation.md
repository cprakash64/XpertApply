# AUTH-2A external identity foundation

## Scope

Provider-neutral identity persistence, nullable-password compatibility,
transactional creation/linking primitives, privacy/deletion integration, and a
single reversible migration. Google/Apple protocol endpoints, provider calls,
UI, extension changes, Store work, deployment, and production access are out of
scope.

## Baseline and migration graph

- Worktree: `/Users/cprakash/Developer/XpertApply-auth-evolution`
- Branch/start: `feature/auth-evolution` at
  `ffa69df477da09dc6bddf32e16fd07bb759244ef`
- Remote matched the same checkpoint; worktree was clean.
- `alembic heads`: one head, `0033_snapshot_provenance`.
- `alembic branches`: none.
- `alembic history`: one linear chain from `0001_initial` through
  `0033_snapshot_provenance`.
- AUTH-2A revision/down-revision: `0034_external_identities` /
  `0033_snapshot_provenance`.

## Existing identity conventions

`User.id` is an integer primary key. `User.email` is `VARCHAR(320)`, non-null,
indexed, and unique; signup trims through Pydantic `EmailStr` and lowercases for
lookup/storage. `User.hashed_password` is `VARCHAR(255)` and was non-null.
Timestamps use timezone-aware `DateTime` with database `now()` defaults. Owned
rows use integer `user_id` foreign keys with database `ON DELETE CASCADE`.
Signup creates `User` and `UserProfile` in one transaction; password login uses
`verify_password`; HS256 JWTs use the integer user ID rendered as `sub`.

Account deletion directly deletes `users`, relying on database cascades. The
privacy export includes explicit safe categories and excludes password hashes,
credential ciphertext, and storage paths.

## Decisions

- `external_identities` uses a string provider, stable provider subject,
  optional observed provider email/display name, verification flag, and normal
  timestamps. It stores no OAuth tokens, codes, payloads, state, or secrets.
- Unique `(provider, subject)` makes provider subject authoritative globally.
  Unique `(user_id, provider)` permits Google and Apple on one account but only
  one identity from each provider.
- Provider identifiers are canonicalized and validated in application code;
  the table remains provider-neutral and avoids a database enum.
- `users.hashed_password` becomes nullable. Password signup still always hashes
  a real password. Login treats a null hash exactly like any invalid credential
  and never calls the verifier with a null/sentinel value.
- `users.email` remains non-null because the broader product and public schema
  treat it as the account address. A new provider-only user therefore requires
  a verified provider email. A known provider subject can still resolve without
  a fresh email claim. Relay addresses are ordinary valid account emails.
- Same-email collision never links or creates a duplicate; it returns the typed
  `EMAIL_LINK_REQUIRED` outcome for AUTH-2B.
- Domain operations flush inside a savepoint but do not commit. The route/use
  case owns the outer commit, so user/profile/identity remain one transaction.
  Database constraints are the final concurrency defense, and an insert race is
  re-resolved to the winning subject or a typed collision.
- Explicit linking takes an already-authenticated target user ID and an already-
  verified provider identity. AUTH-2B must add recent reauthentication policy;
  AUTH-2A deliberately exposes no public linking route.
- Privacy export includes safe linked-provider metadata but not stable provider
  subjects. User deletion cascades identities.

## Downgrade safety

Downgrade first checks for any user with a null password hash. If one exists it
raises and refuses before dropping identity data or restoring `NOT NULL`.
No fake hash or credential is manufactured. With no provider-only users, it
drops `external_identities` and restores password non-nullability.

## Plan and progress

- [x] Verify checkpoint and audit user/auth/privacy/deletion conventions.
- [x] Prove one linear Alembic head and choose the actual down-revision.
- [x] Add model, migration, provider-neutral service, and minimal integrations.
- [x] Add the required focused model/service/migration/privacy/auth tests.
- [x] Rehearse upgrade/preservation/downgrade on a disposable database.
- [x] Run full API, web, extension, static, build, Compose, and diff gates.
- [x] Create one local checkpoint commit; do not push.

The migration rehearsal uses an isolated SQLite database representing the
`0033` user schema because the historical `0001` migration embeds PostgreSQL
`JSONB` and cannot be replayed on SQLite. It stamps `0033`, seeds representative
password users, upgrades to `0034`, checks exact IDs/emails/password hashes and
zero identity rows, creates a provider-only account, proves downgrade refusal,
removes that disposable fixture, then proves successful downgrade and restored
password non-nullability. A local PostgreSQL rehearsal was attempted, but the
host's Docker Desktop installation requires an interactive privileged setup and
did not expose its engine; no persistent database resource was created.

Qualification evidence (2026-09-23): focused AUTH-2A selection 37 passed;
complete API suite 2,069 passed and 12 skipped; Web 934 passed; Extension 1,184
passed on the clean standalone rerun; API Ruff/compileall, Web lint/typecheck/
production build, Extension typecheck/build, Docker Compose config, Alembic
single-head checks, and `git diff --check` passed. The first Extension run had
one post-suite timer-cleanup exception despite all assertions passing; the
standalone rerun exited successfully. Warnings are existing dependency/test
diagnostics (FastAPI/httpx, AnyIO, `crypt`, ReportLab, short test JWT secrets,
and jsdom navigation). Ruff findings in older applied migrations are baseline
issues; the application tree and new migration pass.

## AUTH-2B plan

AUTH-2B will add backend-mediated Google OIDC authorization-code flow with PKCE
S256, one-time state, nonce, exact callback URI, and server-side signature,
issuer, audience, expiry, nonce, and verified-email validation. It will request
only `openid email profile`, key identities by Google `sub`, issue the existing
XpertApply JWT, and preserve the website-mediated extension handoff. It will not
use implicit flow, offline access, Google API scopes, or `chrome.identity`.

This follows Google's current server-side OIDC guidance: use an authorization
code returned to an exact registered redirect URI, validate anti-forgery
`state`, use `nonce` for replay protection, and validate the ID token before
using its stable `sub`. Google documents PKCE `code_challenge` validation for
the authorization-code exchange. References:

- https://developers.google.com/identity/openid-connect/openid-connect
- https://developers.google.com/identity/openid-connect/reference
- https://developers.google.com/identity/protocols/oauth2/web-server

The callback concept is an API-owned HTTPS route, tentatively
`https://api.xpertapply.com/auth/google/callback`; AUTH-2B must confirm the
actual router prefix and register that exact value before implementation.

Owner setup after callback design is final: Google Cloud project and consent
branding, authorized domain(s), Web application OAuth client, exact production
and test/local redirect URIs, and backend-secret-store injection of the client
ID/secret. No credential belongs in source or the extension.

## Rollout and rollback

This stage is local only. A future rollout runs the reviewed migration before
AUTH-2B code begins creating provider-only users. Before such users exist,
downgrade is fully reversible. After they exist, downgrade intentionally refuses
until identity-capable application code/data are handled by a separately
approved rollback plan.
