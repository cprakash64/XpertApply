# S2 staging web release: enforced CSP baseline + staging Report-Only origin (web only)

Status: **PREPARED, NOT EXECUTED.** Nothing was pushed, uploaded, deployed or changed on staging or production. Nginx (including the deployed S1 headers) is never read for writing or edited by this release.

## 1. What this release is
- **Source (image revision label):** `95de9778b54f6fe18894e088bd29ab72307bb74b` (`95de977`), branch `feature/premium-ui-overhaul`.
- Staging today: web **F4** `baf0817` (running image `sha256:fd93a786…ea03`), API `aa5bc2f` (running image `sha256:c7a15f1e…3440`), database `0034_password_reset`, S1 nginx headers deployed.
- Source audit (`git log baf0817..95de977`, `git diff baf0817 95de977`): the only product commits are `04e872c` (per-environment Report-Only origin), `cf17123` (enforced baseline `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`) and `95de977` (WebKit-only e2e traversal key). Between F4 and the source only four files under `apps/web` differ (`lib/securityPolicy.mjs`, `next.config.mjs`, and two test files); nothing outside `apps/web` and `docs/` changed. `baf0817`, `cf17123` and `95de977` are all ancestors of the source. No unfinished feature rides along.
- Not in this release: `script-src` enforcement, `form-action` enforcement, any nginx change, any API, database, SMTP or extension change, anything on production.

## 2. Artifacts
| | |
|---|---|
| Image | `xpertapply-staging-web:s2-95de977-amd64`, `linux/amd64`, 9 layers, 342,490,745 B, built from a clean `git archive` of `apps/web` at `95de977` (237 files, **0** env files, no `node_modules`/`.next`) |
| Local image ID (this Mac, containerd store; a loaded image gets a host-specific ID) | `sha256:23514b8f5053f79abd9d244a3544e3e02b0f25c8fe5173f491601cce896ba064` |
| **Layer fingerprint** (sha256 of the JSON layer list; what the script pins) | `ff8c29c3ec6ab407cdde3f5769b9893208fff4d1fabe1bc6957d3135a22aed54` |
| Revision label | `org.opencontainers.image.revision=95de9778b54f6fe18894e088bd29ab72307bb74b` |
| Archive | `xpertapply-staging-web-s2-95de977-amd64.tar`, 342,510,080 B, SHA-256 `b040c82ef9869352bb5013204bd075c303fa694136ce26782c92e4dc750ea11b` (kept in the session scratchpad, not in Git, not uploaded) |
| Release script | `docs/release/pui-s2/staging-s2-web-release.sh`, SHA-256 `8e7a94e52d0993b7dea234294061bd4c2d1fcefb57230dc83a3793b83882f14d` |
| Dry-run validator (already on the host from earlier releases; the script refuses any other version) | `/home/luna/xpertapply-pui01/staging-release-dryrun.sh`, SHA-256 `93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39` |
Build values (same as every earlier staging web): `NEXT_PUBLIC_API_URL=https://api-staging.xpertapply.com`, `NEXT_PUBLIC_SITE_URL=https://staging.xpertapply.com`, `NEXT_PUBLIC_CHROME_EXTENSION_URL=` (empty), `NEXT_PUBLIC_CHROME_EXTENSION_ID=` (empty, unchanged). Runtime `NEXT_PUBLIC_*` in `compose.staging.yml` carries the same API and site URLs.

### Environment precedence (verified)
Next.js order is process environment, then `.env.production.local`, `.env.local`, `.env.production`, `.env`. The developer's `apps/web/.env.local` sets `NEXT_PUBLIC_API_URL=http://127.0.0.1:8001`, is git-ignored, and would be picked up by any build made from a working directory instead of a clean archive. The image was therefore built only from the clean archive (0 env files), and the Dockerfile `ENV` (from the build args) is the only source. The CSP origin is derived from the same variable at build and again when `next start` loads the config; both are `https://api-staging.xpertapply.com`, and a malformed or non-https value stops the server at startup (fail closed) instead of emitting a wrong policy.

### Image content checks
Production API URL (`https://api.xpertapply.com`) occurs only in two shipped test files (`__tests__/securityPolicy.test.ts`, `__tests__/productionCompose.test.ts`; the Dockerfile has always copied tests) and in **no** client chunk or server bundle; staging API URL occurs in 9 `.next` files; `127.0.0.1:8001`/`localhost:8000` in client chunks: 0; secret-pattern hits (private keys, `sk-`, `AKIA`, `ghp_`, `xox`): 0; runs as uid 0 like every earlier image (unchanged; hardening is the compose `*hardening` anchor's job).

## 3. Security verification (served image behind the reviewed S1 nginx config)
`bash docs/release/pui-s2/test-s2-image-smoke.sh` runs the real amd64 image behind nginx 1.24 using the reviewed S1 candidate vhost and executes the release script's own contract (117 checks, 0 failed) on `/login /signup /forgot-password /reset-password /dashboard /jobs /tracker /extension/connect` and a 404:
exactly one enforced `Content-Security-Policy` equal to the baseline (no `script-src`, `form-action`, `default-src`, `connect-src`); exactly one `Content-Security-Policy-Report-Only` whose `connect-src`/`img-src` name `https://api-staging.xpertapply.com`, never the production API, and which keeps `script-src 'self'`; HSTS `max-age=300`, `X-Frame-Options: DENY`, `nosniff` each exactly once; `Referrer-Policy` once (`no-referrer` on `/forgot-password` and `/reset-password`, otherwise `strict-origin-when-cross-origin`); `X-Robots-Tag: noindex, nofollow` once everywhere; recovery pages keep `Cache-Control: no-store`; dynamic `/jobs/1` and `/matches/1` are `private, no-store` (never public/`s-maxage`); static files carry no CSP; `/robots.txt` and `/sitemap.xml` stay 404. Static shells keep `s-maxage=31536000` and contain no user data (sessions live in the browser; API responses are bearer-token authenticated).

Header values served for the record (`/login`): `Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'` and a Report-Only policy identical to the one in production except for the API origin.

## 4. Tests (all on source `95de977`)
- `npm run lint`, `npm run typecheck`: clean. `npm test`: 62 files, **1216** tests pass. `npm run build`: succeeds.
- Playwright (production build; `API_BASE_URL=http://127.0.0.1:8001`, which the mocked specs need): Chromium **all pass**, including the Apply dialog keyboard specs (Escape, focus trap, axe), jobs workspace, tracker documents/downloads, applied-to-tracker, password recovery, session expiry. (The 12 failures seen in the earlier S1/S2 round were caused by running without that variable.)
- Cross-browser CSP baseline script (`pui-s1s2/crossbrowser-baseline.mjs`): Chromium and WebKit pass; Firefox passed on the operator's machine.
- WebKit (macOS) on the same build: recovery, tracker, session, applied-to-tracker specs pass. The **Apply dialog specs fail in WebKit (8 of 9)**; this is **not** caused by this release: with the enforced CSP stripped by a proxy, with both CSP headers stripped, and with both present, the same ones fail (see section 9). 
- Script logic: `bash docs/release/pui-s2/test-s2-release-script.sh` runs the release script against a stub docker/curl in a Debian container: 31/31 pass (see section 7).

## 5. Commands (root on `srv738314`, staging only; stop at the first `STOP`)
```bash
echo "b040c82ef9869352bb5013204bd075c303fa694136ce26782c92e4dc750ea11b  xpertapply-staging-web-s2-95de977-amd64.tar" | sha256sum -c - || exit 1
sudo docker load -i xpertapply-staging-web-s2-95de977-amd64.tar          # adds the image; replaces nothing
cd /home/luna/xpertapply-pui01 && echo "8e7a94e52d0993b7dea234294061bd4c2d1fcefb57230dc83a3793b83882f14d  staging-s2-web-release.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-s2-web-release.sh preflight    2>&1 | tee s2-1-preflight.txt   # READ-ONLY; must end PREFLIGHT PASS
sudo bash ./staging-s2-web-release.sh pin-rollback 2>&1 | tee s2-2-pin.txt         # adds one alias TAG on the running F4 web image
# --- proceed only with the founder's approval ---
export XA_STAGING_APPROVED=yes-s2-95de9778
sudo -E bash ./staging-s2-web-release.sh web       2>&1 | tee s2-3-web.txt         # recreates ONLY xpertapply-staging-web
sudo bash ./staging-s2-web-release.sh verify       2>&1 | tee s2-4-verify.txt
sudo chown luna:luna s2-*.txt
```
What each mode does:
- `preflight` (read-only; writes nothing under `/root`): host name, default Docker context, dry-run validator hash; candidate image fingerprint, revision label, `linux/amd64`; **running web must be exactly the F4 image** (host id `sha256:fd93a786…`, fingerprint `7f9f346b…`, label `baf0817…`); **API must be exactly the F2 image** (host id `sha256:c7a15f1e…`, fingerprint `87b53b0e…`, label `aa5bc2f…`); database `0034_password_reset (head)`; `EMAIL_BACKEND` unset; API health; compose `up --dry-run` limited to `xpertapply-staging-web`; S1 headers already active (the release refuses to run ahead of S1). If the web already runs the candidate it says so and exits 10.
- `pin-rollback`: one `docker tag` alias `xpertapply-staging-rollback:web-f4-baf0817` on the running F4 image; idempotent; verifies the alias fingerprint, label and host id.
- `web` (needs `XA_STAGING_APPROVED=yes-s2-95de9778`): one lock (concurrent operators are refused), alias must exist, snapshot of all containers, `docker compose ... --profile web up -d --no-deps --no-build --pull never web` after the approved dry run shows only the web, then volumes unchanged, health, local and public answers, Jobs UI strings, API untouched, every other container identical, and the **full live header contract**. Phases are appended to `/root/pui-s2/web-release.log` (`BEGIN`, `REPLACED`, `HEALTHY`, `VERIFIED`).
- `verify` (read-only): candidate running; header contract; API S1 headers, 401s, CORS; production API healthy and production web **without** an enforced CSP; protected containers identical to the pre-release snapshot; prints the staging vhost SHA-256 for comparison with the S1 record.
- `rollback-web` (needs the same approval): restores the **verified F4 image through the alias** (never the older F2 web), checks fingerprint, label and host id, health, others unchanged, API unchanged, S1 headers still once, enforced CSP gone.

Exit codes: 0 done and verified; 1 stopped, nothing changed; **2 the web container was replaced (or restored) but verification did not complete**; 10 nothing to do. The final `RESULT` block always states whether the web container was replaced (old and new container ids) and whether verification completed.

## 6. Signed-in browser acceptance (needs an approved throwaway staging account; none was created)
On `https://staging.xpertapply.com`, desktop and phone width, light and dark: sign in (and Google sign-in if enabled: top-level redirect, unaffected by this policy); Dashboard and Jobs load; automatic fit scoring starts on opening Jobs and the scoring notice appears/clears; open **Apply on official site** by keyboard, focus enters the dialog, Tab/Shift+Tab stay inside, Escape closes it with focus back on the button; Tracker lists applications and **Download resume** saves with the server filename; Profile and Settings save; `/forgot-password` shows the honest "unavailable" state with no email form and `/reset-password` removes any token from the address bar; `/extension/connect` renders (the staging API allowlist holds the unpacked-build ID, so a full connect with the store build is not expected). In DevTools: no failed requests, no mixed-content warnings, and **no enforced-CSP violations**. Report-Only reports are expected and acceptable: two `script-src-elem inline` entries per page (Next.js inline flight data) and the `upgrade-insecure-requests ... ignored in report-only` console notice.

## 7. Release-script safety and the F4 anomaly
### F4 deployment anomaly: findings
Reported: the F4 `web` command printed a running-image fingerprint mismatch although the F4 candidate was already running when inspected afterwards. **The operator's output files (`f4-3-web.txt`) and host logs are not in this repository or session, so the exact cause cannot be proven from here; I am not guessing.** What the F4 script itself establishes:
1. Every fingerprint test in `web` happens as a **precondition**: "staging web currently running" must equal the older F2 web (`64f80564…`). After the container is recreated there is no comparison against that value; the post-change checks compare against the candidate. So the message "staging web currently running: layer fingerprint mismatch" can only have been produced **before** the recreation step of that invocation, i.e. by an invocation that started when the candidate was already running (a second run after a first run that had already replaced the container), or by a different mode run afterwards (`preflight` and `pin-rollback` use the same precondition and the same wording).
2. A first invocation could have been interrupted after `compose up` (SSH drop, terminal timeout; the script waits up to about two minutes for health plus up to one minute for the HTTP check) without the operator seeing its end, then re-run. Concurrent operator activity (two runs, or `preflight` re-run while `web` was finishing) gives the same picture. A partially completed deployment is therefore consistent; a stale-precondition rerun is consistent; I found no supported explanation involving a bug that replaced the container without the script's involvement.
3. Evidence that would decide it (read-only, on the host): `docker inspect -f '{{.Created}} {{.State.StartedAt}}' xpertapply-staging-web` against the time of the failing command; the saved `f4-*.txt` files; `docker events --since <date> --filter container=xpertapply-staging-web`; shell history and `last` for overlapping sessions.
Fingerprint checks are not bypassed anywhere in S2. What changed instead:
- the script **classifies** the running web first (verified F4, S2 candidate, or other) by host image id plus fingerprint and label. If the target is already running, `web` prints `NO ACTION: ... already runs the S2 candidate (container, started time). It was NOT redeployed.`, shows the last recorded phases and exits 10; `preflight` and `pin-rollback` report the same;
- anything that is neither F4 nor the candidate stops with the running image id;
- `web` records `BEGIN`, `REPLACED`, `HEALTHY`, `VERIFIED` and decides "replaced" from the container id and image actually running afterwards, **not** from compose's exit status, so a compose error after the container changed is reported as exit 2 with the rollback instruction, and a compose error before any change as exit 1 "NOT replaced";
- a lock refuses a concurrent mutating command.
Tested against a stub host (31 checks): approval gate, alias gate, pin idempotence and F4-not-F2 alias target, success path (flags `--no-deps --no-build --pull never`, only the `web` service, logged phases), repeat run is a reported no-op that does not call compose, verify passes and detects a duplicate enforced CSP, rollback restores F4 and never F2, pre-change compose failure, post-change compose failure, post-change header failure, rerun after partial deployment reports "already deployed", concurrent lock, unknown mode.

### Scope guarantees
Only `xpertapply-staging-web` is recreated. No compose `down`, `rm`, prune, pull or build; no API recreation; no database, migration, nginx, SMTP, production or VeoTrex change; protected containers (`xpertapply-*-1`, `xpertapply-staging-{postgres,redis,worker,scheduler,api}`, `veotrex-*`) are compared against a snapshot taken before the change.

## 8. Failure handling
- `STOP` before the `RESULT` block says "NOT replaced": nothing changed; fix the stated cause and rerun.
- Exit 2 or "verification INCOMPLETE": the web **is** on the new image. Run `verify`; if anything fails or you cannot decide quickly, `sudo -E bash ./staging-s2-web-release.sh rollback-web` (same approval variable). Send the `s2-*.txt` files.
- Exit 10: nothing to do; run `verify`.
- After rollback the enforced CSP disappears and the Report-Only origin returns to the F4 behaviour (it names the production API, the known S2 defect); that is the expected F4 state, not a failure.
- Do not edit nginx to "fix" a header result; S1 is a separate, already verified release.

## 9. Known findings (not caused by, and not fixed in, this release)
- **WebKit/Safari Apply-dialog behaviour (pre-existing, F4/shared hook):** WebKit does not focus a button on mouse click, so `useDialogFocus` finds no opener and focus returns to `<body>` after Escape when the dialog was opened with the mouse; keyboard traversal specs use plain Tab, which WebKit skips for buttons. Four axe specs also fail in WebKit only because Playwright's `addScriptTag` rejects under the existing Report-Only policy. A/B on the same build: enforced CSP stripped, Report-Only kept: identical 8 failures; both stripped: 6 failures remain, the 2 axe ones pass. Chromium passes all. Suggested separate follow-up: record the opener explicitly in the hook and make the WebKit traversal key platform-aware, without weakening any assertion.
- Report-Only will keep reporting the Next.js inline flight script until a nonce/hash strategy is chosen (S2 enforcement of `script-src` is out of scope).
- The image still runs as root and still ships the `__tests__` and `e2e` folders (unchanged from every earlier staging web).

## 10. GO / NO-GO
**GO** for the S2 web-only staging deployment, subject to the operator's `preflight` passing on the host, the archive and script checksums, and the founder's approval. Production: **NO-GO** (unchanged); the production nginx still needs the Referrer-Policy map before the recovery-page web release.
