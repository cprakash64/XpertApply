# EXT-LIVE-01 — Seamless autofill and auto-open reliability (extension 0.3.1)

Status: implemented locally on `feature/ext-live-01` (child of `release/ext-final-01` dcfc59e). Not pushed,
not published. Extension ID `gnibjomjfdobadlockphjiibbpmiehcj` is unchanged.

## Problem (published 0.3.0, build 8665fbe)

1. Repeated permission requests. 0.3.0 asks Chrome for one *exact hostname* at a time
   (`originPatternFor`), and registers one content script per exact hostname. Greenhouse alone is
   `boards.greenhouse.io`, `job-boards.greenhouse.io`, `boards.eu.greenhouse.io`, embedded frames; Workday is
   one host per tenant. Each new company or host is a new prompt.
2. The unprompted "wants access" request was de-duplicated in an in-memory `Set` in the MV3 service worker.
   The worker is suspended after ~30 s idle, so the set was forgotten and the request was raised again. A
   declined or revoked origin was not remembered at all.
3. Inconsistent appearance. No script exists on an origin until it is granted, so before a grant nothing can
   appear. After a grant the form watcher counted every debounced DOM mutation as one of twelve looks; a busy
   SPA spent them in about 30 s, before the form rendered, and it never looked again. A same-document route
   change did not re-arm it. When it gave up, the page stayed silent.

## Decisions

- Install-time permissions are unchanged (`activeTab, identity, sidePanel, storage, scripting, tabs`; hosts only
  for xpertapply.com / api.xpertapply.com; `optional_host_permissions: https://*/*`). The new behaviour needs no
  manifest permission, so Chrome shows no additional warning on update. `options_ui` (a page) is the only
  manifest addition.
- Supported ATS (Greenhouse, Lever, Ashby, Workday-limited) are requested as one group pattern each
  (`https://*.<suffix>/*`) in ONE `permissions.request` from an extension page click (first-run onboarding /
  Options). The same group pattern is used when a person grants from the toolbar, the side panel or the in-page
  Allow button on an ATS host, so granting once covers the next company.
- Custom employer domains stay exact-host and user-initiated. No `https://*/*` request exists anywhere.
- Only the four allow-listed group wildcards are ever registered as content scripts; any other wildcard Chrome
  reports is ignored. An exact grant covered by a group grant is not registered twice.
- Declined/revoked patterns are remembered (`storage.local`, patterns + timestamp only) and never re-requested
  passively; "offered" markers moved to `storage.session` so they survive worker suspension.
- Automatic appearance remains the in-page overlay. `sidePanel.open()` is not called without a gesture.
- Form watch: a look is spent only when the page plausibly has a form (>=3 visible controls or a file input);
  20 looks / 5 min per navigation; Navigation API / popstate / hashchange restore the budget; budget exhaustion
  on a supported application URL opens the assistant with an actionable "Try again" notice
  (`DIRECT_FORM_NOT_FOUND`) through a new payload-free worker message the worker validates from Chrome's
  sender record (top frame, granted origin, supported application URL, no live workflow, per-site switch).
- Autofill engine is NOT changed in this release. No evidence of an engine defect was found that is separable
  from the permission/detection defects above; the existing adapters keep their qualification.

## Files

`src/siteGrants.ts`, `src/siteAccessStore.ts`, `src/content/formWatch.ts`, `src/ui/access.{html,ts}`;
changed: `siteRegistration.ts`, `permissionFlow.ts`, `toolbarOverlay.ts`, `background.ts`, `messages.ts`,
`content/bootstrap.ts`, `ui/{sidepanel,assistant,applicationAssistant}.ts`, `content/applicationOverlayAssistant.ts`,
`manifest.json`, `build.mjs`, `e2e/build-granted.mjs`, `e2e/ext-live-01.spec.ts`.

## Validation

`npm run typecheck`, `npm run build`, `npm run build:e2e`, `npx vitest run` (108 files), `npx playwright test`
(real Chromium 149, unpacked extension, owned loopback employer + API). See the release report for results and
for what could not be exercised (Chrome's native consent dialog, a Store-installed profile, real employer sites).

## Rollout

1. Operator uploads `xpertapply-extension-0.3.1.zip` as a new Store version (same item). Review is required.
2. Existing users update silently: no new permission warning, existing exact grants keep working.
3. Existing users are offered the group grant at their next supported application page (toolbar badge ->
   one Chrome prompt) or from Options; new users see the onboarding page once.

## Rollback

Re-upload the 0.3.0 ZIP (hash 18b98e1c…f279d) as 0.3.2+ (the Store never lowers a version number); or use the
Store's staged rollout / "pause" before widening. Stored keys added by 0.3.1 (`xaSiteAccessSuppressed`,
`xaAtsOnboarding`, session `xaSiteAccessOffered`) are ignored by 0.3.0.
