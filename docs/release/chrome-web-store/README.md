# Chrome Web Store draft-item operator bundle

Prepared September 19, 2026 from `release/chrome-web-store` at `ac64ea901d7c3462a74182afffc3377586674656`. This bundle is for operator entry and review. No Store item has been created or submitted by this preparation.

## First action: obtain the permanent item ID

Before adding an item, inspect the publisher Dashboard for an existing XpertApply item. Repository/config audit found no verified Store item ID; synthetic test IDs are not production IDs. If an item already exists, stop and reconcile it rather than creating another.

If no item exists, sign in to the registered publisher account, satisfy current account verification and two-step verification requirements, choose **Add new item**, and upload the exact [package](../../../apps/extension/xpertapply-extension.zip). Confirm the upload result, then record the permanent item/extension ID and draft URL if available. **Stop before Submit for Review or publication.** Return the ID, upload result, and any Dashboard warnings or validation errors. Filling the remaining fields can follow the stable-ID integration; do not invent an ID in the meantime.

Package: `apps/extension/xpertapply-extension.zip`; version `0.2.0`; size `203500` bytes; SHA-256 `30c8784dd755b982cb18fe6cd99c6474b96ed4a82585f9e731db0d27f0f545a4`. `manifest.json` is at ZIP root. The package is a generated, ignored upload artifact, not a tracked documentation file.

## Dashboard field map

| Dashboard area | Enter or review |
| --- | --- |
| Package | Upload only the ZIP identified above for the initial draft item. |
| Store listing: name and summary | Derived from the packaged manifest; see [listing copy](store-listing.md). |
| Store listing: detailed description, category, language, URLs | Copy from [listing copy](store-listing.md); leave unsupported support/verified-domain claims unset. |
| Store listing: images | Use the [asset inventory](asset-inventory.md); screenshots and small promo still need qualified capture/design before submission. |
| Privacy practices | Copy and verify the [privacy worksheet](privacy-practices.md) against the live Dashboard labels. |
| Distribution | Use [distribution worksheet](distribution.md); eventual goal is Public, with region/purchase choices checked by owner. |
| Stable ID integration | Use [stable-ID map](stable-id-handoff.md) after receiving the real ID. |
| Final submission | Follow the [release checklist](submission-checklist.md); do not submit in this stage. |

## Official Chrome guidance reviewed September 19, 2026

- [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare): MV3 package review, 132-character description maximum, manifest at ZIP root, and increasing versions for later uploads.
- [Store listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), and [distribution fields](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution).
- [Supplying images](https://developer.chrome.com/docs/webstore/images) and [creating a great listing](https://developer.chrome.com/docs/webstore/best-listing): 128×128 icon, 1–5 screenshots at 1280×800 or 640×400, required 440×280 small promo, optional 1400×560 marquee.
- [Listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements), [privacy policies](https://developer.chrome.com/docs/webstore/program-policies/privacy/), [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use/), and [program policies](https://developer.chrome.com/docs/webstore/program-policies/policies).
- [Current extension categories](https://developer.chrome.com/docs/webstore/best-practices#choose-your-extensions-category-well) and [first upload flow](https://developer.chrome.com/docs/webstore/publish): upload creates an editable draft item before review submission.

Recheck live Dashboard wording during entry. The Dashboard, rather than this document, is authoritative if its labels change.
