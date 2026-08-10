/**
 * The two live TikTok defects, in a real browser.
 *
 * Reported from the authenticated page:
 *
 *   • work authorization visibly displayed "Yes", and JobPilot still said
 *     "JobPilot could not keep this selection" and offered to re-select it;
 *   • sponsorship stayed blank — a separate, genuine actuation failure;
 *   • privacy consent correctly stayed manual.
 *
 * Both need real layout to reproduce. The verification defect needs a trigger
 * whose rendered text is not a bare value, and the sponsorship defect needs a
 * portaled menu that really does sit over the next control — `elementFromPoint`
 * hit-testing is meaningless without a layout engine, so jsdom cannot show it.
 */
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");
const LIVE_URL = "https://lifeattiktok.com/resume/7412998877665544/apply";

const AUTHORIZATION = "tiktok:work_authorization:authorization";
const SPONSORSHIP = "tiktok:work_authorization:sponsorship_now_or_future";

/**
 * A faithful stand-in for the live widget.
 *
 * Three properties matter, and all three are taken from the reported behaviour:
 *
 *  1. both questions portal their menu into ONE shared container;
 *  2. the menu stays mounted and visible after an option is chosen — it closes
 *     only on a genuine outside click or Escape, which a synthetic option click
 *     does not produce;
 *  3. a committed trigger renders a visually hidden label and a caret glyph
 *     around the value, and the node is replaced on every commit (React).
 */
async function renderApplication(page: Page): Promise<void> {
  await page.setContent(`
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; }
      .question-row { display: flex; gap: 16px; align-items: center; padding: 14px; }
      .question { width: 420px; }
      .answer-cell { position: relative; width: 240px; }
      .trigger { width: 100%; height: 38px; text-align: left; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      /* The portal is pinned over the form, so an open menu genuinely covers
         whatever row sits beneath it. This is the sponsorship blocker. */
      #portal-root { position: fixed; left: 460px; top: 90px; width: 240px; z-index: 9999; }
      #portal-root [role="listbox"] { background: #fff; border: 1px solid #999; }
      #portal-root [role="option"] { padding: 8px; }
    </style>
    <form id="application-form">
      <section class="generated-control-shell">
        <h2>Work Authorization</h2>
        <div class="question-row">
          <div class="question">Are you legally authorized to work in the US without restriction?</div>
          <div class="answer-cell">
            <button id="authorization" class="trigger" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false">Select</button>
            <input type="hidden" name="authorization_value">
          </div>
        </div>
        <div class="question-row">
          <div class="question">Will you now or in the future require visa sponsorship or a visa transfer?</div>
          <div class="answer-cell">
            <button id="sponsorship" class="trigger" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false">Select</button>
            <input type="hidden" name="sponsorship_value">
          </div>
        </div>
        <label><input id="privacy" type="checkbox"> I agree to the privacy policy</label>
      </section>
    </form>
    <div id="portal-root"></div>
    <script>
      const portal = document.getElementById('portal-root');
      window.__events = { submitted: false, openedFor: [] };
      document.addEventListener('submit', (e) => { e.preventDefault(); window.__events.submitted = true; }, true);

      function closeMenu() { portal.innerHTML = ''; }

      // The menu closes ONLY on a real outside interaction — never as a side
      // effect of choosing an option. That is what leaves it covering the next
      // question, and it is the behaviour being fixed against.
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);
      document.addEventListener('mousedown', (e) => {
        if (!portal.contains(e.target) && !e.target.classList?.contains('trigger')) closeMenu();
      }, true);

      function commit(id, label) {
        const current = document.getElementById(id);
        // React replaces the node on commit, so any reference taken before this
        // point is dead.
        const replacement = document.createElement('button');
        replacement.id = id;
        replacement.className = 'trigger';
        replacement.type = 'button';
        replacement.setAttribute('role', 'combobox');
        replacement.setAttribute('aria-haspopup', 'listbox');
        replacement.setAttribute('aria-expanded', 'false');
        // Decorated: a visually hidden label and a caret around the value. An
        // exact textContent equality against "Yes" fails here.
        replacement.innerHTML =
          '<span class="sr-only">' + (id === 'authorization' ? 'Work authorization' : 'Sponsorship') + '</span>' +
          '<span class="value">' + label + '</span><span class="caret"> \\u25be</span>';
        current.replaceWith(replacement);
        replacement.parentElement.querySelector('input[type=hidden]').value = label === 'Yes' ? 'true' : 'false';
        bind(id);
      }

      function bind(id) {
        document.getElementById(id).addEventListener('click', () => {
          window.__events.openedFor.push(id);
          portal.innerHTML = '';
          const menu = document.createElement('div');
          menu.setAttribute('role', 'listbox');
          for (const label of ['Yes', 'No']) {
            const option = document.createElement('div');
            option.setAttribute('role', 'option');
            option.textContent = label;
            option.addEventListener('click', () => commit(id, label));
            menu.appendChild(option);
          }
          portal.appendChild(menu);
        });
      }
      bind('authorization');
      bind('sponsorship');
    </script>`);
  await page.addScriptTag({ path: HARNESS });
}

/** What the two controls currently show, with decoration stripped. */
async function committedValues(page: Page): Promise<{ authorization: string; sponsorship: string }> {
  return page.evaluate(() => ({
    authorization: document.querySelector("#authorization .value")?.textContent?.trim() ?? "",
    sponsorship: document.querySelector("#sponsorship .value")?.textContent?.trim() ?? ""
  }));
}

test("authorization verifies through a decorated trigger instead of reporting a lost selection", async ({ page }) => {
  await renderApplication(page);

  const result = await page.evaluate(
    ({ url, identity }) =>
      (window as any).JobPilotHarness.tiktokActuate(url, identity, "Yes", true, "#application-form"),
    { url: LIVE_URL, identity: AUTHORIZATION }
  );

  // The live symptom was ok:false with reason "selected_value_not_persisted",
  // on a control that plainly showed Yes.
  expect(result.ok).toBe(true);
  expect(result.reason).toBe("verified");
  expect(result.states).toContain("VERIFIED");
  expect((await committedValues(page)).authorization).toBe("Yes");

  // The hidden submitted value agrees with what is painted.
  const backing = await page.evaluate(() =>
    (document.querySelector('input[name="authorization_value"]') as HTMLInputElement).value);
  expect(backing).toBe("true");
});

test("sponsorship is selected even though the previous menu is still mounted over it", async ({ page }) => {
  await renderApplication(page);

  const authorization = await page.evaluate(
    ({ url, identity }) =>
      (window as any).JobPilotHarness.tiktokActuate(url, identity, "Yes", true, "#application-form"),
    { url: LIVE_URL, identity: AUTHORIZATION }
  );
  expect(authorization.ok).toBe(true);

  // The widget leaves its menu open; it is now sitting over the sponsorship row.
  const covering = await page.evaluate(() => {
    const box = document.getElementById("sponsorship")!.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { menuStillOpen: Boolean(document.querySelector('#portal-root [role="listbox"]')), coveredByPortal: Boolean(top?.closest("#portal-root")) };
  });
  expect(covering.menuStillOpen).toBe(true);
  expect(covering.coveredByPortal).toBe(true);

  const sponsorship = await page.evaluate(
    ({ url, identity }) =>
      (window as any).JobPilotHarness.tiktokActuate(url, identity, "No", false, "#application-form"),
    { url: LIVE_URL, identity: SPONSORSHIP }
  );

  // Previously: control_covered (the stale menu) or an adopted foreign menu,
  // leaving sponsorship blank.
  expect(sponsorship.ok).toBe(true);
  expect(sponsorship.reason).toBe("verified");

  const values = await committedValues(page);
  expect(values).toEqual({ authorization: "Yes", sponsorship: "No" });

  // The second transaction opened the SECOND control, not the first one again.
  const opened = await page.evaluate(() => (window as any).__events.openedFor);
  expect(opened.filter((id: string) => id === "sponsorship").length).toBeGreaterThan(0);
});

test("both legal answers verify end to end, and consent stays the user's decision", async ({ page }) => {
  await renderApplication(page);

  for (const [identity, label, typed] of [
    [AUTHORIZATION, "Yes", true],
    [SPONSORSHIP, "No", false]
  ] as const) {
    const result = await page.evaluate(
      ({ url, id, display, typedAnswer }) =>
        (window as any).JobPilotHarness.tiktokActuate(url, id, display, typedAnswer, "#application-form"),
      { url: LIVE_URL, id: identity, display: label, typedAnswer: typed }
    );
    expect(result, identity).toMatchObject({ ok: true, reason: "verified" });
  }

  const final = await page.evaluate(
    ({ url, traces }) => (window as any).JobPilotHarness.tiktokFinal(url, "#application-form", traces),
    {
      url: LIVE_URL,
      traces: [
        {
          fieldId: `f_top_${AUTHORIZATION}`, frameId: "top", rawLabel: "authorization", accessibleName: "authorization",
          sectionHeading: "Work Authorization", fieldType: "combobox", ariaRole: "combobox", options: ["Yes", "No"],
          canonicalKey: "work_authorization_us", resolutionMethod: "registry", resolutionConfidence: 1, transform: "none",
          requiredCanonicalKeys: [], answerSource: "saved_profile", sourceValues: [true], typedAnswer: true, displayAnswer: "Yes",
          profileRevision: "r1", domGeneration: 1, actuator: "tiktok_application", actuatorReached: true,
          transactionStates: ["QUEUED_FOR_ACTUATION", "VERIFIED"], attemptedValue: "[redacted]",
          displayedValueAfterFill: "[present]", backingValueAfterFill: "[present]", verified: true, failureCode: null
        },
        {
          fieldId: `f_top_${SPONSORSHIP}`, frameId: "top", rawLabel: "sponsorship", accessibleName: "sponsorship",
          sectionHeading: "Work Authorization", fieldType: "combobox", ariaRole: "combobox", options: ["Yes", "No"],
          canonicalKey: "sponsorship_required_now_or_future", resolutionMethod: "registry", resolutionConfidence: 1,
          transform: "boolean_or", requiredCanonicalKeys: ["sponsorship_required_now", "sponsorship_required_future"],
          answerSource: "saved_profile", sourceValues: [false, false], typedAnswer: false, displayAnswer: "No",
          profileRevision: "r1", domGeneration: 1, actuator: "tiktok_application", actuatorReached: true,
          transactionStates: ["QUEUED_FOR_ACTUATION", "VERIFIED"], attemptedValue: "[redacted]",
          displayedValueAfterFill: "[present]", backingValueAfterFill: "[present]", verified: true, failureCode: null
        }
      ]
    }
  );

  expect(final).toMatchObject({
    requiredVerified: 2,
    requiredRemaining: 0,
    technicalIssues: 0,
    // Privacy consent is counted separately and never selected for the user.
    manualConsentActions: 1
  });
  await expect(page.locator("#privacy")).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).__events.submitted)).toBe(false);
});

test("a control showing the opposite answer is still rejected", async ({ page }) => {
  await renderApplication(page);
  // Pre-commit the wrong answer, then ask for the other one and refuse to
  // accept the control as already-correct.
  await page.evaluate(() => (document.getElementById("authorization") as HTMLElement).click());
  await page.evaluate(() => {
    const options = Array.from(document.querySelectorAll('#portal-root [role="option"]'));
    (options.find((node) => node.textContent === "No") as HTMLElement).click();
  });
  expect((await committedValues(page)).authorization).toBe("No");

  const matches = await page.evaluate(() => {
    const trigger = document.getElementById("authorization")!;
    return (window as any).JobPilotHarness.committedValueMatches(
      trigger.textContent ?? "", "Yes", true, ["Yes", "No"]
    );
  });
  expect(matches).toBe(false);
});
