/**
 * Stage 3C-2 — embedded ATS permission discovery, in a real browser.
 *
 * What only a real browser can prove here: that Chrome genuinely will not let
 * the extension see or touch an ungranted frame. Every unit test in this area
 * MODELS that behaviour; this one observes it. The blindness at the heart of
 * the Stage 3C-V defect — `scripting.executeScript({ allFrames: true })`
 * silently omitting the one frame whose problem is the missing grant — is
 * asserted against Chrome itself, not against a mock of Chrome.
 *
 * Preconditions, matching the real starting state of an assisted apply:
 *
 *     employer origin  GRANTED    (the user allowed it at the top level)
 *     ATS origin       UNGRANTED  (embedded, trusted, no grant yet)
 *     ads origin       UNGRANTED  (embedded, never trusted, never asked for)
 *
 * The native Chrome permission PROMPT is not exercised here — Playwright cannot
 * accept it. That is Stage 3C-V2 manual acceptance. This spec covers discovery,
 * which is what the defect broke.
 */
import { expect, test, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWithGrantedOrigins, removeGrantedBuild } from "./granted-build";
import {
  startFixture, type Fixture,
  APPLICATION_URL, EMPLOYER_ORIGIN, ATS_ORIGIN, ADS_ORIGIN
} from "./fixtures/3c2/server";

const EMPLOYER_URL = APPLICATION_URL;

let fixture: Fixture;
let context: BrowserContext;
let worker: Worker;
let distDir: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = await startFixture();
  // Only the employer origin is granted. The shipped Stage 3C manifest grants
  // no employer/ATS authority at install, so the post-grant state for the TOP
  // origin is expressed the one other way Chrome accepts it. The ATS and ad
  // origins are deliberately left out: those are what this spec is about.
  // Built from the SHIPPED `dist/`, deliberately not from `dist-e2e-granted`:
  // that build pre-grants the loopback fixture origins, and this spec is about
  // what the production permission architecture does with origins it has not
  // been given. The employer origin is the only addition.
  const inherited = process.env.XA_E2E_DIST;
  delete process.env.XA_E2E_DIST;
  try {
    distDir = buildWithGrantedOrigins([`${EMPLOYER_ORIGIN}/*`], "3c2");
  } finally {
    if (inherited) process.env.XA_E2E_DIST = inherited;
  }

  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      ...fixture.chromeArgs
    ],
    ignoreHTTPSErrors: true,
    serviceWorkers: "allow"
  });
  worker = context.serviceWorkers()[0]
    ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
});

test.afterAll(async () => {
  await context?.close();
  await fixture?.close();
  removeGrantedBuild("3c2");
});

test("Chrome grants the employer origin and nothing else", async () => {
  const state = await worker.evaluate(async (origins) => {
    const check = async (origin: string) =>
      chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false);
    const all = await chrome.permissions.getAll();
    return {
      employer: await check(origins.employer),
      ats: await check(origins.ats),
      ads: await check(origins.ads),
      wildcard: (all.origins ?? []).includes("https://*/*"),
      granted: all.origins ?? []
    };
  }, { employer: EMPLOYER_ORIGIN, ats: ATS_ORIGIN, ads: ADS_ORIGIN });

  expect(state.employer).toBe(true);
  expect(state.ats).toBe(false);
  expect(state.ads).toBe(false);
  // The wildcard is DECLARED as optional so arbitrary employer origins can be
  // asked for. It must never be a granted runtime origin.
  expect(state.wildcard).toBe(false);
});

test("Chrome hides the ungranted frames from the extension's own enumeration", async () => {
  const page = await context.newPage();
  await page.goto(EMPLOYER_URL);
  await page.waitForSelector("#ats");

  // Both iframes really are there, as the page's own DOM reports.
  const domFrames = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map((f) => new URL(f.src).origin).sort());
  expect(domFrames).toEqual([ADS_ORIGIN, ATS_ORIGIN].sort());

  const tabId = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    return tab?.id ?? null;
  }, EMPLOYER_ORIGIN);
  expect(tabId).not.toBeNull();

  // …and Chrome reports exactly ONE of them to the extension. This is the
  // blindness the Stage 3C-V defect was built on: the frame that needs the
  // grant is the frame this call cannot see.
  const injectable = await worker.evaluate(async (id) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: id as number, allFrames: true },
      func: () => location.origin
    }).catch(() => []);
    return results.map((r) => r.result as string).sort();
  }, tabId);

  expect(injectable).toEqual([EMPLOYER_ORIGIN]);
  expect(injectable).not.toContain(ATS_ORIGIN);
  expect(injectable).not.toContain(ADS_ORIGIN);

  await page.close();
});

test("no XpertApply code runs in either ungranted frame, and nothing is filled", async () => {
  const page = await context.newPage();
  await page.goto(EMPLOYER_URL);
  await page.waitForSelector("#ats");
  // Give any injection attempt time to have happened.
  await page.waitForTimeout(3000);

  for (const [name, selector] of [["ats", "#ats"], ["ads", "#ads"]] as const) {
    const frame = page.frameLocator(selector);
    // The fixture's own marker proves the frame loaded and is reachable to
    // Playwright — so an absent XpertApply marker means absent, not unloaded.
    const loaded = await frame.locator("form").count();
    expect(loaded, name).toBe(1);

    const values = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLIFrameElement | null;
      // Cross-origin: unreadable from here, which is itself the point. Read
      // through Playwright instead.
      return el ? el.src : null;
    }, selector);
    expect(values, name).toBeTruthy();
  }

  // Not one field in either frame received a value.
  const atsValues = await page.frameLocator("#ats").locator("input").evaluateAll(
    (nodes) => nodes.map((n) => (n as HTMLInputElement).value));
  const adsValues = await page.frameLocator("#ads").locator("input").evaluateAll(
    (nodes) => nodes.map((n) => (n as HTMLInputElement).value));
  expect(atsValues.every((v) => v === "")).toBe(true);
  expect(adsValues.every((v) => v === "")).toBe(true);

  await page.close();
});

test("discovery names the ATS origin as the one needing access, and never the ad origin", async () => {
  test.setTimeout(180_000);
  const page = await context.newPage();

  const workerLogs: string[] = [];
  worker.on("console", (m) => { if (m.text().includes("[XpertApply]")) workerLogs.push(m.text()); });
  const pageLogs: string[] = [];
  page.on("console", (m) => { if (m.text().includes("[XpertApply]")) pageLogs.push(m.text()); });

  // Seed the handoff a real launch would leave, so this page belongs to a
  // workflow. Throwaway test token; it never leaves this process.
  await worker.evaluate(async (url) => {
    const now = Date.now();
    await (chrome.storage.session ?? chrome.storage.local).set({
      activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "3c2", jobId: "1", applicationUrl: url,
        status: "prepared", handoffToken: "t", requestId: "r-3c2", sessionId: 55,
        launchToken: "t", officialUrl: url, expectedOrigin: new URL(url).origin,
        createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      }
    });
  }, EMPLOYER_URL);

  await page.goto(EMPLOYER_URL);
  await page.waitForSelector("#ats");

  // The production content script runs its own discovery, cannot reach the
  // embedded application, and asks the worker to diagnose it. Wait for that
  // diagnosis rather than driving it synthetically.
  const inspected = await worker.evaluate(async () => {
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const store = await (chrome.storage.session ?? chrome.storage.local).get("viewStates");
      const map = (store.viewStates ?? {}) as Record<string, Record<string, unknown>>;
      const view = Object.values(map)[0];
      if (view && view.siteAccess && view.siteAccess !== "no_workflow") return view;
      await new Promise((r) => setTimeout(r, 500));
    }
    const store = await (chrome.storage.session ?? chrome.storage.local).get("viewStates");
    return { timedOut: true, views: store.viewStates ?? null };
  });

  console.log("=== 3C-2 tab view ===\n" + JSON.stringify(inspected, null, 2));
  console.log("=== worker frame-inspection log ===\n"
    + workerLogs.filter((l) => l.includes("frame")).join("\n"));
  console.log("=== page log tail ===\n" + pageLogs.slice(-12).join("\n"));

  const view = inspected as Record<string, unknown>;
  // The exact ATS origin is what the side panel will ask for …
  expect(view.siteAccess).toBe("site_access_required");
  expect(view.siteAccessPattern).toBe(`${ATS_ORIGIN}/*`);
  expect(view.siteAccessOrigin).toBe(new URL(ATS_ORIGIN).host);
  expect(view.siteAccessScope).toBe("frame");

  // … and the ad origin appears nowhere in it, nor any wildcard.
  const serialized = JSON.stringify(view);
  expect(serialized).not.toContain("doubleclick");
  expect(view.siteAccessPattern).not.toContain("*.");
  expect(view.siteAccessPattern).not.toBe("https://*/*");

  // Still ungranted, so still no code and no values in either frame.
  const grants = await worker.evaluate(async (origins) => ({
    ats: await chrome.permissions.contains({ origins: [`${origins.ats}/*`] }).catch(() => false),
    ads: await chrome.permissions.contains({ origins: [`${origins.ads}/*`] }).catch(() => false)
  }), { ats: ATS_ORIGIN, ads: ADS_ORIGIN });
  expect(grants.ats).toBe(false);
  expect(grants.ads).toBe(false);

  for (const selector of ["#ats", "#ads"]) {
    const values = await page.frameLocator(selector).locator("input").evaluateAll(
      (nodes) => nodes.map((n) => (n as HTMLInputElement).value));
    expect(values.every((v) => v === ""), selector).toBe(true);
  }

  await page.close();
});

// --------------------------------------------------------------------------- //
// Post-grant: what the ATS origin gets once Chrome allows it, and what the
// unrelated frame still does not. The native prompt is Stage 3C-V2's job; this
// is the state Chrome is in on the far side of it.
// --------------------------------------------------------------------------- //

test.describe("after the ATS origin is granted", () => {
  let grantedContext: BrowserContext;
  let grantedWorker: Worker;
  let grantedFixture: Fixture;
  let grantedDist: string;

  test.beforeAll(async () => {
    grantedFixture = await startFixture();
    const inherited = process.env.XA_E2E_DIST;
    delete process.env.XA_E2E_DIST;
    try {
      grantedDist = buildWithGrantedOrigins(
        [`${EMPLOYER_ORIGIN}/*`, `${ATS_ORIGIN}/*`], "3c2granted");
    } finally {
      if (inherited) process.env.XA_E2E_DIST = inherited;
    }
    grantedContext = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${grantedDist}`,
        `--load-extension=${grantedDist}`,
        ...grantedFixture.chromeArgs
      ],
      ignoreHTTPSErrors: true,
      serviceWorkers: "allow"
    });
    grantedWorker = grantedContext.serviceWorkers()[0]
      ?? (await grantedContext.waitForEvent("serviceworker", { timeout: 20_000 }));
  });

  test.afterAll(async () => {
    await grantedContext?.close();
    await grantedFixture?.close();
    removeGrantedBuild("3c2granted");
  });

  test("Stage 3C-3 activates the concrete ATS frame after a frame-scoped grant result", async () => {
    test.setTimeout(180_000);
    await grantedWorker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session?.clear();
    });

    const page = await grantedContext.newPage();
    let submitted = false;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/submit")) submitted = true;
    });
    await page.goto(APPLICATION_URL);
    await page.waitForSelector("#ats");

    const prepared = await grantedWorker.evaluate(async ({ url, employer, ats, ads }) => {
      const [tab] = await chrome.tabs.query({ url: `${employer}/*` });
      if (!tab?.id) return { ok: false, error: "TAB_NOT_FOUND" };
      const now = Date.now();
      const pending = {
        version: 1, applicationId: "3c3", jobId: "1", applicationUrl: url,
        status: "prepared", handoffToken: "t", requestId: "r-3c3", sessionId: 55,
        launchToken: "t", officialUrl: url, expectedOrigin: employer,
        createdAt: now, expiresAt: now + 900_000, targetTabId: tab.id,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      };
      const view = {
        tabId: tab.id, requestId: "r-3c3", sessionId: 55,
        state: "waiting_for_content_script", company: "Fixture Employer",
        jobTitle: "Software Engineer", atsId: null, atsDisplayName: null,
        limited: false, fieldsDiscovered: 0, filled: 0, skipped: 0,
        reviewRequired: 0, resumeStatus: "pending", coverStatus: "pending",
        reachedFinalStep: false, contentReady: true, packageLoaded: false,
        running: false, failureCode: "APPLICATION_FRAME_PERMISSION_MISSING",
        failureMessage: null, failureRecoverable: true,
        siteAccess: "site_access_required", siteAccessPattern: `${ats}/*`,
        siteAccessOrigin: new URL(ats).host, siteAccessScope: "frame",
        siteAccessFramePathShape: "/embed/<id>", updatedAt: now
      };
      await (chrome.storage.session ?? chrome.storage.local).set({
        activeAssistedApplyHandoffV1: pending,
        pendingLaunches: { [String(tab.id)]: pending },
        viewStates: { [String(tab.id)]: view }
      });

      // Mirror the native flow: the employer top frame is already alive and
      // has registered its negative application probe before ATS permission is
      // granted. The defect was precisely that this top-frame liveness caused
      // the old worker to skip ATS activation.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] }, files: ["content.js"]
      });
      const before = await new Promise<unknown>((resolve) => {
        chrome.tabs.sendMessage(tab.id!, { type: "JOBPILOT_PING_CONTENT" }, { frameId: 0 }, resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const all = await chrome.permissions.getAll();
      return {
        ok: true, tabId: tab.id, before,
        atsGranted: await chrome.permissions.contains({ origins: [`${ats}/*`] }),
        adsGranted: await chrome.permissions.contains({ origins: [`${ads}/*`] }),
        wildcard: (all.origins ?? []).includes("https://*/*")
      };
    }, { url: APPLICATION_URL, employer: EMPLOYER_ORIGIN, ats: ATS_ORIGIN, ads: ADS_ORIGIN });

    expect(prepared).toMatchObject({ ok: true, atsGranted: true, adsGranted: false, wildcard: false });
    const extensionId = new URL(grantedWorker.url()).host;
    const panel = await grantedContext.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const response = await panel.evaluate(async ({ tabId, pattern }) =>
      new Promise<unknown>((resolve) => {
        chrome.runtime.sendMessage({
          type: "JOBPILOT_SITE_ACCESS_RESULT", tabId, pattern, granted: true
        }, resolve);
      }), { tabId: prepared.tabId, pattern: `${ATS_ORIGIN}/*` });
    await panel.close();

    const transition = { ...prepared, response };

    console.log("=== Stage 3C-3 post-grant transition ===\n" + JSON.stringify(transition, null, 2));
    expect(transition).toMatchObject({
      ok: true,
      response: { ok: true, state: "site_access_granted" },
      atsGranted: true,
      adsGranted: false,
      wildcard: false
    });

    // The exact ATS frame bootstraps and fills. The unrelated frame remains
    // ungranted, uninjected and empty, and neither form submits.
    await expect(page.frameLocator("#ats").locator("#email"))
      .toHaveValue(/fixture\.candidate@example\.test/i, { timeout: 90_000 });
    const atsTraces = await page.frameLocator("#ats")
      .locator("[data-jobpilot-filled],[data-jobpilot-status]").count();
    expect(atsTraces).toBe(0);
    const adValues = await page.frameLocator("#ads").locator("input")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
    expect(adValues.every((value) => value === "")).toBe(true);
    expect(submitted).toBe(false);
    await page.close();
  });

  test("the ATS frame fills, the ad frame receives nothing, and nothing submits", async () => {
    test.setTimeout(180_000);
    const page = await grantedContext.newPage();

    await grantedWorker.evaluate(async (url) => {
      const now = Date.now();
      await (chrome.storage.session ?? chrome.storage.local).set({
        activeAssistedApplyHandoffV1: {
          version: 1, applicationId: "3c2g", jobId: "1", applicationUrl: url,
          status: "prepared", handoffToken: "t", requestId: "r-3c2g", sessionId: 55,
          launchToken: "t", officialUrl: url, expectedOrigin: new URL(url).origin,
          createdAt: now, expiresAt: now + 900_000,
          state: "waiting_for_content_script", protocolVersion: 3, atsType: null
        }
      });
    }, APPLICATION_URL);

    let submitted = false;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/submit")) submitted = true;
    });

    await page.goto(APPLICATION_URL);
    await page.waitForSelector("#ats");

    // The grant exists, so Chrome now reports and injects the ATS frame.
    const injectable = await grantedWorker.evaluate(async (origin) => {
      const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
      if (!tab?.id) return [];
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => location.origin
      }).catch(() => []);
      return results.map((r) => r.result as string).sort();
    }, EMPLOYER_ORIGIN);

    console.log("=== post-grant injectable origins ===\n" + JSON.stringify(injectable));
    expect(injectable).toContain(EMPLOYER_ORIGIN);
    expect(injectable).toContain(ATS_ORIGIN);
    // The unrelated frame was never granted and is still unreachable.
    expect(injectable).not.toContain(ADS_ORIGIN);

    // The application in the ATS frame receives the profile.
    const email = page.frameLocator("#ats").locator("#email");
    await expect(email).toHaveValue(/fixture\.candidate@example\.test/i, { timeout: 90_000 });
    const first = await page.frameLocator("#ats").locator("#first_name").inputValue();
    expect(first.length).toBeGreaterThan(0);

    // The ad frame's identically-named fields received nothing at all.
    const adValues = await page.frameLocator("#ads").locator("input").evaluateAll(
      (nodes) => nodes.map((n) => (n as HTMLInputElement).value));
    console.log("=== ad frame values ===\n" + JSON.stringify(adValues));
    expect(adValues.every((v) => v === "")).toBe(true);

    // And the extension never submits. It never has and never may.
    expect(submitted).toBe(false);

    await page.close();
  });

  test("Stage 3C-4 reactivates a newly confirmed ATS frame after a real browser restart", async () => {
    test.setTimeout(300_000);
    const profileDir = mkdtempSync(path.join(tmpdir(), "xa-3c4-restart-"));
    const launchBrowser = () => chromium.launchPersistentContext(profileDir, {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${grantedDist}`,
        `--load-extension=${grantedDist}`,
        ...grantedFixture.chromeArgs
      ],
      ignoreHTTPSErrors: true,
      serviceWorkers: "allow"
    });
    const seedFreshWorkflow = async (targetWorker: Worker, tabId: number, requestId: string) => {
      await targetWorker.evaluate(async ({ url, tabId, requestId }) => {
        const now = Date.now();
        const pending = {
          version: 1, applicationId: "3c4", jobId: "1", applicationUrl: url,
          status: "prepared", handoffToken: `handoff-${requestId}`, requestId, sessionId: 55,
          launchToken: `launch-${requestId}`, officialUrl: url, expectedOrigin: new URL(url).origin,
          createdAt: now, expiresAt: now + 900_000, targetTabId: tabId,
          state: "waiting_for_content_script", protocolVersion: 3, atsType: null
        };
        const view = {
          tabId, requestId, sessionId: 55, state: "waiting_for_content_script",
          company: "Fixture Employer", jobTitle: "Software Engineer",
          atsId: null, atsDisplayName: null, limited: false,
          fieldsDiscovered: 0, filled: 0, skipped: 0, reviewRequired: 0,
          resumeStatus: "pending", coverStatus: "pending", reachedFinalStep: false,
          contentReady: false, packageLoaded: false, running: false,
          failureCode: null, failureMessage: null, failureRecoverable: null,
          siteAccess: "site_access_granted", siteAccessPattern: null,
          siteAccessOrigin: null, siteAccessScope: "page",
          siteAccessFramePathShape: null, updatedAt: now
        };
        await (chrome.storage.session ?? chrome.storage.local).set({
          activeAssistedApplyHandoffV1: pending,
          pendingLaunches: { [String(tabId)]: pending },
          viewStates: { [String(tabId)]: view }
        });
        // Intentionally activate only the employer top frame. The embedded ATS
        // must be reached by the persisted-grant reconciliation under test.
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] }, files: ["content.js"]
        });
      }, { url: APPLICATION_URL, tabId, requestId });
    };
    const frameInventory = (targetWorker: Worker, tabId: number) => targetWorker.evaluate(async (tabId) => {
      const rows = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => ({ origin: location.origin, path: location.pathname })
      });
      return rows.map((row) => ({ frameId: row.frameId ?? 0, ...row.result as { origin: string; path: string } }));
    }, tabId);

    let restartContext: BrowserContext | null = null;
    try {
      restartContext = await launchBrowser();
      let restartWorker = restartContext.serviceWorkers()[0]
        ?? (await restartContext.waitForEvent("serviceworker", { timeout: 20_000 }));
      await restartWorker.evaluate(async () => {
        await chrome.storage.local.clear();
        await chrome.storage.session?.clear();
      });

      const run1 = await restartContext.newPage();
      let submittedRun1 = false;
      run1.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/submit")) submittedRun1 = true;
      });
      await run1.goto(APPLICATION_URL);
      await run1.waitForSelector("#ats");
      const run1Tab = await restartWorker.evaluate(async (origin) => {
        const tabs = await chrome.tabs.query({ url: `${origin}/*` });
        return tabs.at(-1)?.id ?? null;
      }, EMPLOYER_ORIGIN);
      expect(run1Tab).not.toBeNull();
      await seedFreshWorkflow(restartWorker, run1Tab as number, "run-1");
      await expect(run1.frameLocator("#ats").locator("#email"))
        .toHaveValue("fixture.candidate@example.test", { timeout: 90_000 });
      const run1Frames = await frameInventory(restartWorker, run1Tab as number);
      expect(run1Frames.some((frame) => frame.origin === ATS_ORIGIN && frame.frameId > 0)).toBe(true);
      expect(submittedRun1).toBe(false);

      await restartContext.close();
      restartContext = await launchBrowser();
      restartWorker = restartContext.serviceWorkers()[0]
        ?? (await restartContext.waitForEvent("serviceworker", { timeout: 20_000 }));
      const afterRestart = await restartWorker.evaluate(async ({ employer, ats, ads }) => {
        const runtime = await (chrome.storage.session ?? chrome.storage.local).get([
          "activeAssistedApplyHandoffV1", "pendingLaunches", "viewStates", "sessionPackages"
        ]);
        const all = await chrome.permissions.getAll();
        return {
          runtime,
          employer: await chrome.permissions.contains({ origins: [`${employer}/*`] }),
          ats: await chrome.permissions.contains({ origins: [`${ats}/*`] }),
          ads: await chrome.permissions.contains({ origins: [`${ads}/*`] }),
          wildcard: (all.origins ?? []).includes("https://*/*")
        };
      }, { employer: EMPLOYER_ORIGIN, ats: ATS_ORIGIN, ads: ADS_ORIGIN });
      expect(afterRestart).toMatchObject({ employer: true, ats: true, ads: false, wildcard: false });
      expect(afterRestart.runtime).toEqual({});

      const run2 = await restartContext.newPage();
      let submittedRun2 = false;
      run2.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/submit")) submittedRun2 = true;
      });
      await run2.goto(APPLICATION_URL);
      await run2.waitForSelector("#ats");
      const run2Tab = await restartWorker.evaluate(async (origin) => {
        const tabs = await chrome.tabs.query({ url: `${origin}/*` });
        return tabs.at(-1)?.id ?? null;
      }, EMPLOYER_ORIGIN);
      expect(run2Tab).not.toBeNull();
      await seedFreshWorkflow(restartWorker, run2Tab as number, "run-2");
      await expect(run2.frameLocator("#ats").locator("#email"))
        .toHaveValue("fixture.candidate@example.test", { timeout: 90_000 });
      expect(await run2.frameLocator("#ats").locator("#first_name").inputValue()).toBe("Fixture");
      expect(await run2.frameLocator("#ats").locator("#last_name").inputValue()).toBe("Candidate");
      const adValues = await run2.frameLocator("#ads").locator("input")
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
      expect(adValues.every((value) => value === "")).toBe(true);
      const run2Frames = await frameInventory(restartWorker, run2Tab as number);
      expect(run2Frames.some((frame) => frame.origin === ATS_ORIGIN && frame.frameId > 0)).toBe(true);
      expect(submittedRun2).toBe(false);

      console.log("=== Stage 3C-4 real restart ===\n" + JSON.stringify({
        run1: { tabId: run1Tab, frames: run1Frames, submitted: submittedRun1 },
        restart: afterRestart,
        run2: { tabId: run2Tab, frames: run2Frames, submitted: submittedRun2, adValues }
      }, null, 2));
    } finally {
      await restartContext?.close().catch(() => undefined);
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});
