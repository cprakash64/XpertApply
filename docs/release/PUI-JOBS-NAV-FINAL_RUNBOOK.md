# PUI-JOBS-NAV-FINAL: Jobs navigation, visual acceptance and web-only staging release

Status: PREPARED, NOT EXECUTED. Nothing was pushed, deployed, or changed on staging or production.
Source (image revision): `94a19a501adf35ed03b7e1159652bd05aa99e5ce`, on top of the verified `fb6475f` (ancestry confirmed with `git merge-base --is-ancestor`).

## Visual comparison against the approved reference
Fixed (navbar defects only, in `94a19a5`): trailing vertical rule between Sort and the actions; roomier bar (60px vs 52px); chevrons pinned to the item edge;
search expansion now animates (`flex-grow`/`flex-basis` transition, 200ms); workplace and fit icons now match the reference (building, sliders).

Matches the reference: bar starts at the sidebar edge and spans the workspace; borderless items with fine rules; no filter pills; right-aligned actions; summary line
directly under the bar; rows use the width (1600px content cap, aligned to the bar); dark and light coherent.

**Differences deliberately NOT changed (founder decision needed):**
1. **Match-score panel.** The reference cards show a right-hand "MATCH SCORE 79 / 100, Good fit" panel with a progress bar and chevron. The shipped cards show the
   existing compact green/amber/red chip beside the title. No such panel exists anywhere in the repository history, so this is a new card design, not a regression.
2. **Primary button colour.** The reference "Find fresh jobs" is a saturated blue with white text. The app's primary token in dark mode is the pale sapphire (`#8db6d8`,
   dark text), the same as "Apply on official site". Matching the reference needs a token or a hardcoded colour, so it was left.
3. **Sort label.** The reference reads "Best match"; the app's real default is "Best & recent" (server `best_recent`). Kept, because the label must describe the ranking.
4. Reference cards show real company logos, a one-line match reason with a spark icon, and the Apply row inline; the shipped cards are structurally unchanged.

## Regression and validation (production build, against mocked API)
- Unit 1172/1172; `typecheck`, `eslint` clean; `next build` compiles.
- Playwright on the production build: 64 specs across Jobs, cold load, responsive shell, applied-to-tracker, premium-UI regressions, axe; sorts, filters, search, paging, scrolling, Save/Apply flows included.
- New navbar spec: single row, actions at the right, rows > 1000px, no per-filter border, search expands on focus and keeps its query on Escape, nothing else reset, no overflow, no console errors.
- No horizontal overflow at 320, 390, 768, 1024, 1440, 1920. Sticky from 640px up only (the phone header is already sticky).
- Not covered: live-API specs, a real staging session, and the open native dropdown (headless Chromium cannot render the OS menu).
- **CSP review.** `next.config.mjs` and `lib/securityPolicy.mjs` are unchanged since `fb6475f`. The report-only policy produces three things, all present before this change:
  the console notice that `upgrade-insecure-requests` is ignored in report-only mode; `script-src-elem inline` (Next's inline bootstrap scripts); and `connect-src` for the test
  API origin. The navbar e2e now fails on any other violation (style, image, frame, new host). Recommended follow-up: drop `upgrade-insecure-requests` from the report-only copy.

## Artifact
| | |
|---|---|
| Image tag | `xpertapply-staging-web:nav-94a19a5-amd64` (linux/amd64, 9 layers, built from a clean `git archive` of `94a19a5`, 232 files, 0 env files) |
| Local image ID | `sha256:14957eef49d4b1774eeb8dc1701b9d3a590174555154de449fdb8e6f90ea86ce` |
| Layer fingerprint (host-independent) | `b5ea99f4d80fa4eee65b00854b102c2fedb61c3ea22841a8774c6a26a4e5d338` |
| Transport archive SHA-256 | `cfd8074b83d9204707710eabcae74253e735f5ac0fb32bdc750d1f880ca73db3` (342,376,960 bytes) |
| Revision label | `94a19a501adf35ed03b7e1159652bd05aa99e5ce` |
| Build values | API `https://api-staging.xpertapply.com`, site `https://staging.xpertapply.com`, extension URL empty, extension ID unchanged (as in STG1/STG5/STG6) |
| Release script SHA-256 | `6571e73f842193fe7d09c733b0ea957cbfeacc7ef6843ef40171bf686848ca03` (`docs/release/pui-nav/staging-web-nav-release.sh`) |

Checks on the image: `uname -m` = x86_64; staging API URL and the new search placeholder present in the bundle; the production API URL absent from the client bundle; no private
keys or tokens; four `NEXT_PUBLIC_*` values as above. Run locally: `/dashboard`, `/jobs`, `/tracker`, `/settings`, `/login` all 200; the script's "serves new nav" check passes.
The archive is in the session scratchpad, not in Git, and was not uploaded.

A loaded image gets a host-specific ID, so the script pins the **layer fingerprint** and revision label, prints the host ID in preflight, and `web` enforces it.

## Rollback target (web only)
The previous web is the `fb6475f` release candidate: `xpertapply-staging-web:rc-fb6475f-amd64`, `sha256:49c1e73412b015747c3850bf240f411b704d99c85e40e1c73a9df2c51576fcea`, API
`sha256:cfefee81…`, database `0034_password_reset`. **These come from the STG6 record; this machine has no VPS access, so "staging runs exactly this" is unconfirmed until the
operator's preflight, which refuses to continue if it is not true.** `pin-rollback` adds the alias `xpertapply-staging-rollback:web-49c1e73412b0` and nothing else.

## Procedure (operator, root, staging only; stop at the first STOP line)
```bash
# 1. Load the archive on the VPS, then verify it.
echo "cfd8074b83d9204707710eabcae74253e735f5ac0fb32bdc750d1f880ca73db3  xpertapply-staging-web-nav-94a19a5-amd64.tar" | sha256sum -c - || exit 1
sudo docker load -i xpertapply-staging-web-nav-94a19a5-amd64.tar          # adds the image; replaces nothing
cd /home/luna/xpertapply-pui01 && echo "6571e73f842193fe7d09c733b0ea957cbfeacc7ef6843ef40171bf686848ca03  staging-web-nav-release.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-web-nav-release.sh preflight    2>&1 | tee nav-1-preflight.txt     # READ-ONLY
sudo bash ./staging-web-nav-release.sh pin-rollback 2>&1 | tee nav-2-pin.txt           # adds one alias TAG only
# --- proceed only with the founder's approval ---
export XA_STAGING_APPROVED=yes-94a19a50
sudo -E bash ./staging-web-nav-release.sh web       2>&1 | tee nav-3-web.txt           # recreates ONLY xpertapply-staging-web
sudo bash ./staging-web-nav-release.sh verify       2>&1 | tee nav-4-verify.txt
sudo chown luna:luna nav-*.txt
```
`preflight` checks: layer fingerprint, revision label, linux/amd64, the approved dry-run validator hash, staging web on the expected image, API on the fb6475f image, database at 0034,
API healthy, recovery email unset, and a Compose dry run that may name only `xpertapply-staging-web`. It saves a container snapshot. `web` repeats these, requires the alias, and
afterwards checks the new image is running, answers on 127.0.0.1:3001, serves the new navigation, and that every other container is unchanged.

## Rollback (no API or database involvement)
```bash
export XA_STAGING_APPROVED=yes-94a19a50
sudo -E bash ./staging-web-nav-release.sh rollback-web   # back to sha256:49c1e734… (fb6475f web)
```
`verify` then fails its new-image checks by design; all other checks must still pass. Nothing is deleted by either direction.

## Post-deployment checks (synthetic account)
1. `verify` all PASS. 2. Jobs at desktop width: one-row bar, rules, search expands on click and Escape works, change workplace/fit/date/sort (URL updates, list re-ranks), scroll through
pages, Save, Resume, Cover Letter, Apply, Find people. 3. Dark and light, tablet and phone widths. 4. Open one job: workspace and its compact search still work. 5. Browser console: no errors
beyond the CSP baseline above. 6. `python3 docs/release/pui-stg6/staging-ranking-smoke.py https://api-staging.xpertapply.com` to confirm ranking is unchanged.

## GO / NO-GO
**GO for the web-only staging swap, conditional on the founder accepting the three open design differences above** (match-score panel, primary button colour, sort label) as follow-up
work, and on the operator preflight confirming staging currently runs the fb6475f images. **NO-GO for production**: this has not run against a real staging session.
