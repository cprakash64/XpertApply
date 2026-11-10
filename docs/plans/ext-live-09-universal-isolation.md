# EXT-LIVE-09 — universal workflow isolation and trust hardening

## 1. Custom-site / smaller-ATS matching defect (release blocking, reproduced)
EXT-LIVE-08 made hosted-ATS pages (Greenhouse, Lever, Ashby, Workday) identity-based, but `urlsMatchForHandoff` still ended in `pathsCorrespond`:
two URLs on one site matched when their paths shared ANY non-generic word of 4+ letters. Reproduced BEFORE the fix in real Chromium
(`e2e/custom-site-isolation.spec.ts`, run against the EXT-LIVE-08 source): on Tesla-style (`/careers/search/job/apply/<id>`), a custom employer
(`/jobs/senior-backend-engineer` vs `/jobs/senior-backend-engineer-payments`) and SmartRecruiters (`/Acme/<id>-data-engineer`), a second job opened
by hand in a new tab or window, or navigated to in the same tab, was bound to job X's session and filled with job X's data (6/6 specs failed).

Callers of the matcher (all fixed by changing the function, not the callers): `background.ts` opener-tab join (L511), unbound-tab auto-bind
(L779), launch/frame diagnostics, `directApplication.ts` draft re-check, and three decisions in `security/senderTrust.ts`.

## Replacement rule (src/url.ts)
Same site AND positive evidence: identical canonical path (an `/apply` or `/application` suffix aside); OR both URLs name posting ids
(long numeric ids, UUIDs, long hex ids, requisition codes) and share one; OR neither names an id and one path is the other plus ONLY
application-continuation segments (apply, step-N, form, review...). Different ids, a shared prefix, a shared title word, a department listing
versus a job, or a board root versus a job are all "not the same". Hosted-ATS families keep their stricter per-ATS identity (08). Unit tests:
`src/__tests__/universal_identity.test.ts` (5 unsafe pairs matched before; 0 after).
Legitimate posting -> apply transitions keep working by (a) a shared posting id (Tesla), (b) the `/apply` continuation, and (c) the launch's OWN
tab following its workflow (tab evidence + origin graph), which never depended on this function.

## 2. Page-storage trust boundary (findings)
| Value | Where | Authority? |
|---|---|---|
| step signatures, counters, `advancedFrom`, pause flag, timestamps | page `sessionStorage` `xpertapply.workflow.v1` | progress metadata only (page can read/edit it) |
| runId, tab id, origin, session id, account key, posting identity | WORKER `chrome.storage.session` `workflowRunAuthV1` | AUTHORITATIVE; storage.session keeps its default trusted-contexts-only access (no `setAccessLevel` anywhere), so neither the page nor a content script can read/write it |
| permission to click Next / continue a run | worker answers `WORKFLOW_CHECK` | derived from Chrome sender metadata + worker records at the moment of each action |
| permission to START | `WORKFLOW_START`, sent only from the extension's own widget on an `isTrusted` click | mints a runId bound to the SENDER tab, the prepared session and the current account; refused when the tab shows a different posting |
Before this stage a page that wrote a perfectly shaped record (right tab, origin, application, job) could make XpertApply click Next (S1), a
replayed pre-Cancel record restarted automation (S2), and a changed account kept advancing (S4). Now a stored run is acted on only while the
worker vouches for it; otherwise it is forgotten and the assistant offers "Complete application" again (never a silent restart).
Nothing here stores answers, credentials, résumé content or declarations: run records hold ids, counters and signatures.

Residual: a hostile page can still read/forge its own progress metadata (harmless: it cannot authorise anything) and can of course click its own
Next button. No new manifest permission is used: sender metadata (tab id, frame url/origin) was sufficient.

## 3. Other defects found by the adversarial tests
- A fill response already in flight when the tab moved to a different job wrote into the new job (S5): writes are now gated at the moment of
  each write (`setFillGate`), in addition to the worker-withdrawn authority.

## 4. Test-environment notes
- The 10 real-API specs need `XA_REAL_API_PYTHON`, `XA_REAL_API_DIR`, `XA_REAL_API_PG_ADMIN` (+ `XA_REAL_API_DIR_OLD` for the compatibility case). They
  were run against a DISPOSABLE local PostgreSQL 16 (initdb in /tmp) and an `apps/api` archive of the commit before drafting existed. Drafting is
  OFF by default in the API (`application_answer_drafting_enabled=false`, 503 `answer_drafting_disabled`); the specs need it on, so the test run set
  `APPLICATION_ANSWER_DRAFTING_ENABLED=true` for the local test process only. Production configuration was not touched.
