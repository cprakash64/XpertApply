# PUI-STG5: staging web refresh to the final Applications redesign (web only)

Status: PREPARED, NOT EXECUTED. Source `b99125c9224f2fc4a8a1ab2376964ef3b5ea6654` (founder approved the Applications design).

## Current staging (verified 2026-10-29)
- Database `0034_password_reset`; API image `sha256:87c72268…` (9dbf283); web image `sha256:fb51cfd7…` (9dbf283). The earlier release steps
  (`release-2..4`) all passed; nothing else changed. Password-reset availability reports `{"available":false}`; EMAIL_BACKEND unset.

## Artifact
- Web image `xpertapply-staging-web:pui-b99125c-amd64`, linux/amd64, revision label `b99125c9…`, built from a clean `git archive` with the staging
  `NEXT_PUBLIC_*` values (same as before; extension ID unchanged).
- Local ID `sha256:0b6165b0…`; **host ID `sha256:55fa6bb761925c62021a5bbe88fe90c8a8ff48c89513c530eda50516881ddc46`** (layer fingerprint
  `bcb7f197…` identical on both). Archive SHA-256 `3478861132dfdb966f880fea8bb90ed153954dcdb8b430c3827e6e5ca4e7e69c`, verified on the VPS.
- Bundle checks: staging API URL present; no production API URL except the report-only CSP header; new Applications UI present; old "Total tracked"
  cards absent; light default present; no secrets or env files.

## Procedure (root, staging only; stop at the first STOP line)
```bash
cd /home/luna/xpertapply-pui01 && echo "a4b4e883c3ac374acb93bbfe21b8fdc382ca7fdcb0a5f3adb400f7eaea62ec8f  staging-web-refresh.sh" | sha256sum -c - || exit 1
set -o pipefail
sudo bash ./staging-web-refresh.sh preflight       2>&1 | tee refresh-1-preflight.txt   # read-only
sudo bash ./staging-web-refresh.sh pin-rollback    2>&1 | tee refresh-2-pin.txt         # adds one alias TAG only
# --- the operator proceeds only with the founder's approval ---
export XA_STAGING_APPROVED=yes-b99125c9
sudo -E bash ./staging-web-refresh.sh web          2>&1 | tee refresh-3-web.txt         # recreates ONLY xpertapply-staging-web
sudo bash ./staging-web-refresh.sh verify          2>&1 | tee refresh-4-verify.txt
sudo chown luna:luna refresh-*.txt
```
The `web` step refuses unless: the new image ID, revision label and platform match; the web currently runs the expected 9dbf283 image; the API is on
its 9dbf283 image and the database is at 0034; the API is healthy; recovery email is unset; the rollback alias exists; and the Compose dry run
(validated by the approved validator) names only `xpertapply-staging-web`. Afterwards it checks the image, that the new header is served, and that
every other container is unchanged.

## Rollback (web only, no database or API change)
```bash
export XA_STAGING_APPROVED=yes-b99125c9
sudo -E bash ./staging-web-refresh.sh rollback-web    # back to sha256:fb51cfd7… (the 9dbf283 web)
sudo bash ./staging-web-refresh.sh verify              # expect the new-image check to fail by design; the other checks must pass
```
The original pre-release web (`stage50d`, `sha256:30651fdd…`) is still available through `staging-release.sh rollback-web`.

## Post-deployment tests (synthetic accounts)
1. `verify` output: all PASS. 2. Sign up a synthetic user, log in, reload (session persists), log out. 3. `/tracker`: header, filters, list, details,
status change (reload to confirm it persisted), resume and cover-letter downloads, PDF and Word. 4. Default light under a dark OS; Settings >
Appearance (Light/System/Dark) switches the app; the sidebar has no theme control. 5. Phone width: list first, details open and back. 6. Dashboard,
Jobs, Profile, Resume, Cover letter still load. 7. Login page: check whether it offers a recovery link while email is disabled and record it.
8. Extension: confirm which build is under test, then run connect and a tracker confirmation. 9. noindex headers (validator, run by `verify`).

## Not covered
Live-API Playwright specs (`profile-and-theme`, `tracker-documents-live`, people/profile) have not been run; run them against staging after the swap.
Real-mailbox password reset is still unverified and stays disabled.
