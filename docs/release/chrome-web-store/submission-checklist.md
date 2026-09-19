# Chrome Web Store release checklist

This is a staged operator checklist. Checked items are locally verified only; an unchecked item must not be inferred complete from another item.

## Package

- [x] Exact initial ZIP: `apps/extension/xpertapply-extension.zip` from `ac64ea901d7c3462a74182afffc3377586674656`.
- [x] Manifest version `0.2.0`; initial-upload version gate: no previous Store upload found in repository evidence.
- [x] SHA-256 `30c8784dd755b982cb18fe6cd99c6474b96ed4a82585f9e731db0d27f0f545a4`.
- [x] Root `manifest.json`; 10 ZIP entries; runtime files/icons only; no maps or dev files.
- [ ] Owner confirms no existing Dashboard item/version before initial upload.

## Listing

- [x] Name/summary and detailed description drafted in `store-listing.md`.
- [x] Recommended current category: Workflow & Planning; language: English.
- [x] Qualified 128×128 icon and homepage/privacy URLs identified.
- [ ] Capture at least one real, synthetic-data Store screenshot at 1280×800 or 640×400.
- [ ] Prepare/approve required 440×280 small promo tile.
- [ ] Support URL: owner decides whether to add a real public support page; optional field may remain empty.
- [ ] Official URL: use xpertapply.com only if publisher domain verification is confirmed.

## Privacy

- [x] Single purpose and permission justifications drafted.
- [x] Data-category selections drafted, including Web history.
- [x] Limited Use and remote-code answers documented; public privacy URL/contact identified.
- [x] Prominent side-panel site-access disclosure and processor consistency reviewed.
- [ ] Operator verifies current Dashboard labels and enters accurate answers.

## Distribution

- [ ] Eventual Public visibility chosen at final launch stage, not during ID acquisition.
- [ ] Owner selects regions and verifies any paid-item/in-app-purchase declaration.

## Stable ID

- [ ] Owner checks for an existing item, then creates one draft item if none exists.
- [ ] Exact initial ZIP uploaded; permanent extension ID and Store URL recorded.
- [ ] Public ID/URL added to a new production Web build and deployed under separate authorization.
- [ ] Production Web-to-Store-installed-extension handshake verified later.

## Final release gates

- [ ] NEW-04 HTTP security headers.
- [ ] Manual ATS acceptance.
- [ ] Side-panel accessibility/manual acceptance.
- [ ] PROXY-01 production proxy/body-limit gate if still open.
- [ ] Signed Store version N → N+1 update proof.
- [ ] Final release audit and Dashboard consistency review.
- [ ] Submit for review; publish only under later authorization.
