# PUI-STG1: staging build, configuration validation and release preflight

**Final status: BLOCKED.**

A verified `linux/amd64` image now exists locally and the draft deployment script is hardened and stub-tested.
The release is blocked because four required conditions cannot be established from the access available in this
stage (details in section N). Nothing was deployed, restarted, migrated, pushed or modified on any server.

Legend: **VERIFIED** (observed or ran) / **NOT VERIFIED** / **BLOCKED**.

## A. Repository and commit verification

- VERIFIED: root `/Users/cprakash/Documents/Jobs/XpertApply`; branch `feature/premium-ui-overhaul`; HEAD `58ea83e` at the start; tracked tree clean.
- VERIFIED: `a63945e`, `cb76c3d`, `b357260`, `58ea83e` are all ancestors of HEAD; `b357260` is the single tested web source.
- VERIFIED: `58ea83e` changes only `docs/plans/premium-ui-overhaul.md`, the RC report and `scripts/test-staging-web-release-premium-ui.sh`.
  `git diff b357260 HEAD -- apps/web` is empty, and no Dockerfile or Compose file changed. No deployment-relevant drift.
- The image was built from `git archive b357260 apps/web` (204 files, 0 env-like files), not from the working folder.
- Changes made in this stage (not yet committed when this section was written): `scripts/staging-web-release-premium-ui.sh`,
  `scripts/test-staging-web-release-premium-ui.sh`, this report, a plan-doc pointer. No web source change.

## B. Existing-work preservation

- VERIFIED: `release/chrome-web-store` = `e1affbf`; `wip/pre-ui-overhaul-20261027` = `3cbd4c7` (31 files, +2852/-4 vs `e1affbf`).
- VERIFIED present and untouched: `jobpilot-ai/` (64 KB, 5 files), `.git-stray-reinit-backup/` (20 MB, 1816 files), `apps/api/.venv 2` (empty),
  and the external git directory `~/.xpertapply-runtime/XpertApply-git-20260902-162256` (23 MB).
- VERIFIED: the screenshot evidence still exists, `docs/release/evidence/pui-rc1/` (209 files, 14 MB), untracked and not ignored.
  It holds only synthetic data, so nothing needs removing.
- No Git cleanup, reset, stash, merge, prune or relocation. No data loss detected.
- The external git directory is still a single point of failure for all history; no copy was made in this stage.

## C. Staging host identity and architecture

Access used: the existing SSH alias `xpertapply`, which logs in as the **unprivileged `xpertapply` user** (the account the staging
runbook says owns the staging infra directory). Read-only commands only, strict host-key checking, batch mode. The `vps-admin`
alias (user `luna`, the production operator) was deliberately **not** used.

| Item | Result |
|---|---|
| Host | `srv738314`, the **same machine that runs production** (VERIFIED) |
| OS / kernel | Ubuntu 24.04.2 LTS, Linux 6.8.0-147-generic (VERIFIED) |
| CPU architecture | **x86_64** → target platform `linux/amd64` (VERIFIED) |
| Capacity | 4 CPUs, ~16 GB RAM (VERIFIED) |
| Account groups | `xpertapply`, `users`; **not** `docker` and not root (VERIFIED) |
| Staging stack | Compose project `xpertapply-staging`; services postgres, redis, api, worker, scheduler, web; containers `xpertapply-staging-*` (VERIFIED from `compose.staging.yml`) |
| Staging web | service `web`, container `xpertapply-staging-web`, `127.0.0.1:3001` → 3000, network `xpertapply-staging-edge` only (VERIFIED) |
| Networks / volumes | `xpertapply-staging-internal` (internal, no route out), `xpertapply-staging-edge`; named volumes `xpertapply-staging-*` (VERIFIED) |
| Staging checkout | `/home/xpertapply/apps/staging` at `acf8d8b`, branch `integrate/xa-core1-backend-onto-prod-ceb8314` (VERIFIED) |
| Staging domains | web `https://staging.xpertapply.com`, API `https://api-staging.xpertapply.com`; both answer HTTP 200 over TLS (VERIFIED) |
| Docker Engine version/architecture, current staging image id, running container identity | **NOT VERIFIED**: needs the docker group or root |

## D. Configuration source verification (`NEXT_PUBLIC_*`, public by design)

Authoritative sources read: the host's `compose.staging.yml`, the non-secret keys of the host's `.env.staging` (19 keys exist; only
hostnames, ports, origins and extension ids were printed), the host `RUNBOOK.md` / `DNS-TLS.md`, `docs/plans/xa-stage50d-…md`, and the **live staging
site's public JavaScript** (what the running build actually embeds).

| Variable | Value used | Source and checks |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api-staging.xpertapply.com` | `compose.staging.yml` default + `STAGING_API_HOST` in `.env.staging` + live bundle embeds the same. Staging-specific; not production. VERIFIED |
| `NEXT_PUBLIC_SITE_URL` | `https://staging.xpertapply.com` | `STAGING_WEB_HOST` + compose default + live canonical. Matches `CORS_ORIGINS`. VERIFIED |
| `NEXT_PUBLIC_CHROME_EXTENSION_URL` | empty | compose passes `""`; live bundle contains no store URL; the 50D record says "empty extension URL". VERIFIED |
| `NEXT_PUBLIC_CHROME_EXTENSION_ID` | `gnibjomjfdobadlockphjiibbpmiehcj` | **Carried forward, with an unresolved conflict (below).** |

**Extension ID conflict (needs a decision, not a guess):**
- The live staging web embeds `gnibjom…`, the production Chrome Web Store ID, and the 50D record says the staging candidate used "production Store ID (public)".
- The staging **compose file passes no ID at all** (a host-side build would produce none, which disables web→extension routing).
- The staging **API allowlist** is `EXTENSION_ALLOWED_IDS=["cglmdonbfbadfbggkpajpkjgpekhkall"]`, and the runbook says it "must be the id of the unpacked build under test... No other id is accepted."
  `cglmdonb…` appears nowhere in this repository. The web app uses the ID for browser-routed web→extension messaging.
- Consequence: with `gnibjom…` baked in, website extension detection on staging targets the Store build, whose requests the staging API would refuse; with `cglm…`
  it would target the unpacked test build. I chose `gnibjom…` because it is what the running staging site already embeds (no behavior change from today).
  Nothing was assumed about which extension QA will use; this must be decided before extension QA (section L).

No secrets are placed in any `NEXT_PUBLIC_*` value and no production API endpoint was substituted. OAuth configuration was not touched.

## E. `NEXT_PUBLIC_*` validation status

API URL, site URL and extension URL: **VERIFIED** (staging-specific, defined, build-time, browser-safe). Extension ID: **VERIFIED as the current live value; alignment with the staging API allowlist UNRESOLVED**.
Also VERIFIED on the live staging API: `/auth/providers` returns `{"google":{"enabled":false}}`, so **Google sign-in is disabled on staging**.

## F. Docker image build evidence

- Dockerfile (unchanged): `node:20-alpine`, single stage, `npm ci` (includes dev dependencies), `COPY . .`, four build args become `ENV`, `npm run build`
  (`next build --webpack`), `CMD npm run start -- --hostname 0.0.0.0` (not standalone output), no `USER` (runs as root).
  Public values are embedded at build time; changing them at runtime has no effect.
- Environment-file handling: the build context was an archive of tracked files (0 `.env*` files). `.dockerignore` now also excludes `.env.*` (added in `b357260`).
- Command: `docker buildx build --platform linux/amd64 --load` with the four values above, labels
  `org.opencontainers.image.revision=b35726083516ac8bb23f46fb51932eb4dd36a823`, `…source=feature/premium-ui-overhaul`, tag
  `xpertapply-staging-web:pui-b357260-amd64`. Exit 0 under Docker Desktop's amd64 emulation. **No fallback to host architecture. Not pushed. Not uploaded.**
- Inspected, not assumed:
  - platform `linux/amd64`; `uname -m` inside the container prints `x86_64`; Node v20.20.2; 9 layers; ~340 MB.
  - labels present with the full source sha. Environment: only the four `NEXT_PUBLIC_*` values are printed; every other variable shown by name only.
  - **0** `.env*` files under `/app` outside `node_modules`; secret-pattern scan (private keys, `sk-…`, AWS, Slack, GitHub, Google API keys) of `.next`, `public`, `package.json`: **no hits**.
  - `public/brand/xpertapply-logo-256.png` present; `.next/BUILD_ID` present.
- Local run (amd64 emulation, loopback port, container removed): `/`, `/pricing`, `/privacy`, `/opensource`, `/login`, `/signup`, `/dashboard`, `/robots.txt`,
  `/sitemap.xml` all 200. Canonical and `og:url` = `https://staging.xpertapply.com`. Embedded API origin `https://api-staging.xpertapply.com`; embedded id `gnibjom…`.
- NOT VERIFIED: that this image runs on the real staging host (different kernel/Docker version), and image behavior behind staging nginx and TLS.

## G. Image platform and provenance

| Property | Value |
|---|---|
| Local tag (immutable by convention: commit in the name) | `xpertapply-staging-web:pui-b357260-amd64` |
| Local image id (Docker Desktop containerd store; this is the **index** digest) | `sha256:c5e12c4efd1e011b8094ca1e2d73583215d36abd5346955ead8453c559a68419` |
| amd64 manifest / config digest (from the build log) | `sha256:5c220341f99df69ee2617fcb79bf4a51d20c39c37441b0557ccf8b36ddea70bc` / `sha256:4966b0024452d234f8cd26d77b3e06fc0d48b2e08674fc6fa772ffeacca9fba4` |
| Source | `b35726083516ac8bb23f46fb51932eb4dd36a823` (label) |
| Platform | `linux/amd64` |

**Important:** `docker image inspect .Id` differs between Docker's image stores (an index digest here, usually the config digest on a classic store after `docker load`).
The deployment script compares `NEW_ID` against the **host's** `docker image inspect -f '{{.Id}}'`, so the operator must record `NEW_ID` on the host after transferring the image.
The older local image `xpertapply-web:premium-ui-1aff376` is `arm64` and stale; do not use it.

## H. Deployment script assessment (`scripts/staging-web-release-premium-ui.sh`)

Earlier fixes confirmed still present: private temp dir and 0600 files for resolved config, `NEW_REV` vs the image's revision label, same OS/architecture as the current image,
compose `web` must be `xpertapply-staging-web`, API override must exist, and a changed non-web container aborts with exit 2 (the `a && b` errexit bug).

**New gap found and fixed in this stage:** the repository's own staging wrapper `infra/staging/staging-compose.sh` refuses a non-default Docker context, refuses `DOCKER_HOST`, and pipes the rendered
configuration through `staging_guard.py rendered-config` (forbidden published ports including production's 3000 and 8020, allowed service list, staging name prefixes, no production paths). Our script cannot use
the wrapper (it must layer the API override file) and silently skipped all three. It now enforces the same three checks.

Branches reviewed:
- `plan`: runs `docker compose config` twice and `up --dry-run` (no containers changed). Its only writes are `staging-web.release.yml` and `staging-web.rollback.yml` (0600) beside the script and a temp dir that is removed on exit.
  Needs root and Docker; **was not executed**.
- `apply` / `rollback`: recreate only the `web` service with `--no-deps --no-build --pull never`, snapshot all containers (production included) before and after, exit 2 if any non-web container differs, then probe `127.0.0.1:3001`.
  Not executed (forbidden in this stage).

Tests: `scripts/test-staging-web-release-premium-ui.sh`, **18/18 pass** against a stub docker (adds guard-refusal, context and `DOCKER_HOST` cases). These prove the script's decision logic, not that a real
Compose run will succeed; the real `staging_guard.py` may refuse the merged configuration, which would safely abort `plan`.

Remaining limits: a recreate causes brief staging downtime; a failed `up` leaves staging without a web container until `rollback`; the stub tests do not exercise real Compose semantics; the script lives in this branch, so the
operator must copy it to the host and review it there.

## I. Staging PLAN results

**NOT RUN. BLOCKED at the access boundary.** `plan` requires root and Docker on `srv738314`. The only authorized access available is the unprivileged `xpertapply` account, which is neither. I did not use
the production operator account or any sudo path. To run it, the operator must supply `NEW_IMG`, `NEW_ID` (recorded on the host), `NEW_REV=b35726083516ac8bb23f46fb51932eb4dd36a823`, `OLD_IMG` and `OLD_ID`.

## J. Production/staging isolation assessment

VERIFIED from the host's files and the live site:
- Separate Compose project, container prefix, named volumes, internal network (no route out), and loopback-only ports (staging 3001/8021; production 3000/8020). The staging stack is "self-contained on purpose", with every variable listed explicitly and no `env_file`.
- Staging has its own `SECRET_KEY` and keys (the guard requires they differ from production, and it checks this automatically in the wrapper); `GOOGLE_OAUTH_ENABLED=false`, job ingestion, people providers and AI are off; CORS allows only the staging origin; DNS is staging-specific.

NOT VERIFIED / FINDINGS:
1. **Staging is currently indexable.** The live `staging.xpertapply.com` and `api-staging.xpertapply.com` send **no `X-Robots-Tag`** header, although the repo's nginx template sets `noindex, nofollow`; `robots.txt` and `sitemap.xml` currently return 404.
   **This build changes that:** it serves `robots.txt` with `Allow: /` and a sitemap listing the staging URLs (`https://staging.xpertapply.com/…`) because `NEXT_PUBLIC_SITE_URL` is the staging origin. Deploying it as-is would actively advertise staging to crawlers.
   Required before apply: the `X-Robots-Tag: noindex, nofollow` header must be live on the staging web vhost (operator action in nginx, outside this repository). No code change was made, per this stage's rules.
2. The records disagree on where production lives: `docs/deployment.md` and `scripts/production-compose.sh` say `/home/luna/apps/XpertApply`; the staging runbook and guard say `/home/xpertapply/apps/production` (a checkout at `a63945e` exists there). The guard's production-path refusals cover the second path.
3. Production database/firewall isolation from the production side, and that a staging token is refused by production, were **not** verified (the runbook itself lists these as needing separate authorization).

## K. Rollback readiness

- NOT VERIFIED: the currently running staging web image and its id, and whether a previous image is retained. The 50D record lists `xpertapply-staging-web:nav02-downloads-1516f23` (`sha256:4dfceefe…`) as the earlier rollback image and
  `stage50d-cb76c3d` as the later candidate; which of these is running now cannot be seen without Docker access. No deploy snapshot files (`before.*.txt`) are visible to the staging account.
- The runbook's own rollback (section 14) is for code and data (`git checkout` + rebuild; restore a dump into a new database), not for a prebuilt web image. A Git checkout alone does **not** restore a deployed container.
- The script's `rollback` restores the previous image by id, but only if `OLD_IMG`/`OLD_ID` are recorded **before** apply and the old image is still on the host. Web-only change: no database or API change, so rollback is stateless.
- Rollback was not executed.

## L. Remaining risks

1. Staging indexing exposure (section J.1): blocks apply until the noindex header is live.
2. Extension ID decision (section D): `gnibjom…` baked vs API allowlist `cglm…`; extension QA on staging may fail detection or authentication until aligned (an API-side or web-side configuration choice, not a code change).
3. Google OAuth is disabled on staging, so the Google button will not render and the OAuth flow cannot be tested on staging at all.
4. Image identity must be re-recorded on the host (index vs config digest); the image was built under emulation, not on the target, and is untested on the real host.
5. The image runs as root, ships dev dependencies, tests and source (pre-existing Dockerfile design) and is ~340 MB.
6. This web line does not include the `/extension/connect` page that the runbook's "website integration" stage refers to (excluded deliberately in 50D), so extension handoff pages are not part of this release.
7. Conflicting production-path records; single point of failure for the external git directory; staging and production share one host (a resource or operator-error blast radius, mitigated by the guards above).
8. Firefox/Edge/screen-reader gaps from PUI-RC1 remain.

## M. Post-deployment QA checklist (run after a future, separately authorized apply)

Use synthetic staging accounts only; never submit a real job application. Record screenshots to a dated evidence folder and measure performance on the deployed site.

**Public site:** homepage, pricing (dialog and page), nav and anchors, footer links, `/privacy`, `/opensource`; metadata, canonical = staging origin; `robots.txt`/`sitemap.xml`; confirm `X-Robots-Tag: noindex` on every public path and on the API host.
**Authentication:** signup, login, logout, session persistence across reload and tabs, expired-session recovery, wrong-password and duplicate-email errors. **Google OAuth: not testable on staging** (`google.enabled=false`); verify the button is absent and the callback error page offers "Back to sign in"; plan OAuth validation separately.
**Application:** dashboard (empty and populated), Find Jobs (filters, sort, search, long titles), job detail and materials, save/mark applied, tracker (status change, document downloads), profile and wizard (all steps, validation, save, import), resume and cover-letter generate/preview/edit/download (AI is off on staging, so expect the documented degraded behavior), settings (Workday credential, export), logout.
**Integration:** web↔API connectivity from the browser console (no mixed content, CORS passes for the staging origin only); network panel shows only `api-staging` requests; extension detection with whichever extension ID is decided; autofill-is-not-submission boundary and manual-submission wording unchanged; existing staging data intact.
**Accessibility:** keyboard-only pass on every page and dialog, visible focus in light and dark, 200% and 400% zoom reflow, reduced motion, VoiceOver sample on login, jobs and a dialog; axe on key pages.
**Browsers:** Chromium, Safari/WebKit, Firefox (manual; blocked in automation on the dev machine), Edge.
**Responsive:** 320, 390, 768, 1024, 1440, 1920 on dashboard, jobs, tracker, profile, document modals.
**Performance:** Lighthouse/lab and a real mobile profile against the deployed origin; compare with the RC lab numbers; check cache headers and any CDN/purge.
**Operational:** container health, `docker logs` for the web container, CSP report-only reports, no production container IDs changed (script's snapshot diff), and a rehearsed rollback to `OLD_IMG` immediately after the first successful apply.

## N. Final recommendation

**BLOCKED.** What is done and verified: source provenance, a correct-architecture local image whose embedded public configuration matches the running staging site, no embedded secrets, a hardened and stub-tested script, and a documented host
layout showing staging is separated from production by project, ports, network and secrets. What blocks apply, with no source change needed:

1. **Plan not executed and rollback unverified** (privileged access): need root/Docker on `srv738314` to record `OLD_IMG`/`OLD_ID`, transfer the image, record `NEW_ID`, and run `plan` (expecting "effective config identical except web.image" and a guard pass).
2. **Staging indexing protection absent** while this build adds `robots.txt` Allow and a staging sitemap: enable `X-Robots-Tag: noindex, nofollow` on the staging web (and API) vhosts first.
3. **Extension ID decision** between `gnibjom…` (current, baked in) and the staging allowlist's `cglm…`, plus API allowlist alignment if the Store build will be tested on staging.
4. **Docker store identity**: re-record the image id on the host; confirm the amd64 image runs there.

Once those are cleared, re-run `plan` and re-issue this status. Not production readiness. No deployment, push, restart or server modification was performed. I read only from the host (an unprivileged account) and from the public staging site.
