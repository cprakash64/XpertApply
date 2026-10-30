# S3 staging web release: Safari/WebKit dialog focus restoration (web only)

Status: **PREPARED, NOT EXECUTED.** Nothing was pushed, uploaded, deployed or changed on staging or production. nginx, API, database, SMTP and the extension are not touched. Plan: `docs/plans/s3-safari-dialog-focus-staging-release.md`.

## 1. What this release is
- **Source (image revision label):** `1b26947dfd46c3038c79579dd77df40db8622f60` (`1b26947`, branch `feature/premium-ui-overhaul`). `git diff fb913fb 1b26947 -- apps` is empty, so the application tree equals the fix commit `fb913fb`.
- **Staging today (assumed; preflight re-verifies):** web S2 `95de977`, API `aa5bc2f` (image `sha256:c7a15f1e…3440`), database `0034_password_reset`, S1 nginx headers deployed.
- **Product change:** `git diff 95de977 1b26947 -- apps` touches six files. The only runtime file is `apps/web/lib/useDialogFocus.ts` (restores focus to the clicked invoker; falls back to `<main>`, never `<body>`). The other five are unit/e2e tests and `e2e/support/axe.ts`. No change to `securityPolicy.mjs`, `next.config.mjs`, headers, API calls, styling or dependencies.
- **Not in this release:** any security policy, nginx, API, database, SMTP, extension, production change.

## 2. Artifacts
| | |
|---|---|
| Image | `xpertapply-staging-web:s3-1b26947-amd64`, `linux/amd64`, 9 layers, built from a clean `git archive` of `apps/web` at `1b26947` (0 env files) with the S2 build args (`NEXT_PUBLIC_API_URL=https://api-staging.xpertapply.com`, `NEXT_PUBLIC_SITE_URL=https://staging.xpertapply.com`, extension URL and ID empty) |
| Local image ID (this Mac, containerd store; the host-side ID after `docker load` differs and is printed by preflight) | `sha256:9b7dbe857416d2ef475da0129f66155193edf5341edd42e8863f7c56ddd13aa7` |
| **Layer fingerprint** (what the script pins) | `185247471546c434039840dd47515e15ffeaa4744435b92bcab533f6e5dfd86d` |
| Revision label | `org.opencontainers.image.revision=1b26947dfd46c3038c79579dd77df40db8622f60` |
| Archive | `xpertapply-staging-web-s3-1b26947-amd64.tar`, 342,515,200 B, SHA-256 `0fff3ff1bded39ab5c34f78faeb811bceedee2ecc569e9b0816bfe5ebb3f50f6` (session scratchpad, not in Git, not uploaded) |
| Release script | `docs/release/pui-s3/staging-s3-web-release.sh`, SHA-256 `8b9a3fa77ffcaf514dcb2f95e0910388dcee8d17c18a141a65adb888989b9ea4` |
| Dry-run validator (already on the host; the script refuses any other version) | `/home/luna/xpertapply-pui01/staging-release-dryrun.sh`, SHA-256 `93c5c157e34e52eac27354199ce89f98315e4af6ecdc191a8517d267cf487c39` |

Image content checks: production API URL in `.next`: 0 files; staging API URL: 11 files; `127.0.0.1:8001`/`localhost:8000` in client chunks: 0; secret-pattern hits: 0; env files in image: 0. Runs as uid 0 like every earlier image (unchanged).

The fix is detectable in the served bundle: its interactive-control selector literal `summary, [role="button"], [role="link"], [role="menuitem"]` is present in the S3 `/jobs` chunks and absent from the S2 image's static bundle. The script requires it after the swap.

## 3. Verification already done locally
- Source gates at `fb913fb` (identical `apps` tree): lint and typecheck clean; Vitest 62 files, 1222 tests; production build ok; Apply-dialog specs 18/18 in Chromium and WebKit; axe scans, jobs-workspace and tracker-documents pass in both. Firefox not run (sandbox). Four unrelated WebKit layout failures are pre-existing and identical on the old hook.
- `bash docs/release/pui-s3/test-s3-image-smoke.sh`: the real S3 image behind nginx 1.24 with the reviewed S1 candidate vhost. **117/117 header contract checks pass**: exactly one enforced CSP equal to `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`, one Report-Only CSP naming only the staging API, HSTS `max-age=300`, XFO DENY, nosniff, Referrer-Policy once (`no-referrer` on recovery pages), noindex once, caching unchanged. All 13 static pages return 200; the bundle has the focus selector and the earlier UI strings. Headers are byte-for-byte what S2 served.
- `bash docs/release/pui-s3/test-s3-release-script.sh`: script against a stub docker/curl in a Debian container, **33/33 pass**. Beyond the S2 cases it covers: running web is F4 (refused), running web is S2 (accepted), missing focus code after the swap (exit 2 with rollback advice), rollback to the S2 alias with the full header contract re-run (S1 and S2 policy must still hold), never F4 or F2.

## 4. Commands (root on `srv738314`, staging only; stop at the first `STOP`)
```bash
echo "0fff3ff1bded39ab5c34f78faeb811bceedee2ecc569e9b0816bfe5ebb3f50f6  xpertapply-staging-web-s3-1b26947-amd64.tar" | sha256sum -c - || exit 1
sudo docker load -i xpertapply-staging-web-s3-1b26947-amd64.tar          # adds the image; replaces nothing
cd /home/luna/xpertapply-pui01 && echo "8b9a3fa77ffcaf514dcb2f95e0910388dcee8d17c18a141a65adb888989b9ea4  staging-s3-web-release.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-s3-web-release.sh preflight    2>&1 | tee s3-1-preflight.txt   # READ-ONLY; must end PREFLIGHT PASS
sudo bash ./staging-s3-web-release.sh pin-rollback 2>&1 | tee s3-2-pin.txt         # adds one alias tag on the running S2 web image
# --- proceed only with the founder's approval ---
export XA_STAGING_APPROVED=yes-s3-1b26947d
sudo -E bash ./staging-s3-web-release.sh web       2>&1 | tee s3-3-web.txt         # recreates ONLY xpertapply-staging-web
sudo bash ./staging-s3-web-release.sh verify       2>&1 | tee s3-4-verify.txt
sudo chown luna:luna s3-*.txt
```
Modes behave as in S2 (`docs/release/PUI-S2_RUNBOOK.md` section 5), with these differences:
- The running web must be the **S2 image** (revision `95de977`, fingerprint `ff8c29c3…`). F4, F2 or anything else stops the run. The S2 host image id was not recorded in the repository, so by default the S2 image is matched by fingerprint plus revision label. To also pin the host id, take it from the S2 `verify` output or `docker inspect -f '{{.Image}}' xpertapply-staging-web` **before** the release and run with `XA_S3_PREV_WEB_ID=sha256:…` (`sudo -E` or `sudo XA_S3_PREV_WEB_ID=… bash …`); it is then enforced like every other pin.
- The rollback alias is `xpertapply-staging-rollback:web-s2-95de977`; the script also checks the running web equals that alias's image before replacing it.
- After the swap, `web` requires the focus selector in the served Jobs bundle in addition to the earlier UI strings and the full live header contract.
- State and log directory: `/root/pui-s3` (phases `BEGIN`, `REPLACED`, `HEALTHY`, `VERIFIED`).
- Exit codes: 0 done and verified; 1 stopped, nothing changed; 2 replaced but verification incomplete (RESULT block says exactly what happened); 10 nothing to do.

`rollback-web` (needs the same approval) restores the S2 image through the alias, never F4 or F2, then re-runs the **full** header contract: S1 and the S2 enforced CSP baseline must still hold, because S2 stays deployed.

## 5. Signed-in acceptance (needs the existing approved throwaway staging account; none was created here)
Release condition, because Playwright's WebKit is not real Safari:
1. **Safari (macOS), mouse:** Jobs, click **Apply on official site**, press Escape: focus returns to the Apply button; reopen, click Close: same. VoiceOver announces the button. Repeat for the Resume and Cover Letter dialogs on a tracker row.
2. **Safari, keyboard:** Option+Tab to the button, Enter, Escape: same result. Plain Tab inside the dialog follows Safari's native convention; record what happens, it is not a defect.
3. **Chrome and Firefox:** the same flow; focus returns to the button. (Firefox could not be run in the build sandbox, so this is its only check.)
4. Profile wizard open and close in Safari: focus returns to its opener or `<main>`, never `<body>`.
5. No scroll jump on close; no extra network requests on open or close; no enforced-CSP violations in DevTools (Report-Only entries are expected: two `script-src-elem inline` per page and the `upgrade-insecure-requests ... ignored` notice).
6. Smoke: sign-in, Dashboard, Jobs scoring, Tracker **Download resume**, Profile and Settings save, `/forgot-password` and `/reset-password`.

## 6. Failure handling
- `STOP` before the RESULT block says "NOT replaced": nothing changed; fix the stated cause and rerun.
- Exit 2 or "verification INCOMPLETE": the web **is** on the new image. Run `verify`; if anything fails or the decision is unclear, `sudo -E bash ./staging-s3-web-release.sh rollback-web` (same approval variable).
- Exit 10: nothing to do; run `verify`.
- Do not edit nginx to "fix" a header result.

## 7. Known findings (not caused by this release)
- Four WebKit layout specs fail identically with and without the fix (tablet 768px applications row, Jobs navbar search width, responsive-app-shell breakpoint, premium-ui-rc-regressions 768px). They involve no dialog.
- Escape on two nested `useDialogFocus` dialogs would close both (pre-existing; no such nesting exists in the app).
- Report-Only keeps reporting Next.js inline flight scripts until a nonce/hash strategy is chosen.
- The image still runs as root and still ships `__tests__` and `e2e` (unchanged from earlier staging webs).

## 8. GO / NO-GO
**GO** for the S3 web-only staging deployment, subject to the checksums, a passing host `preflight`, and the founder's approval. Firefox and real-Safari acceptance (section 5) are release conditions. Production: **NO-GO** (unchanged); it needs its own plan, the nginx Referrer-Policy map from the S1 runbook, and explicit approval.
