# Production Google-auth release P2B

## Objective

Compose the smallest production release that adds the qualified Google OIDC,
external-identity, account-linking, password-auth compatibility, logging, and
Web UX behavior on top of the exact deployed production source and the P2A
production-lineage migration.

## Architecture and exclusions

- Port auth-owned modules and symbol-level shared-file changes from qualified
  checkpoint `e15fc04d77d3dbfd4da51140a31dd9179c50d320`.
- Preserve the production confirmation-contract runtime and the single Alembic
  head `0033_prod_auth_identities`.
- Reuse production-base PyJWT, Redis, HTTPX, password, session, readiness, and
  dependency versions; add no package dependency unless validation proves one
  missing.
- Keep Google disabled by default and require complete HTTPS configuration in
  production before it can be enabled.
- Exclude development migrations `0032_application_memory`,
  `0033_snapshot_provenance`, and `0034_external_identities`; exclude snapshot,
  retention, provenance, extension, Store, Apple, and unrelated UI/runtime work.

## Progress

- [x] Verify both worktrees and preserve P2A artifacts.
- [x] Inventory all named auth checkpoints and dependency prerequisites.
- [x] Port auth-specific API, Web, configuration, logging, and tests narrowly.
- [x] Prove no application-memory dependency in changed runtime code.
- [x] Run focused and complete regression/static/build/audit gates.
- [x] Qualify an isolated PostgreSQL 16.14 full stack with Google disabled.
- [x] Prepare safe local real-Google composition smoke without exposing secrets.
- [x] Record validation, rollout, privacy, and rollback evidence.

## Validation

Validation must cover focused API/Web auth behavior, the full repository gates,
one Alembic head, PostgreSQL 16.14 migration/runtime compatibility, disabled
provider discovery, password signup/login, readiness, confirmation-contract
behavior, absence of SQL references to undeployed schema, access-log query
removal, dependency audit, and at least one owner-assisted real Google round
trip on this exact composition.

## Rollout and rollback

P2B is local-only. A later stage must migrate first, roll all API replicas,
verify readiness, publish the reviewed privacy disclosure, and only then enable
Google OAuth. OAuth must remain disabled while any old API replica can encounter
provider-only users. Database downgrade remains forbidden once identity rows or
null-password users exist.

## Privacy impact inventory

The production policy must identify Google as an authentication provider and
disclose retained provider, subject, observed provider email, verification flag,
and optional display name. Google authorization codes and access, refresh, and
ID tokens are not retained after the transaction. Applicable Google privacy
information must be linked. Publication is deferred to P3.

## Validation evidence

### Static, focused, and full regression gates

- Ruff/compile checks for the auth-related Python delta passed.
- Focused API auth, external-identity, Google, logging, configuration, privacy,
  and serialization tests: 126 passed.
- Focused Web auth tests: 43 passed.
- Full API: 1,933 passed, 4 skipped (the four isolated P2A PostgreSQL tests are
  covered by the separate P2A gate), with 1,173 warnings.
- Full Web: 49 files and 975 tests passed; lint, typecheck, and production build
  passed. The build contains `/auth/google/callback`.
- Full Extension: 56 files and 819 tests passed; typecheck and build passed.
- Web and Extension `npm audit --omit=dev`: zero vulnerabilities in each.
  No established Python audit command or installed `pip-audit` executable is
  present in this production base.
- API and Web production container images built successfully. The isolated
  Compose configurations validated successfully.

### Composition and schema gates

- Release migration tree has one head: `0033_prod_auth_identities`.
- A new isolated `postgres:16.14` volume was migrated to
  `0032_confirmation_contract`, populated with a synthetic bcrypt password user,
  job, tracker, and both confirmation timestamps, then upgraded to `0033`.
- The password hash remained non-null and both confirmation timestamps remained
  unchanged. `external_identities` exists after upgrade.
- `/healthz` and `/readyz` passed with database, Redis, current/head revision,
  critical-table, and schema-current checks healthy.
- With Google disabled, `/auth/providers` reported `enabled: false`; the Web
  served successfully; existing password login and new signup passed; a
  9-character signup password returned 422; wrong-password and unknown-user
  login returned byte-identical generic 401 bodies; the pre-existing tracker
  remained readable.
- Before the real smoke, invariants were: 2 synthetic users, 0 external
  identities, 0 null-password users, 1 preserved confirmation row, and Redis
  DB size 0.
- An OAuth callback request containing sentinel `code` and `state` values
  produced an access log containing only the path; neither query value appeared.
- Runtime logs contained no missing-schema SQL error and no reference to
  application snapshots, snapshot provenance, retention-only columns, or the
  other explicitly excluded schema.
- Static exclusion searches across the auth runtime found none of the forbidden
  application-memory symbols.

### Owner-assisted real Google smoke handoff

- The exact release API/Web images are running locally on the callback ports
  registered by the existing local OAuth client: API `localhost:8000`, Web
  `localhost:3000`.
- Provider discovery reports Google enabled and readiness remains healthy.
- The existing auth-reference `.env` remains mode 600 and is consumed directly
  as an external Compose `env_file`; its client secret was neither printed,
  copied into the release worktree, nor committed.
- The isolated P2B PostgreSQL 16.14 volume is retained. The prior auth-acceptance
  API/Web containers were stopped only to release ports; its database and Redis
  were not reused and remain intact.
- Owner-assisted real-browser acceptance completed on the exact release images:
  one first-time Google sign-in followed by one returning Google sign-in. Both
  reached the dashboard. API logs contain two successful start (303), callback
  (303), and completion (200) cycles.
- After the returning flow the database contains 3 total users, exactly 1 Google
  external identity, exactly 1 Google provider-only user, no duplicate
  `(provider, subject)` pair, and no duplicate `(user_id, provider)` pair. The
  original confirmation row remains intact.
- Redis returned to DB size 0 after one-time records were consumed/expired. The
  final API log contains no OAuth query values, provider-token field names,
  provider error descriptions, missing-schema errors, or excluded
  application-memory schema references.
