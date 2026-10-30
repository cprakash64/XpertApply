# AUTH-THROTTLE: login and sign-up throttling, API-only staging release

Status: PREPARED, NOT EXECUTED. Nothing was pushed, deployed, or changed on staging or production.
Source (image revision): `6d3a8e74ed236bd73dcc449418d1e2da93c3ad9d` (ancestry from `fb6475f` verified). Closes finding S3 (P1) of `docs/release/PUI-LIVE-ACCEPTANCE_REPORT.md`; design, tests and rollback in `docs/plans/auth-login-throttling.md`.

## What it changes
Only the API image. `POST /auth/login` counts each attempt per account (default 10 per 15 min) before the password is checked, answers 429 with `Retry-After` past the limit (identically for known and unknown emails), and clears on a correct password.
No schema change and no migration (the candidate's only Alembic head is `0034_password_reset`). The web is unchanged; it already shows a clear message for 429. The worker and scheduler stay on their current image: the throttle only runs in the API's `/auth` routes.
**Defaults are active with no configuration.** Per-address limits stay OFF until `AUTH_TRUSTED_PROXY_HOPS=1` is added to the API environment (see "Step 2").

## Artifact
| | |
|---|---|
| Image | `xpertapply-api:auth-throttle-6d3a8e7-amd64`, linux/amd64, 14 layers, built from a clean `git archive` of `apps/api` at `6d3a8e7` (341 files, 0 env files) |
| Local image ID | `sha256:6666d34949ae2c6759051e1e634e8ba3eec0ae1b4ab54d8322a9ffc9723b922b` |
| Layer fingerprint (host-independent) | `91dda6b2431f245e415e77053309bd19d9539f6e1c7f6502627bf53e6fd53a2e` |
| Archive SHA-256 | `de16bc1f453877445bc012cb032ab052ffb342ffdcb301ea0eb7c26f468571d6` (246,823,424 bytes), in the session scratchpad `xpertapply-api-auth-throttle-6d3a8e7-amd64.tar`; not in Git, not uploaded |
| Revision label | `6d3a8e74ed236bd73dcc449418d1e2da93c3ad9d` |
| Release script SHA-256 | `dfa52b5ed91fb6e581770b4b35e02a1ce075dabd5f18bdb54f1cac4607d77317` (`docs/release/pui-auth/staging-api-throttle-release.sh`) |

Image checks (run locally, read-only, no network): x86_64; `alembic heads` = `0034_password_reset (head)`; `app.services.auth_throttle` and `app.main` import; defaults 10 attempts / 900 s / 0 hops; `app/tests` absent; 0 env files; 0 secret-pattern hits; all
232 files under `app/`, `alembic/`, `scripts/` are byte-identical to the commit (tests excluded, as the Dockerfile removes them). A loaded image gets a host-specific ID, so the script pins the layer fingerprint and revision, prints the host ID in preflight, and `api` enforces it.
Not changed on purpose: `pytest` still ships in `requirements.txt` (finding S5, separate).

## Script audit
Only state changes: one alias `docker tag` (`pin-rollback`) and `compose up -d --no-deps --no-build --pull never api` (`api`, `rollback-api`); the approved dry-run validator (hash pinned) must show only `xpertapply-staging-api`. No down, rm, prune, pull, build, nginx, production, VeoTrex, PostgreSQL, Redis-config or SMTP command; `alembic current` and
`alembic heads` are read-only. It stops without root, on the wrong host, without the approval variable, or on any mismatch. Tested here: guards stop correctly, syntax check, and its throttle probe run against the candidate API served locally (401 for attempts 1-10, 429 with `Retry-After` on 11, also with Redis unreachable).
The probe uses a random never-registered address, so it creates no account and writes nothing to PostgreSQL (only an expiring hashed counter).

## Current staging and rollback target
Rollback target: the fb6475f API, `xpertapply-api:rc-fb6475f-amd64`, `sha256:cfefee8171251736c399fc95b6bb3ab2fe6d20f2517c55e4f9bf3f1a0dc9e90d`, database `0034_password_reset`, web on the 1df25f5 image.
**This machine has no VPS access, so that staging runs exactly these is unconfirmed here.** Preflight checks the API image, database revision, startup-migration flag, recovery email and health, and refuses to continue otherwise.

## Operator commands (root, staging only; stop at the first STOP line)
```bash
echo "de16bc1f453877445bc012cb032ab052ffb342ffdcb301ea0eb7c26f468571d6  xpertapply-api-auth-throttle-6d3a8e7-amd64.tar" | sha256sum -c - || exit 1
sudo docker load -i xpertapply-api-auth-throttle-6d3a8e7-amd64.tar          # adds the image; replaces nothing
cd /home/luna/xpertapply-pui01 && echo "dfa52b5ed91fb6e581770b4b35e02a1ce075dabd5f18bdb54f1cac4607d77317  staging-api-throttle-release.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-api-throttle-release.sh preflight    2>&1 | tee auth-1-preflight.txt     # READ-ONLY; must end PREFLIGHT PASS
sudo bash ./staging-api-throttle-release.sh pin-rollback 2>&1 | tee auth-2-pin.txt           # adds one alias TAG only
# --- proceed only with the founder's approval ---
export XA_STAGING_APPROVED=yes-6d3a8e74
sudo -E bash ./staging-api-throttle-release.sh api       2>&1 | tee auth-3-api.txt           # recreates ONLY xpertapply-staging-api
sudo bash ./staging-api-throttle-release.sh verify       2>&1 | tee auth-4-verify.txt
sudo chown luna:luna auth-*.txt
```
Note the file name on the VPS is `staging-api-throttle-release.sh` (the repository file name).

## Rollback (no database involvement)
```bash
export XA_STAGING_APPROVED=yes-6d3a8e74
sudo -E bash ./staging-api-throttle-release.sh rollback-api    # back to sha256:cfefee81… (fb6475f API); then run verify (its new-image and probe checks fail by design)
```
Leftover Redis counters (`xa:auththrottle:*`) expire on their own and may be ignored. To loosen without rolling back, raise `AUTH_LOGIN_MAX_ATTEMPTS` in the API environment.

## Step 2 (optional, separate change, not in this release): per-address limits
Behind the single nginx every request reaches the API from the proxy address, so per-address limits stay off unless `AUTH_TRUSTED_PROXY_HOPS=1` is set. `compose.staging.yml` passes an explicit list of variables, so that needs an operator edit to
the compose environment (or the API override file) and a recreate; it is deliberately not done here. Only enable it where nginx overwrites `X-Forwarded-For` (the staging templates do). Verify from two source addresses first. An nginx `limit_req` on
`/auth/login` and `/auth/signup` (snippet in the plan) is the recommended companion; production's edge has not been inspected.

## Post-deployment checks (synthetic account; each needs your approval, none are done)
1. `verify` all PASS, including "login throttling is active" (unknown-address probe).
2. The original burst, on one throwaway account: 15 wrong passwords then the correct one: expect 401 x10, then 429 with `Retry-After`; correct password still refused inside the window; accepted after it. Confirm a normal sign-in and sign-out still work in the browser and the UI shows
   "Too many sign-in attempts. Please wait a few minutes and try again." Delete the account afterwards.
3. Sign-up with a new address still works; a second browser/user is unaffected while the first account is blocked.

## GO / NO-GO
**GO** for the API-only staging swap once the operator preflight confirms staging is on the fb6475f API and database 0034. This is not production approval: S3 stays open on production until the same API and a reviewed edge rule are released there, and F2, F3-F5, S1/S2 and the extension test are still open (see the acceptance report).
