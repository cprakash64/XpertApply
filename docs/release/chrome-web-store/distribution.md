# Distribution worksheet — current 0.3.0 preparation

Eventual intended visibility: **Public**. Current distribution actions are **NOT AUTHORIZED**. Historical guidance reference: [Chrome distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution), reviewed September 19, 2026; final live labels remain pending.

| State | Meaning and boundary |
| --- | --- |
| DRAFT | Editable item/package/metadata state; uploading or saving still needs separately scoped authorization. It does not itself deliver an install or establish a signed baseline. |
| PRIVATE / RESTRICTED DELIVERY | Same official item restricted to approved testers where supported; still requires policy review and publication/delivery authorization. It is not a harmless draft action. |
| PUBLIC | Eventual owner goal; separate final readiness, review submission and publication authorization required. |

Owner decisions PENDING: regions (all or selected), pricing/IAP and account offering confirmation, trusted tester / Private baseline strategy and Store-delivered signed N. Do not infer a paid-extension model from account features or silently create a separate testing item.

Same-item signed N must be established before replacing draft N with 0.3.0. An existing Store-delivered install can qualify after proof; otherwise any historical 0.2.0 restricted review and delivery need separate authorization with accurate N-specific listing/privacy/package evidence. Unsigned local ZIPs do not qualify. Later restricted N+1 review/delivery, final Public review submission and publication remain separate actions. NEW-04, PROXY-01 and production handoff readiness remain open gates; see the [living plan](../../plans/chrome-web-store-0.3.0-release.md).

No Dashboard save, upload, review submission or publication/delivery at any level is authorized here.
