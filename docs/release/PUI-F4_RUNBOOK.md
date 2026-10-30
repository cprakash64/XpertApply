# F4 staging candidate: Apply dialog keyboard accessibility (web only)

Status: PREPARED, NOT EXECUTED. Nothing was pushed, deployed or changed on staging or production.
Source (image revision): `baf081769b8e4c2ce4f04599f0568da3456a8b1c` on top of the deployed `aa5bc2f`. The only product change is `baf0817`: the Apply dialog now closes on Escape and manages focus (see the commit and `apps/web/__tests__/auto-apply-keyboard.test.tsx`, `apps/web/e2e/apply-dialog-keyboard.spec.ts`).

## Release requirement: WEB ONLY
No API change, no migration, no environment change, no worker, no new infrastructure. The API image (`aa5bc2f`) and the database (`0034_password_reset`) are untouched; the script refuses to run unless the API is still exactly that image.

## Artifact
| | |
|---|---|
| Image | `xpertapply-staging-web:f4-baf0817-amd64`, linux/amd64, 9 layers, clean `git archive` of `apps/web` (237 files, 0 env files) |
| Local image ID | `sha256:2ca1b85b2b1839250ab7fa079c11e514d698b2a65e0851a998b8db36523ba575` |
| Layer fingerprint | `7f9f346b43d6f6ac2d3052693154c3977d4838f8779a8342d033e919bee66ed2` |
| Archive SHA-256 | `762fb213a3bd4af472112eec799f30ece1296dfde2e9ccb2a469aa896ca39410` (342,491,136 B) |
| Archive file (session scratchpad, not in Git, not uploaded) | `xpertapply-staging-web-f4-baf0817-amd64.tar` in `/private/tmp/claude-501/-Users-cprakash-Documents-Jobs-XpertApply/7a1d83ad-b199-449d-9c43-1e1e973b26ac/scratchpad/` |
| Revision label | `baf081769b8e4c2ce4f04599f0568da3456a8b1c` |
| Release script SHA-256 | `be05885768906c4de891de15c35fae4e6e747cfae791db3e5e05c2ff0c6053a6` (`docs/release/pui-f4/staging-f4-web-release.sh`) |
Build values: staging API URL, staging site URL, empty extension URL, extension ID unchanged (as in every earlier release).
Image checks: x86_64; staging API URL embedded and production API URL absent; the scoring notice, match-score and Assisted application strings present; 0 env files; 0 secret hits; the four `NEXT_PUBLIC_*` values as above. **The Apply dialog chunk differs from the one in the deployed aa5bc2f web image** (so the fix really is in the bundle). Served locally: `/dashboard /jobs /tracker /settings /login` all 200 and the script's served-UI check passes.
A loaded image has a host-specific ID, so the script pins layer fingerprints and revision labels and prints the host ID.

## Script audit
Derived from the audited F2 release script (web part only). Only state changes: one alias `docker tag` (`pin-rollback`) and `compose up -d --no-deps --no-build --pull never web` (`web`, `rollback-web`) after the approved dry-run validator shows only `xpertapply-staging-web`. The one `POST` is an unauthenticated call that must be refused with 401. No down, rm, prune, pull, build, nginx, production, VeoTrex, PostgreSQL, Redis, SMTP or migration command. It stops without root, on the wrong host, without the approval variable, on a wrong fingerprint or revision, or if the API or database is not exactly the F2 release. Tested here: guards, syntax, and the served-UI check against the candidate container.

## What staging runs today and the rollback target
Web `aa5bc2f` (fingerprint `64f80564…`), API `aa5bc2f` (fingerprint `87b53b0e…`), database `0034_password_reset`. **I have no VPS access, so this is unconfirmed;** preflight verifies the running containers by fingerprint and revision label and stops otherwise (if it stops there, send its output). `pin-rollback` tags the running web as `xpertapply-staging-rollback:web-aa5bc2f`.

## Operator commands (root, staging only; stop at the first STOP line)
```bash
echo "762fb213a3bd4af472112eec799f30ece1296dfde2e9ccb2a469aa896ca39410  xpertapply-staging-web-f4-baf0817-amd64.tar" | sha256sum -c - || exit 1
sudo docker load -i xpertapply-staging-web-f4-baf0817-amd64.tar          # adds the image; replaces nothing
cd /home/luna/xpertapply-pui01 && echo "be05885768906c4de891de15c35fae4e6e747cfae791db3e5e05c2ff0c6053a6  staging-f4-web-release.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-f4-web-release.sh preflight    2>&1 | tee f4-1-preflight.txt     # READ-ONLY; must end PREFLIGHT PASS
sudo bash ./staging-f4-web-release.sh pin-rollback 2>&1 | tee f4-2-pin.txt           # adds one alias TAG only
# --- proceed only with the founder's approval ---
export XA_STAGING_APPROVED=yes-baf08176
sudo -E bash ./staging-f4-web-release.sh web       2>&1 | tee f4-3-web.txt           # recreates ONLY xpertapply-staging-web
sudo bash ./staging-f4-web-release.sh verify       2>&1 | tee f4-4-verify.txt
sudo chown luna:luna f4-*.txt
```

## Rollback (web only; the API and database are never involved)
```bash
export XA_STAGING_APPROVED=yes-baf08176
sudo -E bash ./staging-f4-web-release.sh rollback-web
```
`verify` then fails its new-image check by design.

## Post-deployment checks
No account is needed for the dialog's keyboard behaviour that is already proven on a production build with a mocked API; on staging it needs a signed-in account (an approved throwaway account, none created here): on Jobs, open **Apply on official site** by keyboard, check focus lands inside the dialog, Tab and Shift+Tab stay inside, Escape closes it with focus back on the Apply button, no request is made by Escape, and the Close button and reopening still work; inside an open job, Escape closes only the dialog. Then delete the account. Also run `verify`.

## Known unrelated finding (not fixed here, P3)
The muted "job · company" line in the dialog header measures 4.49:1 (needs 4.5:1) on the mobile glass background. A design-token fix, separate from F4.

## GO / NO-GO
**GO** for the web-only staging release once preflight confirms staging is on the aa5bc2f web and API. Not production approval: S1/S2 (edge headers, CSP), the extension 0.3.0 test, the memory headroom and the unoptimised `refresh-matches` / `/dashboard/summary` remain.
