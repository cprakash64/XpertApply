import { beforeEach, describe, expect, it, vi } from "vitest";
import { MSG } from "../messages";
import manifest from "../../manifest.json";
import {
  disableSidePanelToolbarOpen,
  installToolbarOverlayAction,
  showToolbarOverlay,
  toolbarTarget,
  TOOLBAR_OVERLAY_BUNDLE
} from "../toolbarOverlay";

describe("toolbar exact-tab overlay cutover", () => {
  const executeScript = vi.fn(async () => undefined);
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const actionListeners: Array<(tab: chrome.tabs.Tab) => void> = [];
  const setPanelBehavior = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    actionListeners.length = 0;
    vi.stubGlobal("chrome", {
      action: { onClicked: { addListener: (listener: (tab: chrome.tabs.Tab) => void) => actionListeners.push(listener) } },
      scripting: { executeScript },
      tabs: { sendMessage },
      sidePanel: { setPanelBehavior }
    });
  });

  it("injects and shows only the exact tab supplied by action.onClicked", async () => {
    expect(await showToolbarOverlay({ id: 41, url: "https://jobs.example/apply" } as chrome.tabs.Tab)).toBe(true);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 41, frameIds: [0] },
      files: [TOOLBAR_OVERLAY_BUNDLE]
    });
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 41, frameIds: [0] },
      files: ["content.js"]
    });
    expect(sendMessage).toHaveBeenCalledWith(41, { type: MSG.SHOW_APPLICATION_OVERLAY }, { frameId: 0 });
    expect(JSON.stringify(executeScript.mock.calls)).not.toContain("42");
  });

  it.each([undefined, -1, 1.5])("rejects invalid tab id %s", async (id) => {
    expect(await showToolbarOverlay({ id, url: "https://jobs.example/apply" } as chrome.tabs.Tab)).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it.each(["chrome://extensions", "about:blank", "edge://settings", "view-source:https://example.com", "chrome-extension://id/page.html"])
  ("rejects internal target %s", async (url) => {
    expect(toolbarTarget({ id: 9, url } as chrome.tabs.Tab)).toBeNull();
    expect(await showToolbarOverlay({ id: 9, url } as chrome.tabs.Tab)).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("registers action ownership and disables automatic Side Panel opening", async () => {
    installToolbarOverlayAction();
    disableSidePanelToolbarOpen();
    expect(actionListeners).toHaveLength(1);
    actionListeners[0]({ id: 77, url: "https://jobs.example/apply" } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(77, { type: MSG.SHOW_APPLICATION_OVERLAY }, { frameId: 0 }));
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
  });

  it("adds only activeTab without changing host authority or version", () => {
    expect(manifest.version).toBe("0.3.0");
    expect(manifest.permissions).toEqual(["activeTab", "sidePanel", "storage", "scripting", "tabs"]);
    expect(manifest.host_permissions).toEqual([
      "https://api.xpertapply.com/*", "https://xpertapply.com/*", "https://www.xpertapply.com/*"
    ]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
  });
});
