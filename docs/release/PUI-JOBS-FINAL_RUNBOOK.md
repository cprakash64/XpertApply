# PUI-JOBS-FINAL: match-score panel, Sapphire primary action, final web-only staging release

Status: PREPARED, NOT EXECUTED. Nothing was pushed, deployed, or changed on staging or production.
Source: `1df25f52bf81af02282e52be3e9505a1cfa4b665` (ancestry from `fb6475f` verified). Supersedes `docs/release/PUI-JOBS-NAV-FINAL_RUNBOOK.md`, whose script and image (`94a19a5`) are not to be used.

## What changed (web only)
- `components/jobs/MatchScore.tsx` (new): `MatchScorePanel` (from 1024px up) and `MatchScoreInline` (below). `JobCard.tsx` uses them in place of the small chip on the Jobs page.
  The Dashboard and Tracker still use the existing `FitScoreChip`. `lib/fitScore.ts` is untouched, so band thresholds (80 strong / 60 good / 45 stretch / below low) are unchanged.
- Panel: "MATCH SCORE", the rounded real score "/ 100", the band label (the backend's `fit_label` when sent), and a slim bar whose width is the real score (clamped 0-100).
  Number, label and bar use the existing semantic tokens (fit-strong green, status-warning amber, status-danger red). Unscored jobs show "Calculating fit…", "Score unavailable" or
  "No fit score" with no number and no bar. Colour is never the only signal (the number and label are printed; screen readers hear "Match score 79 out of 100, Good fit").
  The reference's chevron is omitted: the card already has a real title button, and a second control would add a tab stop per card.
- "Find fresh jobs": new scoped `sapphire` Button variant and `--color-action-sapphire-*` tokens (white text; 5.8:1 light, 5.6:1 dark, hover 7.3:1 / 4.6:1). The default `primary`
  variant is unchanged. "Refresh matches" remains the ghost action. Behaviour of both is unchanged.
- Sort labels: "Best & Recent", "Best Fit", "Newest First". Values (`best_recent`, `fit`, `newest`) and the server request are unchanged.
- Navbar unchanged (60px bar, rules, borderless filters, expandable search, wrapping, sticky from 640px).

Changed files: `apps/web/components/jobs/MatchScore.tsx` (new), `components/jobs/JobCard.tsx`, `components/jobs/JobsFilterBar.tsx`, `components/JobDiscovery.tsx`, `components/ui/Button.tsx`,
`app/globals.css`, `tailwind.config.ts`, `__tests__/match-score.test.tsx` (new), `__tests__/jobs-discovery.test.tsx`, `__tests__/jobs-feed.test.tsx`, `e2e/dashboard-jobs-redesign.spec.ts`,
plus `docs/release/evidence/pui-jobs-final/` (screenshots).

## Validation
- Unit 1188/1188 (twice, clean); `typecheck`, `eslint .` clean; `next build` compiles.
- Playwright on the production build: 65 specs (Jobs, cold load, responsive shell, applied-to-tracker, premium-UI regressions, axe, paging, sorts, Save/Apply flows) plus 33 in the redesign spec.
- Unit coverage of the bands at every boundary (92, 80, 79, 60, 59, 45, 44, 0), bar width equals the score, clamping, backend label, and no number for pending, failed or profile-incomplete jobs.
- e2e: real scores 92/66/38 render as strong/good/low with 92%/66%/38% fills; panel is right-aligned in the card; card height < 230px; Find fresh jobs has white text; no overflow;
  no CSP violation beyond the documented report-only baseline (see the previous runbook).
- No horizontal overflow at 320, 390, 768, 1024, 1440, 1920. Screenshots: dark and light full page, navbar and score close-up, high/medium/low fit in both themes, expanded search, 390 and 320 phone, 768 tablet.
- Known cosmetic point: with search expanded at exactly 1440px the placeholder is clipped ("Role, company or"); typing and the query are unaffected.
- Not covered: live-API specs, a real staging session, the open native dropdown (headless Chromium cannot render it).
- Reference comparison: navbar, panel layout (label, large number, "/ 100", band label, slim bar), and Sapphire button now match the reference. Remaining intentional differences: sort reads "Best & Recent" (not "Best match");
  no panel chevron; reference shows real company logos and a spark-icon match line (data and card structure not changed).

## Artifact
| | |
|---|---|
| Image | `xpertapply-staging-web:final-1df25f5-amd64`, linux/amd64, 9 layers, from a clean `git archive` (234 files, 0 env files) |
| Local image ID | `sha256:7470da202ff94c8096ce9041cc5c29dd7a0775d47d715bccd95fc65eb5e9c328` |
| Layer fingerprint | `524f869837ed4dc2a2888687d609448a281b709b09a18c5b137590c2e3dda4d3` |
| Archive SHA-256 | `c30be08872b0c33f7cae9291744788fdba5113a85d97681fdd7b01cedfa77ee9` (342,453,248 bytes), in the session scratchpad `xpertapply-staging-web-final-1df25f5-amd64.tar`; not in Git, not uploaded |
| Revision label | `1df25f52bf81af02282e52be3e9505a1cfa4b665` |
| Release script SHA-256 | `15463b3a33e3257d83f95ebf4495eeb93c9fdb48ccfc5e706c7578d7edf2ba97` (`docs/release/pui-final/staging-web-final-release.sh`) |

Image checks: x86_64; staging API URL embedded; production API URL absent from the client bundle; match-score and new search strings present; 0 env files; 0 secret-pattern hits; the four
`NEXT_PUBLIC_*` values equal the earlier releases'. Run locally, `/dashboard /jobs /tracker /settings /login` return 200 and the script's served-UI check passes. A loaded image gets a host-specific
ID, so the script pins the layer fingerprint and revision, prints the host ID in preflight, and `web` enforces it.

Script audit: the only state changes are one alias `docker tag` (`pin-rollback`) and `compose up -d --no-deps --no-build --pull never web`. No down, rm, prune, pull, build, nginx, production, VeoTrex, SMTP or
migration command; `alembic current` is read-only. The approved dry-run validator (hash pinned) must show only `xpertapply-staging-web`. Without root or approval it stops (tested).

## Current staging and rollback target
The rollback target is the fb6475f release candidate web, `xpertapply-staging-web:rc-fb6475f-amd64`, `sha256:49c1e73412b015747c3850bf240f411b704d99c85e40e1c73a9df2c51576fcea` (API `sha256:cfefee81…`, database
`0034_password_reset`), from the STG6 record. **This machine has no VPS access, so that staging runs exactly these images is not confirmed here.** The preflight checks it and refuses to continue otherwise.

## Operator commands (root, staging only; stop at the first STOP line)
```bash
echo "c30be08872b0c33f7cae9291744788fdba5113a85d97681fdd7b01cedfa77ee9  xpertapply-staging-web-final-1df25f5-amd64.tar" | sha256sum -c - || exit 1
sudo docker load -i xpertapply-staging-web-final-1df25f5-amd64.tar          # adds the image; replaces nothing
cd /home/luna/xpertapply-pui01 && echo "15463b3a33e3257d83f95ebf4495eeb93c9fdb48ccfc5e706c7578d7edf2ba97  staging-web-final-release.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-web-final-release.sh preflight    2>&1 | tee final-1-preflight.txt     # READ-ONLY; must end PREFLIGHT PASS
sudo bash ./staging-web-final-release.sh pin-rollback 2>&1 | tee final-2-pin.txt           # adds one alias TAG only
# --- proceed only with the founder's approval ---
export XA_STAGING_APPROVED=yes-1df25f52
sudo -E bash ./staging-web-final-release.sh web       2>&1 | tee final-3-web.txt           # recreates ONLY xpertapply-staging-web
sudo bash ./staging-web-final-release.sh verify       2>&1 | tee final-4-verify.txt
sudo chown luna:luna final-*.txt
```
## Rollback (web only; no API or database involvement)
```bash
export XA_STAGING_APPROVED=yes-1df25f52
sudo -E bash ./staging-web-final-release.sh rollback-web    # back to sha256:49c1e734… (fb6475f web); then run verify (its new-image checks fail by design)
```
## Post-deployment checks (synthetic account)
`verify` all PASS; Jobs at desktop, tablet and phone widths in light and dark; panel scores match the API (compare one card with `GET /jobs`); change each sort and filter; scroll through pages; Save, Resume,
Cover Letter, Apply, Find people; open a job and return; console free of errors beyond the CSP baseline; `python3 docs/release/pui-stg6/staging-ranking-smoke.py https://api-staging.xpertapply.com`.

## GO / NO-GO
**GO** for the web-only staging swap, once the operator preflight confirms staging is on the fb6475f images. **NO-GO** for production until live integration testing on staging.
