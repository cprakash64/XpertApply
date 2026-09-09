import { chromium, expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION_DIST = process.env.XA15_PRODUCTION_DIST ?? path.resolve(here, "..", "dist");
const E2E_DIST = path.resolve(here, "..", "dist-e2e-granted");
const DESTINATION = "https://hostile-destination.example.test/apply";

function hostilePage(): string {
  return `<!doctype html><html><body>
    <h1>Unrelated local process</h1>
    <form><button type="submit">Submit</button></form>
    <script>
      window.__xa15 = { result: null, submissions: 0 };
      document.querySelector("form").addEventListener("submit", (event) => {
        event.preventDefault();
        window.__xa15.submissions += 1;
      });
      window.addEventListener("message", (event) => {
        if (event.data?.type === "JOBPILOT_START_ASSISTED_APPLY_RESULT") {
          window.__xa15.result = event.data.result;
        }
      });
    </script>
  </body></html>`;
}

test.describe.configure({ mode: "serial" });

test("XA-15: the production MV3 bridge does not trust unrelated localhost or 127.0.0.1 processes", async () => {
  test.setTimeout(60_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${PRODUCTION_DIST}`,
      `--load-extension=${PRODUCTION_DIST}`
    ],
    serviceWorkers: "allow"
  });

  try {
    await context.route(/http:\/\/(?:localhost|127\.0\.0\.1):3000\/.*/, (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: hostilePage()
    }));
    const worker = context.serviceWorkers()[0]
      ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
    });

    for (const [index, origin] of ["http://localhost:3000", "http://127.0.0.1:3000"].entries()) {
      const page = await context.newPage();
      await page.goto(`${origin}/hostile`);
      await page.waitForTimeout(500);
      const requestId = `xa15-hostile-request-${index}`;
      const token = `synthetic-xa15-token-${index}`;
      await page.evaluate(({ officialUrl, requestId, token, index }) => {
        window.postMessage({
          source: "jobpilot-web",
          type: "JOBPILOT_START_ASSISTED_APPLY",
          payload: {
            requestId,
            launchToken: token,
            sessionId: 1500 + index,
            jobId: 1500 + index,
            officialUrl,
            atsType: null
          }
        }, window.location.origin);
      }, { officialUrl: DESTINATION, requestId, token, index });
      await page.waitForTimeout(1_000);

      const browserState = await worker.evaluate(async (destination) => {
        const session = await chrome.storage.session.get(null);
        const local = await chrome.storage.local.get(null);
        const tabs = await chrome.tabs.query({});
        return {
          destinationTabs: tabs.filter((tab) => tab.url === destination || tab.pendingUrl === destination).length,
          session,
          local
        };
      }, DESTINATION);
      const pageState = await page.evaluate(() =>
        (window as typeof window & { __xa15: { result: unknown; submissions: number } }).__xa15);

      const vulnerableControl = process.env.XA15_EXPECT_LOCAL_TRUST === "1";
      if (vulnerableControl) {
        expect(pageState.result).toMatchObject({ ok: true });
        expect(browserState.destinationTabs).toBeGreaterThan(0);
      } else {
        expect(pageState.result).toBeNull();
        expect(browserState.destinationTabs).toBe(0);
        expect(JSON.stringify(browserState.session)).not.toContain(token);
        expect(JSON.stringify(browserState.local)).not.toContain(requestId);
      }
      expect(pageState.submissions).toBe(0);
      await page.close();
    }
  } finally {
    await context.close();
  }
});

test("XA-15: removed legacy origin shapes have no production bridge authority", async () => {
  test.setTimeout(60_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${PRODUCTION_DIST}`,
      `--load-extension=${PRODUCTION_DIST}`
    ],
    serviceWorkers: "allow"
  });
  const removedOrigins = [
    "https://app.jobpilot.ai",
    "https://ezjobfind.com",
    "https://www.ezjobfind.com"
  ];

  try {
    for (const origin of removedOrigins) {
      await context.route(`${origin}/**`, (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: hostilePage()
      }));
    }
    const worker = context.serviceWorkers()[0]
      ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });

    for (const [index, origin] of removedOrigins.entries()) {
      const page = await context.newPage();
      await page.goto(`${origin}/xa15-removed-origin`);
      await page.waitForTimeout(500);
      const requestId = `xa15-legacy-request-${index}`;
      await page.evaluate(({ officialUrl, requestId, index }) => window.postMessage({
        source: "jobpilot-web",
        type: "JOBPILOT_START_ASSISTED_APPLY",
        payload: {
          requestId,
          launchToken: `synthetic-legacy-token-${index}`,
          sessionId: 1530 + index,
          jobId: 1530 + index,
          officialUrl,
          atsType: null
        }
      }, window.location.origin), { officialUrl: DESTINATION, requestId, index });
      await page.waitForTimeout(750);

      expect(await page.evaluate(() =>
        (window as typeof window & { __xa15: { result: unknown } }).__xa15.result
      )).toBeNull();
      expect(await worker.evaluate(async (destination) => {
        const tabs = await chrome.tabs.query({});
        return tabs.filter((tab) => tab.url === destination || tab.pendingUrl === destination).length;
      }, DESTINATION)).toBe(0);
      expect(await page.evaluate(() =>
        (window as typeof window & { __xa15: { submissions: number } }).__xa15.submissions
      )).toBe(0);
      await page.close();
    }
  } finally {
    await context.close();
  }
});

test("XA-15: the explicit E2E artifact intentionally retains the loopback bridge", async () => {
  test.setTimeout(60_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${E2E_DIST}`, `--load-extension=${E2E_DIST}`],
    serviceWorkers: "allow"
  });
  try {
    await context.route("http://localhost:3000/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: hostilePage()
    }));
    const page = await context.newPage();
    await page.goto("http://localhost:3000/development");
    await page.waitForTimeout(500);
    await page.evaluate((officialUrl) => window.postMessage({
      source: "jobpilot-web",
      type: "JOBPILOT_START_ASSISTED_APPLY",
      payload: {
        requestId: "xa15-development-request",
        launchToken: "synthetic-development-token",
        sessionId: 1510,
        jobId: 1510,
        officialUrl,
        atsType: null
      }
    }, window.location.origin), DESTINATION);
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { __xa15: { result: { ok?: boolean } | null } }).__xa15.result?.ok ?? null
    )).toBe(true);
    expect(await page.evaluate(() =>
      (window as typeof window & { __xa15: { submissions: number } }).__xa15.submissions
    )).toBe(0);
  } finally {
    await context.close();
  }
});

test("XA-15: both approved production XpertApply origins retain the bridge", async () => {
  test.setTimeout(60_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${PRODUCTION_DIST}`, `--load-extension=${PRODUCTION_DIST}`],
    serviceWorkers: "allow"
  });
  try {
    for (const origin of ["https://xpertapply.com", "https://www.xpertapply.com"]) {
      await context.route(`${origin}/**`, (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: hostilePage()
      }));
      const page = await context.newPage();
      await page.goto(`${origin}/xa15-positive-control`);
      await page.waitForTimeout(500);
      await page.evaluate(({ officialUrl, origin }) => window.postMessage({
        source: "jobpilot-web",
        type: "JOBPILOT_START_ASSISTED_APPLY",
        payload: {
          requestId: `xa15-production-positive-${origin}`,
          launchToken: `synthetic-production-token-${origin}`,
          sessionId: 1520,
          jobId: 1520,
          officialUrl,
          atsType: null
        }
      }, window.location.origin), { officialUrl: DESTINATION, origin });
      await expect.poll(() => page.evaluate(() =>
        (window as typeof window & { __xa15: { result: { ok?: boolean } | null } }).__xa15.result?.ok ?? null
      )).toBe(true);
      expect(await page.evaluate(() =>
        (window as typeof window & { __xa15: { submissions: number } }).__xa15.submissions
      )).toBe(0);
      await page.close();
    }
  } finally {
    await context.close();
  }
});
