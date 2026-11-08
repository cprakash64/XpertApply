# EXT-LIVE-04 native Chrome runbook (pre-publication)

Candidate ZIP: `/Users/cprakash/Developer/XpertApply-builds/xpertapply-extension-0.3.1-44c107e.zip`
SHA-256: `9dec55f058ecaf7c2b45176c8c7dbba24f7f4915691e926170f6592c21255b3a`
Production ID: `gnibjomjfdobadlockphjiibbpmiehcj`. Full checklist: `EXT-LIVE-01_ACCEPTANCE_CHECKLIST.md`.
Nothing in this runbook has been run by the engineer. Mark each result yourself; none is pre-filled.

## 1. Make the production-ID unpacked folder
1. In the Chrome Web Store Developer Dashboard open the item > Package > View public key. Copy it (public key only).
2. Run:
   ```bash
   /Users/cprakash/Developer/XpertApply-builds/make-store-id-build.sh
   ```
3. It must end with: `manifest identical except key: true`, `derived extension id: gnibjomjfdobadlockphjiibbpmiehcj (matches production)`,
   `version: 0.3.1`, then the folder path. It refuses (and builds nothing) on a wrong key or checksum. It never prints the key.
4. Load unpacked folder: `/Users/cprakash/Developer/XpertApply-builds/xpertapply-0.3.1-44c107e-store-id-work/dist-store-id`
   (never upload it; do not commit it).

## 2. Fresh profile
Use a new Chrome profile with no other extensions. If the real Store 0.3.0 is installed in the same profile, remove it first:
two copies of one ID cannot coexist. `chrome://extensions` > Developer mode > Load unpacked > the folder above. Confirm the card shows
ID `gnibjomjfdobadlockphjiibbpmiehcj` and version 0.3.1.

## 3. Priority order (checklist section in brackets)
1. **One-time ATS permissions** [B3-B5, C]: the Enable-sites page opens once. Click Enable once; Chrome shows ONE dialog naming the
   four ATS domains, never "all websites". Accept; each group shows Allowed.
2. **No repeat prompts on the same ATS** [B5, C2, G1]: open a second company on the same ATS; wait over a minute (worker idle); repeat. No new
   dialog or badge. Then deny/revoke one group and confirm it is not re-requested by itself [C1, C4, C5].
3. **Automatic assistant** [D1, D4, D6]: opening an application page shows the in-page assistant without clicking; a listing page shows none.
4. **SPA and late forms** [D2, D3, D5]: route change into an application, a slow-rendering form, and a form that never appears (expect the
   "hasn't found the application form" notice with Try again).
5. **Accurate autofill** [E1-E7]: Greenhouse, Lever, Ashby with disposable data; stop before Submit. Manual edits survive, demographic fields
   stay untouched, nothing invented. Workday is limited.
6. **Production login and account switching** [F1-F3]: sign in as user A, fill, sign out, sign in as user B; B must never see A's data.
   Use only a disposable production account; this is the one place the real backend is touched.

## 4. Evidence
For each row record PASS / FAIL, Chrome version, date and a screenshot. Any dialog naming all websites, a repeat prompt after a denial,
an overwritten manual edit, a demographic fill, or a submission is a blocker. Post-publication Store upgrade tests (section A) wait until
the Store has actually delivered 0.3.1.

## 5. Known test-infrastructure notes (not product behaviour)
- The Playwright connect specs fail when the machine is saturated and pass otherwise; see the EXT-LIVE-04 report. Run them serially on an idle host.
