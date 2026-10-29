# PUI-STG3: Premium UI staging release runbook (API + web)

Status: **DRAFT. NOTHING IN THIS RUNBOOK HAS BEEN EXECUTED.** Every expected output below is something an operator must
observe and record. Staging only; production is never touched. Source: `9dbf2836a6ffa374d6e626a368820fd79410ba78`.

## 0. Why this is not just `staging-compose.sh`

`infra/staging/staging-compose.sh` cannot be pointed at the live staging stack:

* it refuses root and requires the checkout at `/home/luna/apps/XpertApply-staging` (absent), while the live stack runs
  from `/home/xpertapply/apps/staging/infra/staging` (api, web) and `/opt/xpertapply-staging-control/infra/staging`
  (postgres, redis);
* its `up` names `postgres redis api` and would try to reconcile the live database containers.

So the release follows the pattern already reviewed in `scripts/staging-web-release-premium-ui.sh`: layered `-f` override
files, `--no-deps --no-build --pull never`, one service at a time, with a before/after container snapshot. That script is
web-only; the API steps below use the same pattern and **must be dry-run first (`up --dry-run`)** before the real run.
Do not use `staging-compose.sh up/down` on this host.

## 1. Facts to record before anything else

| Item | Value |
|---|---|
| New API image (host) | `xpertapply-api:pui-9dbf283-amd64` = `sha256:87c7226837b6133aadd3ffc72f88acb1119b0fca9c013f267b597d649bd83e55` |
| New web image (host) | `xpertapply-staging-web:pui-9dbf283-amd64` = `sha256:fb51cfd76b1ae7ea8bd1b473ef59d6cb60d3935ae2332586cfb3d0d320a819cd` |
| Rollback API image | `xpertapply-api:nav02-gated-1516f23` = `sha256:436c05e7dff8…` (also what PRODUCTION runs: never retag or remove) |
| Rollback web image | `xpertapply-staging-web:stage50d-cb76c3d` = `sha256:30651fdd2fa8…` |
| Staging DB revision now | `0036_application_doc_snapshots` (verified read-only) |
| Candidate head | `0034_password_reset`, one migration, parent `0036_application_doc_snapshots` |

Re-verify the IDs on the host (`docker image inspect -f '{{.Id}}' <tag>`) and the revision label
(`org.opencontainers.image.revision` = the commit above). Any mismatch: STOP.

## 2. Roles

* **luna** (docker group, no root): sections 3 and 4 (backup, restore test, read-only checks).
* **root / authorized owner:** sections 5 to 8 (nginx, release). The infra directory and `.env.staging` are readable only
  by `xpertapply`.

## 3. Backup of the staging database (luna, no root needed)

Reads the database through the running staging Postgres container; no credentials are printed.

```bash
umask 077; B=/home/luna/staging-backups; mkdir -p $B; chmod 700 $B
F=$B/xpertapply-staging-pre-0034-$(date -u +%Y%m%dT%H%M%SZ).dump
docker exec xpertapply-staging-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$F"
[ -s "$F" ] && (cd $B && sha256sum "$(basename $F)" | tee "$(basename $F).sha256")
```

Require a non-empty file and record size and SHA-256. Also record the staging row counts that matter for the post-check:

```bash
docker exec xpertapply-staging-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
 -c "select count(*) from users" -c "select count(*) from applications" -c "select version_num from alembic_version"'
```

## 4. Isolated restore test (luna)

Restores into a disposable database and drops only that database. Staging data is not modified.

```bash
S=xa_restore_test_$(date -u +%Y%m%d%H%M%S)
docker exec xpertapply-staging-postgres sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE $S'"
docker exec -i xpertapply-staging-postgres sh -c "pg_restore -U \"\$POSTGRES_USER\" -d $S --no-owner --exit-on-error" < "$F"; echo restore-exit=$?
docker exec xpertapply-staging-postgres sh -c "psql -U \"\$POSTGRES_USER\" -d $S -At -c 'select version_num from alembic_version' -c 'select count(*) from users'"
docker exec xpertapply-staging-postgres sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -c 'DROP DATABASE IF EXISTS $S'"
```

Pass criteria: `restore-exit=0`, revision `0036_application_doc_snapshots`, user count equals section 3. **No backup
that has not been restore-tested counts.** The dump stays under `/home/luna/staging-backups` (0700).

## 5. Staging-only noindex (root; PUI-STG3B)

Use the guarded script `docs/release/pui-stg2/staging-nginx-noindex.sh` (modes `plan`, `apply`, `rollback`). It pins the
host name, the reviewed patch and validator SHA-256 values, the live file baseline (`1d635e30…`) and the exact expected
result (`c7f40f8b…`). It edits only `/etc/nginx/sites-available/xpertapply-staging`, takes a verified backup
(`xpertapply-staging.bak-noindex-<UTC>`, never overwritten), runs `nginx -t` before and after, restores automatically if
the post-change test fails, reloads gracefully (no restart), and proves that production files and all container
IDs are unchanged before it runs the public validator.

```bash
bash staging-nginx-noindex.sh plan                 # read-only, any user
sudo bash staging-nginx-noindex.sh apply           # only after the plan is reviewed and approved
sudo bash staging-nginx-noindex.sh rollback [backup-file]
```

Notes: nginx adds the header itself, so the app's own `X-Robots-Tag` on `/forgot-password` and `/reset-password` will
appear twice with the same value (harmless). The staging vhost has no other `add_header`, so nothing is suppressed, and
staging nginx adds no HSTS or frame headers (unchanged from today; production sets its own in a separate file). Noindex is
a crawler hint and is not access control.

## 6. Pre-flight for the release (root)

```bash
export INFRA=/home/xpertapply/apps/staging/infra/staging
export API_OVR=/home/xpertapply/nav02-staging-release-1516f23/staging-api.release.yml   # existing override (api pinned to nav02)
export NEW_API=xpertapply-api:pui-9dbf283-amd64 NEW_WEB=xpertapply-staging-web:pui-9dbf283-amd64
docker context show        # must print: default      (DOCKER_HOST and DOCKER_CONTEXT must be unset)
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | sort > /root/pre-release.containers.txt   # snapshot
curl -fsS https://api-staging.xpertapply.com/healthz
```

Create two small override files (images only; no environment values):

```bash
cat > /root/pui-api.new.yml <<Y
services:
  api:
    image: $NEW_API
Y
cat > /root/pui-web.new.yml <<Y
services:
  web:
    image: $NEW_WEB
Y
```

Define the same helper the reviewed web script uses (minimal environment so the host cannot override the env file):

```bash
dc() { env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  docker compose --project-name xpertapply-staging --project-directory "$INFRA" --env-file "$INFRA/.env.staging" \
  -f "$INFRA/compose.staging.yml" -f "$API_OVR" "$@" ; }
```

**Dry run both recreations and read the output.** Only `xpertapply-staging-api` and `xpertapply-staging-web` may appear:

```bash
dc -f /root/pui-api.new.yml up --dry-run -d --no-deps --no-build --pull never api
dc -f /root/pui-web.new.yml --profile web up --dry-run -d --no-deps --no-build --pull never web
```

If `postgres`, `redis`, `worker` or `scheduler` appear, or the rendered web service is not named `xpertapply-staging-web`,
**STOP**. Also run the repository guard on the rendered config:
`dc -f /root/pui-api.new.yml --profile web config --format json | python3 $INFRA/staging_guard.py rendered-config`.

## 7. Release (root), in this order

Order matters. The old API ignores the new column and table, so migrating first is safe for the running service. The new
API reads `users.password_changed_at`, so it must not serve before 0034 exists.

1. **Migrate with the NEW image in a one-off container** (does not touch the running API):
   ```bash
   dc -f /root/pui-api.new.yml run --rm --no-deps --entrypoint alembic api heads     # expect: 0034_password_reset (head)
   dc -f /root/pui-api.new.yml run --rm --no-deps --entrypoint alembic api current   # expect: 0036_application_doc_snapshots
   dc -f /root/pui-api.new.yml run --rm --no-deps --entrypoint alembic api upgrade head
   dc -f /root/pui-api.new.yml run --rm --no-deps --entrypoint alembic api current   # expect: 0034_password_reset (head)
   ```
   Exactly one `Running upgrade 0036_application_doc_snapshots -> 0034_password_reset` line; anything else: STOP and
   restore from section 3 (new database, never in place).
   If `run --entrypoint` is refused by the staging guard or compose file, use `docker exec xpertapply-staging-api alembic
   upgrade head` only **after** step 2 (the new API then briefly serves before the schema exists; accept this only on
   staging and only if the dry run in section 6 was clean).
2. **Recreate the API only:**
   `dc -f /root/pui-api.new.yml up -d --no-deps --no-build --pull never api`
   then `curl -fsS http://127.0.0.1:8021/healthz && curl -fsS http://127.0.0.1:8021/readyz` and
   `curl -fsS https://api-staging.xpertapply.com/healthz`.
3. **Recreate the web only:**
   `dc -f /root/pui-web.new.yml --profile web up -d --no-deps --no-build --pull never web`
   then `curl -fsS -o /dev/null http://127.0.0.1:3001/`.
4. **Prove nothing else moved:** `docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | sort | diff /root/pre-release.containers.txt -`
   may differ only on the `xpertapply-staging-api` and `xpertapply-staging-web` lines. Production containers (`xpertapply-api-1`,
   `xpertapply-web-1`, `xpertapply-worker-1`, `xpertapply-scheduler-1`, `xpertapply-postgres-1`, `xpertapply-redis-1`),
   `xpertapply-staging-postgres`, `xpertapply-staging-redis` and all `veotrex-*` containers must show the same IDs and uptime.
5. Record the running image IDs: `docker inspect -f '{{.Name}} {{.Image}}' xpertapply-staging-api xpertapply-staging-web`.

## 8. Email and recovery on staging

Staging has no `EMAIL_BACKEND`/`SMTP_HOST`; the code default is `disabled`, so
`GET /auth/password-reset/availability` returns `available:false` and the UI must not offer a working form. Verify that
and check the **login page itself** for a recovery link that leads to an unusable page: if one is shown, record it as a
defect (do not enable Resend on staging; delivery testing uses an isolated sink or the reviewed
`scripts/auth-recovery-e2e` flow). Real-mailbox delivery stays NOT VERIFIED until a production-key-separated test.

## 9. Acceptance (synthetic accounts only)

Home, login, signup, logout, session persistence, dashboard, jobs, tracker (resume and cover-letter downloads), profile,
resume, cover letter, health and error responses, light-mode public routes, dark/light preference in the app, mobile
layouts, accessibility, CSP report-only behaviour (the policy lists only the production API origin; expect report-only
violations against `api-staging`, no blocking), noindex headers, and extension compatibility (staging allowlist is
`cglmdonb…`; the web build embeds `gnibjom…`; decide which build is under test). Google sign-in is disabled on staging and
cannot be claimed as passed.

## 10. Rollback

Triggers: failed health check, unexpected container change, migration anomaly, regression in login or tracker.

1. Web: `dc -f /root/pui-web.old.yml --profile web up -d --no-deps --no-build --pull never web` where the override pins
   `xpertapply-staging-web:stage50d-cb76c3d` (verify its ID is still `sha256:30651fdd2fa8…`).
2. API: same with `xpertapply-api:nav02-gated-1516f23`. The old API runs unchanged on the 0034 schema because 0034 is
   additive (nullable column plus new table).
3. **Do not run `alembic downgrade` or `stamp`.** If data is damaged, restore the section 3 dump into a **new** database,
   verify, then repoint; never overwrite the live database in place.
4. noindex: restore the nginx `.bak`, `nginx -t`, reload.

## 11. Stop conditions

Image ID or label mismatch; dry run touches anything other than staging api/web; migration output other than the single
0034 step; backup missing, empty or not restore-tested; production container ID or uptime changes; `docker context` not
`default`; validator for noindex not exiting 0; any request to bypass file permissions.

## 12. Known gaps in this draft

* The existing override `staging-api.release.yml` and `.env.staging` were not readable by `luna`, so the exact `-f`
  stack and whether `run --entrypoint` is accepted are **unverified**. The dry run in section 6 is the gate.
* The 0034 docstring header says "Revises: 0033"; the code revision is correct (`0036`). Cosmetic.
* Worker and scheduler are not part of the live staging stack; none are recreated here.
* Password-reset email delivery, real-mailbox acceptance and the Forgot-Password feature gate for production remain open.
