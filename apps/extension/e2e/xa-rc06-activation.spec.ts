import { expect, test, chromium, type BrowserContext, type Worker } from "@playwright/test";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { PROFILES, employerTls, stagingApiFront, startDirectApi } from "./xa-core1-harness";

/**
 * XA-RC-06 workstream A: direct application activation on a custom careers domain (careers.withwaymo.com).
 *
 * Real Chromium, the real staging build, local fixtures, an owned API. What automation CANNOT do, and is therefore a manual desktop check:
 * click the toolbar icon (activeTab), see Chrome's native "Allow XpertApply on this site" dialog, and accept or decline it.
 */
const WAYMO = "https://careers.withwaymo.com/jobs/ml-engineer/apply";
const WAYMO_PATTERN = "https://careers.withwaymo.com/*";

type Env = { ctx: BrowserContext; worker: Worker; front: Awaited<ReturnType<typeof stagingApiFront>>; calls: () => Promise<Array<{ api: string; arg: unknown }>>; close: () => Promise<void> };

async function launch(dist: "dist-staging" | "dist-staging-granted"): Promise<Env> {
  const api = await startDirectApi(); const front = await stagingApiFront(api);
  const tls = await employerTls([`MAP api-staging.xpertapply.com 127.0.0.1:${front.port}`]);
  const dir = path.resolve(dist);
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, ...tls.args] });
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
  // Record every request for host access, whichever API makes it, passing the call through.
  await worker.evaluate(() => {
    const g = globalThis as any; g.__perm = [];
    const perms = chrome.permissions as any;
    for (const name of ["request", "addHostAccessRequest"]) {
      const real = perms[name]?.bind(perms); if (!real) continue;
      perms[name] = (arg: unknown) => { g.__perm.push({ api: name, arg }); return real(arg); };
    }
  });
  return { ctx, worker, front, calls: () => worker.evaluate(() => (globalThis as any).__perm), close: async () => { await ctx.close().catch(() => undefined); tls.server.close(); front.close(); await api.close(); } };
}
const seed = (w: Worker, uid: number) => w.evaluate(async ([u, email]) => new Promise<void>((res, rej) => { const o = indexedDB.open("xpertapply-extension-auth", 1); o.onupgradeneeded = () => o.result.createObjectStore("kv"); o.onerror = () => rej(o.error); o.onsuccess = () => { const tx = o.result.transaction("kv", "readwrite"); tx.objectStore("kv").put({ v: 1, accessToken: `acc-${u}`, refreshToken: `ref-${u}`, expiresAt: Date.now() + 1_800_000, userId: u, email }, "xaExtensionAuthV1"); tx.oncomplete = () => { o.result.close(); res(); }; }; }), [uid, PROFILES[uid].email] as const);
/** The Waymo-shaped page shows its description first and renders the form when "Apply Now" is pressed, with no navigation. */
const openWaymo = async (p: import("@playwright/test").Page) => { await p.goto(WAYMO); await p.locator("#apply-now").click(); };
const overlays = (p: import("@playwright/test").Page) => p.locator("#xpertapply-assistant-overlay-v1").count();

test("R1: custom careers domain, access not granted: nothing is read, requested or sent passively, and Chrome reports the origin as not granted", async () => {
  test.setTimeout(150_000);
  const e = await launch("dist-staging");
  try {
    // Before: Chrome has not granted the origin, and getAll agrees.
    expect(await e.worker.evaluate((o) => chrome.permissions.contains({ origins: [o] }), WAYMO_PATTERN)).toBe(false);
    expect(((await e.worker.evaluate(() => chrome.permissions.getAll())).origins ?? []).some((o) => /withwaymo/.test(o))).toBe(false);
    const p = await e.ctx.newPage();
    await p.goto(WAYMO);
    await p.waitForTimeout(3000);
    expect(await overlays(p)).toBe(0);                                             // no XpertApply code on a page nobody granted
    expect(await e.calls()).toEqual([]);                                           // no passive request for an unknown domain: the user's click asks
    expect(e.front.seen).toEqual([]);                                              // and nothing was sent to the API
    // The wording of Chrome's refusal when a request carries no user gesture. The worker classifies it by this text.
    const message = await e.worker.evaluate(async (o) => { try { await chrome.permissions.request({ origins: [o] }); return "resolved"; } catch (error) { return String((error as Error).message); } }, WAYMO_PATTERN);
    expect(message).toMatch(/user gesture/i);
    expect(await e.worker.evaluate((o) => chrome.permissions.contains({ origins: [o] }), WAYMO_PATTERN)).toBe(false);   // asking is not having
  } finally { await e.close(); }
});

test("R2: custom careers domain already authorized: one assistant, no permission prompt, across reload and SPA navigation and a second tab", async () => {
  test.setTimeout(240_000);
  const e = await launch("dist-staging-granted");
  try {
    expect(await e.worker.evaluate((o) => chrome.permissions.contains({ origins: [o] }), WAYMO_PATTERN)).toBe(true);
    await seed(e.worker, 7);
    const p = await e.ctx.newPage();
    await openWaymo(p);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    const ov = overlayCdp(p);
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 60_000 }).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) { await p.reload(); await p.locator("#apply-now").click(); await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 }); }
    await p.evaluate(() => history.pushState({}, "", "/jobs/ml-engineer/apply?step=2"));
    await p.waitForTimeout(2500);
    expect(await overlays(p)).toBe(1);
    expect(await e.calls()).toEqual([]);                                           // an authorized origin is never asked again
    expect(await p.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
    const q = await e.ctx.newPage();
    await openWaymo(q);
    await expect(q.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    expect(await e.calls()).toEqual([]);
  } finally { await e.close(); }
});

test("R3: the per-site 'don't open automatically' choice is honoured on a custom careers domain and survives a reload", async () => {
  test.setTimeout(240_000);
  const e = await launch("dist-staging-granted");
  try {
    await seed(e.worker, 7);
    const p = await e.ctx.newPage();
    await openWaymo(p);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    const ov = overlayCdp(p);
    await ov.clickSynthetic("#disableSite");
    await expect.poll(async () => (await ov.text("#disableSite")) ?? "", { timeout: 15_000 }).toMatch(/won.t open here by itself/i);
    const drafts = e.front.seen.filter((s) => /direct-sessions/.test(s)).length;
    await p.reload();
    await p.locator("#apply-now").click();
    await p.waitForTimeout(6000);
    expect(await overlays(p)).toBe(0);
    expect(e.front.seen.filter((s) => /direct-sessions/.test(s)).length).toBe(drafts);   // no new draft either
  } finally { await e.close(); }
});
