# EXT-LIVE-01 real-Chrome acceptance checklist (0.3.1)

Purpose: close the gaps that automated Chromium specs cannot cover. Run it by hand on a Store-delivered
build before widening the rollout. Record PASS/FAIL and a screenshot or note for every row.

Candidate: `xpertapply-extension-0.3.1-ba2941f.zip`, sha256
`36d65c40119707380da7f9192ba230b2289bfae2f317fde8c9cf6a9193f1ab39`. Extension ID
`gnibjomjfdobadlockphjiibbpmiehcj`.

## Ground rules
- Use a brand-new Chrome profile (no other extensions) and a disposable XpertApply account with disposable
  resume and profile data. No real personal data.
- Never press the final Submit / Apply button on any employer page. Stop at the review step. Use test
  postings you own, or stop before submission on real ones.
- Do not push, publish or widen the rollout from this list; it only produces evidence.
- Keep `chrome://extensions` > XpertApply > Details > Site access open in a second tab to watch grants.

## A. Delivery
| # | Step | Expected |
|---|------|----------|
| A1 | Upload the ZIP as a new version of the existing item; submit for review with a staged rollout if offered. | Dashboard shows 0.3.1, same ID, no new-permission notice. |
| A2 | Before the update, install published 0.3.0 from the Store in profile P1. Grant one exact host (e.g. one Greenhouse board). | 0.3.0 works as before. |
| A3 | Force the update (`chrome://extensions` > Update, or wait). | Version reads 0.3.1. The extension is not disabled for "new permissions". The earlier exact grant still listed. |
| A4 | Open one supported application page already covered by the old exact grant. | Assistant appears with no new prompt. |

## B. Fresh install (profile P2, 0.3.1 from the Store)
| # | Step | Expected |
|---|------|----------|
| B1 | Install. | The Enable-sites page opens once. Nothing else is requested; Site access shows no extra sites. |
| B2 | Close the page without clicking. Visit a Greenhouse application. | No read of the page, no prompt. Toolbar badge offers access. |
| B3 | Reopen via Options, click "Enable on supported job sites". | ONE native Chrome dialog naming the four ATS domains. Not "all websites". |
| B4 | Accept. | Page shows all four groups Allowed. Chrome Site access lists them. |
| B5 | Visit a different company on the same ATS. | No prompt; assistant appears. |

## C. Consent edge cases
| # | Step | Expected |
|---|------|----------|
| C1 | Fresh profile P3: deny the native dialog. | Page shows not allowed; no error loop. |
| C2 | Browse several Greenhouse/Lever pages, wait over 1 minute so the worker suspends, then browse again. | No repeated passive prompts or badges for the denied sites. |
| C3 | Allow later from Options. | Works; suppression cleared. |
| C4 | Remove a group in Chrome Site access (or Options "Remove"). Reload a page of that ATS. | Assistant stops; no prompt reappears on its own; Options shows it not allowed. |
| C5 | Restart Chrome. | Grants and denials persist. |
| C6 | Custom employer domain (not one of the four): open the assistant. | Asks only for that exact host, from a click. Never `https://*/*`. |
| C7 | Review the native dialogs seen. | None says "all websites". |

## D. Automatic assistant
| # | Step | Expected |
|---|------|----------|
| D1 | Open an application page directly in a new tab (granted ATS). | Overlay appears without a click. |
| D2 | Open a page whose form renders late (SPA, slow network or throttled). | Overlay appears once the form shows. |
| D3 | Navigate inside the SPA from listing to application. | Overlay appears after the route change. |
| D4 | Open a listing page with no form. | No overlay and no page reads; no CPU churn in Task Manager. |
| D5 | Provoke a miss (supported URL, form never renders). | After about 5 minutes or 20 looks, the assistant opens with "hasn't found the application form" and a Try again button that works. |
| D6 | Per-site switch off, then reload. | Overlay stays away. |
| D7 | Browser window narrow / 400% zoom. | Overlay stays usable. |

## E. Autofill (disposable data; stop before Submit)
For each of Greenhouse, Lever, Ashby (priority) and Workday (limited):
| # | Check | Expected |
|---|-------|----------|
| E1 | Saved fields (name, email, phone, links) fill. | Correct values only. |
| E2 | Resume upload. | Attaches the saved resume or prompts clearly. |
| E3 | Type a value manually, then run autofill. | Manual edit not overwritten. |
| E4 | Demographic / EEO / disability / veteran fields. | Left untouched. |
| E5 | Free-text questions with no saved answer. | Left empty, nothing invented; drafting stays disabled. |
| E6 | Form reaches review. | No auto-submit; user presses Submit (do not press). |
| E7 | Workday: record which steps fill and which do not. | Limited scope documented; no claim of full support. |

## F. Account and isolation
| # | Step | Expected |
|---|------|----------|
| F1 | Signed out: open a supported page. | Prompts sign-in; nothing filled; no saved data exposed. |
| F2 | Sign in as user A, fill, sign out, sign in as user B. | B never sees A's data, drafts or state. |
| F3 | Revoke the session in the web app, retry autofill. | Extension reports signed out. |

## G. Resilience
| # | Step | Expected |
|---|------|----------|
| G1 | Let the service worker idle out (about 1 minute) mid-session, then act. | Flow recovers; no duplicate prompts. |
| G2 | Two ATS tabs at once. | Independent state; no cross-fill. |
| G3 | DevTools Network on an application page. | Requests only to xpertapply.com / api.xpertapply.com; no third-party calls from the extension. |
| G4 | `chrome://extensions` > Errors. | No new errors. |

## Evidence and sign-off
Fill in: tester, date, Chrome version, OS, profile used per section, and a link or file for each screenshot.

Verdict rule: PASS READY FOR CONTROLLED UPDATE only if every A, B, C, D, F and G row passes and E passes for
Greenhouse, Lever and Ashby; Workday E7 is recorded as limited. Any native dialog naming all websites, any
repeated prompt after a denial, any overwrite of manual input, any demographic fill, or any submission
is a BLOCKER.

## Rollback trigger
If a blocker appears after upload: pause the staged rollout, then re-upload the 0.3.0 contents as a higher
version number (the Store never lowers one).
