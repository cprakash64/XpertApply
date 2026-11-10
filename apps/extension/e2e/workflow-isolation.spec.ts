import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";
import { site } from "./employer-site";

/**
 * EXT-LIVE-08 cross-tab / cross-application isolation, in real Chromium with the real extension against OWNED Lever-shaped pages under the
 * real hostname. Two JOBS at one employer share every hostname and the employer slug; they are different applications and carry different
 * values here so any contamination is visible. Unit mocks are not counted as isolation evidence.
 */
const HOST = "jobs.lever.co";
const J1 = "/acme/11111111-1111-1111-1111-111111111111/apply";
const J2 = "/acme/22222222-2222-2222-2222-222222222222/apply";
const HTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lever-app.html"), "utf8");
const url = (p: string) => `https://${HOST}${p}`;
const keyFor = (t: string): string | null => /^full name/i.test(t) ? "full_name" : /^email/i.test(t) ? "email" : /current company/i.test(t) ? "current_company" : null;
const A = { name: "Riley Candidate", email: "riley@example.test", org: "Acme Robotics" };
const B = { name: "Morgan Other", email: "morgan@example.test", org: "Zeta Corp" };
const ans = (v: typeof A) => [answer("full_name", v.name), answer("email", v.email), answer("current_company", v.org)];
const field = (p: Page, n: string) => p.inputValue(`input[name="${n}"]`).catch(() => "(none)");
const writes = (p: Page) => p.evaluate(() => (window as unknown as { __emp: { submits: number; clicks?: number } }).__emp);

async function twoJobs(sidA: number, sidB: number) {
  const s = await site({ [J1]: () => ({ body: HTML }), [J2]: () => ({ body: HTML }) }, [HOST]);
  const h = await launchFromWebsite({
    html: "<!doctype html><title>u</title>", sessionId: sidA, atsType: "lever", officialUrl: url(J1), launchArgs: s.args,
    profile: { first_name: "Riley" }, answers: ans(A), keyFor, jobTitle: "Job One", company: "Acme", location: "Phoenix, AZ, United States"
  });
  await h.addJob({ sessionId: sidB, atsType: "lever", officialUrl: url(J2), jobTitle: "Job Two", company: "Acme", profile: { first_name: "Morgan" }, answers: ans(B), keyFor, launchToken: "synthetic-launch-b" });
  const payloadB = { requestId: `req-${sidB}`, launchToken: "synthetic-launch-b", sessionId: sidB, jobId: sidB, officialUrl: url(J2), atsType: "lever", webApiBase: h.employer.origin, webAuthenticatedUserId: 1 };
  return { s, h, payloadB };
}
async function startPayload(h: Awaited<ReturnType<typeof launchFromWebsite>>, payload: Record<string, unknown>): Promise<Page> {
  await h.site.evaluate((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: p }, location.origin), payload);
  const [page] = await Promise.all([
    h.ctx.waitForEvent("page", { timeout: 30_000 }),
    h.site.evaluate((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: p }, location.origin), payload)
  ]);
  await page.waitForURL(payload.officialUrl as string);
  return page;
}
const employerPages = (h: Awaited<ReturnType<typeof launchFromWebsite>>) => h.ctx.pages().filter((p) => p.url().includes(HOST));

test("A-C,M,N,O: a different job of the same employer opened by hand stays idle: nothing written, no navigation, no extra tabs", async () => {
  test.setTimeout(200_000);
  const { s, h } = await twoJobs(8301, 8302);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => field(a, "name"), { timeout: 60_000 }).toBe(A.name);
    expect(await field(a, "org")).toBe(A.org);
    const b = await h.ctx.newPage();
    await b.goto(url(J2));
    await b.waitForTimeout(15_000);
    expect(await field(b, "name")).toBe("");              // never receives job A's values
    expect(await field(b, "email")).toBe("");
    expect(await field(b, "org")).toBe("");
    expect(b.url()).toBe(url(J2));                        // and was not navigated
    expect((await writes(b)).submits).toBe(0);
    expect((await writes(a)).submits).toBe(0);
    expect(employerPages(h)).toHaveLength(2);
    expect(await field(a, "name")).toBe(A.name);          // A untouched by B's presence
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("E,O: two explicitly launched applications on one ATS origin fill independently with their own values", async () => {
  test.setTimeout(240_000);
  const { s, h, payloadB } = await twoJobs(8311, 8312);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => field(a, "name"), { timeout: 60_000 }).toBe(A.name);
    const b = await startPayload(h, payloadB);
    await expect.poll(() => field(b, "name"), { timeout: 60_000 }).toBe(B.name);
    expect(await field(b, "org")).toBe(B.org);
    expect(await field(b, "email")).toBe(B.email);
    await a.waitForTimeout(4000);
    expect(await field(a, "name")).toBe(A.name);          // B's launch did not rewrite A
    expect(await field(a, "org")).toBe(A.org);
    for (const p of [a, b]) { expect((await writes(p)).submits).toBe(0); await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1); }
    expect(employerPages(h)).toHaveLength(2);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("K: a stale/forged run record cannot be used by a duplicated tab: no run, no Next, no fill from the copy", async () => {
  test.setTimeout(200_000);
  const { s, h } = await twoJobs(8331, 8332);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => field(a, "name"), { timeout: 60_000 }).toBe(A.name);
    // Duplicate Tab copies sessionStorage. Emulate it with an init script carrying A's storage into a new tab at the same URL.
    const copied = await a.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
    const dup = await h.ctx.newPage();
    await dup.addInitScript((json) => { for (const [k, v] of Object.entries(JSON.parse(json))) sessionStorage.setItem(k, v as string); }, copied);
    await dup.goto(url(J1));
    await dup.waitForTimeout(12_000);
    expect(employerPages(h)).toHaveLength(2);
    expect((await writes(dup)).submits).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Workday: the continuous run (Complete application). Two JOBS of one tenant share the host, the site path and the step names.
// ---------------------------------------------------------------------------------------------------------------------------------
import { ANSWERS as W_ANSWERS, HOST as W_HOST, PROFILE as W_PROFILE, fixture, keyFor as w_keyFor } from "./workday-shared";
import { clickWidget, emp, startReady, status as wstatus } from "./workday-driver";
import { overlayCdp } from "./overlay-cdp";

const WP = (n: number) => `/en-US/Careers/job/Phoenix/Engineer_JR${n}/apply/applyManually`;
const wurl = (n: number) => `https://${W_HOST}${WP(n)}`;
const personAnswers = (first: string) => W_ANSWERS.map((x) => (x.canonical_key === "first_name" ? answer("first_name", first) : x));
const wRoutes = () => ({ [WP(1)]: () => ({ body: fixture({ name: "wi1", noLegal: true }) }), [WP(2)]: () => ({ body: fixture({ name: "wi2", noLegal: true }) }) });

async function workdayTwoJobs(sidA: number, sidB: number, cfg: Record<string, unknown> = {}) {
  const s = await site({ [WP(1)]: () => ({ body: fixture({ name: "wi1", noLegal: true, ...cfg }) }), [WP(2)]: () => ({ body: fixture({ name: "wi2", noLegal: true, ...cfg }) }) }, [W_HOST]);
  const h = await launchFromWebsite({
    html: "<!doctype html><title>u</title>", sessionId: sidA, atsType: "workday", officialUrl: wurl(1), launchArgs: s.args,
    profile: { ...W_PROFILE, first_name: "Riley" }, answers: personAnswers("Riley"), keyFor: w_keyFor, jobTitle: "Engineer One", company: "Acme", location: "Phoenix, AZ, United States"
  });
  await h.addJob({ sessionId: sidB, atsType: "workday", officialUrl: wurl(2), jobTitle: "Engineer Two", company: "Acme", profile: { ...W_PROFILE, first_name: "Morgan" }, answers: personAnswers("Morgan"), keyFor: w_keyFor, launchToken: "synthetic-launch-b" });
  const payloadB = { requestId: `req-${sidB}`, launchToken: "synthetic-launch-b", sessionId: sidB, jobId: sidB, officialUrl: wurl(2), atsType: "workday", webApiBase: h.employer.origin, webAuthenticatedUserId: 1 };
  return { s, h, payloadB };
}
const first = (p: Page) => p.inputValue("#fn").catch(() => "(none)");
const startRun = async (p: Page) => { const ov = overlayCdp(p); await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true); await clickWidget(ov, "start"); return ov; };

test("Workday A-D,M,N: Tab A runs to Review; a different JOB of the tenant opened by hand stays idle (no fill, no Next, no extra tab)", async () => {
  test.setTimeout(300_000);
  const { s, h } = await workdayTwoJobs(8401, 8402);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    const b = await h.ctx.newPage();
    await b.goto(wurl(2));
    await startRun(a);
    await expect.poll(async () => (await emp(a)).visited.at(-1), { timeout: 180_000 }).toBe("Review");
    await b.waitForTimeout(5000);
    expect(await first(b)).toBe("");
    expect((await emp(b)).clicks.next).toBe(0);
    expect((await emp(b)).visited.at(-1)).toBe("My Information");
    expect((await emp(a)).clicks.submit).toBe(0);
    expect((await emp(a)).clicks.next).toBe(3);
    expect(h.ctx.pages().filter((p) => p.url().includes(W_HOST))).toHaveLength(2);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("Workday E: both applications explicitly started in two tabs complete independently with their own values", async () => {
  test.setTimeout(360_000);
  const { s, h, payloadB } = await workdayTwoJobs(8411, 8412);
  try {
    const { empPage: a } = await h.start();
    const b = await startPayload(h, payloadB);
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    await expect.poll(() => first(b), { timeout: 60_000 }).toBe("Morgan");
    await startRun(a); await startRun(b);
    await expect.poll(async () => (await emp(a)).visited.at(-1), { timeout: 240_000 }).toBe("Review");
    await expect.poll(async () => (await emp(b)).visited.at(-1), { timeout: 240_000 }).toBe("Review");
    expect(await a.evaluate(() => (window as any).__emp.vals.fn)).toBe("Riley");
    expect(await b.evaluate(() => (window as any).__emp.vals.fn)).toBe("Morgan");
    for (const p of [a, b]) { const e = await emp(p); expect(e.clicks.submit).toBe(0); expect(e.clicks.next).toBe(3); }
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("Workday F: the tab moves (SPA) to a DIFFERENT job mid-run: the run stops, no further Next, and the person must start again", async () => {
  test.setTimeout(300_000);
  const { s, h } = await workdayTwoJobs(8421, 8422);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    const ov = await startRun(a);
    await expect.poll(async () => (await emp(a)).clicks.next, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);
    await a.evaluate((p) => history.pushState({}, "", p), WP(2));
    await a.waitForTimeout(500);
    const nextAtMove = (await emp(a)).clicks.next;
    await a.waitForTimeout(25_000);
    expect((await emp(a)).clicks.next).toBeLessThanOrEqual(nextAtMove + 1);   // at most one click already in flight at the instant of the move
    const after = (await emp(a)).clicks.next;
    await a.waitForTimeout(8_000);
    expect((await emp(a)).clicks.next).toBe(after);                           // and then none
    expect((await emp(a)).visited.at(-1)).not.toBe("Review");
    expect((await emp(a)).clicks.submit).toBe(0);
    void ov;
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("Workday G: a duplicated tab (sessionStorage copied) does not inherit the run: no run, no Next", async () => {
  test.setTimeout(300_000);
  const { s, h } = await workdayTwoJobs(8431, 8432);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    await startRun(a);
    await expect.poll(async () => (await emp(a)).clicks.next, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);
    const copied = await a.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
    expect(copied).toContain("xpertapply.workflow.v1");
    const dup = await h.ctx.newPage();
    await dup.addInitScript((json) => { for (const [k, v] of Object.entries(JSON.parse(json))) sessionStorage.setItem(k, v as string); }, copied);
    await dup.goto(wurl(1));
    const before = (await emp(dup)).clicks.next;
    await dup.waitForTimeout(20_000);
    expect((await emp(dup)).clicks.next).toBe(before);       // the copy never advances on the strength of a copied record
    expect((await emp(dup)).clicks.submit).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("Workday J,L: the site permission is revoked during a run: automation stops; and Cancel freezes a run for good", async () => {
  test.setTimeout(300_000);
  const { s, h } = await workdayTwoJobs(8441, 8442, { nextDelay: 6000 });
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    await startRun(a);
    await expect.poll(async () => (await emp(a)).clicks.next, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);
    await h.worker.evaluate(async () => chrome.permissions.remove({ origins: ["https://*.myworkdayjobs.com/*"] }));
    await a.waitForTimeout(3000);
    const frozen = (await emp(a)).clicks.next;
    await a.waitForTimeout(30_000);
    expect((await emp(a)).clicks.next).toBeLessThanOrEqual(frozen + 1);
    expect((await emp(a)).visited.at(-1)).not.toBe("Review");
    expect((await emp(a)).clicks.submit).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});
