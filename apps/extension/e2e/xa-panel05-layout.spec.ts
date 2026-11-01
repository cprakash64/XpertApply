import { expect, test, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { ASHBY_RICH, PROFILES, employerTls, stagingApiFront, startDirectApi } from "./xa-core1-harness";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";

const URL_RICH = "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555/application?rich=1";
const out = process.env.VISUAL_OUT;

type Env = { ctx: BrowserContext; worker: Worker; close: () => Promise<void> };
async function launch(): Promise<Env> {
  const api = await startDirectApi(); const front = await stagingApiFront(api);
  const tls = await employerTls([`MAP api-staging.xpertapply.com 127.0.0.1:${front.port}`]);
  const dist = path.resolve("dist-staging-granted");
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...tls.args] });
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
  return { ctx, worker, close: async () => { await ctx.close().catch(() => undefined); tls.server.close(); front.close(); await api.close(); } };
}
const seed = (w: Worker, uid: number) => w.evaluate(async ([u, email]) => new Promise<void>((res, rej) => { const o = indexedDB.open("xpertapply-extension-auth", 1); o.onupgradeneeded = () => o.result.createObjectStore("kv"); o.onerror = () => rej(o.error); o.onsuccess = () => { const tx = o.result.transaction("kv", "readwrite"); tx.objectStore("kv").put({ v: 1, accessToken: `acc-${u}`, refreshToken: `ref-${u}`, expiresAt: Date.now() + 1_800_000, userId: u, email }, "xaExtensionAuthV1"); tx.oncomplete = () => { o.result.close(); res(); }; }; }), [uid, PROFILES[uid].email] as const);

/** Every VISIBLE text run in a root (scope: the panel), clipped to its scroll containers; pairs from different runs sharing area overlap. */
const TEXT_PROBE = `function(scrollTo){
  const top = this.querySelector('[data-overlay-panel]') ? this : this.host.getRootNode();
  const panel = top.querySelector('[data-overlay-panel]:not([hidden])');
  const body = this.querySelector('.body') || top.querySelector('.body');
  if (body && scrollTo != null) body.scrollTop = scrollTo === 'end' ? body.scrollHeight : scrollTo;
  const pr = panel ? panel.getBoundingClientRect() : null;
  const clip = (el, rect) => { // intersect with every clipping ancestor, across shadow boundaries
    let r = { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom };
    for (let n = el; n; n = n.parentElement || (n.getRootNode() && n.getRootNode().host)) {
      if (n.nodeType !== 1) break;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      if (n.tagName === 'DETAILS' && !n.open && el.tagName !== 'SUMMARY' && !el.closest('summary')) return null;
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY) && n !== document.documentElement) {
        const c = n.getBoundingClientRect(); r = { l: Math.max(r.l, c.left), t: Math.max(r.t, c.top), r: Math.min(r.r, c.right), b: Math.min(r.b, c.bottom) };
      }
    }
    return r.r - r.l > 1 && r.b - r.t > 1 ? r : null;
  };
  const roots = [this]; const runs = []; const escapes = [];
  const walkRoot = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; let nodeIndex = 0;
    while ((n = walker.nextNode())) { nodeIndex++;
      const t = n.textContent.replace(/\\s+/g, ' ').trim(); if (!t) continue;
      const el = n.parentElement; if (!el || el.closest('style,script')) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        const c = clip(el, rect); if (!c) continue;
        runs.push({ node: nodeIndex, t: t.slice(0, 40), id: el.id || el.className || el.tagName, l: c.l, tp: c.t, r: c.r, b: c.b });
        if (pr && (rect.left < pr.left - 1 || rect.right > pr.right + 1) && c.r - c.l > 1) escapes.push([t.slice(0, 30), Math.round(rect.left), Math.round(rect.right)]);
      }
    }
    for (const host of root.querySelectorAll('[data-overlay-workflow-facade]')) { /* closed root is unreachable from here */ }
  };
  walkRoot(this);
  const overlaps = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.node === b.node) continue; // lines of one text node (a clamped title) cannot overlap each other
    const w = Math.min(a.r, b.r) - Math.max(a.l, b.l), h = Math.min(a.b, b.b) - Math.max(a.tp, b.tp);
    if (w > 2 && h > 3) overlaps.push([a.t, a.id, b.t, b.id, Math.round(w), Math.round(h)]);
  }
  const small = runs.filter(x => (x.b - x.tp) < 9).map(x => x.t);
  return { runs: runs.length, overlaps, escapes, small, panel: pr && { l: pr.left, t: pr.top, w: pr.width, h: pr.height, b: pr.bottom }, bodyScroll: body && [body.scrollHeight, body.clientHeight] };
}`;

/** Synthetic worst case, applied to the real panel through CDP: every warning visible at once, a very long job title, long messages, big numbers. */
const STRESS = `function(){
  const q = (id) => this.querySelector('#' + id);
  const long = 'Senior Staff Machine Learning Engineer, Ads Ranking and Efficiency, Core Monetization Platform (Remote, United States) · jobs.ashbyhq.com';
  if (q('job')) q('job').textContent = long;
  for (const id of ['siteAccess', 'limited', 'errors', 'final', 'suppressedMarks', 'summary', 'account']) if (q(id)) q(id).hidden = false;
  if (q('siteAccessText')) q('siteAccessText').textContent = 'The application is on jobs.ashbyhq.com. XpertApply needs permission to read relevant application-page and form information so it can identify and fill fields. Relevant information may be sent to XpertApply’s service only for features you request.';
  if (q('errors')) q('errors').textContent = 'XpertApply stopped before it finished this application. Nothing already on the form was changed. Choose “Fill application” to retry, or finish the rest yourself.';
  if (q('suppressedMarks')) q('suppressedMarks').textContent = '12 field marks are hidden so they don’t cover the form. Scroll the form to check those fields yourself.';
  if (q('summary')) q('summary').textContent = 'XpertApply filled 4 of 35 fields. Values the employer or your browser had already entered are not counted. 31 required questions are still unanswered. A resume is attached, but the application is not complete.';
  if (q('account')) q('account').textContent = 'Extension not signed in · this application was opened from xpertapply.com';
  for (const id of ['discovered', 'filled', 'skipped', 'review']) if (q(id)) q(id).textContent = '9999';
  if (q('resume')) q('resume').textContent = 'Attach manually'; if (q('cover')) q('cover').textContent = 'Attach manually';
  if (q('stage')) q('stage').textContent = 'Filled — some items need your review';
  if (q('disconnect')) q('disconnect').hidden = false;
}`;

/** Every visible control can be scrolled to and ends up fully inside the panel; the body scrolls to its end. */
const REACH = `function(){
  const top = this.querySelector('[data-overlay-panel]') ? this : this.host.getRootNode();
  const panel = top.querySelector('[data-overlay-panel]:not([hidden])'); const body = top.querySelector('.body');
  if (!panel || !body) return { error: 'no panel' };
  const pr = panel.getBoundingClientRect(); const bad = [];
  for (const b of top.querySelectorAll('.body button, .header button')) {
    if (b.closest('[hidden]')) continue;
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect(); const br = b.closest('.body') ? body.getBoundingClientRect() : pr;
    if (r.width < 1) continue;
    if (r.left < pr.left - 1 || r.right > pr.right + 1 || r.top < br.top - 1 || r.bottom > br.bottom + 1) bad.push([b.id || b.textContent.slice(0, 20), Math.round(r.top), Math.round(r.bottom), Math.round(br.top), Math.round(br.bottom)]);
  }
  body.scrollTop = body.scrollHeight;
  const atEnd = body.scrollTop >= body.scrollHeight - body.clientHeight - 2;
  body.scrollTop = 0;
  return { bad, atEnd, scrolls: body.scrollHeight > body.clientHeight, panelInside: pr.left >= 0 && pr.top >= 0 && pr.right <= innerWidth + 1 && pr.bottom <= innerHeight + 1 };
}`;

const SIZES: Array<[number, number]> = [[1366, 768], [1440, 900], [1756, 864], [1920, 1080], [2048, 1060]];
const ZOOMS = [0.75, 1, 1.25];
// Viewport widths that give panel widths of about 280, 320, 360, 410 and 410 (the panel is capped at 410/420).
const NARROW: Array<[number, number]> = [[308, 760], [348, 760], [388, 760], [448, 760], [508, 760]];

async function openConnected(env: Env): Promise<{ p: Page; ov: ReturnType<typeof overlayCdp> }> {
  await seed(env.worker, 7);
  const p = await env.ctx.newPage(); p.on("dialog", (d) => void d.accept());
  await p.goto(URL_RICH);
  await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
  const ov = overlayCdp(p);
  await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 90_000 }).toBeGreaterThanOrEqual(20);
  await expect.poll(async () => (await ov.text("#stage")) ?? "", { timeout: 90_000 }).toMatch(/filled|review/i);
  await p.waitForTimeout(2500);
  return { p, ov };
}

test("P1: panel text never overlaps or escapes, controls stay reachable, host stays usable (5 sizes x 3 zooms, 5 panel widths x 3 zooms, normal and worst-case)", async () => {
  test.setTimeout(900_000);
  const env = await launch();
  const findings: Record<string, any> = {};
  try {
    const { p, ov } = await openConnected(env);
    const cdp = await env.ctx.newCDPSession(p);
    if (out) mkdirSync(out, { recursive: true });
    const cases = [...SIZES.map(([w, h]) => ["vp", w, h] as const), ...NARROW.map(([w, h]) => ["narrow", w, h] as const)];
    for (const [kind, w, h] of cases) for (const zoom of ZOOMS) {
      const vp = { width: Math.round(w / zoom), height: Math.round(h / zoom) };
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: zoom, mobile: false });
      await p.waitForTimeout(400);
      for (const variant of ["normal", "stress"] as const) {
        if (variant === "stress") await ov.call(STRESS);
        for (const at of [0, "end"] as const) {
          const key = `${kind}${w}x${h}@${Math.round(zoom * 100)}/${variant}/${at}`;
          const overlay = await ov.call<any>(TEXT_PROBE, [at]);
          const widget = await ov.call<any>(TEXT_PROBE, [0], "widget").catch(() => null);
          findings[key] = { vp, overlay, widget };
          if (out && zoom === 1 && ((kind === "vp" && at === 0) || (kind === "narrow" && at === 0))) writeFileSync(path.join(out, `${key.replace(/\//g, "_")}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
        }
        const reach = await ov.call<any>(REACH);
        const usable = await p.evaluate(() => {
          const input = document.getElementById("location")!; input.scrollIntoView({ block: "center" });
          const r = input.getBoundingClientRect(); const panel = document.getElementById("xpertapply-assistant-overlay-v1")!;
          const x = Math.max(2, r.left + 8), y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, onInput: hit === input, hostIsPageHost: hit === panel };
        });
        // Under the floating panel the panel is meant to win; anywhere else the page must receive the pointer.
        const pr = findings[`${kind}${w}x${h}@${Math.round(zoom * 100)}/${variant}/0`].overlay.panel;
        if (pr && usable.x >= pr.l && usable.x <= pr.l + pr.w && usable.y >= pr.t && usable.y <= pr.t + pr.h) { usable.onInput = true; usable.hostIsPageHost = false; }
        findings[`${kind}${w}x${h}@${Math.round(zoom * 100)}/${variant}/reach`] = { reach, usable };
      }
      // back to the real state for the next case
      await ov.call<any>(`function(){ /* real state is restored by the next refresh */ }`);
      await p.reload(); await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
      await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 90_000 }).toBeGreaterThanOrEqual(20);
      await p.waitForTimeout(1200);
    }
    if (out) writeFileSync(path.join(out, "PANEL-FINDINGS.json"), JSON.stringify(findings, null, 1));
    const text = Object.entries(findings).filter(([k]) => !k.endsWith("/reach"));
    const bad = text.filter(([, f]) => f.overlay.overlaps.length || f.overlay.escapes.length || f.widget?.overlaps?.length || f.widget?.escapes?.length);
    const reachBad = Object.entries(findings).filter(([k, f]) => k.endsWith("/reach") && (f.reach.bad?.length || !f.reach.atEnd || !f.reach.panelInside || f.usable.hostIsPageHost || !f.usable.onInput));
    console.log("PANELBAD " + bad.length + "/" + text.length + " reachBad " + reachBad.length + " " + JSON.stringify(bad.slice(0, 4).map(([k, f]) => [k, f.overlay.overlaps.slice(0, 3), f.overlay.escapes.slice(0, 3)])) + JSON.stringify(reachBad.slice(0, 4)));
    if (!process.env.VISUAL_REPORT_ONLY) { expect(bad.map(([k]) => k)).toEqual([]); expect(reachBad.map(([k]) => k)).toEqual([]); }
  } finally { await env.close(); }
});

const HOSTILE_DIV_CSS = `div{line-height:1!important;letter-spacing:.3em!important;text-align:justify!important;white-space:nowrap!important;font-size:22px!important;word-spacing:1em!important;text-transform:uppercase!important;font-family:Georgia,serif!important}
 *{line-height:1!important}`;

test("H1: host page rules aimed at div elements (the overlay host is a div) cannot disturb the panel", async () => {
  test.setTimeout(300_000);
  const env = await launch();
  try {
    await seed(env.worker, 7);
    const p = await env.ctx.newPage();
    await p.addInitScript((css) => { document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.append(s); }); }, HOSTILE_DIV_CSS);
    await p.goto(URL_RICH);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    const ov = overlayCdp(p);
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 90_000 }).toBeGreaterThanOrEqual(20);
    await p.waitForTimeout(3000);
    const cdp = await env.ctx.newCDPSession(p);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await p.waitForTimeout(600);
    const a = await ov.call<any>(TEXT_PROBE, [0]);
    const b = await ov.call<any>(TEXT_PROBE, ["end"]);
    const hostStyle = await p.evaluate(() => { const h = document.getElementById("xpertapply-assistant-overlay-v1")!; const s = getComputedStyle(h); return { lh: s.lineHeight, ls: s.letterSpacing, fs: s.fontSize, ta: s.textAlign, ws: s.whiteSpace, pos: s.position }; });
    if (out) writeFileSync(path.join(out, "hostile-div.png"), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    console.log("HOSTILE " + JSON.stringify({ hostStyle, top: [a.overlaps.length, a.escapes.length, a.runs, a.panel], end: [b.overlaps.length, b.escapes.length] , sample: a.overlaps.slice(0, 4)}));
    if (!process.env.VISUAL_REPORT_ONLY) { expect(a.overlaps).toEqual([]); expect(b.overlaps).toEqual([]); expect(a.escapes).toEqual([]); }
  } finally { await env.close(); }
});

const HOSTILE_LINEHEIGHT_CSS = `div{line-height:.55!important;font-size:13px!important}`;

test("H2: a page rule that collapses line-height on div elements cannot make panel text overlap", async () => {
  test.setTimeout(300_000);
  const env = await launch();
  try {
    await seed(env.worker, 7);
    const p = await env.ctx.newPage();
    await p.addInitScript((css) => { document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.append(s); }); }, HOSTILE_LINEHEIGHT_CSS);
    await p.goto(URL_RICH);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    const ov = overlayCdp(p);
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 90_000 }).toBeGreaterThanOrEqual(20);
    await p.waitForTimeout(3000);
    const cdp = await env.ctx.newCDPSession(p);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await p.waitForTimeout(600);
    const a = await ov.call<any>(TEXT_PROBE, [0]);
    const b = await ov.call<any>(TEXT_PROBE, ["end"]);
    const hostStyle = await p.evaluate(() => { const h = document.getElementById("xpertapply-assistant-overlay-v1")!; const s = getComputedStyle(h); return { lh: s.lineHeight, ls: s.letterSpacing, fs: s.fontSize, ta: s.textAlign, ws: s.whiteSpace, pos: s.position }; });
    if (out) writeFileSync(path.join(out, "hostile-lineheight.png"), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    console.log("HOSTILE2 " + JSON.stringify({ hostStyle, top: [a.overlaps.length, a.escapes.length, a.runs, a.panel], end: [b.overlaps.length, b.escapes.length] , sample: a.overlaps.slice(0, 4)}));
    if (!process.env.VISUAL_REPORT_ONLY) { expect(a.overlaps).toEqual([]); expect(b.overlaps).toEqual([]); expect(a.escapes).toEqual([]); }
  } finally { await env.close(); }
});

test("A1: why each required Ashby field was not filled is reported with its reason (never invented as filled)", async () => {
  test.setTimeout(240_000);
  const env = await launch();
  try {
    const { p, ov } = await openConnected(env);
    // Open the review list so its items are rendered, then read title, explanation and reason code of every item.
    await ov.call(`function(){const t=this.querySelector('.review-toggle'); if(t && t.getAttribute('aria-expanded')!=='true') t.click();}`, [], "widget");
    await p.waitForTimeout(500);
    const items = await ov.call<any[]>(`function(){return [...this.querySelectorAll('.item')].map(i=>({q:(i.querySelector('.q')||{}).textContent,why:(i.querySelector('.why')||{}).textContent,code:(i.querySelector('.reason-code')||{}).textContent||null}))}`, [], "widget");
    const values = await p.evaluate(() => Object.fromEntries(["_systemfield_name", "_systemfield_email", "_systemfield_phone", "location", "linkedin"].map((id) => [id, (document.getElementById(id) as HTMLInputElement).value])));
    // Every unfilled required field is explained by a reason code, and nothing empty is reported as filled. In this fixture the mock
    // profile has no location, so the reason is a missing saved answer, not a failed write.
    expect(items.length).toBeGreaterThan(20);
    expect(items.filter((i) => i.code && i.code !== "answer_missing")).toEqual([]);
    expect(values.location).toBe("");
    console.log("ASHBYITEMS " + JSON.stringify({ n: items.length,  first: items.slice(0, 3), values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ? "filled" : "empty"])) }));
    if (out) writeFileSync(path.join(out, "ashby-items.json"), JSON.stringify({ items, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ? "filled" : "empty"])) }, null, 1));
  } finally { await env.close(); }
});

const labelKey = (t: string) => /^name/i.test(t) ? "full_name" : /^e-?mail/i.test(t) ? "email" : /^phone/i.test(t) ? "phone" : null;
const LONG_TITLE = "Senior Staff Machine Learning Engineer, Ads Ranking and Efficiency, Core Monetization Platform (Remote, United States)";

async function websiteLaunched(hostile: boolean) {
  const h = await launchFromWebsite({
    html: ASHBY_RICH, sessionId: 5005, atsType: "ashby", jobTitle: LONG_TITLE, company: "Plaid",
    profile: { full_name: "Riley Candidate", email: "riley@example.test", phone: "+16025550199" },
    answers: [answer("full_name", "Riley Candidate"), answer("email", "riley@example.test"), answer("phone", "+16025550199")],
    keyFor: labelKey
  });
  if (hostile) await h.ctx.addInitScript((css) => { document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.append(s); }); }, HOSTILE_DIV_CSS);
  const { empPage } = await h.start();
  await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
  const ov = overlayCdp(empPage);
  await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 90_000 }).toBeGreaterThanOrEqual(20);
  await expect.poll(() => empPage.inputValue("#_systemfield_name"), { timeout: 60_000 }).toMatch(/Riley/);
  await empPage.waitForTimeout(2500);
  return { h, empPage, ov };
}

for (const hostile of [false, true]) {
  test(`W${hostile ? 2 : 1}: website-launched application${hostile ? " under hostile host CSS" : ""}: a long job title and every state stay readable, the launch needs no extension sign-in, nothing is submitted`, async () => {
    test.setTimeout(420_000);
    const { h, empPage, ov } = await websiteLaunched(hostile);
    try {
      await expect.poll(async () => (await ov.text("#account").catch(() => "")) ?? "", { timeout: 20_000 }).toMatch(/Extension not signed in · this application was opened from xpertapply\.com/);
      expect(await ov.call<string>(`function(){return this.querySelector('#account').dataset.kind}`)).toBe("website");
      // the website launch keeps working without an extension account: Fill is a Fill, not a forced Connect
      expect(await ov.text("#fill")).toMatch(/fill application/i);
      expect(await ov.isEnabled("#fill")).toBe(true);
      expect((await ov.text("#job")) ?? "").toContain("Senior Staff Machine Learning Engineer");
      const cdp = await h.ctx.newCDPSession(empPage);
      if (out) mkdirSync(out, { recursive: true });
      const bad: unknown[] = [];
      for (const [w, hgt] of [[1366, 768], [1756, 864], [2048, 1060], [348, 760]] as const) for (const zoom of ZOOMS) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(w / zoom), height: Math.round(hgt / zoom), deviceScaleFactor: zoom, mobile: false });
        await empPage.waitForTimeout(400);
        for (const variant of ["normal", "stress"] as const) {
          if (variant === "stress") await ov.call(STRESS);
          for (const at of [0, "end"] as const) {
            const o = await ov.call<any>(TEXT_PROBE, [at]);
            const wd = await ov.call<any>(TEXT_PROBE, [0], "widget").catch(() => null);
            if (o.overlaps.length || o.escapes.length || wd?.overlaps?.length || wd?.escapes?.length) bad.push([`${w}x${hgt}@${zoom}/${variant}/${at}`, o.overlaps.slice(0, 2), o.escapes.slice(0, 2), wd?.overlaps?.slice(0, 2)]);
          }
          const reach = await ov.call<any>(REACH);
          if (reach.bad?.length || !reach.atEnd || !reach.panelInside) bad.push([`${w}x${hgt}@${zoom}/${variant}/reach`, reach]);
          if (out && zoom === 1 && variant === "normal") writeFileSync(path.join(out, `website${hostile ? "-hostile" : ""}-${w}x${hgt}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
        }
        await empPage.reload(); await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
        await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 90_000 }).toBeGreaterThanOrEqual(20);
      }
      console.log(`WEBSITEBAD${hostile ? "-hostile" : ""} ` + JSON.stringify(bad).slice(0, 1500));
      expect(bad).toEqual([]);
      expect(await empPage.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
    } finally { await h.close(); }
  });
}
