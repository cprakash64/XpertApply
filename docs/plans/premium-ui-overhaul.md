# XpertApply premium UI/UX overhaul (Midnight Slate + Glacier Blue)

Status: implementation complete for the web app; NOT yet deployed anywhere. Staging review pending.
Branch: `feature/premium-ui-overhaul` (web only; no backend, migration, extension or production-config changes)
Base: `release/stage50d-tracker-downloads` at `939171f`, which contains production commit `a63945e`
(Store ID hardening, CSP report-only) and `cb76c3d` (tracker downloads).

## 1. Scope and non-goals

In scope: `apps/web` visual system, public pages, authenticated shell and pages.
Out of scope and untouched: `apps/api`, Alembic migrations, `apps/extension`, `packages/shared`,
Dockerfile, `next.config.mjs`, `lib/securityPolicy.mjs`, `lib/siteConfig.ts`, `lib/api.ts`,
`lib/authSession.ts`, tracker download code, VPS/production configuration.
Verified by `git diff --name-only 939171f HEAD` (every path is under `apps/web/`) and a diff of the
protected files above (no changes).

## 2. Architecture

- One token layer: `app/globals.css` semantic CSS variables, consumed through `tailwind.config.ts`
  aliases. The marketing stylesheet (`app/marketing.css`) is scoped to `.xa-theme`.
- Approved raw palette (variable names `--xa-*` are historical; `--xa-cyan*` now hold glacier values):
  navy `#25364b`, navy-hover `#1d2c3d`, glacier `#6888ad`, glacier-light `#9bb3cf`, accent text
  `#405f80`, ink `#20242b`, secondary `#596779`, muted `#5d6c81`, porcelain `#f8f9fb`, ice `#eaf0f7`,
  borders `#dce3eb` / `#c9d3df`, interactive border `#7d90a8` (3.27:1, WCAG 1.4.11).
- Glacier `#6888ad` is 3.5-3.7:1 on white/porcelain: used only for non-text UI (focus, selection,
  rails). Text uses `#405f80` (6.6:1).
- Status: success is slate (never green), info is slate-blue, warning is amber `#8a5300`, danger is
  red `#b42318`. Meaning is always carried by a label as well as colour.
- Fit-score bands (`lib/fitScore.ts`) are a single slate/glacier scale resolved through tokens; the
  label and number carry the band.
- `--glass-*` names are retained but resolve to solid card/border/overlay-shadow tokens. No
  `backdrop-filter`, `backdrop-blur`, gradients or glow remain in `app/` or `components/`.

## 3. Decisions

| Decision | Reason |
|---|---|
| Keep dark mode in the app (`prefers-color-scheme`); homepage stays light-only | Founder brief is light-first; removing dark mode is a product call. OPEN: confirm. |
| Pricing dialog now states "Pricing is not finalized yet" (same position as `/pricing`); plans, prices, limits and "Cancel anytime" removed | No billing code backs them; the founder chose the placeholder. Real plans return here only once billing exists. |
| Removed "MOST POPULAR" badge | Unsupported popularity claim. |
| Removed invented demo data (companies, fit scores, counts, "84%") from the homepage | No fabricated metrics. Demo is labelled illustrative. |
| Removed visible authoring instruction ("Replace this illustration with...") from the public homepage | It shipped publicly in the base. Replaced with an "illustrative example" caption. |
| Footer lists only working pages | Removed About/Careers/Help/Blog/Terms placeholders. |
| Stage dimming on the homepage story removed | Reduced opacity put body copy below 4.5:1. |
| `/login` uses a plain `<img>` for the 32px logo | `next/image` added ~9 KB gzip to auth routes. |
| `robots.txt` + sitemap added | Public pages only; signed-in routes, `/login`, `/signup` disallowed. |
| No structured data, no `og:image` | No image asset exists; no claims to mark up accurately. Twitter card is `summary`. |

## 4. Progress (commits after `939171f`)

1. `97ae45c` Phase 1: design tokens
2. `827a812`, `3c5cb33` Phase 2: flat homepage; neutral labelled demo
3. `8958a03` Phase 3: public page shell, footer, robots/sitemap, metadata
4. `444e091` Phase 4: fit tones, danger red, retired legacy accent
5. `9538e70` Phase 5: neutral generated company mark
6. `f785f06` Phase 6: tracker density, document pages, amber warning
7. `678d7d7` Phase 7: flat auth card, solid modal surfaces, neutral profile tiles
8. Phase 8 commit: accessibility, content and payload fixes (see section 5)

## 5. Validation (all run against a production build in a temporary `distDir`)

VERIFIED
- `tsc --noEmit`, `eslint .`: exit 0. `vitest run`: 53 files, 1054 tests pass.
- Playwright (Chromium) 34 tests pass: responsive-app-shell, jobs-workspace, jobs-cold-load,
  applied-to-tracker, tracker-documents, auth-session-expiry.
- axe-core (WCAG 2.0/2.1/2.2 A+AA tags): 0 violations on 11 routes x light and dark = 22 scans
  (`/`, `/pricing`, `/privacy`, `/opensource`, `/login`, `/signup`, `/dashboard`, `/jobs`,
  `/tracker`, `/settings`, `/profile`; signed-in routes with mocked API and synthetic data).
  The first run found 49 contrast failures on `/`, dashboard `dl` markup and dark-mode contrast; all fixed.
- WebKit 26.5 (Playwright webkit-2311, macOS): `/`, `/pricing`, `/login`, `/jobs` at 390 and 1440 px,
  8/8 pass: no horizontal overflow, no page errors, no `backdrop-filter` in use, page background
  `rgb(248, 249, 251)`; homepage and Jobs screenshots read correctly.
- Keyboard: 14 consecutive Tab stops on the homepage all show a focus style.
- No horizontal overflow at 320/390/768/1024/1440/1920 on Jobs and Tracker, and at 320/390/768/1440
  on login, signup, settings, profile.
- CSP: `Content-Security-Policy-Report-Only` header present and unchanged.
- SEO (built output): unique title, description and canonical on `/`, `/pricing`, `/privacy`,
  `/opensource`; one `<h1>` each; `robots.txt` and `sitemap.xml` correct.
- Payload, gzip (base `939171f` -> redesign): `/` JS 179 -> 179 KB, CSS 20 -> 18 KB, HTML 78 -> 72 KB;
  `/login` JS 171 -> 174 KB (+3 KB); `/pricing` JS 166 -> 166 KB, CSS 11 -> 10 KB. Static payload only.

NOT TESTED / BLOCKED
- Firefox: BLOCKED. Playwright's Firefox 151 (firefox-1532) downloaded but its launch hangs on this
  machine (timeout at 150 s; WebKit launches in ~11 s). Cause not diagnosed; macOS first-launch
  checks on the downloaded app are suspected but unconfirmed, and no security setting was changed.
  Test Firefox manually or on another machine. Edge not tested.
- Screen-reader testing; full manual keyboard walk of every dialog and editor.
- Core Web Vitals (LCP/INP/CLS): not measured; no field data.
- Profile wizard and editor forms, document preview components, Google sign-in button (disabled in
  the test environment): not visually reviewed.
- `docker compose config`, API tests, extension tests: not run (no backend or extension change).
- A normal `make test-web` build (it writes `.next`); the equivalent `next build --webpack` was run
  into a temporary directory instead.

## 6. Open issues and risks

- RESOLVED: the pricing dialog previously showed unbacked plans; it now matches `/pricing`.
  Follow-up (P3): the unused `.xa-pricing__plan*` rules remain in `app/marketing.css` and can be pruned.
- P2: dark mode vs light-only homepage; warning amber still reads warm on light; mobile marketing
  nav hamburger is not right-aligned; phone job-card density (fit badge on its own row); tablet
  "Word" download button wraps; `--xa-cyan*` variable names no longer match their values.
- P3: no `og:image`; no structured data.

## 7. Staging plan (web only)

Reuse the existing web-only mechanism `scripts/staging-web-release-50d.sh`
(`plan` read-only -> `apply` recreates ONLY `xpertapply-staging-web` with a pinned image ->
`rollback` recreates ONLY the web container with the previous image). Do not touch API, database,
DNS, billing or the extension.
1. Build an image from this branch with staging `NEXT_PUBLIC_*` build args; record its digest.
2. `plan`, review the diff, then `apply` on staging only.
3. Review the pages in section 5 on desktop, tablet and phone in Chrome, Firefox, Safari.
4. Run the tracker-download acceptance scripts in `scripts/staging-tracker-acceptance/`.
5. Confirm CSP report-only reports no new violations; confirm sign-in, job search, tracker download,
   and Chrome Web Store links still work.
6. Founder accepts the design and decides the pricing item.

### 7a. Local verification image (built, not deployed)

- Tag `xpertapply-web:premium-ui-1aff376`, id
  `sha256:bc10171bd397b416750f8a2c7f7df3e5c7b25ea1d3b4606d2aa130794f29b814`, built from
  `git archive` of commit `1aff376` (not the working folder) with `apps/web/Dockerfile`, 1.4 GB.
- Local smoke (container on a loopback port, then removed): `/`, `/pricing`, `/privacy`, `/opensource`,
  `/login`, `/signup`, `/dashboard`, `/robots.txt`, `/sitemap.xml` all 200; CSP report-only header
  present; no placeholder caption or "MOST POPULAR".
- NOT deployable as built: (1) architecture is arm64 (Apple Silicon); a typical VPS needs
  `--platform linux/amd64`. (2) It was built with EMPTY `NEXT_PUBLIC_*` args, so its canonical URL is
  the production domain and its API URL is unset. The staging image must be built with the real
  staging args (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_CHROME_EXTENSION_URL`,
  `NEXT_PUBLIC_CHROME_EXTENSION_ID`) because they are compiled into the browser bundle.
- SUPERSEDED by PUI-RC1: this image was built from `1aff376` and is stale. See
  `docs/release/PUI-RC1_RELEASE_CANDIDATE_REPORT.md` for the release-candidate commit and for why a
  new image is BLOCKED on staging configuration.
- `scripts/staging-web-release-premium-ui.sh` is a hardened draft of the 50D script
  (`NEW_IMG/NEW_ID/OLD_IMG/OLD_ID/NEW_REV` from the environment). Its guards are exercised against a
  stub docker by `scripts/test-staging-web-release-premium-ui.sh` (15 cases, no server needed). It has
  NOT been run on any real server.

### 7a-2. Staging build and preflight (PUI-STG1)

See `docs/release/PUI-STG1_STAGING_PREPARATION_REPORT.md`: a verified `linux/amd64` image
`xpertapply-staging-web:pui-b357260-amd64` exists locally (not pushed); status BLOCKED on privileged staging access,
staging noindex headers, the extension-ID decision and host-side image identity. The script now also enforces the
staging wrapper's default-context and `staging_guard.py rendered-config` checks (18 stub tests).

### 7b. Operator steps (run on the staging host by the operator)

1. Build `linux/amd64` with the real staging args; record `docker image inspect -f '{{.Id}}'`.
2. Record the id and tag of the image staging runs today (the rollback target).
3. `export NEW_IMG NEW_ID OLD_IMG OLD_ID NEW_REV` (NEW_REV = the full commit sha the image was built from;
   the script checks the image's `org.opencontainers.image.revision` label), then `sudo -E bash staging-web-release-premium-ui.sh plan`;
   expect "effective config identical except web.image" and only `xpertapply-staging-web` recreated.
4. `apply`; expect "all other containers unchanged" and `web http=200`.
5. Review, then either keep or `rollback`.

## 8. Production web-only rollout and rollback (after explicit founder approval only)

Rollout: merge this branch onto the production release line, build the web image, deploy only the
web container with a pinned digest, smoke-test `/`, `/login`, `/jobs`, `/tracker` download,
`/robots.txt`, `/sitemap.xml`, and watch CSP reports and error rates.
Rollback: recreate the web container from the previous pinned image digest (the script's `rollback`
mode). No data migration is involved, so rollback is stateless and does not affect user data.
The extension is not part of this release.
