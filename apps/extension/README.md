# XpertApply — Assisted Apply (browser extension)

A Manifest V3 Chrome/Chromium extension that autofills employer application
forms with your **verified** XpertApply data, uploads your **tailored** resume and
cover letter, flags anything that needs your review, and **never submits** —
you always do the final review and click Submit yourself.

## What it does

1. Detects the XpertApply web app (version + capability handshake).
2. When you click **Open and autofill application**, a content script on the
   XpertApply origin catches that exact click in the **capture phase** and forwards
   a launch request to the background **synchronously within the user gesture**.
   The background opens the side panel (gesture-valid), then creates the employer
   tab itself (`chrome.tabs.create` — no website popup, exact tab id) and binds a
   `PendingLaunch` to that tab id in `chrome.storage.session`. The one-time launch
   token is staged into the extension's isolated content world, never the DOM/URL.
3. The employer content script announces readiness (`CONTENT_READY`); the
   background exchanges the single-use token **once**, caches the session package
   per tab (so refresh/retry never re-consumes the token), and hands the content
   script the verified answers.
4. Autofill starts **automatically** — no “Fill application” click needed. It
   detects the ATS, fills confidently-known fields, uploads the tailored documents
   into the correct inputs (verifying the employer UI accepted them), and
   highlights unresolved/sensitive items for you to answer.
5. It reports a **PII-free** summary (counts + reason codes only) back to XpertApply.

The launch flows through one canonical state machine
(`idle → preparing → package_ready → opening_tab → waiting_for_tab →
waiting_for_content_script → fetching_package → detecting_ats → discovering_fields
→ filling → completed / completed_with_review / failed`). The side panel is a pure
**observer** of the tab-scoped state in `chrome.storage.session`; both the
automatic launch and the manual **Fill application** retry call the same runner
(`startAutofillForTab` → content `runAutofill`).

Nothing is ever submitted automatically. Sensitive/voluntary questions
(demographics, veteran/disability status, legal attestations, salary, criminal
history, etc.) are **never** guessed — they are left for you.

## Security and privacy model

- The production bridge is available only on `https://xpertapply.com` and
  `https://www.xpertapply.com`. Those first-party origins and
  `https://api.xpertapply.com` are the extension's only required host access.
- Employer/ATS HTTPS access is **optional**, not install-time access to every
  site. Chrome may persist an exact-origin grant after the user approves it, but
  the extension treats that grant as capability, not current workflow authority.
  It injects only into an origin tied to the active application, and every frame
  must independently pass the browser-supplied origin and workflow checks before
  it can receive application data or touch the DOM.
- Launch metadata, tab-scoped progress, verified answers, document metadata, and
  the session token live in `chrome.storage.session` (with service-worker memory
  for transient coordination). Supported production Chrome does not persist that
  workflow package across a browser or extension-runtime restart.
- `chrome.storage.local` is limited to extension configuration and minimal runtime
  coordination metadata; candidate profile fields, form answers, document
  contents, and session tokens are not written there. Logs use low-cardinality
  state and reason codes rather than candidate data.
- The session token is scoped to one assisted-apply session and is not the user's
  XpertApply login token. It and the full session package remain inside the
  extension's isolated world. The employer page sees only the values and files
  the extension intentionally places into its native form controls, just as it
  can see values typed or selected by the user; it does not receive the token or
  the package itself.
- XpertApply never infers or automatically affirms consents, certifications, or
  legal attestations. Work-authorization and sponsorship questions may be filled
  only from an explicit saved answer when the question's jurisdiction and
  yes/no polarity are proven; ambiguous cases remain for manual review.
- XpertApply never clicks Submit. It may observe the user's submit gesture and
  report a PII-free result summary, but the user reviews and submits the
  application.
- Extension bookkeeping stays in private JavaScript state. The employer page can
  observe native form events and values written into its own controls, plus the
  visible XpertApply widget host, but not the extension's internal field ledger.
- Logout and account replacement invalidate in-flight authority, purge workflow
  storage and in-memory caches, and clear extension-owned state in open employer
  tabs on a best-effort basis.

## Supported ATS

Ashby (e.g. Temporal), Greenhouse, Lever, and a generic semantic-form adapter.
Workday is detected but flagged **limited** (standard fields only).

## Build

```bash
cd apps/extension
npm install       # first time only
npm run build     # outputs the loadable extension to apps/extension/dist
```

Other scripts: `npm run typecheck`, `npm test`.

## Install (load unpacked) and verify

1. Run `npm run build` (above). The loadable extension is in **`apps/extension/dist`**.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the **`apps/extension/dist`** directory.
6. Refresh XpertApply (`http://localhost:3000`).
7. Open a job and start an assisted application. The modal should now show
   **“XpertApply extension connected.”**
8. Click **Open and autofill application**.
9. The extension opens the employer tab **and** the side panel. Autofill runs
   **automatically** (you should NOT need to click “Fill application”). The panel
   shows the ATS, stage, and non-zero Filled/Review counts as it works.
10. Refresh the employer page — the extension recovers the pending session and
    continues without duplicating already-filled values or overwriting your edits.
11. Review everything and **submit the application yourself** — XpertApply never submits.

> After any code change you must **rebuild AND reload**: run `npm run build`, then
> click the ↻ reload icon on the extension card in `chrome://extensions`. A rebuild
> alone does not reload the running service worker.

### Configuring a development build

Edit `src/config.ts`:

- `DEFAULT_API_BASE` — the XpertApply API base (or set `apiBase` in extension
  storage at runtime, no rebuild needed).
- `JOBPILOT_WEB_ORIGINS` — the internal allowlist of first-party origins allowed
  to hand a launch token to the extension.

Keep `manifest.json` `content_scripts.matches`, required `host_permissions`, and
`externally_connectable.matches` aligned with that first-party allowlist, then
rebuild. Employer origins belong in `optional_host_permissions`; runtime code
requests only the exact workflow origin from a user gesture.

## Notes / limitations

- File uploads use the browser `DataTransfer` API; a small number of ATSes block
  programmatic file assignment. In that case the extension reports the failure
  rather than claiming success — attach the document manually.
- Multi-step forms: the extension re-scans on DOM/route changes but never clicks
  a control that could submit or advance past a legal attestation.
