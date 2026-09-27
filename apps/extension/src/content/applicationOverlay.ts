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
  getState(): ApplicationOverlayState;
}

interface OverlayInstance {
  controller: ApplicationOverlayController;
  disposeListeners: () => void;
}

const instances = new WeakMap<Document, OverlayInstance>();
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
    const ownedRoot = priorHost.shadowRoot?.querySelector(`[data-overlay-root="${OVERLAY_MARKER}"]`);
    if (!ownedRoot) throw new Error("XPERTAPPLY_OVERLAY_HOST_ID_COLLISION");
    priorHost.remove();
  }

  const host = ownerDocument.createElement("div");
  host.id = APPLICATION_OVERLAY_HOST_ID;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = overlayMarkup();

  const panel = ownedElement<HTMLElement>(root, "[data-overlay-panel]");
  const pill = ownedElement<HTMLButtonElement>(root, "[data-overlay-restore]");
  const heading = ownedElement<HTMLElement>(root, "#xpertapply-overlay-heading");
  const minimizeButton = ownedElement<HTMLButtonElement>(root, "[data-overlay-minimize]");
  const closeButton = ownedElement<HTMLButtonElement>(root, "[data-overlay-close]");
  let state: ApplicationOverlayState = "HIDDEN";

  const render = (): void => {
    panel.hidden = state !== "OPEN";
    pill.hidden = state !== "MINIMIZED";
    host.dataset.overlayState = state.toLowerCase();
  };
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
  const onClose = (): void => destroy();
  minimizeButton.addEventListener("click", onMinimize);
  pill.addEventListener("click", onRestore);
  closeButton.addEventListener("click", onClose);
  const disposeListeners = (): void => {
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
    if (instances.get(ownerDocument)?.controller === controller) instances.delete(ownerDocument);
  };
  const controller: ApplicationOverlayController = {
    host, root, show, minimize, restore, hide, focus, destroy, getState: () => state
  };

  ownerDocument.documentElement.appendChild(host);
  render();
  instances.set(ownerDocument, { controller, disposeListeners });
  return controller;
}

export function showOverlay(ownerDocument: Document = document): ApplicationOverlayController {
  const overlay = ensureOverlay(ownerDocument);
  overlay.show();
  return overlay;
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
      .panel {
        position: fixed; top: 16px; right: 16px;
        width: min(400px, calc(100vw - 24px)); max-width: 420px;
        max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px);
        overflow: hidden; pointer-events: auto; color: #10243a;
        background: #f9fbfc; background: rgba(249, 251, 252, 0.96);
        border: 1px solid rgba(15, 35, 50, 0.12); border-radius: 20px;
        box-shadow: 0 18px 48px rgba(15, 35, 50, 0.14), 0 2px 8px rgba(15, 35, 50, 0.07);
        -webkit-backdrop-filter: blur(18px) saturate(120%);
        backdrop-filter: blur(18px) saturate(120%);
      }
      .header { min-height: 54px; display: flex; align-items: center; gap: 12px; padding: 8px 12px 8px 16px; border-bottom: 1px solid rgba(15, 35, 50, 0.08); }
      .identity { min-width: 0; flex: 1; }
      .brand { margin: 0; font-size: 15px; line-height: 20px; font-weight: 680; letter-spacing: -0.01em; }
      .context { margin: 1px 0 0; color: #667687; font-size: 12px; line-height: 16px; }
      .controls { display: flex; align-items: center; gap: 4px; }
      button { appearance: none; border: 0; margin: 0; font: inherit; color: inherit; cursor: pointer; }
      .icon-button { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 10px; background: transparent; }
      .icon-button:hover { background: rgba(16, 36, 58, 0.06); }
      .icon { position: relative; width: 14px; height: 14px; display: block; }
      .minimize-icon::after { content: ""; position: absolute; left: 2px; right: 2px; bottom: 3px; height: 1.5px; border-radius: 2px; background: currentColor; }
      .close-icon::before, .close-icon::after { content: ""; position: absolute; left: 6px; top: 1px; width: 1.5px; height: 12px; border-radius: 2px; background: currentColor; }
      .close-icon::before { transform: rotate(45deg); }
      .close-icon::after { transform: rotate(-45deg); }
      .body { padding: 24px 20px; overflow: auto; }
      .status { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; color: #155d78; font-size: 12px; font-weight: 650; }
      .status-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: #1da8c7; }
      .message { margin: 0; color: #44566a; font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
      .restore-pill {
        position: fixed; right: 16px; bottom: 16px; min-width: 126px; height: 44px;
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        padding: 0 16px; pointer-events: auto; color: #10243a;
        background: #f9fbfc; background: rgba(249, 251, 252, 0.96);
        border: 1px solid rgba(15, 35, 50, 0.12); border-radius: 999px;
        box-shadow: 0 10px 30px rgba(15, 35, 50, 0.13), 0 2px 7px rgba(15, 35, 50, 0.07);
        -webkit-backdrop-filter: blur(18px) saturate(120%); backdrop-filter: blur(18px) saturate(120%);
        font-weight: 680;
      }
      .restore-pill:hover { background: #ffffff; }
      button:focus-visible, h2:focus-visible { outline: 3px solid #1598bd; outline-offset: 2px; }
      @media (max-width: 363px) {
        .panel { top: 12px; right: 12px; width: calc(100vw - 24px); max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); }
        .header { padding-left: 12px; } .body { padding: 20px 16px; } .restore-pill { right: 12px; bottom: 12px; }
      }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
      @media (forced-colors: active) {
        .panel, .restore-pill { color: CanvasText; background: Canvas; border-color: CanvasText; box-shadow: none; }
        .header { border-color: CanvasText; } .context, .message, .status { color: CanvasText; }
        .status-dot { background: Highlight; } button:focus-visible, h2:focus-visible { outline-color: Highlight; }
      }
    </style>
    <div data-overlay-root="${OVERLAY_MARKER}">
      <aside class="panel" data-overlay-panel role="complementary" aria-labelledby="xpertapply-overlay-heading" hidden>
        <header class="header">
          <div class="identity"><h2 class="brand" id="xpertapply-overlay-heading" tabindex="-1">XpertApply</h2><p class="context">Application Assistant</p></div>
          <div class="controls">
            <button class="icon-button" data-overlay-minimize type="button" aria-label="Minimize XpertApply assistant"><span class="icon minimize-icon" aria-hidden="true"></span></button>
            <button class="icon-button" data-overlay-close type="button" aria-label="Close XpertApply assistant"><span class="icon close-icon" aria-hidden="true"></span></button>
          </div>
        </header>
        <div class="body"><p class="status" role="status"><span class="status-dot" aria-hidden="true"></span><span>Ready when you are</span></p><p class="message">XpertApply will help you complete this application while you remain in control.</p></div>
      </aside>
      <button class="restore-pill" data-overlay-restore type="button" aria-label="Restore XpertApply assistant" hidden><span class="status-dot" aria-hidden="true"></span><span>XpertApply</span></button>
    </div>`;
}
