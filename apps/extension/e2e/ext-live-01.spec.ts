import { chromium, expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overlayCdp } from "./overlay-cdp";
import { HOSTS, directDrafts, employerPage, employerTls, launchSignedIn, overlayCount, startDirectApi, submitsUntouched } from "./xa-core1-harness";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * EXT-LIVE-01 acceptance, real Chromium with the real unpacked extension. The build differs from the
 * shipped one only in the state Chrome is in after the person accepts the single onboarding prompt: the
 * four supported-ATS group patterns granted, and NO per-host grant for any of those ATSs.
 *
 * Chrome's own consent dialog cannot be automated, so the grant is expressed as host_permissions in the
 * copy (see granted-build.ts). Nothing is ever submitted.
 */
/** The state Chrome is in after the person accepts the single onboarding prompt: the four group patterns, no per-host ATS grant. */
const GROUP_DIST = path.resolve(here, "..", "dist-ats-group-granted");
test.beforeAll(() => { execFileSync(process.execPath, ["e2e/build-ats-group-granted.mjs"], { cwd: path.resolve(here, ".."), stdio: "inherit" }); });

async function env(pageFor?: (host: string, url: string) => string | null) {
  const tls = await employerTls([], pageFor);
  const api = await startDirectApi();
  const b = await launchSignedIn({ api, tls, dist: GROUP_DIST });
  return { tls, api, ...b, async close() { await b.close(); tls.server.close(); await api.close(); } };
}

test("L1. One group grant per ATS: Greenhouse, Lever and Ashby each get one assistant and verified fields, with no per-host grant", async () => {
  test.setTimeout(240_000);
  const e = await env();
  try {
    const ids = await e.worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id).filter(id => id.startsWith("xa-site-")).sort());
    expect(ids).toEqual(["xa-site-ats-ashbyhq.com", "xa-site-ats-greenhouse.io", "xa-site-ats-lever.co", "xa-site-ats-myworkdayjobs.com", "xa-site-careers.withwaymo.com"]);
    const granted = await e.worker.evaluate(async () => (await chrome.permissions.getAll()).origins ?? []);
    expect(granted).not.toContain("https://job-boards.greenhouse.io/*");
    expect(granted).not.toContain("https://jobs.lever.co/*");

    for (const [url, first] of [
      ["https://job-boards.greenhouse.io/acme/jobs/4012345", "#first_name"],
      ["https://jobs.ashbyhq.com/acme/abc/application", "#first_name"]
    ] as const) {
      const p = await e.ctx.newPage();
      await p.goto(url);
      await expect.poll(() => p.inputValue(first), { timeout: 45_000 }).toBe("Riley");
      await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
      expect(await submitsUntouched(p)).toEqual({ submits: 0, clicks: 0 });
      await p.close();
    }
    // A DIFFERENT employer on the same ATS needs nothing further (the case that used to prompt again).
    const q = await e.ctx.newPage();
    await q.goto("https://job-boards.greenhouse.io/otherco/jobs/9988776");
    await expect.poll(() => q.inputValue("#first_name"), { timeout: 45_000 }).toBe("Riley");
    await expect(q.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    // Repeat visit: still exactly one assistant, one draft per posting.
    await q.reload();
    await expect.poll(() => q.inputValue("#first_name"), { timeout: 45_000 }).toBe("Riley");
    await expect(q.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    expect(directDrafts(e.api).length).toBeGreaterThanOrEqual(3);
  } finally { await e.close(); }
});

test("L2. A busy page that renders its form late is still found (mutations with no form do not spend the budget)", async () => {
  test.setTimeout(180_000);
  const storm = `<!doctype html><meta charset="utf-8"><title>Apply</title><main id="m"><h1>Application</h1><div id="slot"></div></main>
<script>
// Constant DOM churn with no form controls (chat widget, animation, analytics beacons)...
let n=0; const churn=setInterval(()=>{const d=document.createElement('div');d.textContent='tick '+(n++);document.getElementById('m').appendChild(d); if(n>400){clearInterval(churn)}},150);
// ...and the real form only after 45 seconds.
setTimeout(()=>{document.getElementById('slot').innerHTML=${JSON.stringify(`<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="last_name">Last Name</label><input id="last_name"><label for="email">Email</label><input id="email" type="email"><label for="phone">Phone</label><input id="phone" type="tel"><label for="resume">Resume/CV</label><input id="resume" type="file"><button type="submit">Submit application</button></form>`)}},45000);
window.__emp={submits:0,clicks:0};
</script>`;
  const e = await env((host, url) => (host === "job-boards.greenhouse.io" && url.includes("/jobs/777") ? storm : null));
  try {
    const p = await e.ctx.newPage();
    await p.goto("https://job-boards.greenhouse.io/acme/jobs/777");
    await expect.poll(() => p.inputValue("#first_name").catch(() => ""), { timeout: 120_000, intervals: [2000] }).toBe("Riley");
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
  } finally { await e.close(); }
});

test("L3. A single-page route change to the application step is found without a reload", async () => {
  test.setTimeout(150_000);
  const spa = `<!doctype html><meta charset="utf-8"><title>Job</title><main id="m"><h1>Senior Engineer</h1><button id="go" type="button">Apply</button><div id="slot"></div></main>
<script>
window.__emp={submits:0,clicks:0};
document.getElementById('go').addEventListener('click',()=>{history.pushState({}, '', '/acme/abc/application');
 // The route renders after a long pause, past what a single burst of looks would cover.
 setTimeout(()=>{document.getElementById('slot').innerHTML=${JSON.stringify(`<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="last_name">Last Name</label><input id="last_name"><label for="email">Email</label><input id="email" type="email"><label for="phone">Phone</label><input id="phone" type="tel"><label for="resume">Resume/CV</label><input id="resume" type="file"><button type="submit">Submit application</button></form>`)}},20000)});
</script>`;
  const e = await env((host, url) => (host === "jobs.ashbyhq.com" && /\/acme\/abc$/.test(url.split("?")[0]) ? spa : null));
  try {
    const p = await e.ctx.newPage();
    await p.goto("https://jobs.ashbyhq.com/acme/abc");
    await p.waitForTimeout(3500);
    expect(await overlayCount(p)).toBe(0);                    // a job description is not an application
    await p.click("#go");
    await expect.poll(() => p.inputValue("#first_name").catch(() => ""), { timeout: 90_000, intervals: [2000] }).toBe("Riley");
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
  } finally { await e.close(); }
});

test("L4. A supported application URL with no recognisable form ends in an actionable message, then Retry recovers", async () => {
  test.setTimeout(200_000);
  // Looks like several fields (so the page is looked at) but is not an application: no résumé, no identity pair.
  const survey = `<!doctype html><meta charset="utf-8"><title>Apply</title><main id="m"><h1>Tell us about yourself</h1><form id="s"><input name="a1"><input name="a2"><input name="a3"><textarea name="a4"></textarea></form><div id="tick"></div></main>
<script>window.__emp={submits:0,clicks:0};let n=0;setInterval(()=>{document.getElementById('tick').textContent='t'+(n++)},700);</script>`;
  let realForm = false;
  const e = await env((host, url) => {
    if (host === "job-boards.greenhouse.io" && url.includes("/jobs/555")) return realForm ? employerPage(host, "/acme/jobs/4012345") : survey;
    return null;
  });
  try {
    const p = await e.ctx.newPage();
    await p.goto("https://job-boards.greenhouse.io/acme/jobs/555");
    const ov = overlayCdp(p);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 150_000 });
    await ov.waitFor((root) => /hasn.t found the application form/i.test(root.textContent ?? ""), { timeout: 30_000 });
    expect(directDrafts(e.api)).toHaveLength(0);               // nothing was created or filled
    realForm = true;
    await p.reload();
    await expect.poll(() => p.inputValue("#first_name").catch(() => ""), { timeout: 60_000 }).toBe("Riley");
  } finally { await e.close(); }
});

test("L5. Pages that are not applications still never open an assistant", async () => {
  test.setTimeout(90_000);
  const e = await env();
  try {
    for (const url of ["https://job-boards.greenhouse.io/acme", "https://jobs.lever.co/zoox/abc", "https://jobs.ashbyhq.com/acme"]) {
      const p = await e.ctx.newPage();
      await p.goto(url);
      await p.waitForTimeout(3500);
      expect(await overlayCount(p), url).toBe(0);
      await p.close();
    }
    expect(directDrafts(e.api)).toHaveLength(0);
    expect(HOSTS.length).toBe(5);
  } finally { await e.close(); }
});

test("L6. The access page reads Chrome's real state and offers the single enable action", async () => {
  test.setTimeout(60_000);
  const e = await env();
  try {
    const id = new URL(e.worker.url()).host;
    const p: Page = await e.ctx.newPage();
    await p.goto(`chrome-extension://${id}/access.html?welcome=1`);
    await expect(p.locator("#groups .row")).toHaveCount(5);       // Greenhouse, Lever, Ashby, Workday, Workable
    await expect(p.locator("#groups")).toContainText("Greenhouse");
    await expect(p.locator("#groups")).toContainText("Allowed");     // this build is the post-grant state
    await expect(p.locator("#title")).toHaveText("Welcome to XpertApply");
  } finally { await e.close(); }
});

test("L7. Fresh install of the production build: no site access, one onboarding page, nothing requested before the click", async () => {
  test.setTimeout(90_000);
  const dist = path.resolve(here, "..", "dist");
  const tls = await employerTls();
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...tls.args] });
  try {
    const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
    // Install opens exactly one onboarding page.
    await expect.poll(() => ctx.pages().filter(p => p.url().includes("/access.html?welcome=1")).length, { timeout: 15_000 }).toBe(1);
    const granted = await worker.evaluate(async () => (await chrome.permissions.getAll()).origins ?? []);
    expect(granted.sort()).toEqual(["https://api.xpertapply.com/*", "https://www.xpertapply.com/*", "https://xpertapply.com/*"]);
    expect(await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBe(0);
    const page = ctx.pages().find(p => p.url().includes("/access.html"))!;
    await expect(page.locator("#groups .row")).toHaveCount(4);
    await expect(page.locator("#groups")).not.toContainText("Allowed");
    await expect(page.locator("#enable")).toBeVisible();
    await expect(page.locator("#title")).toHaveText("Welcome to XpertApply");
    // A supported application page before any grant: nothing is injected, no assistant, no draft.
    const p = await ctx.newPage();
    await p.goto("https://job-boards.greenhouse.io/acme/jobs/4012345");
    await p.waitForTimeout(3000);
    expect(await overlayCount(p)).toBe(0);
    expect(await worker.evaluate(async () => (await chrome.permissions.getAll()).origins ?? [])).toHaveLength(3);
    // Options reaches the same page (no extra permission needed).
    expect(await worker.evaluate(() => chrome.runtime.getManifest().options_ui?.page)).toBe("access.html");
  } finally { await ctx.close(); tls.server.close(); }
});
