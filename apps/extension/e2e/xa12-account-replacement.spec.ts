import { expect, test, chromium, type BrowserContext, type Worker, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

async function unusedLoopbackPort(): Promise<number> {
  // The external teardown channel also accepts 3001, but the page handoff
  // bridge does not. Never silently choose an origin with no staging listener.
  for (const port of [3000]) {
    const available = await new Promise<boolean>(resolve => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("XA-12 requires a handoff bridge fixture port 3000; stop any owned fixture or set XA12_WEB_URL to a supported bridge origin");
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

async function qualifyHandoff(context: BrowserContext, worker: Worker, page: Page): Promise<void> {
    // A staging record is a locator, not private account authority. Replaying
    // an old locator must fail token exchange and never produce a package.
    let oldTokenRejected = 0;
    let newTokenAccepted = 0;
    const employerBase = "http://127.0.0.1:39991";
    await context.route(`${employerBase}/**`, route => route.fulfill({
      status: 200, contentType: "text/html", body: `<!doctype html><title>Application</title>
        <form><label for="name">Full name</label><input id="name"><label for="email">Email address</label><input id="email" type="email"><label for="phone">Phone</label><input id="phone" type="tel"><button type="submit">Submit application</button></form>
        <script>window.__submits=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.__submits++})</script>`
    }));
    await context.route("http://localhost:8000/application-sessions/**", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/token")) {
        const body = request.postDataJSON() as { launch_token?: string };
        if (body.launch_token === "old") {
          oldTokenRejected++;
          await route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"synthetic revoked old-account token"}' });
          return;
        }
        expect(body.launch_token).toBe("user-b-launch");
        newTokenAccepted++;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: "synthetic-b-package" }) });
        return;
      }
      if (pathname.endsWith("/answers")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"answers":[],"unresolved_questions":[]}' });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        session_id: 2202, authenticated_user_id: 702, ats_type: null,
        official_application_url: `${employerBase}/new`, job: { title: "Synthetic application" }, profile: {}
      }) });
    });
    await worker.evaluate(async () => chrome.storage.local.set({ apiBase: "http://localhost:8000" }));
    const stage = async (old: boolean) => {
      await page.evaluate(({ old, employerBase }) => window.postMessage({
        source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: {
          requestId: old ? "replayed-old" : "replacement-owned", launchToken: old ? "old" : "user-b-launch",
          sessionId: old ? 1201 : 2202, jobId: old ? 1 : 2,
          officialUrl: `${employerBase}/${old ? "old" : "new"}`, atsType: null,
          webApiBase: "http://localhost:8000", webAuthenticatedUserId: 702
        }
      }, location.origin), { old, employerBase });
      await expect.poll(() => worker.evaluate(async () => {
        const data = await chrome.storage.session.get("activeAssistedApplyHandoffV1");
        return data.activeAssistedApplyHandoffV1?.sessionId;
      })).toBe(old ? 1201 : 2202);
    };
    const openEmployer = async (suffix: string) => {
      const employer = await context.newPage();
      await employer.goto(`${employerBase}/${suffix}`);
      await worker.evaluate(async url => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(tab => tab.url === url);
        if (!tab?.id) throw new Error("Synthetic employer tab missing");
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      }, employer.url());
      // Resolve the browser-attributed readiness response rather than racing
      // a Node-side network counter against asynchronous script initialization.
      await worker.evaluate(async url => {
        const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
        if (!tab?.id) throw new Error("Synthetic employer tab missing");
        const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () =>
          await chrome.runtime.sendMessage({ type: "JOBPILOT_CONTENT_READY" }) });
        return result[0]?.result;
      }, employer.url());
      return employer;
    };
    await stage(true);
    const oldEmployer = await openEmployer("old");
    await expect.poll(() => oldTokenRejected).toBeGreaterThan(0);
    expect(await worker.evaluate(async () => {
      const data = await chrome.storage.session.get("sessionPackages");
      return Object.values(data.sessionPackages ?? {}).some(value => (value as { session?: { sessionId?: number } }).session?.sessionId === 1201);
    })).toBe(false);
    expect(await oldEmployer.locator("#name").inputValue()).toBe("");

    await stage(false);
    const newEmployer = await openEmployer("new");
    await expect.poll(() => worker.evaluate(async () => {
      const data = await chrome.storage.session.get("sessionPackages");
      return Object.values(data.sessionPackages ?? {}).some(value => {
        const entry = value as { session?: { sessionId?: number; authenticatedUserId?: number } };
        return entry.session?.sessionId === 2202 && entry.session?.authenticatedUserId === 702;
      });
    })).toBe(true);
    expect(newTokenAccepted).toBe(1);
    expect(await oldEmployer.evaluate(() => (window as Window & { __submits?: number }).__submits)).toBe(0);
    expect(await newEmployer.evaluate(() => (window as Window & { __submits?: number }).__submits)).toBe(0);


}

async function runReplacement(roundTrip = false): Promise<void> {
  test.setTimeout(90_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  let submissionRequests = 0;
  let loginToken = "user-b-token";
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
    if (!["http://localhost:3000", "http://127.0.0.1:3000"].includes(new URL(webUrl).origin)) {
      throw new Error("XA-12 Web fixture must use a current development handoff bridge origin");
    }


    const page = await context.newPage();
    await page.addInitScript(() => {
      const runtime = (globalThis as unknown as { chrome?: { runtime?: { sendMessage?: (...args: unknown[]) => unknown } } }).chrome?.runtime;
      if (!runtime || typeof runtime.sendMessage !== "function") return;
      const original = runtime.sendMessage.bind(runtime);
      (globalThis as typeof globalThis & { __xa12Messages?: Array<{ extensionId: unknown; type: unknown }> }).__xa12Messages = [];
      runtime.sendMessage = (...args: unknown[]) => {
        (globalThis as typeof globalThis & { __xa12Messages: Array<{ extensionId: unknown; type: unknown }> }).__xa12Messages.push({
          extensionId: args[0], type: (args[1] as { type?: unknown } | undefined)?.type
        });
        return original(...args);
      };
    });
    await page.route("http://localhost:8000/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/auth/login") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: loginToken, token_type: "bearer" }) });
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
    const oldReferences: Page[] = [];
    await context.route("http://127.0.0.1:39992/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Old account document</title>" }));
    for (const suffix of ["one", "two"]) {
      const oldPage = await context.newPage();
      await oldPage.goto(`http://127.0.0.1:39992/${suffix}`);
      oldReferences.push(oldPage);
    }
    await page.bringToFront();
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
      const tabs = (await chrome.tabs.query({})).filter(tab => tab.url?.startsWith("http://127.0.0.1:39992/"));
      if (tabs.length !== 2) throw new Error("Two old-account fixture tabs are required");
      const pending: Record<string, unknown> = {};
      const views: Record<string, unknown> = {};
      const packages: Record<string, unknown> = {};
      for (const tab of tabs) {
        pending[String(tab.id)] = { ...old, targetTabId: tab.id };
        views[String(tab.id)] = { tabId: tab.id, sessionId: 1201 };
        packages[String(tab.id)] = { sessionToken: "synthetic-a-private", cachedAt: now, session: { sessionId: 1201, authenticatedUserId: 701 } };
      }
      await chrome.storage.session.set({ pendingLaunches: pending, viewStates: views, sessionPackages: packages });
      const runtime = globalThis as typeof globalThis & {
        __xa12Entered?: boolean;
        __xa12Release?: () => void;
      };
      runtime.__xa12Entered = false;
      const originalRemove = chrome.storage.local.remove.bind(chrome.storage.local);
      chrome.storage.local.remove = async (keys) => {
        if (keys === "jobpilotWebRuntimeV2" && !runtime.__xa12Entered) {
          runtime.__xa12Entered = true;
          await new Promise<void>((resolve) => { runtime.__xa12Release = resolve; });
        }
        await originalRemove(keys);
      };
    });

    await page.getByLabel("Email address").fill("user-b@example.test");
    await page.locator("#auth-password").fill("correct-horse-battery");


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


    const purged = await worker.evaluate(async () => {
      const keys = ["activeAssistedApplyHandoffV1", "pendingLaunches", "viewStates", "sessionPackages", "pendingApplyActivationV1"];
      const stored = await chrome.storage.session.get(keys);
      return keys.filter(key => stored[key] !== undefined);
    });
    expect(purged).toEqual([]);

    // Token storage precedes router.replace. Wait for the production login
    // destination before sending a one-shot page bridge message.
    await page.waitForURL("**/dashboard");
    const bridgeReady = await page.evaluate(() => new Promise<boolean>(resolve => {
      const requestId = "xa12-bridge-ready";
      const listener = (event: MessageEvent) => {
        if (event.source !== window || event.origin !== location.origin ||
            event.data?.type !== "XPERTAPPLY_EXTENSION_PRESENCE_READY" || event.data?.requestId !== requestId) return;
        window.removeEventListener("message", listener);
        resolve(true);
      };
      window.addEventListener("message", listener);
      window.postMessage({ source: "jobpilot-web", type: "XPERTAPPLY_EXTENSION_PRESENCE_PING", requestId }, location.origin);
    }));
    expect(bridgeReady).toBe(true);


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
    await qualifyHandoff(context, worker, page);
    await worker.evaluate(async () => {
      const tabs = (await chrome.tabs.query({})).filter(tab => tab.url?.startsWith("http://127.0.0.1:39992/"));
      // Observe surviving old-account references without reinjecting a fresh
      // current-generation content script (which would grant new authority).
      const data = await chrome.storage.session.get(["pendingLaunches", "sessionPackages"]);
      for (const tab of tabs) {
        // A fresh reconnect may create sanitized new-workflow metadata on a
        // workflow origin; this is not private package/document authority.
        if (data.pendingLaunches?.[String(tab.id)]?.sessionId === 1201 || data.sessionPackages?.[String(tab.id)]) {
          throw new Error("Old document retained old session or adopted a private package");
        }
      }
    });

    if (roundTrip) {
      loginToken = "user-a-new-token";
      await page.goto(`${webUrl}/login`);
      await page.getByLabel("Email address").fill("user-a@example.test");
      await page.locator("#auth-password").fill("correct-horse-battery");
      await page.getByRole("button", { name: "Log in" }).click();
      await expect.poll(() => page.evaluate(() => localStorage.getItem("jobpilot_token"))).toBe("user-a-new-token");
      await page.waitForURL("**/dashboard");
      expect(await worker.evaluate(async () => {
        const data = await chrome.storage.session.get(["activeAssistedApplyHandoffV1", "pendingLaunches", "viewStates", "sessionPackages"]);
        return Object.keys(data);
      })).toEqual([]);
      await page.evaluate(() => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: {
        requestId: "a-new-session", launchToken: "synthetic-a-new-launch", sessionId: 3303, jobId: 3,
        officialUrl: "https://employer.example.test/a-new", atsType: null,
        webApiBase: "http://localhost:8000", webAuthenticatedUserId: 701
      } }, location.origin));
      await expect.poll(() => worker.evaluate(async () => {
        const data = await chrome.storage.session.get("activeAssistedApplyHandoffV1");
        return data.activeAssistedApplyHandoffV1?.sessionId;
      })).toBe(3303);
      expect(await worker.evaluate(async () => {
        const data = await chrome.storage.session.get(["pendingLaunches", "sessionPackages"]);
        return JSON.stringify(data).includes("2202") || JSON.stringify(data).includes("1201");
      })).toBe(false);

    }
    expect(submissionRequests).toBe(0);




  } finally {
    await context.close();
    if (webFixture) await stopFixture(webFixture);
  }
}

test("XA-12: production Web activates replacement auth only after production MV3 purge ACK", async () => runReplacement());

test("XA-12: A to B to A new session never revives a prior workflow", async () => runReplacement(true));

test("XA-12: direct current handoff rejects revoked old token and adopts replacement package", async () => {
  test.setTimeout(60_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`], serviceWorkers: "allow"
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await context.route("http://localhost:3000/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic authenticated Web</title>" }));
    const page = await context.newPage();
    await page.goto("http://localhost:3000/dashboard");
    await page.evaluate(() => localStorage.setItem("jobpilot_token", "synthetic-b-web-token"));

    await qualifyHandoff(context, worker, page);

  } finally { await context.close(); }
});
