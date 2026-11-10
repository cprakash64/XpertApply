# EXT-LIVE-07 native Chrome runbook (operator-run; nothing here has been run by the engineer)

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

## 3. Store version
Choose the upload version only after reading the version history in the Developer Dashboard (not visible from the development
environment). Do not bump merely because several unpublished 0.3.1 ZIPs exist.
