# Stage 50D: production-compatible Tracker download release

Branch `release/stage50d-tracker-downloads` (worktree `~/Developer/XpertApply-stage50d`), cut from production web baseline
`a63945e` (`release/cws-web-new04-prod`). Supersedes the Stage 50C plan (do not build production web from NAV02 `1516f23`).

## Architecture and decisions
- Production web = `a63945e` (CSP report-only, Chrome Web Store routing, `NEXT_PUBLIC_CHROME_EXTENSION_ID`). NAV02 web (`1516f23`) lacks these.
- `cb76c3d` adds only the Tracker downloads from NAV02: `TrackerClient.tsx`, `lib/api.ts`, `__tests__/tracker-documents.test.tsx`,
  `e2e/tracker-documents*.spec.ts`, `e2e/support/seed_live_tracker.py`. Neither file was touched by production's two extra commits, so the diff applies without conflict.
- Deliberately excluded: `/extension/connect` page and the `authSession.ts` route entry (not needed for downloads).
- `securityPolicy.mjs`, `siteConfig.ts`, `next.config.mjs`, `Dockerfile` are byte-identical to `a63945e` (`git diff a63945e HEAD --stat` lists none of them).

## Validation (local, `cb76c3d`)
typecheck 0 errors; eslint 0; full vitest 53 files / 1050 tests pass; `next build` with production args OK; mocked Playwright
`e2e/tracker-documents.spec.ts` 6/6 against `next start`; bundle: no secret patterns, no `api-staging`, Store ID present.
`productionCompose.test.ts`: the earlier failure was a missing git-ignored `.env` in a fresh worktree (`docker-compose.yml` has `env_file: .env`;
`docker compose config` needs no daemon). With an empty `.env` all 9 tests pass; the file was removed afterwards. Not a Compose defect.
`tracker-documents-live.spec.ts` needs a disposable `xa_live*` database and was not run.

## Staging acceptance (live, NAV02 staging web + API, disposable users 10/11, fully removed)
Scripts: `scripts/staging-tracker-acceptance/`. Real PDF/DOCX downloads, frozen vs edited source, legacy association, ambiguous/none/resume-only,
cross-account 404, unauthenticated 401, UI clicks, keyboard, mobile, failure and loading states.

## Staging candidate
`xpertapply-staging-web:stage50d-cb76c3d` = `sha256:30651fdd2fa8520c6aaa61d809ed57e7eb362de1ad879bb7452e943d1d8a62ca`
(source tarball sha256 `e3eea112…4ad`), args: staging API/site URLs, empty extension URL, production Store ID (public).
Rollback image: `xpertapply-staging-web:nav02-downloads-1516f23` (`sha256:4dfceefe…`). Deploy with `scripts/staging-web-release-50d.sh plan|apply|rollback` (root; keeps the NAV02 staging API override).

## Production build requirements (verified from the running container and image history; deploy NOT done)
`NEXT_PUBLIC_API_URL=https://api.xpertapply.com`, `NEXT_PUBLIC_SITE_URL=https://xpertapply.com`, `NEXT_PUBLIC_CHROME_EXTENSION_URL=` (empty),
`NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj`. Current web image `sha256:6b299869db426912c3017ee13a9afd7c720c73598b96a67581944ab858a5546a`
(kept as rollback). Recreate only `xpertapply-web-1`; keep the corrected API release override (in the nav02-final backup controls dir; the checkout's
`compose.nav02-api.release.yml` names the older `nav02-acf8d8b` and must not be used), the Redis preserve file, and the corrected `DATABASE_URL`.
The dry run must propose only the web recreation and effective config must differ only in `web.image`.
