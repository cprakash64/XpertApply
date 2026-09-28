import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPLICATION_OVERLAY_HOST_ID,
  destroyOverlay,
  ensureOverlay,
  focusOverlay,
  getOverlayState,
  hideOverlay,
  minimizeOverlay,
  restoreOverlay,
  showOverlay
} from "../content/applicationOverlay";

function shell() {
  const host = document.getElementById(APPLICATION_OVERLAY_HOST_ID) as HTMLElement | null;
  const root = host?.shadowRoot ?? null;
  return {
    host,
    root,
    panel: root?.querySelector<HTMLElement>("[data-overlay-panel]") ?? null,
    pill: root?.querySelector<HTMLButtonElement>("[data-overlay-restore]") ?? null
  };
}

afterEach(() => {
  destroyOverlay(document);
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
});

describe("application overlay lifecycle", () => {
  it("creates exactly one collision-resistant host with an open ShadowRoot", () => {
    const first = ensureOverlay(document);
    const second = ensureOverlay(document);
    expect(first).toBe(second);
    expect(first.host.id).toBe(APPLICATION_OVERLAY_HOST_ID);
    expect(first.root.mode).toBe("open");
    expect(first.host.shadowRoot).toBe(first.root);
    expect(document.querySelectorAll(`#${APPLICATION_OVERLAY_HOST_ID}`)).toHaveLength(1);
    expect(getOverlayState(document)).toBe("HIDDEN");
  });

  it("moves idempotently through open, minimized, restored and hidden states", () => {
    showOverlay(document);
    showOverlay(document);
    expect(getOverlayState(document)).toBe("OPEN");
    expect(shell().panel?.hidden).toBe(false);
    expect(shell().pill?.hidden).toBe(true);

    minimizeOverlay(document);
    minimizeOverlay(document);
    expect(getOverlayState(document)).toBe("MINIMIZED");
    expect(shell().panel?.hidden).toBe(true);
    expect(shell().pill?.hidden).toBe(false);

    restoreOverlay(document);
    expect(getOverlayState(document)).toBe("OPEN");
    expect(shell().panel?.hidden).toBe(false);
    expect(shell().pill?.hidden).toBe(true);

    hideOverlay(document);
    expect(getOverlayState(document)).toBe("HIDDEN");
    expect(shell().panel?.hidden).toBe(true);
    expect(shell().pill?.hidden).toBe(true);
  });

  it("wires minimize, restore, and close without showing panel and pill together", () => {
    showOverlay(document);
    const root = shell().root!;
    root.querySelector<HTMLButtonElement>("[data-overlay-minimize]")!.click();
    expect(getOverlayState(document)).toBe("MINIMIZED");
    expect(shell().panel?.hidden).not.toBe(shell().pill?.hidden);

    root.querySelector<HTMLButtonElement>("[data-overlay-restore]")!.click();
    expect(getOverlayState(document)).toBe("OPEN");
    expect(shell().panel?.hidden).not.toBe(shell().pill?.hidden);

    root.querySelector<HTMLButtonElement>("[data-overlay-close]")!.click();
    expect(getOverlayState(document)).toBe("ABSENT");
    expect(document.getElementById(APPLICATION_OVERLAY_HOST_ID)).toBeNull();
  });

  it("destroys idempotently and removes owned listeners", () => {
    const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const overlay = showOverlay(document);
    overlay.destroy();
    overlay.destroy();
    expect(getOverlayState(document)).toBe("ABSENT");
    expect(remove).toHaveBeenCalledTimes(3);
    remove.mockRestore();
  });

  it("reconstructs after its tracked host becomes disconnected", () => {
    const first = ensureOverlay(document);
    first.host.remove();
    const second = ensureOverlay(document);
    expect(second).not.toBe(first);
    expect(second.host.isConnected).toBe(true);
    expect(document.querySelectorAll(`#${APPLICATION_OVERLAY_HOST_ID}`)).toHaveLength(1);
  });

  it("does not replace an unrelated element that collides with the host id", () => {
    const employerNode = document.createElement("div");
    employerNode.id = APPLICATION_OVERLAY_HOST_ID;
    document.body.appendChild(employerNode);
    expect(() => ensureOverlay(document)).toThrow("XPERTAPPLY_OVERLAY_HOST_ID_COLLISION");
    expect(document.getElementById(APPLICATION_OVERLAY_HOST_ID)).toBe(employerNode);
  });
});

describe("application overlay isolation and accessibility", () => {
  it("keeps presentation CSS inside the ShadowRoot and leaves employer styles untouched", () => {
    document.body.style.cssText = "overflow: scroll; color: rgb(255, 0, 0)";
    const before = document.body.getAttribute("style");
    const employerForm = document.createElement("form");
    employerForm.className = "panel";
    document.body.appendChild(employerForm);
    const overlay = showOverlay(document);
    const css = overlay.root.querySelector("style")?.textContent ?? "";
    expect(css).toContain(":host");
    expect(css).toContain("all: initial");
    expect(css).toContain("pointer-events: none");
    expect(css).toContain("pointer-events: auto");
    expect(css).toContain("z-index: 2147483000");
    expect(document.head.querySelector("style")).toBeNull();
    expect(document.body.getAttribute("style")).toBe(before);
    expect(employerForm.className).toBe("panel");
    expect(employerForm.children).toHaveLength(0);
  });

  it("uses a labelled non-modal complementary landmark and accessible controls", () => {
    const overlay = showOverlay(document);
    const aside = overlay.root.querySelector("aside")!;
    expect(aside.getAttribute("role")).toBe("complementary");
    expect(aside.getAttribute("aria-labelledby")).toBe("xpertapply-overlay-heading");
    expect(overlay.root.querySelector("[aria-modal]")).toBeNull();
    expect(overlay.root.querySelector('[aria-label="Minimize XpertApply assistant"]')).toBeTruthy();
    expect(overlay.root.querySelector('[aria-label="Close XpertApply assistant"]')).toBeTruthy();
    expect(overlay.root.querySelector('[aria-label="Restore XpertApply assistant"]')).toBeTruthy();
    expect(overlay.root.querySelector('[role="status"]')?.textContent).toContain("Ready when you are");
  });

  it("provides visible focus and reduced-motion rules without automatic focus stealing", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const overlay = showOverlay(document);
    const css = overlay.root.querySelector("style")?.textContent ?? "";
    expect(document.activeElement).toBe(outside);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion: reduce");
    focusOverlay(document);
    expect(overlay.root.activeElement?.id).toBe("xpertapply-overlay-heading");
  });

  it("uses responsive bounds without a backdrop or page-wide interactive surface", () => {
    const overlay = showOverlay(document);
    const css = overlay.root.querySelector("style")?.textContent ?? "";
    expect(css).toContain("width: min(410px, calc(100vw - 28px))");
    expect(css).toContain("max-width: 420px");
    expect(css).toContain("max-height: min(760px, calc(100dvh - 36px))");
    expect(css).toContain("right: 18px; bottom: 18px");
    expect(overlay.root.querySelector("[data-backdrop]")).toBeNull();
    expect(overlay.host.style.pointerEvents).toBe("");
  });

  it("does not clear unrelated document-local application state", () => {
    document.documentElement.dataset.applicationLedger = "preserve";
    showOverlay(document);
    destroyOverlay(document);
    expect(document.documentElement.dataset.applicationLedger).toBe("preserve");
  });

  it("does not activate beside the production widget merely by importing the module", () => {
    const widget = document.createElement("div");
    widget.id = "jobpilot-assisted-apply";
    document.documentElement.appendChild(widget);
    expect(getOverlayState(document)).toBe("ABSENT");
    expect(document.getElementById(APPLICATION_OVERLAY_HOST_ID)).toBeNull();
    expect(document.getElementById("jobpilot-assisted-apply")).toBe(widget);
  });
});
