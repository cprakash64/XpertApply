import { expect, test, chromium } from "@playwright/test";
import { OwnedPackageFixture } from "./owned-package-fixture";
import { containSyntheticNetwork } from "./network-containment";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";
import { overlayCdp } from "./overlay-cdp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

/**
 * A script on the employer page must not be able to read or operate the overlay.
 *
 * The overlay lives in the page's own DOM, so this holds only while its shadow roots
 * are CLOSED. 0.2.0 was closed; 0.3.0 shipped open roots and every E2E spec still
 * passed, because Playwright's locators pierce open roots and the specs were written
 * against that. This spec is the one that fails if it happens again, in a real
 * browser, against the real extension.
 *
 * The page below is hostile in the way that matters: its script runs BEFORE the
 * extension injects anything and hooks Element.prototype.attachShadow in the page's
 * main world, which is the classic way to capture a closed root if the code creating
 * it shares that world. The extension's content script runs in an isolated world with
 * its own Element.prototype, so the hook must never fire.
 */
const fixture = `<!doctype html><meta charset="utf-8"><title>Hostile employer page</title>
<script>
  window.__hostile = { attachShadowCalls: 0, modes: [] };
  const realAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    window.__hostile.attachShadowCalls++;
    window.__hostile.modes.push(init && init.mode);
    return realAttachShadow.call(this, init);
  };
</script>
<main><h1>Apply for Software Engineer</h1>
<form id="application"><label>Email <input id="email" name="email" type="email"></label>
<button type="submit">Submit application</button></form></main>`;

const HOST_ID = "xpertapply-assistant-overlay-v1";

test("a hostile script on the employer page cannot read or operate the overlay", async () => {
  test.setTimeout(90_000);
  const apiFixture = await new OwnedPackageFixture(fixture).start();
  const applicationUrl = `${apiFixture.origin}/apply`;
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  const network = await containSyntheticNetwork(context);

  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await context.newPage();
    await page.goto(applicationUrl);
    await CanonicalOverlayDriver.openFromToolbar(page, worker);
    const ov = overlayCdp(page);

    // Positive control: the overlay exists and is fully reachable the way the DevTools Protocol
    // reaches it, so a null from the page below means "closed", not "never rendered".
    expect(await ov.count("#fill")).toBe(1);
    expect(await ov.count("[data-overlay-minimize]")).toBe(1);
    expect(await ov.count("[data-overlay-close]")).toBe(1);
    expect(await ov.text("#stage")).toBeTruthy();
    await expect.poll(() => ov.isVisible("[data-overlay-panel]")).toBe(true);

    // What a script in the page's own world can see.
    const hostile = await page.evaluate((hostId) => {
      const host = document.getElementById(hostId);
      const seen: Element[] = [];
      const walk = (scope: ParentNode): void => {
        for (const element of Array.from(scope.querySelectorAll("*"))) {
          seen.push(element);
          if (element.shadowRoot) walk(element.shadowRoot);
        }
      };
      walk(document);
      const text = seen.map((element) => element.textContent ?? "").join("\n");
      const hostile = (window as unknown as { __hostile: { attachShadowCalls: number } }).__hostile;
      // Read the hook BEFORE the page makes its own attachShadow call below, which would count too.
      const hookFiredByExtension = hostile.attachShadowCalls;
      let reattach = "no-throw";
      try { host?.attachShadow({ mode: "open" }); } catch (error) { reattach = (error as Error).name; }
      return {
        hostPresent: Boolean(host),
        shadowRoot: host ? host.shadowRoot : "no host",
        hostLightChildren: host ? host.children.length : -1,
        hostLightText: host ? host.textContent : null,
        controlsFound: ["[data-overlay-close]", "[data-overlay-minimize]", "[data-overlay-panel]", "#fill", "#complete", "[data-overlay-workflow-facade]"]
          .map((selector) => seen.filter((element) => element.matches(selector)).length),
        overlayTextVisible: /Fill application|Mark application complete|Waiting for an application|XpertApply/.test(text),
        hookFiredByExtension,
        // The page's own call just above must have been counted, which proves the hook is live.
        hookFiredAfterPageCall: hostile.attachShadowCalls,
        reattach
      };
    }, HOST_ID);

    expect(hostile.hostPresent).toBe(true);
    expect(hostile.shadowRoot, "host.shadowRoot must be null: the root is closed").toBeNull();
    expect(hostile.hostLightChildren).toBe(0);
    expect(hostile.hostLightText).toBe("");
    expect(hostile.controlsFound, "no overlay control may be enumerable from the page").toEqual([0, 0, 0, 0, 0, 0]);
    expect(hostile.overlayTextVisible, "no overlay text may be readable from the page").toBe(false);
    expect(hostile.hookFiredByExtension, "the page's attachShadow hook must never see the extension's roots").toBe(0);
    expect(hostile.hookFiredAfterPageCall, "non-vacuity: the hook does fire for a call made from the page's own world").toBe(1);
    expect(hostile.reattach, "the page must not be able to attach its own root to the host").not.toBe("no-throw");

    // Try to operate the overlay through everything the page can reach: aim at the Minimize button's
    // own coordinates, and click whatever the page's hit-test returns, plus the host itself.
    const point = await ov.evaluate((root) => {
      const box = root.querySelector<HTMLElement>("[data-overlay-minimize]")!.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    const attempt = await page.evaluate(({ x, y, hostId }) => {
      const host = document.getElementById(hostId)!;
      const hit = document.elementFromPoint(x, y);
      hit?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, clientX: x, clientY: y }));
      (hit as HTMLElement | null)?.click();
      host.click();
      host.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, clientX: x, clientY: y }));
      return { hitIsHost: hit === host, hitTag: hit?.tagName ?? null, state: host.dataset.overlayState };
    }, { ...point, hostId: HOST_ID });
    expect(attempt.hitIsHost, "the page's hit-test must report only the host, never an inner control").toBe(true);

    // Nothing happened: still open, panel still showing.
    await page.waitForTimeout(300);
    expect(await page.evaluate((hostId) => document.getElementById(hostId)!.dataset.overlayState, HOST_ID)).toBe("open");
    expect(await ov.isVisible("[data-overlay-panel]")).toBe(true);

    // Positive control for the click path: a genuine user click on the very same button DOES work,
    // so the failed attempts above were isolation, not an inert button.
    await ov.click("[data-overlay-minimize]");
    await expect.poll(() => page.evaluate((hostId) => document.getElementById(hostId)!.dataset.overlayState, HOST_ID)).toBe("minimized");

    network.assertContained();
    await page.close();
  } finally {
    await context.close();
    await apiFixture.close();
  }
});
