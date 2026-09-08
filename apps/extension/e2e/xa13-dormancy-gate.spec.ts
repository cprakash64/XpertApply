import { expect, test, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

test("XA-13: an injected no-handoff frame performs zero DOM probes", async () => {
  test.setTimeout(60_000);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Unrelated employer page</title>
      <main><h1>Careers</h1><form>
        <label>First name <input name="first_name" required></label>
        <label>Last name <input name="last_name" required></label>
        <label>Email <input name="email" type="email" required></label>
        <label>Resume <input name="resume" type="file"></label>
        <button type="submit">Explore opportunities</button>
      </form></main>
      <script>
        window.__xa13SubmitCount = 0;
        document.querySelector("form").addEventListener("submit", (event) => {
          event.preventDefault();
          window.__xa13SubmitCount += 1;
        });
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  // Instrument only a disposable copy of the shipped bundle. This counter is
  // inside probeFrame itself, so the assertion cannot be satisfied by merely
  // suppressing a message or hiding a result after the DOM scan occurred.
  const instrumentedDist = mkdtempSync(path.join(tmpdir(), "xa13-dist-"));
  cpSync(DIST, instrumentedDist, { recursive: true });
  const manifestPath = path.join(instrumentedDist, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), `${origin}/*`])];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const contentPath = path.join(instrumentedDist, "content.js");
  let content = readFileSync(contentPath, "utf8");
  const needle = "function probeFrame(doc = document) {";
  expect(content.split(needle)).toHaveLength(2);
  content = content.replace(
    needle,
    `${needle}\n    globalThis.__xa13ProbeCount = (globalThis.__xa13ProbeCount || 0) + 1;`
  );
  if (process.env.XA13_NEGATIVE_CONTROL === "eager-probe") {
    const ready = "sendRuntime({ type: MSG.CONTENT_READY })";
    expect(content.split(ready)).toHaveLength(2);
    content = content.replace(
      ready,
      "sendRuntime({ type: MSG.CONTENT_READY, probe: buildFrameProbe() })"
    );
  }
  writeFileSync(contentPath, content);

  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${instrumentedDist}`,
      `--load-extension=${instrumentedDist}`
    ],
    serviceWorkers: "allow"
  });
  try {
    const worker = context.serviceWorkers()[0]
      ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    await worker.evaluate(async () => {
      await chrome.storage.session.clear();
      await chrome.storage.local.clear();
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const scope = globalThis as typeof globalThis & { __xa13FetchCount?: number };
      scope.__xa13FetchCount = 0;
      globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        scope.__xa13FetchCount! += 1;
        return nativeFetch(...args);
      }) as typeof fetch;
    });

    const page = await context.newPage();
    await page.goto(`${origin}/unrelated`);
    const tabId = await worker.evaluate(async (url) =>
      (await chrome.tabs.query({ url })).find((tab) => tab.id != null)?.id ?? null,
    `${origin}/unrelated`);
    expect(tabId).not.toBeNull();

    // Exercise the shipped employer entrypoint even though XA-06 would not
    // naturally inject it without an active workflow. XA-13's invariant is
    // stronger: accidental/stale injection must still remain dormant.
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id! },
        func: () => {
          const NativeMutationObserver = MutationObserver;
          const scope = globalThis as typeof globalThis & { __xa13MutationObserverCount?: number };
          scope.__xa13MutationObserverCount = 0;
          globalThis.MutationObserver = class extends NativeMutationObserver {
            constructor(callback: MutationCallback) {
              scope.__xa13MutationObserverCount! += 1;
              super(callback);
            }
          };
        }
      });
      await chrome.scripting.executeScript({ target: { tabId: id! }, files: ["content.js"] });
    }, tabId);
    await page.waitForTimeout(500);
    const noHandoffProbeCount = await worker.evaluate(async (id) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: id! },
        func: () => Number((globalThis as typeof globalThis & { __xa13ProbeCount?: number }).__xa13ProbeCount ?? 0)
      });
      return Number(result?.result ?? 0);
    }, tabId);
    expect(noHandoffProbeCount).toBe(0);
    const noHandoffMutationObservers = await worker.evaluate(async (id) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: id! },
        func: () => Number((globalThis as typeof globalThis & { __xa13MutationObserverCount?: number }).__xa13MutationObserverCount ?? 0)
      });
      return Number(result?.result ?? 0);
    }, tabId);
    expect(noHandoffMutationObservers).toBe(0);
    expect(await worker.evaluate(() =>
      Number((globalThis as typeof globalThis & { __xa13FetchCount?: number }).__xa13FetchCount ?? 0)
    )).toBe(0);
    expect(await page.locator("input").evaluateAll((nodes) =>
      nodes.every((node) => (node as HTMLInputElement).value === "")
    )).toBe(true);
    expect(await page.locator('[data-jobpilot-widget],#jobpilot-widget,[id*="jobpilot"]').count()).toBe(0);
    expect(await page.evaluate(() =>
      Number((window as typeof window & { __xa13SubmitCount?: number }).__xa13SubmitCount ?? 0)
    )).toBe(0);

    // Positive control: the same entrypoint must probe after an exact live
    // handoff is bound to the browser-supplied tab and origin.
    await page.reload();
    const authorizedProbeStartedAt = Date.now();
    await worker.evaluate(async ({ id, applicationUrl }) => {
      const now = Date.now();
      const launch = {
        version: 1,
        applicationId: "xa13-application",
        jobId: "1313",
        applicationUrl,
        status: "prepared",
        handoffToken: "xa13-handoff",
        requestId: "xa13-request",
        sessionId: 1313,
        launchToken: "xa13-launch",
        officialUrl: applicationUrl,
        expectedOrigin: new URL(applicationUrl).origin,
        createdAt: now,
        expiresAt: now + 900_000,
        targetTabId: id,
        state: "package_ready",
        protocolVersion: 3,
        atsType: null
      };
      await chrome.storage.session.set({
        activeAssistedApplyHandoffV1: launch,
        pendingLaunches: { [String(id)]: launch },
        sessionPackages: { [String(id)]: {
          sessionToken: "xa13-session-token",
          cachedAt: now,
          session: {
            sessionId: 1313,
            jobTitle: "Test Engineer",
            company: "Example Employer",
            officialUrl: applicationUrl,
            profileData: { first_name: "Test", last_name: "Candidate", email: "candidate@example.test" },
            answers: [],
            unresolvedQuestions: []
          }
        } }
      });
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] });
    }, { id: tabId!, applicationUrl: `${origin}/unrelated` });

    await expect.poll(async () => worker.evaluate(async (id) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => Number((globalThis as typeof globalThis & { __xa13ProbeCount?: number }).__xa13ProbeCount ?? 0)
      });
      return Number(result?.result ?? 0);
    }, tabId!)).toBeGreaterThan(0);
    const authorizedProbePathMs = Date.now() - authorizedProbeStartedAt;

    console.log(`XA13_MV3 ${JSON.stringify({
      noHandoffProbeCount,
      noHandoffMutationObservers,
      authorizedProbeCount: await worker.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => Number((globalThis as typeof globalThis & { __xa13ProbeCount?: number }).__xa13ProbeCount ?? 0)
        });
        return Number(result?.result ?? 0);
      }, tabId!),
      authorizedProbePathMs,
      requests: requests.filter((request) => !request.endsWith("/favicon.ico"))
    })}`);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
