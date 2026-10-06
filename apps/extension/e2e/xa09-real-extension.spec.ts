import { expect, test, chromium } from "@playwright/test";
import { OwnedPackageFixture } from "./owned-package-fixture";
import { containSyntheticNetwork } from "./network-containment";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

test("XA-09: shipped MV3 content script refuses a 5,000-control form without touching it", async () => {
  test.setTimeout(60_000);
  const controls = Array.from({ length: 5_000 }, (_, index) =>
    `<label for="field-${index}">${index === 0 ? "First name" : index === 1 ? "Email" : `Question ${index}`}</label>` +
    `<input id="field-${index}" name="field-${index}"${index < 2 ? " required" : ""}>`
  ).join("");
  const fixture = `<!doctype html><title>Apply</title><main><h1>Apply for this job</h1>
    <form id="application">${controls}<button type="submit">Submit application</button></form><label><input id="manual-consent" type="checkbox">I consent</label></main>
    <script>window.__xa09Events = { input: 0, submit: 0, submitClick: 0, formMutation: 0 };
      document.querySelector("button[type=submit]").addEventListener("click", () => window.__xa09Events.submitClick++);
      new MutationObserver(records => window.__xa09Events.formMutation += records.length).observe(document.querySelector("#application"), {subtree:true, attributes:true, childList:true, characterData:true});
      document.addEventListener("input", () => window.__xa09Events.input++, true);
      document.addEventListener("submit", (event) => { event.preventDefault(); window.__xa09Events.submit++; }, true);
    </script>`;
  const apiFixture = await new OwnedPackageFixture(fixture).start();
  const origin = apiFixture.origin;
  const applicationUrl = `${origin}/apply`;

  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  const network = await containSyntheticNetwork(context);
  try {
    const sessionBody = {
      session_id: 909,
      ats_type: null,
      official_application_url: applicationUrl,
      job: { title: "Engineer", company: "XA-09 Fixture" },
      resume: { status: "ready", document_id: 1, download_url: null },
      cover_letter: { status: "ready", document_id: 2, download_url: null },
      profile: { email: "candidate@example.test", full_name: "Test Candidate" }
    };
    await apiFixture.route("**/application-sessions/token", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session_token: apiFixture.sessionToken, session: sessionBody })
    }));
    await apiFixture.route("**/application-sessions/*/answers", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ answers: [], unresolved_questions: [], refreshed: false, profile_revision: "r" })
    }));
    await apiFixture.route("**/application-sessions/909", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(sessionBody)
    }));

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    // Load before staging so only explicit toolbar discovery can report refusal.
    // A preceding automatic workflow must not mask a missing toolbar failure code.
    const page = await context.newPage();
    await page.goto(applicationUrl);
    const started = Date.now();
    await worker.evaluate(async (url) => {
      await chrome.storage.local.set({apiBase:new URL(url).origin});
      const now = Date.now();
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: {
        version: 1,
        applicationId: "xa09-e2e",
        jobId: "909",
        applicationUrl: url,
        status: "prepared",
        handoffToken: "xa09-handoff",
        requestId: "xa09-request",
        sessionId: 909,
        launchToken: "xa09-launch",
        officialUrl: url,
        expectedOrigin: new URL(url).origin,
        createdAt: now,
        expiresAt: now + 15 * 60 * 1_000,
        state: "waiting_for_content_script",
        protocolVersion: 3,
        atsType: null
      }});
    }, applicationUrl);

    const overlay = await CanonicalOverlayDriver.openFromToolbar(page, worker);
    await expect.poll(() => overlay.status(), { timeout: 20_000 }).toBe("Something needs your attention");
    // Terminal workflow status can precede the worker's authoritative failure patch.
    // Await that state, rather than taking a racing one-shot storage snapshot.
    await expect.poll(async () => {
      const state = await worker.evaluate(async () => chrome.storage.session.get(["viewStates"]));
      return JSON.stringify(state);
    }).toContain("APPLICATION_FORM_TOO_LARGE");
    const elapsedMs = Date.now() - started;

    const pageState = await page.evaluate(() => ({
      filled: Array.from(document.querySelectorAll<HTMLInputElement>("#application input")).filter((input) => input.value !== "").length,
      consent: (document.querySelector("#manual-consent") as HTMLInputElement).checked,
      events: (window as any).__xa09Events
    }));
    const storage = await worker.evaluate(async () => chrome.storage.session.get(["viewStates"]));


    expect(elapsedMs).toBeLessThan(10_000);
    expect(pageState).toEqual({ filled: 0, consent: false, events: { input: 0, submit: 0, submitClick: 0, formMutation: 0 } });
    expect(JSON.stringify(storage)).toContain("APPLICATION_FORM_TOO_LARGE");
    await expect(page.locator("#xpertapply-assistant-overlay-v1 #errors")).toBeVisible();
    await expect(page.locator("#xpertapply-assistant-overlay-v1 #errors")).toContainText(/safe limit.*1,000/);
    await expect(page.locator("#xpertapply-assistant-overlay-v1 #errors")).toContainText("Nothing was filled");
    network.assertContained();
    await page.close();
  } finally {
    await context.close();
    await apiFixture.close();
  }
});
