# EXT-LIVE-08 — P0 workflow isolation and release-gate closure

## Confirmed cross-tab root cause
`urlsMatchForHandoff` (src/url.ts) decided that two pages on one hosted-ATS family were "the same application" when their URL paths shared ANY
specific word (`pathsCorrespond`). On Lever, Ashby, Greenhouse and Workday every posting of an employer shares the employer slug / site name
(`/acme/<id>`), so a manually opened second job matched the active launch, was bound by the worker's `tabs.onUpdated` "bound application tab"
path, inherited the first job's session package (`session_scoped_reuse`) and was filled with job 1's data. Reproduced in real Chromium
(Lever fixture) before the fix; after it the same tab logs `direct_signed_out` and stays empty.

## Corrections
1. `atsJobIdentity()` — per-ATS posting identity (Lever/Ashby company+uuid, Greenhouse job id/token, Workday `/job/...` posting segment).
   Within one ATS family a pair with any identity-bearing URL matches only on equal identity; an index/board page names no job.
2. Workflow runs are bound to Chrome tab id (answered by the worker from sender metadata via `TAB_IDENTITY`), origin, session id, account
   key, run id and the posting identity. A duplicated tab copies sessionStorage but has another tab id, so it cannot inherit a run.
3. `discoverAndFill` stops (and cancels any run) when the document shows a different posting than the session was prepared for.
4. Revoking a site grant sends `SESSION_DETACH` to the affected tabs; the content script cancels its run (previously a run kept clicking Next).
5. Starting a run requires a known tab id and a known posting identity; otherwise nothing starts.

## Cold-worker failure (application-answer "cold worker")
Not a worker defect. A website-launched tab uploads the résumé and then deliberately waits for the employer form to settle
(`waitForAtsParse`: 0.9 s grace, 1.4 s quiet window after any change, 15 s cap): ~3.2 s typical, with a tail past the test's hard-coded 5 s.
Reproduced 4/20 and 4/14 before the change (bimodal: 130 ms first tab, 3.2 s second tab); the failure state was `fetching_package`/"loading your
application". The test's deadline is now the product cap plus margin with failure diagnostics; 20/20 afterwards (max 3.3 s). The tail that
exceeded 5 s was not separately explained beyond mutation-extended quiet windows, so this is recorded as a TEST synchronisation fix, not as
proof of absence of a slow tail.

## Second intermittent test (cws-toolbar-disclosure)
Setup race: the handoff was seeded after `goto`; under load the worker handled the tab's load event afterwards, found the seeded handoff
and (by design) injected the engine for a matching prepared launch. Reproduced 2/24 at 4 workers; harness now waits for tab-complete and a
settled worker turn: 72/72 under the same load.
