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

## Stage 50E: final staging acceptance (2026-10-27, live) and production web preparation
- Deployed staging web: container `xpertapply-staging-web` on `sha256:30651fdd…62ca`, label revision `cb76c3d159519d…`; server source tarball
  sha256 `e3eea112…44ad` is byte-identical to `git archive cb76c3d apps/web` (197 files). Staging API `436c05e7…` unchanged; schema `0036`; drafting off.
- Live downloads over HTTPS (disposable users 12/13): resume and cover letter PDF+DOCX, correct magic/MIME/filenames, `private, no-store`;
  frozen snapshot ignores post-freeze edits; legacy association served; ambiguous/none/missing cover = 404 + accurate UI copy; 401 unauth; cross-account 404.
- Browser (Playwright, real staging): login, nav (dashboard/jobs/profile/tracker/pricing), 5 PDF + 5 DOCX UI downloads, filters/search, status change persisted,
  keyboard Tab/Enter/Space, loading (`Preparing…`, disabled), 500/404/409/401 states, logout clears storage, 375px no overflow. axe: only pre-existing brand
  colour-contrast findings, identical on production.
- Security parity: container CSP Report-Only header byte-identical staging vs production; no X-Powered-By; HSTS/nosniff/Referrer/Permissions/XFO come from the
  production nginx vhost (staging vhost lacks them; unaffected by a web image swap). Landing links and disabled "Add to Chrome" CTA identical to production.
  Bundle: staging API only; Store ID present; no Store URL; no secret patterns.
- Cleanup: all 34 staging tables hash-identical to pre-test. `remove_users.py` left orphan `user_profiles` (User.profile has no ORM delete cascade);
  this run's two were removed and the script now deletes profiles first. Four older orphans (ids 8–11, synthetic "Xa Fifty Cee", user_id NULL) predate 50E.
- Production candidate: `xpertapply-web:stage50d-cb76c3d-prod` = `sha256:3c1639711470ed4ab00899e3fa8e44e98d1e5a786d2b640ea8a239c0fdb315a8`
  (same tarball, production args, base layers identical to the staging candidate). Loopback smoke (throwaway container, removed): 200s, CSP identical to live
  production, production API only. Rollback tag `xpertapply-web:rollback-pre-50d` = `6b299869…`.
- Preflight/release: `scripts/production-web-release-50e.py plan|apply|rollback` (root). Uses `/home/xpertapply/apps/production` base files + Redis preserve +
  NAV02 `controls/release.yml`, env-clean with `NAV02_PROD_DATABASE_URL` from the live API (never the stale checkout override or /etc/environment).
  The old `/home/luna/apps/XpertApply` checkout that last created the web container no longer exists.
