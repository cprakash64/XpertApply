/**
 * Real-Chromium destination readiness.
 *
 * The live failure: "I'm interested" opened the destination application, the
 * content script attached, the session rebound — and the widget stayed on
 * "Detecting fields / Filled 0 of 0" while the page visibly contained a resume
 * upload, first/last name, email, confirm email, city, phone country code,
 * phone number, Experience and Education.
 *
 * jsdom cannot reproduce the thing that matters here: a real page that mounts
 * its application AFTER the script that is looking for it has already run. So
 * these specs use a genuine browser, a genuine load, and genuine timing.
 */
import { expect, test } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");
const FIXTURE = pathToFileURL(path.join(here, "fixtures", "destination-async-application.html")).href;

/** The controls the live destination showed while the widget claimed 0 of 0. */
const EXPECTED_SCALARS = [
  "first_name",
  "last_name",
  "email",
  "confirm_email",
  "city",
  "phone_country",
  "phone"
];

test("hydrating destination: content script loads first, discovery still finds every field", async ({ page }) => {
  await page.goto(`${FIXTURE}?mode=top&delay=700`);
  // The content script attaches HERE — before the application exists. This is
  // the exact ordering that produced the live "0 of 0".
  await page.addScriptTag({ path: HARNESS });

  const before = await page.evaluate(() => (window as any).JobPilotHarness.applicationEvidence());
  expect(before.sufficient).toBe(false);
  expect(before.applicantControlCount).toBe(0);

  const readiness = await page.evaluate(() =>
    (window as any).JobPilotHarness.awaitDestinationReadiness(8000, 150));

  expect(readiness.ready).toBe(true);
  expect(readiness.failureCode).toBeNull();
  expect(readiness.stages).toContain("APPLICATION_ROOT_WAITING");
  expect(readiness.stages).toContain("APPLICATION_ROOT_FOUND");
  expect(readiness.fieldCount).toBeGreaterThan(0);
  expect(readiness.evidence).toMatchObject({
    resumeUpload: true,
    nameFields: true,
    emailFields: true,
    phoneField: true,
    repeatableSectionControls: true,
    personalInformationHeading: true
  });

  // Discovery runs AFTER hydration and the inventory becomes nonzero.
  const fields = await page.evaluate(() =>
    (window as any).JobPilotHarness.discover("#application-form"));
  expect(fields.length).toBeGreaterThan(0);
  const identity = fields.map((f: any) => `${f.id} ${f.label}`.toLowerCase()).join("|");
  for (const scalar of EXPECTED_SCALARS) {
    expect(identity, scalar).toContain(scalar.replace(/_/g, "-").split("-")[0]);
  }

  // Nothing was submitted and consent was never auto-selected.
  const events = await page.evaluate(() => (window as any).__destinationEvents);
  expect(events).toEqual({ submitted: false, consentChecked: false });
});

test("destination form inside a child frame is found and counted, not reported as zero", async ({ page }) => {
  await page.goto(`${FIXTURE}?mode=iframe&delay=500`);
  await page.addScriptTag({ path: HARNESS });

  const readiness = await page.evaluate(() =>
    (window as any).JobPilotHarness.awaitDestinationReadiness(8000, 150));

  // The top document has no application of its own; the frame has all of it.
  // Judging readiness on the top document alone made this wait out the full
  // timeout and then report a failure for a form we can read perfectly well.
  expect(readiness.ready).toBe(true);
  expect(readiness.failureCode).toBeNull();
  expect(readiness.evidenceLocation).toBe("frame");
  expect(readiness.elapsedMs).toBeLessThan(8000);

  expect(readiness.frames.length).toBeGreaterThan(0);
  const frame = readiness.frames[0];
  expect(frame.accessible).toBe(true);
  expect(frame.applicantControlCount).toBeGreaterThan(0);
  // A form living in a frame must never surface to the user as "0 of 0".
  expect(readiness.fieldCount).toBeGreaterThan(0);
});

test("an SPA route transition that replaces the document still reaches discovery", async ({ page }) => {
  await page.goto(`${FIXTURE}?mode=spa&delay=350`);
  await page.addScriptTag({ path: HARNESS });

  const readiness = await page.evaluate(() =>
    (window as any).JobPilotHarness.awaitDestinationReadiness(9000, 150));

  expect(readiness.ready).toBe(true);
  expect(readiness.failureCode).toBeNull();
  expect(readiness.fieldCount).toBeGreaterThan(0);
});

test("an application root replaced mid-hydration is rediscovered, not filled from stale refs", async ({ page }) => {
  // The delay is generous on purpose: the harness must be watching BEFORE the
  // partial tree mounts, otherwise the test silently observes only the final
  // one and proves nothing about re-arming.
  await page.goto(`${FIXTURE}?mode=remount&delay=1500&gap=150`);
  await page.addScriptTag({ path: HARNESS });

  const readiness = await page.evaluate(() =>
    (window as any).JobPilotHarness.awaitDestinationReadiness(12000, 250));

  expect(readiness.ready).toBe(true);
  expect(readiness.rootReplacements).toBeGreaterThan(0);

  // Discovery ran against the FINAL tree: the remounted form has the fields the
  // partial one never had.
  const fields = await page.evaluate(() =>
    (window as any).JobPilotHarness.discover("#application-form"));
  const ids = fields.map((f: any) => f.id);
  expect(ids).toContain("confirm-email");
  expect(ids).toContain("phone-country");
});

test("a destination that never renders an application ends on a named failure", async ({ page }) => {
  await page.goto(`${FIXTURE}?mode=never`);
  await page.addScriptTag({ path: HARNESS });

  const readiness = await page.evaluate(() =>
    (window as any).JobPilotHarness.awaitDestinationReadiness(1200, 150));

  // The point of the whole change: a bounded, NAMED end state. Never an
  // indefinite "Detecting fields", and never a silent success.
  expect(readiness.ready).toBe(false);
  expect(readiness.failureCode).toBe("APPLICATION_ROOT_NOT_FOUND");
  expect(readiness.elapsedMs).toBeGreaterThanOrEqual(1200);
  expect(readiness.stage).not.toBe("FIELD_DISCOVERY_COMPLETED");
});

test("the 'I'm interested' CTA is never mistaken for the final Submit control", async ({ page }) => {
  await page.goto(`${FIXTURE}?mode=top&delay=200`);
  await page.addScriptTag({ path: HARNESS });
  await page.waitForSelector("#submit-application");

  const candidates = await page.evaluate(() =>
    (window as any).JobPilotHarness.candidates());
  const names = candidates.map((candidate: any) => String(candidate.name ?? "").toLowerCase());
  expect(names.some((name: string) => name.includes("submit application"))).toBe(false);

  const selected = await page.evaluate(() => (window as any).JobPilotHarness.selected());
  expect(selected?.name?.toLowerCase() ?? "").not.toContain("submit");
});
