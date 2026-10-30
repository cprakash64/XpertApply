# API staging candidate: login throttling (S3) + two-phase jobs list (F3/F5)

Status: PREPARED, NOT EXECUTED. Nothing was pushed, deployed or changed on staging or production.
Source (image revision): `e4797e4d9e27dbed253e312462c4db081197fd2d`, which contains the throttling commit `6d3a8e7` and the list fix (ancestry from `fb6475f` verified).
**Supersedes** `docs/release/PUI-AUTH-THROTTLE_RUNBOOK.md` and its image, which lack the F3/F5 fix. Design and evidence: `docs/plans/auth-login-throttling.md`, `docs/plans/jobs-list-efficiency.md`.

## What it changes (API image only, no migration, no web change)
1. `POST /auth/login` and `/auth/signup` throttling (per-account limit active by default; per-address limits only with `AUTH_TRUSTED_PROXY_HOPS`).
2. `GET /jobs` loads only the columns it needs and builds full cards for the page only. Responses are byte-identical to the old ones (27 query shapes compared); memory and CPU per request fall sharply, and four overlapping requests no longer exhaust the 768 MB container.

## Artifact
| | |
|---|---|
| Image | `xpertapply-api:api-e4797e4-amd64`, linux/amd64, 14 layers, clean `git archive` of `apps/api` (342 files, 0 env files) |
| Local image ID | `sha256:887740bb2f6381ae47e9ad42089cd987ec697a9ed797d229424d1ececfdfbc86` |
| Layer fingerprint | `56a016d22de6cacf1c273b988511f331aa97f0c35e22c72ad1db4530de1cb6e5` |
| Archive SHA-256 | `b71406dcb9b8480b4fc9d6dc60559c203e68a56273d5390fe9066d9a7cdc7391` (246,825,472 bytes), session scratchpad `xpertapply-api-api-e4797e4-amd64.tar`; not in Git, not uploaded |
| Revision label | `e4797e4d9e27dbed253e312462c4db081197fd2d` |
| Release script SHA-256 | `095a87b4c56b0322e5d6069fec564dff3020d69446f352e3d81c5781a0d8bc85` (`docs/release/pui-api-f3/staging-api-release.sh`) |

Image checks (read-only, no network): x86_64; only Alembic head `0034_password_reset`; `app.services.auth_throttle`, `app.routes.jobs` and `app.main` import; the phase-1 column list has 14 columns and none of `description_raw`, `raw_json`, `responsibilities`; `app/tests` absent; 0 env files; 0 secret-pattern hits; all 232
files under `app/`, `alembic/`, `scripts/` byte-identical to the commit. A loaded image gets a host-specific ID, so the script pins the layer fingerprint and revision label, prints the host ID in preflight and `api` enforces it.

## Script audit
Same guarded pattern as the throttle release (derived from it; only constants and two image checks differ). Only state changes: one alias `docker tag` and `compose up -d --no-deps --no-build --pull never api` after the approved dry-run validator shows only `xpertapply-staging-api`.
No down, rm, prune, pull, build, nginx, production, VeoTrex, PostgreSQL, Redis-config, SMTP or migration command (`alembic current`/`heads` are read-only). Stops without root, on the wrong host, without the approval variable, or on any mismatch (guards tested). The new image checks were run against this image; the probe was run
against the candidate code locally in the throttle release.

## Current staging and rollback target
Rollback: the fb6475f API `xpertapply-api:rc-fb6475f-amd64`, `sha256:cfefee8171251736c399fc95b6bb3ab2fe6d20f2517c55e4f9bf3f1a0dc9e90d`, database `0034_password_reset`. **No VPS access here, so that staging runs exactly this is unconfirmed;** preflight verifies it and stops otherwise.

## Operator commands (root, staging only; stop at the first STOP line)
```bash
echo "b71406dcb9b8480b4fc9d6dc60559c203e68a56273d5390fe9066d9a7cdc7391  xpertapply-api-api-e4797e4-amd64.tar" | sha256sum -c - || exit 1
sudo docker load -i xpertapply-api-api-e4797e4-amd64.tar
cd /home/luna/xpertapply-pui01 && echo "095a87b4c56b0322e5d6069fec564dff3020d69446f352e3d81c5781a0d8bc85  staging-api-release.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-api-release.sh preflight    2>&1 | tee api-1-preflight.txt     # READ-ONLY; must end PREFLIGHT PASS
sudo bash ./staging-api-release.sh pin-rollback 2>&1 | tee api-2-pin.txt           # adds one alias TAG only
# --- proceed only with the founder's approval ---
export XA_STAGING_APPROVED=yes-e4797e4d
sudo -E bash ./staging-api-release.sh api       2>&1 | tee api-3-api.txt           # recreates ONLY xpertapply-staging-api
sudo bash ./staging-api-release.sh verify       2>&1 | tee api-4-verify.txt
sudo chown luna:luna api-*.txt
```
Before the swap, the operator can also run the read-only F3 confirmation commands in `docs/plans/jobs-list-efficiency.md` (container restart count / OOM flag, kernel log, nginx 50x lines, active-job count).

## Rollback (no database involvement)
```bash
export XA_STAGING_APPROVED=yes-e4797e4d
sudo -E bash ./staging-api-release.sh rollback-api
```

## Post-deployment checks (synthetic account; need approval, none done)
Page through every sort with limits 10 and 25 (no duplicates, none skipped, `total` equals items); a bounded burst (6 to 8 quick filter changes plus a deep scroll) with 0 failures and `RestartCount` unchanged; the 15-attempt login burst gives 401 then 429 with `Retry-After`; a normal sign-in still works. Delete the account afterwards.

## GO / NO-GO
**GO** for the API-only staging swap once preflight confirms staging is on the fb6475f API and database 0034. Not a production approval: F2, F4, S1/S2 and the extension test remain open, and the staging catalogue size and F3's cause on staging are unconfirmed.
