# EXT-LIVE-09 native-test candidate

- Source commit: `96cd4e2` (product code last changed in `c39a643`; later commits are tests and docs). Version `0.3.1` (unchanged; read the Developer Dashboard version history before choosing an upload version).
- ZIP: `/Users/cprakash/Developer/XpertApply-builds/xpertapply-extension-0.3.1-09-96cd4e2.zip`
- SHA-256: `8ddc7ca63c09f8ba6ba85be4c8fef6b712fe54738b803d8b2f25e670e73546a2` (reproduced twice from a clean tree; `unzip -t` clean; 16 files)
- Manifest vs the EXT-LIVE-08 candidate: only `version_name` differs. Permissions unchanged (`activeTab identity sidePanel storage scripting tabs`; optional `https://*/*`). No `key`.
- Production-ID unpacked build (public key only; the historical default pin is untouched):
  ```bash
  /Users/cprakash/Developer/XpertApply-builds/make-store-id-build.sh --zip /Users/cprakash/Developer/XpertApply-builds/xpertapply-extension-0.3.1-09-96cd4e2.zip --sha256 8ddc7ca63c09f8ba6ba85be4c8fef6b712fe54738b803d8b2f25e670e73546a2
  ```
- Checklist: `EXT-LIVE-07_NATIVE_RUNBOOK.md` section 2b first. Real Workday acceptance has NOT been performed.
- Known failing test: `xa-core1-connect` "interruptions" (forged OAuth state): the notice text intermittently reads "isn't connected" instead of "couldn't be verified". No credential is stored in any failing run. Pre-existing (reproduced on the EXT-LIVE-08 source).
