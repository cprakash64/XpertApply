import { expect, test, chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");
const WEB = process.env.XA12_WEB_URL ?? "http://localhost:3000";

test("XA-12: production Web activates replacement auth only after production MV3 purge ACK", async () => {
  test.setTimeout(90_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  let submissionRequests = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await context.newPage();
    await page.route("http://localhost:8000/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/auth/login") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: "user-b-token", token_type: "bearer" }) });
        return;
      }
      if (url.pathname.includes("complete") || url.pathname.includes("submission")) submissionRequests += 1;
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "not part of XA-12" }) });
    });
    await page.goto(`${WEB}/login`);
    await page.evaluate(() => localStorage.setItem("jobpilot_token", "user-a-token"));
    await worker.evaluate(async () => {
      const now = Date.now();
      const old = {
        version: 1, applicationId: "user-a", jobId: "1", applicationUrl: "https://employer.example.test/a",
        status: "prepared", handoffToken: "old", requestId: "old", sessionId: 1201,
        launchToken: "old", officialUrl: "https://employer.example.test/a", expectedOrigin: "https://employer.example.test",
        createdAt: now, expiresAt: now + 900_000, state: "package_ready", protocolVersion: 3, atsType: null
      };
      await chrome.storage.session.set({
        activeAssistedApplyHandoffV1: old,
        pendingLaunches: { "41": old },
        viewStates: { "41": { tabId: 41, sessionId: 1201 } },
        sessionPackages: { "41": { sessionToken: "user-a-session", cachedAt: now, session: { sessionId: 1201, authenticatedUserId: 701 } } }
      });
      const runtime = globalThis as typeof globalThis & {
        __xa12Entered?: boolean;
        __xa12Release?: () => void;
      };
      runtime.__xa12Entered = false;
      const originalRemove = chrome.storage.local.remove.bind(chrome.storage.local);
      chrome.storage.local.remove = async (keys) => {
        if (keys === "jobpilotWebRuntimeV2") {
          runtime.__xa12Entered = true;
          await new Promise<void>((resolve) => { runtime.__xa12Release = resolve; });
        }
        await originalRemove(keys);
      };
    });

    await page.getByLabel("Email address").fill("user-b@example.test");
    await page.locator("#auth-password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect.poll(() => worker.evaluate(() => Boolean((globalThis as typeof globalThis & { __xa12Entered?: boolean }).__xa12Entered)))
      .toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("jobpilot_token"))).toBeNull();
    expect(new URL(page.url()).pathname).toBe("/login");

    await page.evaluate(() => {
      window.postMessage({ source: "jobpilot-extension", type: "JOBPILOT_PONG" }, window.location.origin);
      window.postMessage({
        source: "jobpilot-extension", type: "JOBPILOT_SESSION_END_RESULT",
        requestId: "known-legacy-request", ok: true
      }, window.location.origin);
    });
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => localStorage.getItem("jobpilot_token"))).toBeNull();

    await worker.evaluate(() => (globalThis as typeof globalThis & { __xa12Release?: () => void }).__xa12Release?.());
    await expect.poll(() => page.evaluate(() => localStorage.getItem("jobpilot_token"))).toBe("user-b-token");

    await page.evaluate(() => window.postMessage({
      source: "jobpilot-web",
      type: "JOBPILOT_STAGE_LAUNCH",
      payload: {
        requestId: "user-b-request", launchToken: "user-b-launch", sessionId: 2202, jobId: 2,
        officialUrl: "https://employer.example.test/b", atsType: null,
        webApiBase: "http://localhost:8000", webAuthenticatedUserId: 702
      }
    }, window.location.origin));
    await expect.poll(() => worker.evaluate(async () => {
      const stored = await chrome.storage.session.get("activeAssistedApplyHandoffV1");
      return stored.activeAssistedApplyHandoffV1?.sessionId ?? null;
    })).toBe(2202);
    const final = await worker.evaluate(async () => chrome.storage.session.get([
      "activeAssistedApplyHandoffV1", "pendingLaunches", "viewStates", "sessionPackages"
    ]));
    expect(final.activeAssistedApplyHandoffV1.sessionId).toBe(2202);
    expect(JSON.stringify(final)).not.toContain("1201");
    expect(JSON.stringify(final)).not.toContain("user-a");
    expect(submissionRequests).toBe(0);
    console.log("XA12_REPLACEMENT", JSON.stringify({
      beforeResponseToken: null, afterForgedMessageToken: null, afterBrowserResponseToken: "present",
      newSession: 2202, oldState: 0, submissions: 0
    }));
  } finally {
    await context.close();
  }
});
