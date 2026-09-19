# Privacy Practices Dashboard worksheet

Prepared from the [qualified privacy declaration](../chrome-web-store-privacy-declarations.md), the final version `0.2.0` package, and [Chrome's Privacy practices guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), reviewed September 19, 2026. This is entry guidance, not a record of Dashboard selections. Compare each label with the live Dashboard before submission.

## Single purpose

XpertApply helps users prepare, fill, and track job applications using information they provide and job/application pages they choose to use with XpertApply. Users review and submit applications themselves.

## Permission justifications

| Permission shown by package | Dashboard-ready justification |
| --- | --- |
| `sidePanel` | Displays the selected application's context, progress, review controls, and site-access disclosure beside the current tab. The side panel is needed so those controls remain visible while the user reviews the employer form. |
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

**Remote Code:** select **“No, I am not using remote code.”** The ZIP executes bundled JavaScript only. API/AI responses are data, not remote executable code; no remote script tag, dynamic remote import, `eval`, or `new Function` was found in the package audit.

**Privacy policy URL:** https://xpertapply.com/privacy. **Public privacy contact:** privacy@xpertapply.com.

**Prominent disclosure:** the side panel's site-access warning appears before its origin-specific “Allow XpertApply on this site” button. The click invokes the optional permission request; denial remains safe. The user controls final employer submission.

**Disclosed processors:** OpenAI, People Data Labs, Apollo, Hunter, and Hostinger hosting infrastructure. Do not add unsupported provider training, zero-retention, or deletion guarantees.
