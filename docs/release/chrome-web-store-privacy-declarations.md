# Chrome Web Store privacy declarations — operator draft

**NOT YET SUBMITTED TO CHROME WEB STORE.** Reviewed September 19, 2026. This is a draft for the operator to enter and verify against the live Dashboard; it is not a record of submission.

## Official basis

- [Privacy policy](https://developer.chrome.com/docs/webstore/program-policies/privacy/): accurately describe collection, use, sharing, and all recipients; link the policy in the Dashboard.
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use/): data must serve the disclosed single purpose or related operations; browsing activity requires a prominent user-facing feature; prohibit advertising, brokers, and lending; place an affirmative compliance statement on the product website.
- [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy): describe single purpose, justify each permission, answer remote-code question, declare data categories and certify use.
- [User data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq): local processing counts; page content, forms, URLs, identifiers and authentication information count as user data; consent disclosure must appear in product UI before collection.

## Single purpose

XpertApply helps users prepare, fill, and track job applications using information they provide and information from job/application pages they choose to use with XpertApply. Users review and submit applications themselves.

## Permission justifications

| Manifest item | Justification |
| --- | --- |
| `sidePanel` | Shows progress, review items, manual controls, and site-access disclosure for the selected application tab. |
| `storage` | Keeps temporary handoffs, tab authority, application package, progress, and limited runtime metadata across service-worker suspension. |
| `scripting` | Injects the bundled application assistant into the specifically authorized application tab/frame after host access is established. |
| `tabs` | Opens and tracks the user-selected employer application tab and necessary redirects/new tabs; binds authority to exact tab IDs. |
| `https://api.xpertapply.com/*` | Communicates with the first-party API for prepared sessions and application assistance. |
| `https://xpertapply.com/*`, `https://www.xpertapply.com/*` | Connects the first-party web app with the extension launch flow. |
| Optional `https://*/*` | Requested for one employer/ATS origin at a time by an explicit side-panel click. Employer destinations, embedded forms, redirects, and new tabs cannot all be enumerated in advance. Access serves only the selected application workflow. This is optional runtime access, not an install-time blanket grant. |

`webNavigation` is absent. No broader permission is proposed.

## Remote code

**No, I am not using remote code.** The extension manifest runs packaged `background.js`, `content.js`, and `sidepanel.js`. The side panel has a local script. API and AI responses are data used by packaged code, not remotely executed JavaScript. The local qualification ZIP was inspected: it contains only those bundled scripts and local assets, and a targeted scan found no `eval`, `new Function`, remote module import or remote script tag. Recheck the artifact uploaded at submission if it is rebuilt.

## User-data categories

The labels below are from the official [Privacy fields screenshot](https://developer.chrome.com/static/docs/webstore/cws-dashboard-privacy/image/screenshot-data-certifi-1955439870c37.png), checked September 19, 2026. Reconfirm the live Dashboard at submission if its labels change. Treat ambiguous categories inclusively rather than under-declaring.

| Dashboard category | Draft choice | Basis |
| --- | --- | --- |
| Personally identifiable information | SELECT | Name, email, contact details, account ID, professional profile. |
| Health information | DO NOT SELECT | No health-information feature established. |
| Financial and payment information | DO NOT SELECT | No payment or financial feature established in this extension flow. |
| Authentication information | SELECT | Session token and account authentication state handled during launch; an optional saved Workday password can be returned for the selected Workday application session. |
| Personal communications | DO NOT SELECT | Source audit did not establish reading email, text, chat, social posts or calls. A prepared outreach draft is not access to a communication channel. |
| Location | SELECT | User-entered location/region may be in profile and professional search criteria. No device geolocation permission is requested. |
| Web history | SELECT | Selected application URL, origin, redirect and tab navigation are processed for the user-facing workflow. This is not a general browser-history feed. |
| User activity | SELECT | Selected application workflow actions, statuses and progress are handled. |
| Website content | SELECT | Selected job/application page and form labels, questions, options and field state. |

## Limited Use certification draft

Extension-derived data is used only to provide or improve the disclosed application assistance and related security/reliability. It is not sold, used or transferred for personalized advertising, transferred to brokers or information resellers, or used for creditworthiness/lending. Human access must be limited to the policy exceptions (specific user consent, anonymized internal operations, security, or legal compliance). Public policy states: “The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.”

The official Dashboard image shows three certification boxes. Draft answers: certify **“I do not sell user data to third parties”; “I do not use or transfer user data for purposes that are unrelated to my item's single purpose”; “I do not use or transfer user data to determine creditworthiness or for lending purposes.”** Verify the live text before submission.

## Prominent disclosure and affirmative action

Location: `apps/extension/src/ui/sidepanel.ts`, site-access warning rendered before the `grantSiteAccess` button. Copy: “To help fill this application, XpertApply needs access to this site. It will read relevant application-page and form information. Relevant information may be sent to XpertApply's service for the features you request.” The button identifies the origin. A click invokes `chrome.permissions.request`; a denial does not grant access. The extension continues only after grant and authority checks. Employer submission remains manual.

## Policy, contact and processors

- Privacy URL: https://xpertapply.com/privacy (public page source: `apps/web/app/privacy/page.tsx`; deploy separately before Store submission).
- Contact: privacy@xpertapply.com.
- Current recipients: OpenAI, People Data Labs, Apollo, Hunter, Hostinger (hosting infrastructure). See [processor and flow audit](./chrome-web-store-privacy-audit.md).
- Owner account-contract check: exact Hostinger contracting entity. Do not add an invented legal entity to public copy.
- Provider contract follow-up: verify any desired OpenAI/other provider training, access or retention guarantees before making stronger claims. None are asserted here.

**Remaining publication gate:** this branch must be reviewed and deployed to the public privacy URL, the final Dashboard choices matched to its live labels, and the operator must submit the declarations. This draft does not perform those actions.
