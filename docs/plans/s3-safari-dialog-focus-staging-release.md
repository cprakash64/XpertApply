# S3: staging web release of the Safari dialog focus fix (plan)

Status: **PLANNED, NOTHING BUILT OR EXECUTED.** No image, push, upload, deploy, nginx, API, database, SMTP or extension change. Production stays NO-GO.

## 1. Goal and scope
Ship commit `fb913fb` (`useDialogFocus` restores focus to the clicked invoker; Safari/WebKit pointer-opened Apply, Resume and Cover Letter dialogs no longer drop focus to `<body>`) to **staging web only**, following the S2 pattern.

- Staging today (assumed after the S2 release and its five signed-in acceptance checks): web `95de977`, API `aa5bc2fa`, DB `0034_password_reset`, S1 nginx headers deployed. **Re-verify on the host in preflight; do not trust this document.**
- Source audit: `git diff 95de977 fb913fb -- apps` touches six files; the only runtime file is `apps/web/lib/useDialogFocus.ts`. The other five are unit/e2e tests and the new `e2e/support/axe.ts`. No change to `securityPolicy.mjs`, `next.config.mjs`, headers, API calls, styling or dependencies.
- Out of scope: nginx, CSP/Report-Only content, `script-src`/`form-action`, API, DB, SMTP, extension, production.

## 2. Decisions
| Decision | Choice | Why |
|---|---|---|
| Image source | Clean `git archive` of `apps/web` at the release commit, no env files | `apps/web/.env.local` points the API at `127.0.0.1:8001` and would win over Dockerfile args |
| Release commit | A docs-only commit on top of `fb913fb` may follow; the image revision label is whatever commit the archive is cut from, and the script pins that exact SHA | Keeps label, script and runbook consistent, as in S2 |
| Rollback target | The running S2 web `95de977`, pinned by alias `xpertapply-staging-rollback:web-s2-95de977` before any change | Never fall back to F4 or F2 |
| Script | Reuse `staging-s2-web-release.sh` structure as `pui-s3/staging-s3-web-release.sh`, with new pins only | Already tested (31 stub checks) and carries the lock, classification, phase log and exit codes |
| Approval token | `yes-s3-<first 8 of release SHA>` | Distinct from S2, so an old approval cannot be replayed |
| Browser matrix | Chromium + WebKit run here; Firefox run by the operator | Sandbox cannot launch Firefox |

## 3. Work breakdown (each step stops on failure)
1. **Freeze source.** Confirm `git status` has no tracked changes, record the release SHA and the `git diff 95de977 <sha> -- apps` file list in the runbook.
2. **Gates on the frozen source.** `make test-web` (lint, typecheck, Vitest, build), then the Playwright subset on a production build with `API_BASE_URL=http://127.0.0.1:8001`: apply-dialog, jobs-workspace, tracker-documents, applications-redesign, dashboard-jobs-redesign, password-recovery. Chromium and WebKit. Expect the four known pre-existing WebKit layout failures (identical on the old hook) and nothing else.
3. **Build** `xpertapply-staging-web:s3-<sha7>-amd64` (`linux/amd64`, same build args as S2), then record local ID, layer fingerprint (sha256 of `RootFS.Layers` JSON), revision label, archive SHA-256. Run the image content checks used in S2 (no production API URL in client chunks, no `127.0.0.1:8001`, secret patterns 0).
4. **Image smoke.** `test-s2-image-smoke.sh <image>` behind the reviewed S1 candidate nginx: the full header contract must pass unchanged (this proves the fix did not alter CSP, HSTS, XFO, Referrer-Policy or caching). Add one check that the served `/jobs` bundle contains the new invoker handling.
5. **Script and tests.** Derive the S3 script, update pins (release SHA, fingerprint, previous-web = S2 values, rollback alias), re-run the stub suite as `test-s3-release-script.sh`, plus the new case "running web is S2 `95de977`, not F4".
6. **Runbook** `docs/release/PUI-S3_RUNBOOK.md`: artifacts and hashes, commands, rollback, acceptance checklist, risks. Update section 16 of `edge-security-headers-csp.md` or this plan with results.
7. **Commit locally** (plan, script, tests, runbook). Stop and report. The operator, not this session, uploads and runs.

## 4. Operator sequence (to be written into the runbook)
`docker load` after checksum, `preflight` (read-only; the web must classify as exactly S2 `95de977`, the API as `aa5bc2fa`, DB head `0034`, S1 headers active), `pin-rollback`, then with the founder's approval `web`, then `verify`. `rollback-web` restores the pinned S2 image. Exit codes as in S2 (0 / 1 / 2 / 10).

## 5. Acceptance on staging (signed in; needs the existing approved throwaway account)
- Safari (real, macOS), mouse: Jobs, click **Apply on official site**, press Escape, then Close: focus returns to the Apply button each time; VoiceOver announces the button. Repeat for Resume and Cover Letter dialogs on a tracker row.
- Safari keyboard: Option+Tab to the button, Enter, Escape: same result. Tab/Shift+Tab inside the dialog follows Safari's own convention; note the result, not a defect.
- Chrome and Firefox: same flow, focus returns to the button.
- No scroll jump on close; no new network requests on open or close; no enforced-CSP violations in DevTools; only the known Report-Only entries.
- Profile wizard open and close in Safari: focus returns to its opener or `<main>`, never `<body>`.

## 6. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Hook is shared by three consumers | Unit tests cover all invoker cases; acceptance exercises each consumer in Safari |
| Escape on nested hook dialogs closes both (pre-existing) | No nesting exists in the app; record it, do not widen scope |
| Plain Tab can leave the dialog in Safari | Native convention; Option+Tab is contained; not changed here |
| Four unrelated WebKit layout test failures | Pre-existing, identical on the old hook; tracked separately, must not be reported as regressions of this release |
| Firefox unverified here | Operator runs the apply-dialog spec before approval |
| Real Safari + VoiceOver not exercised by Playwright WebKit | Manual acceptance in section 5 is a release condition |
| Host drift since S2 (someone redeployed) | Preflight classifies running images by host id, fingerprint and label and stops on anything unexpected |

## 7. Rollback
Web only: `rollback-web` re-creates the web from alias `xpertapply-staging-rollback:web-s2-95de977` (S2, enforced CSP baseline retained), then verifies fingerprint, label, health, API and other containers unchanged, and the header contract. No data, nginx or migration state is involved. The failure mode of the fix is a focus-management regression in three dialogs, which is cosmetic to function and fully reverted by the image swap.

## 8. Go/no-go for starting the build
Proceed to step 1 once the founder confirms staging web is still `95de977` and S2 acceptance is recorded. Production promotion needs its own plan and approval; the production web also needs the nginx Referrer-Policy map noted in the S1 runbook before the recovery pages ship.

## 9. Progress log
- 2026-10-30: plan written. Fix `fb913fb` committed locally.
- 2026-10-30: steps 1 to 7 done locally. Release commit `1b26947` (apps tree identical to `fb913fb`; gates from that commit reused). Image `xpertapply-staging-web:s3-1b26947-amd64`, fingerprint `18524747…dfd86d`, archive SHA `0fff3ff1…50f6`. Smoke 117/117, stub script tests 33/33. Runbook `docs/release/PUI-S3_RUNBOOK.md`. Deviations from plan: (a) the S2 host image id is unrecorded, so the previous-web check matches fingerprint plus revision, with optional `XA_S3_PREV_WEB_ID`; (b) the bundle check uses the hook's selector literal, which survives minification. Nothing pushed, uploaded or deployed.
