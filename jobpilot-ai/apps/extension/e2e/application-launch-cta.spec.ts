import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");
const listing = fs.readFileSync(path.join(here, "fixtures", "application-launch-listing.html"), "utf8");
const destination = fs.readFileSync(path.join(here, "fixtures", "application-launch-destination.html"), "utf8");

test("I’m interested wins over referral and a pre-click launch survives a new-tab external ATS handoff", async ({ page, context }) => {
  await context.route("https://careers.servicenow.example/job/123", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: listing }));
  await context.route("https://acme.wd5.myworkdayjobs.com/apply/123", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: destination }));

  await page.goto("https://careers.servicenow.example/job/123");
  await page.addScriptTag({ path: HARNESS });
  expect(await page.evaluate(() => (window as any).JobPilotHarness.selected())).toMatchObject({
    name: "I’m interested",
    reason: "interest_application_cta_in_main_content"
  });
  expect(await page.evaluate(() => (window as any).JobPilotHarness.candidates())).toEqual([
    expect.objectContaining({ name: "I’m interested" })
  ]);

  await page.evaluate(() => {
    (window as any).pendingApplicationLaunch = {
      launchId: "fixture-launch-1",
      applicationId: "55",
      sourceTabId: 1,
      sourceUrl: "https://careers.servicenow.example/job/123",
      jobFingerprint: "fixture-job",
      extensionBuildId: "fixture-build",
      expiration: Date.now() + 90_000,
      state: "PENDING_NAVIGATION"
    };
  });
  const popupPromise = page.waitForEvent("popup");
  await page.locator("#interest").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(popup.locator("#application-form")).toBeVisible();
  expect(await popup.evaluate(() => (window as any).jobpilotContentHandshake)).toMatchObject({
    state: "SESSION_REBOUND",
    applicationRootDetected: true
  });
  expect(await page.evaluate(() => (window as any).pendingApplicationLaunch.state)).toBe("PENDING_NAVIGATION");
});
