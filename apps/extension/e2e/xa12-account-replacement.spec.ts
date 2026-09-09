import { expect, test, chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

async function unusedLoopbackPort(): Promise<number> {
  for (const port of [3000, 3001]) {
    const available = await new Promise<boolean>(resolve => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("XA-12 requires an approved loopback fixture port (3000 or 3001)");
}

async function waitForLogin(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`XA-12 Web fixture exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/login`);
      if (response.status === 200) return;
    } catch {
      // The server has not bound its socket yet.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("XA-12 Web fixture did not become ready");
}

async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>(resolve => child.once("exit", () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("XA-12: production Web activates replacement auth only after production MV3 purge ACK", async () => {
  test.setTimeout(90_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  let submissionRequests = 0;
  let webFixture: ChildProcess | null = null;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    let webUrl = process.env.XA12_WEB_URL;
    if (!webUrl) {
      const port = await unusedLoopbackPort();
      webUrl = `http://localhost:${port}`;
      const webRoot = path.resolve(here, "..", "..", "web");
      webFixture = spawn(process.execPath, [
        path.join(webRoot, "node_modules", "next", "dist", "bin", "next"),
        "dev", "--hostname", "localhost", "--port", String(port)
      ], {
        cwd: webRoot,
        env: { ...process.env, NEXT_PUBLIC_CHROME_EXTENSION_ID: extensionId },
        stdio: ["ignore", "pipe", "pipe"]
      });
      await waitForLogin(webUrl, webFixture);
    }
    const page = await context.newPage();
    await page.addInitScript(() => {
      const runtime = (globalThis as typeof globalThis & { chrome?: { runtime?: { sendMessage?: (...args: unknown[]) => unknown } } }).chrome?.runtime;
      if (!runtime || typeof runtime.sendMessage !== "function") return;
      const original = runtime.sendMessage.bind(runtime);
      (globalThis as typeof globalThis & { __xa12Messages?: Array<{ extensionId: unknown; type: unknown; at: number }> }).__xa12Messages = [];
      runtime.sendMessage = (...args: unknown[]) => {
        (globalThis as typeof globalThis & { __xa12Messages: Array<{ extensionId: unknown; type: unknown; at: number }> }).__xa12Messages.push({
          extensionId: args[0], type: (args[1] as { type?: unknown } | undefined)?.type, at: performance.now()
        });
        return original(...args);
      };
    });
    await page.route("http://localhost:8000/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/auth/login") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: "user-b-token", token_type: "bearer" }) });
        return;
      }
      if (url.pathname.includes("complete") || url.pathname.includes("submission")) submissionRequests += 1;
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "not part of XA-12" }) });
    });
    await page.goto(`${webUrl}/login`);
    const readiness = await page.evaluate(extensionId => new Promise<{ response: unknown; error: string | null }>(resolve => {
      chrome.runtime.sendMessage(extensionId, { type: "XPERTAPPLY_EXTERNAL_PING" }, response => {
        resolve({ response, error: chrome.runtime.lastError?.message ?? null });
      });
    }), extensionId);
    expect(readiness.error).toBeNull();
    expect(readiness.response).toMatchObject({ ok: true, info: { installed: true } });
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
        __xa12EnteredAt?: number;
        __xa12Release?: () => void;
        __xa12Senders?: Array<{ type: unknown; at: number; id: string | null; tabId: number | null; frameId: number | null; origin: string | null; url: string | null }>;
      };
      runtime.__xa12Entered = false;
      runtime.__xa12Senders = [];
      chrome.runtime.onMessageExternal.addListener((message, sender) => {
        runtime.__xa12Senders?.push({
          type: (message as { type?: unknown })?.type,
          at: Date.now(),
          id: sender.id ?? null,
          tabId: sender.tab?.id ?? null,
          frameId: sender.frameId ?? null,
          origin: sender.origin ?? null,
          url: sender.url ?? null
        });
      });
      const originalRemove = chrome.storage.local.remove.bind(chrome.storage.local);
      chrome.storage.local.remove = async (keys) => {
        if (keys === "jobpilotWebRuntimeV2") {
          runtime.__xa12Entered = true;
          runtime.__xa12EnteredAt = Date.now();
          await new Promise<void>((resolve) => { runtime.__xa12Release = resolve; });
        }
        await originalRemove(keys);
      };
    });

    await page.getByLabel("Email address").fill("user-b@example.test");
    await page.locator("#auth-password").fill("correct-horse-battery");
    const replacementStartedAt = Date.now();
    await page.getByRole("button", { name: "Log in" }).click();
    await expect.poll(() => page.evaluate(() =>
      (globalThis as typeof globalThis & { __xa12Messages?: Array<{ type: unknown }> }).__xa12Messages?.map(message => message.type) ?? []
    )).toContain("XPERTAPPLY_EXTERNAL_SESSION_END");
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
    const replacementActivatedAt = Date.now();

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
    const workerEvidence = await worker.evaluate(() => {
      const runtime = globalThis as typeof globalThis & { __xa12EnteredAt?: number; __xa12Senders?: unknown[] };
      return { enteredAt: runtime.__xa12EnteredAt ?? null, senders: runtime.__xa12Senders ?? [] };
    });
    console.log("XA12_REPLACEMENT", JSON.stringify({
      beforeResponseToken: null, afterForgedMessageToken: null, afterBrowserResponseToken: "present",
      newSession: 2202, oldState: 0, submissions: 0,
      timing: { replacementStartedAt, replacementActivatedAt, ...workerEvidence }
    }));
  } finally {
    await context.close();
    if (webFixture) await stopFixture(webFixture);
  }
});
