/* TEMP PROBE — can this harness grant an optional host permission? */
import { chromium, test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

test.setTimeout(90_000);
test("probe", async () => {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20_000 }));
  const id = new URL(worker.url()).host;

  const before = await worker.evaluate(async () => chrome.permissions.getAll());
  console.log("PROBE before " + JSON.stringify(before));

  // (a) from the service worker — expected to fail (no user gesture)
  const fromWorker = await worker.evaluate(async () =>
    chrome.permissions.request({ origins: ["https://careers.example.test/*"] })
      .then((g) => `resolved:${g}`).catch((e) => `threw:${String(e).slice(0, 90)}`));
  console.log("PROBE fromWorker " + fromWorker);

  // (b) from an extension page with a real Playwright click
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "probe";
    b.textContent = "probe";
    b.addEventListener("click", () => {
      (window as unknown as { __r?: Promise<unknown> }).__r =
        chrome.permissions.request({ origins: ["https://careers.example.test/*"] })
          .then((g) => `resolved:${g}`).catch((e) => `threw:${String(e).slice(0, 90)}`);
    });
    document.body.appendChild(b);
  });
  await page.click("#probe");
  const fromPage = await Promise.race([
    page.evaluate(() => (window as unknown as { __r: Promise<unknown> }).__r),
    new Promise((r) => setTimeout(() => r("TIMEOUT(dialog blocked)"), 8000))
  ]);
  console.log("PROBE fromPage " + String(fromPage));

  const after = await worker.evaluate(async () => chrome.permissions.getAll());
  console.log("PROBE after " + JSON.stringify(after));
  await ctx.close();
  expect(true).toBe(true);
});
