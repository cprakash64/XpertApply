import { expect, test } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(path.join(here, "fixtures", "samsara.html")).href;
const HARNESS = path.join(here, "bundle", "harness.js");

test("XA-10: Clear restores native select, radio, and custom dropdown selections", async ({ page }) => {
  await page.goto(FIXTURE);
  await page.addScriptTag({ path: HARNESS });
  await page.evaluate(() => {
    document.querySelector("#application-form")!.insertAdjacentHTML("beforeend", `
      <fieldset id="source-group">
        <legend>How did you hear about us?</legend>
        <input id="source-referral" type="radio" name="source" value="referral"><label for="source-referral">Referral</label>
        <input id="source-board" type="radio" name="source" value="board"><label for="source-board">Job board</label>
      </fieldset>`);
    window.JobPilotHarness.configureDropdownTiming({
      openPointerMs: 800, openKeyboardMs: 500, openEnterMs: 300,
      listboxMs: 500, optionsMs: 900, verifyMs: 800, pollStepMs: 20
    });
    window.JobPilotHarness.discover("#application-form");
  });

  expect((await page.evaluate(() => window.JobPilotHarness.fill("work_auth", "Yes"))).status).toBe("filled");
  expect((await page.evaluate(() => window.JobPilotHarness.fill("source-referral", "Referral"))).status).toBe("filled");
  expect((await page.evaluate(() => window.JobPilotHarness.fill("prev_samsara", "No"))).status).toBe("filled");

  expect(await page.locator("#work_auth").inputValue()).toBe("Yes");
  expect(await page.locator("#source-referral").isChecked()).toBe(true);
  await expect(page.locator("#prev_samsara .select__value")).toHaveText("No");

  expect(await page.evaluate(() => window.JobPilotHarness.clear())).toEqual({ cleared: 3, failed: 0 });
  const clearedState = await page.evaluate(() => ({
    native: (document.querySelector("#work_auth") as HTMLSelectElement).value,
    radio: (document.querySelector("#source-referral") as HTMLInputElement).checked,
    custom: document.querySelector("#prev_samsara .select__value")?.textContent ?? "",
    marked: document.querySelectorAll("[data-jobpilot-filled]").length
  }));
  expect(clearedState).toEqual({ native: "", radio: false, custom: "", marked: 0 });
  expect(await page.evaluate(() => window.__submitClicked)).toBe(false);
  expect(await page.evaluate(() => window.JobPilotHarness.clear())).toEqual({ cleared: 0, failed: 0 });
});

test("XA-10: Clear restores a user's pre-existing custom selection", async ({ page }) => {
  await page.goto(FIXTURE);
  await page.locator("#prev_samsara").dispatchEvent("mousedown");
  await page.locator("#prev_samsara-menu").getByRole("option", { name: "Yes", exact: true }).click();
  await page.addScriptTag({ path: HARNESS });
  await page.evaluate(() => {
    window.JobPilotHarness.configureDropdownTiming({
      openPointerMs: 800, openKeyboardMs: 500, openEnterMs: 300,
      listboxMs: 500, optionsMs: 900, verifyMs: 800, pollStepMs: 20
    });
    window.JobPilotHarness.discover("#application-form");
  });

  expect((await page.evaluate(() => window.JobPilotHarness.fill("prev_samsara", "No"))).status).toBe("filled");
  await expect(page.locator("#prev_samsara .select__value")).toHaveText("No");
  expect(await page.evaluate(() => window.JobPilotHarness.clear())).toEqual({ cleared: 1, failed: 0 });
  await expect(page.locator("#prev_samsara .select__value")).toHaveText("Yes");
  expect(await page.evaluate(() => window.__submitClicked)).toBe(false);
});
