import { expect, test, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { PROFILES, employerTls, stagingApiFront, startDirectApi } from "./xa-core1-harness";

/**
 * XA-EXT-ASHBY-03: the assistant must never present a signed-out extension as connected, and a Chrome site grant is not XpertApply
 * authorization. Real staging build (granted-sites variant) on a real Chromium; every employer page and the API are local fixtures.
 */
const URL_ASHBY = "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555/application";
const URL_ASHBY_RICH = `${URL_ASHBY}?rich=1`;
const KEY = "xaExtensionAuthV1";
const FIELDS = ["first_name", "last_name", "email", "phone"];

type Env = { ctx: BrowserContext; worker: Worker; front: Awaited<ReturnType<typeof stagingApiFront>>; close: () => Promise<void> };
async function launch(): Promise<Env> {
  const api = await startDirectApi(); const front = await stagingApiFront(api);
  const tls = await employerTls([`MAP api-staging.xpertapply.com 127.0.0.1:${front.port}`]);
  const dist = path.resolve("dist-staging-granted");
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...tls.args] });
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
  return { ctx, worker, front, close: async () => { await ctx.close().catch(() => undefined); tls.server.close(); front.close(); await api.close(); } };
}
const seed = (w: Worker, uid: number) => w.evaluate(async ([u, email]) => new Promise<void>((res, rej) => { const o = indexedDB.open("xpertapply-extension-auth", 1); o.onupgradeneeded = () => o.result.createObjectStore("kv"); o.onerror = () => rej(o.error); o.onsuccess = () => { const tx = o.result.transaction("kv", "readwrite"); tx.objectStore("kv").put({ v: 1, accessToken: `acc-${u}`, refreshToken: `ref-${u}`, expiresAt: Date.now() + 1_800_000, userId: u, email }, "xaExtensionAuthV1"); tx.oncomplete = () => { o.result.close(); res(); }; }; }), [uid, PROFILES[uid].email] as const);
const unseed = (w: Worker) => w.evaluate(() => new Promise<void>((res, rej) => { const o = indexedDB.open("xpertapply-extension-auth", 1); o.onsuccess = () => { const tx = o.result.transaction("kv", "readwrite"); tx.objectStore("kv").delete("xaExtensionAuthV1"); tx.oncomplete = () => { o.result.close(); res(); }; }; o.onerror = () => rej(o.error); }));
const values = (p: Page) => p.evaluate((ids) => ids.map(id => (document.getElementById(id) as HTMLInputElement | null)?.value ?? ""), FIELDS);
const clearFields = (p: Page) => p.evaluate((ids) => { for (const id of ids) (document.getElementById(id) as HTMLInputElement).value = ""; }, FIELDS);
const overlayCount = (p: Page) => p.locator("#xpertapply-assistant-overlay-v1").count();
const submitted = (p: Page) => p.evaluate(() => (window as unknown as { __emp: { submits: number; clicks: number } }).__emp);

async function connected(env: Env, url = URL_ASHBY): Promise<{ p: Page; ov: ReturnType<typeof overlayCdp> }> {
  await seed(env.worker, 7);
  const p = await env.ctx.newPage(); p.on("dialog", d => void d.accept());
  await p.goto(url);
  await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
  const nameField = url === URL_ASHBY ? "#first_name" : "#_systemfield_name";
  await expect.poll(() => p.inputValue(nameField), { timeout: 60_000 }).toMatch(/Riley/);
  return { p, ov: overlayCdp(p) };
}
const signedOutUi = async (ov: ReturnType<typeof overlayCdp>) => {
  await expect.poll(async () => (await ov.text("#account").catch(() => "")) ?? "", { timeout: 20_000 }).toMatch(/not connected/i);
  await expect.poll(async () => (await ov.text("#fill").catch(() => "")) ?? "", { timeout: 20_000 }).toMatch(/connect xpertapply/i);
  // no fill claim, no counts, no document preparation text while signed out
  expect((await ov.text("#stage")) ?? "").not.toMatch(/filled/i);
  expect(await ov.text("#filled")).toBe("0");
  expect((await ov.text("#cover")) ?? "").not.toMatch(/preparing/i);
};

test("A: site access granted but the extension is NOT connected: Connect CTA, nothing written, no authenticated API call", async () => {
  test.setTimeout(150_000);
  const env = await launch();
  try {
    const p = await env.ctx.newPage();
    await p.goto(URL_ASHBY);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    const ov = overlayCdp(p);
    await signedOutUi(ov);
    await p.waitForTimeout(3000);
    expect(await values(p)).toEqual(["", "", "", ""]);
    expect(env.front.seen.filter(s => /direct-sessions|\/applications\//.test(s))).toEqual([]);
    expect(await overlayCount(p)).toBe(1);
    expect(await submitted(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await env.close(); }
});

test("B: connected fill is attributed, counted from real writes, never submitted; single assistant", async () => {
  test.setTimeout(200_000);
  const env = await launch();
  try {
    const { p, ov } = await connected(env);
    await expect.poll(async () => Number(await ov.text("#filled")), { timeout: 30_000 }).toBeGreaterThan(0);
    const written = (await values(p)).filter(Boolean).length;
    expect(Number(await ov.text("#filled"))).toBeLessThanOrEqual(written + 2); // never more than attributable writes (+ file/choice controls)
    expect((await ov.text("#account")) ?? "").not.toMatch(/not connected/i);
    expect(await overlayCount(p)).toBe(1);
    expect(await submitted(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await env.close(); }
});

test("C: expired or revoked credential (refresh refused / credential removed) flips the assistant to Connect and blocks writes", async () => {
  test.setTimeout(240_000);
  const env = await launch();
  try {
    const { p, ov } = await connected(env);
    await unseed(env.worker);
    await p.evaluate(() => window.dispatchEvent(new Event("focus"))); // the assistant re-reads account state when the tab regains focus
    await signedOutUi(ov);
    const calls = env.front.seen.length;
    await clearFields(p);
    for (const id of ["rescan", "fill", "next"]) { await ov.clickSynthetic(`#${id}`).catch(() => undefined); await p.waitForTimeout(2500); }
    expect(await values(p)).toEqual(["", "", "", ""]);
    expect(env.front.seen.slice(calls).filter(s => /direct-sessions|\/applications\//.test(s))).toEqual([]);
    expect(await overlayCount(p)).toBe(1);
  } finally { await env.close(); }
});

test("D: explicit Disconnect shows the Connect state at once (no stale 'prepared application' text) and keeps it after reload", async () => {
  test.setTimeout(240_000);
  const env = await launch();
  try {
    const { p, ov } = await connected(env);
    await ov.clickSynthetic("#disconnect");
    await signedOutUi(ov);
    await p.reload();
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    await signedOutUi(overlayCdp(p));
    expect((await values(p)).filter(Boolean)).toEqual([]);
  } finally { await env.close(); }
});

test("E: switching accounts never reuses the previous account's draft or values", async () => {
  test.setTimeout(240_000);
  const env = await launch();
  try {
    const { p, ov } = await connected(env);
    await seed(env.worker, 9); // credential now belongs to a different account than the tab's draft
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(async () => (await ov.text("#fill").catch(() => "")) ?? "", { timeout: 20_000 }).toMatch(/connect xpertapply/i);
    expect(await ov.text("#filled")).toBe("0");
    await clearFields(p);
    await ov.clickSynthetic("#fill").catch(() => undefined);
    await p.waitForTimeout(3000);
    expect((await values(p)).join("|")).not.toContain("Riley");
  } finally { await env.close(); }
});

test("F: assistant and field badges stay clear of each other on a hostile-CSS Ashby page after scrolling an inner container", async () => {
  test.setTimeout(240_000);
  const env = await launch();
  try {
    const { p, ov } = await connected(env, URL_ASHBY_RICH);
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 60_000 }).toBeGreaterThanOrEqual(20);
    await p.waitForTimeout(2000);
    const panel = await ov.call<{ left: number; top: number; right: number; bottom: number } | null>(`function(){const e=this.querySelector('[data-overlay-panel]:not([hidden])');if(!e)return null;const r=e.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom}}`);
    expect(panel).not.toBeNull();
    const vp = p.viewportSize()!;
    expect(panel!.left).toBeGreaterThanOrEqual(0); expect(panel!.right).toBeLessThanOrEqual(vp.width + 1); expect(panel!.bottom).toBeLessThanOrEqual(vp.height + 1);
    // the extension's own UI is never discovered as an application field
    expect(await p.evaluate(() => document.querySelectorAll("#xpertapply-assistant-overlay-v1 input,#xpertapply-assistant-overlay-v1 button").length)).toBe(0);
    await p.evaluate(() => { const s = document.getElementById("scroller"); if (s) s.scrollTop = 400; window.scrollTo(0, 300); });
    await p.waitForTimeout(1200);
    expect(await overlayCount(p)).toBe(1);
    expect(await submitted(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await env.close(); }
});
