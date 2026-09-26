# AUTH Stage 2C-2J — authentication error UX and Google control polish

## Scope

Qualify the existing password and Google authentication UI without changing the
backend protocol, identity-linking policy, token semantics, redirect URLs,
database schema, extension handoff, or branding. The protected design-system
audit remains untouched.

## Current architecture and findings

- `/login` and `/signup` render the shared client-side `AuthDialog`.
- `lib/api.ts` converts transport and backend failures into `ApiError`, including
  structured server codes and Pydantic field errors.
- Before this stage, `AuthDialog` handled a few statuses locally and otherwise
  rendered backend messages. The Google callback had a separate partial map and
  could render caught exception text. Linking reduced every non-401 failure to
  one generic message.
- `app/auth/google/callback/page.tsx` completes the one-use handoff and owns the
  explicit password-link form. `lib/googleAuth.ts` owns PKCE preparation and
  safe return-path handling.
- `cz-shortcut-listen` and `shortcut-listen` do not occur in application source.
  The observed body attribute is external browser-extension DOM mutation before
  hydration, not server/client product output. React diagnostics remain enabled.

## Design decisions

1. `lib/authErrors.ts` is the typed presentation boundary for password login,
   signup, Google completion, and explicit linking errors. Components never
   render backend/provider diagnostic text.
2. Client validation supplies exact empty, malformed-email, and minimum-password
   guidance. Safe backend validation is normalized to the same field contract.
3. Login always maps a 401 to one enumeration-safe message, regardless of
   whether the email or password was wrong.
4. Routine errors remain inline. Field errors are associated with their input;
   form errors are alerts above controls and receive focus when no field does.
5. A repository-owned, decorative multicolor Google mark is rendered by one
   shared button component. No runtime image fetch or icon dependency is added.

## Implementation progress

- [x] Inventory password and Google authentication paths.
- [x] Add centralized typed error mapping and local validation.
- [x] Apply safe copy to sign-in, signup, callback, and linking.
- [x] Add shared accessible Google button with a decorative G mark.
- [x] Add the required error-taxonomy and non-leak regression matrix.
- [x] Complete focused and full qualification: 43 focused Web tests, 965 full
  Web tests, and 32 focused API Google-auth tests passed; Web lint, typecheck,
  and production build passed.
- [x] Complete desktop and narrow responsive inspection in dark mode. The
  sign-in, signup, and synthetic link form showed no clipping or overlap; field
  focus and wrapping were correct, and no hydration warning was emitted.

## Validation plan

- Focused: `auth-pages.test.tsx`, `google-auth.test.tsx`, and API Google auth.
- Full: Web unit suite, lint, typecheck, and production build.
- Manual: `/login`, `/signup`, and synthetic Google-link state at desktop and
  narrow viewport, including keyboard focus, wrapping, dark mode, and clipping.
- Security: search rendered copy and source for raw OAuth/provider diagnostics,
  secret logging, and divergent invalid-credential messages.

## Rollout and rollback

This is a Web-only presentation change with no migration or configuration
rollout. Deploy through the normal Web release after qualification. Roll back by
reverting the Web error mapper, shared Google button, component wiring, tests,
and this plan as one unit; the authentication protocol and persisted identities
remain compatible throughout.
