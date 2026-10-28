# PUI-STG2: staging blocker resolution and controlled deployment preparation

**Final status: READY_FOR_AUTHORIZED_SERVER_REMEDIATION**

Every change needed to clear the four blockers is prepared, tested locally and reviewed, but **none has been executed on the server**.
This is not `READY_FOR_STAGING_APPLY`: noindex is not live, the running staging image and rollback image are unrecorded, the image is not loaded on the host, and
the script's `plan` has not run. Nothing was deployed, restarted, loaded, migrated, pushed or modified on any server. No nginx file was edited or reloaded.

Legend: **VERIFIED** (direct evidence) / **NOT VERIFIED** / **BLOCKED**. Artifacts live in `docs/release/pui-stg2/` (tracked) and
`docs/release/evidence/pui-stg2/` (untracked, large).

## A. Verified repository state

- VERIFIED: branch `feature/premium-ui-overhaul`, HEAD `ae5c064` at the start, tracked tree clean; `b357260` and `ae5c064` are ancestors of HEAD;
  `git diff b357260 HEAD -- apps/web` is empty, so the tested web source is unchanged.
- VERIFIED: the local image `xpertapply-staging-web:pui-b357260-amd64` is `linux/amd64` and its source label is `b35726083516ac8bb23f46fb51932eb4dd36a823`.
- VERIFIED preserved: `release/chrome-web-store` (`e1affbf`), `wip/pre-ui-overhaul-20261027` (`3cbd4c7`), `jobpilot-ai/`, `.git-stray-reinit-backup/`,
  the external git directory, and the screenshot evidence. No reset, stash, merge, delete or branch switch.
- Changes in this stage: `scripts/staging-web-release-premium-ui.sh` and its test; new files under `docs/release/pui-stg2/`; this report. No web source change.

## B. Noindex findings and proposed minimal patch

**Active configuration (read directly from the host, not from the repo template):** nginx 1.24 (Ubuntu), shared with unrelated sites. The active staging vhost is
`/etc/nginx/sites-available/xpertapply-staging` (root:root 0644, 1866 bytes, mtime 2026-10-23, **sha256 `1d635e304affc54a13303b6030b90dd8c1d159e3e8be915d2746837323a3c182`**):
a port-80 block for both staging names (ACME + 301), and one TLS server block each for `staging.xpertapply.com` (to `127.0.0.1:3001`) and `api-staging.xpertapply.com` (to `127.0.0.1:8021`).
It has **no `add_header` at any level**, no HSTS, and no robots header; `nginx.conf` has none at `http{}` level. The repo's `infra/staging/nginx/*.conf` template (which does set `X-Robots-Tag`) is **not** what is live.

**Live state, re-verified over public HTTPS during this stage:** no `X-Robots-Tag` on any staging web or API path; `robots.txt` and `sitemap.xml` currently return 404 (the live build is the older 50D build).
The RC image would change that: it serves `robots.txt` with `Allow: /` plus a sitemap listing staging URLs. `docs/release/pui-stg2/validate-staging-noindex.sh` run today: **9 of 9 staging header checks FAIL, production checks pass**.

**Patch:** `docs/release/pui-stg2/xpertapply-staging-noindex.patch` (3 hunks, applies cleanly to the exact live base copy `xpertapply-staging.live-base.conf`; the SSL key lines are not touched):
1. port-80 server block: `add_header X-Robots-Tag "noindex, nofollow" always;` (covers the 301 and the ACME location; neither defines its own `add_header`).
2. staging web TLS block: the same header at server level, plus `location = /robots.txt` and `location = /sitemap.xml` that `return 404` **and repeat the header**.
3. staging API TLS block: the same header at server level.

Why these shapes: nginx inherits `add_header` into a location only if that location defines none, so a location that adds its own header silently drops the inherited one. That is why the two `location =` blocks repeat it.
`robots.txt` is deliberately NOT turned into `Disallow: /`: crawlers must be able to fetch pages to see the noindex rule, and a disallowed URL can still be indexed without content. Keeping `robots.txt` and `sitemap.xml` as 404 on staging
preserves today's behavior, so the new app build cannot advertise staging URLs. No application code, CORS, HSTS or other security header is touched (staging has none to remove).

**Empirical proof (not assumed):** `docs/release/pui-stg2/test-noindex-nginx-local.sh` runs the live-base file, then the patched file, in a real `nginx:1.24` container with stub upstreams:
**15/15 PASS**, including: header absent before the patch; present after on `/`, a nested path, upstream 404 and 500, `robots.txt`, `sitemap.xml`, the API host, the port-80 301, the ACME path, and an nginx-generated **502** (upstream down);
and **absent** on a production-style vhost in the same nginx. `nginx -t` passes on both files.

**Validation after apply:** `bash docs/release/pui-stg2/validate-staging-noindex.sh` must exit 0 (9 staging checks PASS, sitemap/robots still 404, CORS `Access-Control-Allow-Origin: https://staging.xpertapply.com` still returned, production checks PASS).
**Rollback:** restore the timestamped backup of the vhost, `nginx -t`, `systemctl reload nginx` (operator steps below).

**Separate security concern (not fixed by noindex):** staging web and API are reachable by anyone on the internet. Noindex is a crawler hint, not access control. Whether sign-up is open on staging, or whether
an allowlist/basic auth is wanted, was not tested (no accounts were created). Recommend the operator decide on access restriction separately; basic auth on the API would break extension and browser testing.

## C. Production non-impact analysis

- Production vhost `/etc/nginx/sites-available/xpertapply` is a different file and different `server_name` set (`xpertapply.com`, `www`, `api.xpertapply.com`); the patch edits only the staging file's three server blocks. nginx selects a server block by `server_name`, so no staging directive can apply to a production host.
- Production currently has **no** `X-Robots-Tag`, and sends `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`. Baseline recorded before any change; the validator and the local nginx test both assert it stays unchanged.
- Production `robots.txt` and `sitemap.xml` currently return 404. The future production release of this web line will add them (intended: production should be indexable); that is a production-release concern and was not touched here.
- NOT VERIFIED: nginx behavior on the real host after reload (done only in a container); the other sites sharing this nginx were deliberately not read.

## D. Extension ID ownership and compatibility findings

**The two IDs come from two different extensions, both with verified provenance:**

| ID | Owner | Evidence |
|---|---|---|
| `gnibjomjfdobadlockphjiibbpmiehcj` | The **Chrome Web Store** item (production extension) | `docs/release/chrome-web-store/stable-id-handoff.md`: "official known Store item ID", status Draft/unpublished at that time, "never a test/unpacked ID" for production configuration |
| `cglmdonbfbadfbggkpajpkjgpekhkall` | A dedicated **`XpertApply (STAGING)` developer/unpacked build** (XA-EXT-STAGING-01) | commit `fb070c9` (2026-10-23) on `feature/xa-core1-direct-autofill`, `apps/extension/STAGING.md`, `src/staging-extension-key.mjs`. ID **independently re-derived from the committed public key: matches**. Private key discarded; must never go to the Store |

So the staging allowlist ID is **not** stale or incorrect: it is the purpose-built staging extension, and the runbook rule "no other id is accepted" is deliberate.

**How the website actually uses the ID (this web line):** `chromeExtensionId()` has **no caller** in `apps/web`. The extension is detected through a `window.postMessage` PING/PONG handshake
(`lib/autoApply.ts`: "no real extension id needed"). The ID only gates whether a supplied Store URL is accepted (`chromeExtensionUrl()`), and staging passes an empty URL. The ID-routed messaging bridge exists on the Web Store
line, not on this branch. **Consequence: the `gnibjom…` value baked into the RC image has no runtime effect on staging.**

**Option A, test staging with the published (Store) extension: not viable.** Its manifest (0.3.0) content scripts, `externally_connectable` and host permissions cover only `xpertapply.com`, `www.xpertapply.com` and `api.xpertapply.com`.
On `staging.xpertapply.com` it would not even inject, and it points at the production API.
**Option B, test staging with the dedicated staging build: viable and documented.** Per its commit and `STAGING.md` it trusts only the two staging origins, accepts only the staging API, has a pinned ID, and is the ID already in the staging API allowlist.

## E. Recommended staging extension configuration

**Recommendation: Option B.** Staging extension QA uses `dist-staging` built from `feature/xa-core1-direct-autofill` (`npm run build:staging`), loaded unpacked in a dedicated Chrome profile; the staging API allowlist stays exactly `["cglmdonb…"]`
(do **not** add the production Store ID); production is untouched.

**Web image:** no rebuild is required for this release, because the baked ID is inert on this web line (section D). I did not rebuild, so the verified image identity stands.
Record for later: if the extension-presence bridge from the Web Store line is ever merged into this branch, the staging web build must use `NEXT_PUBLIC_CHROME_EXTENSION_ID=cglmdonbfbadfbggkpajpkjgpekhkall` (STAGING.md section 4) and be rebuilt then; until that merge, changing it only churns the image.
**No founder decision is required.** If you prefer to align the value anyway, the one-line change is the `--build-arg` in `docs/release/PUI-STG1_STAGING_PREPARATION_REPORT.md` section F; it needs a rebuild and a new re-verification.
NOT VERIFIED: compatibility between the staging extension's protocol version (direct-autofill line) and this web line's handshake; this is a manual staging QA step.

## F. Administrative access and operator requirements

- The `xpertapply` SSH alias is the **unprivileged staging account** (groups `xpertapply,users`). It owns the staging infra directory but is **not** in the `docker` group (the `docker` group has exactly one member, **`luna`**, the production operator) and is not root.
- Its only sudo rights are three fixed, read-only helpers granted by the host admin: `xpertapply-staging-port-owner 3001`, `xpertapply-staging-port-owner 8021`, and `xpertapply-status` (lists the production compose project's container names and status).
- `/opt/xpertapply-staging-control` (the "protected deployment") is `root:root 0700`: not readable by the staging account.
- Intended privileged path (from the 50D script and the runbook): an authorized operator with Docker and root access (`luna` via the existing admin alias, then `sudo`) runs the release script, because the infra directory is readable only by `xpertapply` and Docker only by the docker group. **I did not use the `luna` alias or any broad privilege.**
- The permission system **denied** my attempt to run the three sudo helpers together (it flagged the production-status read). I did not retry that command. I then ran only the two staging-scoped `port-owner` helpers (section G).
- **Production path discrepancy, not resolved:** tracked `docs/deployment.md` and `scripts/production-compose.sh` say `/home/luna/apps/XpertApply` (user `luna`, host `srv738314`); the staging runbook and guard say `/home/xpertapply/apps/production`.
  The latter exists (owner `xpertapply`, 0750, checkout `a63945e`); the former is not visible to the staging account. The runtime answer is a Docker label, which needs privileged read access (operator check 5 below). Neither path was modified.
- Production and staging both listen on loopback (3000/8020 and 3001/8021); nginx fronts both on 80/443.

## G. Running staging image and rollback evidence

- VERIFIED (host's own helper, sudo-granted to the staging account): `xpertapply-staging-port-owner 3001` and `8021` both print `PASS: Verified staging owner of port …`. This proves the containers `xpertapply-staging-web` and `xpertapply-staging-api` are **running**, in compose project **`xpertapply-staging`**, services `web` and `api`, bound to `127.0.0.1:3001` and `127.0.0.1:8021` respectively.
- The live site's public bundle embeds the 50D-style build (API origin `api-staging…`, ID `gnibjom…`), consistent with the `stage50d` candidate, but the **image reference and id are NOT VERIFIED**: reading them needs Docker access.
- **NOT VERIFIED: the current running image id, whether the rollback image still exists on the host, the Docker engine version and storage driver.** No `before.*.txt` snapshots are visible to the staging account.
- The runbook's rollback (section 14) restores code and data, not a prebuilt web image; a Git checkout does not restore a container. The release script's `rollback` restores the previous image by id, so the operator must record `OLD_IMG`/`OLD_ID` first.
  The hardened script now **refuses to run `plan` or `apply` unless `OLD_ID` equals the image the staging web container is running today**, which makes a wrong rollback target impossible to carry forward.

## H. Docker image transfer and verification plan

**Digest types are different things and must not be compared with each other.** Measured for this image (same archive loaded into a Docker Desktop containerd store and into a classic overlay2 engine):

| Digest | Value | Store-dependent? |
|---|---|---|
| Image **tag** | `xpertapply-staging-web:pui-b357260-amd64` | n/a (mutable name) |
| `docker image inspect .Id` on Docker Desktop (containerd store) | `sha256:c5e12c4e…8419` (an **index** digest that includes an attestation entry) | **yes** |
| `.Id` on a **classic-store** engine after `docker load` of the transfer archive | `sha256:4966b0024452d234f8cd26d77b3e06fc0d48b2e08674fc6fa772ffeacca9fba4` (the **config** digest) | **yes** |
| amd64 **manifest** digest (inside the archive) | `sha256:5c220341f99df69ee2617fcb79bf4a51d20c39c37441b0557ccf8b36ddea70bc` | per format |
| **Layer diffID fingerprint** (`sha256` of the ordered layer diffIDs) | `ff0632c90a5e4cef2530a83b2dc666dc8e47a1acaee3487bb01a6d53b82ffb4a` | **no (identical on both stores)** |
| Registry digest | not applicable (never pushed) | n/a |

Which `.Id` the target host reports depends on its image store (classic: config digest `4966b002…`; containerd store: a manifest digest). The script compares `NEW_ID` with the **host's own** `docker image inspect -f '{{.Id}}'`, so **`NEW_ID` must be recorded on the host after loading**, never copied from this Mac.
The store-independent checks are the source label, `linux/amd64`, and the diffID fingerprint above.

**Transfer artifact (prepared, not uploaded or loaded):** `docs/release/evidence/pui-stg2/xpertapply-staging-web_pui-b357260-amd64.tar` (untracked, 340,582,400 bytes), made with `docker save --platform linux/amd64` so it contains one amd64 manifest and no attestation entries.
**SHA-256: `158302f0b96b01ce8376c0ce0a4f008901ec383138213b6a171bce516932c084`.** VERIFIED: the archive's index lists exactly one manifest (`5c220341…`, linux/amd64), its config blob is `4966b002…`, and loading it into a classic-store Docker engine
(an ephemeral `docker:dind` container, since removed) produced `.Id = sha256:4966b002…`, `linux/amd64`, the correct source label, 9 layers and the matching diffID fingerprint.
NOT VERIFIED: loading on the real host (its Docker version and store).

Process (operator, after authorization): copy the tar to a directory the operator controls; `sha256sum -c` against the value above; `docker load -i` (loads only into that host's engine, with the tag `…:pui-b357260-amd64`, which cannot collide with the rollback image tag);
then record on the host `docker image inspect -f '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}'` and the diffID fingerprint and compare with the table; export `NEW_IMG`, `NEW_ID` (from the host), `NEW_REV=b35726083516ac8bb23f46fb51932eb4dd36a823`.
The script enforces that the new tag and id differ from the rollback image's, so the rollback image cannot be overwritten.

## I. Script validation and PLAN results

`scripts/staging-web-release-premium-ui.sh` re-reviewed branch by branch. Earlier protections confirmed present (default Docker context, no `DOCKER_HOST`, `staging_guard.py rendered-config`, staging container identity, source revision label, same platform, changed-container detection, 0600 files and a private temp dir).
**New defects found and fixed in this stage:**
1. `NEW_IMG`/`OLD_IMG` were interpolated unvalidated into a YAML heredoc. They are now restricted to plain `repo:tag` references, and the ids to `sha256:<64 hex>`.
2. Nothing proved `OLD_ID` was what staging runs. `plan`/`apply` now abort unless the running `xpertapply-staging-web` container's image equals `OLD_ID`.
3. Nothing stopped the new image from reusing the rollback image's tag or id. It now aborts if either matches.
4. After `up`, the script never verified the running container's image and its health check only printed a code. It now exits 3 if the running image is not the intended one and exits 4 (with a rollback hint) if `127.0.0.1:3001` is not healthy after 10 tries.

`plan` assessment: its only effects are `docker compose config` (twice), `up --dry-run`, writing two 0600 override files beside the script, and a temp dir removed on exit; no containers are changed. It needs root and Docker, so it **was not run** (BLOCKED, section F).
`apply` and `rollback` were reviewed and **not executed**.
Tests: `scripts/test-staging-web-release-premium-ui.sh` **24/24 pass** (adds image-reference and id validation, tag collision, wrong running image, guard refusal, bad post-`up` image and failed health). These are stub-docker tests: they prove the decision logic, not a real Compose run.
**Expected output of a real `plan`:** `effective config identical except web.image`, the guard accepting the merged configuration, then a dry-run showing only `xpertapply-staging-web` recreated. If the guard refuses the merged configuration, `plan` aborts safely and the refusal reasons name settings without values.

## J. Shared-host security findings

Evidence: the host's staging compose file and the image itself.
- Staging web service: no `privileged`, no `cap_add`, no volumes or host mounts, no Docker-socket mount, no host/pid network mode, loopback-only port, `edge` network only, `mem_limit 512m`, `cpus 1.0`, `pids_limit 256`. The compose file records that `no-new-privileges` is deliberately **not** set (it causes AppArmor entrypoint denials on this host), keeping Docker's default AppArmor and seccomp profiles.
- Image (VERIFIED locally): runs as **root** (`uid=0`, no `USER`), default capabilities, writable root filesystem, **0 setuid binaries**, ships dev tooling (vitest, eslint, playwright, tsc), tests and e2e sources; no healthcheck.
- Container root is not host root here (no privileged mode, socket, mounts or host namespaces), but it is also not harmless: it widens the blast radius of any in-container code execution on a host shared with production.
- NOT VERIFIED (needs Docker access): the running container's actual user, capabilities and security options, daemon user-namespace settings, Docker version and snap packaging.
- **Dependency advisories (`npm audit --omit=dev` on the `b357260` lockfile, run today): 1 critical, 3 high.** `next@16.3.5` (RCE in `next/og` ImageResponse; `use cache`/Draft Mode leak), `sharp` (librsvg), `zod` (oversized-collection memory exhaustion), `source-map-js` (build-time DoS); fixes exist. **Reachability, checked in source and in the built route manifest:** no `next/og`, `ImageResponse`, OG-image routes, `use cache` or Draft Mode usage exists (25 routes); the image optimizer is on but has no remote patterns and `dangerouslyAllowSVG` is off, so the librsvg path is not reachable. Assessed unreachable by code path, **not** patched. The production line already carries the same posture.

Classification:
- **Staging blockers: none** from this review (no privileged mode, socket or host mounts; loopback and network-isolated; advisory code paths unreachable).
- **Production release blockers:** upgrade `next`, `sharp`, `zod` (a zod major bump may be involved) and re-qualify; and decide whether to keep a critical advisory in production dependencies on the same host. A dedicated dependency stage, not part of staging.
- **Non-blocking improvements:** `USER node`, drop capabilities, read-only root filesystem with a writable temp mount, multi-stage build with production-only dependencies, add a healthcheck. No Dockerfile rewrite was done here.

## K. Google OAuth testing limitation

- VERIFIED (public GET today): `https://api-staging.xpertapply.com/auth/providers` returns `{"google":{"enabled":false}}`; the host compose file sets `GOOGLE_OAUTH_ENABLED: "false"` and no `GOOGLE_*` keys exist in `.env.staging` (key names only were listed).
- Consequence: the Google button will not render on staging and **end-to-end Google sign-in is NOT VERIFIED and cannot be verified there**. The callback error page ("Back to sign in") can still be checked by visiting the callback with an error parameter.
- Not enabled, and no Google Cloud credentials or redirect URIs were touched. Before the production release, Google sign-in must be verified by one of: a separate staging OAuth client and callback URI (a deliberate operator change to staging only), or a controlled production smoke test with a dedicated test Google account immediately after release, with a rollback ready.

## L. Exact remaining blockers

1. **Noindex not live on staging** (nginx patch prepared, tested, not applied). Requires root on the host.
2. **Running staging image and rollback image unrecorded**; Docker version/store unknown. Requires Docker access.
3. **Image not loaded on the host; target image identity not recorded.** Requires an authorized `docker load`.
4. **Script `plan` not run** on the real runtime. Requires root and Docker.
5. Active production checkout path unresolved (two records disagree). Requires a Docker label read.
Not blockers but open: staging public reachability (decision), Google OAuth unavailable on staging, dependency advisories (production release), root container user.

## M. Next authorized actions (in order, all by an authorized operator)

1. Operator read-only checks (checklist below); record the running image id and the rollback image.
2. Apply the nginx patch with a backup, `nginx -t`, reload; run `validate-staging-noindex.sh` until it exits 0.
3. Transfer and load the archive; record `NEW_ID` on the host; verify label, platform and diffID fingerprint.
4. Run `plan`; review; re-issue this gate. Only then consider `apply`, followed by the QA checklist in `PUI-STG1_STAGING_PREPARATION_REPORT.md` section M, with the staging extension for extension QA.

## N. Final release-gate recommendation

**READY_FOR_AUTHORIZED_SERVER_REMEDIATION.** The four blockers are each reduced to a precise, tested, reviewable action: noindex (patch + 15/15 nginx tests + validator), extension ID (resolved by evidence; Option B; no rebuild), operator path (documented; privileged checks listed), image identity (archive + measured digest taxonomy + store-independent fingerprint).
`READY_FOR_STAGING_APPLY` is withheld because items L.1-L.4 require server-side execution that has not happened. Production readiness is a separate, later decision and also needs the dependency upgrade.

---

## Operator checklist (verified commands and prerequisites only; no secrets)

Run as an authorized operator with Docker access on `srv738314` (Docker group member `luna`, or root). Read-only unless marked **CHANGE**.

**1. Record the current runtime (read-only)**
```bash
docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'
docker info --format '{{.Driver}} {{json .DriverStatus}}'      # "io.containerd.snapshotter" in output = containerd store
docker inspect -f '{{.Name}} image={{.Config.Image}} imageId={{.Image}} state={{.State.Status}}' xpertapply-staging-web
docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.project.working_dir"}}' xpertapply-staging-web
docker inspect -f 'user={{.Config.User}} privileged={{.HostConfig.Privileged}} capAdd={{.HostConfig.CapAdd}} secOpt={{.HostConfig.SecurityOpt}} mem={{.HostConfig.Memory}} pids={{.HostConfig.PidsLimit}} mounts={{len .Mounts}}' xpertapply-staging-web
docker images --filter reference='xpertapply-staging-web*' --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}'
docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' xpertapply-web-1   # which production path is live
```
Record `OLD_IMG` (the tag from `Config.Image`) and `OLD_ID` (= `imageId`). **Do not remove or retag that image.**

**2. noindex (CHANGE, root)**
```bash
F=/etc/nginx/sites-available/xpertapply-staging
sha256sum $F        # must be 1d635e304affc54a13303b6030b90dd8c1d159e3e8be915d2746837323a3c182 (else STOP: the file changed)
cp -p $F $F.bak.$(date +%Y%m%d%H%M%S)
patch --dry-run $F < docs/release/pui-stg2/xpertapply-staging-noindex.patch && patch $F < docs/release/pui-stg2/xpertapply-staging-noindex.patch
nginx -t && systemctl reload nginx
bash docs/release/pui-stg2/validate-staging-noindex.sh      # expect exit 0
# rollback: cp -p the .bak file back over $F; nginx -t && systemctl reload nginx
```

**3. Image transfer (CHANGE: load)**
```bash
sha256sum -c <<< '158302f0b96b01ce8376c0ce0a4f008901ec383138213b6a171bce516932c084  xpertapply-staging-web_pui-b357260-amd64.tar'
docker load -i xpertapply-staging-web_pui-b357260-amd64.tar
I=xpertapply-staging-web:pui-b357260-amd64
docker image inspect -f 'NEW_ID={{.Id}} {{.Os}}/{{.Architecture}} rev={{index .Config.Labels "org.opencontainers.image.revision"}}' $I
docker image inspect -f '{{range .RootFS.Layers}}{{println .}}{{end}}' $I | sha256sum   # expect ff0632c90a5e4cef2530a83b2dc666dc8e47a1acaee3487bb01a6d53b82ffb4a
```
Expect `linux/amd64`, `rev=b35726083516ac8bb23f46fb51932eb4dd36a823`; on a classic store `NEW_ID=sha256:4966b002…fba4`.

**4. Plan (read-only effects; needs root and Docker)**
```bash
export NEW_IMG=xpertapply-staging-web:pui-b357260-amd64 NEW_ID=<from step 3> OLD_IMG=<step 1> OLD_ID=<step 1> NEW_REV=b35726083516ac8bb23f46fb51932eb4dd36a823
sudo -E bash scripts/staging-web-release-premium-ui.sh plan
```
Expected: `effective config identical except web.image`, guard accepted, dry run shows only `xpertapply-staging-web` recreated. Anything else: STOP. **Do not run `apply` until this gate is re-issued.**
