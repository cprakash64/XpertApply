# AUTH-2B Google sign-in

## Scope and architecture

Development-only backend-mediated Google OIDC authorization-code flow on the
AUTH-2A provider-neutral identity model. The API owns Google state, nonce, PKCE,
code exchange, ID-token verification, account resolution, and XpertApply JWT
issuance. The Web receives only a one-time opaque completion code. No Google
token enters a URL, browser store, relational table, or extension channel.

Google requirements were retrieved 2026-09-24 from the official OIDC guide,
OIDC reference, Web-server OAuth guide, server-side ID-token verification guide,
and Sign in with Google branding guide:

- https://developers.google.com/identity/openid-connect/openid-connect
- https://developers.google.com/identity/openid-connect/reference
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
- https://developers.google.com/identity/branding-guidelines

## Security decisions

- Redis is mandatory and fail-closed for OAuth, completion, and pending-link
  records. Records expire in 600 seconds and are atomically consumed with
  `GETDEL`.
- Google authorization uses state, nonce, PKCE S256, an HttpOnly SameSite=Lax
  browser-binding cookie, exact callback URI, and only `openid email profile`.
- Google JWT verification pins the HTTPS JWKS URL and RS256, bounds HTTP timeouts
  and response size, caches keys briefly, refreshes on an unknown `kid`, and
  validates issuer, audience, multi-audience `azp`, expiry, issued-at, nonce,
  subject, email, and email verification before new-account creation.
- The Web creates a Web Crypto verifier in sessionStorage. Its S256 challenge is
  bound into the server transaction. Callback query material is removed before
  exchange. Completion codes are random, short-lived, verifier-bound, and
  one-use. XpertApply JWTs are returned only in POST bodies.
- Same-email collision produces a pending-link record bound to verified provider
  claims and the exact existing user ID. Password reauthentication is generic,
  Redis-rate-limited, and the caller cannot supply identity or target fields.
- Redirects accept only relative paths; OAuth/token-bearing query keys and the
  callback path are rejected. Provider URLs are compiled constants, preventing
  SSRF through configuration.
- Privacy-safe events name outcome categories only. They never contain email,
  subject, state, nonce, verifier, code, provider tokens, tickets, or JWTs.

## Data and privacy

Received from Google: stable `sub`, verified email status/address, and optional
display name. Retained: provider name, subject, observed provider email,
verification flag, and optional display name in `external_identities`. Discarded:
authorization code, ID token, access token, token response, state, nonce, and
PKCE verifier. Offline access is not requested, so no refresh token is expected
or retained.

Before production deployment, the public privacy policy should identify Google
as an authentication provider; describe the external-identity metadata received
and retained; state that Google access/refresh tokens are not retained; and link
to applicable Google privacy information. XpertApply must not make unsupported
claims about Google's own retention.

## Rollout and migration lineage

No migration is added. `0034_external_identities` remains unchanged and is valid
only on the development lineage ending in `0033_snapshot_provenance`. Production
currently ends at the separate `0032_confirmation_contract`; lineage must be
reconciled in a later release stage before deployment.

The extension remains website-mediated and receives only the existing
XpertApply session handoff. No manifest, permission, version, package, or Store
item changes are allowed.

## Validation checklist

- [x] Review official Google requirements and existing auth/Redis/Web patterns.
- [x] Implement provider capability, start, callback, completion, and link APIs.
- [x] Implement Web initiation, callback, and password-link experience.
- [x] Add synthetic provider, signed-JWT, identity, replay, and Web tests.
- [x] Complete API, Web, extension, static, build, Compose, and diff gates.
- [x] Complete security matrix and create one local checkpoint commit.

Qualification evidence: 49 focused API auth/identity tests (27 Google cases),
2,096 full API tests with 12 environment-dependent skips, 944 Web tests, and
1,184 Extension tests passed. Ruff, compileall, Web lint/typecheck/build,
Extension typecheck/build, API image build, Compose config, Alembic graph, and
diff checks passed. The checkpoint commit is the final step performed after
this document is staged and reviewed.

## Security review matrix

| Threat / control | Result | Evidence |
| --- | --- | --- |
| OAuth login CSRF | PASS | Random one-use state plus a hashed, HttpOnly browser-binding cookie and Web handoff challenge. |
| Authorization-code interception | PASS | Backend-only exchange, Google PKCE S256, exact configured redirect URI, and no retry after state consumption. |
| State replay | PASS | Redis `GETDEL` consumes the OAuth record before exchange. |
| Completion-code theft / replay | PASS | Random opaque code is bound to the Web S256 challenge and atomically consumed once. |
| Open redirect | PASS | Only validated relative XpertApply paths without auth-bearing query keys are accepted. |
| PKCE downgrade | PASS | Start always sends S256 and callback always supplies the server-held verifier. |
| Nonce omission / substitution | PASS | Random server-held nonce is required in, and compared against, the verified ID token. |
| JWT in URL | PASS | Redirect carries only an opaque completion code; JWT is returned by POST. |
| Provider-token persistence | PASS | Exchange extracts only `id_token`; token payload, ID token, access token, and code are neither returned nor stored. |
| Account takeover by same email | PASS | Same-email collision yields link-required and requires the existing password. |
| Provider-subject reassignment | PASS | AUTH-2A uniqueness/link conflict rules prevent subject reassignment. |
| Link-ticket substitution | PASS | Server state fixes provider, subject, email, and user; request models reject extra identity fields. |
| Link password brute force | PASS | Redis fixed-window limit permits five attempts per hashed ticket in ten minutes. |
| OAuth secret leakage | PASS | Client secret is backend-only; no `NEXT_PUBLIC_` setting, URL, response, or committed value. |
| Logs leaking auth material | PASS | Structured events contain only event/category; tests and review found no sensitive values logged. |
| CORS mistakes | PASS | Existing explicit origin/credential policy is reused; callback security does not depend on cross-origin cookies. |
| Cookie SameSite / Secure | PASS | Binding is host-only, HttpOnly, SameSite=Lax, path-limited, short-lived, and Secure whenever the callback is HTTPS; production validation requires HTTPS. |
| SSRF through provider configuration | PASS | Authorization, token, and JWKS endpoints are fixed HTTPS constants. |
| JWKS algorithm confusion | PASS | JWT header and decoder are pinned to RS256. |
| `kid` / JWK abuse | PASS | `kid` must be a string and match a Google-set key; one bounded refresh supports rotation, then rejects. |
| Fail-open Redis behavior | PASS | Store exceptions produce `OAUTH_TEMPORARY_FAILURE`; there is no in-memory runtime fallback. |

No High or Critical finding is open.
