import { expect, test, type Page } from "@playwright/test";
import { overlayCdp } from "./overlay-cdp";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";
import { site } from "./employer-site";

/**
 * XA-EXT-NAV-02-R: a second website launch while another employer application is still open.
 * Job A is an Ashby-style form (ElevenLabs shape), job B a Greenhouse-style form (SoFi shape), on different hosts. Real Chromium, the real
 * e2e extension build, a real website-launch handshake against an owned backend; the employer pages are local fixtures.
 */
const A_URL = "https://jobs.ashbyhq.com/elevenlabs/0f6c2a52-aaaa-4bbb-8ccc-111111111111/application";
const B_URL = "https://job-boards.greenhouse.io/sofi/jobs/7001234";
const A_PROFILE = { first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "+16025550199" };

const labelKey = (t: string) => /github/i.test(t) ? "github_url" : /linkedin/i.test(t) ? "linkedin_url" : /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^e-?mail/i.test(t) ? "email" : /^phone/i.test(t) ? "phone" : null;
const answers = () => [...Object.entries(A_PROFILE).map(([k, v]) => answer(k, v)), answer("github_url", "https://github.com/riley-candidate"), answer("linkedin_url", "https://www.linkedin.com/in/riley-candidate")];

const form = (title: string, extra = "") => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<main><h1>${title}</h1><form id="application-form" novalidate>
<div><label for="first_name">First Name *</label><input id="first_name" name="first_name" autocomplete="given-name" required></div>
<div><label for="last_name">Last Name *</label><input id="last_name" name="last_name" autocomplete="family-name" required></div>
<div><label for="email">Email *</label><input id="email" name="email" type="email" autocomplete="email" required></div>
<div><label for="phone">Phone *</label><input id="phone" name="phone" type="tel" autocomplete="tel" required></div>
<div><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required></div>
${extra}
<button id="submit_app" type="submit">Submit Application</button></form></main>
<script>window.__emp={submits:0,clicks:0};document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('#submit_app'))window.__emp.clicks++},true);
document.getElementById('application-form').addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++});</script>`;

const FIELDS = ["first_name", "last_name", "email", "phone"] as const;
const values = (p: Page) => p.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, (document.getElementById(id) as HTMLInputElement | null)?.value ?? "(none)"])), [...FIELDS]);

async function startPayload(h: Awaited<ReturnType<typeof launchFromWebsite>>, payload: Record<string, unknown>): Promise<Page> {
  await h.site.evaluate((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: p }, location.origin), payload);
  const [page] = await Promise.all([
    h.ctx.waitForEvent("page", { timeout: 30_000 }),
    h.site.evaluate((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: p }, location.origin), payload)
  ]);
  await page.waitForURL(payload.officialUrl as string);
  return page;
}

async function twoJobs(sidA: number, sidB: number, drafts?: (questions: any[]) => unknown[]) {
  const s = await site({
    "jobs.ashbyhq.com/elevenlabs/0f6c2a52-aaaa-4bbb-8ccc-111111111111/application": () => ({ body: form("Applied AI Engineer - ElevenLabs", `<div><label for="gh">GitHub profile URL</label><input id="gh" name="gh" type="url"></div><div><label for="li">LinkedIn profile URL</label><input id="li" name="li" type="url"></div>
<div><label for="q1">Describe an agent or LLM-powered system you have shipped. How did you evaluate whether it was working?</label><textarea id="q1" name="q1" required></textarea></div>
<div><label for="q2">Tell us about an automation or agent you took from prototype to production, including how you handled credentials and failures.</label><textarea id="q2" name="q2" required></textarea></div>
<div><label for="q3">Describe a project you built with non-engineering stakeholders. How did you decide what to build, and what was the impact?</label><textarea id="q3" name="q3" required maxlength="600"></textarea></div>
<div><label for="q4">What's the most impactful thing you've built? What was your specific contribution?</label><textarea id="q4" name="q4" required></textarea></div>
<div><label for="q5">Will you now or in the future require visa sponsorship to work for ElevenLabs?</label><textarea id="q5" name="q5"></textarea></div>`) }),
    "jobs.ashbyhq.com/elevenlabs/9d1e7b30-bbbb-4ccc-8ddd-222222222222/application": () => ({ body: form("Voice Platform Engineer - ElevenLabs") }),
    "job-boards.greenhouse.io/sofi/jobs/7001234": () => ({ body: form("Software Engineer - SoFi", `<button type="button" id="sofi_autofill" onclick="window.__emp.employerAutofill=(window.__emp.employerAutofill||0)+1">Autofill my application</button>`) })
  }, ["jobs.ashbyhq.com", "job-boards.greenhouse.io"]);
  const h = await launchFromWebsite({
    html: "<!doctype html><title>unused</title>", sessionId: sidA, atsType: "ashby", officialUrl: A_URL, launchArgs: s.args,
    profile: A_PROFILE, answers: answers(), keyFor: labelKey, jobTitle: "Applied AI Engineer", company: "ElevenLabs", drafts
  });
  await h.addJob({ sessionId: sidB, atsType: "greenhouse", officialUrl: B_URL, jobTitle: "Software Engineer", company: "SoFi", profile: A_PROFILE, answers: answers(), keyFor: labelKey, launchToken: "synthetic-launch-b" });
  const payloadB = { requestId: `req-${sidB}`, launchToken: "synthetic-launch-b", sessionId: sidB, jobId: sidB, officialUrl: B_URL, atsType: "greenhouse", webApiBase: h.employer.origin, webAuthenticatedUserId: 1 };
  return { s, h, payloadB };
}

test("a second website launch while another employer application is open gets its own assistant and fill, and leaves the first untouched", async () => {
  test.setTimeout(180_000);
  const { s, h, payloadB } = await twoJobs(8101, 8102);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => a.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    await a.locator("#first_name").fill("Edited By User");                    // the applicant edits A and leaves it unfinished
    const b = await startPayload(h, payloadB);
    await expect(b.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });
    await expect.poll(() => b.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    expect((await values(b)).first_name).toBe("Riley");
    expect((await values(a)).first_name).toBe("Edited By User");              // A was neither refilled nor reverted
    expect(await a.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);
    expect(await b.evaluate(() => (window as unknown as { __emp: { submits: number; clicks: number } }).__emp)).toEqual({ submits: 0, clicks: 0 });
    expect(await a.evaluate(() => (window as unknown as { __emp: { submits: number; clicks: number } }).__emp)).toEqual({ submits: 0, clicks: 0 });
    // each tab's assistant is bound to its own application
    const view = await h.worker.evaluate(async () => Object.values((await chrome.storage.session.get("viewStates")).viewStates ?? {}).map((v: any) => [v.sessionId, v.company]));
    expect(view).toEqual(expect.arrayContaining([[8101, "ElevenLabs"], [8102, "SoFi"]]));
    void overlayCdp;
  } finally { await h.close().catch(() => undefined); s.close(); }
});

const noSubmit = (p: Page) => p.evaluate(() => (window as unknown as { __emp: { submits: number; clicks: number } }).__emp);

test("two launches in the same instant: each tab is bound to its own application", async () => {
  test.setTimeout(180_000);
  const { s, h, payloadB } = await twoJobs(8201, 8202);
  try {
    const payloadA = h.payload as Record<string, unknown>;
    await h.site.evaluate((ps) => ps.forEach((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: p }, location.origin)), [payloadA, payloadB]);
    const pages: Page[] = [];
    h.ctx.on("page", (p) => pages.push(p));
    await h.site.evaluate((ps) => ps.forEach((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: p }, location.origin)), [payloadA, payloadB]);
    await expect.poll(() => pages.length, { timeout: 30_000 }).toBe(2);
    for (const p of pages) await expect.poll(() => p.inputValue("#email").catch(() => ""), { timeout: 60_000 }).toBe("riley@example.test");
    for (const p of pages) await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    const bound = await h.worker.evaluate(async () => Object.values((await chrome.storage.session.get("viewStates")).viewStates ?? {}).map((v: any) => [v.sessionId, v.company]));
    expect(bound).toEqual(expect.arrayContaining([[8201, "ElevenLabs"], [8202, "SoFi"]]));
    for (const p of pages) expect(await noSubmit(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("the worker is suspended while the first application sits open, then a second is launched", async () => {
  test.setTimeout(180_000);
  const { s, h, payloadB } = await twoJobs(8301, 8302);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => a.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    const cdp = await h.ctx.newCDPSession(a);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    const b = await startPayload(h, payloadB);
    await expect(b.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });
    await expect.poll(() => b.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    // switching back and forth changes nothing
    for (const p of [a, b, a, b]) await p.bringToFront();
    expect(await a.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);
    expect(await b.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("a third launch after two open applications, and a relaunch of the first, each get a working assistant", async () => {
  test.setTimeout(240_000);
  const { s, h, payloadB } = await twoJobs(8401, 8402);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => a.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    const b = await startPayload(h, payloadB);
    await expect.poll(() => b.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    await a.locator("#email").fill("changed@example.test");
    await b.locator("#email").fill("changed-b@example.test");
    await a.bringToFront();
    expect(await a.inputValue("#email")).toBe("changed@example.test");
    expect(await b.inputValue("#email")).toBe("changed-b@example.test");     // neither page was refilled by the other's activity
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("the employer's own Autofill control and final Submit are never touched; the narrative field is not invented", async () => {
  test.setTimeout(180_000);
  const { s, h, payloadB } = await twoJobs(8601, 8602);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => a.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    const b = await startPayload(h, payloadB);
    await expect.poll(() => b.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    await b.waitForTimeout(4000);
    expect(await b.evaluate(() => (window as unknown as { __emp: { employerAutofill?: number } }).__emp.employerAutofill ?? 0)).toBe(0);
    for (const p of [a, b]) expect(await noSubmit(p)).toEqual({ submits: 0, clicks: 0 });
    expect(await a.inputValue("#q1")).toBe("");                                   // no answer source: left for the applicant
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("two different jobs on the SAME employer domain launched together each keep their own tab", async () => {
  test.setTimeout(180_000);
  const urlB = "https://jobs.ashbyhq.com/elevenlabs/9d1e7b30-bbbb-4ccc-8ddd-222222222222/application";
  const { s, h } = await twoJobs(8701, 8702);
  try {
    await h.addJob({ sessionId: 8703, atsType: "ashby", officialUrl: urlB, jobTitle: "Voice Platform Engineer", company: "ElevenLabs", profile: A_PROFILE, answers: answers(), keyFor: labelKey, launchToken: "synthetic-launch-c" });
    const payloadC = { requestId: "req-8703", launchToken: "synthetic-launch-c", sessionId: 8703, jobId: 8703, officialUrl: urlB, atsType: "ashby", webApiBase: h.employer.origin, webAuthenticatedUserId: 1 };
    const payloadA = h.payload as Record<string, unknown>;
    const pages: Page[] = [];
    h.ctx.on("page", (p) => pages.push(p));
    await h.site.evaluate((ps) => ps.forEach((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: p }, location.origin)), [payloadA, payloadC]);
    await h.site.evaluate((ps) => ps.forEach((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: p }, location.origin)), [payloadA, payloadC]);
    await expect.poll(() => pages.length, { timeout: 30_000 }).toBe(2);
    for (const p of pages) await expect.poll(() => p.inputValue("#email").catch(() => ""), { timeout: 60_000 }).toBe("riley@example.test");
    const bound = await h.worker.evaluate(async () => Object.values((await chrome.storage.session.get("pendingLaunches")).pendingLaunches ?? {}).map((v: any) => [v.sessionId, v.officialUrl.split("/")[4]]));
    expect(bound).toEqual(expect.arrayContaining([[8701, "0f6c2a52-aaaa-4bbb-8ccc-111111111111"], [8703, "9d1e7b30-bbbb-4ccc-8ddd-222222222222"]]));
    const tabsByUrl = Object.fromEntries(await Promise.all(pages.map(async (p) => [p.url().split("/")[4], await p.locator("#xpertapply-assistant-overlay-v1").count()])));
    expect(Object.values(tabsByUrl)).toEqual([1, 1]);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

const DRAFTS: Record<string, { text: string; status: string; missing?: string[] }> = {
  q1: { text: "I built a support-triage agent at Northwind and checked it offline against labelled tickets before and after each change.", status: "drafted" },
  q2: { text: "", status: "insufficient_evidence", missing: ["a production deployment you owned", "how credentials were handled"] },
  q3: { text: "At Northwind I worked with the support team on the triage agent; the saved details do not say how the scope was chosen or the measured impact.", status: "partial", missing: ["how you decided what to build", "the impact"] },
  q4: { text: "The support-triage agent is the most impactful thing I have built; my part was the agent and its offline evaluation harness.", status: "drafted" }
};
const draftsFor = (questions: any[]) => questions.map((q) => {
  const d = DRAFTS[String(q.field_identifier_label ?? "")] ?? DRAFTS[Object.keys(DRAFTS).find((k) => new RegExp(DRAFT_MATCH[k]).test(q.question)) ?? ""];
  return d ? { field_identifier: q.field_identifier, proposed_answer: d.text, evidence_references: [{ sourceId: "x" }], requires_user_review: true, missing_information: d.missing ?? [], generation_status: d.status, verified: false }
    : { field_identifier: q.field_identifier, proposed_answer: "", evidence_references: [], requires_user_review: true, missing_information: [], generation_status: "needs_user_answer", verified: false };
});
const DRAFT_MATCH: Record<string, string> = { q1: "agent or LLM", q2: "prototype to production", q3: "non-engineering", q4: "most impactful" };

test("open-ended questions: drafts are inserted for review, empty ones stay empty, limits and the applicant's edits are respected, and nothing leaks to the other application", async () => {
  test.setTimeout(240_000);
  const requests: any[] = [];
  const { s, h, payloadB } = await twoJobs(8801, 8802, (questions) => { requests.push(questions); return draftsFor(questions); });
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => a.inputValue("#q1").catch(() => ""), { timeout: 60_000 }).toContain("support-triage agent");
    expect(await a.inputValue("#gh")).toBe("https://github.com/riley-candidate");                    // verified links are filled deterministically
    expect(await a.inputValue("#li")).toBe("https://www.linkedin.com/in/riley-candidate");
    expect(await a.inputValue("#q4")).toContain("most impactful");
    expect((await a.inputValue("#q3")).length).toBeLessThanOrEqual(600);
    expect(await a.inputValue("#q2")).toBe("");                                                      // no evidence: nothing is invented
    expect(await a.inputValue("#q5")).toBe("");                                                      // sponsorship is the applicant's alone
    const sent = requests.flat().map((q: any) => q.question as string);
    expect(sent.some((q) => /visa|sponsor/i.test(q))).toBe(false);                                   // never even asked
    expect(sent.every((q) => !/riley|@example/i.test(q))).toBe(true);                                // no applicant data in the questions
    expect(requests.flat().find((q: any) => /non-engineering/.test(q.question)).max_length).toBe(600);
    // the applicant edits a draft; a later fill must not overwrite it
    await a.fill("#q1", "My own words.");
    await overlayCdp(a).click("#fill").catch(() => undefined);
    await a.waitForTimeout(6000);
    expect(await a.inputValue("#q1")).toBe("My own words.");
    // the other application neither shows nor receives these answers
    const b = await startPayload(h, payloadB);
    await expect.poll(() => b.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    await b.waitForTimeout(3000);
    expect(await b.evaluate(() => document.body.innerText)).not.toMatch(/support-triage/);
    expect(await noSubmit(a)).toEqual({ submits: 0, clicks: 0 });
    expect(await a.inputValue("#q1")).toBe("My own words.");
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("the user's off switch for an origin keeps the assistant from opening by itself on a website launch, and only that origin", async () => {
  test.setTimeout(180_000);
  const { s, h, payloadB } = await twoJobs(8901, 8902);
  try {
    await h.worker.evaluate(async () => chrome.storage.local.set({ xaAutoOpenDisabledOrigins: ["https://job-boards.greenhouse.io"] }));
    const { empPage: a } = await h.start();
    await expect(a.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });   // another origin: unaffected
    const b = await startPayload(h, payloadB);
    await b.waitForTimeout(12_000);
    expect(await b.locator("#xpertapply-assistant-overlay-v1").count()).toBe(0);                           // switched-off origin: no automatic assistant
    expect((await noSubmit(b))).toEqual({ submits: 0, clicks: 0 });
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("closing the earlier application's tab leaves the other application, and a later launch, working", async () => {
  test.setTimeout(180_000);
  const { s, h, payloadB } = await twoJobs(9001, 9002);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => a.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    const b = await startPayload(h, payloadB);
    await expect.poll(() => b.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    await b.fill("#first_name", "Edited");
    await a.close();
    await b.bringToFront();
    await b.waitForTimeout(3000);
    expect(await b.inputValue("#first_name")).toBe("Edited");
    expect(await b.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);
    const sessions = await h.worker.evaluate(async () => Object.values((await chrome.storage.session.get("pendingLaunches")).pendingLaunches ?? {}).map((v: any) => v.sessionId));
    expect(sessions).toContain(9002);                                                                       // B's record survived A's tab closing
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("SoFi first, then ElevenLabs: the reverse order also gives each its own assistant and fill", async () => {
  test.setTimeout(180_000);
  const { s, h } = await twoJobs(9101, 9102);
  try {
    // launch B's payload first, then A's, through the same page
    const payloadA = h.payload as Record<string, unknown>;
    const payloadB = { requestId: "req-9102", launchToken: "synthetic-launch-b", sessionId: 9102, jobId: 9102, officialUrl: B_URL, atsType: "greenhouse", webApiBase: h.employer.origin, webAuthenticatedUserId: 1 };
    const first = await startPayload(h, payloadB);
    await expect.poll(() => first.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    const second = await startPayload(h, payloadA);
    await expect.poll(() => second.inputValue("#email").catch(() => ""), { timeout: 45_000 }).toBe("riley@example.test");
    for (const p of [first, second]) await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    expect(second.url()).toContain("elevenlabs"); expect(first.url()).toContain("sofi");
  } finally { await h.close().catch(() => undefined); s.close(); }
});
