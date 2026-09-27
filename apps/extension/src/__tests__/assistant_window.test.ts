import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_STATE_KEY,
  assistantUrl,
  bindAssistantToJobTab,
  clearAssistantWindowReference,
  createAssistant,
  findExistingAssistant,
  getAssistantContext,
  handleAssistantWindowRemoved,
  handleBoundTabUpdated,
  isTrustedAssistantSender,
  openOrFocusAssistant,
  readAssistantState,
  requireAuthorizedAssistantJobTab,
  restoreAssistantAfterServiceWorkerWake,
  validateJobTab
} from "../assistantWindow";
import { MSG, parseRuntimeMessage } from "../messages";

type Stored = Record<string, unknown>;
let stored: Stored;
let tabs: Map<number, chrome.tabs.Tab>;
let windows: chrome.windows.Window[];
let nextWindowId: number;
let create: ReturnType<typeof vi.fn>;
let update: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
let permissionsRequest: ReturnType<typeof vi.fn>;
let executeScript: ReturnType<typeof vi.fn>;

const extensionUrl = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/assistant.html";

function popup(id: number, url = extensionUrl): chrome.windows.Window {
  return { id, focused: false, type: "popup", alwaysOnTop: false, incognito: false, tabs: [{ id: id * 10, windowId: id, url }] };
}

beforeEach(() => {
  stored = {};
  tabs = new Map();
  windows = [];
  nextWindowId = 100;
  create = vi.fn(async (options) => {
    const created = popup(nextWindowId++);
    windows.push(created);
    return { ...created, ...options };
  });
  update = vi.fn(async (id, options) => ({ ...windows.find((item) => item.id === id), ...options }));
  remove = vi.fn(async (id: number) => { windows = windows.filter((item) => item.id !== id); });
  permissionsRequest = vi.fn();
  executeScript = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getURL: (path: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      sendMessage: vi.fn(async () => undefined)
    },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (value: Stored) => Object.assign(stored, value))
      }
    },
    tabs: { get: vi.fn(async (id: number) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error("missing");
      return tab;
    }) },
    windows: { getAll: vi.fn(async () => windows), create, update, remove },
    permissions: { request: permissionsRequest },
    scripting: { executeScript }
  });
});

describe("assistant window lifecycle", () => {
  it("creates the extension-owned assistant URL at the required popup bounds", async () => {
    await createAssistant();
    expect(create).toHaveBeenCalledWith({ url: extensionUrl, type: "popup", width: 460, height: 800, focused: true });
  });

  it("focuses an existing assistant instead of creating another", async () => {
    windows = [popup(8)];
    await openOrFocusAssistant();
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(8, { focused: true });
  });

  it("ignores a stale stored ID and reconstructs the real assistant", async () => {
    stored[ASSISTANT_STATE_KEY] = { assistantWindowId: 99 };
    windows = [popup(7)];
    expect((await findExistingAssistant())?.id).toBe(7);
    expect(await readAssistantState()).toEqual({ assistantWindowId: 7 });
  });

  it("never mistakes an unrelated popup for the assistant", async () => {
    stored[ASSISTANT_STATE_KEY] = { assistantWindowId: 5 };
    windows = [popup(5, "https://example.com/")];
    expect(await findExistingAssistant()).toBeNull();
    expect(await readAssistantState()).toEqual({});
  });

  it("chooses the lowest ID deterministically when duplicate assistants exist", async () => {
    windows = [popup(12), popup(4), popup(9)];
    expect((await findExistingAssistant())?.id).toBe(4);
    expect((await readAssistantState()).assistantWindowId).toBe(4);
    expect(remove.mock.calls.map(([id]) => id)).toEqual([9, 12]);
  });

  it("serializes concurrent creation", async () => {
    const [a, b] = await Promise.all([createAssistant(), createAssistant()]);
    expect(a.id).toBe(b.id);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("stores assistant and bound job tab IDs separately", async () => {
    tabs.set(42, { id: 42, url: "https://jobs.example/apply" });
    await createAssistant(42);
    expect(await readAssistantState()).toEqual({ assistantWindowId: 100, boundJobTabId: 42 });
  });

  it.each(["http://jobs.example/apply", "https://jobs.example/apply"])("accepts a normal %s job tab", async (url) => {
    tabs.set(4, { id: 4, url });
    expect((await validateJobTab(4))?.id).toBe(4);
  });

  it.each(["chrome://settings/", "edge://settings/", "about:blank", "devtools://devtools/", "file:///tmp/a"])("rejects internal URL %s", async (url) => {
    tabs.set(4, { id: 4, url });
    expect(await validateJobTab(4)).toBeNull();
  });

  it("rejects the assistant's own extension tab", async () => {
    tabs.set(4, { id: 4, url: assistantUrl() });
    expect(await validateJobTab(4)).toBeNull();
  });

  it("rejects every other extension-internal tab", async () => {
    tabs.set(4, { id: 4, url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html" });
    expect(await validateJobTab(4)).toBeNull();
  });

  it("clears a closed or invalidated bound tab", async () => {
    tabs.set(5, { id: 5, url: "https://jobs.example/apply" });
    await bindAssistantToJobTab(5);
    tabs.delete(5);
    await handleBoundTabUpdated(5);
    expect((await readAssistantState()).boundJobTabId).toBeUndefined();
  });

  it("assistant closure clears only its window reference", async () => {
    stored[ASSISTANT_STATE_KEY] = { assistantWindowId: 10, boundJobTabId: 5 };
    await handleAssistantWindowRemoved(10);
    expect(await readAssistantState()).toEqual({ boundJobTabId: 5 });
  });

  it("an unrelated window closure changes nothing", async () => {
    stored[ASSISTANT_STATE_KEY] = { assistantWindowId: 10, boundJobTabId: 5 };
    await handleAssistantWindowRemoved(11);
    expect(await readAssistantState()).toEqual({ assistantWindowId: 10, boundJobTabId: 5 });
  });

  it("worker restoration validates both real window and tab state", async () => {
    stored[ASSISTANT_STATE_KEY] = { assistantWindowId: 99, boundJobTabId: 5 };
    windows = [popup(10)];
    tabs.set(5, { id: 5, url: "chrome://extensions/" });
    const context = await restoreAssistantAfterServiceWorkerWake();
    expect(context.status).toBe("waiting");
    expect(await readAssistantState()).toEqual({ assistantWindowId: 10 });
  });

  it("returns only safe context for a valid bound tab", async () => {
    stored[ASSISTANT_STATE_KEY] = { boundJobTabId: 5 };
    tabs.set(5, { id: 5, url: "https://jobs.example/apply", title: "Engineer" });
    expect(await getAssistantContext()).toMatchObject({ status: "bound", title: "Engineer", url: "https://jobs.example/apply" });
  });

  it("requires both the extension ID and exact assistant URL for internal messages", () => {
    expect(isTrustedAssistantSender({ id: chrome.runtime.id, url: extensionUrl })).toBe(true);
    expect(isTrustedAssistantSender({ id: chrome.runtime.id, url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html" })).toBe(false);
    expect(isTrustedAssistantSender({ id: "other", url: extensionUrl })).toBe(false);
  });

  it("never requests permission or injects a script while opening or focusing", async () => {
    await openOrFocusAssistant();
    await openOrFocusAssistant();
    expect(permissionsRequest).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("keeps the Side Panel entrypoint and avoids current-window tab authority", async () => {
    const [manifest, assistantSource, assistantHtml, sharedSource] = await Promise.all([
      import("../../manifest.json", { with: { type: "json" } }),
      import("node:fs/promises").then((fs) => fs.readFile("src/ui/assistant.ts", "utf8")),
      import("node:fs/promises").then((fs) => fs.readFile("src/ui/assistant.html", "utf8")),
      import("node:fs/promises").then((fs) => fs.readFile("src/ui/applicationAssistant.ts", "utf8"))
    ]);
    expect(manifest.default.side_panel.default_path).toBe("sidepanel.html");
    expect(manifest.default.permissions).toContain("sidePanel");
    expect(assistantSource).not.toContain("currentWindow");
    expect(assistantSource).not.toContain("tabs.query");
    expect(sharedSource).not.toContain("currentWindow");
    for (const id of ["job", "stage", "siteAccess", "fill", "clear", "complete", "diag"]) {
      expect(assistantHtml).toContain(`id="${id}"`);
    }
  });

  it("parses only complete typed assistant action messages", () => {
    expect(parseRuntimeMessage({ type: MSG.ASSISTANT_START_AUTOFILL, tabId: 42, reason: "manual_retry" })).not.toBeNull();
    expect(parseRuntimeMessage({ type: MSG.ASSISTANT_CLEAR_SESSION, tabId: 42 })).not.toBeNull();
    expect(parseRuntimeMessage({ type: MSG.ASSISTANT_COMPLETE_SESSION, tabId: 42, sessionId: 7 })).not.toBeNull();
    expect(parseRuntimeMessage({ type: MSG.ASSISTANT_SITE_ACCESS_RESULT, tabId: 42, pattern: "https://jobs.example/*", granted: true })).not.toBeNull();
    expect(parseRuntimeMessage({ type: MSG.ASSISTANT_START_AUTOFILL, reason: "manual_retry" })).toBeNull();
    expect(parseRuntimeMessage({ type: MSG.ASSISTANT_COMPLETE_SESSION, tabId: 42 })).toBeNull();
  });

  it("can clear only a verified assistant reference", async () => {
    stored[ASSISTANT_STATE_KEY] = { assistantWindowId: 8, boundJobTabId: 5 };
    await clearAssistantWindowReference(7);
    expect((await readAssistantState()).assistantWindowId).toBe(8);
  });
});

describe("assistant action tab authority", () => {
  const trustedSender = { id: "abcdefghijklmnopabcdefghijklmnop", url: extensionUrl };

  it("revalidates worker-owned boundJobTabId with tabs.get on every action", async () => {
    stored[ASSISTANT_STATE_KEY] = { boundJobTabId: 42 };
    tabs.set(42, { id: 42, url: "https://jobs.example/apply" });
    expect((await requireAuthorizedAssistantJobTab(trustedSender, 42)).id).toBe(42);
    expect(chrome.tabs.get).toHaveBeenCalledWith(42);
  });

  it("rejects untrusted extension pages and stale UI-supplied tab IDs", async () => {
    stored[ASSISTANT_STATE_KEY] = { boundJobTabId: 42 };
    tabs.set(42, { id: 42, url: "https://jobs.example/apply" });
    await expect(requireAuthorizedAssistantJobTab({ id: chrome.runtime.id, url: chrome.runtime.getURL("sidepanel.html") }, 42))
      .rejects.toThrow("UNTRUSTED_ASSISTANT_SENDER");
    await expect(requireAuthorizedAssistantJobTab(trustedSender, 41))
      .rejects.toThrow("ASSISTANT_TAB_AUTHORITY_MISMATCH");
  });

  it("clears and rejects a closed, internal, or assistant-owned bound tab", async () => {
    for (const url of [undefined, "chrome://settings/", extensionUrl]) {
      stored[ASSISTANT_STATE_KEY] = { boundJobTabId: 42 };
      tabs.clear();
      if (url) tabs.set(42, { id: 42, url });
      await expect(requireAuthorizedAssistantJobTab(trustedSender, 42))
        .rejects.toThrow("ASSISTANT_BOUND_TAB_UNAVAILABLE");
      expect((await readAssistantState()).boundJobTabId).toBeUndefined();
    }
  });

  it("fails closed when binding changes while tabs.get is in flight", async () => {
    stored[ASSISTANT_STATE_KEY] = { boundJobTabId: 42 };
    tabs.set(42, { id: 42, url: "https://jobs.example/apply" });
    vi.mocked(chrome.tabs.get).mockImplementationOnce(async () => {
      stored[ASSISTANT_STATE_KEY] = { boundJobTabId: 77 };
      return tabs.get(42)!;
    });
    await expect(requireAuthorizedAssistantJobTab(trustedSender, 42))
      .rejects.toThrow("ASSISTANT_TAB_AUTHORITY_CHANGED");
  });

  it("does not consult focused windows or unrelated active tabs", async () => {
    stored[ASSISTANT_STATE_KEY] = { boundJobTabId: 42 };
    tabs.set(42, { id: 42, windowId: 1, active: false, url: "https://jobs.example/apply" });
    tabs.set(77, { id: 77, windowId: 2, active: true, url: "https://unrelated.example/" });
    windows = [popup(9)];
    expect((await requireAuthorizedAssistantJobTab(trustedSender, 42)).id).toBe(42);
    expect(chrome.windows.getAll).not.toHaveBeenCalled();
  });

  it("never substitutes an unrelated active tab when the binding is absent or invalid", async () => {
    tabs.set(77, { id: 77, windowId: 2, active: true, url: "https://unrelated.example/" });
    await expect(requireAuthorizedAssistantJobTab(trustedSender, 42))
      .rejects.toThrow("ASSISTANT_TAB_AUTHORITY_MISMATCH");
    expect(chrome.tabs.get).not.toHaveBeenCalledWith(77);

    stored[ASSISTANT_STATE_KEY] = { boundJobTabId: 42 };
    await expect(requireAuthorizedAssistantJobTab(trustedSender, 42))
      .rejects.toThrow("ASSISTANT_BOUND_TAB_UNAVAILABLE");
    expect(chrome.tabs.get).toHaveBeenCalledWith(42);
    expect(chrome.tabs.get).not.toHaveBeenCalledWith(77);
  });
});
