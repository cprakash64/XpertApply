import { expect, test, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { PROFILES, employerTls, stagingApiFront, startDirectApi } from "./xa-core1-harness";

/**
 * XA-EXT-GREENHOUSE-04. The REAL staging build (granted-sites variant) in a real Chromium, on a sanitized Greenhouse job-board
 * application (React-Select style comboboxes, voluntary self-identification, sticky header, inner scroller). The XpertApply API is an
 * owned loopback mock behind `api-staging.xpertapply.com`; every employer page is a local fixture. This is NOT a live staging run.
 *
 * Collisions are MEASURED from DOM bounding rectangles (badges via CDP, because their layer is a closed shadow root), never by pixel diff.
 * VISUAL_OUT=<dir> writes screenshots and FINDINGS.json. VISUAL_REPORT_ONLY=1 records findings without failing (used for "before").
 */
const URL_GH = "https://job-boards.greenhouse.io/acme/jobs/4012345?rich=1";
const URL_GH_PREFILL = `${URL_GH}&prefill=1`;
const SIZES: Array<[number, number]> = [[1366, 768], [1440, 900], [1756, 864], [1920, 1080]];
const ZOOMS = [1, 1.25];
const SENSITIVE = ["gender", "hispanic_ethnicity", "veteran_status", "disability_status"];
const out = process.env.VISUAL_OUT;
const reportOnly = process.env.VISUAL_REPORT_ONLY === "1";

type Box = { left: number; top: number; right: number; bottom: number };
type Kind = "text" | "control" | "menu" | "sticky";
type Obstacle = Box & { kind: Kind };
const area = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

type Env = { ctx: BrowserContext; worker: Worker; api: Awaited<ReturnType<typeof startDirectApi>>; front: Awaited<ReturnType<typeof stagingApiFront>>; hosts: string[]; close: () => Promise<void> };
async function launch(): Promise<Env> {
  const api = await startDirectApi(); const front = await stagingApiFront(api);
  const tls = await employerTls([`MAP api-staging.xpertapply.com 127.0.0.1:${front.port}`]);
  const dist = path.resolve("dist-staging-granted");
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...tls.args] });
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
  const hosts: string[] = [];
  ctx.on("request", (r) => { try { hosts.push(new URL(r.url()).hostname); } catch { /* data: and blob: URLs */ } });
  return { ctx, worker, api, front, hosts, close: async () => { await ctx.close().catch(() => undefined); tls.server.close(); front.close(); await api.close(); } };
}
const seed = (w: Worker, uid: number) => w.evaluate(async ([u, email]) => new Promise<void>((res, rej) => { const o = indexedDB.open("xpertapply-extension-auth", 1); o.onupgradeneeded = () => o.result.createObjectStore("kv"); o.onerror = () => rej(o.error); o.onsuccess = () => { const tx = o.result.transaction("kv", "readwrite"); tx.objectStore("kv").put({ v: 1, accessToken: `acc-${u}`, refreshToken: `ref-${u}`, expiresAt: Date.now() + 1_800_000, userId: u, email }, "xaExtensionAuthV1"); tx.oncomplete = () => { o.result.close(); res(); }; }; }), [uid, PROFILES[uid].email] as const);

async function connected(env: Env, url = URL_GH): Promise<{ p: Page; ov: ReturnType<typeof overlayCdp> }> {
  await seed(env.worker, 7);
  const p = await env.ctx.newPage(); p.on("dialog", (d) => void d.accept());
  await p.goto(url);
  await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
  const ov = overlayCdp(p);
  await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 90_000 }).toBeGreaterThanOrEqual(10);
  await expect.poll(async () => (await ov.text("#stage")) ?? "", { timeout: 90_000 }).toMatch(/filled|review/i);
  await p.waitForTimeout(2500);
  return { p, ov };
}

async function badges(page: Page): Promise<Box[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  const { nodes } = await cdp.send("DOM.getFlattenedDocument", { depth: -1, pierce: true }) as any;
  const found: Box[] = [];
  for (const node of nodes) {
    const attrs: string[] = node.attributes ?? [];
    const cls = attrs[attrs.indexOf("class") + 1];
    if (node.nodeName !== "DIV" || cls !== "status") continue;
    try {
      // The live rect of the badge as laid out (transforms included), and whether it is rendered at all.
      const { object } = await cdp.send("DOM.resolveNode", { nodeId: node.nodeId }) as any;
      const { result } = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: `function(){ const r = this.getBoundingClientRect(); const cs = getComputedStyle(this); const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0; return shown ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null; }`
      }) as any;
      if (result.value) found.push(result.value as Box);
    } catch { /* detached */ }
  }
  await cdp.detach();
  return found;
}

/** Everything on the employer page a badge must not cover, from the live DOM, clipped to the inner scroller and the viewport. */
const OBSTACLES = () => {
  const inner = document.getElementById("inner")!.getBoundingClientRect();
  const sticky = (document.querySelector("header.top") as HTMLElement).getBoundingClientRect();
  const out: Array<{ kind: string; left: number; top: number; right: number; bottom: number }> = [];
  const add = (kind: string, el: Element, r: { left: number; top: number; right: number; bottom: number }) => {
    let { left, top, right, bottom } = r;
    if (el.closest("#inner")) { left = Math.max(left, inner.left); top = Math.max(top, inner.top); right = Math.min(right, inner.right); bottom = Math.min(bottom, inner.bottom); }
    // Content scrolled under the sticky header is not visible, so it cannot be covered.
    if (kind !== "sticky") top = Math.max(top, sticky.bottom);
    left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
    if (right - left > 1 && bottom - top > 1) out.push({ kind, left, top, right, bottom });
  };
  for (const el of document.querySelectorAll("label,legend,h1,h2,p,.select__placeholder,.select__single-value")) {
    const range = document.createRange(); range.selectNodeContents(el);
    for (const r of range.getClientRects()) add("text", el, r);
  }
  for (const el of document.querySelectorAll("input:not([type=file]):not([type=hidden]):not(.select__input),textarea,.select__control,.select__menu,.select__option,header.top")) {
    const kind = el.matches(".select__menu,.select__option") ? "menu" : el.matches("header.top") ? "sticky" : "control";
    add(kind, el, el.getBoundingClientRect());
  }
  return out;
};

const PANEL = `function(){const e=this.querySelector('[data-overlay-panel]:not([hidden]), [data-overlay-restore]:not([hidden])');if(!e)return null;const r=e.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom}}`;

async function measure(p: Page, ov: ReturnType<typeof overlayCdp>) {
  const vp = await p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const [boxes, obstacles, panel] = await Promise.all([badges(p), p.evaluate(OBSTACLES) as Promise<Obstacle[]>, ov.call<Box | null>(PANEL)]);
  const count = (kind: Kind) => boxes.filter((b) => obstacles.some((o) => o.kind === kind && area(b, o) > 2)).length;
  let overBadges = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (area(boxes[i], boxes[j]) > 0) overBadges += 1;
  return {
    viewport: vp, badges: boxes.length,
    overLabels: count("text"), overControls: count("control"), overMenus: count("menu"), overSticky: count("sticky"),
    overBadges, overPanel: panel ? boxes.filter((b) => area(b, panel) > 0).length : 0,
    outsideViewport: boxes.filter((b) => b.left < 0 || b.top < 0 || b.right > vp.width + 1 || b.bottom > vp.height + 1).length,
    panel
  };
}
const submitted = (p: Page) => p.evaluate(() => (window as unknown as { __emp: { submits: number; clicks: number } }).__emp);
const selected = (p: Page) => p.evaluate(() => (window as unknown as { __selected: () => Record<string, string> }).__selected());
const textValues = (p: Page) => p.evaluate(() => Object.fromEntries(["first_name", "last_name", "email", "phone"].map((id) => [id, (document.getElementById(id) as HTMLInputElement).value])));

test("G1: badges never cover labels, controls, other badges, the sticky header or the assistant (4 sizes x 2 zooms x 4 scroll positions)", async () => {
  test.setTimeout(480_000);
  const env = await launch();
  const findings: Record<string, unknown> = {};
  try {
    const { p, ov } = await connected(env);
    const cdp = await env.ctx.newCDPSession(p);
    if (out) mkdirSync(out, { recursive: true });
    for (const [w, h] of SIZES) for (const zoom of ZOOMS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(w / zoom), height: Math.round(h / zoom), deviceScaleFactor: zoom, mobile: false });
      for (const [scrollY, inner] of [[0, 0], [380, 0], [900, 120], [1500, 200]] as const) {
        await p.evaluate(([y, i]) => { window.scrollTo(0, y); document.getElementById("inner")!.scrollTop = i; }, [scrollY, inner] as const);
        await p.waitForTimeout(700);
        const key = `${w}x${h}@${Math.round(zoom * 100)}/y${scrollY}`;
        findings[key] = await measure(p, ov);
        // Captured through the same emulated viewport the measurements were taken in (Playwright's own screenshot ignores it).
        if (out && (scrollY === 0 || scrollY === 380)) {
          const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
          writeFileSync(path.join(out, `${key.replace("/", "_")}.png`), Buffer.from(shot.data, "base64"));
        }
      }
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    if (out) writeFileSync(path.join(out, "FINDINGS.json"), JSON.stringify(findings, null, 2));
    const all = Object.values(findings) as Array<Awaited<ReturnType<typeof measure>>>;
    expect(all.reduce((n, f) => n + f.badges, 0), "the layout must still show some badges, not hide everything").toBeGreaterThan(0);
    expect(await submitted(p)).toEqual({ submits: 0, clicks: 0 });
    // No call to anything but the staging API and the local employer fixtures.
    expect(env.hosts.filter((host) => /xpertapply\.com$/.test(host) && host !== "api-staging.xpertapply.com")).toEqual([]);
    if (!reportOnly) {
      for (const [key, f] of Object.entries(findings) as Array<[string, Awaited<ReturnType<typeof measure>>]>) {
        expect.soft(f.overLabels, `${key} badges over question labels`).toBe(0);
        expect.soft(f.overControls, `${key} badges over controls`).toBe(0);
        expect.soft(f.overMenus, `${key} badges over menus`).toBe(0);
        expect.soft(f.overSticky, `${key} badges over the sticky header`).toBe(0);
        expect.soft(f.overBadges, `${key} badges over other badges`).toBe(0);
        expect.soft(f.overPanel, `${key} badges over the assistant`).toBe(0);
        expect.soft(f.outsideViewport, `${key} badges outside the viewport`).toBe(0);
      }
    }
  } finally { await env.close(); }
});

test("G2: an open Greenhouse dropdown menu is not covered by any badge, and the menu still works", async () => {
  test.setTimeout(240_000);
  const env = await launch();
  try {
    const { p, ov } = await connected(env);
    await p.evaluate(() => document.getElementById("relocate")!.scrollIntoView({ block: "center" }));
    await p.waitForTimeout(500);
    const control = p.locator('.select__control[data-for="relocate"]');
    await control.click();
    await expect(p.locator(".select__menu")).toHaveCount(1);
    await p.waitForTimeout(800);
    const f = await measure(p, ov);
    expect(f.overMenus, "badges over the open menu").toBe(0);
    expect(f.overLabels).toBe(0);
    expect(f.overControls).toBe(0);
    await p.locator(".select__option", { hasText: "No" }).first().click();
    expect((await selected(p)).relocate).toBe("No");
    expect(await submitted(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await env.close(); }
});

test("G3: voluntary self-identification stays unanswered and is never submitted", async () => {
  test.setTimeout(240_000);
  const env = await launch();
  try {
    const { p } = await connected(env);
    const chosen = await selected(p);
    for (const id of SENSITIVE) expect(chosen[id], `${id} must stay unanswered`).toBe("");
    expect(await submitted(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await env.close(); }
});

test("G4: Disconnect after a partial fill keeps what is on the employer form, stops writing, and removes annotations", async () => {
  test.setTimeout(300_000);
  const env = await launch();
  try {
    const { p, ov } = await connected(env);
    const before = await textValues(p);
    expect(Object.values(before).filter(Boolean).length).toBeGreaterThan(0);
    const annotated = (await badges(p)).length;
    expect(annotated).toBeGreaterThan(0);
    await ov.clickSynthetic("#disconnect");
    await expect.poll(async () => (await ov.text("#account").catch(() => "")) ?? "", { timeout: 20_000 }).toMatch(/not connected/i);
    await expect.poll(async () => (await ov.text("#fill").catch(() => "")) ?? "", { timeout: 20_000 }).toMatch(/connect xpertapply/i);
    await p.waitForTimeout(2500);
    // The user's page is exactly as it was: nothing erased, nothing newly written.
    expect(await textValues(p)).toEqual(before);
    expect(await badges(p)).toEqual([]);
    const calls = env.front.seen.length;
    for (const id of ["rescan", "fill", "next"]) { await ov.clickSynthetic(`#${id}`).catch(() => undefined); await p.waitForTimeout(1500); }
    expect(await textValues(p)).toEqual(before);
    expect(env.front.seen.slice(calls).filter((s) => /direct-sessions|\/application-sessions\//.test(s))).toEqual([]);
    expect(await submitted(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await env.close(); }
});

test("G5: a form that already holds employer or Chrome values: they are kept, and the fill count is attributable", async () => {
  test.setTimeout(240_000);
  const env = await launch();
  try {
    const { p, ov } = await connected(env, URL_GH_PREFILL);
    const values = await textValues(p);
    expect(values.last_name).toBe("ChromeFilled");
    const written = Object.values(values).filter(Boolean).length;
    // Resume and cover letter are files, not text values, so they are counted without being among the four text fields.
    expect(Number(await ov.text("#filled"))).toBeLessThanOrEqual(written + 2);
  } finally { await env.close(); }
});

test("G6: a preparation failure is reported as a preparation failure, with a retry, and nothing is written or counted", async () => {
  test.setTimeout(200_000);
  const env = await launch();
  try {
    env.api.state.failDirect = true;
    await seed(env.worker, 7);
    const p = await env.ctx.newPage();
    await p.goto(URL_GH);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    const ov = overlayCdp(p);
    await expect.poll(async () => (await ov.text("#errors").catch(() => "")) ?? "", { timeout: 40_000 }).toMatch(/couldn.t prepare this application/i);
    expect(await ov.text("#fill")).toMatch(/try again/i);
    expect(await ov.text("#filled")).toBe("0");
    expect(await ov.text("#discovered")).toBe("0");
    await p.waitForTimeout(2000);
    expect(Object.values(await textValues(p)).filter(Boolean)).toEqual([]);
    expect(await badges(p)).toEqual([]);
    expect(await submitted(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await env.close(); }
});

test("G7: the assistant never says preparation failed while it shows a prepared, discovered form", async () => {
  test.setTimeout(240_000);
  const env = await launch();
  try {
    const { ov } = await connected(env);
    expect(Number(await ov.text("#discovered"))).toBeGreaterThan(0);
    const errors = (await ov.text("#errors")) ?? "";
    expect(errors).not.toMatch(/preparing this application/i);
    const final = (await ov.text("#final")) ?? "";
    expect(final).not.toMatch(/ready to submit|all set|looks complete/i);
  } finally { await env.close(); }
});

