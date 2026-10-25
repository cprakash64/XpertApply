import { expect, test, type Page } from "@playwright/test";
import { chromium, type BrowserContext, type Worker } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overlayCdp } from "./overlay-cdp";
import { webServer } from "./cws-p1-launch-harness";
import { site } from "./employer-site";

/**
 * XA-EXT-NAV-02-V1: the extension against the REAL FastAPI application and a disposable PostgreSQL 16 database.
 * Only the external OpenAI service is a local stub (the real OpenAI SDK client code path runs against it). Needs:
 *   XA_REAL_API_PYTHON  the API virtualenv's python        XA_REAL_API_DIR  apps/api        XA_REAL_API_PG_ADMIN  postgresql+psycopg://…/postgres
 * Skipped (loudly) when they are absent, so the default suite does not depend on a database server.
 */
const PY = process.env.XA_REAL_API_PYTHON, API_DIR = process.env.XA_REAL_API_DIR, PG_ADMIN = process.env.XA_REAL_API_PG_ADMIN;
test.skip(!PY || !API_DIR || !PG_ADMIN, "XA_REAL_API_* not set: real-FastAPI integration NOT RUN");
const OLD_API_DIR = process.env.XA_REAL_API_DIR_OLD;
test.describe.configure({ mode: "serial" });

type Seed = { jobs: Record<string, number>; api: string; users: Record<string, { token: string; id: number }>; sessions: Record<string, { id: number; launch_token: string; url: string }> };
type Api = { seed: Seed; dir: string; stop(): void; mode(m: Record<string, unknown>): void; log(): { questions: any[]; claims: string[]; keys: string[]; model: string }[] };

async function startApi(dirOverride?: string): Promise<Api> {
  const dir = mkdtempSync(path.join(tmpdir(), "xa-real-api-"));
  const out = path.join(dir, "seed.json");
  const child: ChildProcess = spawn(PY!, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "real-api/server.py"), out, PG_ADMIN!], { cwd: dirOverride ?? API_DIR, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 180 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!existsSync(out)) { child.kill("SIGTERM"); throw new Error("real API did not start"); }
  const api: Api = {
    seed: JSON.parse(readFileSync(out, "utf8")), dir, stop: () => child.kill("SIGTERM"),
    mode: (m) => writeFileSync(path.join(dir, "stub_mode.json"), JSON.stringify(m)),
    log: () => (existsSync(path.join(dir, "stub_log.jsonl")) ? readFileSync(path.join(dir, "stub_log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
  };
  return api;
}

const ELEVEN = "jobs.ashbyhq.com/elevenlabs/0f6c2a52-aaaa-4bbb-8ccc-111111111111/application";
const SOFI = "job-boards.greenhouse.io/sofi/jobs/7001234";
const NARRATIVE = `<div><label for="q1">Describe an agent or LLM-powered system you have shipped. How did you evaluate whether it was working?</label><textarea id="q1" name="q1" required></textarea></div>
<div><label for="q2">Tell us about an automation or agent you took from prototype to production, including how you handled credentials and failures.</label><textarea id="q2" name="q2" required></textarea></div>
<div><label for="q3">Describe a project you built with non-engineering stakeholders. How did you decide what to build, and what was the impact?</label><textarea id="q3" name="q3" required maxlength="600"></textarea></div>
<div><label for="q5">Will you now or in the future require visa sponsorship to work for this company?</label><textarea id="q5" name="q5"></textarea></div>
<div><label><input id="agree" type="checkbox" name="agree"> I agree to the privacy policy and certify the information above is true</label></div>`;
const form = (title: string, extra = "") => `<!doctype html><meta charset="utf-8"><title>${title}</title><main><h1>${title}</h1><form id="application-form" novalidate>
<div><label for="first_name">First Name *</label><input id="first_name" name="first_name" autocomplete="given-name" required></div>
<div><label for="last_name">Last Name *</label><input id="last_name" name="last_name" autocomplete="family-name" required></div>
<div><label for="email">Email *</label><input id="email" name="email" type="email" autocomplete="email" required></div>
<div><label for="gh">GitHub profile URL</label><input id="gh" name="gh" type="url"></div><div><label for="li">LinkedIn profile URL</label><input id="li" name="li" type="url"></div>
<div><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required></div>${extra}
<button id="submit_app" type="submit">Submit Application</button></form></main>
<script>window.__emp={submits:0,clicks:0};document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('#submit_app'))window.__emp.clicks++;if(e.target&&e.target.closest&&e.target.closest('#sofi_autofill'))window.__emp.employerAutofill=(window.__emp.employerAutofill||0)+1},true);
document.getElementById('application-form').addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++});</script>`;

async function browser(api: Api, withNarrativeOnSofi = false) {
  const s = await site({
    [ELEVEN]: () => ({ body: form("Applied AI Engineer - ElevenLabs", NARRATIVE) }),
    [SOFI]: () => ({ body: form("Software Engineer - SoFi", `<button type="button" id="sofi_autofill">Autofill my application</button>${withNarrativeOnSofi ? NARRATIVE.replace(/q(\d)/g, "s$1") : ""}`) })
  }, ["jobs.ashbyhq.com", "job-boards.greenhouse.io"]);
  const web = await webServer();
  const dist = process.env.XA_E2E_DIST!;
  const ctx: BrowserContext = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...s.args] });
  const worker: Worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  await worker.evaluate(async (b) => chrome.storage.local.set({ apiBase: b }), api.seed.api);
  const siteTab: Page = await ctx.newPage();
  await siteTab.goto(web.origin);
  const payloadFor = async (key: string) => {
    const sess = api.seed.sessions[key];
    // A launch token is single-use. Preparing the same application again reuses its session and mints a fresh one, as the website does.
    const [uk, jk] = key.split(":");
    const prepared = await fetch(`${api.seed.api}/application-sessions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${api.seed.users[uk].token}` }, body: JSON.stringify({ job_id: api.seed.jobs[jk] }) });
    const fresh = (await prepared.json()) as { extension_launch_token: string };
    return { requestId: `req-${key}-${Date.now()}`, launchToken: fresh.extension_launch_token, sessionId: sess.id, jobId: sess.id, officialUrl: sess.url, atsType: key.endsWith("sofi") ? "greenhouse" : "ashby", webApiBase: api.seed.api, webAuthenticatedUserId: api.seed.users[uk].id };
  };
  const stage = (p: unknown) => siteTab.evaluate((x) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: x }, location.origin), p);
  const start = (p: unknown) => siteTab.evaluate((x) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: x }, location.origin), p);
  const launch = async (key: string): Promise<Page> => {
    const payload = await payloadFor(key);
    await stage(payload);
    const [page] = await Promise.all([ctx.waitForEvent("page", { timeout: 30_000 }), start(payload)]);
    await page.waitForURL(payload.officialUrl);
    return page;
  };
  /** Several launches in the same instant; the tab for each is found by its own URL. */
  const launchTogether = async (keys: string[]): Promise<Page[]> => {
    const payloads = await Promise.all(keys.map(payloadFor));
    const seen: Page[] = [];
    ctx.on("page", (p) => seen.push(p));
    for (const p of payloads) await stage(p);
    await Promise.all(payloads.map(start));
    await expect.poll(() => payloads.every((p) => seen.some((pg) => pg.url().startsWith(p.officialUrl.split("?")[0]))), { timeout: 60_000 }).toBe(true);
    return payloads.map((p) => seen.find((pg) => pg.url().startsWith(p.officialUrl.split("?")[0]))!);
  };
  return { s, web, ctx, worker, siteTab, launch, launchTogether, close: async () => { await ctx.close().catch(() => undefined); web.server.close(); s.close(); } };
}

/** The labels of every field-status badge on the page (their layer is a closed shadow root, so they are read over CDP). */
async function badgeLabels(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  const { nodes } = (await cdp.send("DOM.getFlattenedDocument", { depth: -1, pierce: true })) as any;
  const out: string[] = [];
  for (const node of nodes) {
    const attrs: string[] = node.attributes ?? [];
    if (node.nodeName !== "DIV" || attrs[attrs.indexOf("class") + 1] !== "status") continue;
    try {
      const { object } = (await cdp.send("DOM.resolveNode", { nodeId: node.nodeId })) as any;
      const { result } = (await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true, functionDeclaration: "function(){return (this.textContent||'').trim()}" })) as any;
      out.push(String(result.value));
    } catch { /* detached */ }
  }
  await cdp.detach();
  return out;
}
const emp = (p: Page) => p.evaluate(() => (window as unknown as { __emp: { submits: number; clicks: number; employerAutofill?: number } }).__emp);
const post = (api: Api, token: string, id: number, questions: unknown[]) =>
  fetch(`${api.seed.api}/application-sessions/${id}/draft-answers`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ questions }) });
const exchange = async (api: Api, key: string) => (await (await fetch(`${api.seed.api}/application-sessions/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launch_token: api.seed.sessions[key].launch_token }) })).json()) as { session_token: string };
const Q = [{ field_identifier: "q1", question: "Describe an agent or LLM-powered system you have shipped. How did you evaluate whether it was working?", control_type: "textarea", max_length: 900 }];

let api: Api;
test.beforeAll(async () => { test.setTimeout(240_000); api = await startApi(); });
test.afterAll(() => api?.stop());

test("API authorization against the real routes, database and rate limiter", async () => {
  const sA = (await exchange(api, "A:elevenlabs")).session_token, sB = (await exchange(api, "B:sofi")).session_token;
  const a = api.seed.sessions["A:elevenlabs"], a2 = api.seed.sessions["A:sofi"], ex = api.seed.sessions["A:expired"];
  const ok = await post(api, sA, a.id, Q);
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { drafts: { proposed_answer: string; verified: boolean; generation_status: string }[] };
  expect(body.drafts[0].proposed_answer).toMatch(/support-triage agent/);                      // A's own experience
  expect(body.drafts[0].proposed_answer).not.toMatch(/fraud|Contoso/);                         // never B's
  expect(body.drafts[0].verified).toBe(false);
  expect((await post(api, sB, a.id, Q)).status).toBe(403);                                     // another account's session token
  expect((await post(api, api.seed.users.B.token, a.id, Q)).status).toBe(403);                 // another account's main token
  expect((await post(api, sA, a2.id, Q)).status).toBe(403);                                    // right user, wrong job/session pairing
  expect((await post(api, "garbage", a.id, Q)).status).toBe(403);
  expect((await fetch(`${api.seed.api}/application-sessions/${a.id}/draft-answers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questions: Q }) })).status).toBe(401);
  expect((await fetch(`${api.seed.api}/application-sessions/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launch_token: ex.launch_token }) })).status).toBe(401);   // expired: no new session token
  expect((await post(api, api.seed.users.A.token, ex.id, Q)).status).toBe(410);               // expired: owner token cannot draft either
  expect((await post(api, sA, 999999, Q)).status).toBe(404);
  const sent = api.log().flatMap((l) => l.claims).join("|");
  expect(sent).toMatch(/support-triage/); expect(sent).not.toMatch(/fraud|Contoso/);           // the model only ever saw A's facts
  expect(api.log().every((l) => !l.keys.includes("candidate_contact"))).toBe(true);
});

test("ElevenLabs then SoFi: each tab drafts only from its own account; the first is untouched; documents and Submit stay separate", async () => {
  test.setTimeout(240_000);
  const b = await browser(api);
  try {
    const eleven = await b.launch("A:elevenlabs");
    await expect.poll(() => eleven.inputValue("#q1").catch(() => ""), { timeout: 90_000 }).toMatch(/support-triage agent/); 
    await eleven.waitForTimeout(3000);
    expect(await eleven.inputValue("#first_name")).toBe("Riley");
    // The real backend publishes email / GitHub / LinkedIn from the profile as UNVERIFIED answers, and the extension only fills verified
    // ones: these stay for the applicant (this is why the user's ElevenLabs form showed them unanswered). Nothing is invented.
    for (const id of ["email", "gh", "li"]) expect(await eleven.inputValue("#" + id)).toBe("");
    expect(await eleven.inputValue("#q2")).toBe("");                                           // no production evidence: nothing invented
    expect(await eleven.inputValue("#q5")).toBe("");                                           // sponsorship is the applicant's
    expect(await eleven.locator("#agree").isChecked()).toBe(false);                            // consent untouched
    // a draft is shown as a suggestion to review, never as done: the badge says so and the assistant still lists work to do
    expect((await badgeLabels(eleven)).some((t) => /Suggested/.test(t))).toBe(true);
    expect((await overlayCdp(eleven).text("#stage")) ?? "").toMatch(/review/i);
    expect((await overlayCdp(eleven).text("#stage")) ?? "").not.toMatch(/all caught up|complete/i);
    expect((await eleven.inputValue("#q3")).length).toBeLessThanOrEqual(600);
    await eleven.fill("#q1", "Edited by the applicant.");
    const sofi = await b.launch("B:sofi");
    await expect(sofi.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(() => sofi.inputValue("#first_name").catch(() => ""), { timeout: 60_000 }).toBe("Sam"); 
    for (const p of [eleven, sofi, eleven, sofi]) await p.bringToFront();
    expect(await eleven.inputValue("#q1")).toBe("Edited by the applicant.");                    // never overwritten
    expect(await eleven.inputValue("#first_name")).toBe("Riley");
    expect(await sofi.inputValue("#first_name")).toBe("Sam");
    expect(await sofi.evaluate(() => document.body.innerText + [...document.querySelectorAll("input,textarea")].map((e) => (e as HTMLInputElement).value).join(" "))).not.toMatch(/support-triage|Riley|Northwind/);
    // each tab keeps its own session, and documents are the applicant's own (names come from the session's own application)
    const views = await b.worker.evaluate(async () => Object.values((await chrome.storage.session.get("viewStates")).viewStates ?? {}).map((v: any) => [v.sessionId, v.company]));
    expect(views).toEqual(expect.arrayContaining([[api.seed.sessions["A:elevenlabs"].id, "ElevenLabs"], [api.seed.sessions["B:sofi"].id, "SoFi"]]));
    const fileName = async (p: Page) => p.evaluate(() => (document.getElementById("resume") as HTMLInputElement).files?.[0]?.name ?? "");
    const [fa, fb] = [await fileName(eleven), await fileName(sofi)];
    if (fa && fb) { expect(fa).not.toBe(fb); expect(fa).not.toMatch(/Sam/); expect(fb).not.toMatch(/Riley/); }
    for (const p of [eleven, sofi]) { const e = await emp(p); expect(e.submits).toBe(0); expect(e.clicks).toBe(0); expect(e.employerAutofill ?? 0).toBe(0); }
    console.log("DOC-NAMES " + JSON.stringify([fa, fb]));
  } finally { await b.close(); }
});

test("two applications of one account launched and drafting at the same moment each receive their own drafts, once", async () => {
  test.setTimeout(240_000);
  api.mode({ mode: "slow", delay: 4 });
  const before = api.log().length;
  const b = await browser(api, true);
  try {
    const [eleven, sofi] = await b.launchTogether(["A:elevenlabs", "A:sofi"]);
    await expect.poll(() => eleven.inputValue("#q1").catch(() => ""), { timeout: 120_000 }).toMatch(/support-triage agent/);
    await expect.poll(() => sofi.inputValue("#s1").catch(() => ""), { timeout: 120_000 }).toMatch(/support-triage agent/);
    await eleven.waitForTimeout(6000);
    for (const [page, id] of [[eleven, "q1"], [sofi, "s1"]] as const) expect((await page.inputValue("#" + id)).match(/support-triage/g)?.length).toBe(1);   // one draft each, not two replies in one field
    expect(await sofi.locator("#q1").count()).toBe(0);                                                   // the other form's field does not exist here
    const requests = api.log().slice(before);
    expect(requests.length).toBeGreaterThanOrEqual(2);                                                   // two separate drafting requests
    for (const p of [eleven, sofi]) { const e = await emp(p); expect(e.submits).toBe(0); expect(e.clicks).toBe(0); }
  } finally { api.mode({ mode: "normal" }); await b.close(); }
});

for (const [name, mode] of [["rate-limited provider", { mode: "rate_limit" }], ["malformed model output", { mode: "malformed" }], ["fabricated evidence", { mode: "fabricate" }], ["contact details in the draft", { mode: "inject" }]] as const) {
  test(`${name}: nothing is invented, the form stays usable, and a later retry succeeds`, async () => {
    test.setTimeout(240_000);
    api.mode(mode);
    const b = await browser(api);
    try {
      const page = await b.launch("A:elevenlabs");
      await expect.poll(() => page.inputValue("#first_name").catch(() => ""), { timeout: 90_000 }).toBe("Riley");   // deterministic fill still works
      await page.waitForTimeout(8000);
      expect(await page.inputValue("#q1")).toBe("");
      expect(await page.inputValue("#q3")).toBe("");
      await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
      api.mode({ mode: "normal" });
      await overlayCdp(page).click("#fill");
      await expect.poll(() => page.inputValue("#q1").catch(() => ""), { timeout: 90_000 }).toMatch(/support-triage agent/);
      expect((await emp(page)).submits).toBe(0);
    } finally { api.mode({ mode: "normal" }); await b.close(); }
  });
}

test("a reload while a draft is still being written never lets the old page's reply land twice", async () => {
  test.setTimeout(240_000);
  api.mode({ mode: "slow", delay: 5 });
  const b = await browser(api);
  try {
    const page = await b.launch("A:elevenlabs");
    await expect.poll(() => page.inputValue("#first_name").catch(() => ""), { timeout: 90_000 }).toBe("Riley");
    await page.reload();
    await expect.poll(() => page.inputValue("#q1").catch(() => ""), { timeout: 120_000 }).toMatch(/support-triage agent/);
    await page.waitForTimeout(8000);
    const v = await page.inputValue("#q1");
    expect(v.match(/support-triage/g)?.length).toBe(1);
  } finally { api.mode({ mode: "normal" }); await b.close(); }
});

test("the drafting endpoint is rate limited per account (run last: it exhausts the account's window)", async () => {
  const tokenA = api.seed.users.A.token, tokenB = api.seed.users.B.token;
  const statuses: number[] = [];
  for (let i = 0; i < 16; i++) statuses.push((await post(api, tokenA, api.seed.sessions["A:elevenlabs"].id, Q)).status);
  expect(statuses).toContain(429);
  expect(statuses.filter((x) => x === 200).length).toBeLessThanOrEqual(12);
  // another account is not affected by A's window
  expect((await post(api, tokenB, api.seed.sessions["B:sofi"].id, Q)).status).toBe(200);
});

test("compatibility: the new extension against the CURRENT staging backend (no draft-answers route) still launches, fills and stays usable", async () => {
  test.skip(!OLD_API_DIR, "XA_REAL_API_DIR_OLD not set: old-backend compatibility NOT RUN");
  test.setTimeout(240_000);
  const old = await startApi(OLD_API_DIR);
  try {
    expect((await post(old, old.seed.users.A.token, old.seed.sessions["A:elevenlabs"].id, Q)).status).toBe(404);   // the route really is absent
    const b = await browser(old);
    try {
      const page = await b.launch("A:elevenlabs");
      await expect.poll(() => page.inputValue("#first_name").catch(() => ""), { timeout: 90_000 }).toBe("Riley");
      await page.waitForTimeout(6000);
      expect(await page.inputValue("#q1")).toBe("");                                                  // nothing drafted, nothing invented
      expect((await overlayCdp(page).text("#errors")) ?? "").toBe("");                                // and no error is shown for it
      expect((await overlayCdp(page).text("#stage")) ?? "").toMatch(/review/i);
      expect((await emp(page)).submits).toBe(0);
    } finally { await b.close(); }
  } finally { old.stop(); }
});
