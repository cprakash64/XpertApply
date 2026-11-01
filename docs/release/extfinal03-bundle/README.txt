EXT-FINAL-03: extension 0.3.0 production connection release (web + API configuration). Every command is operator-executed; nothing here runs automatically.
Order: WEB first, then API. The API change is what makes Connect work; the web change makes sign-out end the extension session and adds /support.

Before you start: compare the SHA-256 of SHA256SUMS with the value in the engineering report. The package is verified against that file.

 1  sudo ./install-extfinal03.sh                                              (verifies SHA256SUMS; installs root-owned under /opt/xpertapply-release/extfinal03-extension-connect)
 2  sudo /opt/xpertapply-release/extfinal03-extension-connect/init-extfinal03-state.sh --apply      (once; creates the two pinned override files)
 3  docker load -i <web archive from release-manifest.txt>                    (optional: apply loads it itself if the pinned archive hash matches)
 4  /opt/xpertapply-release/extfinal03-extension-connect/production-release.sh web check            (as luna: read-only; then again with sudo)
 5  sudo /opt/xpertapply-release/extfinal03-extension-connect/production-release.sh web apply --confirm extfinal03-release-web
 6  verify: https://xpertapply.com/support 200, /privacy 200, sign in/out works          (see the report)
 7  sudo .../production-release.sh api check
 8  sudo .../production-release.sh api apply --confirm extfinal03-release-api
 9  verify the allowlist behaviour (the script prints it) and run the native Chrome acceptance C1 to C14

Rollback (independent):
   sudo .../production-rollback.sh web apply --confirm extfinal03-rollback-web
   sudo .../production-rollback.sh api apply --confirm extfinal03-rollback-api      (allowlist back to empty: Connect fails closed again)
Discovery/email emergency switch is unchanged: the NET-PROD-08 production-email-off.sh.
