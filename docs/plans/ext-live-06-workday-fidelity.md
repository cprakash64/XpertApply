# EXT-LIVE-06 — Workday field fidelity and completion engine

Branch `feature/ext-live-01` (worktree `XpertApply-extlive`). Baseline EXT-LIVE-05W `84e54cf`. Not pushed, not published, not deployed.
Production extension ID unchanged. No manifest permission change.

## Evidence limits (read first)
Everything below is verified against OWNED Workday-shaped fixtures (`apps/extension/e2e/fixtures/workday-app.html`) in jsdom and in real
Chromium with the real extension. **No live Workday tenant was available, so live acceptance is UNVERIFIED.** Workday `data-automation-id`
names come from public descriptions and are not confirmed on a live tenant; every lookup has a label/role fallback.

## Verified root causes
1. Production discovery never calls `adapter.discoverFields` (05W). It runs `discoverQuestionFields -> discoverFields`. The Workday
   repair therefore lives in the production path: `resolveQuestion` (automation-id label), `classifyField` (confidence), and a Workday
   filter in `discoverQuestionFields` plus `verifyFinalLiveDom({excludeElement})`.
2. The generic `fillStructuredRepeaters` would click Workday's "Add Another" while counting labels it does not recognise (blank rows), and
   the generic scalar mapper would copy the current employer into every row. Both are skipped on Workday; `ats/workdaySections.ts` owns rows.
3. 05W paused every step: `pending` counted OPTIONAL blanks. Only required blanks and confirmations now pause.
4. `Country`, `State`, `Country Phone Code` dropdowns were filled but reported `CONTROL_VALUE_VERIFICATION_FAILED` (no backing input on a
   Workday prompt button) and parked for review (label-only confidence 0.82-0.94). Rendered button text is now accepted as the committed
   value, and an automation id that agrees with the label raises confidence to the auto-fill threshold.
5. "Country Phone Code" matched no phone-country rule; "Phone Device Type" matched the generic phone rule (a phone number into a list).
6. A grouped Yes/No question was labelled by its option ("Yes"). Radio groups now use the group label. That exposed a latent defect: the
   word "country" in "...authorized to work in the country where the job is located" classified a legal question as Country. Fixed in
   `mapping.ts`; the test that pinned the defect now asserts the correct classification and the fail-closed case.
7. A step with no controls (informational page, Review) has no form root, so no fill pass ran and the engine never saw it.
   `driveWithoutForm` reads the step directly (and never for pages that have section containers or Add controls).
8. A Submit button on an ordinary step was treated as Review. It is now `ambiguous_submit`: stop, say why, click nothing.

## Control coverage (fixture-verified unless stated)
| Control | State | Verification |
|---|---|---|
| Text / textarea | done | read back from the control |
| Country / State / phone code prompt dropdown | done (production scalar path) | button text non-placeholder |
| Searchable typeahead (school, field of study) | done (sections) | selected chip text equals the exact option |
| Degree prompt | done | exact label; level word only for a GENERIC option ("Bachelor's Degree") |
| Month/Year spinbutton dates | done | each part read back; invalid month/year never written |
| Year-only dates (education) | done | |
| "I currently work here" + hidden end date | done | row re-resolved after the re-render |
| Radio / legal Yes-No | fills visibly, then flagged: run pauses (existing consequential-answer policy) | |
| Phone device type | left for the person (not a saved fact) | |
| Day-of-month dates, multi-select skills, languages, certifications | NOT implemented | |
| Real Workday dropdown markup (option list, search latency, virtualised lists) | UNVERIFIED live | |

## Repeatable sections
`fillWorkExperience / fillEducation / fillWebsites`: records matched to rows by CONTENT (employer; start year or title only to separate
two stints; school + degree level). Blank rows are reused; a row is added only for an unmatched saved record; foreign rows and non-empty
values are never overwritten or deleted (a differing value is counted as "kept"). A rerun or reload adds nothing. Not done: deleting a
duplicate created by an employer parse that completes AFTER the fill (XpertApply never deletes rows).

## Résumé
No native file picker is driven. The existing upload (the person's saved XpertApply résumé, set through DataTransfer) is skipped when
Workday already lists a file. A parse in progress (`file-upload-progress` / `aria-busy`) is awaited (25 s cap) before rows are reconciled.
"Autofill with Resume" remains a user-only start-choice boundary. Real Workday parse markup UNVERIFIED.

## Workflow / UX
Engine unchanged (bounded, one advance per signature). Assistant status shows employer-provided "Step N of M" only when the progress bar
exposes it, a verified-field count, named rows needing attention (labels only), and a review summary (fields verified, entries added,
employer values kept). No new tab, no new overlay.

## Permission assessment — `https://*.myworkdaysite.com/*`
- Evidence for the host: only third-party scraper/API vendor pages (Apify actors) and extension listings; they disagree (one says
  `wdN.myworkdaysite.com/<locale>/recruiting/<company>/<site>` works, another says it is not supported). Workday's own documentation
  (doc.workday.com, career-site setup) does not document `myworkdaysite.com`. Not confirmed on a live tenant.
- Consent impact if enabled: one more registrable domain in the single Chrome grant dialog (4 -> 5), a wildcard over every subdomain of a
  domain XpertApply cannot show Workday controls.
- **Decision for this candidate: NOT enabled.** `SITE_GROUPS` is back to the four approved groups, the onboarding dialog and Chrome
  prompt are identical to the 0.3.1 candidate, and host detection for `myworkdaysite.com` remains (detection grants nothing).
  Re-adding it is a one-line change plus `ext_live_site_grants.test.ts` after (a) a live tenant on that host is confirmed and (b) the
  operator re-approves the 5-domain dialog. (An earlier "keep it" was given before this evidence review.)

## Validation and rollback
See the release report. Rollback: re-upload 0.3.0 under a higher version; all state added is the `xpertapply.workflow.v1` sessionStorage key.
