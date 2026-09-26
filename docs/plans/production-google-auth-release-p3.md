# Production Google-auth release P3

## Objective

Perform the final release-scope and security review, add the smallest accurate
Google-auth privacy disclosure, prove the production configuration contract,
and create and push one reviewable checkpoint commit without accessing or
changing production.

## Architecture and decisions

- Preserve the qualified P2A/P2B runtime composition and single Alembic head;
  P3 changes no authentication runtime behavior.
- Add Google to the existing privacy policy's account-data, service-provider,
  token-processing, retention, and deletion language without changing its
  structure or removing existing processors.
- Keep OAuth disabled by default. Deployment must first migrate and validate
  the new API/Web and published privacy page, then deliberately set
  `GOOGLE_OAUTH_ENABLED=true`.
- Treat the client ID and callback URLs as public configuration. The client
  secret remains backend-only and must come from the production secret store.

## Production configuration contract

Prepare these values for the later deployment stage:

```dotenv
GOOGLE_OAUTH_ENABLED=false
GOOGLE_OAUTH_CLIENT_ID=858246938433-qffbis672h594l74r5nkfelu5vh6oaob.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=<backend secret store; never commit or print>
GOOGLE_OAUTH_REDIRECT_URI=https://api.xpertapply.com/auth/google/callback
GOOGLE_OAUTH_WEB_CALLBACK_URL=https://xpertapply.com/auth/google/callback
GOOGLE_OAUTH_TRANSACTION_TTL_SECONDS=600
```

The later enablement step may change only `GOOGLE_OAUTH_ENABLED` to `true` after
migration, API/Web health, privacy publication, and OAuth-client verification.

## Future Google Cloud operator checklist

- Client type: Web application.
- Client ID: `858246938433-qffbis672h594l74r5nkfelu5vh6oaob.apps.googleusercontent.com`.
- Authorized redirect URI exactly:
  `https://api.xpertapply.com/auth/google/callback`.
- Audience: External, with publishing status suitable for intended real users.
- Authorized domain: `xpertapply.com`.
- Homepage: `https://xpertapply.com`.
- Privacy policy: `https://xpertapply.com/privacy`.
- Do not add Gmail, Drive, Calendar, Contacts, offline-access, or other scopes;
  the release requests only `openid`, `email`, and `profile`.

## Validation

- Review every release diff path against the production base and classify it.
- Scan tracked and staged content for credentials and excluded feature coupling.
- Run focused privacy, configuration, provider-discovery, and auth-page tests;
  Ruff/compile checks for changed API test/config files; Web lint, typecheck, and
  production build; Alembic heads; and Git whitespace checks.
- Stage only the explicit reviewed allowlist and compare staged paths exactly to
  that allowlist before committing.

## Rollout and rollback

P3 creates and pushes a checkpoint only; it does not deploy. P4 performs
production read-only preflight, backup, rollback checkpoint, and command
planning. During a later deployment Google remains disabled until migration and
the complete application/privacy/configuration rollout are verified. Roll back
application code with OAuth still disabled if validation fails; do not downgrade
the identity migration once provider identities or null-password users exist.

## Progress

- [x] Inventory and review qualified P2A/P2B release scope.
- [x] Add and test the Google privacy disclosure.
- [x] Document the exact production configuration and operator checklist.
- [x] Complete focused P3 validation and security scan.
- [x] Stage the exact reviewed allowlist.
- [x] Create and push the single checkpoint commit.

## Validation evidence

- Focused API configuration, Google-auth, password-auth, and serialization
  command: 119 passed. A follow-up identity/serialization fixture check: 26
  passed. Ruff and Python compilation passed for the affected API files.
- Focused Web privacy and auth: 3 files, 45 tests passed. Web lint, typecheck,
  and production build passed, including `/privacy` and
  `/auth/google/callback`.
- Production validation accepts the exact client ID, HTTPS API redirect, HTTPS
  Web callback, and TTL 600. It permits missing Google credentials only while
  disabled and rejects missing ID/secret, non-HTTPS or malformed redirects,
  and malformed callbacks when enabled.
- Alembic reports the single head `0033_prod_auth_identities`.
- Diff exclusion checks found no new application-memory, Apple-auth,
  extension-window, or Store-release code. `.env` is ignored and untracked.
- Secret-pattern scans found no client secret, private key, provider token, JWT,
  or personal email in the release files. Synthetic email fixtures use the
  reserved `example.com` domain.
