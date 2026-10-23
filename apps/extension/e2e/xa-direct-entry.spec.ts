import { expect, test, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { LEVER_UUID, PROFILES, UNGRANTED_HOST, employerTls, overlayCount, stagingApiFront, startDirectApi, submitsUntouched } from "./xa-core1-harness";

/**
 * XA-EXT-DIRECT-ENTRY-02. The STAGING extension, in a real Chromium, on supported applications opened directly.
 *
 * Two real builds are loaded:
 *   dist-staging          exactly what a user installs: NO employer site is granted (Chrome grants nothing at install).
 *   dist-staging-granted  the same build with the fixture ATS origins pre-granted, i.e. the state after the user allows a site.
 * Chrome's native grant dialog and sign-in window cannot be automated; they are not exercised here (see the report).
 */
const STAGING_ID = "cglmdonbfbadfbggkpajpkjgpekhkall";
const dist = (name: string) => path.resolve(name);
const GH = "https://job-boards.greenhouse.io/acme/jobs/4012345";
const LEVER = `https://jobs.lever.co/zoox/${LEVER_UUID}/apply`;
const ASHBY = `https://jobs.ashbyhq.com/acme/${LEVER_UUID}/application`;
const WAYMO = "https://careers.withwaymo.com/jobs/machine-learning-engineer";
const PRODUCTION_HOSTS = /(^|\.)xpertapply\.com$/;

async function env(build: "dist-staging" | "dist-staging-granted", opts: { api?: boolean } = {}) {
  const api = opts.api ? await startDirectApi() : null;
  const front = api ? await stagingApiFront(api) : null;
  const tls = await employerTls(front ? [`MAP api-staging.xpertapply.com 127.0.0.1:${front.port}`] : []);
  const ctx: BrowserContext = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist(build)}`, `--load-extension=${dist(build)}`, ...tls.args] });
  const worker: Worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const urls: string[] = [];
  ctx.on("request", r => urls.push(r.url()));
  // Record Chrome's own "wants access to this site" requests and every fetch the worker makes. Both are observation only.
  const instrument = () => worker.evaluate(() => {
    const g = globalThis as any;
    if (g.__xaObserved) return;
    g.__xaObserved = true; g.__access = []; g.__fetches = [];
    (chrome.permissions as any).addHostAccessRequest = async (request: { tabId: number; pattern?: string }) => { g.__access.push({ tabId: request.tabId, pattern: request.pattern }); };
    const real = g.fetch.bind(g);
    g.fetch = (input: any, init?: any) => { g.__fetches.push(String(typeof input === "string" ? input : input?.url)); return real(input, init); };
  });
  await instrument();
  const stubAuth = () => worker.evaluate(() => {
    const g = globalThis as any; g.__auth = null;
    chrome.identity.launchWebAuthFlow = ((details: { url: string }) => new Promise((_resolve, reject) => { g.__auth = { url: details.url, reject }; })) as typeof chrome.identity.launchWebAuthFlow;
  });
  return {
    ctx, worker, urls, api, front, stubAuth, instrument,
    access: () => worker.evaluate(() => (globalThis as any).__access as { tabId: number; pattern: string }[]),
    fetches: () => worker.evaluate(() => (globalThis as any).__fetches as string[]),
    badge: (tabUrlPrefix: string) => worker.evaluate(async prefix => {
      const tab = (await chrome.tabs.query({})).find(t => (t.url ?? "").startsWith(prefix));
      return tab?.id == null ? null : chrome.action.getBadgeText({ tabId: tab.id });
    }, tabUrlPrefix),
    granted: (pattern: string) => worker.evaluate(p => chrome.permissions.contains({ origins: [p] }), pattern),
    async close() { await ctx.close().catch(() => undefined); tls.server.close(); front?.close(); await api?.close(); }
  };
}
const fields = (p: Page) => p.evaluate(() => [...document.querySelectorAll("input,textarea,select")].map((e: any) => (e.type === "file" ? "" : e.value)).join("|"));

// ------------------------------------------------------------------------------------------------------------------
// A. What a first-time user has: the staging build, nothing granted.
// ------------------------------------------------------------------------------------------------------------------
test("A1. staging build, no site access: a supported application opened directly asks Chrome for exactly that origin and shows a badge; nothing is read, sent or filled", async () => {
  test.setTimeout(150_000);
  const e = await env("dist-staging");
  try {
    for (const [name, url, origin] of [["Greenhouse", GH, "job-boards.greenhouse.io"], ["Lever", LEVER, "jobs.lever.co"], ["Ashby", ASHBY, "jobs.ashbyhq.com"]] as const) {
      const p = await e.ctx.newPage();
      await p.goto(url);
      await expect.poll(async () => (await e.access()).filter(r => r.pattern === `https://${origin}/*`).length, { message: `${name} access request`, timeout: 20_000 }).toBe(1);
      expect(await e.badge(`https://${origin}/`), `${name} badge`).not.toBe("");
      expect(await e.granted(`https://${origin}/*`)).toBe(false);          // asking is not having
      expect(await overlayCount(p)).toBe(0);                               // no script is on the page, so no assistant
      expect(await fields(p)).not.toMatch(/Riley|@/);                      // nothing modified
    }
    const requests = await e.access();
    expect(requests.every(r => /^https:\/\/[a-z.-]+\/\*$/.test(r.pattern) && !r.pattern.includes("*."))).toBe(true);   // exact origin, never a domain wildcard
    expect((await e.fetches()).filter(u => !u.startsWith("chrome-extension://"))).toEqual([]);                        // no account/draft/API traffic before authorization
  } finally { await e.close(); }
});

test("A2. no request for anything that is not a supported application page", async () => {
  test.setTimeout(120_000);
  const e = await env("dist-staging");
  try {
    for (const url of ["https://job-boards.greenhouse.io/acme", `https://jobs.lever.co/zoox/${LEVER_UUID}`, `https://${UNGRANTED_HOST}/jobs/machine-learning-engineer`, "https://jobs.ashbyhq.com/acme"]) {
      const p = await e.ctx.newPage();
      await p.goto(url);
      await p.waitForTimeout(2500);
      await p.close();
    }
    expect(await e.access()).toEqual([]);
    expect(await e.badge("https://job-boards.greenhouse.io/")).toBeFalsy();
  } finally { await e.close(); }
});

test("A3. reloads do not repeat the request; SPA navigation into an application does ask, once", async () => {
  test.setTimeout(150_000);
  const e = await env("dist-staging");
  try {
    const p = await e.ctx.newPage();
    await p.goto(GH);
    await expect.poll(async () => (await e.access()).length, { timeout: 20_000 }).toBe(1);
    for (let i = 0; i < 3; i++) { await p.reload(); await p.waitForTimeout(1500); }
    expect((await e.access()).length).toBe(1);

    const q = await e.ctx.newPage();
    await q.goto("https://jobs.ashbyhq.com/acme");                           // a listing: nothing
    await q.waitForTimeout(2000);
    expect((await e.access()).length).toBe(1);
    await q.evaluate(id => history.pushState({}, "", `/acme/${id}/application`), LEVER_UUID);   // same document, new route
    await expect.poll(async () => (await e.access()).filter(r => r.pattern === "https://jobs.ashbyhq.com/*").length, { timeout: 20_000 }).toBe(1);
    await q.evaluate(id => history.pushState({}, "", `/acme/${id}/application?step=2`), LEVER_UUID);
    await q.waitForTimeout(2000);
    expect((await e.access()).filter(r => r.pattern === "https://jobs.ashbyhq.com/*").length).toBe(1);
  } finally { await e.close(); }
});

test("A4. the staging build holds host access to the staging website and API only, and no production host is ever contacted", async () => {
  test.setTimeout(120_000);
  const e = await env("dist-staging");
  try {
    const manifest = await e.worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.name).toBe("XpertApply (STAGING)");
    expect(manifest.host_permissions).toEqual(["https://api-staging.xpertapply.com/*", "https://staging.xpertapply.com/*"]);
    expect(await e.worker.evaluate(() => chrome.runtime.id)).toBe(STAGING_ID);
    const p = await e.ctx.newPage();
    await p.goto(GH);
    await p.waitForTimeout(3000);
    const hosts = [...e.urls.map(u => new URL(u).hostname), ...(await e.fetches()).map(u => { try { return new URL(u).hostname; } catch { return ""; } })];
    expect(hosts.filter(h => PRODUCTION_HOSTS.test(h) && h !== "staging.xpertapply.com" && h !== "api-staging.xpertapply.com")).toEqual([]);
  } finally { await e.close(); }
});

// ------------------------------------------------------------------------------------------------------------------
// B. After the user allows the site (the same staging build with the fixture origins granted).
// ------------------------------------------------------------------------------------------------------------------
test("B1. granted, extension disconnected: the one assistant shows Connect XpertApply on Greenhouse, Lever, Ashby and a custom careers domain; nothing is fetched or filled", async () => {
  test.setTimeout(240_000);
  const e = await env("dist-staging-granted");
  try {
    for (const url of [GH, LEVER, ASHBY, WAYMO]) {
      const p = await e.ctx.newPage();
      await p.goto(url);
      if (url === WAYMO) await p.click("#apply-now");
      await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
      const ov = overlayCdp(p);
      await expect.poll(async () => (await ov.text("#errors")) ?? "", { message: url, timeout: 30_000 }).toMatch(/Connect XpertApply/);
      expect(await fields(p)).not.toMatch(/Riley|@/);
      for (let i = 0; i < 2; i++) {
        await p.reload(); if (url === WAYMO) await p.click("#apply-now");
        await expect(p.locator("#xpertapply-assistant-overlay-v1"), `${url} after reload ${i + 1}`).toHaveCount(1, { timeout: 40_000 });
      }
      await p.waitForTimeout(2500);
      expect(await overlayCount(p)).toBe(1);                                // reloads never stack assistants
    }
    expect((await e.fetches()).filter(u => !u.startsWith("chrome-extension://"))).toEqual([]);   // no account or draft request before authorization
    expect(await e.worker.evaluate(() => chrome.runtime.getManifest().host_permissions)).not.toContain("https://api.xpertapply.com/*");
  } finally { await e.close(); }
});

test("B2. Connect XpertApply invokes the native Chrome sign-in with the staging website and the staging extension's redirect", async () => {
  test.setTimeout(150_000);
  const e = await env("dist-staging-granted");
  try {
    await e.stubAuth();
    const p = await e.ctx.newPage();
    await p.goto(GH);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    const ov = overlayCdp(p);
    await expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/Connect XpertApply/);
    await ov.click("#fill");
    await expect.poll(() => e.worker.evaluate(() => (globalThis as any).__auth?.url ?? null), { timeout: 30_000 }).not.toBeNull();
    const url = new URL(await e.worker.evaluate(() => (globalThis as any).__auth.url as string));
    expect(url.origin + url.pathname).toBe("https://staging.xpertapply.com/extension/connect");
    expect(url.searchParams.get("redirect_uri")).toBe(`https://${STAGING_ID}.chromiumapp.org/xpertapply`);
    expect(url.search).not.toMatch(/token|verifier|refresh/i);
    await e.worker.evaluate(() => { const a = (globalThis as any).__auth; a.reject(new Error("The user did not approve access.")); });
    await expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 20_000 }).toMatch(/cancelled/i);
    expect(await fields(p)).not.toMatch(/Riley|@/);
  } finally { await e.close(); }
});

test("B3. granted and already signed in: the staging build fills from the STAGING API only, and the service worker can be restarted", async () => {
  test.setTimeout(240_000);
  const e = await env("dist-staging-granted", { api: true });
  try {
    // Seed a signed-in extension exactly where the worker keeps its credential.
    await e.worker.evaluate(async ([uid, email]) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("xpertapply-extension-auth", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("kv");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => { const tx = open.result.transaction("kv", "readwrite"); tx.objectStore("kv").put({ v: 1, accessToken: `acc-${uid}`, refreshToken: `ref-${uid}`, expiresAt: Date.now() + 1_800_000, userId: uid, email }, "xaExtensionAuthV1"); tx.oncomplete = () => { open.result.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
      });
    }, [7, PROFILES[7].email] as const);
    const p = await e.ctx.newPage();
    await p.goto(GH);
    await expect.poll(() => p.inputValue("#first_name"), { timeout: 60_000 }).toBe("Riley");
    expect(await submitsUntouched(p)).toEqual({ submits: 0, clicks: 0 });
    expect(e.front!.seen.some(s => s.startsWith("POST /extension/direct-sessions"))).toBe(true);   // the draft was created on the staging host
    expect((await e.fetches()).every(u => !PRODUCTION_HOSTS.test(new URL(u).hostname) || new URL(u).hostname === "api-staging.xpertapply.com")).toBe(true);

    // Restart the service worker (as Chrome does when idle) and reload: the assistant comes back, once.
    const cdp = await e.ctx.newCDPSession(p);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await p.reload();
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(() => p.inputValue("#first_name"), { timeout: 60_000 }).toBe("Riley");
    await p.waitForTimeout(2000);
    expect(await overlayCount(p)).toBe(1);
  } finally { await e.close(); }
});

test("B4. granted: a site that was not granted, and a page that is not an application, stay silent", async () => {
  test.setTimeout(120_000);
  const e = await env("dist-staging-granted");
  try {
    for (const url of [`https://${UNGRANTED_HOST}/jobs/machine-learning-engineer`, "https://job-boards.greenhouse.io/acme", "https://careers.withwaymo.com/newsletter"]) {
      const p = await e.ctx.newPage();
      await p.goto(url);
      await p.waitForTimeout(3500);
      expect(await overlayCount(p), url).toBe(0);
      await p.close();
    }
  } finally { await e.close(); }
});
