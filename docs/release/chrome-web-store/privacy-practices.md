# Privacy Practices Dashboard worksheet

Current **0.3.0 source-based draft**, updated for the in-page assistant and activeTab. Final 0.3.0 ZIP is NOT BUILT; SHA/package scan PENDING CWS-PREP-13. The historical 0.2.0 byte audit is preserved in the [privacy audit](../chrome-web-store-privacy-audit.md). FINAL LIVE DASHBOARD LABEL VERIFICATION PENDING; answers have not been entered by this stage.

## Single purpose

XpertApply helps users prepare, fill, and track job applications using information they provide and job/application pages they choose to use with XpertApply. Users review and submit applications themselves.

## Permission justifications

| Permission shown by package | Dashboard-ready justification |
| --- | --- |
| `activeTab` | Temporary authorization after an explicit Chrome toolbar action to bootstrap the packaged assistant on the selected application tab. It does not create blanket access to all employer origins. |
| `sidePanel` | Displays the selected application's context, progress, review controls, and site-access disclosure beside the current tab. The Side Panel is a fallback; the primary in-page assistant keeps the employer form visible and usable. |
| `storage` | Retains temporary application handoffs, tab binding, prepared answers, and progress across MV3 service-worker suspension, plus limited local configuration. In-memory state alone would be lost when Chrome suspends the worker. |
| `scripting` | Injects the packaged form assistant into the specific application tab/frame after site access is granted. A static first-party content script cannot cover user-selected third-party employer origins. |
| `tabs` | Opens and tracks the selected employer application through redirects and new tabs, binding the workflow to exact tab IDs. The selected application may move across tabs, which an active-tab-only view cannot reliably track. |
| Required `https://api.xpertapply.com/*` | Connects the extension to XpertApply's first-party API for requested application sessions and assistance. A narrower path set would omit multiple related API endpoints. |
| Required `https://xpertapply.com/*`, `https://www.xpertapply.com/*` | Enables the first-party launch/content-script bridge on the established apex and `www` web origins. Both are supported site forms; unrelated hosts are excluded. |
| Optional `https://*/*` | Allows an explicit per-origin Chrome permission request for the employer or ATS site the user selected, including redirects/embedded application forms. Those destinations cannot be enumerated in advance; the grant is requested at runtime for the chosen origin, not automatically at installation. |

No `webNavigation` permission is present. Do not describe optional employer access as a blanket install-time grant.

## User-data categories

These are the labels shown in Chrome's [Privacy practices category screenshot](https://developer.chrome.com/static/docs/webstore/cws-dashboard-privacy/image/screenshot-data-certifi-1955439870c37.png). Reconfirm in the live Dashboard.

| Dashboard category | Draft choice | Evidence |
| --- | --- | --- |
| Personally identifiable information | SELECT | Name, email, contact, account ID, professional profile. |
| Health information | DO NOT SELECT | No health-information feature established. |
| Financial and payment information | DO NOT SELECT | No payment or financial flow established for this extension. |
| Authentication information | SELECT | Launch/session credentials and optional saved Workday application credential in the selected workflow. |
| Personal communications | DO NOT SELECT | No reading of email, chat, texts, calls, or social messages is established. |
| Location | SELECT | User-entered location/region in profile and selected searches; no device geolocation permission. |
| Web history | SELECT | User-selected application URLs, redirects, and tab navigation are processed for the application workflow; this is not a general history feed. |
| User activity | SELECT | Selected application actions, state, progress, and tracking. |
| Website content | SELECT | Selected job/application page content, form labels, questions, options, and field state. |

## Data use, disclosure, and remote code

Certify the current Dashboard statements only after confirming they match operations: user data is not sold; it is not used/transferred for an unrelated purpose; it is not used/transferred for creditworthiness or lending. Extension-derived data is limited to disclosed application assistance and related security/reliability. [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use/) also restricts personalized advertising, brokers, and human access. The live privacy policy contains the required affirmative Limited Use statement.

**Expected final remote-code answer: No remote executable code.** Current runtime entrypoints are locally bundled, including `background.js`, `content.js`, `assistant.js`, `overlayBootstrap.js` and `sidepanel.js`, with local page assets. API/AI responses are data, not executable extension code. Final answer requires a fresh CWS-PREP-13 package-entry inventory and scan before any Dashboard entry; the historical package scan does not qualify current bytes.

**Privacy policy URL:** https://xpertapply.com/privacy. **Public privacy contact:** privacy@xpertapply.com.

**Prominent access disclosure to reconcile in final product/Dashboard qualification:** the toolbar selects an application page and temporarily authorizes packaged assistant bootstrap through activeTab. The primary UI is the in-page assistant; Popup and Side Panel remain fallback surfaces. Local form discovery reads labels, questions, options and relevant context; relevant selected-page information may be sent to XpertApply for requested assistance. Optional employer/ATS origin access remains an explicit grant; users may decline or revoke it. Fill is explicit and user-triggered. Values placed in the employer/ATS form become visible to that site under its practices before final submission. Sensitive questions, legal attestations and consent require manual review/action; employer final Submit remains manual. This is not an all-DOM-upload or local-until-Submit claim. Final manual disclosure qualification is PENDING.

**Disclosed processors:** OpenAI, People Data Labs, Apollo, Hunter, and Hostinger hosting infrastructure. Do not add unsupported provider training, zero-retention, or deletion guarantees.

Category set remains PII, authentication, user-entered/profile/job-search location, selected-workflow Web history, user activity and website/application content. No new category is established solely by the UI surface change. No provider zero-retention or non-training guarantees are asserted. Final Dashboard declarations remain PENDING and upload/review/publication are NOT AUTHORIZED.
