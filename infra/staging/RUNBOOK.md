# Staging runbook (XA-STG0)

Nothing in this runbook has been executed. Every result below is something you must observe and record;
none is a claim. Placeholders in `<angle brackets>` are values only you can supply.

Staging is a second Compose project, `xpertapply-staging`, beside production on `srv738314` **only if** the
host preflight passes. All Compose commands go through `infra/staging/staging-compose.sh`, which refuses to
run from the production checkout, against a non-default Docker context, or with an unsafe rendered config.
The same files work unchanged on a separate VPS: put the checkout at the same path.

Production (verified from `docker-compose.yml` + `compose.production.yml` + `scripts/production-compose.sh`):
checkout `/home/luna/apps/XpertApply`, project `xpertapply`, API `127.0.0.1:8020`, web `127.0.0.1:3000`,
PostgreSQL 16, hostname `api.xpertapply.com`. Staging never touches any of those.

## 1. Host resource preflight (read-only)
```bash
sudo -iu luna
git clone --branch integrate/xa-core1-backend-onto-prod-ceb8314 <repo-url> /home/luna/apps/XpertApply-staging   # step 2
cd /home/luna/apps/XpertApply-staging && infra/staging/host-preflight.sh; echo "exit=$?"
```
Exit 0 = capacity measured and sufficient. Exit 1 = **same-VPS deployment BLOCKED**: use a separate machine.
Exit 2 = NOT VERIFIED: do not proceed until the unmeasured item is measured. Record the full output.

## 2. Check out the approved commit
```bash
cd /home/luna/apps/XpertApply-staging
git fetch origin && git checkout --detach <approved-integration-sha>   # expected: b03665a or a descendant
git status --short                                                    # must be empty
git merge-base --is-ancestor ceb8314 HEAD && echo "contains production baseline"
```
Never run this from `/home/luna/apps/XpertApply`. Never merge into `release/prod-google-auth`.

## 3. Initialise the staging environment
```bash
infra/staging/staging-compose.sh init-env        # writes infra/staging/.env.staging (600); prints no secrets
$EDITOR infra/staging/.env.staging               # set EXTENSION_ALLOWED_IDS only; AI stays disabled
```
`EXTENSION_ALLOWED_IDS` must be the id of the unpacked build under test (chrome://extensions). Confirm in that
build's service-worker console that `chrome.identity.getRedirectURL("xpertapply")` is
`https://<id>.chromiumapp.org/xpertapply`. No other id is accepted.

## 4. DNS · 5. HTTPS
Follow `DNS-TLS.md`. It needs the DNS records and certificates, and edits nginx by hand, outside this repository.

## 6. Validate the Compose configuration (side-effect free)
```bash
infra/staging/staging-compose.sh preflight
```
Expect `preflight passed (project=xpertapply-staging api=127.0.0.1:8021 web=127.0.0.1:3001 ...)`.

## 7. Backup and restore test (do this even on an empty database)
```bash
infra/staging/staging-compose.sh up                       # postgres, redis, api (first start; schema is empty)
infra/staging/staging-compose.sh backup                   # prints path, size, sha256
infra/staging/staging-compose.sh restore-test <that .dump>
```
`restore-test` verifies the checksum, restores into a throw-away `xa_restore_test_<timestamp>` database,
prints its table count and Alembic version, and drops only that scratch database.
The API container will not serve useful requests until step 8 creates the schema.

## 8. Schema migration
Migration graph on this branch (verified): `0031_publications → 0032_confirmation_contract →
0033_prod_auth_identities → 0035_extension_auth (head)`. The migration only creates `extension_auth_codes` and
`extension_credentials`; it modifies no existing table.
```bash
infra/staging/staging-compose.sh alembic-info             # before: expect heads = 0035_extension_auth
infra/staging/staging-compose.sh migrate                  # refuses without a backup < 24h old + checksum
infra/staging/staging-compose.sh alembic-info             # after: current = 0035_extension_auth
```
Post-check the schema: `docker exec xpertapply-staging-postgres psql -U <user> -d <db> -c '\dt extension_*'`
(2 tables) and `\di *extension_*` (7 indexes including the two primary keys). Do not run `alembic downgrade`; roll back from the backup (section 14).

## 9. API startup · 10. Health
```bash
infra/staging/staging-compose.sh up
curl -fsS http://127.0.0.1:8021/healthz && curl -fsS http://127.0.0.1:8021/readyz
curl -fsS https://api-staging.xpertapply.com/healthz            # after DNS + TLS
infra/staging/staging-compose.sh logs --since 10m api           # look for errors; tokens are redacted
```
Existing auth check: sign up a **dedicated staging test user** and call `/auth/me`.

## 11. Extension authentication API checks
Use dedicated test users only. Substitute your values.
```bash
API=https://api-staging.xpertapply.com
# website login token for the test user (from /auth/signup or /auth/login)
VERIFIER=$(python3 -c "import secrets;print(secrets.token_urlsafe(48))")
CHALLENGE=$(python3 -c "import hashlib,base64,sys;print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).rstrip(b'=').decode())" "$VERIFIER")
REDIR=https://<allowlisted-id>.chromiumapp.org/xpertapply
curl -sS -X POST $API/extension/auth/code -H "Authorization: Bearer $WEB_TOKEN" -H 'content-type: application/json' \
  -d "{\"code_challenge\":\"$CHALLENGE\",\"redirect_uri\":\"$REDIR\"}"            # 200 {code}
# expect 400: a redirect for an id NOT in EXTENSION_ALLOWED_IDS
# exchange: POST $API/extension/auth/token {grant_type:authorization_code,code,code_verifier,redirect_uri}
#   200 once; the same code again -> 400; a wrong verifier -> 400
# GET $API/extension/me with the access token -> the test user; GET $API/auth/me and /profile with it -> 401
# refresh twice with the same refresh token -> second 401, and the newest token then also fails
# POST $API/extension/auth/revoke -> 204; the access token now -> 401
```

## 12. Direct drafts and idempotency
```bash
curl -sS -X POST $API/extension/direct-sessions -H "Authorization: Bearer $EXT_TOKEN" \
  -H 'content-type: application/json' -d '{"url":"https://careers.example-employer.com/jobs/ml-engineer?utm=x"}'
```
Expect 201 with `session_token`; the same URL again returns the same `session_id`; a second test user gets a different
draft; the job row is `is_active = false`. With AI disabled the draft is still created and `warnings` records that
tailored documents could not be prepared (once, not on every request).

## 13. Website integration
Next stage: `up --with-web` builds the web image with the staging URLs and serves `/extension/connect`.

## 14. Safe rollback
* Code: `git checkout --detach <previous-sha>`, `staging-compose.sh build && staging-compose.sh up`. The previous API
  runs against the new schema (additive tables are ignored).
* Data: restore the pre-migration dump into a **new** database, verify, then switch `POSTGRES_DB`; never overwrite
  the live database in place and never run `alembic downgrade`.

## 15. Shutdown and cleanup (staging only)
```bash
infra/staging/staging-compose.sh stop        # keeps containers and data
infra/staging/staging-compose.sh down        # removes staging containers/networks, keeps volumes
```
The wrapper refuses `down -v`, `--rmi`, `docker volume rm` and any prune. Deleting staging data is a manual,
deliberate act: `docker volume rm xpertapply-staging-postgres-data` (exact name, after confirming no production
name matches). Never `docker system prune`.

## Isolation checks that need separate authorization
Not run in this stage and not to be run casually: confirming a staging token is refused by production
(use local signature/issuer/audience validation instead: staging uses a different `SECRET_KEY`, so it cannot
verify on production), the database firewall from the production side, and reading the production `.env` to
compare secret hashes (the wrapper does this automatically as the deployment user and prints nothing).
