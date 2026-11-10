# EXT-LIVE-07 / 08 native Chrome runbook (operator-run; nothing here has been run by the engineer)

> EXT-LIVE-09 supersedes the candidate named below: use the candidate recorded in `docs/release/EXT-LIVE-09_CANDIDATE.md`. The checks in section 2 still apply; section 2b is new.

Candidate: `/Users/cprakash/Developer/XpertApply-builds/xpertapply-extension-0.3.1-07-1aeffe9.zip`
SHA-256: `74da925f69f373368cd35ea8d37be94dc439d23b7d276ff9056696a0f76ad673` (commit `1aeffe9`, version 0.3.1, no manifest key)
Production ID: `gnibjomjfdobadlockphjiibbpmiehcj`. Never upload the unpacked folder. Never paste a private key anywhere (none is needed).

## 1. Production-ID unpacked build (public key only)
1. Chrome Web Store Developer Dashboard > item > Package > View public key. Copy it (PUBLIC key).
2. Run (the historical `44c107e` pin is still the default; the candidate must be named explicitly):
   ```bash
   /Users/cprakash/Developer/XpertApply-builds/make-store-id-build.sh --zip /Users/cprakash/Developer/XpertApply-builds/xpertapply-extension-0.3.1-07-1aeffe9.zip --sha256 74da925f69f373368cd35ea8d37be94dc439d23b7d276ff9056696a0f76ad673
   ```
3. It must print `manifest identical except key: true`, `derived extension id: gnibjomjfdobadlockphjiibbpmiehcj (matches production)`,
   `version: 0.3.1`, then the folder `.../store-id-work-xpertapply-extension-0.3.1-07-1aeffe9/dist-store-id`. It refuses on a wrong
   checksum, a missing/relative path, a lone argument, or a clipboard that is not the production public key. The work folder is recreated
   each time (no stale artifacts).
4. New Chrome profile, no other extensions (remove the Store 0.3.0 copy first: one ID cannot load twice). Load unpacked that folder.

## 2. Real Workday acceptance (use ONLY an employer and account you are authorised to use; stop before Submit; do not create accounts for testing)
Record per tenant: hostname and form variant (no secrets), steps, field types, filled-and-visibly-correct, unresolved, wrong mappings,
navigation failures, interventions, timeouts. Do NOT record credentials, tokens, applicant PII, résumés or disclosure answers.

| Row | Check |
|---|---|
| A | Enable-sites page once; ONE Chrome dialog naming four domains (Greenhouse, Lever, Ashby, Workday); no repeat prompt |
| B | Opening the application shows the assistant without a click; a job posting shows none |
| C | Sign-in / start-choice pages: assistant reports a pause, clicks nothing (Sign In, Autofill with Resume, Apply Manually are yours) |
| D | "Complete application" starts once; no second employer tab; one overlay |
| E-G | My Information: names, address, phone + country code, location; searchable school / degree / field of study |
| H-I | 2+ jobs and 2+ degrees: right count, no blanks, no duplicates after a reload |
| J-K | Your own résumé: no second upload after refresh; parsed rows kept; only missing records added; "Résumé parsing" pause if it hangs |
| L-M | Screening and legal questions: nothing invented; legal answers flagged for you; pause reason is understandable |
| N | Voluntary disclosures / self-identify: left for you |
| O-P | Every step advances once; reload and worker sleep resume without repeating or skipping a step |
| Q-R | Review page: run ends "Ready for your review"; Submit never clicked |

Any dialog naming all websites, a repeat prompt, an overwritten manual edit, a demographic fill, a duplicate row, or any submission is a blocker.

## 2b. EXT-LIVE-08 two-application isolation (do this BEFORE the Workday rows)
Use two different jobs of the same employer on ONE ATS (for example two Lever or Greenhouse postings) with your own account.
1. Launch job 1 from XpertApply. Let it fill. Do not start anything in other tabs.
2. In a NEW tab open job 2's application URL yourself (paste it). Expected: the form stays EMPTY and nothing is clicked. The assistant may appear and say it has no application for this page. Any fill, navigation or Next click here is a blocker.
3. Launch job 2 from XpertApply. Expected: its own tab fills with job 2's values; job 1's tab is unchanged; both tabs show their own assistant.
4. On Workday: click Complete application in tab 1. While it runs, open job 2's URL in another tab: it must stay idle. Then start job 2 yourself: each tab advances only itself.
5. In tab 1 mid-run, navigate (link/back) to a different job: the run stops with a message; nothing is filled until you start again from that job.
6. Duplicate tab 1 (right-click tab > Duplicate) while running: the copy must NOT continue the run.
7. In chrome://extensions > XpertApply > Site access, remove the site during a run: the run stops.
8. Custom career sites and smaller ATSs (Tesla-style, SmartRecruiters, any employer's own domain): repeat steps 1-3 with two different jobs. Open job 2 by hand in a new TAB and in a new WINDOW (Window > New Window): both must stay empty. Then in tab 1 follow a link/back/forward to job 2: nothing carries over.
9. Resume after a restart: during a Workday run restart Chrome (or reload the extension). The assistant must NOT continue by itself; it offers "Complete application" again and says it could not verify the earlier run. Click it to resume.
10. Open the service-worker console (chrome://extensions > service worker) and each employer tab console: record any red errors.

## 2c. EXT-LIVE-10 operator checklist (fresh Chrome profile; run before Workday)
A. Install the exact candidate (build command in `EXT-LIVE-10_CANDIDATE.md`) in a FRESH Chrome profile. Compare the ZIP/unpacked SHA-256 with the record.
B. chrome://extensions: the ID must be `gnibjomjfdobadlockphjiibbpmiehcj` (Developer mode, Load unpacked).
C. Site permission: one Chrome dialog for the approved ATS groups, once; nothing else is requested.
D. After granting, open a supported application page: the assistant appears by itself, with no further click.
E. Two jobs on one ATS in two tabs: job 2 opened by hand stays empty; launching job 2 fills only job 2. Repeat with two URLs that differ only by `?jobId=`.
F. Tesla-style multistep application (own account): runs through every step, stops at Review, never clicks Submit.
G. Real Workday (authorised account only): My Information, My Experience, Education, questions, Review. Stop at Review.
H. Pause/resume: leave a required question blank, answer it yourself, choose Complete application again. Restart Chrome mid-run: the assistant offers to resume and never continues silently.
I. No duplicate Work Experience/Education rows; no extra employer tabs.
J. Edit a field yourself mid-run: your value is kept.
K. Submit is never clicked by XpertApply.
L. Sign-in: Connect, then Disconnect, then Connect again WITHOUT reloading. The assistant becomes usable immediately and shows only the current account's data. Cancel the Chrome sign-in window once: the notice says it was cancelled and a retry works.
M. Record red errors from the service-worker console and each employer tab console.
Live employer acceptance (G, F, E on real sites) is separate from the synthetic/fixture tests in the report; do not treat one as the other.

## 3. Store version
Choose the upload version only after reading the version history in the Developer Dashboard (not visible from the development
environment). Do not bump merely because several unpublished 0.3.1 ZIPs exist.
