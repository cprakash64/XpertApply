import { expect, type Page } from "@playwright/test";

const AXE = require.resolve("axe-core/axe.min.js");

/**
 * Injects axe-core as an inline script and proves it is usable.
 *
 * Under the Report-Only CSP, WebKit EXECUTES the injected script but logs the (non-blocking) violation to the console as an
 * error, and Playwright's WebKit driver then rejects `addScriptTag` although the script ran; Chromium resolves. The rejection is
 * therefore tolerated only if `window.axe.run` really exists afterwards, so a script that was genuinely blocked still fails
 * the test and no accessibility coverage is removed.
 */
export async function injectAxe(page: Page) {
  try {
    await page.addScriptTag({ path: AXE });
  } catch (error) {
    if (!(await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe === "object"))) throw error;
  }
  expect(await page.evaluate(() => typeof (window as unknown as { axe?: { run?: unknown } }).axe?.run)).toBe("function");
}
