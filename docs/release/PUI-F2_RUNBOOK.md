# F2 staging candidate: automatic initial job scoring (API then web)

Status: PREPARED, NOT EXECUTED. Nothing was pushed, deployed or changed on staging or production.
Source (image revision): `aa5bc2fa3cd943cdba53dbb475554eee6178a399`, containing `e4797e4` (throttling + two-phase jobs list) and the F2 change. Design, measurements and tests: `docs/plans/initial-job-scoring.md`.

## What changes
- **API:** `GET /jobs` gains a read-only `scoring` progress block; new authenticated `POST /jobs/scoring/advance` scores the caller's next bounded batch of visible jobs (idempotent, one per user, two per process, 200 jobs and 4 s per call, retry cap); two avoidable full-row scans removed from the manual refresh path.
- **Web:** the Jobs page starts and drives scoring itself, shows progress, holds "Show more" until scores are final, reloads once, and no longer polls forever; incomplete profiles show "No fit score".
- **Flagged requirements:** API **and** web image rebuilds. **No migration** (only head `0034_password_reset`), **no new infrastructure, worker or queue**, and **no environment change required** (three new optional settings with safe defaults: `SCORING_ADVANCE_BATCH_SIZE=200`, `SCORING_ADVANCE_TIME_BUDGET_SECONDS=4`, `SCORING_ADVANCE_MAX_CONCURRENT=2`). Release the **API first**: the new web needs the scoring endpoint; an old web works with the new API, and a new web against an old API falls back to the previous polling.

## Artifacts
| | API | Web |
|---|---|---|
| Image | `xpertapply-api:f2-aa5bc2f-amd64` (14 layers, 344 files in the context, 0 env files) | `xpertapply-staging-web:f2-aa5bc2f-amd64` (9 layers, 235 files, 0 env files) |
| Local image ID | `sha256:366f582de5b76794e1fb4f5d57f352f056f699327a7b5e2df3ce322344bb03f7` | `sha256:942eef0afc52f29b57746d15cea34be9ce077f8e995466c3a499f789aaa3e085` |
| Layer fingerprint | `87b53b0e0032b94198cb27fd08b73422d145bddff37510c5b84bb102ffd6a95b` | `64f805646ad52c01571dea4b8d029d3016e2492d40abe695c8728432697a1c1a` |
| Archive SHA-256 | `07c3278d3c1b7e2d420dbb367d870e6fcbec54d39faed0cb25a660d6de0495a9` (246,835,712 B) | `50ecad285bb91b1afdd1e8c53c34d3799fd8b2319c5e5c1a88b55ed7c0f49a90` (342,494,720 B) |
| Archive file (session scratchpad, not in Git, not uploaded) | `xpertapply-api-f2-aa5bc2f-amd64.tar` | `xpertapply-staging-web-f2-aa5bc2f-amd64.tar` |
| Revision label | `aa5bc2fa3cd943cdba53dbb475554eee6178a399` | same |
| Release script SHA-256 | `6eec6b719f19810d86ca41ebd69641aad6be790396852e22adc9a01535fbad3c` (`docs/release/pui-f2/staging-f2-release.sh`) | |
Scratchpad folder: `/private/tmp/claude-501/-Users-cprakash-Documents-Jobs-XpertApply/7a1d83ad-b199-449d-9c43-1e1e973b26ac/scratchpad/`.
API image checks (read-only, no network): x86_64; only head `0034_password_reset`; the throttle, two-phase list and `initial_scoring` modules import; defaults 200 / 4.0 / 2; `app/tests` absent; 0 env files; 0 secret hits; all 233 files under `app/`, `alembic/`, `scripts/` byte-identical to the commit.
Web image checks: x86_64; staging API URL embedded, production API URL absent; "Scoring your matches" and "Match score" present in the bundle; four `NEXT_PUBLIC_*` values as in earlier releases (extension ID unchanged); 0 env files; 0 secret hits; served locally, `/dashboard /jobs /tracker /settings /login` all 200 and the script's served-UI check passes.
A loaded image has a host-specific ID, so the script pins layer fingerprints and revision labels and prints the host IDs.

## Script audit
Derived from the previously audited API-only and web-only scripts. Only state changes: `docker tag` aliases (`pin-rollback`) and `compose up -d --no-deps --no-build --pull never` for `api`, `web` and the rollbacks, each after the approved dry-run validator shows only that one container. The two `POST`s it sends are an unauthenticated call that must be refused with 401 and the unknown-address throttle probe (writes only an expiring Redis counter).
No down, rm, prune, pull, build, nginx, production, VeoTrex, PostgreSQL, Redis-config, SMTP or migration command (`alembic current`/`heads` are read-only). Stops without root, on the wrong host, without the approval variable, on a wrong fingerprint or revision, if the web is released before the API, or on any mismatch. Tested here: guards, syntax, the served-UI check against the candidate web container, and the 401-route and throttle probes against the candidate API code.

## What staging runs today, and the rollback targets
API `e4797e4` (fingerprint `56a016d2…`) and web `1df25f5` (fingerprint `524f8698…`), database `0034_password_reset`. **I have no VPS access, so this is unconfirmed.** Preflight verifies the running containers by fingerprint and revision label and stops if they differ (if it stops there, send its output; the images may have been built on the host rather than loaded).
`pin-rollback` tags exactly those running images as `xpertapply-staging-rollback:api-e4797e4` and `...:web-1df25f5`.

## Operator commands (root, staging only; stop at the first STOP line)
```bash
echo "07c3278d3c1b7e2d420dbb367d870e6fcbec54d39faed0cb25a660d6de0495a9  xpertapply-api-f2-aa5bc2f-amd64.tar" | sha256sum -c - || exit 1
echo "50ecad285bb91b1afdd1e8c53c34d3799fd8b2319c5e5c1a88b55ed7c0f49a90  xpertapply-staging-web-f2-aa5bc2f-amd64.tar" | sha256sum -c - || exit 1
sudo docker load -i xpertapply-api-f2-aa5bc2f-amd64.tar && sudo docker load -i xpertapply-staging-web-f2-aa5bc2f-amd64.tar    # add images; replace nothing
cd /home/luna/xpertapply-pui01 && echo "6eec6b719f19810d86ca41ebd69641aad6be790396852e22adc9a01535fbad3c  staging-f2-release.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-f2-release.sh preflight    2>&1 | tee f2-1-preflight.txt     # READ-ONLY; must end PREFLIGHT PASS
sudo bash ./staging-f2-release.sh pin-rollback 2>&1 | tee f2-2-pin.txt           # adds two alias TAGS only
# --- proceed only with the founder's approval ---
export XA_STAGING_APPROVED=yes-aa5bc2fa
sudo -E bash ./staging-f2-release.sh api       2>&1 | tee f2-3-api.txt           # recreates ONLY xpertapply-staging-api
sudo -E bash ./staging-f2-release.sh web       2>&1 | tee f2-4-web.txt           # recreates ONLY xpertapply-staging-web
sudo bash ./staging-f2-release.sh verify       2>&1 | tee f2-5-verify.txt
sudo chown luna:luna f2-*.txt
```
Before the swap, record a memory baseline for the F2 follow-up: `docker stats --no-stream xpertapply-staging-api` (the last known reading was 627 MiB of 768 MiB; the new path peaked at +15 MiB per call locally but this was not measured on staging).

## Rollback (no database involvement; web first, then API)
```bash
export XA_STAGING_APPROVED=yes-aa5bc2fa
sudo -E bash ./staging-f2-release.sh rollback-web
sudo -E bash ./staging-f2-release.sh rollback-api
```
After a rollback `verify` fails its new-image checks by design. An old API with the new web would fall back to polling, so a web-only rollback is also safe.

## Post-deployment checks (need an approved synthetic account; none done)
1. `verify` all PASS.
2. One throwaway account with a completed profile: open Jobs; expect "Scoring your matches… X of Y" with advancing counts, the list reloading once ranked, no manual Refresh, "Show more" enabled afterwards, and no console errors. Record the number of `/jobs/scoring/advance` calls and their latencies.
3. A second throwaway account with a thin profile: "No fit score", no scoring calls, no repeated list requests.
4. Re-run the bounded rapid-paging test from the F3/F5 acceptance while scoring, and confirm `RestartCount` unchanged and `OOMKilled=false` afterwards (`docker inspect -f 'restarts={{.RestartCount}} oom={{.State.OOMKilled}}' xpertapply-staging-api`).
5. Delete the accounts afterwards.

## Remaining risks
Scoring starts when Jobs is opened (Dashboard top matches stay empty until then); each advance repeats the eligibility scan (about 0.5-0.9 s at 4,500 jobs); the cap is per API process; staging's worker is not started by default so background rescoring after profile changes still relies on the page; the 768 MiB headroom concern from the F3/F5 acceptance is unchanged; real staging timings are untested.

## GO / NO-GO
**GO** for the API-then-web staging release once preflight confirms the running images. Not production approval: F4 (Escape on the Apply dialog), S1/S2 (edge headers, CSP), the extension 0.3.0 test, and the post-deployment checks above remain.
