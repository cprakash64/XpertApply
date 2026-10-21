import { MSG, parseRuntimeMessage } from "../messages";
import { reopenApplicationAssistantOverlay } from "./applicationOverlayAssistant";
import { showToolbarDisclosure } from "./toolbarDisclosure";

type BootstrapWorld = typeof globalThis & {
  __xpertapplyOverlayBootstrapV1__?: true;
};

/**
 * Install exactly one receiver in this document's extension isolated world.
 * Re-executing overlayBootstrap.js is harmless and exposes no page-world API.
 */
export function installOverlayToolbarReceiver(): void {
  const world = globalThis as BootstrapWorld;
  if (world.__xpertapplyOverlayBootstrapV1__) return;
  world.__xpertapplyOverlayBootstrapV1__ = true;

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const message = parseRuntimeMessage(raw);
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === MSG.SHOW_TOOLBAR_DISCLOSURE) {
      // Static copy only: nothing on the page is read before the user accepts.
      showToolbarDisclosure(document);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== MSG.SHOW_APPLICATION_OVERLAY) return false;
    chrome.runtime.sendMessage({ type: MSG.TOOLBAR_OVERLAY_READY }, () => {
      // Registration is best-effort for display: the worker remains the
      // authority for every action and will fail closed if it did not accept it.
      void chrome.runtime.lastError;
      const mounted = reopenApplicationAssistantOverlay(document);
      sendResponse({ ok: true, state: mounted.overlay.getState() });
    });
    return true;
  });
}

installOverlayToolbarReceiver();
