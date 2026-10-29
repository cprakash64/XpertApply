# Password recovery and auth UX finalization (PUI-AUTH-FINAL)

Living plan. Branch `feature/premium-ui-overhaul`. Status: implemented and verified locally; **not deployed**.

## Audit (before any change)
- Backend had signup/login/me and Google OIDC only. **No** reset endpoints, **no** reset-token storage, **no** outbound email integration (no SMTP/provider code anywhere), **no** rate limiting on auth routes, and **no** way to revoke a login token (stateless HS256 JWT with only `sub`/`exp`).
- Passwords: bcrypt via passlib; signup policy 10-128 characters.
- So recovery could not be "connected"; it was built, end to end, in the existing architecture.

## Architecture
- `app/core/email.py`: one small interface, real backends: `smtp` (stdlib, STARTTLS/SSL, optional auth), `outbox` (`.eml` files, dev/test only, refused in production) and `disabled` (default). No new dependency.
- `app/services/password_reset.py`: 256-bit `secrets.token_urlsafe(32)` token, SHA-256 stored, 30-minute TTL (`PASSWORD_RESET_TOKEN_TTL_MINUTES`), single use, new request supersedes the old token, per-recipient (3/h) and per-client (30/h) in-process limits plus a per-user DB cap that holds across workers.
- Routes (`app/routes/auth.py`): `GET /auth/password-reset/availability`, `POST /request` (202, identical for known/unknown/provider-only accounts; email sent in a background task so neither body nor timing tells), `POST /verify` (read-only, never consumes), `POST /confirm` (atomic single-use claim; no auto-login).
- Link: `{WEB_BASE_URL}/reset-password#token=...`: the origin is configuration (never the Host header) and the token is in the URL **fragment** (not sent to servers, logs or Referer). The page strips it from the address bar immediately and keeps it in memory only. `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `noindex` on both pages.
- Provider-only accounts (no local password) never get a reset token or a local password: they get a note pointing at "Continue with Google".
- Session revocation: access tokens now carry a fractional `iat`; `users.password_changed_at` (migration `0034_password_reset`) is set on reset and `get_current_user` and the application-session check refuse earlier tokens. Users who never reset keep working tokens. Extension session tokens (<= 30 minutes, scoped) are separate and are not revoked.
- Production validation (`config_validation._check_email_recovery`): once `EMAIL_BACKEND` is not `disabled`, requires `smtp`, a host, starttls/ssl, a real sender, and an https `WEB_BASE_URL` origin with no path and not localhost. With email disabled, recovery reports itself unavailable and the UI says so.

## Frontend
- Login and signup: removed "Private by default. You stay in control.", its lock icon and divider. Login gained "Forgot password?" (right of the Password label). The login/signup switch is now a real link on the page routes (keeps a safe `?next=`); the modal keeps its in-place switch. The logo links to `/`.
- New public, always-light pages `/forgot-password` and `/reset-password` (same card geometry, no decoration). Public route classification needed no change: anything outside `THEMED_ROUTE_PREFIXES` is light; both pages export the light viewport. Tests cover them.

## Configuration (no secrets in git)
`EMAIL_BACKEND`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` (secret store), `SMTP_SECURITY`, `WEB_BASE_URL`, `PASSWORD_RESET_*` (see `.env.example`).

## Validation commands
- API: `cd apps/api && env APP_ENV=test DEBUG=false python -m pytest` (recovery: `app/tests/test_password_reset.py`).
- Migration: `alembic upgrade head`, `alembic downgrade -1`, `alembic upgrade head` on PostgreSQL (done on an ephemeral `postgres:16-alpine`).
- Web: `make test-web`; Playwright `e2e/password-recovery.spec.ts` and `e2e/public-light.spec.ts`.
- Live, nothing mocked: `scripts/auth-recovery-e2e/live.mjs` (real browser, real build, real API, PostgreSQL, SMTP to `sink.py`). Setup: start Postgres and `alembic upgrade head`; run `python scripts/auth-recovery-e2e/sink.py <workdir>/mail`; run the API with `EMAIL_BACKEND=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_SECURITY=none WEB_BASE_URL=<web origin>` and log to `<workdir>/api.log`; build and serve the web app against that API; `node scripts/auth-recovery-e2e/live.mjs <workdir> <screenshots>`.

## Rollout
1. Apply migration 0034 (additive: one nullable column, one table). 2. Configure a real SMTP relay and `WEB_BASE_URL` (https). 3. Deploy API, then web. Until email is configured the feature reports itself unavailable; login/signup are unaffected.

## Rollback
Disable by `EMAIL_BACKEND=disabled` (pages then say recovery is unavailable). Code rollback is a normal redeploy of the previous images; `alembic downgrade -1` drops the table and the column (reset tokens are disposable; `password_changed_at` is lost, which only means pre-reset tokens would be honoured again).

## Open items / blockers
- **Real email delivery to a mailbox is NOT verified**: no SMTP relay, credentials, or sender-domain authentication (SPF/DKIM/DMARC) exist in this repository or environment. The SMTP client was verified against a local sink only.
- Per-client limiting keys on the peer address; behind the nginx proxy that is the proxy address unless uvicorn trusts `X-Forwarded-For` (not configured), so it acts as a shared cap. The per-recipient cap is the effective abuse control.
- Rate-limit buckets are per process (the DB cap is shared). A Redis-backed limiter would be a later hardening.
- Extension session tokens are not revoked by a reset (short-lived, scoped).

## Resend SMTP integration (2026-10-28)

- No backend change was required: `EMAIL_BACKEND=smtp`, `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`,
  `SMTP_SECURITY=ssl` (implicit TLS via `smtplib.SMTP_SSL`, default verifying context), `SMTP_USERNAME=resend`,
  `SMTP_PASSWORD=<Resend API key>`, `EMAIL_FROM`, `WEB_BASE_URL` were already supported and production-validated.
- Compose already passes them: the `api` (and `worker`, `scheduler`) services load `.env` through `env_file`.
- Added tests: implicit TLS with a trusted test certificate (AUTH PLAIN as `resend`, delivery, reset link origin) and
  refusal of an untrusted certificate (nothing sent, request still answers generically).
- Added a commented Resend block to `.env.example`. Real delivery to a mailbox remains NOT verified.
- Rollout: set the variables in each server's `.env` (separate staging/production keys), recreate only the `api`
  container (no migration needed beyond 0034). Rollback: remove `EMAIL_BACKEND` (or set `disabled`) and recreate `api`;
  recovery reports itself unavailable.
