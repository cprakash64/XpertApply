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
        onMessage: { addListener: (listener: Listener) => listeners.push(listener) }
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

  it("owns one bounded refresh timer per mount and clears it on close and reopen", () => {
    const interval = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");
    show();
    const first = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!;
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 1_000);
    show();
    first.shadowRoot?.querySelector<HTMLButtonElement>("[data-overlay-minimize]")?.click();
    show();
    expect(interval).toHaveBeenCalledTimes(1);
    first.shadowRoot?.querySelector<HTMLButtonElement>("[data-overlay-close]")?.click();
    expect(clear).toHaveBeenCalledTimes(1);
    show();
    expect(interval).toHaveBeenCalledTimes(2);
    overlay.destroyOverlay(document);
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("self-disposes if its host is disconnected before the next refresh", () => {
    let tick: (() => void) | undefined;
    const interval = vi.spyOn(window, "setInterval").mockImplementation(((callback: TimerHandler) => {
      tick = callback as () => void;
      return 77;
    }) as typeof window.setInterval);
    const clear = vi.spyOn(window, "clearInterval");
    show();
    const host = document.getElementById(overlay.APPLICATION_OVERLAY_HOST_ID)!;
    host.remove();
    expect(() => tick?.()).not.toThrow();
    expect(clear).toHaveBeenCalledWith(77);
    expect(interval).toHaveBeenCalledTimes(1);
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
