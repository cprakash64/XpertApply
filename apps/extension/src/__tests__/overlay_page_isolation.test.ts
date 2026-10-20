/**
 * Page-world code must not be able to read or operate the overlay.
 *
 * The overlay and the nested review widget live inside the employer page's own
 * DOM. That is safe only while their shadow roots are CLOSED: with an open root,
 * any script on the page - the ATS's own, or a third-party tag - can read what the
 * overlay shows (job, company, progress) and synthesise clicks on Fill, Clear and
 * Mark complete. 0.2.0 was closed ("Neither of those may be relaxed for testing",
 * e2e/widget-driver.ts); 0.3.0 shipped both roots open, and nothing failed, because
 * the unit suite had been rewritten to expect "open". These tests are what would
 * have caught it.
 *
 * Two layers: what a hostile page script can actually reach, and a scan of the
 * shipped source so no `attachShadow` can be opened again without a red test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createWidget } from "../content/widget";
import { APPLICATION_OVERLAY_HOST_ID, destroyOverlay } from "../content/applicationOverlay";
import { reopenApplicationAssistantOverlay } from "../content/applicationOverlayAssistant";
import { installShadowRootCapture, restoreShadowRootCapture, rootOf } from "./shadowRootCapture";

beforeEach(() => {
  installShadowRootCapture();
});

afterEach(() => {
  restoreShadowRootCapture();
  destroyOverlay(document);
  document.getElementById(APPLICATION_OVERLAY_HOST_ID)?.remove();
  document.body.innerHTML = "";
});

/** Everything a script running in the page's own world can enumerate: every
 * element, plus whatever each element's `.shadowRoot` exposes, recursively. */
function whatPageScriptCanSee(): { elements: Element[]; texts: string[] } {
  const elements: Element[] = [];
  const texts: string[] = [];
  const walk = (scope: ParentNode): void => {
    for (const element of Array.from(scope.querySelectorAll("*"))) {
      elements.push(element);
      texts.push(element.textContent ?? "");
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  return { elements, texts };
}

const OVERLAY_ONLY_SELECTORS = [
  "[data-overlay-close]", "[data-overlay-minimize]", "[data-overlay-restore]", "[data-overlay-panel]",
  "#fill", "#clear", "#complete", "#rescan", "#grantSiteAccess", "[data-overlay-workflow-facade]"
];

describe("a script on the employer page cannot reach the overlay", () => {
  function mountOverlayWithWidget() {
    reopenApplicationAssistantOverlay(document);
    const widget = createWidget({ retry: () => {}, clear: () => {}, complete: () => {} });
    widget.update({ stage: "review", total: 3, filled: 1, message: "Software Engineer at Hostile Corp" });
    return { host: document.getElementById(APPLICATION_OVERLAY_HOST_ID)!, widget };
  }

  it("gets null from host.shadowRoot for the overlay and for the nested widget", () => {
    const { host, widget } = mountOverlayWithWidget();

    expect(host).not.toBeNull();
    expect(host.shadowRoot).toBeNull();
    // The extension's own capture proves a root exists and is closed; the page just cannot see it.
    expect(rootOf(host)?.mode).toBe("closed");

    const facade = rootOf(host)!.querySelector<HTMLElement>("[data-overlay-workflow-facade]");
    expect(facade, "the widget surface is mounted inside the overlay").not.toBeNull();
    expect(facade!.shadowRoot).toBeNull();
    expect(rootOf(facade)?.mode).toBe("closed");
    widget.destroy();
  });

  it("cannot find any overlay control or read any overlay text by walking the page", () => {
    const { widget } = mountOverlayWithWidget();
    // Sanity: the controls and the text really do exist for the extension.
    const inside = rootOf(document.getElementById(APPLICATION_OVERLAY_HOST_ID))!;
    expect(inside.querySelector("#fill")).not.toBeNull();
    const facade = inside.querySelector<HTMLElement>("[data-overlay-workflow-facade]")!;
    expect(rootOf(facade)!.textContent).toContain("Hostile Corp");

    const seen = whatPageScriptCanSee();
    for (const selector of OVERLAY_ONLY_SELECTORS) {
      expect(seen.elements.filter((element) => element.matches(selector)), `page script must not find ${selector}`).toHaveLength(0);
    }
    expect(seen.texts.join("\n")).not.toContain("Hostile Corp");
    expect(seen.texts.join("\n")).not.toContain("Fill application");
    widget.destroy();
  });

  it("sees an empty host element: nothing leaks through its light DOM", () => {
    const { host, widget } = mountOverlayWithWidget();
    expect(host.children).toHaveLength(0);
    expect(host.textContent).toBe("");
    expect(host.innerHTML).toBe("");
    widget.destroy();
  });

  it("cannot attach its own root to take the overlay's place", () => {
    const { host, widget } = mountOverlayWithWidget();
    expect(() => host.attachShadow({ mode: "open" })).toThrow();
    widget.destroy();
  });
});

describe("shipped source never opens a shadow root", () => {
  // src/e2e-harness.ts is built only by e2e/build-harness.mjs for the dropdown
  // harness page; it is not an entry point of the extension (see build.mjs).
  const HARNESS_ONLY = new Set(["e2e-harness.ts"]);
  const root = path.resolve(__dirname, "..");

  function shippedSourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : shippedSourceFiles(full);
      return entry.name.endsWith(".ts") && !HARNESS_ONLY.has(entry.name) ? [full] : [];
    });
  }

  it("finds the files it is supposed to scan", () => {
    const files = shippedSourceFiles(root).map((file) => path.relative(root, file));
    expect(files).toContain(path.join("content", "applicationOverlay.ts"));
    expect(files).toContain(path.join("content", "widget.ts"));
    expect(files.some((file) => file.includes("__tests__"))).toBe(false);
  });

  it("has no attachShadow call with mode: open", () => {
    const offenders: string[] = [];
    for (const file of shippedSourceFiles(root)) {
      const text = readFileSync(file, "utf8");
      // Matches `attachShadow({ mode: "open" ...` and `attachShadow({ ...init, mode: 'open' })`.
      if (/attachShadow\(\s*\{[^)]*mode\s*:\s*["'`]open["'`]/s.test(text)) offenders.push(path.relative(root, file));
      // A computed mode could hide an open root from the check above.
      if (/attachShadow\(\s*\{[^)]*mode\s*:\s*(?=[^\s"'`])/s.test(text)) offenders.push(`${path.relative(root, file)} (non-literal mode)`);
    }
    expect(offenders, "every shadow root in shipped code must be { mode: \"closed\" }").toEqual([]);
  });
});
