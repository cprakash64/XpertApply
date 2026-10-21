# CWS 0.3.0 pre-publication verification and disclosure closure

Status: implemented locally on `verify/cws-prepub` (from `origin/release/chrome-web-store` 890892d). Nothing pushed,
published, deployed or entered in the Developer Dashboard.

## Why

The 0.3.0 public wording (privacy policy, store listing, Dashboard worksheet) made claims about the toolbar
(`activeTab`) path and the in-page assistant that had been written from source, not measured. This work measured
them, closed the two product gaps the measurements exposed, and corrected the drafts.

## Findings that changed the product

1. **Page could read text typed into the assistant (defect, fixed).** The assistant renders in the employer
   page's document. A page script with capture-phase listeners on `window`/`document` recorded every `keydown`,
   `keyup`, `keypress`, `beforeinput`, `input` and `paste` (including `InputEvent.data` and `clipboardData`) from all
   five name-confirmation inputs, even inside the closed shadow root. `change` and the final `value` were not
   exposed. `e2e/cws-hostile-keystrokes.spec.ts` failed on 0.3.0 and passes after the fix.
2. **The toolbar path read the page before any in-product notice (gap, fixed).** `showToolbarOverlay` injected
   `content.js` (adapter detection, form discovery, up to 20k chars of body text for submission observation)
   immediately on click.

## Architecture

- **Private text entry.** Free-text and name-confirmation inputs are rendered in an extension-origin iframe
  (`ui/fieldentry.html`), declared in `web_accessible_resources` (`https://*/*`, `use_dynamic_url`). The iframe asks
  the worker for its configuration by an unguessable entry id (`FIELD_ENTRY_CONFIG`), and submits over runtime
  messaging (`FIELD_ENTRY_SUBMIT`); the worker validates sender id, page path, non-top frame and tab, then delivers to
  the top frame (`FIELD_ENTRY_DELIVER`). No `postMessage`, so the page's `message` listeners see nothing. Entry
  configs live in `chrome.storage.session` (survives worker suspension, cleared with the browser session). If the
  iframe cannot be created the widget says so; it never falls back to an in-page input.
- **Toolbar first-use disclosure.** `showToolbarOverlay` injects only `overlayBootstrap.js`. If
  `toolbarDisclosureAcceptedVersion` (a bare number) is below `TOOLBAR_DISCLOSURE_VERSION`, it shows a static notice
  (closed shadow root, Continue/Cancel, trusted clicks only). Continue records the version and then
  `continueToolbarOverlay` injects `content.js`. Cancel removes the notice and persists nothing. `bootstrap.ts` also
  re-checks the marker before `checkHandoffAndStart` on a toolbar-initiated document. Bumping the constant re-prompts.
- **e2e hook.** Playwright cannot press the toolbar button. `src/e2eToolbarHook.ts` is injected by esbuild for
  `--profile e2e` only and exposes `showToolbarOverlay`; the production package is tested to not contain it.

## Decisions

- Isolation uses a web-accessible iframe rather than the side panel or assistant window because neither has a
  user-reachable trigger in 0.3.0 (see below). The earlier invariant "no web_accessible_resources" was deliberately
  relaxed to exactly this one page; `site_access.test.ts` now pins the exact entry.
- Buttons, checkboxes, radios and selects stay in the page document. A page can observe interaction with them;
  public wording says so.
- No claim that the assistant is undetectable: the page can see an extension element and one extension frame.

## Surfaces (0.3.0)

| Surface | Trigger | Reachable |
| --- | --- | --- |
| In-page assistant | toolbar click (`action.onClicked`) or a prepared launch | yes |
| Assistant window (`chrome.windows` popup) | none: `openOrFocusAssistant`/`createAssistant` have no caller | no |
| Side panel | `openPanelOnActionClick:false`, no `sidePanel.open` call | only through Chrome's own UI, unverified |
| Action popup | `default_popup` absent | does not exist |

## Validation

Run from `apps/extension`: `npm run verify` (typecheck, production build, e2e build, vitest) and
`npx playwright test --retries=0 --workers=1`. New specs: `cws-toolbar-network`, `cws-toolbar-disclosure`,
`cws-hostile-keystrokes`, `cws-private-entry`, `cws-activetab-boundary`; new unit test `cws_store_package`.

Not automatable: Chrome's real `activeTab` grant and its expiry on navigation require a physical toolbar click.
Manual check before submission: click the icon on an https page, accept, confirm the assistant works, navigate the
tab to another site, confirm the assistant cannot be used without clicking again.

## Rollout

Ship with 0.3.0 (the manifest version is unchanged and unpublished). Public wording changes only after the privacy
policy page is deployed; deployment is a separate, explicit step.

## Rollback

Revert the branch. The storage keys `toolbarDisclosureAcceptedVersion` (local) and `fieldEntriesV1` (session) are
inert to older builds. No migrations, no API changes.

## XA-P1 addendum: website -> extension -> employer launch

Manual Chrome testing of 3907f74 found three launch-blocking faults.

1. **Site said "Install extension" with the extension installed.** The deployed site detects the extension
   with `JOBPILOT_PING` -> `JOBPILOT_PONG` (production `/jobs` chunk `b09f79efdb49d89d`). The extension stopped
   answering both in `1fd837c` and only answers `XPERTAPPLY_EXTENSION_PRESENCE_PING`, which the deployed site
   does not send. Local web code already uses the new message, so this is version skew: web not redeployed.
   Fix: the bridge answers the legacy ping with capability metadata only; a page-supplied `apiBase` is never read.
2. **No way to grant an employer origin.** The in-page assistant called `chrome.permissions.request` from a
   content script (Chrome does not expose it there) and its comment pointed at a "Side Panel grant path"
   that nothing opened. `handleLaunchRequest` likewise relied on a side panel "opened by this same user gesture".
   Fix: the launch (from the real Apply click) and the in-page Allow button open the side panel, falling back to the
   extension window, whose own button calls `chrome.permissions.request` for exactly that origin. Also fixed the
   Allow button staying `hidden` after the panel's first "unavailable" render.
3. **No automatic activation.** The assistant only mounted on a toolbar click. After a launch is matched, probed and
   its package loaded for the top frame, the worker now mounts it once per document; a dismissed or open assistant
   is left alone.

Also: `HANDOFF_NOT_FOUND` no longer tells the user to refresh (refreshing cannot help); it says to start from XpertApply.

Deployment: nothing on the web or API must change for these fixes. They ship in the extension build. Redeploying
the current web code is optional and works with both extension handshakes.

Not verifiable by automation: Chrome's native Allow/Deny prompt and a live job-boards.greenhouse.io page.
