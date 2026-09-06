import { expect, test, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WidgetDriver } from "./widget-driver";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

test("XA-09: shipped MV3 content script refuses a 5,000-control form without touching it", async () => {
  test.setTimeout(60_000);
  const controls = Array.from({ length: 5_000 }, (_, index) =>
    `<label for="field-${index}">${index === 0 ? "First name" : index === 1 ? "Email" : `Question ${index}`}</label>` +
    `<input id="field-${index}" name="field-${index}"${index < 2 ? " required" : ""}>`
  ).join("");
  const fixture = `<!doctype html><title>Apply</title><main><h1>Apply for this job</h1>
    <form id="application">${controls}<button type="submit">Submit application</button></form></main>
    <script>window.__xa09Events = { input: 0, submit: 0 };
      document.addEventListener("input", () => window.__xa09Events.input++, true);
      document.addEventListener("submit", (event) => { event.preventDefault(); window.__xa09Events.submit++; }, true);
    </script>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://localhost:${(server.address() as { port: number }).port}`;
  const applicationUrl = `${origin}/apply`;

  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
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
    await context.route("**/application-sessions/token", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session_token: "xa09-test-token", session: sessionBody })
    }));
    await context.route("**/application-sessions/*/answers", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ answers: [], unresolved_questions: [], refreshed: false, profile_revision: "r" })
    }));
    await context.route("**/application-sessions/*", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(sessionBody)
    }));

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    await worker.evaluate(async (url) => {
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

    const page = await context.newPage();
    const started = Date.now();
    await page.goto(applicationUrl);
    await page.waitForSelector("#jobpilot-assisted-apply", { state: "attached", timeout: 20_000 });
    const widget = await WidgetDriver.attach(page);
    await expect.poll(() => widget.message(), { timeout: 20_000 }).toContain("safe limit of 1000");
    const elapsedMs = Date.now() - started;

    const pageState = await page.evaluate(() => ({
      filled: Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter((input) => input.value !== "").length,
      events: (window as any).__xa09Events
    }));
    const storage = await worker.evaluate(async () => chrome.storage.session.get(["viewStates"]));
    console.log(`XA09_MV3 ${JSON.stringify({ elapsedMs, pageState, storage })}`);

    expect(elapsedMs).toBeLessThan(10_000);
    expect(pageState).toEqual({ filled: 0, events: { input: 0, submit: 0 } });
    expect(JSON.stringify(storage)).toContain("APPLICATION_FORM_TOO_LARGE");
    await page.close();
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
