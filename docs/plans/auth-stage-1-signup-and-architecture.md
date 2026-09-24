# AUTH-1 signup remediation and authentication architecture audit

## Scope and constraints

This stage fixes only email/password signup and its error UX, adds focused
tests, and records the current and proposed authentication architecture. Google
and Apple sign-in, extension UI changes, extension permissions, packaging,
deployment, and Chrome Web Store mutation are explicitly out of scope.

- Worktree: `/Users/cprakash/Developer/XpertApply-auth-evolution`
- Branch: `feature/auth-evolution`
- Base: `861427de804a9a4650d9284e3c1b5bfaa2bf213e`
- Protected unrelated document: `docs/plans/xpertapply-design-system-audit.md`

## Investigation and root cause

The page route `apps/web/app/signup/page.tsx` renders
`components/AuthDialog.tsx`. That component submitted the raw email/password
through `lib/api.ts` to `POST /auth/signup`. The backend route in
`apps/api/app/routes/auth.py` receives `SignupRequest` from
`apps/api/app/schemas/auth.py`, checks normalized email uniqueness, hashes the
password, flushes a `User`, creates its `UserProfile`, commits once, and returns
an HS256 JWT access token. The browser stores that token through
`lib/authSession.ts` and routes to the requested safe protected path or the
dashboard.

The defect is a client/server validation contract mismatch combined with lost
error metadata:

1. The browser declared `minLength={8}` while `SignupRequest.password` requires
   10 characters. An 8- or 9-character password therefore passed browser
   validation and received HTTP 422 from FastAPI.
2. `lib/api.ts` normalized FastAPI's response into `ApiError.fieldErrors`, but
   `AuthDialog` ignored those errors and rendered only `ApiError.message`, which
   is intentionally the generic summary “Some fields need attention before
   this can be saved.”

No validation is weakened. Email normalization already trims surrounding
whitespace through `EmailStr`; the route lowercases both lookup and storage.

## Implementation plan and progress

- [x] Verify the canonical release branch and exact base; create an isolated
  feature worktree without touching the dirty production/development checkout.
- [x] Trace the complete signup path and reproduce the schema boundary.
- [x] Align the signup UI with the authoritative ten-character password rule.
- [x] Render safe field/form errors with focus and ARIA relationships.
- [x] Add backend and web regression coverage.
- [x] Complete the authentication/extension/provider architecture audit below.
- [x] Run focused and full qualification and review the exact diff. Create one
  local commit as the final AUTH-1 checkpoint.

## Validation matrix

The focused tests must cover valid signup, malformed email, short password,
duplicate email, case and whitespace normalization, single user/profile
creation, 422 mapping, generic/network failure, accessible field errors, and
successful stored-session navigation. Full qualification will record exact
commands and counts here after execution.

Qualification completed on 2026-09-23 America/Phoenix:

- Focused API auth: **10 passed**; 14 dependency/test-key warnings.
- Focused web auth page: **16 passed**.
- Full API: **2,054 passed, 12 skipped**; 1,782 existing dependency,
  deprecation, test-key-length, and deprecated-status warnings. The canonical
  test working directory was used with generated artifacts redirected to `/tmp`
  because this isolated worktree sits outside the tool's normal writable root.
- Full web: **49 files, 934 tests passed**. JSDOM emitted five existing
  “navigation not implemented” diagnostics while the suite still exited 0.
- Web ESLint: passed. Web TypeScript: passed. Web production build: passed
  (31 static/SSG pages generated plus dynamic routes).
- API Ruff on touched auth paths: passed. API compileall: passed.
- Extension compatibility: TypeScript passed; **75 files, 1,184 tests passed**;
  production build passed at unchanged version `0.2.0`. The Vitest runner
  config loader was used to keep its temporary config output within sandbox
  rules; no source/config change was made.
- `docker compose --env-file .env.example config --quiet`: passed using a
  temporary ignored empty `.env`, removed immediately afterward. No real secret
  or environment file was read or retained.
- Alembic upgrade/downgrade: not applicable because AUTH-1 changes no model or
  migration; provider schema work is explicitly deferred.

## Rollout and rollback

This is a source-only local checkpoint. There is no deployment or Store action.
Rollout in a later stage consists of deploying the API/web from a qualified
descendant and retesting signup against that environment. Rollback is a revert
of the single AUTH-1 commit; no data migration or extension-package rollback is
required.

## Authentication architecture audit

### Exact email/password signup path

1. `apps/web/app/signup/page.tsx:SignupPage` renders
   `apps/web/components/AuthDialog.tsx:AuthDialog` in signup mode.
2. Native browser constraints run first. `AuthDialog.submit` sends JSON through
   `apps/web/lib/api.ts:api` / `apiResponse`; public auth calls intentionally do
   not attach a stale bearer token.
3. `apps/api/app/routes/auth.py:signup` receives
   `apps/api/app/schemas/auth.py:SignupRequest` (`EmailStr`, password length
   10–128).
4. `EmailStr` trims surrounding email whitespace. The route lowercases the
   email for both `select(User)` and storage. The unique `users.email` index is
   the concurrent-race backstop.
5. `apps/api/app/core/security.py:hash_password` uses Passlib bcrypt when
   installed (the deployment dependency); its PBKDF2 branch is a dependency-
   absent fallback. The plaintext is never persisted or returned.
6. The route adds `User`, flushes to obtain its ID, adds exactly one
   `UserProfile`, and commits once. `IntegrityError` rolls back to a safe 409;
   `SQLAlchemyError` rolls back to 503. Thus user and profile are one
   transaction.
7. `create_access_token` returns an HS256 JWT with numeric user ID as string
   `sub` and configured expiry. `TokenResponse` returns it as a bearer token.
8. `AuthDialog` calls `apps/web/lib/authSession.ts:storeAuthToken`, which writes
   the legacy-compatible `jobpilot_token` key owned by
   `apps/web/lib/authToken.ts`, then replaces the route with a validated internal
   `next` path or `/dashboard`.
9. Failures flow through `api`: FastAPI 422 detail arrays become typed
   `ApiError.fieldErrors`; safe string/envelope errors become form errors. The
   auth form now associates field messages with inputs, focuses the first
   failing field, and announces the summary.

Observed deterministic behavior: valid unused email plus 10+ character password
is HTTP 200; malformed email and short password are HTTP 422; a normalized
duplicate is HTTP 409; case and surrounding email whitespace normalize to the
same lowercase identity; a network failure produces no status; an unexpected
server exception is converted by `apps/api/app/main.py:catch_unhandled_errors`
to a safe JSON 500 with request ID. The client does not render response HTML,
trace text, credentials, or internal operational detail.

### Current web authentication

- Endpoints: `POST /auth/signup`, `POST /auth/login`, and bearer-protected
  `GET /auth/me` in `apps/api/app/routes/auth.py`.
- Authentication is one first-party HS256 access JWT, verified by
  `apps/api/app/api/deps.py:get_current_user`. There is no refresh token,
  rotation, server session row, or revocation list. Default expiry is seven
  days (`JWT_EXPIRES_MINUTES=10080`).
- The web app stores the bearer JWT in `localStorage` under `jobpilot_token` and
  attaches it in `apps/web/lib/api.ts:apiResponse`. There is no auth cookie.
- Obvious client-side expiry prevents protected rendering, but the API is
  authoritative. A protected 401 clears the matching current token and routes
  to login without allowing an old in-flight request to erase a newer session.
- Logout is client-side token removal through
  `invalidateAuthSession`/`clearAuthSession`, plus extension teardown. It does
  not revoke an otherwise unexpired JWT at the server.
- No password-reset, password-change, email-verification, refresh, or provider
  endpoints exist in this source.

### Current extension authentication and handoff

The extension does **not** hold the web login JWT and does not create a second
user identity system.

- An authenticated web request creates an application session and one-time
  `extension_launch_token`. `apps/web/lib/autoApply.ts` stages that token from a
  production first-party page into the extension content script's isolated
  world; it is never placed in the URL or page DOM.
- The service worker binds the handoff to the employer tab, exchanges the token
  once, and receives a session-scoped bearer token. The scoped token and full
  session package live in `chrome.storage.session`, plus bounded service-worker
  memory. They are not stored in `chrome.storage.local`; local storage contains
  only configuration and minimal runtime coordination.
- `apps/extension/manifest.json` restricts `externally_connectable`, required
  web host access, and the web content script to `https://xpertapply.com` and
  `https://www.xpertapply.com`. `background.ts` validates every external
  message with `parseExternalRuntimeMessage` and
  `isApprovedExternalWebSender`, using browser-supplied sender data rather than
  message claims.
- Logout/account replacement calls the external runtime protocol from
  `authSession.ts`. `background.ts:purgeSessionState` advances an authority
  generation fence, clears pending/session storage and caches, removes runtime
  metadata, acknowledges only after authority is gone, and best-effort clears
  open employer tabs. A replacement web token is not installed until teardown
  is acknowledged or the extension is proven absent.

### Current backend identity model and configuration

`apps/api/app/models/entities.py:User` is the only login identity record. It has
a unique, non-null normalized email and non-null password hash. There is no
`ExternalIdentity`, provider subject, provider token, verified-email marker, or
linking table. `UserProfile.user_id` is unique and cascade-deleting. The initial
constraints are in `apps/api/alembic/versions/0001_initial.py` and later
migrations do not add provider identity.

Relevant configuration is limited to `SECRET_KEY`, `JWT_EXPIRES_MINUTES`,
`CORS_ORIGINS`, `CORS_ALLOW_CREDENTIALS`, `NEXT_PUBLIC_API_URL`, site URL, and
public Chrome extension ID/listing URL. Production startup refuses the shipped
secret, wildcard credentialed CORS, and other unsafe defaults. OAuth client IDs,
callback URLs, Google secrets, Apple identifiers, and Apple keys do not exist.
Provider secrets must be backend-only and injected by the deployment secret
store; no secret value belongs in `NEXT_PUBLIC_*`, the extension, source, logs,
or this document.

## Google sign-in design (next stage; not implemented)

### Options considered

1. **Backend/web OIDC authorization-code flow — recommended.** It produces the
   existing XpertApply bearer session and preserves the current website-to-
   extension one-time handoff.
2. `chrome.identity.getAuthToken` is a Chrome-account/extension OAuth mechanism
   and would require the `identity` permission plus an extension OAuth client.
   It would create a parallel extension-first login surface and does not solve
   Apple or normal web login.
3. `chrome.identity.launchWebAuthFlow` can run a general redirect flow through a
   `chromiumapp.org` callback, but still creates extension-specific callback,
   state, client, and account-switch logic.
4. Website-mediated extension authentication is already the product model:
   authenticate on XpertApply web, mint the ordinary XpertApply JWT, then issue
   only one-time/scoped application authority to the extension. Keep it.

### Recommended flow

- Create a Google Cloud **Web application** OAuth client with exact authorized
  production/staging/local redirect URIs. Use backend routes such as
  `GET /auth/google/start` and `GET /auth/google/callback`; after success,
  return the ordinary XpertApply access token through a same-origin completion
  page without putting it in a query string or cross-origin URL.
- Use authorization code flow with PKCE S256, high-entropy one-time `state`, and
  OIDC `nonce`, bound to a short-lived HttpOnly, Secure, SameSite cookie or
  server-side transaction record. Consume each once and allowlist the final
  internal return path.
- Request only `openid email profile`. No offline Google access or refresh token
  is needed merely to sign in.
- Exchange the code server-side and verify signature/JWKS, issuer, audience,
  expiry, nonce, and `email_verified`. The stable identity key is Google's
  `sub`, never a client-reported email. See Google's current
  [OIDC reference](https://developers.google.com/identity/openid-connect/reference)
  and [server-side ID-token verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
- In one database transaction, resolve `(provider="google", subject=sub)`, then
  create/link according to the policy below, create the profile for a new user,
  and finally issue the existing XpertApply JWT. Do not return Google tokens to
  the extension.
- Logout keeps the existing local XpertApply logout/fencing semantics. Provider
  disconnect deletes only the link after proving another login method remains.
  If a later feature stores a Google grant, revoke that grant on disconnect;
  sign-in alone should avoid storing provider access/refresh tokens.

Owner actions: create/configure the Google Cloud project and consent screen,
verify the production domain if required, create the Web application client,
register exact origins/redirect URIs, supply the client ID and client secret to
the backend secret store, and manage test/publishing status. Code actions: add
the migration/model, start/callback/link/disconnect endpoints, provider-token
verification, UI buttons/completion handling, redacted telemetry, and tests.
Extension permissions needed for this design: **none**; specifically, do not add
`identity` solely for Google sign-in.

## Apple sign-in design (following stage; not implemented)

- Use the same backend-mediated authorization-code architecture and the same
  XpertApply session issuance. Suggested routes are `/auth/apple/start`,
  `/auth/apple/callback` (accepting Apple's `form_post`), notifications, link,
  and disconnect/revoke endpoints.
- Generate and consume one-time state and nonce, use exact HTTPS return URLs,
  exchange the short-lived code on the backend, and verify Apple signature/JWKS,
  issuer, Services-ID audience, expiry, nonce, and stable `sub`. Persist the
  `user` name payload immediately and only after token validation because Apple
  supplies it only on the first authorization. Request only `name email`.
- Treat `@privaterelay.appleid.com` as a valid provider address, not proof of a
  match to a real-email password or Google account. Store the provider subject
  as identity and the relay address as provider metadata/communication address.
- Generate Apple's client-secret JWT on the backend from Team ID, Services ID,
  Key ID, and the Sign in with Apple `.p8` private key. Keep the key only in the
  deployment secret manager, support rotation, and never commit it.
- If tokens are retained for revocation/account lifecycle, encrypt them at rest,
  revoke via Apple's endpoint on disconnect/deletion, validate refresh state as
  Apple directs, and validate signed server-to-server notifications such as
  consent revocation and relay enable/disable. Apple's current documentation
  covers [environment setup](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple),
  [first-authorization-only user data](https://developer.apple.com/documentation/signinwithapple/configuring-your-webpage-for-sign-in-with-apple),
  and [account-change notifications](https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts).

Owner actions: maintain Apple Developer membership; enable Sign in with Apple on
a primary App ID; create and associate a Services ID; register/verify web domains
and exact return URLs; create/download the Sign in with Apple private key once;
record Team ID and Key ID; configure a TLS server-notification URL; and register
SPF/DKIM-authenticated outbound sources before emailing relay users. Apple
requires a Sign in with Apple-enabled App ID associated with the web Services
ID. Localhost cannot be an Apple return URL, so development needs an HTTPS
domain/tunnel registered by the owner.

Backend secret/config additions: `APPLE_SERVICES_ID`, `APPLE_TEAM_ID`,
`APPLE_KEY_ID`, an injected `APPLE_PRIVATE_KEY`, exact callback URL, notification
audience/config, and optional encrypted-token key. None are extension config.

## Deterministic account-linking policy

1. A known `(provider, subject)` signs into its linked user regardless of current
   provider email.
2. A new provider subject with no email collision creates one user/profile and
   one external identity atomically. Provider-only users have no usable password
   until they explicitly establish one.
3. A provider assertion whose verified email equals an existing password
   account does **not** silently merge. Offer a generic “sign in to link” flow;
   require the existing password (or a future verified recovery challenge) in
   the same browser transaction, then add the external identity atomically.
4. Apple relay email never collides or links to a real-email account by inferred
   personhood. Google-then-Apple (or the reverse) links only from an authenticated
   account with a recent reauthentication/link transaction.
5. A `(provider, subject)` is globally unique and can link to only one user.
   Normalize emails for collision lookup, but do not use them as provider keys.
6. Disconnect requires recent authentication and at least one other usable login
   method. The last method cannot be removed. Revoke retained provider grants and
   advance/clear XpertApply sessions as the session design permits.
7. Provider-only users may add password login only through an authenticated,
   reauthenticated “set password” path (and later through verified recovery),
   never by attempting signup with the provider email.
8. Public responses stay generic enough not to become a bulk account-discovery
   oracle. Audit records contain internal IDs and reason codes, not tokens or
   provider payloads.

## Schema impact

**Migration required: YES, in the provider implementation stage—not AUTH-1.**

Add an `external_identities` table with user FK/cascade, provider enum/string,
provider subject, provider email snapshot, provider-email-verified flag, created
and last-login timestamps, and unique `(provider, subject)`. Optional encrypted
refresh/revocation material should be isolated and nullable. Make
`users.hashed_password` nullable (or move passwords to a credential table), with
a constraint that account-service logic enforces at least one usable login
method. Add transaction-safe link/unlink services. Do not put Apple relay email
or changeable Google email in the stable uniqueness key.

## Chrome Web Store impact

Store submission remains paused. The existing draft/package is version `0.2.0`
for public Store item `gnibjomjfdobadlockphjiibbpmiehcj`; neither was changed.
The recommended website-mediated Google/Apple design needs no `identity`
permission. The later persistent assistant-window stage may remove `sidePanel`,
change permission/privacy justifications, require fresh listing screenshots, and
require a later package version/upload. If the implementation choice changes to
extension-native OAuth, reassess `identity` permission and Store disclosures.
No Store dashboard mutation belongs to any of these source stages.
