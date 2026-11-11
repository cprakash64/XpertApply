# EXT-LIVE-11 — Zero-extra-click launch, persistent Workable access, document handoff

Baseline EXT-LIVE-10 `fca77e1` (candidate source `7803558`). Branch `feature/ext-live-01`. Not pushed, published or deployed.
Extension ID unchanged. **No new manifest permission** (`optional_host_permissions` already `https://*/*`; the new Workable grant is a
runtime request for ONE exact host, `https://apply.workable.com/*`). Consent impact: the single first-run Chrome dialog goes from 4 to 5 domains.

## Evidence limits
The live Multi Media LLC application and the operator's screenshots were not available to this work. Workable's markup was read-only inspected on a
public posting (no input, no submit): `form[data-ui="application-form"]` rendered client-side; `input#firstname|lastname|email` (data-ui, name,
`aria-labelledby` labels with a leading "*"); `input#input_phone[name=phone][type=tel][autocomplete=tel]` beside a country button; a resume dropzone
whose real `input[type=file][data-ui=resume]` (accept `.pdf,.doc,.docx,.odt,.rtf`, tabindex -1) sits behind a "Choose file" label; submit
`button[data-ui=apply-button]`. Everything below that is derived from the code path, not from the live page. **Workable is "limited" support until a
real authorised application has been filled on the live site.**

## Root causes (code-evidenced)
1. **Did not auto-open.** Workable was not in `PROVIDERS` or `SITE_GROUPS`. At the website's Apply click the worker only asks Chrome for the employer
   origin when `providerForUrl` knows the host (`requestAtsOriginInGesture`); for any other host it asked nothing in the gesture, nothing was granted, no
   content script was registered or injected, and so no assistant and no autofill. The only way left was the toolbar icon.
2. **Toolbar flow shows a disclosure and a temporary grant.** The toolbar path runs under `activeTab` (temporary), read-only discovery until "Fill
   application".
3. **"Access was removed" right after consenting.** The worker's gate (`handleContentReady`) accepts only a PERSISTENT grant
   (`permissions.contains`); `activeTab` is invisible to it. A content script running under activeTab therefore failed the gate and
   `settleReadyRefusal("HOST_PERMISSION_MISSING")` wrote `site_access_revoked` ("Access was removed") for a grant that was never removed.
4. **Documents "Preparing" then not there.** The engine uploads documents only after the page is bound and read under a persistent grant; in the
   toolbar/activeTab flow the package was never fetched for the page, and when a run finished with a document neither uploaded nor handed back the row
   fell through to a bare "—" / stale "Preparing".
5. **Empty email.** The backend deliberately withholds an application email that is a fixture/reserved-domain address or unconfirmed
   (`profile/emails.py`, `answer_vault_service._redact_dev_fixture_identities`): the answer is dropped and an unresolved question
   (`replace_demo_email`) with a reason is returned. The extension then (correctly) writes nothing and lists the item for review with that reason;
   Workable's own validation shows "Invalid" for the blank required field. This is the most likely cause for "36 verified, 2 to review, email empty",
   but the person's account data was not inspected, so it is **not confirmed**. A fixture with the same markup and a usable email fills the email.

## Changes
- `ats/providers.ts`, `siteGrants.ts`, `ats/workable.ts`, `ats/registry.ts`, `ui/access.html`: Workable provider, exact-host group grant (limited), adapter.
- `toolbarOverlay.requestLaunchOriginInGesture` + `background.handleLaunchRequest`: the Apply click asks Chrome for exactly the launch origin
  (group grant for known ATSs, exact host for others, never a wildcard, never plain http, never an unsupported provider). Outcome is kept apart:
  granted -> resume the pending launch; **denied -> recorded and respected (`suppress(..., "declined")`, no second prompt)**; no gesture -> the
  existing permission surface.
- `settleReadyRefusal` / `recordSiteAccess`: "revoked" only when Chrome reported a removal; a page with only temporary access is "permission
  required"; a refusal stays "declined".
- Statuses: `not_applicable` ("No upload field on this form") vs `unavailable` ("Not generated yet") vs `review` ("Attach manually") once a run has finished.
- `autofill.verifyUpload`: on Workable an input that holds the file while the form shows no file name is NOT reported uploaded.

## Launch intent (unchanged design, evidenced)
The website Apply click already stages a durable, single-use launch (token exchange `application-sessions/token` is single use), bound to account
(`webAuthenticatedUserId`, session token), job (`sessionId`/`jobId`/official URL identity), tab (`targetTabId`) and origin graph, expiring after 15
minutes (`LAUNCH_TTL_MS`), ended by sign-out/account change (`SESSION_END`), invalid after permission removal (`SESSION_DETACH`), and gated by the
worker-owned run authorization of EXT-LIVE-09. No new endpoint or message was needed; a page-controlled query parameter or DOM attribute is never read.

## Validation
See `docs/release/EXT-LIVE-11_CANDIDATE.md`.

## Rollout / rollback
Rollout: the candidate ZIP only; first-run dialog now includes Workable. Rollback: remove the `workable` group from `SITE_GROUPS` and the provider entry
(one commit); re-upload 0.3.0 under a higher version number. State added: a `declined` suppression record per refused origin (already existing store).
