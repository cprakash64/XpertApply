# EXT-LIVE-07 — Real Workday acceptance and targeted remediation

Baseline EXT-LIVE-06 `ae304f1`. Branch `feature/ext-live-01`. Not pushed, published or deployed. Extension ID unchanged. No manifest change.

## What "real" evidence was available
No authorized Workday candidate account exists in the development environment, and accounts are never created here. The only real-tenant
evidence is **read-only, pre-authentication** DOM inspection of two public tenants (nothing clicked inside an application, nobody signed in,
no data recorded beyond element names):

| Tenant host (public postings) | Variant seen | Observed |
|---|---|---|
| `nvidia.wd5.myworkdayjobs.com` | posting → `/apply` start page → `/apply/applyManually` | Apply is `<a data-automation-id="adventureButton">`; start page is anchors `autofillWithResume`, `applyManually`, `useMyLastApplication`, `applyWithLinkedIn`; sign-in landing has headings "Sign In", `signInContent`, Google/LinkedIn/email buttons and **no password field**; progress bar is `<ol data-automation-id="progressBar">` of `<li progressBarActiveStep/InactiveStep>` with labels only "current step N of 6" (no step names) |
| `salesforce.wd12.myworkdayjobs.com` | posting → `/apply` start page | same anchors (`autofillWithResume`, `applyManually`, `useMyLastApplication`), no LinkedIn option, different datacenter |

Everything past the sign-in wall (My Information, My Experience, questions, disclosures, Review) remains **fixture-only**.

## Confirmed failures on real markup, and fixes
1. Start-choice page and the posting's Apply control are **anchors**, not buttons: classified `unknown_step` (wrong boundary message). Fixed
   (`workdayStep.ts`); test `workday_real_markup.test.ts` uses the sanitized structure.
2. The sign-in landing page has no password input yet: not recognised as sign-in. Fixed.
3. Real progress bar has no step names: ambiguity detection (Submit on an ordinary step) relied on them. Heading now names the step; step
   counts ("Step N of M") come from the bar only.
4. `Apply Manually` was verified NOT to be an automatic activation target (test).

## Résumé-parse reconciliation barrier
Busy marker (`file-upload-progress` / `aria-busy` in the résumé section) → nothing added; after it clears the row count must be quiet for
900 ms before rows are re-read; 25 s without settling → add nothing and pause ("Résumé parsing"). Rows are matched by content, only
missing records are added, nothing is deleted or overwritten, and duplicate-like rows created by a parse that finishes after the fill are
reported (pause) instead of added to or removed. Browser-fixture proof: `e2e/workday-parse.spec.ts` P1–P7.
Limits: busy/settled markers are modelled on public descriptions and unverified on a live parse.

## Lever
`e2e/lever-regression.spec.ts` (owned Lever-shaped page under `jobs.lever.co`): auto-appearance, text/dropdown fill, unknowns and consent
untouched, preserved edits, flagged legal answer, permission persistence, no submission. Lever's form is single-page; multi-step n/a.
Observation (not changed): a second tab on the same ATS origin joins the active workflow (`originJoinsWorkflow`) and is filled with that
session's data, including when it is a different job. Product decision needed.

## Permissions
Unchanged from 06: four approved groups; `myworkdaysite.com` not granted. Real evidence for that host still absent.
