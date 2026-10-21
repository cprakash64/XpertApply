import { expect, test, chromium } from "@playwright/test";
import { OwnedPackageFixture } from "./owned-package-fixture";
import path from "node:path";

/**
 * The PRODUCTION build (dist/, not the pre-granted e2e build) holds no host
 * access to an arbitrary employer site: the toolbar path's only authority is
 * activeTab, which Chrome grants for one tab on a real toolbar click. Automation
 * cannot press that button, so what this proves is the negative half: with no
 * click and no per-origin grant, the extension cannot inject into, or read, an
 * ordinary page, and no broad optional grant is silently held.
 */
const DIST = path.resolve("dist");

test("production build cannot reach an ordinary page without a toolbar click or per-origin grant", async () => {
  test.setTimeout(60_000);
  const fx = await new OwnedPackageFixture(`<!doctype html><title>Employer</title><form><input name="email"></form>`).start();
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium", serviceWorkers: "allow",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`]
  });
  try {
    const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await ctx.newPage();
    await page.goto(`${fx.origin}/apply`);
    const result = await worker.evaluate(async (origin) => {
      const tab = (await chrome.tabs.query({})).find(t => t.url?.startsWith(origin))!;
      let injected = "no error";
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [0] }, files: ["overlayBootstrap.js"] }); }
      catch (e) { injected = String((e as Error).message); }
      const granted = await chrome.permissions.getAll();
      return {
        injected,
        broadGrant: await chrome.permissions.contains({ origins: ["https://example.com/*"] }),
        origins: granted.origins,
        hasHook: "__xaToolbarClick" in globalThis
      };
    }, fx.origin);
    console.log("ACTIVETAB_BOUNDARY " + JSON.stringify(result));
    expect(result.injected).toMatch(/Cannot access contents of the page|must request permission/i);
    expect(result.broadGrant).toBe(false);
    expect([...(result.origins ?? [])].sort()).toEqual(["https://api.xpertapply.com/*", "https://www.xpertapply.com/*", "https://xpertapply.com/*"]);
    expect(result.hasHook).toBe(false);
    await expect(page.locator("#xpertapply-assistant-overlay-v1, #xpertapply-toolbar-disclosure-v1")).toHaveCount(0);
  } finally { await ctx.close(); await fx.close().catch(() => undefined); }
});
