# Minimal production Web security and Store routing backport

## Architecture and decisions
Base: ceb8314ed69be130f591fb6c90df045fadca7fe8. No whole release commits are cherry-picked. Preserve production UI, auth, API, migration and extension source. Transplant the dependency-free qualified securityPolicy.mjs exactly from 1dc21af. Next owns CSP Report-Only and poweredByHeader:false; nginx retains its five Web edge headers.

Store routing uses the qualified current-host HTTPS detail parser and explicit public ID from 099cff90. Brand/site origin and extension handoff logic remain unchanged. ID-only configuration is valid without a published Store URL. No production URL is invented. The production base has no release extensionRuntime messaging module; this backport exports the ID configuration helper without introducing that unrelated bridge.

Private production .env feeds Compose interpolation, Web Docker ARG/ENV and next build. Future ID: gnibjomjfdobadlockphjiibbpmiehcj. URL remains absent. Existing URL plumbing is preserved; only ID plumbing is added. No other service definitions change.

## Progress and validation
Source preparation complete. Qualification results are recorded below before any commit. Required commands: targeted securityPolicy/siteConfig/landing-page tests, lint, typecheck, clean build with exact ID and URL unset, make test-api, make test-web, make test-extension, docker compose config. No migrations change, so Alembic upgrade/downgrade does not apply.

## Rollout and rollback
No push or production deployment in this stage. Final source review and deployment transaction are separate. Future deployment must supply the exact public ID through the narrowly allowlisted production wrapper without editing private .env, preserve current Web image sha256:4df10325e866f5d905d2d6b19e529babd3ae69fa086a430cfa321e0aa759f672 and production environment authority, and rebuild/recreate only Web with dependencies excluded. API/worker/scheduler/database/nginx stay untouched. Roll back through the retained image if Web acceptance fails. Production CSP observation precedes separately qualified enforcement; do not weaken policy in response to inline-script reports.

## Original CWS-PREP-09B qualification results
- Targeted Vitest: securityPolicy 4, siteConfig 34, landing-page 27, Web build plumbing 3; 68 passed. Tests run without production build variables.
- make test-web: lint, typecheck and production build PASS; all 1,008 Web tests PASS. An initial invocation incorrectly exported production variables into tests; rerun with those variables cleared passed without changing assertions for that failure.
- make test-api using the existing Developer-family Python test environment: 1,938 passed, four PostgreSQL-dependent tests skipped; no API source or migration delta.
- make test-extension: typecheck/build PASS; 809 tests passed, 10 skipped. No extension source delta.
- Clean production build with NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj, NEXT_PUBLIC_CHROME_EXTENSION_URL unset and public API/site origins PASS.
- Local Next production-server HTTP smoke: / and /privacy both 200, exact CSP Report-Only, no enforcing CSP and no X-Powered-By. No browser smoke or violation count claimed.
- Local Docker daemon unavailable, so no candidate image/container build. Base and production Compose config validation PASS. Resolved Web build args verified exact ID and URL empty. Docker ARG/ENV ordering is tested before npm run build. URL plumbing already existed.
- Final minimization leaves compose.production.yml byte-for-byte unchanged: only the base Web build argument and Docker ARG/ENV are needed. Docker ENV supplies the built ID; no separate runtime Compose override is added. No services, ports, volumes, dependencies, healthchecks or migration settings change.
- Frozen policy module equals the qualified release blob; API client, autoApply, API, extension and protected design-system plan remain identical to base. No release-only API endpoints.

## Source authority
Candidate consists of the original local backport commit directly on the production base plus exactly one R1 repair commit. No push, production access, environment edit, image recreation, nginx action, database mutation or Store action occurs in this stage. NEW-04 remains OPEN. Final backport review and push/deployment transaction design are CWS-PREP-09C.


## CWS-PREP-09B-R1 repair
- The original configured ID must be exactly 32 lowercase a-p characters. No trimming, case folding, decoding or Unicode normalization. URL identity comparison uses this validated original value; malformed nonempty IDs fail closed even alongside a valid URL. Empty/unset ID retains the existing optional configuration behavior.
- production-compose.sh retains env -i, its four original environment values, fixed Docker authority, private --env-file and all host/user/path/preflight gates. Only an explicitly supplied canonical NEXT_PUBLIC_CHROME_EXTENSION_ID is added. An invalid supplied value stops before Compose; unset retains existing behavior. Empty-array expansion remains compatible with Bash 3 nounset.
- URL is never forwarded from the caller or synthesized. The recorded production .env has no Store URL entry. Future preflight MUST verify this remains absent; if present, STOP and requalify rather than edit .env or assume external env -u clears its authority. No explicit URL-unset feature is needed for the frozen URL-absent baseline.
- Future build from /home/luna/apps/XpertApply: NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj scripts/production-compose.sh build web. Public API/site values remain private env-file authority. No production command is executed in R1.
- Future recreate: scripts/production-compose.sh up -d --no-deps --no-build --pull never web. ID override is unnecessary here: Compose references it only in Web build args, no build is requested, and the image contains Docker ENV plus the baked Next value. Local resolved configurations prove runtime and non-Web service definitions are identical with/without the override.
- Regression tests execute the actual wrapper environment construction in an isolated harness, then actual env -i and local Compose config with synthetic fixtures. Production-only host/user/path gates are not executed or bypassed on production. Tests verify exact ID propagation, unrelated/secret-like caller isolation, optional absent ID/URL, unchanged runtime/non-Web definitions and private API/site authority.
- No migration changes; Alembic upgrade/downgrade remains inapplicable. R1 creates one additional local repair commit; no amendment, push or deployment.

### R1 qualification results
- Targeted Web command (public API/site/Store variables cleared): npm test -- --run __tests__/securityPolicy.test.ts __tests__/siteConfig.test.ts __tests__/landing-page.test.tsx __tests__/webBuildConfig.test.ts __tests__/productionCompose.test.ts. All 90 passed: security 4, siteConfig 47, landing 27, build plumbing 3, wrapper 9; zero failed/skipped.
- make test-web with public variables cleared: lint/typecheck/build PASS; all 1,030 tests PASS. Initial repair attempts exposed Bash 3 empty-array/nounset behavior and local test-harness typing/plugin discovery issues; corrected without weakening assertions before the final full pass.
- make test-api with the existing Developer-family Python environment: 1,938 passed, four PostgreSQL-dependent skips. make test-extension: typecheck/build PASS, all 819 tests PASS, zero skipped. No API/extension source changes.
- Clean Web build with URL unset, exact production Store ID and authoritative public API/site values PASS. Local Next production HTTP smoke on loopback: root/privacy 200, exact CSP Report-Only, no enforcing CSP, no X-Powered-By, no Store listing link. Local smoke server stopped after checks.
- Actual local Compose config interpolation PASS with synthetic private-env fixtures; supplied ID resolves exactly, URL remains empty, private API/site values preserved, and all non-Web plus Web runtime config remain identical. No production connection or Docker image/container operation performed.
- securityPolicy.mjs blob exactly equals 1dc21af (553ab713366ac85c6984810d37c455b8eed715ed). Next config preserves allowedDevOrigins and adds only the qualified Report-Only helper plus poweredByHeader:false. Bash syntax and git diff whitespace checks PASS. No new release-only API endpoints; protected plan and unrelated services/source unchanged. NEW-04 remains OPEN.
