# EXT-LIVE-08 native-test candidate

- Source commit: `66f52b8` (product code last changed in `fd03ac2`; later commits are tests and docs). Version: `0.3.1` (unchanged; check the Developer Dashboard version history before choosing an upload version).
- ZIP: `/Users/cprakash/Developer/XpertApply-builds/xpertapply-extension-0.3.1-08-66f52b8.zip`
- SHA-256: `ea1924fa300a342f30da691691cd95d500088c0ad1a502341dac49c158055c4f` (reproduced twice, built from a clean tree, `unzip -t` clean, 16 files)
- Manifest vs the EXT-LIVE-07 candidate: only `version_name` differs; permissions unchanged (`activeTab identity sidePanel storage scripting tabs`; optional `https://*/*`); no `key`.
- Production-ID unpacked build (public key only, historical default pin untouched):
  ```bash
  /Users/cprakash/Developer/XpertApply-builds/make-store-id-build.sh --zip /Users/cprakash/Developer/XpertApply-builds/xpertapply-extension-0.3.1-08-66f52b8.zip --sha256 ea1924fa300a342f30da691691cd95d500088c0ad1a502341dac49c158055c4f
  ```
- Checklist: `EXT-LIVE-07_NATIVE_RUNBOOK.md` (section 2b first). Real Workday acceptance has NOT been performed.
