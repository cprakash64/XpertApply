import { afterEach, describe, expect, it } from "vitest";
import { isolateHost, isolatedTextBase } from "../content/hostIsolation";
import { destroyOverlay, showOverlay } from "../content/applicationOverlay";
import { showToolbarDisclosure, TOOLBAR_DISCLOSURE_HOST_ID } from "../content/toolbarDisclosure";
import { fieldStatusPresentationCssForTest } from "../fields/statusPresentation";

afterEach(() => { destroyOverlay(document); document.getElementById(TOOLBAR_DISCLOSURE_HOST_ID)?.remove(); document.body.innerHTML = ""; });

// Reproduced in a real Chromium: `div{line-height:.55}` on the employer page reached the overlay host (a div) and, inherited into the
// closed shadow tree, made the panel's counts overlap their labels. Page rules out-rank `:host`, so the host's own properties and the
// first element inside the shadow root are the places to pin them.
describe("XA-EXT-PANEL-05 host isolation", () => {
  it("pins the host's geometry and inheritance inline with !important", () => {
    const host = document.createElement("div");
    isolateHost(host, { zIndex: 7 });
    for (const property of ["all", "position", "pointer-events", "display"]) {
      expect(host.style.getPropertyPriority(property), property).toBe("important");
    }
    expect(host.style.getPropertyValue("pointer-events")).toBe("none");
    expect(host.style.getPropertyValue("z-index")).toBe("7");
  });

  it("resets every inheritable text property that a page could set on a div", () => {
    const css = isolatedTextBase({ fontFamily: "sans-serif", fontSize: "14px", lineHeight: "1.45", color: "#000" });
    for (const needle of ["all:initial", "line-height:1.45", "letter-spacing:normal", "word-spacing:normal", "text-transform:none", "text-align:left", "white-space:normal", "text-indent:0", "direction:ltr"]) {
      expect(css).toContain(needle);
    }
  });

  it("the assistant overlay host and its first inner element are isolated", () => {
    const overlay = showOverlay(document);
    expect(overlay.host.style.getPropertyPriority("position")).toBe("important");
    const css = overlay.root.querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/\[data-overlay-root\]\s*\{\s*all:initial;/);
    expect(css).toContain("line-height:1.45");
  });

  it("the toolbar disclosure host and box are isolated", () => {
    showToolbarDisclosure(document);
    const host = document.getElementById(TOOLBAR_DISCLOSURE_HOST_ID)!;
    expect(host.style.getPropertyPriority("position")).toBe("important");
  });

  it("each field badge restarts its text properties", () => {
    expect(fieldStatusPresentationCssForTest()).toMatch(/\.status\{all:initial;/);
  });
});
