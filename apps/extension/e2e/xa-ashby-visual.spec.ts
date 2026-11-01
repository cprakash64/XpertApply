import { expect, test, chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { PROFILES, employerTls, stagingApiFront, startDirectApi } from "./xa-core1-harness";

/**
 * XA-EXT-ASHBY-03 visual QA. The REAL staging build (granted-sites variant) on a realistic Ashby application, with host CSS that is
 * hostile to anything it does not own. Screenshots at four desktop sizes and two zoom levels, plus MEASURED layout assertions:
 * bounding rectangles of the assistant's own elements and of the field badges, never a pixel diff.
 * VISUAL_OUT=<dir> writes the screenshots and a findings file. VISUAL_REPORT_ONLY=1 records findings without failing (used to capture "before").
 */
const SIZES: Array<[number, number]> = [[1366, 768], [1440, 900], [1756, 864], [1920, 1080]];
const ZOOMS = [1, 1.25];
const URL_RICH = "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555/application?rich=1";
const out = process.env.VISUAL_OUT;
const reportOnly = process.env.VISUAL_REPORT_ONLY === "1";

type Box = { left: number; top: number; right: number; bottom: number };
const inter = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

async function badges(page: Page): Promise<Box[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  const { nodes } = await cdp.send("DOM.getFlattenedDocument", { depth: -1, pierce: true }) as any;
  const found: Box[] = [];
  for (const node of nodes) {
    const attrs: string[] = node.attributes ?? [];
    const cls = attrs[attrs.indexOf("class") + 1];
    if (node.nodeName !== "DIV" || cls !== "status" || attrs.includes("hidden")) continue;
    try {
      const { model } = await cdp.send("DOM.getBoxModel", { nodeId: node.nodeId }) as any;
      const q = model.border as number[];
      found.push({ left: Math.min(q[0], q[6]), top: Math.min(q[1], q[3]), right: Math.max(q[2], q[4]), bottom: Math.max(q[5], q[7]) });
    } catch { /* hidden or detached */ }
  }
  await cdp.detach();
  return found;
}

const LAYOUT_PROBE = `function(){
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[hidden]'); };
  const sel = '.brand,.context,.status,.row,.stat,.actions button,.warn,.note,[data-overlay-minimize],[data-overlay-close],#account,#disconnect,#disableSite';
  const els = [...this.querySelectorAll(sel)].filter(vis);
  const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const overlaps = [];
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
    const a = rect(els[i]), b = rect(els[j]);
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 1 && h > 1) overlaps.push([els[i].id || els[i].className || els[i].tagName, els[j].id || els[j].className || els[j].tagName, Math.round(w), Math.round(h)]);
  }
  const clipped = [...this.querySelectorAll('.brand,.context,.badge,.stat span,.actions button,#stage,#account,.row span')].filter(vis)
    .filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== 'inline').map(el => [el.id || el.className, el.scrollWidth, el.clientWidth]);
  const panel = this.querySelector('[data-overlay-panel]:not([hidden])');
  return { overlaps, clipped, panel: panel ? rect(panel) : null,
    job: (this.querySelector('#job') || {}).textContent, bodyScrolls: (() => { const b = this.querySelector('.body'); return b ? b.scrollHeight > b.clientHeight : null; })(),
    buttons: [...this.querySelectorAll('.actions button, #grantSiteAccess')].filter(vis).map(b => ({ id: b.id, text: b.textContent, disabled: b.disabled, h: Math.round(b.getBoundingClientRect().height) })) };
}`;

test("assistant and field badges: no overlap, no clipping, isolated from hostile host CSS, at 4 sizes x 2 zooms", async () => {
  test.setTimeout(420_000);
  const api = await startDirectApi(); const front = await stagingApiFront(api);
  const tls = await employerTls([`MAP api-staging.xpertapply.com 127.0.0.1:${front.port}`]);
  const dist = path.resolve("dist-staging-granted");
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...tls.args] });
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
  const findings: Record<string, unknown> = {};
  try {
    await worker.evaluate(async ([uid, email]) => new Promise<void>((res, rej) => { const o = indexedDB.open("xpertapply-extension-auth", 1); o.onupgradeneeded = () => o.result.createObjectStore("kv"); o.onerror = () => rej(o.error); o.onsuccess = () => { const tx = o.result.transaction("kv", "readwrite"); tx.objectStore("kv").put({ v: 1, accessToken: `acc-${uid}`, refreshToken: `ref-${uid}`, expiresAt: Date.now() + 1_800_000, userId: uid, email }, "xaExtensionAuthV1"); tx.oncomplete = () => { o.result.close(); res(); }; }; }), [7, PROFILES[7].email] as const);
    const page = await ctx.newPage();
    await page.goto(URL_RICH);
    await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    const ov = overlayCdp(page);
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 90_000 }).toBeGreaterThanOrEqual(20);
    await expect.poll(async () => (await ov.text("#stage")) ?? "", { timeout: 90_000 }).toMatch(/filled|review/i);
    await page.waitForTimeout(2500);
    const cdp = await ctx.newCDPSession(page);
    if (out) mkdirSync(out, { recursive: true });
    for (const [w, h] of SIZES) for (const zoom of ZOOMS) {
      const key = `${w}x${h}@${Math.round(zoom * 100)}`;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(w / zoom), height: Math.round(h / zoom), deviceScaleFactor: zoom, mobile: false });
      await page.waitForTimeout(900);
      const probe = await ov.call<any>(LAYOUT_PROBE);
      const widgetProbe = await ov.call<any>(LAYOUT_PROBE.replace("const sel = '", "const sel = '.q,.why,.item,.group-title,.review-toggle,.item button,"), [], "widget").catch(() => null);
      const vp = { width: Math.round(w / zoom), height: Math.round(h / zoom) };
      const panel: Box | null = probe.panel;
      const boxes = await badges(page);
      const badgesOverPanel = panel ? boxes.filter(b => inter(b, panel) > 0).length : 0;
      const badgesOutside = boxes.filter(b => b.left < 0 || b.top < 0 || b.right > vp.width + 1 || b.bottom > vp.height + 1).length;
      const panelOutside = panel ? (panel.left < 0 || panel.top < 0 || panel.right > vp.width + 1 || panel.bottom > vp.height + 1) : true;
      findings[key] = { viewport: vp, panel, visibleBadges: boxes.length, badgesOverPanel, badgesOutside, panelOutside, overlaps: probe.overlaps, clipped: probe.clipped, job: probe.job, bodyScrolls: probe.bodyScrolls, buttons: probe.buttons,
        widgetOverlaps: widgetProbe?.overlaps ?? null, widgetClipped: widgetProbe?.clipped ?? null };
      if (out) await page.screenshot({ path: path.join(out, `${key}.png`) });
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    if (out) writeFileSync(path.join(out, "FINDINGS.json"), JSON.stringify(findings, null, 2));
    // The host page is untouched by us: its own hostile styles still apply to its own nodes, and it still works.
    expect(await page.evaluate(() => ((document.querySelector("h1") as HTMLElement).style.cssText))).toBe("");
    expect(await page.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
    if (!reportOnly) {
      for (const [key, f] of Object.entries(findings) as Array<[string, any]>) {
        expect.soft(f.panelOutside, `${key} panel inside viewport`).toBe(false);
        expect.soft(f.overlaps, `${key} overlapping assistant elements`).toEqual([]);
        expect.soft(f.clipped, `${key} clipped assistant text`).toEqual([]);
        expect.soft(f.widgetOverlaps ?? [], `${key} overlapping review elements`).toEqual([]);
        expect.soft(f.badgesOverPanel, `${key} field badges over the assistant`).toBe(0);
        expect.soft(f.badgesOutside, `${key} field badges outside the viewport`).toBe(0);
      }
    }
  } finally { await ctx.close().catch(() => undefined); tls.server.close(); front.close(); await api.close(); }
});
