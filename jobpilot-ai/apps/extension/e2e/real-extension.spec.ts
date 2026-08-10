import { expect, test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import path from "node:path";
import fs from "node:fs";

/**
 * The REAL built extension, loaded unpacked into Chromium.
 *
 * Everything else in this directory injects a bundle into a page. This spec
 * loads `dist/` the way Chrome does: the shipped content script, the shipped
 * service worker, and the real manifest matching. It is the only test that
 * proves the production content-script ENTRY POINT reaches CTA activation —
 * which is exactly the gap that let a broken click dispatcher ship while unit
 * tests stayed green.
 *
 * The fixture is served over http://localhost so the manifest's content-script
 * matches apply (a file:// page is not matched, and would silently prove
 * nothing).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const FIXTURE = fs.readFileSync(path.join(here, "fixtures", "listing-tiktok.html"), "utf8");
const UNTRUSTED = fs.readFileSync(path.join(here, "fixtures", "listing-untrusted.html"), "utf8");

type Fixtures = { context: BrowserContext; worker: Worker; origin: string };

const test = base.extend<Fixtures>({
  origin: async ({}, use) => {
    const server: Server = createServer((request, response) => {
      if (request.url?.startsWith("/job")) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(FIXTURE);
        return;
      }
      // A listing whose CTA is a real anchor AND which ignores untrusted
      // clicks — the shape that requires URL-first navigation to work.
      if (request.url?.startsWith("/listing")) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(UNTRUSTED);
        return;
      }
      if (request.url?.startsWith("/careers/apply/")) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>Apply</title>
          <form id="application-form" action="/submit" method="post">
            <label for="first_name">First name</label><input id="first_name" name="first_name" required />
            <label for="last_name">Last name</label><input id="last_name" name="last_name" required />
            <label for="email">Email</label><input id="email" name="email" type="email" required />
            <label for="phone">Phone</label><input id="phone" name="phone" />
            <button type="submit" id="final-submit">Submit application</button>
          </form>`);
        return;
      }
      response.writeHead(404).end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await use(`http://localhost:${port}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  },
  context: async ({ origin }, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      // The session package is fetched by the SERVICE WORKER, not the page, so
      // page-level routing would never see it.
      serviceWorkers: "allow"
    });

    const applicationUrl = `${origin}/job`;
    const sessionBody = {
      session_id: 55,
      ats_type: null,
      official_application_url: applicationUrl,
      job: { title: "Software Engineer, Recommendation Infrastructure", company: "Careers" },
      resume: { status: "ready", document_id: 1, download_url: null },
      cover_letter: { status: "ready", document_id: 2, download_url: null },
      profile: { email: "candidate@example.test", full_name: "Test Candidate" }
    };
    await context.route("**/application-sessions/token", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session_token: "e2e-session-token", session: sessionBody })
      })
    );
    await context.route("**/application-sessions/*/answers", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ answers: [], unresolved_questions: [], refreshed: false, profile_revision: "r1" })
      })
    );
    await context.route("**/application-sessions/*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) })
    );

    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    await use(worker);
  }
});

test.describe.configure({ mode: "serial" });

test("the shipped content script clicks 'Apply to this job' with no user action", async ({
  context,
  worker,
  origin
}) => {
  const applicationUrl = `${origin}/job`;

  // Seed the handoff the background looks for, exactly as a real launch would,
  // and stub the session package so no network call is needed. The token here
  // is a throwaway test value and never leaves this process.
  await worker.evaluate(async (url) => {
    const now = Date.now();
    const launch = {
      version: 1,
      applicationId: "e2e-app",
      jobId: "4242",
      applicationUrl: url,
      status: "prepared",
      handoffToken: "e2e-handoff",
      requestId: "e2e-request",
      sessionId: 55,
      launchToken: "e2e-launch",
      officialUrl: url,
      expectedOrigin: new URL(url).origin,
      createdAt: now,
      expiresAt: now + 15 * 60 * 1000,
      state: "waiting_for_content_script",
      protocolVersion: 3,
      atsType: null
    };
    await chrome.storage.local.set({ activeAssistedApplyHandoffV1: launch });
  }, applicationUrl);

  const page = await context.newPage();


  // The extension's own safe, low-cardinality state log — no page HTML, no
  // user data, no tokens.
  const states: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("[EZJobFind]")) states.push(text.slice(0, 160));
  });

  await page.goto(applicationUrl);

  // No user interaction of any kind happens after this point.
  await page.waitForSelector("#application-form", { timeout: 20_000 });

  const result = await page.evaluate(() => {
    const fixture = (window as unknown as { __jobpilotFixture: { clicks: string[] } }).__jobpilotFixture;
    return {
      clicks: fixture.clicks,
      url: location.href,
      formPresent: Boolean(document.querySelector("#application-form"))
    };
  });

  console.log("\n=== SHIPPED EXTENSION STATE SEQUENCE ===\n" + states.join("\n"));
  console.log("\n=== FIXTURE RESULT ===\n" + JSON.stringify(result, null, 2));

  expect(result.formPresent).toBe(true);
  expect(result.url).toContain("step=application");
  // The job-specific CTA was activated with a real pointer sequence.
  expect(result.clicks).toContain("primary-apply");
  expect(result.clicks).not.toContain("primary-apply:ignored-no-pointer");
  // Nothing else was touched.
  expect(result.clicks).not.toContain("header-apply");
  expect(result.clicks).not.toContain("cookie-accept");
  expect(result.clicks.filter((entry) => entry === "primary-apply")).toHaveLength(1);

  await page.close();
});

test("the shipped extension never activates the final Submit control", async ({
  context,
  worker,
  origin
}) => {
  const applicationUrl = `${origin}/job`;
  await worker.evaluate(async (url) => {
    const now = Date.now();
    await chrome.storage.local.set({
      activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "e2e-app-2", jobId: "4242", applicationUrl: url,
        status: "prepared", handoffToken: "e2e-handoff", requestId: "e2e-request-2",
        sessionId: 55, launchToken: "e2e-launch", officialUrl: url,
        expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      }
    });
  }, applicationUrl);

  const page = await context.newPage();

  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  // Give any mutation-driven follow-up a chance to misbehave.
  await page.waitForTimeout(2500);

  const clicks = await page.evaluate(
    () => (window as unknown as { __jobpilotFixture: { clicks: string[] } }).__jobpilotFixture.clicks
  );
  expect(clicks.some((entry) => entry.toLowerCase().includes("submit"))).toBe(false);
  // The form is still there and unsubmitted.
  expect(await page.locator("#final-submit").count()).toBe(1);

  await page.close();
});


test("URL-first: the shipped extension navigates via the service worker, without a trusted click", async ({
  context,
  worker,
  origin
}) => {
  // This listing rejects every script-dispatched click (isTrusted === false),
  // so the ONLY way to reach the application is by reading the anchor's href
  // and navigating through chrome.tabs. A regression to click-based activation
  // fails here rather than passing on a permissive fixture.
  const listingUrl = `${origin}/listing?cta=anchor`;
  await worker.evaluate(async (url) => {
    const now = Date.now();
    await chrome.storage.local.set({
      activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "e2e-url-first", jobId: "4242", applicationUrl: url,
        status: "prepared", handoffToken: "e2e-handoff", requestId: "e2e-url-first",
        sessionId: 55, launchToken: "e2e-launch", officialUrl: url,
        expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      }
    });
  }, listingUrl);

  const page = await context.newPage();
  const states: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("[EZJobFind]")) states.push(text.slice(0, 160));
  });

  await page.goto(listingUrl);

  // No user interaction. The tab must navigate itself to the application.
  await page.waitForURL(/\/careers\/apply\//, { timeout: 20_000 });
  await page.waitForSelector("#application-form", { timeout: 10_000 });

  console.log("\n=== URL-FIRST STATE SEQUENCE ===\n" + states.join("\n"));
  expect(page.url()).toContain("/careers/apply/12345");
  expect(await page.locator("#application-form").count()).toBe(1);
  // The final submit was never activated.
  expect(await page.locator("#final-submit").count()).toBe(1);

  await page.close();
});

test("URL-first: target=_blank opens a new tab that is bound to the same session", async ({
  context,
  worker,
  origin
}) => {
  const listingUrl = `${origin}/listing?cta=anchor-blank`;
  await worker.evaluate(async (url) => {
    const now = Date.now();
    await chrome.storage.local.set({
      activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "e2e-newtab", jobId: "4242", applicationUrl: url,
        status: "prepared", handoffToken: "e2e-handoff", requestId: "e2e-newtab",
        sessionId: 55, launchToken: "e2e-launch", officialUrl: url,
        expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      }
    });
  }, listingUrl);

  const page = await context.newPage();
  const opened = context.waitForEvent("page", { timeout: 20_000 });
  await page.goto(listingUrl);

  const applicationPage = await opened;
  await applicationPage.waitForURL(/\/careers\/apply\//, { timeout: 15_000 });
  await applicationPage.waitForSelector("#application-form", { timeout: 10_000 });

  expect(applicationPage.url()).toContain("/careers/apply/12345");
  // The listing tab stayed where it was; the application is in the new tab.
  expect(page.url()).toContain("/listing");

  // The service worker bound the NEW tab to the existing launch.
  const bound = await worker.evaluate(async () => {
    const store = await chrome.storage.local.get("pendingLaunches");
    const map = (store.pendingLaunches ?? {}) as Record<string, { sessionId: number }>;
    return Object.values(map).map((launch) => launch.sessionId);
  });
  expect(bound).toContain(55);

  await applicationPage.close();
  await page.close();
});
