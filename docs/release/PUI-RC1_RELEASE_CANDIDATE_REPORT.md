# PUI-RC1: Premium UI release-candidate report

**Final status: READY_FOR_STAGING** (web only; with the conditions in section R). This is NOT production
readiness. Nothing was deployed, pushed, or run on any server.

Release-candidate **source commit: `b357260`** (`b35726083516ac8bb23f46fb51932eb4dd36a823`) on
`feature/premium-ui-overhaul`. Every automated result below was produced from a `git archive` of exactly that
commit (built and tested in a scratch directory), not from the working folder. The commit that adds this report,
the staging-script test and the plan-doc update changes no web source.

Legend: **VERIFIED** (ran and passed) / **NOT VERIFIED** (did not run, or cannot be inferred) / **BLOCKED** (cannot
proceed without something outside this repo).

## A. Verified repository state

- VERIFIED: git root `/Users/cprakash/Documents/Jobs/XpertApply` (capital J). Branch `feature/premium-ui-overhaul`.
  HEAD at the start of this stage was `4d2ce3a`; tracked tree clean.
- VERIFIED: `a63945e` (Store ID hardening) and `cb76c3d` (tracker downloads) are both ancestors of HEAD.
- VERIFIED: 12 commits sit between base `939171f` and the handover HEAD `4d2ce3a`; this stage added 5 more (section C).
- Untracked items that pre-existed and were not touched: `jobpilot-ai/` (64 KB), `.git-stray-reinit-backup/`
  (20 MB), `apps/api/.venv 2` (empty), and three `apps/extension/dist-*` build folders.
- `git worktree list` shows 4 entries: this checkout (whose git dir is `~/.xpertapply-runtime/XpertApply-git-20260902-162256`)
  and 3 `prunable` stale temporary worktrees under `/private/tmp`. None were created, removed or pruned.
- The repo's git directory lives outside the project folder. That is a single point of failure for all history.

## B. Protected-work preservation evidence

- `wip/pre-ui-overhaul-20261027` = `3cbd4c7`, parent `e1affbf` (the `release/chrome-web-store` tip, which is an
  ancestor of the wip commit).
- VERIFIED by content, not by branch name: the commit holds **31 files (30 added, 1 modified)**, 2852 insertions
  and 4 deletions. The modified file, `scripts/e2e-gate.sh`, is **+43/−4**, which matches the dirty diff recorded
  at the start of the original session (43 insertions, 4 deletions). Spot-checked present in the commit tree:
  `apps/api/alembic/versions/0027_application_applied_lifecycle.py`,
  `apps/extension/src/fields/eeoMapping.ts`, `apps/extension/src/__tests__/eeo_mapping.test.ts`,
  `apps/web/components/BrandLogo.tsx`, `apps/web/app/icon.svg`, `apps/extension/e2e/zz-audit-harness.ts`.
- NOT VERIFIED: byte-for-byte equality of the 30 added files with the pre-switch originals. They were committed
  directly from disk and no independent copy exists to compare.
- RISK: `jobpilot-ai/`, `.git-stray-reinit-backup/` and `apps/api/.venv 2` were deliberately excluded from the
  commit (nested Git metadata and an empty folder). They exist only as untracked files on this disk.
- No reset, stash, merge, rebase, delete or branch switch was performed in this stage.

## C. Current HEAD and commits made in this stage

```
b357260 fix(web): review-step overflow at 320px, dialog focus return, dockerignore env files   <- RC source
dbcceec chore(release): harden the draft staging web script
b543428 fix(web): mobile nav alignment, opaque pricing dialog, CSS cleanup, lighter logo
40beb42 fix(web): phone job cards, tracker Word button, modal keyboard access, wizard overflow
c2db289 fix(web): remove the unbacked 'free' claim from homepage CTAs
```

## D. Files changed since `4d2ce3a` (25 files, +380 / −225)

Web source: `app/auth/google/callback/page.tsx`, `app/globals.css`, `app/marketing.css`,
`components/{AppShell,AuthDialog,ProfileWizard,PublicPage,TrackerClient}.tsx`,
`components/jobs/{ApplyButton,JobCard,badges,documents}.tsx`,
`components/marketing/{BrandWordmark,FinalCta,Hero,MarketingNavbar}.tsx`, new `lib/useDialogFocus.ts`,
new `public/brand/xpertapply-logo-256.png`, `.dockerignore`.
Tests: `__tests__/{design-system-tokens,landing-page,tracker-documents}.test.tsx|ts`, new
`__tests__/use-dialog-focus.test.tsx`, new `e2e/premium-ui-rc-regressions.spec.ts`.
Release tooling: `scripts/staging-web-release-premium-ui.sh`; this report adds
`scripts/test-staging-web-release-premium-ui.sh` and edits `docs/plans/premium-ui-overhaul.md`.
No backend, migration, extension, shared-package, Dockerfile or production-config file changed.

## E. Pricing verification

- VERIFIED against the repo: `git grep` finds no billing, subscription, plan, price or quota logic in `apps/api` or
  `apps/web`. The only quota is a people-discovery daily quota. There is no plan data source. So "pricing is not
  finalized" matches the repository configuration.
- VERIFIED: `/pricing` and the dialog say the same thing (open-source MVP is free to run locally; hosted pricing is a
  placeholder). No plan names, prices, limits, "Cancel anytime" or "Most popular" remain (unit assertion in
  `landing-page.test.tsx`).
- **Found and fixed:** "Get started free →" appeared four times (navbar twice, hero, final CTA). It is a free-hosted
  claim the product does not back and sat beside a "pricing not finalized" message. It is now "Get started →".
  This is a copy change on approved homepage text and is trivially reversible (`c2db289`).
- **Found and fixed:** the dialog's final CSS override made its background 94% opaque, so page content showed through.
  Computed on the final build: `background rgb(252, 253, 254)`, `opacity 1`.
- VERIFIED on the final build, at 390 and 1440 px: `role=dialog`, `aria-modal=true`, labelled, focus enters the
  dialog, still inside after 3 Tabs, Escape closes. axe: 0 violations on `/pricing` (light and dark).
  Pricing unit tests (4) pass.
- NOT VERIFIED: the business intent beyond the repo. The founder chose the placeholder during the earlier session.

## F. Responsive corrections

Regression spec `e2e/premium-ui-rc-regressions.spec.ts` (6 tests, passing on Chromium and WebKit):

| Defect | Root cause | Result |
|---|---|---|
| A. Mobile hamburger not right-aligned | A later `.xa-nav { justify-content: flex-start }` override parked it by the logo | `margin-left:auto`; 44×44 px target; right edge within 16 px of the bar edge; opens/closes by keyboard; no overflow |
| B. Tall phone job cards | The 96 px fit badge stacked as its own block; actions wrapped unevenly | Badge is one row (<48 px); Apply spans the width; 4 secondary actions in a 2-column grid, each ≥40 px; card 402 px tall (short title) / 453 px (long title) at 390 px |
| C. Tablet "Word" wraps | Two-column document grid squeezed each cell below the width of both buttons | Documents stack until `xl`; "Word" stays on the same row at 768/900/1024/1180 px |

- Before-height of the phone job card was not measured. About 60 px of savings is INFERRED from the removed badge geometry.
- Additional defects found by the broad review and fixed: `/profile/review` overflowed 88 px at 320 px (a JSON `<pre>`
  widened a CSS grid track; fixed with `minmax(0,1fr)`); document-preview and profile-import modals had no
  `role=dialog`, no Escape, no focus handling (new `useDialogFocus`); Google callback error page had no way back;
  `aria-label` on a `<p>` (axe `aria-prohibited-attr`); focus now returns to the "Resume" button even though it is
  disabled while generating.
- Cleanup done after reference checks: removed the unused `.xa-pricing__plan*` rules and the decorative dialog
  `::before` blob; renamed `--xa-cyan*` to `--xa-glacier*` (3 files, no other references).
- **og:image: NOT ADDED.** The only brand asset is `xpertapply-logo.png` (1448×1086, 4:3, 813 KB) and it carries the
  line "Apply smarter. Get hired." (an outcome promise). It is neither the right size nor a safe message. A purpose-made
  1200×630 asset is needed from design. The Twitter card is `summary`.

## G. Screenshots and viewport matrix

- 209 screenshots, 14 MB, from the final build: `docs/release/evidence/pui-rc1/` (**untracked by design**, since the
  repo tracks no images; commit them only if you want them versioned).
- Matrix: 30 page/state combinations x 6 widths (320, 390, 768, 1024, 1440, 1920) = 180 captures, plus 29 interaction
  and dark-mode captures. Synthetic data only. Pages: home, pricing, privacy, opensource, login, signup, Google
  callback error, dashboard (data/empty/error), jobs (data/empty/error), tracker (data/empty), profile, profile
  edit/import/personal/preferences/experience/skills/review, application-preferences, EEO, settings, resume,
  cover-letter, application-answers, demographics. Interactions: login validation, 401, signup 409, pricing dialog,
  mobile nav open, job detail and materials, resume preview, cover-letter preview and editor, dark mode.
- VERIFIED programmatically across all 180: horizontal overflow 0, controls cut off outside an intentional scroll
  container 0, page errors 0. (Two intentional horizontal-scroll chip bars exist: the homepage workflow switcher and the tracker filters.)
- **Honest scope of human inspection:** I personally looked at 8 images from the final build (pricing dialog 390,
  profile review 320, tracker 1024, cover-letter editor 390, dark dashboard 1440, profile edit 390, home 1920, jobs 390)
  and 8 from the previous build. The other images were checked by script only.
- NOT VERIFIED: empty-state quality at every width, long-title wrapping beyond the cases viewed, resume editor edit mode.

## H. Dark-mode verification

- VERIFIED: axe (WCAG 2.0/2.1/2.2 A+AA tags) is clean on all 30 pages in dark scheme; dark dashboard (final build)
  and dark tracker (previous build) viewed; status colors remain labelled.
- NOT VERIFIED: keyboard focus visibility in dark mode (the focus check ran in light only). Dark mode on the public
  homepage does not apply by design (light-only).

## I. Automated test results (all from the `b357260` archive)

| Check | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| `eslint .` | exit 0 |
| Vitest | 54 files, **1057 tests pass** (a clean checkout needs an empty `.env` for the compose test; that test depends on a gitignored file) |
| Production build `next build --webpack` | exit 0, scratch directory (the active `.next` was never touched) |
| Chromium e2e (repo suite) | **46 passed, 0 failed, 17 skipped** (skips are specs that need a live backend stack) |
| WebKit e2e (same suite) | 45 passed, **1 failed**, 17 skipped |
| axe, 30 pages x light and dark | 60 scans, **60 clean** |
| Staging-script guard harness | 15/15 pass (stub docker) |

- The 1 WebKit failure is `responsive-app-shell.spec.ts` "exact breakpoint boundaries" (mobile menu still visible after a
  639→640 px resize). It **fails identically on the base commit `939171f`** (pre-existing, not a regression), and an independent
  WebKit probe showed correct behavior at 640 px. Classified NONBLOCKING; the cause in the spec's harness is not diagnosed.
- **Firefox: BLOCKED.** One allowed debug-logged attempt: Playwright's Firefox 151 launches, then logs a macOS
  `sandbox_extension_issue_file_to_process` failure and a `RenderCompositorSWGL failed mapping default framebuffer`
  graphics error, then hangs. No quarantine attribute is present. No further retries; the sandbox was not loosened.
- **Edge: NOT VERIFIED** (not installed).
- The 17 live-stack e2e specs (profile-and-theme, people-*, tracker-documents-live, etc.) were skipped, not passed.

## J. Accessibility results

- VERIFIED: axe 0 violations on 60 page/scheme scans. The first full run (before fixes in this stage) had found
  `aria-prohibited-attr` on the pending-score `<p>`; fixed.
- VERIFIED (Tab-order focus styling, light mode): 8 pages, 12-14 stops each, 0 without a focus style. Pricing dialog,
  resume preview and cover-letter preview: dialog semantics, focus entry, Tab trap (pricing + hook unit test), Escape,
  focus return.
- **Do not read this as WCAG compliance.** axe covers a fraction of the criteria. NOT VERIFIED: screen readers (VoiceOver
  was not driven), full manual keyboard walkthrough of every editor, zoom/reflow at 200-400%, reduced motion, target-size
  audit beyond the three controls fixed, dark-mode focus rings.

## K. Performance comparison (lab, Chromium, 390x844 @2x, localhost, no network latency; NOT field data)

| Route | Base `939171f` | RC | Note |
|---|---|---|---|
| `/` image | 794 KB (`xpertapply-logo.png`) | **37 KB** (256 px derivative) | -757 KB |
| `/` JS / CSS (compressed) | 155 / 21 KB | 154 / 19 KB | flat / -2 KB |
| `/` LCP / CLS | 84 ms / 0.000 | 68 ms / 0.000 | lab medians of 5 |
| `/` CPU @4x throttle, median of 11 alternating | task 415 ms, script 154, layout 100 | task 399, script 145, layout 98 | DOM nodes 1500 → 1242; measured on the build before the final link-prefetch change (homepage code unchanged since) |
| `/login` JS / CSS / image | 137 / 12 / 0 KB | 141 / 11 / 37 KB | +4 KB JS (`next/link`), new 37 KB logo; 11 → 13 requests |
| `/pricing` JS / CSS | 146 / 21 KB | 141 / 11 KB | requests 17 → 29 (small-page link prefetch); LCP median 44 vs 52 ms, 15 alternating runs, distributions overlap |

- No font requests on any route (system stack). The earlier "179 KB gzip homepage JS" figure was the sum of all script
  responses on first load; it is consistent with the 154-155 KB measured here (different measurement method).
- An early TBT reading that looked 3x worse was ordering noise: alternating runs showed equal or lower main-thread time.
- Prefetch bytes from links to `/` were removed (`prefetch={false}`); they had inflated `/login` and `/pricing`.
- NOT VERIFIED: real-user LCP/INP/CLS (no field data), mobile-network throttling, INP beyond a menu-toggle proxy,
  authenticated-page performance. The 813 KB original logo remains in `public/` for non-UI uses.

## L. SEO verification (built output)

- VERIFIED: `/`, `/pricing`, `/privacy`, `/opensource` have unique titles, canonicals and exactly one `<h1>`; Twitter card
  matches the Open Graph tags. `robots.txt` allows `/` and disallows all signed-in routes plus `/login`, `/signup`;
  `sitemap.xml` lists exactly the four public pages. No `og:image`, no JSON-LD (nothing accurate to mark up).
  `Content-Security-Policy-Report-Only` header present.
- Authenticated routes: server HTML for `/dashboard` is only "Checking your session…" (no user data); auth is client-side.
- GAP (P3): app and auth routes rely on `robots.txt` alone. They have no `noindex` meta, and `/login`/`/signup` carry the
  generic site title. Recommend adding `robots: { index: false }` metadata to those routes after staging.
- NOTE: HTML pages are served with `Cache-Control: s-maxage=31536000` (Next static default). If a CDN sits in front of
  production, plan a cache purge for the release and the rollback.

## M. Authentication and editor workflow coverage

- VERIFIED (mocked API, synthetic data): login empty-field errors, login 401 message, signup 409 message, Google button
  rendered when the providers endpoint reports it enabled, Google callback error state (now with "Back to sign in"),
  session-expiry e2e, dashboard/jobs/tracker/profile load states, resume and cover-letter preview, cover-letter edit mode.
- **Google sign-in: NOT TESTED end to end.** No authorized non-production OAuth configuration or test account was used or
  available, and nothing was bypassed. **Staging verification to run:** with a real test Google account on the staging origin,
  (1) click Continue with Google, (2) complete consent, (3) land on `/dashboard`, (4) repeat with an email that already has a
  password account to see the link-by-password step, (5) deny consent to see the error page and "Back to sign in".
- NOT VERIFIED: profile wizard field validation and save, resume-editor edit mode, file-upload import, real document
  generation, Workday credential entry, and the extension handoff.

## N. Staging script safety assessment (`scripts/staging-web-release-premium-ui.sh`)

Reviewed against `staging-web-release-50d.sh` and section 7b of the plan doc. Not executed on any server.
Defects found in the draft and its 50D ancestor, now fixed in the draft:

1. The resolved compose config (which contains environment values) was written to `cfg.*.json` beside the script with the
   default umask. It is now in a private `mktemp -d`, removed on exit; `umask 077`; generated files are 0600.
2. No source-provenance check. It now requires `NEW_REV` (40-char sha) to equal the image's
   `org.opencontainers.image.revision` label, and the new and old images to share the same OS/architecture.
3. No assertion that the compose `web` service is the staging container. It now aborts unless `container_name` is
   `xpertapply-staging-web`; `INFRA` files and the API override file must exist.
4. **Errexit bug:** `diff ... && echo "all other containers unchanged"` is exempt from `set -e`, so a changed
   production/staging container would NOT have aborted the run. It is now an `if` that exits 2. (The 50D script still has this bug and was not edited.)

Isolation properties retained: separate compose project (`xpertapply-staging`), `--no-deps --no-build --pull never web`
only, `env -i` for compose, image id pinned, before/after container snapshots that include the production
containers, health check on `127.0.0.1:3001` (the production web binds `127.0.0.1:3000`).
Test evidence: 15/15 cases in `scripts/test-staging-web-release-premium-ui.sh` (stub docker). Remaining limits: tested
against stubs only (real Compose semantics and host paths unverified); recreate-style `up` causes brief staging downtime;
a failed `up` leaves staging without a web container until `rollback`; no secret values were printed or stored in this report.

## O. Docker image architecture and configuration evidence

- **Image generation: BLOCKED.** The existing local image `xpertapply-web:premium-ui-1aff376` is `linux/arm64`, was built with
  empty build args from commit `1aff376`, and is **stale; do not deploy it**. No new image was built.
- Dockerfile (unchanged): `node:20-alpine`, `npm ci`, four build args become `ENV` before `next build`, so
  `NEXT_PUBLIC_*` values are compiled into the browser bundle and cannot be replaced at runtime. The container runs as root (no `USER`) (pre-existing).
- `.dockerignore` excluded `.env` but not `.env.local`; an image built from a working folder could copy `.env.local` into a
  layer. Fixed (`.env.*`) in `b357260`.
- **Missing prerequisites, by variable name only:** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`,
  `NEXT_PUBLIC_CHROME_EXTENSION_URL`, `NEXT_PUBLIC_CHROME_EXTENSION_ID`. The repo's staging acceptance scripts mention the
  origins `https://staging.xpertapply.com` and `https://api-staging.xpertapply.com` (non-secret), which are candidates for the first two,
  but no document confirms the staging deployment's actual values, so none were used. Also missing: the **server architecture** (nothing in
  the repo states it; all local images are arm64; the production wrapper builds on the server via compose).
- Rules for the build: only public values in `NEXT_PUBLIC_*`; never put a secret in a build arg; tag with the exact commit; record the image id
  and `docker image inspect` architecture and revision label; do not push.

## P. Remaining risks

1. Firefox and Edge unverified; one pre-existing WebKit e2e failure unexplained (nonblocking, evidence in section I).
2. Screen-reader, zoom/reflow, reduced-motion and dark-mode focus not verified; no WCAG conformance claim is made.
3. Real-user Core Web Vitals unknown; lab only.
4. Google OAuth and all live-backend flows (17 skipped live-stack e2e specs, real document generation, extension handoff) not exercised.
5. Staging image is not built; staging script untested on a server.
6. Untracked prior work (`jobpilot-ai/`, `.git-stray-reinit-backup/`) is not in any commit; the git dir is outside the project folder.
7. App routes lack `noindex`; CDN HTML caching default is a year; the container runs as root (pre-existing).
8. The logo carries "Get hired." and a teal/navy palette that differs from the slate/glacier UI (brand decision, not changed).
9. A clean-checkout unit test needs a gitignored `.env` (pre-existing); 17 e2e specs only run against a live stack.

## Q. Rollback and readiness information

- Source rollback: `git checkout 4d2ce3a` (handover state) or `939171f` (base); all work is local commits, nothing pushed.
- Staging rollback: `rollback` mode of the staging script recreates only the web container from `OLD_IMG`; record the current
  staging web image id/tag before any apply. No database, API, DNS, billing or extension change is involved, so rollback is stateless.
- Production rollout/rollback remain as in `docs/plans/premium-ui-overhaul.md` section 8; production requires separate explicit approval.

## R. Final staging recommendation

**READY_FOR_STAGING**, on these conditions precedent (none involves changing source):
1. Supply the four `NEXT_PUBLIC_*` values and the server architecture; build a `linux/amd64` image from `b357260` (or its documentation-only
   successor); record id, platform and revision label.
2. Run the script `plan` first on the staging host; apply only if it reports "effective config identical except web.image".
3. Run the Google sign-in steps in section M and the existing tracker acceptance scripts on staging.
4. Test Firefox and Edge manually on staging; review the 8 final-build screenshots plus a sample of the rest.

Not authorized by this report: any deployment, push, or production release.
