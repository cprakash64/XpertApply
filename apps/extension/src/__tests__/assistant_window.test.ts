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
  restoreAssistantAfterServiceWorkerWake,
  validateJobTab
} from "../assistantWindow";

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
    const [manifest, assistantSource] = await Promise.all([
      import("../../manifest.json", { with: { type: "json" } }),
      import("node:fs/promises").then((fs) => fs.readFile("src/ui/assistant.ts", "utf8"))
    ]);
    expect(manifest.default.side_panel.default_path).toBe("sidepanel.html");
    expect(manifest.default.permissions).toContain("sidePanel");
    expect(assistantSource).not.toContain("currentWindow");
  });

  it("can clear only a verified assistant reference", async () => {
    stored[ASSISTANT_STATE_KEY] = { assistantWindowId: 8, boundJobTabId: 5 };
    await clearAssistantWindowReference(7);
    expect((await readAssistantState()).assistantWindowId).toBe(8);
  });
});
