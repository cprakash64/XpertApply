# Chrome Web Store 0.3.0 release checklist

Checked historical items identify prior evidence only. All current final-release gates below remain open.

## Historical 0.2.0 package qualification

- [x] Exact initial ZIP: `apps/extension/xpertapply-extension.zip` from `ac64ea901d7c3462a74182afffc3377586674656`.
- [x] Manifest version `0.2.0`; initial-upload version gate: no previous Store upload found in repository evidence.
- [x] SHA-256 `30c8784dd755b982cb18fe6cd99c6474b96ed4a82585f9e731db0d27f0f545a4`.
- [x] Root `manifest.json`; 10 ZIP entries; runtime files/icons only; no maps or dev files.

Historical repository-only “no previous upload found” was not Dashboard ownership proof. The official item ID is now known; reconcile its actual version/status later.

## Carried engineering/preparation evidence

- [x] Qualified engineering baseline `a11c3839d8c02d9b90dd7501c74513c29af4e98c` identified.
- [x] Historical name/summary and detailed description drafted.
- [x] Historical category recommendation: Workflow & Planning; language: English.
- [x] Qualified 128×128 icon and homepage/privacy URLs identified.
- [x] Historical single-purpose and permission justifications drafted.
- [x] Historical data-category choices drafted, including Web history.
- [x] Historical Limited Use and remote-code answers documented; public privacy URL/contact identified.
- [x] Historical prominent side-panel disclosure and processor consistency reviewed; current surfaces and final package need fresh reconciliation.

## Current 0.3.0 gates — PENDING

- [ ] Final clean-commit production package build (CWS-PREP-13).
- [ ] Final SHA, entry inventory and remote executable-code scan.
- [ ] Owner verifies canonical Store URL, ownership, existing draft/version and live Dashboard labels.
- [ ] Production Web exact Store-ID/URL deployment and positive handoff proof.
- [ ] NEW-04 HTTP security headers — OPEN / P1.
- [ ] PROXY-01 production proxy/body-limit manual qualification — OPEN.
- [ ] Four actual-product synthetic screenshots (1280×800 RGB PNG).
- [ ] Required 440×280 promo; optional marquee remains deferred.
- [ ] Dashboard listing/privacy reconciliation and declaration entry under separate authorization.
- [ ] Owner confirms regions, pricing/IAP/account offering and restricted baseline strategy.
- [ ] Store-delivered same-item signed N baseline before replacing draft N.
- [ ] Separately authorized final 0.3.0 draft upload.
- [ ] Separately authorized restricted review/delivery and signed N → 0.3.0 update proof.
- [ ] Manual ATS acceptance including limited Workday and manual unsupported controls.
- [ ] Manual accessibility acceptance for in-page assistant and fallback surfaces.
- [ ] Final Store-installed audit and production handshake.
- [ ] Optional support URL decision and verified publisher domain confirmation.
- [ ] Separate Submit for Review authorization.
- [ ] Review approval/status evidence.
- [ ] Separate publication authorization, including any Private/tester delivery.

No upload, review submission or publication is authorized here. Follow the [living plan](../../plans/chrome-web-store-0.3.0-release.md); preparation checks do not close final artifact or production gates.
