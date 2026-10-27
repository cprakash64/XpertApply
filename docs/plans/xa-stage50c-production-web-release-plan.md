# Stage 50C: production web-only release plan (NAV02 Tracker downloads)

Status: PLAN ONLY. Nothing here has been executed against production.

## Finding that changes the plan

The production web image was **not** built from the NAV02 release commit `1516f23`.
The production checkout (`/home/xpertapply/apps/production`, owner `xpertapply`) is at `a63945e`
("harden Store ID deployment configuration", branch `release/cws-web-new04-prod`). Its web tree has two commits that
`1516f23` does not contain (`18607fc` Store routing + CSP report-only, `a63945e` Store ID config): `lib/securityPolicy.mjs`,
`lib/siteConfig.ts`, `next.config.mjs`, and the `NEXT_PUBLIC_CHROME_EXTENSION_ID` build arg (Dockerfile line 16).
`git diff a63945e 1516f23 -- apps/web` would delete `securityPolicy.mjs` and revert `siteConfig.ts`/`next.config.mjs`.

Therefore: **do not build production web from `1516f23`.** Doing so would silently drop the CSP report-only policy and
Chrome Web Store ID handling that production serves today. The staging image (built from `1516f23`) was fine for staging
only and must not be promoted.

## Approved source for production

`a63945e` + the tracker-only web patch (merge base `ceb8314e` -> `1516f23`, files below). The `/extension/connect` page and
the `authSession.ts` route entry from `b756415` are excluded: they are not part of document downloads.

Patch files (the scratchpad copy is reviewable; commit them to a branch before release):
`TrackerClient.tsx`, `lib/api.ts`, `__tests__/tracker-documents.test.tsx`, `e2e/tracker-documents.spec.ts`,
`e2e/tracker-documents-live.spec.ts`, `e2e/support/seed_live_tracker.py`.

Validated in a scratch detached worktree of `a63945e`: patch applies cleanly; lockfile identical to NAV02's;
`tsc` typecheck passes; `vitest`: 1049 passed, 1 failed. The failure is `productionCompose.test.ts` (runs local
`docker compose config`; it errored on this Mac, unrelated to the tracker files). Re-run it on a machine with Docker before release.

## Production build args (from the running image's history)

```
NEXT_PUBLIC_API_URL=https://api.xpertapply.com
NEXT_PUBLIC_SITE_URL=https://xpertapply.com
NEXT_PUBLIC_CHROME_EXTENSION_URL=
NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj
```

Verify the built bundle: contains `api.xpertapply.com`, no `api-staging`, and the CSP/Store behaviour is unchanged.

## Current production identities (read-only)

- Web `xpertapply-web-1` `e4ededfc27b1`, image `sha256:6b299869db42` (`xpertapply-web:latest`), `127.0.0.1:3000`, network `xpertapply_default`, `unless-stopped`, no health check.
- API `xpertapply-api-1` image `xpertapply-api:nav02-gated-1516f23`; worker, scheduler, Redis, Postgres up 9 days.
- Compose project `xpertapply`; files `docker-compose.yml`, `compose.production.yml`, `compose.redis-preserve.yml`, plus the corrected API release override under `/home/luna/xpertapply-production-backups/nav02-final-20261026T101651Z-nvrya78c/controls/release.yml` (not readable by `luna`; the checkout's `compose.nav02-api.release.yml` names an older image `nav02-acf8d8b`, so it must NOT be used).
- Wrapper `scripts/production-compose.sh` must run as `xpertapply`; it has an uncommitted local modification (preserve it). `xpertapply` has no Docker access, `luna` cannot read the checkout, so a root-run script is needed, as for staging.

## Steps (to run only after approval)

1. Commit the tracker-only patch on a branch from `a63945e`; run `make test-web` (with Docker available); record the commit SHA.
2. Export that commit's `apps/web` (`git archive`), copy to a luna-owned build dir, `docker build` as `xpertapply-web:nav02-downloads-<sha>` with the four args above. Record the image ID. Keep `xpertapply-web:latest` untouched as the rollback target.
3. Root-run script (modelled on `~luna/xa-web-build-1516f23/staging-web-release.sh`): project `xpertapply`, files = the three compose files + the corrected API override + a new web override containing only `services.web.image`. `plan` mode must (a) assert the effective config differs from the current one only in `web.image`, and (b) `up --dry-run -d --no-deps --no-build --pull never web` proposes recreating only `xpertapply-web-1`. Stop on any other difference.
4. Snapshot container IDs/images before and after; API, worker, scheduler, Redis, Postgres, volumes and networks must be identical; DB stays `0036_application_doc_snapshots`.
5. Smoke: `https://xpertapply.com` 200, login, Tracker loads, filters; downloads only with an authorized account (do not copy production documents anywhere).

## Rollback

Same script in `rollback` mode with an override pointing `web` at `xpertapply-web:latest` (`sha256:6b299869db42`); recreates web only.

## Not in scope

No API, migration, worker, Redis or Postgres change; no AI drafting; no extension release.
