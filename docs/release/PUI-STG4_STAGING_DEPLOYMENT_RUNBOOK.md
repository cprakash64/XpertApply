# PUI-STG4: controlled staging deployment and rollback runbook (Premium UI + migration 0034)

Status: **PREPARED, NOT EXECUTED.** Staging only. Candidate source `9dbf2836a6ffa374d6e626a368820fd79410ba78`.
Supersedes sections 6 to 10 of `PUI-STG3_STAGING_RELEASE_RUNBOOK.md`, which predate the discoveries below.
Every deployment step runs through `docs/release/pui-stg4/staging-release.sh` (root, on `srv738314`); copy it next to the other
approved scripts in `/home/luna/xpertapply-pui01/` and record its SHA-256 before use.

## 1. What is established (evidence)

| Question | Finding | Evidence |
|---|---|---|
| Compose project | `xpertapply-staging` | labels on all four staging containers; rendered config `name:` |
| API/web compose files | `compose.staging.yml` + `staging-api.release.yml` (+ for web `staging-web.release.yml`, image `stage50d-cb76c3d`) | `com.docker.compose.project.config_files` labels |
| Why the web shows `:local` in the base config | the running web was created with a third override pinning `xpertapply-staging-web:stage50d-cb76c3d`; the base file alone says `:local`. The dry run's candidate override pins the new image explicitly, so the difference is irrelevant to the release | labels above; `/home/luna/xa-web-build-cb76c3d/staging-web.release.yml` |
| API physical volumes | `xpertapply-staging-generated-files` -> `/app/generated`, `xpertapply-staging-uploaded-files` -> `/app/uploads`; local driver, rw, **named** (no anonymous volume) | `docker inspect` of the running API; `docker volume inspect` |
| Volume definitions | `compose.staging.yml` gives every volume an explicit `name:`; the volumes carry labels `com.docker.compose.project=xpertapply-staging` and `com.docker.compose.volume=generated_files / uploaded_files / postgres_data`; the 10-27 rendered config shows the same names | repo file; volume labels; `cfg.new.json` of the previous release (names only read) |
| PostgreSQL data | `xpertapply-staging-postgres-data`, mounted only by `xpertapply-staging-postgres`; never in scope | inspect |
| Redis | has an **anonymous** data volume (`df563f68…`); never in scope | inspect |
| Startup migrations | `RUN_MIGRATIONS_ON_STARTUP=false` and `APP_ENV=staging` on the running API, so the migration is an explicit step | `docker exec ... printenv` (names/values are non-secret) |
| Staging DB state | revision `0036`; column `users.password_changed_at` does not exist yet; 1 user | read-only queries |
| Recovery email | `EMAIL_BACKEND` unset, no SMTP: availability endpoint must report `available:false` | running env; code default `disabled` |

**Still to be proved on the host (the script's `evidence` mode, read-only):** that the *candidate render* resolves to those same
physical volume names and networks. The script fails if any rendered volume name differs from a running mount, if a
rendered volume does not already exist (Compose would create an empty one), or if any mount is anonymous or a bind.

## 2. Migration 0034

* Parent `0036_application_doc_snapshots`; only additive DDL: nullable `users.password_changed_at`, new table
  `password_reset_tokens` (FK to `users.id` ON DELETE CASCADE, unique index on `token_hash`, index on `user_id`).
  No existing column or table is altered or dropped; no data is rewritten. Transactional DDL on PostgreSQL, so a failure
  leaves nothing partial.
* Existing authentication stays valid: `token_predates_password_change` returns False when `password_changed_at` is NULL.
* **Order: migrate BEFORE replacing the API.** The new API maps `users.password_changed_at` and fails on any user query without
  it (shown by the compat test). The old API ignores the new column, so it keeps serving during the migration.
* Verified on disposable PostgreSQL 16: `0033 -> 0035 -> 0036 -> 0034`, downgrade to 0036 and re-upgrade; a database built by the
  deployed code needs exactly one migration; **and the previously deployed API code (1516f23) runs against the 0034 schema**
  (health, pre-existing token, login, signup, profile, application flow, tracker list, user delete cascading to the token
  table). That is a scratch test (not committed); the 0034 schema is additive, so rollback of the API alone is safe.
* Not tested: the real staging dataset (one user) and the real `alembic` run on the host.

### Failed migration recovery
1. `docker exec xpertapply-staging-api alembic current` (the old image reports `0036`). If the `password_reset_tokens` table
   and the `password_changed_at` column are both absent, nothing was applied: fix the cause and re-run `migrate`.
2. If exactly one of them exists, STOP: do not stamp or downgrade by hand. Restore the pre-migration dump into a **new**
   database (never over the live one), verify with the restore-test method of PUI-STG3A, then repoint after owner review.
3. The API stays on the old image throughout, so users are unaffected.

## 3. Rollback images (immutable)

* API: `sha256:436c05e7dff8…` (tag `xpertapply-api:nav02-gated-1516f23`; **production uses the same image: never remove or retag**).
* Web: `sha256:30651fdd2fa8…` (tag `xpertapply-staging-web:stage50d-cb76c3d`).
* `pin-rollback` adds alias tags `xpertapply-staging-rollback:api-436c05e7dff8` / `web-30651fdd2fa8` and verifies each resolves
  to the expected ID. The rollback modes use only those aliases, after re-verifying the ID. Rollback recreates the container
  with the same compose files, environment, networks, ports, volumes and restart policy; only the image differs.
* Rolling back never downgrades the database (the old code was shown to run on the 0034 schema). If a database restore is
  ever needed, use section 2's recovery path.

## 4. Procedure (all by an authorized operator; stop at the first failure)

```bash
cd /home/luna/xpertapply-pui01          # approved scripts live here
sha256sum staging-release.sh            # record it; the reviewer pins this value before approval
sudo bash ./staging-release.sh evidence       # 1. read-only: volumes, networks, images, migration scope  -> must end PASS
sudo bash ./staging-release.sh preflight      # 2. read-only: images, backup, snapshot, approved dry run
sudo bash ./staging-release.sh pin-rollback   # 3. adds two alias TAGS only
# --- the founder approves here ---
export XA_STAGING_APPROVED=yes-9dbf2836
sudo -E bash ./staging-release.sh migrate     # 4. one-off `alembic upgrade head` with the NEW image; exactly 0036 -> 0034
sudo -E bash ./staging-release.sh api         # 5. recreates ONLY xpertapply-staging-api (dry run is validated first)
sudo -E bash ./staging-release.sh web         # 6. recreates ONLY xpertapply-staging-web
sudo bash ./staging-release.sh verify         # 7. smoke checks
```

Guards in every mutating step: root, host, default Docker context, approval variable, image ID equality, a verified backup
(<24 h; take a fresh one first if older), database revision, startup-migration flag off, `--no-deps --no-build --pull never`,
Compose dry-run output validated by the approved `validate_dry_run` (exact names, own-id prefix, exit 0), post-step image ID,
identical volume mounts, healthy container, and every other container unchanged since the step began. `api` refuses to run
if the 0034 column is missing. Nothing runs `compose down`, removes a volume or image, prunes, pulls or builds.

### Manual smoke tests after `verify` (synthetic accounts only)
1. Staging web `/`, `/login`, `/signup`: 200, light-mode public pages, noindex header present (the script's validator).
2. Sign up a synthetic user, log out, log in, reload (session persists), open dashboard, jobs, tracker (resume and cover-letter downloads), profile.
3. Password recovery: `GET /auth/password-reset/availability` is `{"available":false}`; confirm the **login page does not offer a working-looking recovery link**
   (if it links to a page that says "unavailable", record it as a defect for the production feature gate; do not enable email).
4. Existing user (the pre-release account) still signs in with the previous token and password.
5. Extension: decide which build is under test (staging allowlist is `cglmdonb…`; the web build embeds `gnibjom…`), run the connect flow, an autofill session and a tracker confirmation.
6. CSP: the policy is report-only and lists only `https://api.xpertapply.com`; expect report-only violations against `api-staging`, no blocking.
7. API errors: unknown route returns the JSON 404, unauthenticated `/auth/me` returns 401.

### Rollback (any failed step)
```bash
export XA_STAGING_APPROVED=yes-9dbf2836
sudo -E bash ./staging-release.sh rollback-web     # restores sha256:30651fdd2fa8…
sudo -E bash ./staging-release.sh rollback-api     # restores sha256:436c05e7dff8…
sudo bash ./staging-release.sh verify
```
Roll back web first, then API. nginx noindex stays (it is independent); its own rollback is in the STG3B script.

## 5. Unresolved risks

1. **Mutating script modes are untested against real Docker.** Only syntax, the evidence logic (stubbed Docker, including drift cases) and the dry-run validator (89 cases) are tested. `compose run` for the one-off migration was never exercised; if it is refused, stop and report (no manual `docker exec` fallback is recommended while the old API is serving).
2. **Live compose files are root-only**, so the candidate's volume mapping is proved from labels, the previous rendered config and the repo file until `evidence` runs.
3. **Backup age**: the PUI-STG3A dump is from 05:30Z; `migrate` refuses one older than 24 h, and a fresh one is recommended immediately before migrating.
4. **Password-reset email is unverified.** Staging keeps it disabled. Production needs a real-mailbox test and a feature gate before customers see recovery.
5. **Extension identity and CSP** (above) are acceptance items, not proven.
6. **Production API shares the rollback image**; any removal of that tag affects production. Never prune.
7. The old API on the 0034 schema was shown on a synthetic database, not on staging data.

## 6. Operator root authorization

Required for `evidence`, `preflight`, `pin-rollback`, `migrate`, `api`, `web`, `verify` and the rollbacks (the compose
files, `.env.staging` and the override are readable only by `xpertapply`/root). `luna` cannot run them.
