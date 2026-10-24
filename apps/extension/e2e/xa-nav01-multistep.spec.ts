import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer as createHttps, type Server } from "node:https";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";

/**
 * XA-EXT-NAV-01: a website launch to an employer JOB-DETAILS page whose "Apply now" leads to the real application form.
 *
 * Real Chromium, the real e2e extension build (the employer hosts below are pre-granted, as after a user's grant), the real worker and
 * content scripts, a real website-launch handshake. Employer pages are local fixtures served over TLS under the real hostnames; nothing
 * is a mock of the extension. NOT the live Waymo site, which is a separate manual acceptance step.
 */
const JOB_PATH = "/jobs/machine-learning-engineer-scenes";
const JOB_URL = `https://careers.withwaymo.com${JOB_PATH}?gh_jid=5357`;

export type Site = { hits: string[]; clicks: { apply: number; submit: number }; close(): void; args: string[] };

export const formHtml = (extra = "") => `<!doctype html><meta charset="utf-8"><title>Apply - Machine Learning Engineer, Scenes</title>
<main><h1>Machine Learning Engineer, Scenes</h1>
<form id="application-form" novalidate>
<div><label for="first_name">First Name *</label><input id="first_name" name="first_name" autocomplete="given-name" required></div>
<div><label for="last_name">Last Name *</label><input id="last_name" name="last_name" autocomplete="family-name" required></div>
<div><label for="email">Email *</label><input id="email" name="email" type="email" autocomplete="email" required></div>
<div><label for="phone">Phone *</label><input id="phone" name="phone" type="tel" autocomplete="tel" required></div>
<div><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required></div>
${extra}
<button id="submit_app" type="submit">Submit application</button></form></main>
<script>window.__emp={submits:0,clicks:0};document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('#submit_app'))window.__emp.clicks++},true);
document.getElementById('application-form').addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++});</script>`;

export const jobHtml = (applyControl: string, extraHead = "") => `<!doctype html><meta charset="utf-8"><title>Machine Learning Engineer, Scenes - Waymo Careers</title>${extraHead}
<main><h1>Machine Learning Engineer, Scenes</h1><p>Waymo Job ID 5357. Build the driver. Responsibilities, qualifications and benefits.</p>
${applyControl}<p>Waymo is an equal opportunity employer.</p></main>
<script>window.__job={apply:0};document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('[data-apply]'))window.__job.apply++},true);</script>`;

/** Serve fixture pages over TLS under real hostnames (resolved to loopback by the spec's host-resolver rules). */
export async function site(routes: Record<string, (url: URL) => { status?: number; body: string; headers?: Record<string, string> }>, hosts = ["careers.withwaymo.com", "job-boards.greenhouse.io"]): Promise<Site> {
  const dir = mkdtempSync(path.join(tmpdir(), "xa-nav-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "1", "-subj", "/CN=employer.test"], { stdio: "ignore" });
  const state: Site = { hits: [], clicks: { apply: 0, submit: 0 }, close: () => undefined, args: [] };
  const server: Server = createHttps({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (rq, rs) => {
    const host = String(rq.headers.host ?? "").split(":")[0];
    const url = new URL(rq.url ?? "/", `https://${host}`);
    state.hits.push(`${host}${url.pathname}`);
    const route = routes[`${host}${url.pathname}`] ?? routes[url.pathname];
    if (!route) { rs.writeHead(404, { "Content-Type": "text/plain" }); rs.end("not found"); return; }
    const out = route(url);
    rs.writeHead(out.status ?? 200, { "Content-Type": "text/html; charset=utf-8", ...(out.headers ?? {}) });
    rs.end(out.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  state.args = [`--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(",")}`, "--ignore-certificate-errors"];
  state.close = () => { server.closeAllConnections(); server.close(); };
  return state;
}

const labelKey = (t: string) => /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^e-?mail/i.test(t) ? "email" : /^phone/i.test(t) ? "phone" : null;
const PROFILE = { first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "+16025550199" };

export async function launch(s: Site, sessionId: number, extra: { jobTitle?: string } = {}) {
  return launchFromWebsite({
    html: "<!doctype html><title>unused</title>", sessionId, atsType: "greenhouse", officialUrl: JOB_URL, launchArgs: s.args,
    profile: PROFILE, answers: [answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test"), answer("phone", "+16025550199")],
    keyFor: labelKey, jobTitle: extra.jobTitle ?? "Machine Learning Engineer, Scenes", company: "Waymo"
  });
}

export type Observation = { url: string; overlays: number; stage: string | null; errors: string | null; discovered: string | null; resume: string | null; cover: string | null; fillDisabled: boolean | null; filled: Record<string, string>; apply: number };

export async function observe(ctx: BrowserContext, page: Page): Promise<Observation> {
  // The application may be this tab or one the page opened; look at whichever holds an assistant or a form.
  const candidates = ctx.pages().filter((p) => /withwaymo|greenhouse/.test(p.url()));
  const target = candidates.find((p) => p.url().includes("/apply") || p.url().includes("/application") || p.url().includes("greenhouse")) ?? page;
  const ov = overlayCdp(target);
  const overlays = await target.locator("#xpertapply-assistant-overlay-v1").count();
  const t = async (sel: string) => (overlays ? ((await ov.text(sel).catch(() => null)) as string | null) : null);
  const filled = await target.evaluate(() => Object.fromEntries(["first_name", "last_name", "email", "phone"].map((id) => [id, (document.getElementById(id) as HTMLInputElement | null)?.value ?? "(none)"]))).catch(() => ({}));
  return {
    url: target.url().replace(/\?.*$/, ""), overlays, stage: await t("#stage"), errors: await t("#errors"), discovered: await t("#discovered"),
    resume: await t("#resume"), cover: await t("#cover"), fillDisabled: overlays ? await ov.isEnabled("#fill").then((e) => !e).catch(() => null) : null, filled,
    apply: await page.evaluate(() => (window as unknown as { __job?: { apply: number } }).__job?.apply ?? -1).catch(() => -2)
  };
}

const VARIANTS: Record<string, { routes: Parameters<typeof site>[0]; hosts?: string[]; click?: string }> = {
  "same-tab anchor, path shares the job slug": {
    routes: { [JOB_PATH]: () => ({ body: jobHtml(`<a data-apply href="${JOB_PATH}/apply?gh_jid=5357">Apply now</a>`) }), [`${JOB_PATH}/apply`]: () => ({ body: formHtml() }) }
  },
  "same-tab anchor, path shares NO token with the job page": {
    routes: { [JOB_PATH]: () => ({ body: jobHtml(`<a data-apply href="/apply/5357?gh_jid=5357">Apply now</a>`) }), "/apply/5357": () => ({ body: formHtml() }) }
  },
  "same-tab button with script navigation": {
    routes: { [JOB_PATH]: () => ({ body: jobHtml(`<button data-apply type="button" onclick="location.href='/careers/application/5357'">Apply now</button>`) }), "/careers/application/5357": () => ({ body: formHtml() }) }
  },
  "new tab (target=_blank)": {
    routes: { [JOB_PATH]: () => ({ body: jobHtml(`<a data-apply target="_blank" rel="noopener" href="/apply/5357">Apply now</a>`) }), "/apply/5357": () => ({ body: formHtml() }) }
  },
  "cross-origin ATS (Greenhouse)": {
    routes: { [JOB_PATH]: () => ({ body: jobHtml(`<a data-apply href="https://job-boards.greenhouse.io/waymo/jobs/5357">Apply now</a>`) }), "/waymo/jobs/5357": () => ({ body: formHtml() }) }
  },
  "SPA route into the form": {
    routes: { [JOB_PATH]: () => ({ body: jobHtml(`<button data-apply type="button" id="go">Apply now</button><div id="slot"></div><script>document.getElementById('go').addEventListener('click',()=>{history.pushState({},'','/apply');document.getElementById('slot').innerHTML=${JSON.stringify(formHtml().replace(/<script>[\s\S]*<\/script>/, ""))}})</script>`) }) }
  }
};

const FORM_PATHS: Record<string, string> = {
  "same-tab anchor, path shares the job slug": "/jobs/machine-learning-engineer-scenes/apply",
  "same-tab anchor, path shares NO token with the job page": "/apply/5357",
  "same-tab button with script navigation": "/careers/application/5357",
  "new tab (target=_blank)": "/apply/5357",
  "cross-origin ATS (Greenhouse)": "/waymo/jobs/5357",
  "SPA route into the form": "/apply"
};

/** The one page of the workflow that is the application form, and the assistant on it. */
async function formPage(ctx: BrowserContext, fallback: Page, path: string): Promise<Page> {
  const find = () => ctx.pages().find((p) => { try { return new URL(p.url()).pathname === path; } catch { return false; } });
  await expect.poll(() => Boolean(find()), { timeout: 45_000, message: `a page at ${path}` }).toBe(true);   // never judge the job page in its place
  return find() ?? fallback;
}

for (const [name, variant] of Object.entries(VARIANTS)) {
  test(`${name}: the assistant opens by itself on the real form, the launch survives the hop, fields are detected and filled, nothing is submitted`, async () => {
    test.setTimeout(120_000);
    const s = await site(variant.routes, variant.hosts);
    const h = await launch(s, 7100 + Object.keys(VARIANTS).indexOf(name));
    try {
      const { empPage } = await h.start();
      const path = FORM_PATHS[name];
      const form = await formPage(h.ctx, empPage, path);
      await expect(form.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });
      const ov = overlayCdp(form);
      await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 45_000 }).toBe(5);
      await expect.poll(() => form.inputValue("#email"), { timeout: 45_000 }).toBe("riley@example.test");
      expect(await form.inputValue("#first_name")).toBe("Riley");
      expect(await form.inputValue("#phone")).toBe("+16025550199");
      expect((await ov.text("#errors")) ?? "").toBe("");                                              // no "doesn't match the prepared application"
      expect(await ov.isEnabled("#fill")).toBe(true);
      expect(await ov.text("#resume")).not.toMatch(/uploaded/i);                                      // a file input existing is not an upload
      await form.waitForTimeout(2500);
      for (const page of h.ctx.pages()) expect(await page.locator("#xpertapply-assistant-overlay-v1").count()).toBeLessThanOrEqual(1);   // no duplicate panels
      expect(await form.evaluate(() => (window as unknown as { __emp?: { submits: number; clicks: number } }).__emp ?? { submits: 0, clicks: 0 })).toEqual({ submits: 0, clicks: 0 });
      expect(s.hits.filter((hit) => hit.endsWith(path)).length).toBeLessThanOrEqual(2);              // the form is opened once, not hammered
      // one launch, one session: the same application context, never a second system
      expect(h.apiLog.filter((l) => l === "POST /application-sessions/token").length).toBe(1);
    } finally { await h.close().catch(() => undefined); s.close(); }
  });
}

test("ambiguous Apply buttons are never auto-clicked; the user is told what to do, and a manual click keeps the session", async () => {
  test.setTimeout(120_000);
  const s = await site({
    [JOB_PATH]: () => ({ body: jobHtml(`<a data-apply href="/apply/5357">Apply now</a><a data-apply href="/apply/9999">Apply now</a>`) }),
    "/apply/5357": () => ({ body: formHtml() }), "/apply/9999": () => ({ body: formHtml() })
  });
  const h = await launch(s, 7200);
  try {
    const { empPage } = await h.start();
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    await empPage.waitForTimeout(5000);
    expect(await empPage.evaluate(() => (window as unknown as { __job: { apply: number } }).__job.apply)).toBe(0);     // nothing was clicked for the user
    expect(new URL(empPage.url()).pathname).toBe(JOB_PATH);
    expect(s.hits.filter((hit) => hit.includes("/apply/"))).toEqual([]);
    await expect.poll(async () => (await overlayCdp(empPage).text("#errors")) ?? "", { timeout: 20_000 })
      .toBe("Click Apply now to continue. XpertApply will follow you to the application form.");
    // the user chooses; the launch follows them
    await empPage.locator("a[data-apply]").first().click();
    await empPage.waitForURL(/\/apply\/5357/);
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    await expect.poll(() => empPage.inputValue("#email"), { timeout: 45_000 }).toBe("riley@example.test");
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("same employer domain alone never binds an unrelated page: with no live Apply activation a different job is refused and nothing is filled", async () => {
  test.setTimeout(120_000);
  const s = await site({
    [JOB_PATH]: () => ({ body: jobHtml(`<p>Static description, no apply control.</p>`) }),
    "/jobs/software-engineer-planning/apply": () => ({ body: formHtml() })
  });
  const h = await launch(s, 7300);
  try {
    const { empPage } = await h.start();
    await empPage.waitForTimeout(4000);
    await h.worker.evaluate(async () => chrome.storage.session.remove("pendingApplyActivationV1"));   // no click ever authorised a hop
    const other = await h.ctx.newPage();
    await other.goto("https://careers.withwaymo.com/jobs/software-engineer-planning/apply");
    await other.waitForTimeout(8000);
    expect(await other.inputValue("#email")).toBe("");                                                 // not the prepared application: untouched
    expect(await other.inputValue("#first_name")).toBe("");
    expect(await other.evaluate(() => (window as unknown as { __emp: { submits: number; clicks: number } }).__emp)).toEqual({ submits: 0, clicks: 0 });
    // and the launch itself still belongs to its own tab
    expect((await h.worker.evaluate(async () => (await chrome.storage.session.get("activeAssistedApplyHandoffV1")).activeAssistedApplyHandoffV1?.targetTabId)) !== undefined).toBe(true);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("an unrelated navigation after the hop was followed is refused, and a stale activation cannot be reused", async () => {
  test.setTimeout(120_000);
  const s = await site({
    [JOB_PATH]: () => ({ body: jobHtml(`<button data-apply type="button" onclick="location.href='/careers/application/5357'">Apply now</button>`) }),
    "/careers/application/5357": () => ({ body: formHtml(`<a id="elsewhere" href="/jobs/software-engineer-planning/apply">Other job</a>`) }),
    "/jobs/software-engineer-planning/apply": () => ({ body: formHtml() })
  });
  const h = await launch(s, 7400);
  try {
    const { empPage } = await h.start();
    await expect.poll(() => empPage.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    await h.worker.evaluate(async () => chrome.storage.session.remove("pendingApplyActivationV1"));   // the activation is spent or expired
    await empPage.locator("#elsewhere").click();
    await empPage.waitForURL(/software-engineer-planning/);
    await empPage.waitForTimeout(8000);
    expect(await empPage.inputValue("#email")).toBe("");                                              // a different job in the same tab is not filled
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("the service worker is suspended after the Apply click and before the page navigates; the form still resumes the same launch, and a reload keeps it", async () => {
  test.setTimeout(150_000);
  const s = await site({
    // the page navigates 3 seconds after the click, a window in which an idle worker can be suspended
    [JOB_PATH]: () => ({ body: jobHtml(`<button data-apply type="button" onclick="setTimeout(function(){location.href='/careers/application/5357'},3000)">Apply now</button>`) }),
    "/careers/application/5357": () => ({ body: formHtml() })
  });
  const h = await launch(s, 7500);
  try {
    const { empPage } = await h.start();
    await expect.poll(() => empPage.evaluate(() => (window as unknown as { __job: { apply: number } }).__job.apply), { timeout: 45_000 }).toBe(1);
    const cdp = await h.ctx.newCDPSession(empPage);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await empPage.waitForURL(/\/careers\/application\/5357/, { timeout: 30_000 });
    await expect.poll(() => empPage.inputValue("#email").catch(() => ""), { timeout: 60_000 }).toBe("riley@example.test");
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    await empPage.reload();
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    await expect.poll(async () => Number(await overlayCdp(empPage).text("#discovered")), { timeout: 40_000 }).toBe(5);
    expect((await overlayCdp(empPage).text("#errors")) ?? "").toBe("");
    expect(h.apiLog.filter((l) => l === "POST /application-sessions/token").length).toBe(1);
  } finally { await h.close().catch(() => undefined); s.close(); }
});
