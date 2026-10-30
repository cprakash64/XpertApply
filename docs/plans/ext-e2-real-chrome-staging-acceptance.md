# EXT-E2: real-Chrome staging acceptance of the staging extension build (plan)

Status: **PLANNED, NOT EXECUTED.** Follows `docs/release/EXT-E1_COMPATIBILITY_REPORT.md`. Staging only. No push, deploy, migration, nginx, SMTP, store build or production contact. Production stays NO-GO.

## 1. Goal
Show, in desktop Chrome against `https://staging.xpertapply.com` and `https://api-staging.xpertapply.com`, that the **staging build of line C** (`feature/xa-core1-direct-autofill`, `6458b2d`, `npm run build:staging`) connects an account, detects Greenhouse, Lever, Ashby and Workday application pages, fills them from a synthetic profile, and never submits. Output is a GO/NO-GO for continuing toward a release plan, not a release.

## 2. Entry conditions (all must hold; each is a stop if not)
| # | Condition | Who | How |
|---|---|---|---|
| 1 | Founder approves this run and the throwaway account | Founder | explicit yes in chat |
| 2 | Staging still web `1b26947`, API `aa5bc2f`, DB `0034` | Operator | `verify` outputs of S3 and the API release record; no new deploy since |
| 3 | `EXTENSION_ALLOWED_IDS` is empty or exactly `["cglmdonbfbadfbggkpajpkjgpekhkall"]` | Operator | `sudo docker exec xpertapply-staging-api printenv EXTENSION_ALLOWED_IDS` (read-only). If it holds another ID, stop: changing it is a separate staging change needing its own approval |
| 4 | Throwaway staging account with a synthetic profile | Founder or operator | created through the staging site; synthetic name, a mailbox the founder controls, no real data. Work-authorization and demographic answers entered **explicitly** by the tester; the extension must never infer them |
| 5 | Dedicated Chrome profile, desktop Chrome 133 or newer, extensions other than this one disabled | Tester | record the exact Chrome version |
| 6 | Staging build produced from a clean `git archive` (no worktree), `version_name` ends `; staging)`, content id `nogit-3a9aaee` (if the sources are unchanged) | Tester | commands in the report, section 11 |

Known gap that must be settled before step 3 of the run: line C is unpushed and is on a tree older than the premium UI. This plan tests the extension only; it does not decide how line C is integrated.

## 3. Roles and evidence
- **Tester** (founder or nominated person) drives Chrome. **Claude** prepares the checklist, reviews the evidence and writes the report; it does not drive the founder's Chrome or enter credentials.
- Evidence per step: screenshot, Chrome version, extension card ID, and a saved DevTools Network export (HAR) for the employer tab and the extension's service worker, with the Authorization header and cookies stripped before sharing. No tokens, passwords or real personal data in any shared file.
- Result sheet: one table, step, expected, observed, pass/fail, evidence file name.

## 4. Test matrix
**Block A: install and identity**
A1 Load unpacked `dist-staging`; card name `XpertApply (STAGING)`, ID `cglmdonbfbadfbggkpajpkjgpekhkall`.
A2 Worker console: host permissions are exactly the two staging hosts; redirect URL starts with the pinned ID.
A3 Toolbar click on an unrelated site: no page read, no request to XpertApply (first-use notice if shown is accurate).

**Block B: account**
B1 Connect from the assistant: Chrome's sign-in window opens on `staging.xpertapply.com/extension/connect`, shows the signed-in email, approve; assistant shows the account.
B2 Decline and close the window: assistant stays "Not connected", no credential created.
B3 Reload, restart Chrome, wait 5 minutes (worker suspends): still connected, one assistant.
B4 Disconnect: "Not connected" at once and after reload; the connect page can issue a new code afterwards.
B5 Second staging account in another tab, connect again: first account's draft and values never appear.
B6 Sign out of the website, connect again: asked to sign in first, then returned to the same request.
B7 (revocation) Operator revokes the credential family in the **staging** database only, or the tester disconnects from a second browser profile: the next action signs the extension out, nothing is filled.

**Block C: permissions and first visit**
C1 Public Greenhouse application URL with no grant: one Chrome access notice and a `!` badge within seconds; nothing read or sent.
C2 Allow: one assistant, no extra window, no stuck "detecting".
C3 Remove the site grant in Chrome and revisit: the request returns once per tab and origin; a reload does not repeat it.
C4 A job listing page and an unrelated site: silent.

**Block D: fill, per ATS (Greenhouse, Lever, Ashby, Workday)**
For each, on a public application page that is **not submitted**: text fields; dropdowns, checkboxes, radios; required versus optional; synthetic resume and cover letter where the form asks for them; partial fill then reload and recovery; the count shown equals the fields that visibly changed; voluntary self-identification untouched unless the tester supplied an answer. Record per-field mismatches by label.
Workday only: stop at the Review step. Record whether auto-advance ever moved past a step with unresolved or required-blank fields (finding F3). If it clicks anything labelled Submit, Apply-as-final or Finish: **abort the run**.

**Block E: network and isolation**
E1 Network of worker and employer tab: only the employer origin and `api-staging.xpertapply.com`; zero requests to `api.xpertapply.com` or `xpertapply.com`.
E2 Page-side: employer page cannot read the assistant (closed root) or the credential; verify with the page console that no token string appears in page-visible storage or DOM.
E3 Duplicate overlays: refresh and SPA navigation never create a second assistant.

**Block F: bounded performance**
Time from page load to assistant visible, and from Connect click to filled, three runs each on Greenhouse. Note memory of the service worker in Chrome Task Manager at start and after 20 minutes of repeated visits. No load generation against staging.

## 5. Stop and abort rules
- Any request to a production host, any submit-type click by the extension, any token visible to a page, or an unexpected extension ID: **abort and report**, change nothing.
- A fill that writes a wrong value into a legal or sensitive field: record, continue other blocks, mark NO-GO for that ATS.
- Do not retry connect more than five times in a minute (the API throttles codes at ten a minute per user).
- Never click the employer site's final submit. If a form cannot be reviewed without submitting, skip it.

## 6. Cleanup and rollback
Remove the `XpertApply (STAGING)` card; delete the throwaway account's data through the staging site if the founder wants it gone; credential families are revoked by Disconnect. Nothing on staging infrastructure is changed by this run. The production extension and site are not touched.

## 7. Deliverable
`docs/release/EXT-E2_ACCEPTANCE_REPORT.md`: result table for every step, Chrome version, build identity, evidence index, defects with root cause, and a GO/NO-GO per ATS (Workday expected to stay "limited" unless block D passes). Defects found are fixed in narrow local commits with tests; nothing is pushed.

## 8. Open items carried from E1
1. F1 (extension credentials end on password reset) is committed locally (`3454d5f`) but not released; staging password reset is disabled, so this run cannot exercise it.
2. F2 rate-limit bucket and F3 Workday auto-advance are unaddressed; the Workday block above is how F3 gets real evidence.
3. How line C joins the release line is undecided.
4. Real-Chrome behavior of Chrome's own sign-in window and grant prompt has never been exercised against the staging hostnames.

## 9. Progress log
- 2026-10-30: plan written. Nothing run.
