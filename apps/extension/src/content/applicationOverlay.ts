import { isolateHost, isolatedTextBase } from "./hostIsolation";

/** Dormant, document-local foundation for the future in-page assistant. */
export const APPLICATION_OVERLAY_HOST_ID = "xpertapply-assistant-overlay-v1";

export type ApplicationOverlayState = "ABSENT" | "OPEN" | "MINIMIZED" | "HIDDEN";

export interface ApplicationOverlayController {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  show(): void;
  minimize(): void;
  restore(): void;
  hide(): void;
  focus(): void;
  destroy(): void;
  onDestroy(listener: () => void): () => void;
  getState(): ApplicationOverlayState;
}

interface OverlayInstance {
  controller: ApplicationOverlayController;
  disposeListeners: () => void;
}

// Separate toolbar/workflow bundles share this document-local ownership in
// their extension isolated world, including explicit dismissal state.
const overlayWorld = globalThis as typeof globalThis & {
  __xpertapplyOverlayInstancesV1__?: WeakMap<Document, OverlayInstance>;
  __xpertapplyOverlayDismissedV1__?: WeakSet<Document>;
  __xpertapplyOverlayRootsV1__?: WeakMap<Element, ShadowRoot>;
};
const instances = overlayWorld.__xpertapplyOverlayInstancesV1__ ??= new WeakMap<Document, OverlayInstance>();
const dismissedDocuments = overlayWorld.__xpertapplyOverlayDismissedV1__ ??= new WeakSet<Document>();
// The overlay's shadow root is CLOSED, so `host.shadowRoot` is null to everyone,
// including this file. A page script must not be able to read what the overlay
// shows or click its buttons (the page, and any third-party tag on it, shares the
// host's document). So hosts this world created are remembered here, in the
// extension's isolated world, which page script cannot reach.
const ownedRoots = overlayWorld.__xpertapplyOverlayRootsV1__ ??= new WeakMap<Element, ShadowRoot>();

/** The shadow root of a host this extension may have created, or null.
 * `ownedRoots` covers this world; `chrome.dom.openOrClosedShadowRoot` covers a host
 * left behind by an earlier world (extension reload) whose map entry is gone. It is
 * only ever used to recognise OUR marker before replacing a stale host. */
function ownedShadowRoot(host: HTMLElement): ShadowRoot | null {
  const known = ownedRoots.get(host);
  if (known) return known;
  try {
    const viaExtensionApi = typeof chrome !== "undefined" ? chrome.dom?.openOrClosedShadowRoot?.(host) : null;
    if (viaExtensionApi) return viaExtensionApi;
  } catch {
    // Not available in this context; fall through to the page-visible root.
  }
  return host.shadowRoot ?? null;
}
const OVERLAY_MARKER = "xpertapply-application-overlay";

export function ensureOverlay(ownerDocument: Document = document): ApplicationOverlayController {
  const current = instances.get(ownerDocument);
  if (current?.controller.host.isConnected) return current.controller;
  if (current) {
    current.disposeListeners();
    instances.delete(ownerDocument);
  }

  const priorHost = ownerDocument.getElementById(APPLICATION_OVERLAY_HOST_ID);
  if (priorHost) {
    const ownedRoot = ownedShadowRoot(priorHost)?.querySelector(`[data-overlay-root="${OVERLAY_MARKER}"]`);
    if (!ownedRoot) throw new Error("XPERTAPPLY_OVERLAY_HOST_ID_COLLISION");
    priorHost.remove();
  }

  const host = ownerDocument.createElement("div");
  host.id = APPLICATION_OVERLAY_HOST_ID;
  isolateHost(host, { zIndex: 2147483000 });
  // CLOSED on purpose, and it must stay closed: with an open root any script on the
  // employer page could read the overlay (job, company, progress) and synthesise
  // clicks on Fill / Clear / Mark complete. Tests reach it over the DevTools
  // Protocol, which can see a closed root from outside the page.
  const root = host.attachShadow({ mode: "closed" });
  ownedRoots.set(host, root);
  root.innerHTML = overlayMarkup();

  const panel = ownedElement<HTMLElement>(root, "[data-overlay-panel]");
  const pill = ownedElement<HTMLButtonElement>(root, "[data-overlay-restore]");
  const heading = ownedElement<HTMLElement>(root, "#xpertapply-overlay-heading");
  const minimizeButton = ownedElement<HTMLButtonElement>(root, "[data-overlay-minimize]");
  const closeButton = ownedElement<HTMLButtonElement>(root, "[data-overlay-close]");
  let state: ApplicationOverlayState = "HIDDEN";
  const destroyListeners = new Set<() => void>();

  const render = (): void => {
    panel.hidden = state !== "OPEN";
    pill.hidden = state !== "MINIMIZED";
    host.dataset.overlayState = state.toLowerCase();
    announceLayout();
  };
  // Field badges keep clear of the assistant, which moves inside this closed root where page observers cannot see it. The event
  // carries no data; it only says "look again".
  const announceLayout = (): void => { ownerDocument.dispatchEvent(new Event(OVERLAY_LAYOUT_EVENT)); };
  const layoutObserver = typeof ownerDocument.defaultView?.ResizeObserver === "function"
    ? new ownerDocument.defaultView.ResizeObserver(announceLayout) : null;
  layoutObserver?.observe(panel);
  layoutObserver?.observe(pill);
  const show = (): void => { state = "OPEN"; render(); };
  const minimize = (): void => {
    if (state === "ABSENT") return;
    state = "MINIMIZED";
    render();
    pill.focus({ preventScroll: true });
  };
  const restore = (): void => {
    if (state === "ABSENT") return;
    state = "OPEN";
    render();
    heading.focus({ preventScroll: true });
  };
  const hide = (): void => { if (state !== "ABSENT") { state = "HIDDEN"; render(); } };
  const focus = (): void => {
    if (state === "OPEN") heading.focus({ preventScroll: true });
    else if (state === "MINIMIZED") pill.focus({ preventScroll: true });
  };

  let destroyed = false;
  const onMinimize = (): void => minimize();
  const onRestore = (): void => restore();
  const onClose = (): void => {
    dismissedDocuments.add(ownerDocument);
    destroy();
  };
  minimizeButton.addEventListener("click", onMinimize);
  pill.addEventListener("click", onRestore);
  closeButton.addEventListener("click", onClose);
  const disposeListeners = (): void => {
    layoutObserver?.disconnect();
    minimizeButton.removeEventListener("click", onMinimize);
    pill.removeEventListener("click", onRestore);
    closeButton.removeEventListener("click", onClose);
  };
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    state = "ABSENT";
    disposeListeners();
    host.remove();
    for (const listener of destroyListeners) listener();
    destroyListeners.clear();
    if (instances.get(ownerDocument)?.controller === controller) instances.delete(ownerDocument);
  };
  const controller: ApplicationOverlayController = {
    host, root, show, minimize, restore, hide, focus, destroy,
    onDestroy(listener) {
      destroyListeners.add(listener);
      return () => { destroyListeners.delete(listener); };
    },
    getState: () => state
  };

  ownerDocument.documentElement.appendChild(host);
  render();
  instances.set(ownerDocument, { controller, disposeListeners });
  return controller;
}

export function showOverlay(ownerDocument: Document = document): ApplicationOverlayController {
  dismissedDocuments.delete(ownerDocument);
  const overlay = ensureOverlay(ownerDocument);
  overlay.show();
  return overlay;
}
/** Where the assistant panel (or its minimized pill) currently is, so page annotations never sit under or over it. */
/** Fired on the document whenever the assistant opens, minimizes, closes or changes size. */
export const OVERLAY_LAYOUT_EVENT = "xpertapply:overlay-layout";
/** Fired on the document, with `detail.count`, when field marks are withheld because no spot covers nothing on the employer form. */
export const STATUS_SUPPRESSED_EVENT = "xpertapply:status-suppressed";

export function overlayAvoidanceRect(ownerDocument: Document = document): DOMRect | null {
  const instance = instances.get(ownerDocument);
  if (!instance?.controller.host.isConnected) return null;
  const root = ownedRoots.get(instance.controller.host);
  const el = root?.querySelector<HTMLElement>("[data-overlay-panel]:not([hidden]), [data-overlay-restore]:not([hidden])");
  return el ? el.getBoundingClientRect() : null;
}

export function isOverlayDismissed(ownerDocument: Document = document): boolean {
  return dismissedDocuments.has(ownerDocument);
}
export function minimizeOverlay(ownerDocument: Document = document): void { instances.get(ownerDocument)?.controller.minimize(); }
export function restoreOverlay(ownerDocument: Document = document): void { instances.get(ownerDocument)?.controller.restore(); }
export function hideOverlay(ownerDocument: Document = document): void { instances.get(ownerDocument)?.controller.hide(); }
export function focusOverlay(ownerDocument: Document = document): void { instances.get(ownerDocument)?.controller.focus(); }
export function destroyOverlay(ownerDocument: Document = document): void { instances.get(ownerDocument)?.controller.destroy(); }
export function getOverlayState(ownerDocument: Document = document): ApplicationOverlayState {
  const overlay = instances.get(ownerDocument)?.controller;
  return overlay?.host.isConnected ? overlay.getState() : "ABSENT";
}

function ownedElement<T extends Element>(root: ShadowRoot, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing XpertApply overlay element: ${selector}`);
  return element;
}

function overlayMarkup(): string {
  return `
    <style>
      :host {
        all: initial; position: fixed; inset: 0; z-index: 2147483000;
        pointer-events: none; color: #10243a;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        font-size: 14px; line-height: 1.45; color-scheme: light;
      }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      /* Everything the host inherited from the page (see hostIsolation.ts) is discarded here. */
      [data-overlay-root] { ${isolatedTextBase({ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif', fontSize: "14px", lineHeight: "1.45", color: "#10243a" })} pointer-events: none; }
      .panel {
        position: fixed; right: 18px; bottom: 18px;
        width: min(410px, calc(100% - 28px)); max-width: 420px;
        max-height: min(760px, calc(100vh - 36px)); max-height: min(760px, calc(100dvh - 36px));
        overflow: hidden; pointer-events: auto; color: #10243a;
        background: #f9fbfc; background: rgba(250, 252, 253, 0.84);
        border: 1px solid rgba(255,255,255,.72); border-radius: 24px;
        box-shadow: 0 18px 50px rgba(15,23,42,.14), 0 4px 14px rgba(15,23,42,.07), inset 0 0 0 1px rgba(15,35,50,.06);
        -webkit-backdrop-filter: blur(22px) saturate(145%);
        backdrop-filter: blur(22px) saturate(145%);
      }
      .header { min-height: 62px; display: flex; align-items: flex-start; gap: 12px; padding: 12px 12px 12px 18px; border-bottom: 1px solid rgba(15, 35, 50, 0.07); }
      .identity { min-width: 0; flex: 1; }
      .brand { margin: 0; font-size: 15px; line-height: 20px; font-weight: 680; letter-spacing: -0.01em; }
      .context { margin: 2px 0 0; color: #667687; font-size: 12px; line-height: 16px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
      .controls { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
      button { appearance: none; border: 0; margin: 0; font: inherit; color: inherit; cursor: pointer; }
      .icon-button { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 999px; background: rgba(255,255,255,.38); }
      .icon-button:hover { background: rgba(16, 36, 58, 0.06); }
      .icon { position: relative; width: 14px; height: 14px; display: block; }
      .minimize-icon::after { content: ""; position: absolute; left: 2px; right: 2px; bottom: 3px; height: 1.5px; border-radius: 2px; background: currentColor; }
      .close-icon::before, .close-icon::after { content: ""; position: absolute; left: 6px; top: 1px; width: 1.5px; height: 12px; border-radius: 2px; background: currentColor; }
      .close-icon::before { transform: rotate(45deg); }
      .close-icon::after { transform: rotate(-45deg); }
      .body { max-height: calc(100vh - 98px); max-height: calc(100dvh - 98px); padding: 18px 20px 20px; overflow: auto; overflow-wrap: anywhere; }
      .assistant-main { display: grid; gap: 14px; min-width: 0; }
      .card { min-width: 0; padding: 14px 16px; border: 1px solid rgba(15, 35, 50, 0.08); border-radius: 16px; background: rgba(255, 255, 255, 0.72); }
      .status { display: flex; align-items: flex-start; gap: 9px; margin: 0; color: #0f4a63; font-size: 14px; line-height: 1.35; font-weight: 680; }
      .status-dot { width: 8px; height: 8px; margin-top: 5px; flex: 0 0 auto; border-radius: 50%; background: #1da8c7; }
      .summary { margin: 8px 0 0 17px; color: #44566a; font-size: 13px; line-height: 1.5; }
      .section-title { margin: 0 0 8px; color: #667687; font-size: 11px; line-height: 1.3; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
      .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; min-width: 0; padding: 3px 0; }
      .row > :first-child { flex: 0 0 auto; }
      .row > :last-child { min-width: 0; text-align: right; }
      .muted { color: #667687; }
      .badge { display: inline-block; max-width: 70%; padding: 2px 9px; border-radius: 999px; background: rgba(21, 152, 189, 0.1); color: #0f4a63; font-size: 12px; font-weight: 600; }
      .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
      .stat { min-width: 0; padding: 10px 12px; border-radius: 12px; background: rgba(16, 36, 58, 0.045); }
      .stat b { display: block; color: #10243a; font-size: 22px; line-height: 1.15; font-weight: 700; font-variant-numeric: tabular-nums; }
      .stat span { display: block; margin-top: 3px; color: #566a7e; font-size: 12px; line-height: 1.3; }
      .actions { display: grid; gap: 8px; }
      .actions-secondary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .actions-more { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid rgba(15, 35, 50, 0.08); }
      .actions button, #grantSiteAccess { min-height: 40px; padding: 9px 12px; border: 1px solid rgba(15, 35, 50, 0.14); border-radius: 10px; background: rgba(255,255,255,.8); line-height: 1.3; white-space: normal; }
      .actions .primary, #grantSiteAccess { border-color: #155d78; background: #155d78; color: #fff; font-weight: 650; }
      .actions .danger { color: #8a3528; border-color: rgba(138,53,40,.28); background: transparent; }
      button:disabled { cursor: not-allowed; opacity: .55; }
      .warn { margin: 0; padding: 12px 14px; border: 1px solid rgba(155,110,15,.2); border-radius: 14px; background: rgba(255,248,232,.9); color: #594711; font-size: 13px; line-height: 1.5; }
      .warn p { margin: 0 0 10px; }
      .note { margin: 0; padding: 10px 12px; border-radius: 12px; background: rgba(16,36,58,.04); color: #526276; font-size: 13px; line-height: 1.5; }
      .account { display: grid; gap: 4px; }
      .account[data-kind="disconnected"] { background: rgba(155,110,15,.08); }
      .quiet { min-height: 32px; padding: 6px 8px; background: transparent; color: #155d78; font-size: 13px; line-height: 1.3; text-align: left; text-decoration: underline; text-underline-offset: 2px; }
      .workflow-extensions:empty { display: none; }
      .restore-pill {
        position: fixed; right: 16px; bottom: 16px; min-width: 126px; height: 44px;
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        padding: 0 16px; pointer-events: auto; color: #10243a;
        background: #f9fbfc; background: rgba(250, 252, 253, 0.86);
        border: 1px solid rgba(15, 35, 50, 0.12); border-radius: 999px;
        box-shadow: 0 10px 30px rgba(15, 35, 50, 0.13), 0 2px 7px rgba(15, 35, 50, 0.07);
        -webkit-backdrop-filter: blur(22px) saturate(145%); backdrop-filter: blur(22px) saturate(145%);
        font-weight: 680;
      }
      .restore-pill:hover { background: #ffffff; }
      button:focus-visible { outline: 3px solid #1598bd; outline-offset: 2px; } h2:focus, h2:focus-visible { outline: none; }
      @media (max-width: 363px) {
        .panel { right: 12px; bottom: 12px; width: calc(100% - 24px); max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); }
        .header { padding-left: 12px; } .body { padding: 16px 14px; } .restore-pill { right: 12px; bottom: 12px; }
        .actions-secondary { grid-template-columns: minmax(0, 1fr); } .stat b { font-size: 20px; }
      }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
      @media (forced-colors: active) {
        .panel, .restore-pill { color: CanvasText; background: Canvas; border-color: CanvasText; box-shadow: none; }
        .header, .warn, .actions button, #grantSiteAccess { border-color: CanvasText; }
        .context, .message, .status, .warn { color: CanvasText; }
        .status-dot { background: Highlight; } button:focus-visible { outline-color: Highlight; }
      }
    </style>
    <div data-overlay-root="${OVERLAY_MARKER}">
      <aside class="panel" data-overlay-panel role="complementary" aria-labelledby="xpertapply-overlay-heading" hidden>
        <header class="header">
          <div class="identity"><h2 class="brand" id="xpertapply-overlay-heading" tabindex="-1">XpertApply</h2><p class="context" id="job">Application Assistant</p></div>
          <div class="controls">
            <button class="icon-button" data-overlay-minimize type="button" aria-label="Minimize XpertApply assistant"><span class="icon minimize-icon" aria-hidden="true"></span></button>
            <button class="icon-button" data-overlay-close type="button" aria-label="Close XpertApply assistant"><span class="icon close-icon" aria-hidden="true"></span></button>
          </div>
        </header>
        <div class="body">
          <main class="assistant-main">
            <section class="card" aria-label="Application status">
              <p class="status" role="status" aria-live="polite"><span class="status-dot" aria-hidden="true"></span><span id="stage">Ready when you are</span></p>
              <p class="summary" id="summary" hidden></p>
            </section>
            <div id="siteAccess" class="warn" hidden><p id="siteAccessText"></p><button id="grantSiteAccess" type="button">Allow XpertApply on this site</button></div>
            <div id="limited" class="warn" hidden>Limited support for this ATS. Complete unsupported fields manually.</div>
            <section class="card" aria-label="Field summary">
              <div class="row"><span class="muted">Application form</span><span class="badge" id="ats">—</span></div>
              <div class="stats">
                <div class="stat"><b id="discovered">0</b><span>Fields found</span></div>
                <div class="stat"><b id="filled">0</b><span>Filled by XpertApply</span></div>
                <div class="stat"><b id="skipped">0</b><span>Skipped</span></div>
                <div class="stat"><b id="review">0</b><span>Needs review</span></div>
              </div>
            </section>
            <section class="card" aria-label="Documents">
              <p class="section-title">Documents</p>
              <div class="row"><span class="muted">Resume</span><span id="resume">—</span></div>
              <div class="row"><span class="muted">Cover letter</span><span id="cover">—</span></div>
            </section>
            <div id="errors" role="alert" hidden class="warn"></div>
            <div id="final" hidden class="warn">You’ve reached the employer’s submit step. XpertApply never submits for you.</div>
            <p id="suppressedMarks" hidden class="note"></p>
            <div class="actions">
              <button class="primary" id="fill" type="button">Fill application</button>
              <div class="actions-secondary">
                <button id="rescan" type="button">Continue filling</button>
                <button id="next" type="button">Refresh status</button>
              </div>
              <div class="actions-more">
                <button class="danger" id="clear" type="button">Clear XpertApply-filled fields</button>
                <button id="complete" type="button">Mark application complete</button>
              </div>
            </div>
            <p class="note">XpertApply never submits for you. Review the form, then submit on the employer’s website.</p>
            <section class="card account" id="account" hidden></section>
            <button id="disconnect" type="button" class="quiet" hidden>Disconnect XpertApply</button>
            <button id="disableSite" type="button" class="quiet">Don’t open XpertApply here automatically</button>
            <div class="workflow-extensions" data-overlay-workflow-extensions></div>
          </main>
        </div>
      </aside>
      <button class="restore-pill" data-overlay-restore type="button" aria-label="Restore XpertApply assistant" hidden><span class="status-dot" aria-hidden="true"></span><span>XpertApply</span></button>
    </div>`;
}
