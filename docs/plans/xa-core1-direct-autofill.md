# XA-CORE1 — Independent (direct) application autofill

Status: implemented on `feature/xa-core1-direct-autofill`, branched from `5b7367f`
(`verify/cws-prepub`, the line that contains the user's latest build; the local
`release/chrome-web-store` checkout at `e1affbf` does not contain 1349a8d / 6b0bad5 / 5b7367f).
Not pushed, not deployed.

## Root cause

The text "This page doesn't match the prepared application. Open it from XpertApply." is
`FAILURE_MESSAGE.HANDOFF_URL_MISMATCH` (content/bootstrap.ts, ui/applicationAssistant.ts), produced by the
worker's `handleContentReady` (background.ts). With no tab binding, that function fell back to the single
global website launch (`getActive()`). A page was accepted only if `senderCanBindTab` →
`urlsMatchForHandoff(active.applicationUrl, pageUrl)` held. For `careers.withwaymo.com` a stale launch for a
different URL (or none) was always the answer, so:

* stale launch present → `HANDOFF_URL_MISMATCH` (the message the user saw);
* no launch → `HANDOFF_NOT_FOUND`, and the old "direct visit" overlay only said "Application recognized — open it
  from XpertApply" and filled nothing (`maybeShowDirectVisitAssistant`).

There was no way for the extension to create its own application session: it held only session-scoped tokens that the
website mints. The fix is architectural, not a relaxed URL match.

## Architecture

1. **Extension sign-in** (`src/auth/extensionAuth.ts`, backend `routes/extension.py`): OAuth authorization code +
   PKCE through `chrome.identity.launchWebAuthFlow` against `/extension/connect` (web). The code is single-use and bound
   to the PKCE challenge and to an `https://<id>.chromiumapp.org/` redirect. The extension holds a 30-minute access
   token (typ `ext`, no `sub`, so it is not a website token and is rejected by every general route) and a rotating
   refresh credential. Replay of a rotated refresh token revokes the whole family; revoke ends access immediately.
2. **Credential storage**: IndexedDB in the extension origin, not `chrome.storage.local` (Chrome exposes
   `storage.local` to content scripts by default). Persists across restarts; unreachable from content scripts.
3. **Direct draft** (`POST /extension/direct-sessions`): derived from the extension token; creates a private, inactive
   `job_postings` row (`external_id = direct:<user>:<hash(origin+path)>`) and reuses the existing
   `create_application_session`, then voids the launch token and returns a session-scoped token — the same scoped
   token shape the website handoff uses, so every downstream route is unchanged. Query strings are never sent or stored.
4. **Single resolver** (`handleContentReady` → `bindDirectApplication`): a website launch claims a page only when the
   page *is* the prepared application, or is the launch's own tab still inside the workflow origin graph. Anything else
   resolves directly: top frame, non-XpertApply origin, not switched off, Chrome says the grant exists, a counts-and-labels
   probe says "real application" (`judgeApplicationEvidence`), extension signed in. The binding is tab-bound,
   owner-bound (`directUserId`), tokenless, and **never promoted to the global active handoff**.
5. **Late forms**: the content script watches a not-yet-eligible granted page with one bounded `MutationObserver`
   (2.5 s gap, 12 looks, 3 min, reset only by a URL change).
6. **Signed-out / unavailable**: the worker records a notice view and opens the one canonical overlay, whose single
   button becomes "Connect XpertApply" / "Try again".

## Decisions

* Eligibility needs a confident application root, ≥2 identity labels and ≥1 application-only label. Newsletter, login,
  search, account settings and description pages fail by construction.
* Automatic fill after connecting is the default; the per-site off switch (`xaAutoOpenDisabledOrigins`) and the global
  `xaDirectAutofillEnabled=false` stop it.
* Company/title for a direct draft are the host name and "Job application" — nothing page-supplied is presented as verified.
* Embedded cross-origin application frames are supported for website launches (unchanged) but **not** newly for direct
  drafts: the top frame must itself contain the form. Reported as unsupported below.

## Security review notes

* Found by the real-browser test, fixed: `putPending` promoted any first pending to the global ACTIVE handoff, which
  made a direct draft claimable by another tab and another account. Direct drafts are now excluded (state.ts), covered by
  E2E `G3`.
* The page contributes no identity: URL/frame/tab come from Chrome's sender; account from the credential; no session id
  or user id is accepted from a page or message.
* New permission: `identity`. Disclosure and privacy-policy wording must mention sign-in through Chrome's identity API
  and that granted employer pages are probed locally (labels and counts, never sent) before a draft is created.

## Validation

See the final report; logs are under `docs/plans/evidence/`.

## Rollout

Backend first (migration `0035_extension_auth`, additive tables + new routes), then web (`/extension/connect`), then the
extension build. Old extensions keep working (website launches unchanged).

## Rollback

Extension: ship the previous build. Backend: `alembic downgrade 0034_external_identities` drops the two new tables;
routes are additive. Web: the connect page is standalone.
