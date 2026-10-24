# XA-RC-06 A — direct application activation on a custom careers domain

Status: implemented on `feature/xa-core1-direct-autofill` after `7538103`. Not pushed, not deployed. **Release stays blocked until a real-Chrome staging retest**: Chrome's native consent dialog and the toolbar click cannot be automated.

## Root cause (code evidence plus real-Chromium checks)
On `careers.withwaymo.com` the assistant's "Allow XpertApply on …" button could be clicked forever without Chrome ever showing a consent dialog.
* The gesture-bound `chrome.permissions.request` was made by `requestAtsOriginInGesture`, which returned without asking unless the URL belonged to a **known ATS provider** (`providerForUrl`). A custom careers domain is not one, so the request was never made, for the toolbar click or for the Allow button.
* The fallback, `permissions.addHostAccessRequest`, only puts a request into Chrome's toolbar menu. The assistant said "Allow in Chrome's prompt…" and offered nothing else.
* A refusal and a lost gesture were folded into one `false`, so a user who clicked "Don't allow" saw the same wait message.

Not the cause (checked): origin normalization (exact `https://careers.withwaymo.com/*`), registration and injection after a grant (the existing granted-build specs fill this page), and the iframe case (separate specs).

Before and after an Allow, what Chrome granted: before, `permissions.contains` and `getAll` report the origin as not granted (R1, real Chromium). A request made without a user gesture is refused with a message containing "user gesture", which is what the worker now classifies on (R1 pins the real wording). After a real grant the worker re-checks with `contains` before anything resumes; **that dialog itself was not exercised**.

## Change
* `requestOriginInGesture` (toolbarOverlay.ts): the one `permissions.request` call site, for exactly one https host, with outcomes `granted | denied | no_gesture | unavailable | not_requested`.
* The assistant's Allow button now asks Chrome for the sender tab's own origin for **any** https site (`OVERLAY_OPEN_PERMISSION_SURFACE`), while the click's gesture is live. A refusal is reported as "denied" with recovery text (ask again, or Extensions menu → Allow on this site). Only a missing gesture or API falls back to Chrome's toolbar request.
* The toolbar click and prepared launches still ask only for known ATS hosts; unknown domains stay a manual path (toolbar → assistant → Allow), with no passive request and nothing read before consent.
* Found by the new real-Chromium spec and fixed: the per-site "don't open automatically" switch did not stop an existing tab draft from resuming on reload. A switched-off origin now drops the draft.
* After a grant: `permissions.onAdded` reconciles the registered script, injects into open tabs and resumes the waiting view (unchanged); later visits open the assistant by themselves unless switched off.

## Tests
`xa_rc06_origin_request.test.ts` (unit), `e2e/xa-rc06-activation.spec.ts` R1–R3. Existing specs cover Greenhouse/Lever/Ashby direct entry, reloads, SPA navigation, service-worker restart, embedded frames, website launches, disconnect/revocation and the no-submit and no-production-call checks (`xa-direct-entry`, `xa-core1-direct`, `embedded-application-frame`, `zz-3c2-frame-discovery`, `cws-*`, `xa-ashby-state`).

## Manual desktop checks still required
Toolbar click on an unknown careers site; Chrome's "Allow" dialog accepted, declined, and re-asked; revoking in `chrome://extensions` → Site access; an Ashby/Greenhouse/Lever first visit (badge then dialog).

## Rollback
Ship the previous extension build; no backend or manifest permission change.
