# EXT-LIVE-10 native-test candidate

- Source commit: `7803558` (product code last changed in `042faae`; later commits are tests and docs). Version `0.3.1` (unchanged; read the Developer Dashboard version history before choosing an upload version).
- ZIP: `/Users/cprakash/Developer/XpertApply-builds/xpertapply-extension-0.3.1-10-7803558.zip`
- SHA-256: `c356f6c820d65a9328a884391015b8cb884baee8e9fcc9a8cc0a76d19da1cfa6` (reproduced twice from a clean tree; `unzip -t` clean; 16 files). Earlier ZIPs untouched.
- Manifest vs the EXT-LIVE-09 candidate: only `version_name` differs. Permissions unchanged (`activeTab identity sidePanel storage scripting tabs`; optional `https://*/*`). No `key`.
- Production-ID unpacked build (needs the Store PUBLIC key on the clipboard; the script refuses without it; the private key is never needed):
  ```bash
  /Users/cprakash/Developer/XpertApply-builds/make-store-id-build.sh --zip /Users/cprakash/Developer/XpertApply-builds/xpertapply-extension-0.3.1-10-7803558.zip --sha256 c356f6c820d65a9328a884391015b8cb884baee8e9fcc9a8cc0a76d19da1cfa6
  ```
- Checklist: `EXT-LIVE-07_NATIVE_RUNBOOK.md` section 2c (then 2b, then Workday). Real Workday acceptance has NOT been performed.

## Engineering results (EXT-LIVE-10)
- Typecheck clean; unit suite 114 files / 1687 tests pass.
- OAuth repeat runs on the final code: `interruptions` 50/50, `sign-in outcomes` 20/20, `same-page reconnect` 20/20, `worker suspension` 10/10 (serial, load average 9-26 from other sessions). An earlier series on the first fix stopped at 25 runs with 1 failure (24 pass), which exposed the second root cause (see the plan).
- Chromium query identity: 7 families x 2 tests = 14/14; the 3 new spelling families failed 6/6 on the old matcher.
- Full serial Playwright suite, three runs on the same product code: 336 passed / 1 failed / 0 skipped each time, with a DIFFERENT failing test each run (`xa-e2b-stale-web-record` zero-latency label read; `xa-e2c-isolation` 1 harness dialog.accept on a gone dialog; `e4od-r3-recovery` service worker still "stopping" after 5 s). Each passes on isolated reruns (16, 40 and 6 test executions) - a rerun is not proof - and each is load-sensitive harness timing (the e2e flake class in the repo notes); the first two were adjusted in the test only (poll for the label; tolerate a dismissed confirm). No run was entirely green; every test passed on this product code in at least two of the three runs. A fourth full run was not made.
- Real-API specs: ran (10/10 on a disposable Postgres 16 + old-API archive, drafting flag enabled only for the local test API); torn down afterwards.
