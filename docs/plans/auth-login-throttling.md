# Login and sign-up throttling

Status: IMPLEMENTED LOCALLY, NOT DEPLOYED. Closes finding S3 (P1) of the live staging acceptance report (`docs/release/PUI-LIVE-ACCEPTANCE_REPORT.md`).

## Problem (evidence)
On staging, 15 wrong-password `POST /auth/login` calls in 4.4 s all returned 401 (no 429, no lockout, no delay) and the correct password then worked. The application limited only password recovery and People search; nginx
(`infra/staging/nginx/*.conf`) has no `limit_req`. Passwords have a 10-character minimum and sessions last 7 days, so unlimited guessing or credential replay was possible.

## Architecture
`apps/api/app/services/auth_throttle.py`, called from `routes/auth.py`:
- **Per account (always on):** `auth_login_max_attempts` (default 10) per `auth_login_window_seconds` (default 900 s). Keyed by SHA-256 of the lower-cased email; unknown emails are counted like known ones, so the 429 does not reveal whether an
  account exists and the existing "no enumeration" behaviour (same 401 body) is preserved. The attempt is counted atomically BEFORE the password is checked (a parallel burst cannot overshoot; a blocked attempt costs no hashing, and a block also
  refuses the correct password so the limit cannot confirm a guess). A correct password clears the counter.
- **Per client address (opt-in):** `auth_login_max_attempts_per_ip` (60) and `auth_signup_per_ip_hourly_limit` (20), active only when `AUTH_TRUSTED_PROXY_HOPS` > 0. Reason: behind nginx every request reaches the API from the proxy's address, so keying on
  `request.client` would throttle all users as one client. With hops = 1 the client is the rightmost `X-Forwarded-For` entry; nginx sets `X-Forwarded-For $remote_addr` (overwrite), and the rightmost entry cannot be forged by the client (tested).
  Default 0 keeps these off.
- **Storage:** Redis fixed-window counters (`INCR` + `EXPIRE NX` + `TTL` in one pipeline, same pattern as the Google OAuth limiter), shared by all workers. If Redis is unreachable it falls back to a per-process counter (degrades, never fails open). Under
  pytest only the process store is used.
- **Response:** `429` with `{"detail":"Too many attempts. Please wait a few minutes and try again."}` and `Retry-After`. The web app already maps 429 for login and signup (`lib/authErrors.ts`), so there is no frontend change.
- No schema change and no migration.

## Decisions
- Per-account limit first, because it works regardless of proxy topology. Per-address limits are opt-in to avoid a self-inflicted outage.
- Trade-off accepted: someone who knows an email can hold that account's password sign-in blocked for one window (15 min). Password recovery and Google sign-in are unaffected, and the alternative is unlimited guessing.
- Fixed window (simple, atomic) rather than a sliding window.
- Not changed here (noted): an unknown email still returns faster than a wrong password (no dummy hash); extension code-exchange endpoints and People limits are separate.

## Progress and validation
- `app/tests/test_auth_throttle.py`: 14 tests: block and `Retry-After`; block refuses the correct password; known and unknown emails identical; reset on success; case/whitespace normalisation and account independence; window expiry; blocked attempts skip password
  verification; per-address off by default; per-address with a trusted hop; forged leftmost `X-Forwarded-For` ignored; signup limit; Redis outage fallback; 40 parallel attempts allow exactly the limit; Redis path uses a hashed key and `EXPIRE NX`.
  Negative control: with the route wiring reverted, 12 of the 14 fail.
- Full API suite (Python 3.12, `APP_ENV=test`): **2247 passed, 10 skipped, 0 failed** (was 2233 passed; the 14 new tests are the difference).
- Real Redis 7 (throwaway container, loopback): 5 attempts allowed, the 6th and 7th returned 429 with `Retry-After` from the key TTL, the key was a hash (no plaintext email), the window expired on schedule, and a correct login deleted the key.
- Not yet done: deployment to staging and the live re-check of the 15-attempt burst (needs approval to deploy and to create a synthetic account).

## Rollout
1. Merge and build the API image (no migration). The per-account limit is active immediately with the defaults.
2. To enable per-address limits, set `AUTH_TRUSTED_PROXY_HOPS=1` in the API environment of the environment behind the single nginx (staging first). Do this only where nginx overwrites `X-Forwarded-For` (the staging templates do:
   `proxy_set_header X-Forwarded-For $remote_addr;`). Verify with two different source addresses before relying on it.
3. Recommended in addition (operator, edge, not applied here; production edge not inspected):
   ```nginx
   limit_req_zone $binary_remote_addr zone=xa_auth:10m rate=10r/m;
   location ~ ^/auth/(login|signup)$ {
       limit_req zone=xa_auth burst=10 nodelay;
       limit_req_status 429;
       # ...existing proxy_pass and headers
   }
   ```
4. After deploying to staging, re-run the live gate's burst (15 wrong logins on a synthetic account): expect 401 x10 then 429 with `Retry-After`; then a correct login after the window.

## Rollback
Redeploy the previous API image (no data or schema to undo). To soften without redeploying, raise `AUTH_LOGIN_MAX_ATTEMPTS` or set `AUTH_TRUSTED_PROXY_HOPS=0`. Counters live in Redis under `xa:auththrottle:*` and expire on their own; they can be deleted safely.
