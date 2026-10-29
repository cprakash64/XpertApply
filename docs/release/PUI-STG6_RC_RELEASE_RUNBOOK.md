# PUI-STG6: release candidate fb6475f, staging release (API then web, no migration)

Status: PREPARED, NOT EXECUTED. Source `fb6475fb6f42b6b365e227d2773f960b9e0499f7` (Dashboard, Jobs and Applications refinement; server-side ranking and paging).

## Staging today (verified 2026-10-29)
API `sha256:87c72268…` (9dbf283), web `sha256:55fa6bb7…` (b99125c), database `0034_password_reset`, recovery email disabled. These two images are the rollback targets.

## Release candidate artifacts (loaded on the VPS; nothing running was changed)
| | Image | Host image ID | Archive SHA-256 |
|---|---|---|---|
| API | `xpertapply-api:rc-fb6475f-amd64` | `sha256:cfefee8171251736c399fc95b6bb3ab2fe6d20f2517c55e4f9bf3f1a0dc9e90d` | `04357b30a74001de2bd7edb92d5c6946f01461302466e3495bdc316ee8cfa739` |
| Web | `xpertapply-staging-web:rc-fb6475f-amd64` | `sha256:49c1e73412b015747c3850bf240f411b704d99c85e40e1c73a9df2c51576fcea` | `0929098b125d808c381a9fbd66d255615132ac3c66ba7d29cd26193cdb14675f` |

Both linux/amd64, revision label fb6475f…, built from a clean `git archive`. Layer fingerprints match the local builds (`62723e09…` API, `33293423…` web).
All 232 files in the API image are byte-identical to the commit (tests excluded, as the Dockerfile removes them). Single Alembic head `0034_password_reset`; migrations
0034, 0035 and 0036 are byte-identical to the commit. The web bundle has the staging API and site URLs, the new Dashboard/Jobs/Applications UI, the light default, the
old "Total tracked" cards absent, no secrets and no env files; the production API URL appears only in the report-only CSP header.

## Why web and API together, and why no migration
- The API change is additive: `GET /jobs` gains `sort`, `limit`, `cursor` and a `page` block; `/dashboard/summary` gains fields. No table or column changes.
- The new web degrades safely against the OLD API (a response without `page` is shown as a full list; every new Dashboard field is optional), so a web-first order would
  not break users, but ranking, paging and the new cards need the new API. The script releases the API first and refuses to release the web until the API is on the candidate.

## Procedure (operator, root, staging only; stop at the first STOP line)
```bash
cd /home/luna/xpertapply-pui01 && echo "35e8899b4171347f78d10075d8717f96481b045a40a79b9c2b411d98ab868845  staging-rc-release.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-rc-release.sh preflight    2>&1 | tee rc-1-preflight.txt     # read-only
sudo bash ./staging-rc-release.sh pin-rollback 2>&1 | tee rc-2-pin.txt           # adds two alias TAGS only
# --- the operator proceeds only with the founder's approval ---
export XA_STAGING_APPROVED=yes-fb6475fb
sudo -E bash ./staging-rc-release.sh api       2>&1 | tee rc-3-api.txt           # recreates ONLY xpertapply-staging-api
sudo -E bash ./staging-rc-release.sh web       2>&1 | tee rc-4-web.txt           # recreates ONLY xpertapply-staging-web
sudo bash ./staging-rc-release.sh verify       2>&1 | tee rc-5-verify.txt
sudo chown luna:luna rc-*.txt
```
Guards in `api` and `web`: root, host, default Docker context, approval variable, image id, revision label and platform, the service currently on its expected previous image,
database at 0034, startup migrations off, recovery email off, the approved dry run validated (only that one container), the same volumes afterwards, healthy afterwards and
every other container unchanged. `api` additionally checks the new image contains the ranking module and the database is still at its head. `web` refuses unless the API is already on the candidate.

## Rollback (no database involvement)
```bash
export XA_STAGING_APPROVED=yes-fb6475fb
sudo -E bash ./staging-rc-release.sh rollback-web   # back to sha256:55fa6bb7… (b99125c)
sudo -E bash ./staging-rc-release.sh rollback-api   # back to sha256:87c72268… (9dbf283)
```
Web first, then API. The previous API and the candidate API are interchangeable against the 0034 schema (no schema change), and the previous web works against either API.

## Post-deployment tests
1. `verify` output all PASS (dashboard, jobs, tracker and settings routes 200; unauthenticated API calls refused; noindex headers; production health; protected containers identical).
2. From any machine: `python3 docs/release/pui-stg6/staging-ranking-smoke.py https://api-staging.xpertapply.com` (needs `httpx`). Creates one synthetic account and checks the three sorts
   against the real staging catalogue, paging equality without duplicates, tampered and unauthenticated cursors, and the Dashboard payload. Exit 0 = pass.
3. In a browser with that synthetic account: Dashboard (three match cards with green/amber/red chips, table, profile card, pipeline), Jobs (toolbar, scroll through pages, change sort,
   filters, Save, Apply opens the existing flow), Applications (no header, filters, status change, downloads), Settings > Appearance, light default, dark mode, a phone width.
4. Run the live-API Playwright specs against staging (they were not run for this candidate): `profile-and-theme`, `tracker-documents-live`, people/profile.
5. Check the login page recovery link while email is disabled, and decide the extension build under test (unchanged open items).

## Known limits
Per-request ranking recomputes the caller's eligible set (about 300 ms at 3,000 jobs on a laptop-class database; ranking itself is about 10 ms there). Real-mailbox password reset is
still unverified and disabled on staging. The 26 live-API specs have not been run.
