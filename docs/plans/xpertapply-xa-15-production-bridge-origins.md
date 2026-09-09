# XA-15 — Production bridge-origin separation

## Finding and invariant

The shipped extension previously injected its first-party Web bridge on
`localhost:3000` and `127.0.0.1:3000`. Production artifacts must trust only
explicit HTTPS product origins. Loopback support is allowed only in an explicit
development or E2E build.

## Architecture and decision

`src/bridge-origins.mjs` is the shared source for runtime bridge origins and
generated content-script match patterns. `src/build-profile.mjs` owns the fixed
profile/output map. Official commands pass a command-line profile, which takes
precedence over the retained CI environment variable. An output override is
accepted only when it exactly repeats the fixed mapping; mismatches fail closed.
The source manifest is itself production-safe. `e2e/build-granted.mjs` builds
directly into its disposable E2E directory and never mutates `dist` or the
source manifest.

The current canonical Web origins are `https://xpertapply.com` and
`https://www.xpertapply.com`. They are the complete production bridge allowlist.
`https://api.xpertapply.com` is an API host permission, not a Web bridge origin.
The unverified historical origins `https://app.jobpilot.ai`,
`https://ezjobfind.com`, and `https://www.ezjobfind.com` were removed from
content-script matches, required host permissions, and runtime bridge trust.

Profile and artifact mapping:

- `npm run build`: explicit `production` profile → `dist`
- `npm run build:dev`: explicit `development` profile → `dist-development`
- `npm run build:e2e`: explicit `e2e` profile → `dist-e2e-granted`
- `npm run package`: removes the prior ZIP, explicitly rebuilds `production`,
  and packages only the freshly generated `dist`; a failed build leaves no ZIP

Production and development contain the two XpertApply HTTPS origins.
Development additionally contains `http://localhost:3000` and
`http://127.0.0.1:3000`. The E2E artifact contains those controlled loopback
origins and adds only its test-required grants.

## Validation

- Production runtime and manifest reject every known loopback variant.
- Real Chrome hostile-loopback test proves no bridge acknowledgement, launch,
  tab creation, package, candidate data, or submission.
- Explicit E2E artifact includes the two required loopback origins.
- Production → development → E2E → production sequencing and package inspection
  prove that nonproduction artifacts cannot contaminate `dist` or the release ZIP.
- Production artifacts reject the three removed historical origin shapes.
- Existing XA-01, XA-06, XA-12, and XA-13 focused/full suites remain green.

## Rollout and rollback

Ship only the artifact freshly produced by `npm run package`. Development and
E2E commands use separate fixed output directories. Rollback is the single
XA-15 change set; never restore loopback or an unverified historical origin to
the production manifest or runtime allowlist.

A compatibility origin may be deliberately reintroduced only after documenting
current operator control, a live supported Web client, affected production
users, the exact bridge requirement, and a removal date/review owner. Add it to
the single production origin source, regenerate the manifest, and repeat the
origin-negative, exact-match, browser, package, and cross-contamination checks.

## Progress

- [x] Reproduce current production exposure in Chrome for Testing.
- [x] Separate build profiles and make the source manifest production-safe.
- [x] Remove unverified legacy origins from production bridge authority.
- [x] Fix deterministic profile/output mapping and production packaging.
- [x] Complete focused, negative-control, cross-contamination, and full-suite validation.
