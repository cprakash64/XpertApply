import { expect, test, chromium, type BrowserContext, type Page } from "@playwright/test";
import { createServer as createHttps, type Server } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";
import { LEVER_FORM } from "../src/__tests__/lever_form.fixture";

/**
 * XA-ACT1: the no-toolbar-click workflow.
 *
 * Real ATS hostnames are served from loopback (the repo's allowed host-resolver MAP rule, plus a
 * local self-signed TLS server) and granted in the e2e build exactly as Chrome would after the
 * user approves each origin. Nothing here ever presses the toolbar button: every assistant that
 * appears was opened by the worker after a REGISTERED content script announced the page.
 *
 * Chrome's native Allow dialog cannot be driven by automation; the grant itself is NOT exercised
 * here (see the report's manual steps). What is exercised is everything after a grant exists.
 */
const HOSTS = ["job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "acme.wd5.myworkdayjobs.com"];
const UUID = "11111111-2222-3333-4444-555555555555";
const common = `<script>window.__emp={submits:0,clicks:0};
document.addEventListener('click',e=>{const t=e.target&&e.target.closest&&e.target.closest('button[type=submit],.template-btn-submit');if(t)window.__emp.clicks++},true);
document.addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++},true);</script>`;
const simpleForm = (title: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><main><h1>${title}</h1><form id="application-form">
<label for="first_name">First Name</label><input id="first_name" name="first_name">
<label for="last_name">Last Name</label><input id="last_name" name="last_name">
<label for="email">Email</label><input id="email" name="email" type="email">
<button type="submit">Submit application</button></form></main>${common}`;
const listing = (t: string) => `<!doctype html><title>${t}</title><main><h1>${t}</h1><p>Open roles</p><a href="#">Software Engineer</a></main>`;

function page(host: string, url: string): string {
  const p = new URL(url, "https://x").pathname;
  if (host === "job-boards.greenhouse.io") return /\/jobs\/\d+/.test(p) ? simpleForm("Apply - Greenhouse-shaped") : listing("Acme jobs");
  if (host === "jobs.lever.co") return p.endsWith("/apply") ? `<!doctype html><meta charset="utf-8"><title>Lever-shaped</title>${LEVER_FORM}${common}` : listing("Zoox - job description");
  if (host === "jobs.ashbyhq.com") return p.endsWith("/application") ? simpleForm("Application - Ashby-shaped") : listing("Acme at Ashby");
  return /\/apply$/.test(p) ? simpleForm("Apply - Workday-shaped") : listing("Workday careers");
}

async function tlsServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "xa-act1-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "1", "-subj", "/CN=ats.test"], { stdio: "ignore" });
  const requests: string[] = [];
  const server: Server = createHttps({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (rq, rs) => {
    const host = String(rq.headers.host ?? "").split(":")[0];
    requests.push(`${host}${rq.url}`);
    rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    rs.end(page(host, rq.url ?? "/"));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, port, requests, args: [`--host-resolver-rules=${HOSTS.map(h => `MAP ${h} 127.0.0.1:${port}`).join(",")}`, "--ignore-certificate-errors"] };
}

async function launch(profileDir: string, args: string[], waitForRegistration = true): Promise<{ ctx: BrowserContext; worker: import("@playwright/test").Worker }> {
  const dist = process.env.XA_E2E_DIST!;
  const ctx = await chromium.launchPersistentContext(profileDir, { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...args] });
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  if (waitForRegistration) await expect.poll(async () => hosts(await registered(worker)).length, { timeout: 30_000 }).toBe(HOSTS.length);
  return { ctx, worker };
}
const registered = (worker: import("@playwright/test").Worker) =>
  worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map(s => ({ id: s.id, matches: s.matches, persist: s.persistAcrossSessions })));
const hosts = (ids: { id: string }[]) => ids.map(s => s.id).filter(id => id.startsWith("xa-site-")).sort();

test("registered scripts mirror Chrome's grants and survive a browser restart without duplicating", async () => {
  test.setTimeout(120_000);
  const tls = await tlsServer();
  const profile = mkdtempSync(path.join(tmpdir(), "xa-act1-profile-"));
  let session = await launch(profile, tls.args);
  try {
    const want = HOSTS.map(h => `xa-site-${h}`).sort();
    await expect.poll(async () => hosts(await registered(session.worker)), { timeout: 20_000 }).toEqual(want);
    const scripts = await registered(session.worker);
    // One exact-origin script per grant: no wildcard host, nothing for XpertApply's own site (it is declarative), persistent.
    expect(scripts.filter(s => s.id.startsWith("xa-site-")).flatMap(s => s.matches).sort()).toEqual(HOSTS.map(h => `https://${h}/*`).sort());
    expect(scripts.every(s => !s.id.startsWith("xa-site-") || s.persist === true)).toBe(true);
    await session.ctx.close();

    session = await launch(profile, tls.args);                  // "Chrome restart", same profile
    await expect.poll(async () => hosts(await registered(session.worker)), { timeout: 20_000 }).toEqual(want);
    // A reconcile on top of what is already registered adds nothing (idempotent after worker wake).
    await new Promise(r => setTimeout(r, 1500));
    expect(hosts(await registered(session.worker))).toEqual(want);
  } finally { await session.ctx.close().catch(() => undefined); tls.server.close(); }
});

test("a granted supported application page opens ONE assistant with no toolbar click; listings and other sites stay silent", async () => {
  test.setTimeout(180_000);
  const tls = await tlsServer();
  const { ctx, worker } = await launch("", tls.args);
  try {
    const api: string[] = [];
    ctx.on("request", r => { if (/application-sessions|api\.xpertapply/.test(r.url())) api.push(r.url()); });
    const cases: Array<[string, string, RegExp, boolean]> = [
      ["Greenhouse", `https://job-boards.greenhouse.io/acme/jobs/4012345`, /Greenhouse/, false],
      ["Lever", `https://jobs.lever.co/zoox/${UUID}/apply`, /Lever/, false],
      ["Ashby", `https://jobs.ashbyhq.com/acme/${UUID}/application`, /Ashby/, false],
      ["Workday", `https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Remote/Engineer_R1/apply`, /Workday/, true]
    ];
    for (const [name, url, atsLabel, limited] of cases) {
      const p = await ctx.newPage();
      await p.goto(url);
      await expect(p.locator("#xpertapply-assistant-overlay-v1"), name).toHaveCount(1, { timeout: 30_000 });
      const ov = overlayCdp(p);
      await expect.poll(async () => (await ov.text("#ats")) ?? "", { message: `${name} ATS`, timeout: 15_000 }).toMatch(atsLabel);
      if (limited) expect(await ov.text("#ats")).toMatch(/limited/i);
      // Truthful: recognised from the URL, nothing read, nothing filled, and it says how to get a fill.
      expect(Number(await ov.text("#discovered"))).toBe(0);
      await expect.poll(async () => await ov.text("#stage"), { message: `${name} stage` }).toBe("Application recognized");
      expect(await ov.text("#errors")).toMatch(/Apply with XpertApply/);
      expect(await p.locator('[name="email"], #email').first().inputValue()).toBe("");
      expect(await p.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
      // Reload: a new document gets exactly one assistant again, never two.
      await p.reload();
      await expect(p.locator("#xpertapply-assistant-overlay-v1"), `${name} reload`).toHaveCount(1, { timeout: 30_000 });
      await p.waitForTimeout(1500);
      await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
      await p.close();
    }
    for (const quiet of ["https://job-boards.greenhouse.io/acme", `https://jobs.lever.co/zoox/${UUID}`, "https://jobs.ashbyhq.com/acme", "https://acme.wd5.myworkdayjobs.com/en-US/careers"]) {
      const p = await ctx.newPage();
      await p.goto(quiet);
      await p.waitForTimeout(3000);
      await expect(p.locator("#xpertapply-assistant-overlay-v1"), quiet).toHaveCount(0);
      await p.close();
    }
    // No XpertApply window or extension page was ever opened, and nothing about these pages went to any API.
    expect(await worker.evaluate(async () => (await chrome.windows.getAll({ populate: true })).flatMap(w => (w.tabs ?? []).map(t => t.url ?? "")).filter(u => u.startsWith("chrome-extension://")))).toEqual([]);
    expect(api).toEqual([]);
  } finally { await ctx.close(); tls.server.close(); }
});

test("a dismissed assistant stays dismissed through DOM and route changes; 'don't open here' is remembered across reloads", async () => {
  test.setTimeout(150_000);
  const tls = await tlsServer();
  const { ctx } = await launch("", tls.args);
  try {
    const url = `https://jobs.ashbyhq.com/acme/${UUID}/application`;
    const p = await ctx.newPage();
    await p.goto(url);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 30_000 });
    await overlayCdp(p).click("[data-overlay-close]");
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);
    // A DOM mutation and a single-page route change must not bring it back.
    await p.evaluate(() => { document.body.appendChild(Object.assign(document.createElement("div"), { textContent: "step 2" })); history.pushState({}, "", location.pathname + "?step=2"); });
    await p.waitForTimeout(3500);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);

    // The persistent off switch: reopen (new document), switch this site off, and it stays off.
    await p.goto(url);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 30_000 });
    await overlayCdp(p).click("#disableSite");
    await p.reload();
    await p.waitForTimeout(3500);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);
    // Other sites are unaffected.
    const g = await ctx.newPage();
    await g.goto("https://job-boards.greenhouse.io/acme/jobs/4012345");
    await expect(g.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 30_000 });
  } finally { await ctx.close(); tls.server.close(); }
});

test("website launch to a granted ATS host: one assistant, verified fields filled, submit untouched; after a browser restart a direct revisit is still recognised", async () => {
  test.setTimeout(240_000);
  const tls = await tlsServer();
  const profile = mkdtempSync(path.join(tmpdir(), "xa-act1-launch-"));
  const officialUrl = "https://job-boards.greenhouse.io/acme/jobs/4012345";
  const h = await launchFromWebsite({
    html: "<!doctype html><title>api</title>", sessionId: 4101, atsType: "greenhouse", officialUrl, profileDir: profile, launchArgs: tls.args,
    profile: { first_name: "Riley", last_name: "Candidate", email: "riley@example.test" },
    answers: [answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test")],
    keyFor: (t) => /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^e-?mail/i.test(t) ? "email" : null
  });
  let ctx2: BrowserContext | null = null;
  try {
    expect(await h.presence()).toMatchObject({ installed: true, protocolVersion: 3 });
    const { empPage, ack } = await h.start();
    expect(ack).toMatchObject({ ok: true });
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    await expect.poll(() => empPage.inputValue("#first_name"), { timeout: 40_000 }).toBe("Riley");
    expect(await empPage.inputValue("#last_name")).toBe("Candidate");
    expect(await empPage.inputValue("#email")).toBe("riley@example.test");
    expect(await empPage.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
    await empPage.waitForTimeout(1500);
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    expect(await h.worker.evaluate(async () => (await chrome.windows.getAll({ populate: true })).flatMap(w => (w.tabs ?? []).map(t => t.url ?? "")).filter(u => u.startsWith("chrome-extension://")))).toEqual([]);

    // Browser restart: session storage (the launch) is gone, the registered script and the grant are not.
    await h.ctx.close();
    const second = await launch(profile, tls.args);
    ctx2 = second.ctx;
    await expect.poll(async () => hosts(await registered(second.worker)), { timeout: 20_000 }).toContain("xa-site-job-boards.greenhouse.io");
    const again = await ctx2.newPage();
    await again.goto(officialUrl);
    await expect(again.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(async () => await overlayCdp(again).text("#stage")).toBe("Application recognized");
    expect(await again.inputValue("#first_name")).toBe("");        // no stale session was resurrected
  } finally {
    await ctx2?.close().catch(() => undefined);
    await h.ctx.close().catch(() => undefined);
    h.web.server.close(); await h.employer.close().catch(() => undefined); tls.server.close();
  }
});

test("a page opened directly (script dormant, assistant open) wakes and fills when a handoff is bound to that same tab, with no reload and no click", async () => {
  test.setTimeout(240_000);
  const tls = await tlsServer();
  const officialUrl = "https://job-boards.greenhouse.io/acme/jobs/4012345";
  const h = await launchFromWebsite({
    html: "<!doctype html><title>api</title>", sessionId: 4102, atsType: "greenhouse", officialUrl, launchArgs: tls.args,
    profile: { first_name: "Riley", last_name: "Candidate", email: "riley@example.test" },
    answers: [answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test")],
    keyFor: (t) => /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^e-?mail/i.test(t) ? "email" : null
  });
  try {
    await expect.poll(async () => hosts(await registered(h.worker)).length, { timeout: 30_000 }).toBe(HOSTS.length);
    const p = await h.ctx.newPage();
    await p.goto(officialUrl);                                   // direct visit: no handoff exists yet
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(async () => await overlayCdp(p).text("#stage")).toBe("Application recognized");
    expect(await p.inputValue("#first_name")).toBe("");

    // The user's launch binds a verified session to THIS tab (as a recovery or exact-URL bind would).
    await h.worker.evaluate(async ({ url, origin, sessionId }) => {
      const tab = (await chrome.tabs.query({ url: `${new URL(url).origin}/*` })).find(t => t.url === url)!;
      const now = Date.now();
      const pending = { version: 1, applicationId: String(sessionId), jobId: String(sessionId), applicationUrl: url, status: "detecting", handoffToken: "t", requestId: `req-${sessionId}`,
        sessionId, launchToken: "synthetic-launch", officialUrl: url, expectedOrigin: origin, createdAt: now, expiresAt: now + 900_000, targetTabId: tab.id,
        state: "detecting_ats", protocolVersion: 3, atsType: "greenhouse" };
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: pending, pendingLaunches: { [String(tab.id)]: pending } });
    }, { url: officialUrl, origin: new URL(officialUrl).origin, sessionId: 4102 });

    await expect.poll(() => p.inputValue("#first_name"), { timeout: 60_000 }).toBe("Riley");
    expect(await p.inputValue("#email")).toBe("riley@example.test");
    expect(await p.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
  } finally { await h.ctx.close(); h.web.server.close(); await h.employer.close().catch(() => undefined); tls.server.close(); }
});
