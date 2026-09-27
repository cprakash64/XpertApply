import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchViewState } from "../messages";
import { MSG } from "../messages";
import { STORAGE_KEYS } from "../state";

const elementIds = ["job", "stage", "ats", "discovered", "filled", "skipped", "review", "limited", "final", "resume", "cover", "errors", "siteAccess", "siteAccessText", "diag", "diagBody"];
const buttonIds = ["fill", "rescan", "next", "clear", "complete", "grantSiteAccess"];

function view(tabId: number, overrides: Partial<LaunchViewState> = {}): LaunchViewState {
  return {
    tabId, requestId: `request-${tabId}`, sessionId: tabId, state: "completed_with_review",
    company: "Example", jobTitle: `Job ${tabId}`, atsId: "greenhouse", atsDisplayName: "Greenhouse",
    limited: false, fieldsDiscovered: 5, filled: 3, skipped: 1, reviewRequired: 1,
    resumeStatus: "uploaded", coverStatus: "review", reachedFinalStep: true,
    contentReady: true, packageLoaded: true, running: false, failureCode: null,
    failureMessage: null, confirmationRequired: false, confirmationDismissed: false,
    submissionGestureAt: null, submissionAttempt: 0, failureRecoverable: null,
    siteAccess: "site_access_granted", siteAccessPattern: null, siteAccessOrigin: null,
    siteAccessScope: "page", updatedAt: 1, ...overrides
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("assistant full-UI bootstrap", () => {
  let boundTabId: number | undefined;
  let views: Record<string, LaunchViewState>;
  let runtimeListener: ((message: unknown, sender: chrome.runtime.MessageSender) => void) | undefined;
  let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;
  let permissionRequest: ReturnType<typeof vi.fn>;
  let sent: object[];

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = [
      ...elementIds.map((id) => `<div id="${id}" hidden></div>`),
      ...buttonIds.map((id) => `<button id="${id}">${id}</button>`)
    ].join("");
    boundTabId = 42;
    views = { "42": view(42), "77": view(77) };
    permissionRequest = vi.fn(async () => true);
    sent = [];
    vi.stubGlobal("chrome", {
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        getManifest: () => ({ update_url: "https://updates.example/" }),
        sendMessage: (message: object, callback: (response: object) => void) => {
          sent.push(message);
          if ((message as { type?: string }).type === MSG.ASSISTANT_GET_CONTEXT) {
            callback({ ok: true, context: boundTabId == null
              ? { status: "waiting", state: {} }
              : { status: "bound", state: { boundJobTabId: boundTabId } } });
          } else callback({ ok: true });
        },
        onMessage: {
          addListener: vi.fn((listener) => { runtimeListener = listener; }),
          removeListener: vi.fn()
        },
        lastError: undefined
      },
      storage: {
        session: { get: vi.fn(async () => ({ [STORAGE_KEYS.VIEW_KEY]: views })) },
        local: { get: vi.fn(async () => ({ [STORAGE_KEYS.VIEW_KEY]: views })) },
        onChanged: {
          addListener: vi.fn((listener) => { storageListener = listener; }),
          removeListener: vi.fn()
        }
      },
      permissions: { request: permissionRequest }
    });
  });

  it("gets bound context from the worker and never requests permission during initialization", async () => {
    await import("../ui/assistant");
    await settle();
    expect(document.getElementById("job")?.textContent).toBe("Job 42 · Example");
    expect(permissionRequest).not.toHaveBeenCalled();
    expect(sent[0]).toEqual({ type: MSG.ASSISTANT_GET_CONTEXT });
  });

  it("disables actions without a worker binding", async () => {
    boundTabId = undefined;
    await import("../ui/assistant");
    await settle();
    expect((document.getElementById("fill") as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("stage")?.textContent).toContain("Open or select");
  });

  it("switches context from worker notification without requesting permission or using another active tab", async () => {
    await import("../ui/assistant");
    await settle();
    boundTabId = 77;
    runtimeListener?.({ type: MSG.ASSISTANT_CONTEXT_CHANGED }, { id: chrome.runtime.id });
    await settle();
    expect(document.getElementById("job")?.textContent).toBe("Job 77 · Example");
    expect(permissionRequest).not.toHaveBeenCalled();
    document.getElementById("fill")?.click();
    await settle();
    expect(sent).toContainEqual({ type: MSG.ASSISTANT_START_AUTOFILL, tabId: 77, reason: "manual_retry" });
  });

  it("clears stale presentation when the bound tab view disappears", async () => {
    await import("../ui/assistant");
    await settle();
    storageListener?.({
      [STORAGE_KEYS.VIEW_KEY]: { oldValue: { "42": views["42"] }, newValue: {} }
    }, "session");
    expect((document.getElementById("fill") as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("stage")?.textContent).toContain("unavailable");
  });

  it("requests only the exact view pattern from the direct site-access click", async () => {
    views["42"] = view(42, {
      siteAccess: "site_access_required",
      siteAccessPattern: "https://jobs.example/*",
      siteAccessOrigin: "jobs.example"
    });
    await import("../ui/assistant");
    await settle();
    expect(permissionRequest).not.toHaveBeenCalled();
    document.getElementById("grantSiteAccess")?.click();
    await settle();
    expect(permissionRequest).toHaveBeenCalledWith({ origins: ["https://jobs.example/*"] });
    expect(sent).toContainEqual({
      type: MSG.ASSISTANT_SITE_ACCESS_RESULT,
      tabId: 42,
      pattern: "https://jobs.example/*",
      granted: true
    });
  });

  it("disposes assistant-owned runtime, storage, and DOM listeners on unload", async () => {
    await import("../ui/assistant");
    await settle();
    window.dispatchEvent(new Event("unload"));
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(runtimeListener);
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(storageListener);
    document.getElementById("fill")?.click();
    expect(sent.filter((message) => (message as { type?: string }).type === MSG.ASSISTANT_START_AUTOFILL)).toHaveLength(0);
  });
});
