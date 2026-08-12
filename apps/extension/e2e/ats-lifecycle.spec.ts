import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");

test("resume parsing replaces the old DOM and post-parse rediscovery actuates the live control", async ({ page }) => {
  await page.setContent(`
    <form id="application-form">
      <label>Resume<input id="resume" type="file"></label>
      <label>Old authorization<input id="old-auth"></label>
    </form>`);
  await page.addScriptTag({ path: HARNESS });
  await page.evaluate(() => {
    window.setTimeout(() => {
      document.querySelector("#application-form")!.innerHTML = `
        <label>First name<input value="ATS populated"></label>
        <label>Are you legally authorized to work in the US without restriction?
          <select id="live-auth" required><option value="">Select</option><option value="true">Yes</option><option value="false">No</option></select>
        </label>
        <section><h2>Projects</h2><button type="button">Add</button></section>`;
    }, 40);
  });
  const handoff = await page.evaluate(() => (window as any).JobPilotHarness.lifecycleHandoff("#application-form"));
  expect(handoff.oldConnected).toBe(false);
  expect(handoff.generation).toBe(1);
  expect(handoff.fields).toContain("Are you legally authorized to work in the US without restriction?");
  expect(handoff.trace).toEqual(expect.arrayContaining([
    "WAITING_FOR_ATS_PARSE", "ATS_PARSE_ACTIVITY_DETECTED", "INVALIDATING_PRE_PARSE_RUN", "REDISCOVERING_POST_PARSE_DOM"
  ]));
  await page.evaluate(() => (window as any).JobPilotHarness.discover("#application-form"));
  const fill = await page.evaluate(() => (window as any).JobPilotHarness.fill("live-auth", "Yes"));
  expect(fill.status).toBe("filled");
  await expect(page.locator("#live-auth")).toHaveValue("true");
});

test("post-parse project takeover saves once and retry skips the duplicate", async ({ page }) => {
  await page.setContent(`
    <form id="application-form"><section id="projects"><h2>Projects</h2><button id="add" type="button">Add</button><div data-items></div></section></form>
    <script>
      document.querySelector('#add').addEventListener('click', () => {
        const dialog = document.createElement('div'); dialog.setAttribute('role','dialog');
        dialog.innerHTML = '<label>Project name<input name="name" required></label><label>Description<textarea name="description"></textarea></label><button type="button">Save</button>';
        dialog.querySelector('button').addEventListener('click', () => {
          const article = document.createElement('article'); article.textContent = dialog.querySelector('[name=name]').value;
          document.querySelector('[data-items]').appendChild(article); dialog.remove();
        });
        document.body.appendChild(dialog);
      });
    </script>`);
  await page.addScriptTag({ path: HARNESS });
  const profile = { projects: [{ name: "Compiler Lab", description: "Built a parser", verified: true }] };
  const first = await page.evaluate((data) => (window as any).JobPilotHarness.fillRepeatable(data, "#application-form"), profile);
  expect(first[0].recordsAdded).toBe(1);
  const retry = await page.evaluate((data) => (window as any).JobPilotHarness.fillRepeatable(data, "#application-form"), profile);
  expect(retry[0].recordsAdded).toBe(0);
  expect(retry[0].duplicatesSkipped).toBe(1);
  await expect(page.locator("article")).toHaveCount(1);
});

test("an optional repeatable section with no confirmed data is skipped", async ({ page }) => {
  await page.setContent('<form id="application-form"><section><h2>Awards</h2><button type="button">Add</button></section></form>');
  await page.addScriptTag({ path: HARNESS });
  const traces = await page.evaluate(() => (window as any).JobPilotHarness.fillRepeatable({ awards: [] }, "#application-form"));
  expect(traces[0]).toMatchObject({ required: false, recordsAdded: 0, failureCode: "NO_CONFIRMED_PROFILE_RECORDS" });
});

test("TikTok post-parse final scan blocks false-ready and separates consent", async ({ page }) => {
  await page.setContent(`
    <form id="application-form">
      <section aria-label="Legal eligibility">
        <div class="field"><div id="auth" role="combobox" tabindex="0" aria-haspopup="listbox"
          aria-label="Are you legally authorized to work in the US without restriction?"><span class="placeholder">Select</span></div><input type="hidden"></div>
        <div class="field"><div id="sponsor" role="combobox" tabindex="0" aria-haspopup="listbox"
          aria-label="Will you now or in the future require visa sponsorship or a visa transfer?"><span class="placeholder">Select</span></div><input type="hidden"></div>
        <label><input id="privacy" type="checkbox" required> I have read and agreed to the Privacy Policy</label>
      </section>
      <section><h2>Project Experience</h2></section>
      <section><h2>Honors and Awards</h2></section>
      <section><h2>Language Skills</h2></section>
    </form>
    <script>
      for (const id of ['auth', 'sponsor']) {
        const control = document.getElementById(id);
        control.addEventListener('click', () => {
          document.querySelector('[role=listbox]')?.remove();
          const list = document.createElement('div'); list.setAttribute('role', 'listbox');
          for (const label of ['Yes', 'No']) {
            const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = label;
            option.addEventListener('click', () => {
              control.innerHTML = '<span class="singleValue" aria-selected="true">' + label + '</span>';
              control.parentElement.querySelector('input[type=hidden]').value = label === 'Yes' ? 'true' : 'false';
              list.remove();
            });
            list.appendChild(option);
          }
          document.body.appendChild(list);
        });
      }
    </script>`);
  await page.addScriptTag({ path: HARNESS });
  const profile = { projects: [{ id: 41, name: "Compiler Lab", verified: true }] };
  const repeaters = await page.evaluate((data) => (window as any).JobPilotHarness.fillRepeatable(data, "#application-form"), profile);
  expect(repeaters.find((item: any) => item.sectionKind === "project_experience")).toMatchObject({
    candidateRecordCount: 1, failureCode: "ADD_CONTROL_NOT_FOUND"
  });

  const blank = await page.evaluate(({ data, sections }) =>
    (window as any).JobPilotHarness.finalVerify(data, "#application-form", [], sections),
  { data: profile, sections: repeaters });
  expect(blank.canEnterReviewReady).toBe(false);
  expect(blank.requiredRemaining).toBe(2);
  expect(blank.manualConsentActions).toBe(1);

  await page.evaluate(() => (window as any).JobPilotHarness.discover("#application-form"));
  expect((await page.evaluate(() => (window as any).JobPilotHarness.fill("auth", "Yes"))).status).toBe("filled");
  expect((await page.evaluate(() => (window as any).JobPilotHarness.fill("sponsor", "No"))).status).toBe("filled");
  const final = await page.evaluate(({ data, sections }) =>
    (window as any).JobPilotHarness.finalVerify(data, "#application-form", [
      { label: "legally authorized", canonicalKey: "work_authorization_us", typedAnswer: true, verified: true, actuatorReached: true },
      { label: "visa sponsorship", canonicalKey: "sponsorship_required_now_or_future", typedAnswer: false, verified: true, actuatorReached: true }
    ], sections),
  { data: profile, sections: repeaters });
  // Candidate records could not reach an Add actuator, so readiness remains
  // blocked honestly even though both eligibility controls now verify.
  expect(final.requiredVerified).toBe(2);
  expect(final.requiredRemaining).toBe(0);
  expect(final.manualConsentActions).toBe(1);
  expect(final.technicalIssues).toBe(1);
  expect(final.canEnterReviewReady).toBe(false);
  await expect(page.locator("#privacy")).not.toBeChecked();
});
