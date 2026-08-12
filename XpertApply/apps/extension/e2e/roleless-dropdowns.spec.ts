/**
 * The two dropdown shapes that could not be filled at all, in a real browser.
 *
 * Both are ordinary component-library output, and each defeated a different
 * part of the transaction:
 *
 *   • the trigger is a plain `<div aria-haspopup="listbox">` — no `role`, no
 *     `aria-controls`, no `tabindex`. Trigger refinement matched none of those,
 *     returned null, and every attempt ended in `control_not_found` without a
 *     single click being sent;
 *   • the widget opens on `mousedown` and dismisses on the `click` that
 *     follows, so the plain click attempt did nothing and the full pointer
 *     sequence opened and shut the menu inside one turn;
 *   • the menu is portaled to `<body>` and declares NO ARIA roles, so every
 *     role-based lookup reported `menu_not_opened` for a menu that was on
 *     screen.
 *
 * Real layout is required: menu discovery is geometry- and style-aware
 * (`position: absolute`, visibility, proximity to the trigger), none of which
 * jsdom evaluates.
 */
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");
const LIVE_URL = "https://lifeattiktok.com/resume/7412998877665544/apply";

const AUTHORIZATION = "tiktok:work_authorization:authorization";
const SPONSORSHIP = "tiktok:work_authorization:sponsorship_now_or_future";

async function renderApplication(page: Page): Promise<void> {
  await page.setContent(`
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; }
      .question-row { display: flex; gap: 16px; align-items: center; padding: 14px; }
      .question { width: 420px; }
      .answer-cell { position: relative; width: 240px; }
      .sel-view { width: 100%; height: 38px; border: 1px solid #999; line-height: 38px; padding: 0 8px; }
      .app-select-dropdown { position: absolute; width: 240px; background: #fff; border: 1px solid #999; }
      .app-select-dropdown ul { margin: 0; padding: 0; list-style: none; }
      .app-select-dropdown li { padding: 8px; }
    </style>
    <form id="application-form">
      <section>
        <h2>Work Authorization</h2>
        <div class="question-row">
          <div class="question">Are you legally authorized to work in the US without restriction?</div>
          <div class="answer-cell">
            <div id="authorization" class="sel-view" aria-haspopup="listbox">Please select</div>
            <input type="hidden" name="authorization_value">
          </div>
        </div>
        <div class="question-row">
          <div class="question">Will you now or in the future require visa sponsorship or a visa transfer?</div>
          <div class="answer-cell">
            <div id="sponsorship" class="sel-view" aria-haspopup="listbox">Please select</div>
            <input type="hidden" name="sponsorship_value">
          </div>
        </div>
      </section>
    </form>
    <script>
      window.__events = { submitted: false, clicksOnTrigger: 0 };
      document.addEventListener('submit', (e) => { e.preventDefault(); window.__events.submitted = true; }, true);

      function openMenu(trigger) {
        if (document.querySelector('.app-select-dropdown')) return;
        const box = trigger.getBoundingClientRect();
        const popup = document.createElement('div');
        popup.className = 'app-select-dropdown';
        popup.style.left = box.left + 'px';
        popup.style.top = box.bottom + 'px';
        const list = document.createElement('ul');
        for (const label of ['Yes', 'No']) {
          const item = document.createElement('li');
          item.textContent = label;
          item.addEventListener('click', () => {
            trigger.textContent = label;
            trigger.parentElement.querySelector('input[type=hidden]').value = label === 'Yes' ? 'true' : 'false';
            popup.remove();
          });
          list.appendChild(item);
        }
        popup.appendChild(list);
        document.body.appendChild(popup);
      }

      for (const id of ['authorization', 'sponsorship']) {
        const trigger = document.getElementById(id);
        // Press opens. The click that follows the press dismisses it again —
        // so one uninterrupted press-plus-click leaves the menu shut.
        trigger.addEventListener('mousedown', () => openMenu(trigger));
        trigger.addEventListener('click', () => {
          window.__events.clicksOnTrigger += 1;
          document.querySelector('.app-select-dropdown')?.remove();
        });
      }
    </script>`);
  await page.addScriptTag({ path: HARNESS });
}

function shown(page: Page): Promise<{ authorization: string; sponsorship: string }> {
  return page.evaluate(() => ({
    authorization: document.getElementById("authorization")!.textContent!.trim(),
    sponsorship: document.getElementById("sponsorship")!.textContent!.trim()
  }));
}

test("the adapter locates a role-less div trigger as the control", async ({ page }) => {
  await renderApplication(page);
  const inventory = await page.evaluate(
    (url) => (window as never as { JobPilotHarness: any }).JobPilotHarness.tiktokDiscover(url, "#application-form"),
    LIVE_URL
  );
  expect(inventory.active).toBe(true);
  expect(inventory.slots.map((slot: { triggerId: string }) => slot.triggerId)).toEqual([
    "authorization",
    "sponsorship"
  ]);
  expect(inventory.slots.every((slot: { failureCode: string | null }) => slot.failureCode === null)).toBe(true);
});

test("both answers commit through a mousedown-toggled trigger and a role-less portaled menu", async ({ page }) => {
  await renderApplication(page);

  for (const [identity, label, typed] of [
    [AUTHORIZATION, "Yes", true],
    [SPONSORSHIP, "No", false]
  ] as const) {
    const result = await page.evaluate(
      ({ url, id, display, typedAnswer }) =>
        (window as never as { JobPilotHarness: any }).JobPilotHarness
          .tiktokActuate(url, id, display, typedAnswer, "#application-form"),
      { url: LIVE_URL, id: identity, display: label, typedAnswer: typed }
    );
    // Previously: control_not_found (no refinable trigger), then
    // menu_not_opened once that was fixed.
    expect(result, identity).toMatchObject({ ok: true, reason: "verified" });
    expect(result.openStrategy, identity).toBe("mouse");
    expect(result.matchedOption, identity).toBe("[present]");
  }

  expect(await shown(page)).toEqual({ authorization: "Yes", sponsorship: "No" });
  const backing = await page.evaluate(() => ({
    authorization: (document.querySelector('input[name="authorization_value"]') as HTMLInputElement).value,
    sponsorship: (document.querySelector('input[name="sponsorship_value"]') as HTMLInputElement).value
  }));
  expect(backing).toEqual({ authorization: "true", sponsorship: "false" });
  expect(await page.evaluate(() => (window as never as { __events: { submitted: boolean } }).__events.submitted)).toBe(false);
});

test("a live re-read reports both required eligibility controls as verified", async ({ page }) => {
  await renderApplication(page);
  for (const [identity, label, typed] of [
    [AUTHORIZATION, "Yes", true],
    [SPONSORSHIP, "No", false]
  ] as const) {
    await page.evaluate(
      ({ url, id, display, typedAnswer }) =>
        (window as never as { JobPilotHarness: any }).JobPilotHarness
          .tiktokActuate(url, id, display, typedAnswer, "#application-form"),
      { url: LIVE_URL, id: identity, display: label, typedAnswer: typed }
    );
  }

  const trace = (fieldId: string, canonicalKey: string, typedAnswer: boolean, displayAnswer: string) => ({
    fieldId, frameId: "top", rawLabel: fieldId, accessibleName: fieldId,
    sectionHeading: "Work Authorization", fieldType: "combobox", ariaRole: "combobox", options: ["Yes", "No"],
    canonicalKey, resolutionMethod: "registry", resolutionConfidence: 1, transform: "none",
    requiredCanonicalKeys: [], answerSource: "saved_profile", sourceValues: [typedAnswer],
    typedAnswer, displayAnswer, profileRevision: "r1", domGeneration: 1,
    actuator: "tiktok_application", actuatorReached: true,
    transactionStates: ["QUEUED_FOR_ACTUATION", "VERIFIED"], attemptedValue: "[redacted]",
    displayedValueAfterFill: "[present]", backingValueAfterFill: "[present]", verified: true, failureCode: null
  });

  const final = await page.evaluate(
    ({ url, traces }) =>
      (window as never as { JobPilotHarness: any }).JobPilotHarness.tiktokFinal(url, "#application-form", traces),
    {
      url: LIVE_URL,
      traces: [
        trace(`f_top_${AUTHORIZATION}`, "work_authorization_us", true, "Yes"),
        trace(`f_top_${SPONSORSHIP}`, "sponsorship_required_now_or_future", false, "No")
      ]
    }
  );

  expect(final).toMatchObject({ requiredVerified: 2, requiredRemaining: 0, technicalIssues: 0 });
});
