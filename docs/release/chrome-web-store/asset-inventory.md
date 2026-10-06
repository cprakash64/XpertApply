# Store graphic asset inventory — current 0.3.0 preparation

Historical image specifications reference: [Chrome images](https://developer.chrome.com/docs/webstore/images), checked September 19, 2026. Live reconciliation remains pending.

| Asset | Current state / capture plan |
| --- | --- |
| 128×128 Store icon | READY: `apps/extension/icons/xpertapply-128.png`, RGB PNG, 16,332 bytes; existing qualified mark. Final package inclusion audit pending. |
| Runtime icons 16/32/48 | READY: existing `apps/extension/icons/xpertapply-16.png`, `xpertapply-32.png`, `xpertapply-48.png`; final package audit pending. |
| S1 | PENDING: toolbar-opened in-page assistant beside a synthetic application. |
| S2 | PENDING: explicit Fill/review workflow with employer page visible. |
| S3 | PENDING: required-review state blocks completion, with actual manual consent/final-submit messaging. |
| S4 | PENDING: minimized/restored assistant or a useful actual fallback surface. |
| Small promo | REQUIRED 440×280; NOT READY / PENDING design and approval. |
| Marquee | OPTIONAL 1400×560; DEFERRED. |
| Promo video | Optional; not prepared. |

Plan four actual final-product screenshots, each **1280×800 RGB PNG**, full bleed with square corners. Chrome's referenced specification permits 1–5 screenshots at 1280×800 or 640×400. Use synthetic/demo data only: no PII, tokens, diagnostics, fabricated/mock UI or test-only/localhost labeling in final Store images. Capture only behavior actually visible in the final product; do not invent review or consent controls for the screenshot.

The existing Web brand logo is a reference, not a qualified Store graphic. No image is created in this stage. Missing graphics block final listing/review submission; they do not establish upload authorization or prevent preparation of the stable-ID map.
