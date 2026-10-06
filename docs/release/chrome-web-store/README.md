# Chrome Web Store release operator bundle

## Current 0.3.0 release preparation

Source version and package mirrors are updated to **0.3.0** from qualified engineering baseline `a11c3839d8c02d9b90dd7501c74513c29af4e98c` on `release/chrome-web-store`. Final 0.3.0 ZIP: **NOT BUILT**. Final SHA and package audit: **PENDING CWS-PREP-13**. The CWS-PREP-05R temporary dirty-tree production build exists only for focused qualification and its generated output is restored to entry bytes.

Official known Store ID: `gnibjomjfdobadlockphjiibbpmiehcj`. Canonical Store detail URL remains **pending owner/Dashboard verification**. Use the existing official item; do not create another item or invent a URL. Production Web ID/URL deployment is pending; positive ID wiring was absent in observed running configuration and URL was empty.

| Gate | Current status |
| --- | --- |
| Final 0.3.0 ZIP / SHA / package-entry and remote-code audit | NOT BUILT / PENDING CWS-PREP-13 |
| Canonical Store detail URL | OWNER/DASHBOARD VERIFICATION PENDING |
| Production Web Store ID/URL deployment and positive handoff proof | PENDING |
| NEW-04 HTTP security headers | OPEN / P1 |
| PROXY-01 production proxy/body-limit qualification | OPEN / manual production qualification required |
| Four Store screenshots / required 440×280 promo | PENDING |
| Dashboard listing, privacy labels and distribution reconciliation | PENDING |
| Store-delivered same-item signed N baseline | PENDING |
| Signed N → 0.3.0 update proof / final installed audit | PENDING |
| Manual ATS / manual accessibility | PENDING |
| Package upload / Submit for Review / publication | NOT AUTHORIZED / NOT PERFORMED |
| Review approval/status | PENDING |

Upload, submission and publication are not authorized by this bundle. Private/restricted tester delivery is also a separately authorized publication/delivery operation. See the [living plan](../../plans/chrome-web-store-0.3.0-release.md) for ordered stages and dependencies.

## Historical 0.2.0 artifact — preserved evidence

The September 19, 2026 operator bundle was prepared at `ac64ea901d7c3462a74182afffc3377586674656`. Historical ZIP: `apps/extension/xpertapply-extension.zip`; version **0.2.0**; **203500 bytes**; SHA-256 `30c8784dd755b982cb18fe6cd99c6474b96ed4a82585f9e731db0d27f0f545a4`. It has `manifest.json` at ZIP root and is ignored generated evidence. This identifies historical bytes, not the current release package or current upload authorization. The stale entry `dist` is intentionally restored to 0.2.0 until final packaging.

## Operator field map

| Area | Record |
| --- | --- |
| Package | Final build/SHA/entry audit pending CWS-PREP-13; historical ZIP is not the current package. |
| Listing | [Listing copy](store-listing.md); reconcile with final package and live Dashboard. |
| Privacy | [Privacy worksheet](privacy-practices.md); live labels and final package scan pending. |
| Images | [Asset inventory](asset-inventory.md); screenshots and required promo pending. |
| Distribution | [Distribution worksheet](distribution.md); owner decisions pending. |
| Stable ID | [Stable-ID handoff](stable-id-handoff.md); known ID, URL verification and Web deployment pending. |
| Release gates | [Submission checklist](submission-checklist.md); no inferred completion. |

Official guidance links retained as references from September 19, 2026: [prepare](https://developer.chrome.com/docs/webstore/prepare), [listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [privacy](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution), [images](https://developer.chrome.com/docs/webstore/images), [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use/) and [publishing](https://developer.chrome.com/docs/webstore/publish). Live Dashboard wording must be verified later.
