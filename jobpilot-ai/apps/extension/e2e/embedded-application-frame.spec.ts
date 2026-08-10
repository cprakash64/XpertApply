/**
 * The application lives in a cross-origin iframe.
 *
 * The live failure: the "I'm interested" launch succeeded, the destination
 * visibly contained a résumé upload, first/last name, email, confirm email,
 * city, phone country, phone number, Experience, Education and profile links —
 * and JobPilot said:
 *
 *     "The application is inside a frame JobPilot isn't allowed to read."
 *
 * That verdict rested on one fact, `contentDocument` throwing, which proves only
 * that the frame is cross-origin. It offered the user nothing to do.
 *
 * These specs use REAL cross-origin frames — two routed https origins in a real
 * browser, not a same-origin stand-in — because the whole question is what a
 * parent can still observe once the security boundary is genuinely in force.
 */
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");

const EMPLOYER = "https://careers.employer.test";
const ATS = "https://apply.ats-vendor.test";

/** The application, as the destination renders it inside the frame. */
const APPLICATION = `<!doctype html><html><body>
  <h2>Personal information</h2>
  <form id="application-form">
    <label for="resume">Résumé/CV</label><input id="resume" type="file" required>
    <label for="first">First name</label><input id="first" name="first_name" required>
    <label for="last">Last name</label><input id="last" name="last_name" required>
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <label for="confirm">Confirm email</label><input id="confirm" name="confirm_email" type="email" required>
    <label for="city">City</label><input id="city" name="city" required>
    <label for="cc">Phone country</label><select id="cc" name="phone_country"><option value="">Select</option><option>+1</option></select>
    <label for="phone">Phone number</label><input id="phone" name="phone" type="tel" required>
    <label for="linkedin">LinkedIn</label><input id="linkedin" name="linkedin" type="url">
    <h3>Experience</h3><button type="button">Add experience</button>
    <h3>Education</h3><button type="button">Add education</button>
  </form>
</body></html>`;

/**
 * Serve the employer page and the ATS application on two different https
 * origins, so the iframe boundary Chromium enforces is the real one.
 */
async function serveEmbedded(page: Page, options: { sandbox?: string; frameSrc?: string } = {}): Promise<void> {
  const sandboxAttr = options.sandbox === undefined ? "" : ` sandbox="${options.sandbox}"`;
  const src = options.frameSrc ?? `${ATS}/apply/7788991122`;
  await page.route(`${EMPLOYER}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <h1>Principal Engineer</h1>
        <iframe id="ats" title="Application" width="720" height="520" src="${src}"${sandboxAttr}></iframe>
      </body></html>`
    })
  );
  await page.route(`${ATS}/**`, (route) => route.fulfill({ contentType: "text/html", body: APPLICATION }));
  await page.goto(`${EMPLOYER}/jobs/principal-engineer`);
  await page.addScriptTag({ path: HARNESS });
}

test("the parent still identifies the cross-origin application frame it cannot read", async ({ page }) => {
  await serveEmbedded(page);

  // The security boundary really is in force.
  const unreadable = await page.evaluate(() => {
    try {
      return document.querySelector<HTMLIFrameElement>("#ats")!.contentDocument === null;
    } catch {
      return true;
    }
  });
  expect(unreadable).toBe(true);

  const remedy = await page.evaluate(() => (window as any).JobPilotHarness.frameRemedy());

  // `src` and `sandbox` belong to the PARENT's markup, so they survive the
  // boundary — which is what makes a remedy possible at all.
  expect(remedy.frames).toHaveLength(1);
  expect(remedy.frames[0]).toMatchObject({
    origin: ATS,
    urlKind: "https",
    srcObservable: true,
    sameOriginReadable: false,
    opaqueOrigin: false
  });
  // The application id never reaches the diagnostic.
  expect(remedy.frames[0].pathShape).toBe("/apply/<id>");
  expect(JSON.stringify(remedy.frames)).not.toContain("7788991122");

  // A missing host permission is named as such, not as a shrug.
  expect(remedy.verdictWithoutPermission).toBe("APPLICATION_FRAME_PERMISSION_MISSING");
  // And there is a concrete fallback: reopen the frame as its own tab.
  expect(remedy.reopenUrl).toBe(`${ATS}/apply/7788991122`);
});

test("a frame sandboxed to an opaque origin is named as unreachable, not as unpermitted", async ({ page }) => {
  // No amount of permission-granting reaches an opaque origin, so offering to
  // ask for one would be a lie. Reopening it as a tab is the honest remedy.
  await serveEmbedded(page, { sandbox: "allow-scripts allow-forms" });

  const remedy = await page.evaluate(() => (window as any).JobPilotHarness.frameRemedy());
  expect(remedy.frames[0]).toMatchObject({ sandboxed: true, opaqueOrigin: true });
  expect(remedy.verdictWithoutPermission).toBe("APPLICATION_FRAME_SANDBOXED_OPAQUE");
  expect(remedy.reopenUrl).toBe(`${ATS}/apply/7788991122`);
});

test("a sandbox that keeps its origin stays permission-requestable", async ({ page }) => {
  await serveEmbedded(page, { sandbox: "allow-scripts allow-same-origin allow-forms" });
  const remedy = await page.evaluate(() => (window as any).JobPilotHarness.frameRemedy());
  expect(remedy.frames[0].opaqueOrigin).toBe(false);
  expect(remedy.verdictWithoutPermission).toBe("APPLICATION_FRAME_PERMISSION_MISSING");
});

test("a script-populated frame with no URL offers no false reopen", async ({ page }) => {
  await page.route(`${EMPLOYER}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><iframe id="ats" width="600" height="400"></iframe></body></html>`
    })
  );
  await page.goto(`${EMPLOYER}/jobs/principal-engineer`);
  await page.addScriptTag({ path: HARNESS });

  const remedy = await page.evaluate(() => (window as any).JobPilotHarness.frameRemedy());
  expect(remedy.frames[0].urlKind).toBe("empty");
  // Nothing to open. Claiming otherwise would produce a broken tab.
  expect(remedy.reopenUrl).toBeNull();
});

test("the application inside the frame is discoverable once the frame itself is reached", async ({ page }) => {
  // Proves the destination is worth reaching: opened directly, the very same
  // document yields a full inventory rather than the reported 0 of 0.
  await page.route(`${ATS}/**`, (route) => route.fulfill({ contentType: "text/html", body: APPLICATION }));
  await page.goto(`${ATS}/apply/7788991122`);
  await page.addScriptTag({ path: HARNESS });

  const evidence = await page.evaluate(() => (window as any).JobPilotHarness.applicationEvidence());
  expect(evidence.sufficient).toBe(true);

  const fields = await page.evaluate(() => (window as any).JobPilotHarness.discover("#application-form"));
  const identity = fields.map((field: any) => `${field.id} ${field.label}`.toLowerCase()).join("|");
  for (const expected of ["first", "last", "email", "confirm", "city", "cc", "phone"]) {
    expect(identity, expected).toContain(expected);
  }
  expect(fields.length).toBeGreaterThanOrEqual(7);
});
