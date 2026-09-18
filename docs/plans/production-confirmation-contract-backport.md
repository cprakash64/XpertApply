# Production confirmation-contract backport

## Architecture and scope

Backport only the two submission-confirmation timestamps, their tracker lifecycle,
the two session-authenticated POST routes, and session response projection. The
Store extension, web client, dependencies, and broader application-memory schema
remain unchanged.

## Decisions

- Base the work on production commit `d9d1fc6520d0013ff89233173073834f724d562f`.
- Use revision `0032_confirmation_contract`, directly after
  `0031_publications`; recovery's `0032_application_memory` is broader and is not
  production-compatible for this minimal hotfix.
- A future integration with recovery will reconcile the divergent children of
  `0031_publications` with an Alembic merge/reconciliation revision.
- Preserve recovery semantics: requiring overwrites the required timestamp and
  clears dismissal; dismissal only timestamps an existing requirement; genuine
  submission clears the requirement.

## Progress

- [x] Source, Store, production-ref, and collision preflight
- [x] Recovery route/lifecycle/model/migration analysis
- [x] Minimal implementation
- [x] Focused and regression tests
- [x] PostgreSQL 16 migration qualification
- [x] Production-shape image and disposable integration
- [x] Final diff and protected-worktree verification

## Validation

Record exact commands and outcomes in the final report. Required checks include
upgrade/downgrade/re-upgrade from `0031_publications`, focused confirmation/auth/
serialization/OpenAPI tests, NEW-06/NEW-07/JWT regressions, two full API runs,
lint/static checks, image build, and disposable PostgreSQL 16 integration.

## Rollout and rollback

This stage performs no deployment. A later deployment must apply the migration
before serving the new code. Roll back code first, then downgrade to
`0031_publications`; the downgrade removes only the two nullable timestamp
columns. Existing tracker rows require no backfill and receive NULL values.
