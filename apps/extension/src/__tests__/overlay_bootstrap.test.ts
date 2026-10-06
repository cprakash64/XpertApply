import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MSG } from "../messages";

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (value: unknown) => void) => boolean;

describe("dedicated toolbar overlay bootstrap", () => {
  const listeners: Listener[] = [];
  const permissionRequest = vi.fn();
  let overlay: typeof import("../content/applicationOverlay");
  let assistant: typeof import("../content/applicationOverlayAssistant");
  let widgetModule: typeof import("../content/widget");

  beforeEach(async () => {
    vi.resetModules();
    listeners.length = 0;
    delete (globalThis as typeof globalThis & { __xpertapplyOverlayBootstrapV1__?: true }).__xpertapplyOverlayBootstrapV1__;
    vi.stubGlobal("chrome", {
      runtime: {
        id: "extension-id",
        lastError: undefined,
        getManifest: () => ({ update_url: "https://updates.example" }),
        sendMessage: vi.fn((_message: unknown, callback: (response?: unknown) => void) => callback(undefined)),
        onMessage: {
          addListener: (listener: Listener) => listeners.push(listener),
          removeListener: (listener: Listener) => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          }
        }
      },
      storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() }, session: {} },
      permissions: { request: permissionRequest }
    });
    await import("../content/overlayBootstrap");
    overlay = await import("../content/applicationOverlay");
    assistant = await import("../content/applicationOverlayAssistant");
    widgetModule = await import("../content/widget");
  });

  afterEach(() => {
    overlay.destroyOverlay(document);
    document.getElementById("xpertapply-assistant-overlay-v1")?.remove();
    delete (globalThis as typeof globalThis & { __xpertapplyOverlayBootstrapV1__?: true }).__xpertapplyOverlayBootstrapV1__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function show(senderId = "extension-id"): unknown {
    let response: unknown;
    listeners[0]({ type: MSG.SHOW_APPLICATION_OVERLAY }, { id: senderId }, (value) => { response = value; });
    return response;
  }

  it("installs once, trusts only the extension sender, and never requests permission on open", async () => {
    const { installOverlayToolbarReceiver } = await import("../content/overlayBootstrap");
    installOverlayToolbarReceiver();
    expect(listeners).toHaveLength(1);
    expect(show("untrusted")).toBeUndefined();
    expect(document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    expect(show()).toEqual({ ok: true, state: "OPEN" });
    expect(permissionRequest).not.toHaveBeenCalled();
  });

  it("reuses one host, restores minimized state, and explicitly reopens after close", () => {
    show();
    const first = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!;
    first.shadowRoot?.querySelector<HTMLButtonElement>("[data-overlay-minimize]")?.click();
    expect(overlay.getOverlayState(document)).toBe("MINIMIZED");
    show();
    expect(overlay.getOverlayState(document)).toBe("OPEN");
    expect(document.querySelectorAll(`#${overlay.APPLICATION_OVERLAY_HOST_ID}`)).toHaveLength(1);
    first.shadowRoot?.querySelector<HTMLButtonElement>("[data-overlay-close]")?.click();
    expect(overlay.getOverlayState(document)).toBe("ABSENT");
    show();
    expect(overlay.getOverlayState(document)).toBe("OPEN");
    expect(document.querySelectorAll(`#${overlay.APPLICATION_OVERLAY_HOST_ID}`)).toHaveLength(1);
  });

  it("shares one controller and notification subscription across separately loaded bundles", async () => {
    show();
    const toolbarMount = assistant.mountApplicationAssistantOverlay();
    expect(listeners).toHaveLength(2);
    vi.resetModules();
    const workflowBundle = await import("../content/applicationOverlayAssistant");
    const workflowOverlay = await import("../content/applicationOverlay");
    const workflowMount = workflowBundle.mountApplicationAssistantOverlay();
    expect(workflowMount).toBe(toolbarMount);
    expect(workflowOverlay.ensureOverlay()).toBe(toolbarMount.overlay);
    expect(listeners).toHaveLength(2);
    workflowMount.overlay.destroy();
    expect(listeners).toHaveLength(1);
    expect(workflowOverlay.getOverlayState()).toBe("ABSENT");
  });

  it("uses no periodic refresh timer across open, minimize, close, and reopen", () => {
    const interval = vi.spyOn(window, "setInterval");
    show();
    const first = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!;
    show();
    first.shadowRoot?.querySelector<HTMLButtonElement>("[data-overlay-minimize]")?.click();
    show();
    first.shadowRoot?.querySelector<HTMLButtonElement>("[data-overlay-close]")?.click();
    show();
    overlay.destroyOverlay(document);
    expect(interval).not.toHaveBeenCalled();
  });

  it("refreshes from trusted invalidation and recovery events, then cleans listeners", async () => {
    const sendMessage = vi.mocked(chrome.runtime.sendMessage);
    show();
    const host = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!;
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      { type: MSG.OVERLAY_GET_CONTEXT }, expect.any(Function)
    ));
    sendMessage.mockClear();
    const invalidation = listeners.find((listener) => listener !== listeners[0])!;
    invalidation({ type: MSG.OVERLAY_VIEW_CHANGED }, { id: "untrusted" }, () => undefined);
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();
    invalidation({ type: MSG.OVERLAY_VIEW_CHANGED }, { id: "extension-id" }, () => undefined);
    invalidation({ type: MSG.OVERLAY_VIEW_CHANGED }, { id: "extension-id" }, () => undefined);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    sendMessage.mockClear();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenNthCalledWith(1, { type: MSG.TOOLBAR_OVERLAY_READY }, expect.any(Function));
    expect(sendMessage).toHaveBeenNthCalledWith(2, { type: MSG.OVERLAY_GET_CONTEXT }, expect.any(Function));
    host.shadowRoot?.querySelector<HTMLButtonElement>("[data-overlay-close]")?.click();
    sendMessage.mockClear();
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("retains minimized state during invalidation and ignores its late fetch after close", async () => {
    show();
    const sendMessage = vi.mocked(chrome.runtime.sendMessage);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: MSG.OVERLAY_GET_CONTEXT }, expect.any(Function)));
    const host = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!;
    host.shadowRoot!.querySelector<HTMLButtonElement>("[data-overlay-minimize]")!.click();
    let complete: ((response?: unknown) => void) | undefined;
    sendMessage.mockClear();
    sendMessage.mockImplementation((_message: unknown, callback: unknown) => {
      complete = callback as (response?: unknown) => void;
      return Promise.resolve(undefined);
    });
    listeners[1]({ type: MSG.OVERLAY_VIEW_CHANGED }, { id: "extension-id" }, () => undefined);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(overlay.getOverlayState()).toBe("MINIMIZED");
    host.shadowRoot!.querySelector<HTMLButtonElement>("[data-overlay-close]")!.click();
    complete!({ ok: true, context: { available: true, tabId: 41, status: "bound" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(overlay.getOverlayState()).toBe("ABSENT");
    expect(document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    expect(listeners).toHaveLength(1);
  });

  it.each(["pageshow", "visibilitychange"])("recovers missed events on %s and removes the listener on close", async (eventName) => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    show();
    const sendMessage = vi.mocked(chrome.runtime.sendMessage);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: MSG.OVERLAY_GET_CONTEXT }, expect.any(Function)));
    sendMessage.mockClear();
    const target = eventName === "visibilitychange" ? document : window;
    target.dispatchEvent(new Event(eventName));
    target.dispatchEvent(new Event(eventName));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenNthCalledWith(1, { type: MSG.TOOLBAR_OVERLAY_READY }, expect.any(Function));
    document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!.shadowRoot!.querySelector<HTMLButtonElement>("[data-overlay-close]")!.click();
    sendMessage.mockClear();
    target.dispatchEvent(new Event(eventName));
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps documents independent and does not auto-open after navigation", () => {
    const tabA = document.implementation.createHTMLDocument("A");
    const tabB = document.implementation.createHTMLDocument("B");
    const a = assistant.reopenApplicationAssistantOverlay(tabA);
    expect(tabA.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeTruthy();
    expect(tabB.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    const b = assistant.reopenApplicationAssistantOverlay(tabB);
    a.overlay.destroy();
    expect(tabA.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    expect(tabB.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBe(b.overlay.host);
    b.overlay.destroy();
  });

  it("keeps fresh-document workflow startup detached until explicit SHOW", () => {
    const widget = widgetModule.createWidget({ retry: vi.fn(), clear: vi.fn(), complete: vi.fn() });
    widget.update({ stage: "review", total: 3, filled: 0 });
    expect(overlay.getOverlayState()).toBe("ABSENT");
    expect(document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    expect(listeners).toHaveLength(1);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    show();
    const host = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!;
    const surface = host.shadowRoot!.querySelector("[data-overlay-workflow-facade]");
    expect(surface).toBeTruthy();
    host.shadowRoot!.querySelector<HTMLButtonElement>("[data-overlay-close]")!.click();
    widget.update({ stage: "ready", total: 3, filled: 3 });
    expect(document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    show();
    expect(document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!.shadowRoot!.querySelector("[data-overlay-workflow-facade]")).toBe(surface);
    expect(document.querySelectorAll(`#${overlay.APPLICATION_OVERLAY_HOST_ID}`)).toHaveLength(1);
    widget.destroy();
  });

  it("renders a toolbar placeholder without a workflow and fetches the real view on reopen", async () => {
    let view = { tabId: 41, sessionId: null as number | null, requestId: "toolbar", state: "idle",
      fieldsDiscovered: 0, filled: 0, reviewRequired: 0, skipped: 0, contentReady: true, packageLoaded: false,
      running: false, requiredReviewRemaining: 0, reachedFinalStep: false };
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((message: any, callback: any) => {
      callback(message.type === MSG.OVERLAY_GET_CONTEXT
        ? { ok: true, context: { available: true, status: "bound", tabId: 41 } }
        : message.type === MSG.OVERLAY_GET_VIEW ? { ok: true, view } : { ok: true });
      return Promise.resolve(undefined);
    });
    show();
    const counts = () => {
      const root = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!.shadowRoot!;
      return ["discovered", "filled", "review"].map(id => Number(root.getElementById(id)!.textContent));
    };
    await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.OVERLAY_GET_VIEW }, expect.any(Function)));
    expect(counts()).toEqual([0, 0, 0]);
    overlay.destroyOverlay(document);
    view = { ...view, sessionId: 911, requestId: "workflow", state: "completed_with_review", packageLoaded: true,
      fieldsDiscovered: 4, filled: 3, reviewRequired: 1 };
    show();
    await vi.waitFor(() => expect(counts()).toEqual([4, 3, 1]));
    expect(listeners).toHaveLength(2);
  });

  it("reopens from the retained workflow owner, never detached discovery counts", async () => {
    const { claimWorkflowContentInstance } = await import("../content/instance");
    const world: Record<string, unknown> = {};
    const owner = claimWorkflowContentInstance(world, "workflow", "same-build", () => true);
    let view = { tabId: 41, sessionId: 911, fieldsDiscovered: 4, filled: 3, reviewRequired: 1, skipped: 0,
      requiredReviewRemaining: 0, state: "completed_with_review", contentReady: true, packageLoaded: true,
      running: false, reachedFinalStep: true };
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((message: any, callback: any) => {
      callback(message.type === MSG.OVERLAY_GET_CONTEXT
        ? { ok: true, context: { available: true, status: "bound", tabId: 41 } }
        : message.type === MSG.OVERLAY_GET_VIEW ? { ok: true, view } : { ok: true });
      return Promise.resolve(undefined);
    });
    const facade = widgetModule.createWidget({ retry: vi.fn(), clear: vi.fn(), complete: vi.fn() });
    facade.update({ stage: "review", total: 4, filled: 0 });
    const counts = () => {
      const root = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!.shadowRoot!;
      return ["discovered", "filled", "review"].map(id => Number(root.getElementById(id)!.textContent));
    };
    const interval = vi.spyOn(window, "setInterval");
    show();
    await vi.waitFor(() => expect(counts()).toEqual([4, 3, 1]));
    overlay.destroyOverlay(document);
    facade.update({ stage: "review", total: 4, filled: 0 });
    expect(document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    const reinjected = claimWorkflowContentInstance(world, "toolbar-reinjection", "same-build", () => true);
    // This is the production startup branch: a new owner publishes read-only
    // discovery. A retained live owner must prevent that destructive startup.
    if (reinjected()) view = { ...view, filled: 0, reviewRequired: 4 };
    show();
    await vi.waitFor(() => expect(counts()).toEqual([4, 3, 1]));
    expect(owner()).toBe(true);
    expect(listeners).toHaveLength(2);
    expect(document.querySelectorAll(`#${overlay.APPLICATION_OVERLAY_HOST_ID}`)).toHaveLength(1);
    expect(interval).not.toHaveBeenCalled();
    facade.destroy();
  });

  it("does not transfer workflow presentation or opening authority to a new document", () => {
    const oldDocument = document.implementation.createHTMLDocument("old");
    const newDocument = document.implementation.createHTMLDocument("new");
    const surface = oldDocument.createElement("div");
    const dispose = assistant.registerApplicationOverlayWorkflowSurface(surface, oldDocument);
    assistant.reopenApplicationAssistantOverlay(oldDocument).overlay.minimize();
    const newSurface = newDocument.createElement("div");
    const disposeNew = assistant.registerApplicationOverlayWorkflowSurface(newSurface, newDocument);
    expect(newDocument.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    expect(surface.isConnected).toBe(true);
    expect(newSurface.isConnected).toBe(false);
    assistant.reopenApplicationAssistantOverlay(newDocument);
    expect(newSurface.isConnected).toBe(true);
    expect(overlay.getOverlayState(oldDocument)).toBe("MINIMIZED");
    dispose(); disposeNew();
  });

  it("converges toolbar-first and workflow activation on the same host", () => {
    show();
    const first = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID);
    const widget = widgetModule.createWidget({ retry: vi.fn(), clear: vi.fn(), complete: vi.fn() });
    expect(document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)).toBe(first);
    expect(document.querySelectorAll(`#${overlay.APPLICATION_OVERLAY_HOST_ID}`)).toHaveLength(1);
    expect(document.getElementById("jobpilot-assisted-apply")).toBeNull();
    widget.destroy();
  });

  it("keeps production diagnostics out of the consumer overlay", () => {
    show();
    const text = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)?.shadowRoot?.textContent ?? "";
    for (const technical of ["Diagnostics", "overlayBuild", "builtAt", "protocol", "tabId", "documentId", "contentReady", "packageLoaded", "lastFailure"]) {
      expect(text).not.toContain(technical);
    }
  });

  it("uses a responsive bottom-right glass surface for panel and restore pill", () => {
    show();
    const css = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)?.shadowRoot?.querySelector("style")?.textContent ?? "";
    const panelRule = css.match(/\.panel\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(panelRule).toContain("right: 18px");
    expect(panelRule).toContain("bottom: 18px");
    expect(panelRule).not.toMatch(/(?:^|;)\s*top\s*:/);
    expect(panelRule).toContain("rgba(250, 252, 253, 0.84)");
    expect(panelRule).toContain("backdrop-filter: blur(22px) saturate(145%)");
    expect(panelRule).toContain("border-radius: 24px");
    expect(panelRule).toContain("0 18px 50px");
    expect(css).toMatch(/\.restore-pill\s*\{[^}]*bottom: 16px/s);
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});
