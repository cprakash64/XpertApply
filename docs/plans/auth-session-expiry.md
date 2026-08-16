# Authentication session-expiry handling

Status: implementation and validation complete; review required before commit,
push, or deployment.

## Incident and objective

Production can retain a stale JWT in `localStorage` and render the protected
application shell even after the API rejects that token with HTTP 401. Dashboard
then falls into its ordinary load-error UI and Settings renders the backend's
`Invalid token` detail. The fix must invalidate the client session centrally,
remove protected content, and replace-navigate to the canonical login page while
preserving a safe internal return path.

## Confirmed architecture

- `/login` and `/signup` render the shared `AuthDialog` and call
  `/auth/login` or `/auth/signup`.
- The API returns one JWT access token. The browser stores it under the legacy,
  compatibility-sensitive `jobpilot_token` localStorage key.
- `lib/api.ts` reads that token for every request and attaches a Bearer header.
- There is no refresh token, refresh endpoint, cookie session, auth provider,
  middleware, or server-side web guard.
- Protected pages use `AppShell`, but before this repair `AppShell` was visual
  chrome only and rendered without checking auth state.
- Logout had no user-facing control. Account deletion removed only the token
  directly; there is no server logout/revocation endpoint.
- Backend `get_current_user` returns 401 for missing, malformed, expired, or
  unknown-user access tokens. Application-session authorization checks use 403.

## Root cause

The shared API client classified both 401 and 403 as `auth_expired`, but only
threw `ApiError`; it never cleared the stored token or initiated navigation.
Pages therefore handled a genuine authentication failure like any local data
failure. Separately, protected routes treated the existence of UI chrome as an
auth boundary even though no boundary existed.

## Architecture decision

1. Add a small session module that owns token writes/removal, conservative JWT
   expiry detection, safe internal return-path validation, cache cleanup hooks,
   and one idempotent invalidation event.
2. Make the shared API client react only to protected HTTP 401 responses. It
   must not invalidate on 403, 422, 5xx, cancellation, or network failure, and
   login/signup requests must neither attach stale auth nor trigger redirects.
3. Turn `AppShell` into the shared protected-route boundary. It renders no shell
   while resolving local auth, rejects missing/obviously expired JWTs, listens
   for central invalidation, and uses replacement navigation.
4. Reuse the same cleanup for explicit logout and account deletion.
5. Do not add refresh behavior: the repository has no refresh-token contract.

## Privacy and security decisions

- Never log tokens or Authorization headers.
- Return targets must be relative paths in the known protected-route set;
  absolute URLs, protocol-relative URLs, backslashes, and auth/public routes
  are rejected.
- The server remains authoritative. Client JWT inspection only rejects an
  obviously expired or malformed JWT-shaped token; it does not validate a
  signature or replace the API's 401 decision.
- Auth invalidation purges registered in-memory user caches and removes only the
  auth token. It does not clear unrelated browser preferences.

## Validation plan

- Shared client: 401 cleanup/redirect event, parallel-401 coordination, and
  isolation for 403/422/500/network failure.
- Guard: missing auth, expired JWT, valid auth, deep-link return, public auth
  usability, and explicit logout.
- Dashboard and Settings: 401 exits protected UI; non-auth failures retain local
  retry/error behavior.
- Existing profile validation suites: 422 field errors remain intact.
- Backend auth tests: missing, malformed, and expired tokens remain 401.
- Run focused tests, full web tests, typecheck, lint, production build,
  `make test-web`, and `git diff --check` as practical.

## Rollout and rollback

No deployment is authorized in this stage. After review, deploy the web/API
artifact through the established deterministic production workflow. Smoke-test
an expired protected deep link, login return, 403 isolation, profile 422 UX,
logout, and public routes. Roll back by redeploying the prior reviewed SHA; no
database schema or data migration is involved.

## Progress

- [x] Trace login, storage, API attachment, backend semantics, and protected routes.
- [x] Reproduce the stale-session behavior from the current code path.
- [x] Implement centralized invalidation and route guarding.
- [x] Add regression coverage.
- [x] Complete validation and review-ready report.

## Validation results

- Focused auth/protected-route/Dashboard/Settings/profile suites: 110 tests passed.
- Complete web suite: 42 files, 797 tests passed.
- Focused backend auth semantics: 8 tests passed in an isolated local API container.
- Playwright against the newly built local artifact: 2 tests passed.
- Web lint, TypeScript typecheck, and optimized production build: passed.
- Extension typecheck, 56-file/819-test suite, and build: passed.
- Docker Compose configuration and `git diff --check`: passed.
- The host Python environment stalled while loading a conftest through a stale
  File Provider path. The full API suite was also started in an isolated
  container, but stopped after sustained slow progress through unrelated
  integration tests; no failure was reported before it was stopped. No backend
  runtime code changed in this stage.
