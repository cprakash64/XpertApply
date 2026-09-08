import { expect, test, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

const fixture = (extensionId: string) => `<!doctype html><title>XpertApply</title>
  <button id="logout" type="button">Log out</button>
  <script>
    window.__xa12Ack = null;
    window.__xa12AfterForgery = null;
    localStorage.setItem("access_token", "user-a-web-token");
    document.querySelector("#logout").addEventListener("click", () => {
      localStorage.removeItem("access_token");
      // Exact legacy public labels and request IDs are page-forgeable. They
      // must now be inert because auth teardown has no postMessage listener.
      window.postMessage({ source: "jobpilot-extension", type: "JOBPILOT_PONG" }, window.location.origin);
      window.postMessage({
        source: "jobpilot-extension",
        type: "JOBPILOT_SESSION_END_RESULT",
        requestId: "page-logout-1"
        , ok: true
      }, window.location.origin);
      window.__xa12AfterForgery = localStorage.getItem("access_token");
      chrome.runtime.sendMessage("${extensionId}", { type: "XPERTAPPLY_EXTERNAL_PING" }, (ping) => {
        if (chrome.runtime.lastError || ping?.ok !== true) {
          window.__xa12Ack = false;
          return;
        }
        chrome.runtime.sendMessage("${extensionId}", {
          type: "XPERTAPPLY_EXTERNAL_SESSION_END", reason: "logout"
        }, (result) => { window.__xa12Ack = !chrome.runtime.lastError && result?.ok === true; });
      });
    });
  </script>`;

test("XA-12: web logout purges every extension workflow reference to the prior user", async () => {
  test.setTimeout(60_000);
  let extensionId = "";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture(extensionId));
  });
  const ownsServer = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(3001, "127.0.0.1", () => resolve(true));
  });
  const origin = "http://localhost:3001";
  const applicationUrl = "https://employer.example.test/apply";
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    extensionId = new URL(worker.url()).host;
    await worker.evaluate(async ({ applicationUrl }) => {
      const now = Date.now();
      const launch = {
        version: 1,
        applicationId: "user-a-application",
        jobId: "1201",
        applicationUrl,
        status: "prepared",
        handoffToken: "user-a-handoff",
        requestId: "user-a-request",
        sessionId: 1201,
        launchToken: "user-a-launch",
        officialUrl: applicationUrl,
        expectedOrigin: new URL(applicationUrl).origin,
        createdAt: now,
        expiresAt: now + 900_000,
        targetTabId: 41,
        state: "package_ready",
        protocolVersion: 3,
        atsType: null
      };
      await chrome.storage.session.set({
        activeAssistedApplyHandoffV1: launch,
        pendingLaunches: { "41": launch },
        viewStates: { "41": { tabId: 41, sessionId: 1201, requestId: "user-a-request" } },
        sessionPackages: { "41": {
          sessionToken: "user-a-session-token",
          cachedAt: now,
          session: { sessionId: 1201, authenticatedUserId: 701 }
        } },
        pendingApplyActivationV1: {
          launchId: "user-a-launch-id",
          applicationId: "user-a-application",
          sourceTabId: 41,
          sessionId: 1201,
          createdAt: now,
          expiresAt: now + 90_000
        }
      });
      await chrome.storage.local.set({
        jobpilotWebRuntimeV2: {
          webEnvironment: "local",
          webApiBase: "http://localhost:8000/api/v1",
          webAuthenticatedUserId: 701
        }
      });
    }, { applicationUrl });

    const hostile = await context.newPage();
    await hostile.route("https://employer.example.test/**", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: "<!doctype html><title>Hostile employer</title>"
    }));
    await hostile.goto("https://employer.example.test/attack");
    const hostileResult = await hostile.evaluate(async (targetExtensionId) => {
      const externalChrome = (globalThis as typeof globalThis & {
        chrome?: { runtime?: { lastError?: { message?: string }; sendMessage?: Function } };
      }).chrome;
      if (typeof externalChrome?.runtime?.sendMessage !== "function") return "API_NOT_EXPOSED";
      return new Promise<string>((resolve) => {
        externalChrome.runtime!.sendMessage!(targetExtensionId, {
          type: "XPERTAPPLY_EXTERNAL_SESSION_END", reason: "logout"
        }, (response: unknown) => resolve(externalChrome.runtime?.lastError?.message ?? JSON.stringify(response)));
      });
    }, extensionId);
    expect(hostileResult).not.toContain('"ok":true');
    expect(await worker.evaluate(async () => Boolean(
      (await chrome.storage.session.get("activeAssistedApplyHandoffV1")).activeAssistedApplyHandoffV1
    ))).toBe(true);
    await hostile.close();

    const page = await context.newPage();
    await page.goto(ownsServer ? origin : `${origin}/login`);
    const teardownStartedAt = Date.now();
    await page.getByRole("button", { name: "Log out" }).click();
    expect(await page.evaluate(() => (window as unknown as { __xa12AfterForgery: string | null }).__xa12AfterForgery)).toBeNull();

    await expect.poll(async () => worker.evaluate(async () => {
      const stored = await chrome.storage.session.get([
        "activeAssistedApplyHandoffV1",
        "pendingLaunches",
        "viewStates",
        "sessionPackages",
        "pendingApplyActivationV1"
      ]);
      const local = await chrome.storage.local.get("jobpilotWebRuntimeV2");
      return {
        active: stored.activeAssistedApplyHandoffV1,
        pending: stored.pendingLaunches,
        views: stored.viewStates,
        packages: stored.sessionPackages,
        activation: stored.pendingApplyActivationV1,
        webRuntime: local.jobpilotWebRuntimeV2
      };
    }), { timeout: 5_000 }).toEqual({
      active: undefined,
      pending: undefined,
      views: undefined,
      packages: undefined,
      activation: undefined,
      webRuntime: undefined
    });
    const teardownMs = Date.now() - teardownStartedAt;
    console.log(`XA12_MV3 ${JSON.stringify({ teardownMs, storesRemaining: 0, hostileOrigin: hostileResult })}`);
    expect(teardownMs).toBeLessThan(2_000);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __xa12Ack: boolean | null }).__xa12Ack))
      .toBe(true);
    await page.close();
  } finally {
    await context.close();
    if (ownsServer) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
