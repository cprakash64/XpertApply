import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");

type Timing = {
  controls: number;
  controlMs: number;
  probeMs: number;
  discoverMs: number;
  discovered: number;
  rootReason: string | null;
};

test("XA-09 benchmark: hostile large forms stay bounded", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setContent("<main><h1>Apply for this job</h1><form id='application'><button type='submit'>Submit application</button></form></main>");
  await page.addScriptTag({ path: HARNESS });

  const timings: Timing[] = [];
  for (const controls of [100, 500, 1_000, 2_000, 5_000]) {
    const timing = await page.evaluate((count) => {
      const form = document.querySelector<HTMLFormElement>("#application")!;
      form.querySelectorAll("label,input").forEach((element) => element.remove());
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < count; index += 1) {
        const label = document.createElement("label");
        label.htmlFor = `field-${index}`;
        label.textContent = index === 0 ? "First name" : index === 1 ? "Email" : `Question ${index}`;
        const input = document.createElement("input");
        input.id = `field-${index}`;
        input.name = `field-${index}`;
        input.required = index < 2;
        fragment.append(label, input);
      }

      const controlStarted = performance.now();
      form.append(fragment);
      void form.querySelectorAll("input").length;
      const controlMs = performance.now() - controlStarted;

      const probeStarted = performance.now();
      const probe = (window as any).JobPilotHarness.probeFrame();
      const probeMs = performance.now() - probeStarted;

      const discoverStarted = performance.now();
      const discovered = (window as any).JobPilotHarness.discover("#application").length;
      const discoverMs = performance.now() - discoverStarted;

      return {
        controls: count,
        controlMs,
        probeMs,
        discoverMs,
        discovered,
        rootReason: probe.rootReason ?? null
      };
    }, controls);
    timings.push(timing);
  }

  console.log(`XA09_TIMINGS ${JSON.stringify(timings)}`);
  expect(timings.map((timing) => timing.discovered)).toEqual([100, 500, 1_000, 0, 0]);
  expect(timings.map((timing) => timing.rootReason)).toEqual([
    null,
    null,
    null,
    "APPLICATION_FORM_TOO_LARGE",
    "APPLICATION_FORM_TOO_LARGE"
  ]);
  for (const timing of timings.filter((sample) => sample.controls >= 2_000)) {
    expect(timing.probeMs).toBeLessThan(1_000);
    expect(timing.discoverMs).toBeLessThan(1_000);
  }
});
