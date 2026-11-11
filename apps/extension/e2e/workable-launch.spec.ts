import { expect, test, type Page } from "@playwright/test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";
import { site } from "./employer-site";
import { overlayCdp } from "./overlay-cdp";
import { workableApplication, type WorkableOptions } from "./workable-fixture";

/**
 * EXT-LIVE-11. The complete WEBSITE + EXTENSION path against an owned Workable-shaped application page: the website's own protocol
 * (stage, then start-assisted-apply) drives the real extension; nothing here clicks the toolbar icon or "Fill application". All
 * applicant data is synthetic. The page is a fixture modelled on a read-only inspection of a public Workable posting; it is not Workable.
 */
const SHARED_DIST = path.resolve("dist-e2e-granted");
const WORKABLE_DIST = path.resolve("dist-e2e-workable");
test.beforeAll(() => {
  // The granted state Chrome is in after the person approves the Workable host (the shared bundle is untouched).
  rmSync(WORKABLE_DIST, { recursive: true, force: true });
  cpSync(SHARED_DIST, WORKABLE_DIST, { recursive: true });
  const file = path.join(WORKABLE_DIST, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.host_permissions = [...new Set([...manifest.host_permissions, "https://apply.workable.com/*"])];
  writeFileSync(file, JSON.stringify(manifest, null, 2));
});

const HOST = "apply.workable.com";
const JOB_X = "/acme-co/j/AAA111BBB2/apply/";
const JOB_Y = "/acme-co/j/CCC333DDD4/apply/";
const who = { first_name: "Riley", last_name: "Candidate", email: "riley.candidate@example.test", phone: "+16025550199" };
const keyFor = (label: string) => {
  const t = label.replace(/^[*\s]+/, "").toLowerCase();
  return /^first name/.test(t) ? "first_name" : /^last name/.test(t) ? "last_name" : /^e-?mail/.test(t) ? "email" : /^phone/.test(t) ? "phone" : null;
};
const answers = Object.entries(who).map(([k, v]) => answer(k, v));
const val = (p: Page, sel: string) => p.inputValue(sel).catch(() => "(none)");
const emp = (p: Page) => p.evaluate(() => (window as unknown as { __emp: { submits: number; clicks: number } }).__emp);

async function open(options: WorkableOptions, documents: { resume?: boolean; coverLetter?: boolean }, sid: number) {
  const s = await site({ [JOB_X]: () => ({ body: workableApplication({ ...options, title: "Job X" }) }), [JOB_Y]: () => ({ body: workableApplication({ ...options, title: "Job Y" }) }) }, [HOST]);
  const h = await launchFromWebsite({
    html: "<!doctype html><title>u</title>", sessionId: sid, atsType: "workable", officialUrl: `https://${HOST}${JOB_X}`, launchArgs: s.args,
    profile: who, answers, keyFor, jobTitle: "Software Engineer", company: "Acme Co", documents, extensionPath: WORKABLE_DIST
  });
  return { s, h };
}

const HOSTS_ALLOWED = new Set(["apply.workable.com", "localhost", "127.0.0.1"]);
const files = (p: Page) => p.evaluate(() => Object.fromEntries([...document.querySelectorAll("input[type=file]")].map((i) => [i.getAttribute("data-ui"), { n: (i as HTMLInputElement).files?.length ?? 0, name: (i as HTMLInputElement).files?.[0]?.name ?? null }])));
const chips = (p: Page) => p.evaluate(() => [...document.querySelectorAll("[data-role=file-name]")].map((c) => c.textContent));
const workableTabs = (h: Awaited<ReturnType<typeof launchFromWebsite>>) => h.ctx.pages().filter((p) => p.url().includes(HOST));
async function startPayload(h: Awaited<ReturnType<typeof launchFromWebsite>>, payload: Record<string, unknown>): Promise<Page> {
  await h.site.evaluate((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: p }, location.origin), payload);
  const [page] = await Promise.all([
    h.ctx.waitForEvent("page", { timeout: 30_000 }),
    h.site.evaluate((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: p }, location.origin), payload)
  ]);
  await page.waitForURL(payload.officialUrl as string);
  return page;
}

test("A-E, I-L, S-U: Apply from the website opens ONE tab, the assistant appears and fills names, email, phone, resume and cover letter with no toolbar click and no Fill click; nothing is submitted", async () => {
  test.setTimeout(240_000);
  const { s, h } = await open({ coverLetter: true }, { resume: true, coverLetter: true }, 9100);
  const hosts = new Set<string>();
  h.ctx.on("request", (r) => { try { hosts.add(new URL(r.url()).hostname); } catch { /* data: urls etc. */ } });
  try {
    const { empPage: p, ack } = await h.start();
    expect(ack.ok).toBe(true);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });      // C: appears by itself
    await expect.poll(() => val(p, "#firstname"), { timeout: 60_000 }).toBe(who.first_name);               // D, E, I
    expect(await val(p, "#lastname")).toBe(who.last_name);
    await expect.poll(() => val(p, "#email"), { timeout: 30_000 }).toBe(who.email);                        // J
    await expect.poll(() => val(p, "#input_phone"), { timeout: 30_000 }).not.toBe("");
    await expect.poll(async () => (await files(p)).resume?.name, { timeout: 60_000 }).toBe("synthetic-resume.pdf");   // K
    await expect.poll(async () => (await files(p)).cover_letter?.name, { timeout: 60_000 }).toBe("synthetic-cover-letter.pdf");   // L
    expect(await chips(p)).toEqual(expect.arrayContaining(["synthetic-resume.pdf", "synthetic-cover-letter.pdf"]));        // the employer UI shows them
    const ov = overlayCdp(p);
    await expect.poll(async () => (await ov.text("#resume")) ?? "", { timeout: 30_000 }).toMatch(/Uploaded/);
    await expect.poll(async () => (await ov.text("#cover")) ?? "", { timeout: 30_000 }).toMatch(/Uploaded/);
    await expect.poll(async () => (await ov.text("#ats")) ?? "").toMatch(/Workable/);                      // not "Generic form"
    expect(workableTabs(h)).toHaveLength(1);                                                               // B, S
    expect(await emp(p)).toMatchObject({ submits: 0, clicks: 0 });                                         // U
    await p.waitForTimeout(3000);
    expect([...hosts].filter((x) => !HOSTS_ALLOWED.has(x))).toEqual([]);                                   // T
    // No privileged tab opened for the launch: only the website, the employer page (and the harness blank).
    expect(h.ctx.pages().map((x) => x.url()).filter((u) => u.startsWith("chrome-extension://"))).toEqual([]);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("a posting with NO upload field says 'not applicable', not 'failed'; user-typed values and unknown required answers are respected (M, N)", async () => {
  test.setTimeout(240_000);
  const { s, h } = await open({ noResumeField: true, questions: true }, { resume: true }, 9110);
  try {
    const { empPage: p } = await h.start();
    await expect(p.locator("#firstname")).toBeVisible({ timeout: 60_000 });
    // N: the person types into the form before/while the assistant works; it is kept.
    await p.fill("#QA_1", "Eight years");
    await expect.poll(() => val(p, "#firstname"), { timeout: 60_000 }).toBe(who.first_name);
    await expect.poll(() => val(p, "#email"), { timeout: 30_000 }).toBe(who.email);
    await p.waitForTimeout(4000);
    expect(await val(p, "#QA_1")).toBe("Eight years");
    // M: the legal radio has no saved answer: nothing is chosen for the person.
    expect(await p.evaluate(() => document.querySelectorAll("input[name=QA_2]:checked").length)).toBe(0);
    const ov = overlayCdp(p);
    await expect.poll(async () => (await ov.text("#resume")) ?? "", { timeout: 60_000 }).toMatch(/No upload field/);
    expect(await emp(p)).toMatchObject({ submits: 0, clicks: 0 });
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("P, Q: two Workable jobs on one origin stay isolated; a reload recovers the same job without a second tab", async () => {
  test.setTimeout(300_000);
  const { s, h } = await open({}, { resume: true }, 9120);
  try {
    await h.addJob({ sessionId: 9121, atsType: "workable", officialUrl: `https://${HOST}${JOB_Y}`, jobTitle: "Job Y", company: "Acme Co", profile: { ...who, first_name: "Morgan" }, answers: [answer("first_name", "Morgan"), answer("last_name", who.last_name), answer("email", "morgan@example.test"), answer("phone", who.phone)], keyFor, launchToken: "synthetic-launch-b", documents: { resume: true } });
    // H: record every access request the worker makes; for an origin that is already granted Chrome shows no dialog and answers true.
    await h.worker.evaluate(() => {
      const g = globalThis as any; g.__asked = [];
      const real = chrome.permissions.request.bind(chrome.permissions);
      (chrome.permissions as any).request = async (req: unknown) => { const granted = await real(req as chrome.permissions.Permissions); g.__asked.push({ req, granted }); return granted; };
    });
    const { empPage: x } = await h.start();
    await expect.poll(() => val(x, "#firstname"), { timeout: 60_000 }).toBe("Riley");
    // Job Y opened by hand in another tab: stays untouched.
    const byHand = await h.ctx.newPage();
    await byHand.goto(`https://${HOST}${JOB_Y}`);
    await byHand.waitForTimeout(12_000);
    expect(await val(byHand, "#firstname")).toBe("");
    // Launching Y explicitly fills Y only.
    const y = await startPayload(h, { requestId: "req-9121", launchToken: "synthetic-launch-b", sessionId: 9121, jobId: 9121, officialUrl: `https://${HOST}${JOB_Y}`, atsType: "workable", webApiBase: h.employer.origin, webAuthenticatedUserId: 1 });
    await expect.poll(() => val(y, "#firstname"), { timeout: 60_000 }).toBe("Morgan");
    expect(await val(x, "#firstname")).toBe("Riley");
    // Q: reload job X: it recovers by itself (idempotent), and there is still one tab for it.
    const before = workableTabs(h).length;
    await x.reload();
    await expect(x.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(() => val(x, "#firstname"), { timeout: 60_000 }).toBe("Riley");
    expect(workableTabs(h)).toHaveLength(before);
    for (const page of [x, y, byHand]) expect((await emp(page)).submits).toBe(0);
    const asked = await h.worker.evaluate(() => (globalThis as any).__asked as { req: { origins: string[] }; granted: boolean }[]);
    expect(asked.length).toBeGreaterThanOrEqual(2);                                                       // one per Apply click
    expect(asked.every((a) => a.granted && a.req.origins.length === 1 && a.req.origins[0] === "https://apply.workable.com/*")).toBe(true);   // H: answered without a dialog
    expect(h.ctx.pages().map((q) => q.url()).filter((u) => u.startsWith("chrome-extension://"))).toEqual([]);
  } finally { await h.close().catch(() => undefined); s.close(); }
});


test("F: an Apply to a Workable host Chrome has not been given asks for EXACTLY that origin once, opens one tab, reads and fills nothing, and a refusal is respected (no second request)", async () => {
  test.setTimeout(240_000);
  // The shared granted bundle does not include apply.workable.com: this is the state before the person has approved it.
  const s = await site({ [JOB_X]: () => ({ body: workableApplication({}) }) }, [HOST]);
  const h = await launchFromWebsite({
    html: "<!doctype html><title>u</title>", sessionId: 9130, atsType: "workable", officialUrl: `https://${HOST}${JOB_X}`, launchArgs: s.args,
    profile: who, answers, keyFor, documents: { resume: true }
  });
  try {
    expect(await h.worker.evaluate(async () => chrome.permissions.contains({ origins: ["https://apply.workable.com/*"] }))).toBe(false);
    await h.worker.evaluate(() => {
      const g = globalThis as any; g.__asked = [];
      (chrome.permissions as any).request = async (req: unknown) => { g.__asked.push(req); return false; };     // Chrome's own dialog: "Deny"
    });
    const { empPage: p, ack } = await h.start();
    expect(ack.ok).toBe(true);
    await p.waitForTimeout(8000);
    expect(await h.worker.evaluate(() => (globalThis as any).__asked)).toEqual([{ origins: ["https://apply.workable.com/*"] }]);
    expect(workableTabs(h)).toHaveLength(1);
    expect(await p.locator("#xpertapply-assistant-overlay-v1").count()).toBe(0);                          // nothing injected before approval
    expect(await val(p, "#firstname")).toBe("");
    const view = await h.worker.evaluate(async () => Object.values(((await chrome.storage.session.get("viewStates")) as any).viewStates ?? {}).map((v: any) => v.siteAccess));
    expect(view).toContain("site_access_denied");                                                        // stated, not "removed"
    expect(view).not.toContain("site_access_revoked");
    expect(h.ctx.pages().map((q) => q.url()).filter((u) => u.startsWith("chrome-extension://"))).toEqual([]);   // no second, redundant request surface
  } finally { await h.close().catch(() => undefined); s.close(); }
});


test("R: the website ending the session (sign-out / account switch) invalidates the launch: a reload of the employer tab is NOT filled with the old account's data, and a new launch works", async () => {
  test.setTimeout(300_000);
  const { s, h } = await open({}, { resume: true }, 9140);
  try {
    const { empPage: x } = await h.start();
    await expect.poll(() => val(x, "#firstname"), { timeout: 60_000 }).toBe("Riley");
    const extId = await h.worker.evaluate(() => chrome.runtime.id);
    const reply = await h.site.evaluate((id) => new Promise((resolve) => {
      (window as any).chrome?.runtime?.sendMessage?.(id, { type: "XPERTAPPLY_EXTERNAL_SESSION_END", reason: "account_changed" }, (r: unknown) => resolve(r ?? "no-reply"));
      setTimeout(() => resolve("no-chrome"), 3000);
    }), extId);
    console.log("SESSION_END_REPLY", JSON.stringify(reply));
    // Authority is gone: the stored launch/package/run are removed, and a reload finds nothing to resume.
    await expect.poll(() => h.worker.evaluate(async () => Object.keys(((await chrome.storage.session.get("pendingLaunches")) as any).pendingLaunches ?? {}).length), { timeout: 20_000 }).toBe(0);
    await x.evaluate(() => { for (const id of ["firstname", "lastname", "email", "input_phone"]) (document.getElementById(id) as HTMLInputElement).value = ""; });
    await x.reload();
    await x.waitForTimeout(12_000);
    expect(await val(x, "#firstname")).toBe("");
    expect(await val(x, "#email")).toBe("");
    expect((await emp(x)).submits).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});


test("S: the website's own retry of the same Apply (same request) never opens a second employer tab", async () => {
  test.setTimeout(240_000);
  const { s, h } = await open({}, { resume: true }, 9150);
  try {
    const { empPage: p } = await h.start();
    await expect.poll(() => val(p, "#firstname"), { timeout: 60_000 }).toBe("Riley");
    // Replay the identical start message twice more (the website retries once on a slow acknowledgement).
    for (let i = 0; i < 2; i++) {
      await h.site.evaluate((payload) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload }, location.origin), h.payload);
    }
    await h.site.waitForTimeout(6000);
    expect(workableTabs(h)).toHaveLength(1);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("O: an email value the employer form rejects is reported as needing the person, not as verified", async () => {
  test.setTimeout(240_000);
  const s = await site({ [JOB_X]: () => ({ body: workableApplication({}) }) }, [HOST]);
  const bad = [answer("first_name", who.first_name), answer("last_name", who.last_name), answer("email", "not-an-email"), answer("phone", who.phone)];
  const h = await launchFromWebsite({
    html: "<!doctype html><title>u</title>", sessionId: 9160, atsType: "workable", officialUrl: `https://${HOST}${JOB_X}`, launchArgs: s.args,
    profile: { ...who, email: "not-an-email" }, answers: bad, keyFor, documents: { resume: true }, extensionPath: WORKABLE_DIST
  });
  try {
    const { empPage: p } = await h.start();
    await expect.poll(() => val(p, "#firstname"), { timeout: 60_000 }).toBe(who.first_name);
    await p.waitForTimeout(8000);
    const ov = overlayCdp(p);
    expect(await p.evaluate(() => [...document.querySelectorAll("[role=alert]:not([hidden])")].map((a) => a.textContent))).toContain("Invalid email");
    expect(Number(await ov.text("#filled"))).toBeLessThan(Number(await ov.text("#discovered")));        // the rejected value is not counted as done
    expect((await ov.text("#stage")) ?? "").toMatch(/review|need/i);
    expect((await ov.text("#summary")) ?? "").toMatch(/still unanswered|not complete/i);
    expect(await emp(p)).toMatchObject({ submits: 0, clicks: 0 });
  } finally { await h.close().catch(() => undefined); s.close(); }
});


test("K2: when the employer form does not visibly accept the file, the résumé is NOT reported as uploaded: it is handed back to attach manually", async () => {
  test.setTimeout(240_000);
  const { s, h } = await open({ silentUpload: true }, { resume: true }, 9170);
  try {
    const { empPage: p } = await h.start();
    await expect.poll(() => val(p, "#firstname"), { timeout: 60_000 }).toBe(who.first_name);
    const ov = overlayCdp(p);
    await expect.poll(async () => (await ov.text("#resume")) ?? "", { timeout: 60_000 }).toMatch(/Attach manually/);
    expect((await ov.text("#resume")) ?? "").not.toMatch(/Uploaded/);
    expect(await emp(p)).toMatchObject({ submits: 0, clicks: 0 });
  } finally { await h.close().catch(() => undefined); s.close(); }
});
