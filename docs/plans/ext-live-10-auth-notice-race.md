# EXT-LIVE-10 — Sign-in notice race and query-based job identity

Baseline EXT-LIVE-09 `b46cfbf` (candidate source `96cd4e2`). Branch `feature/ext-live-01`. Not pushed, published or deployed.
Extension ID unchanged. No manifest change.

## 1. The sign-in notice race

### Symptom
`xa-core1-connect` "interruptions", forged-OAuth-state step: the notice sometimes read "XpertApply isn't connected" instead of
"…couldn't be verified". Reproduced on the EXT-LIVE-08 source too (so not caused by EXT-LIVE-09).

### Flow (traced)
1. The assistant's single button after a sign-out is "Connect XpertApply" -> `OVERLAY_START_AUTOFILL` -> `startAutofillForTab`.
2. It calls `connectExtension` -> `extensionAuth.connect()`. State, redirect URI, code and token exchange are validated there;
   any failure throws `AUTH_CANCELLED | AUTH_DENIED | AUTH_REJECTED | AUTH_UNAVAILABLE` and **nothing is stored** (the credential
   is only written after a verified exchange).
3. `startAutofillForTab` returns `{ ok:false, error }`. The page shows it with `showButtonError()`, which writes plain text into
   `#errors` **in the DOM only**.
4. The tab's persisted view still holds the generic notice `DIRECT_SIGNED_OUT`. `render()` rebuilds `#errors` from the view.

### Root cause
The reason a sign-in failed lived only as a transient DOM string. Any later `render()` — and every
view write the worker makes when it re-resolves the same "not connected" application (`handleContentReady` ->
`putView(noticeView(DIRECT_SIGNED_OUT))`, triggered by a page reload, a form-watch cycle or a content-script restart) — rebuilt the
text from the generic view and erased it. Whether the verification error survived depended on whether such a render landed after
the click response. The security property (no credential stored) was never at risk; the user-facing statement was wrong.

Sanitized evidence:
- Old code, deterministic reproduction (`sign-in outcomes` test, reload after forged state):
  `Received: "This looks like a job application, but XpertApply isn’t connected…"`, expected `couldn’t be verified`.
- Timeline (MutationObserver on `#errors`, passing run): `[ms, hidden, text]` = `[1908,false,"This looks like a job application, but X…"]`
  arrives *between* two button errors, i.e. an unrelated re-render rewrites the notice at an arbitrary moment.

### Correction (smallest)
The outcome becomes tab state: `LaunchViewState.authNotice` (whitelisted `AUTH_*` codes only).
- `startAutofillForTab` clears it when a new attempt starts, records it when the attempt fails.
- `handleContentReady` carries it across a re-resolution of the same notice (it is NOT carried to a different notice, e.g. after a
  sign-out/purge, a purge, or a successful connect, which clears the tab).
- The assistant renders the persisted outcome instead of the generic text; the button error uses the identical text (no flicker).
- No credential, token or URL is stored in the notice; only the code.

### Behaviour
| Event | Notice | Stored auth |
|---|---|---|
| forged / wrong state | "couldn't be verified" (persists across re-resolution) | none |
| cancelled / closed window | "cancelled" | none |
| declined consent | "declined" | none |
| network failure | "couldn't be reached" | none |
| duplicate callback | first outcome only | none |
| retry (any new attempt) | previous reason cleared first | per outcome |
| success | notice gone (tab cleared and re-resolved) | verified credential |
| disconnect / account switch | fresh "not connected", no earlier reason | none until verified |
| worker suspended during attempt | attempt dies; fresh attempt works | none from the dead attempt |

### Not changed / observed
After **Disconnect** the page is detached (`SESSION_DETACH`); connecting again on the same document does not re-bind until the page is
reopened. Pre-existing (identical on the EXT-LIVE-09 source), outside this task; the test reopens the application like a person would.

### Second root cause (found by the repeat series, not by the first fix)
Run 24 of the first 50-run series failed at a later step (the click on "Connect XpertApply" started no sign-in). A diagnostic run showed
the button unchanged and the view untouched: the click never reached the worker. Cause: the in-page assistant reacts to every worker
`OVERLAY_VIEW_CHANGED` by calling `refresh()`, which first BLANKED the UI (context unavailable, view null -> buttons disabled, notice
cleared) and only then re-read the view. A click or a reading inside that round trip hit a disabled/blank control and was lost. The
same window also explains why a reader could catch a generic notice. Fix: `refresh(inPlace)`. A view-change event re-reads in place and keeps
what is on screen until the answer arrives; tab changes and explicit refreshes still start blank, so one tab's data is never shown for
another. After this, the 50-run series passed 50/50.

## 2. Same-page reconnect (Connect -> Disconnect -> Connect, no reload)
Root cause: Disconnect makes the worker send `SESSION_DETACH` to the page. The script keeps running but is bound to nothing; having started
once it reports `started=true, dormant=false`. After a successful sign-in `ensureContentReady` saw a live script, did not wake it, and
nothing else asked the page to resolve again, so it stayed on "No application from XpertApply is open" until reopened. The first
connection worked only because that script was still dormant.
Fix: the ping reply carries `matched`; after a successful reconnect `ensureContentReady(..., rewake=true)` sends one `AUTOFILL_START`
to a script that is live but unmatched. The normal resolution path then binds a fresh draft for the current account. Disconnect still revokes
the earlier credential server-side; a new sign-in still requires fresh consent; the old draft is purged on disconnect, so nothing of the earlier
account reappears. Regression: `same-page reconnect` (fails on the old code, passes now).

## 3. Query-based job identity
`/apply?jobId=111` vs `/apply?jobId=222` WAS already distinguished. Not distinguished (unit + real Chromium, before the change): `JobID`, `reqId`,
`req_id`, `requisitionId`, `id`, `job`, `position`, `positionId`, `postingId`, and one-character ids (`jobId=1` vs `2`), because the key list was
case-sensitive and ids under 3 characters were ignored. Correction: keys compare case/`-`/`_`-insensitively over a fixed identity list, ids of 1-64
characters. Arbitrary query parameters (utm_*, ref, source, lever-source, page, lang...) are NOT identities. A redirect that keeps or drops the id on
the same path, and same-id multistep URLs, still match. Chromium: 3 new families x 2 tests failed 6/6 before, pass after.
