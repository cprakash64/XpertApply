# Minimal production Web security and Store routing backport

## Architecture and decisions
Base: ceb8314ed69be130f591fb6c90df045fadca7fe8. No whole release commits are cherry-picked. Preserve production UI, auth, API, migration and extension source. Transplant the dependency-free qualified securityPolicy.mjs exactly from 1dc21af. Next owns CSP Report-Only and poweredByHeader:false; nginx retains its five Web edge headers.

Store routing uses the qualified current-host HTTPS detail parser and explicit public ID from 099cff90. Brand/site origin and extension handoff logic remain unchanged. ID-only configuration is valid without a published Store URL. No production URL is invented. The production base has no release extensionRuntime messaging module; this backport exports the ID configuration helper without introducing that unrelated bridge.

Private production .env feeds Compose interpolation, Web Docker ARG/ENV and next build. Future ID: gnibjomjfdobadlockphjiibbpmiehcj. URL remains absent. Existing URL plumbing is preserved; only ID plumbing is added. No other service definitions change.

## Progress and validation
Source preparation complete. Qualification results are recorded below before any commit. Required commands: targeted securityPolicy/siteConfig/landing-page tests, lint, typecheck, clean build with exact ID and URL unset, make test-api, make test-web, make test-extension, docker compose config. No migrations change, so Alembic upgrade/downgrade does not apply.

## Rollout and rollback
No push or production deployment in this stage. Final source review and deployment transaction are separate. Future deployment must add the public ID to private production environment authority, preserve current Web image sha256:4df10325e866f5d905d2d6b19e529babd3ae69fa086a430cfa321e0aa759f672 and production environment authority, and rebuild/recreate only Web with dependencies excluded. API/worker/scheduler/database/nginx stay untouched. Roll back through the retained image if Web acceptance fails. Production CSP observation precedes separately qualified enforcement; do not weaken policy in response to inline-script reports.

## Qualification results
- Targeted Vitest: securityPolicy 4, siteConfig 34, landing-page 27, Web build plumbing 3; 68 passed. Tests run without production build variables.
- make test-web: lint, typecheck and production build PASS; all 1,008 Web tests PASS. An initial invocation incorrectly exported production variables into tests; rerun with those variables cleared passed without changing assertions for that failure.
- make test-api using the existing Developer-family Python test environment: 1,938 passed, four PostgreSQL-dependent tests skipped; no API source or migration delta.
- make test-extension: typecheck/build PASS; 809 tests passed, 10 skipped. No extension source delta.
- Clean production build with NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj, NEXT_PUBLIC_CHROME_EXTENSION_URL unset and public API/site origins PASS.
- Local Next production-server HTTP smoke: / and /privacy both 200, exact CSP Report-Only, no enforcing CSP and no X-Powered-By. No browser smoke or violation count claimed.
- Local Docker daemon unavailable, so no candidate image/container build. Base and production Compose config validation PASS. Resolved Web build args verified exact ID and URL empty. Docker ARG/ENV ordering is tested before npm run build. URL plumbing already existed.
- Final minimization leaves compose.production.yml byte-for-byte unchanged: only the base Web build argument and Docker ARG/ENV are needed. Docker ENV supplies the built ID; no separate runtime Compose override is added. No services, ports, volumes, dependencies, healthchecks or migration settings change.
- Frozen policy module equals the qualified release blob; API client, autoApply, API, extension and protected design-system plan remain identical to base. No new snapshots/cancel-deletion endpoints.

## Source authority
Candidate stays as one local commit directly on the production base. No push, production access, environment edit, image recreation, nginx action, database mutation or Store action occurs in this stage. NEW-04 remains OPEN. Final backport review and push/deployment transaction design are CWS-PREP-09C.
