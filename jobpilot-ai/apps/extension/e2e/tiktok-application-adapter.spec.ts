import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");
/**
 * Both approved application hosts, driven through the identical live flow.
 *
 * `lifeattiktok.com/resume/<id>/apply` is what the authenticated application
 * actually serves, and it is the host the adapter's gate rejected — which is
 * why the live page reported TIKTOK_ADAPTER_NOT_ACTIVATED, inserted neither
 * authoritative field, and told the user "required remaining: 0" beside two
 * visibly empty dropdowns.
 */
const APPLICATION_HOSTS: [string, string][] = [
  ["lifeattiktok.com (live application host)", "https://lifeattiktok.com/resume/7412998877665544/apply?from=jobs#work-authorization"],
  ["careers.tiktok.com (locale + query route)", "https://careers.tiktok.com/en/portal/position/123456789/application?locale=en-US#work-authorization"]
];

for (const [hostLabel, TIKTOK_URL] of APPLICATION_HOSTS) {
test(`TikTok adapter inventories, actuates, reacquires, and verifies both legal controls on ${hostLabel}`, async ({ page }) => {
  await page.setContent(`
    <form id="application-form">
      <section class="generated-control-shell">
        <h2>Work Authorization</h2>
        <div class="question-row">
          <div class="question">Are you legally authorized to work in the US without restriction?</div>
          <div class="answer"><button id="authorization" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false">Select</button><input type="hidden" name="authorization_value"></div>
        </div>
        <div class="question-row">
          <div class="question">Will you now or in the future require visa sponsorship or a visa transfer?</div>
          <div class="answer"><button id="sponsorship" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false">Select</button><input type="hidden" name="sponsorship_value"></div>
        </div>
        <label><input id="privacy" type="checkbox"> I agree to the privacy policy</label>
      </section>
    </form>
    <script>
      function bind(id) {
        let trigger = document.getElementById(id);
        trigger.addEventListener('click', () => {
          document.querySelector('[role=listbox]')?.remove();
          const replacement = trigger.cloneNode(true);
          trigger.replaceWith(replacement);
          trigger = replacement;
          trigger.setAttribute('aria-expanded', 'true');
          bindReplacement();
          const menu = document.createElement('div');
          menu.setAttribute('role', 'listbox');
          for (const label of ['Yes', 'No']) {
            const option = document.createElement('div');
            option.setAttribute('role', 'option');
            option.textContent = label;
            option.addEventListener('click', () => {
              const current = document.getElementById(id);
              const committed = current.cloneNode(false);
              committed.textContent = label;
              current.replaceWith(committed);
              trigger = committed;
              trigger.parentElement.querySelector('input[type=hidden]').value = label === 'Yes' ? 'true' : 'false';
              menu.remove();
              bindReplacement();
            });
            menu.appendChild(option);
          }
          document.body.appendChild(menu);
        });
        function bindReplacement() {}
      }
      bind('authorization');
      bind('sponsorship');
    </script>`);
  await page.addScriptTag({ path: HARNESS });

  const inventory = await page.evaluate((url) =>
    (window as any).JobPilotHarness.tiktokDiscover(url, "#application-form"), TIKTOK_URL);
  expect(inventory).toMatchObject({
    active: true,
    trace: {
      adapterName: "tiktok_application",
      adapterActivated: true,
      activationReason: "approved_tiktok_careers_origin_and_visible_work_authorization_section",
      hostAllowed: true,
      contentScriptAllowed: true,
      applicationSurfaceFound: true,
      activationFailureCode: null,
      workAuthorizationSectionFound: true,
      authorizationQuestionFound: true,
      sponsorshipQuestionFound: true,
      authorizationInventoryInserted: true,
      sponsorshipInventoryInserted: true,
      authorizationRowFound: true,
      sponsorshipRowFound: true,
      distinctFieldIdentities: true
    }
  });
  expect(inventory.slots.map((slot: any) => slot.identity)).toEqual([
    "tiktok:work_authorization:authorization",
    "tiktok:work_authorization:sponsorship_now_or_future"
  ]);

  const blank = await page.evaluate((url) =>
    (window as any).JobPilotHarness.tiktokFinal(url, "#application-form"), TIKTOK_URL);
  expect(blank).toMatchObject({ requiredVerified: 0, requiredRemaining: 2, manualConsentActions: 1, canEnterReviewReady: false });

  const authorization = await page.evaluate((url) =>
    (window as any).JobPilotHarness.tiktokActuate(
      url, "tiktok:work_authorization:authorization", "Yes", true, "#application-form"
    ), TIKTOK_URL);
  expect(authorization).toMatchObject({ ok: true, displayed: "Yes", openStrategy: "click" });

  const sponsorship = await page.evaluate((url) =>
    (window as any).JobPilotHarness.tiktokActuate(
      url, "tiktok:work_authorization:sponsorship_now_or_future", "No", false, "#application-form"
    ), TIKTOK_URL);
  expect(sponsorship).toMatchObject({ ok: true, displayed: "No", openStrategy: "click" });
  await expect(page.locator("#privacy")).not.toBeChecked();

  const traces = [
    {
      fieldId: "f_top_tiktok:work_authorization:authorization", frameId: "top", rawLabel: "authorization", accessibleName: "authorization",
      sectionHeading: "Work Authorization", fieldType: "combobox", ariaRole: "combobox", options: ["Yes", "No"],
      canonicalKey: "work_authorization_us", resolutionMethod: "registry", resolutionConfidence: 1, transform: "none",
      requiredCanonicalKeys: [], answerSource: "saved_profile", sourceValues: [true], typedAnswer: true, displayAnswer: "Yes",
      profileRevision: "r1", domGeneration: 1, actuator: "tiktok_application", actuatorReached: true,
      transactionStates: authorization.states, attemptedValue: "[redacted]", displayedValueAfterFill: "[present]", backingValueAfterFill: "[present]", verified: true, failureCode: null
    },
    {
      fieldId: "f_top_tiktok:work_authorization:sponsorship_now_or_future", frameId: "top", rawLabel: "sponsorship", accessibleName: "sponsorship",
      sectionHeading: "Work Authorization", fieldType: "combobox", ariaRole: "combobox", options: ["Yes", "No"],
      canonicalKey: "sponsorship_required_now_or_future", resolutionMethod: "registry", resolutionConfidence: 1, transform: "boolean_or",
      requiredCanonicalKeys: ["sponsorship_required_now", "sponsorship_required_future"], answerSource: "saved_profile",
      sourceValues: [false, false], typedAnswer: false, displayAnswer: "No", profileRevision: "r1", domGeneration: 1,
      actuator: "tiktok_application", actuatorReached: true, transactionStates: sponsorship.states, attemptedValue: "[redacted]",
      displayedValueAfterFill: "[present]", backingValueAfterFill: "[present]", verified: true, failureCode: null
    }
  ];
  const final = await page.evaluate(({ url, values }) =>
    (window as any).JobPilotHarness.tiktokFinal(url, "#application-form", values),
  { url: TIKTOK_URL, values: traces });
  expect(final).toMatchObject({
    requiredVerified: 2,
    requiredRemaining: 0,
    manualConsentActions: 1,
    technicalIssues: 0,
    canEnterReviewReady: true,
    tiktokAdapterTrace: {
      finalVerificationUsedTikTokAdapter: true,
      authorizationActuatorReached: true,
      sponsorshipActuatorReached: true,
      finalVerificationUsedAdapter: true,
      hostAllowed: true,
      adapterActivated: true,
      authorizationInventoryInserted: true,
      sponsorshipInventoryInserted: true
    }
  });
});
}
