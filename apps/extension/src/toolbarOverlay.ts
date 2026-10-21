import { MSG } from "./messages";
import { toolbarDisclosureAccepted } from "./toolbarDisclosure";

export const TOOLBAR_OVERLAY_BUNDLE = "overlayBootstrap.js";

export function toolbarTarget(tab: chrome.tabs.Tab): { tabId: number; url: URL } | null {
  if (!Number.isInteger(tab.id) || tab.id == null || tab.id < 0 || !tab.url) return null;
  try {
    const url = new URL(tab.url);
    return url.protocol === "https:" || url.protocol === "http:" ? { tabId: tab.id, url } : null;
  } catch {
    return null;
  }
}

/** Explicit action-click path only. activeTab authorizes bootstrap injection;
 * it does not alter persistent exact-origin permission state.
 *
 * Only the static bootstrap is injected here. The workflow engine (content.js)
 * is what reads the page, so it is injected by continueToolbarOverlay, which
 * runs only after the user has accepted the first-use disclosure. */
export async function showToolbarOverlay(tab: chrome.tabs.Tab): Promise<boolean> {
  const target = toolbarTarget(tab);
  if (!target) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: target.tabId, frameIds: [0] },
      files: [TOOLBAR_OVERLAY_BUNDLE]
    });
    if (!(await toolbarDisclosureAccepted())) {
      await chrome.tabs.sendMessage(target.tabId, { type: MSG.SHOW_TOOLBAR_DISCLOSURE }, { frameId: 0 });
      return true;
    }
    return await continueToolbarOverlay(target.tabId);
  } catch {
    return false;
  }
}

/** Load the workflow engine and mount the assistant. Callers must already hold
 * a recorded disclosure acceptance. */
export async function continueToolbarOverlay(tabId: number): Promise<boolean> {
  try {
    // The overlay is only a presentation surface. Load the same qualified
    // workflow engine used by prepared launches after the toolbar marker is in
    // place; bootstrap.ts sees that marker and performs read-only discovery,
    // never form mutation, until the user explicitly asks to fill.
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["content.js"]
    });
    await chrome.tabs.sendMessage(tabId, { type: MSG.SHOW_APPLICATION_OVERLAY }, { frameId: 0 });
    return true;
  } catch {
    return false;
  }
}

export function installToolbarOverlayAction(): void {
  chrome.action?.onClicked?.addListener((tab) => {
    void showToolbarOverlay(tab);
  });
}

export function disableSidePanelToolbarOpen(): void {
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => undefined);
}
