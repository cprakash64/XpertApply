import { expect, test, type Page } from "@playwright/test";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";
import { site } from "./employer-site";
import { ANSWERS, HOST, PROFILE, fixture, keyFor } from "./workday-shared";
import { clickWidget, emp, startReady } from "./workday-driver";
import { overlayCdp } from "./overlay-cdp";

/**
 * EXT-LIVE-09 adversarial tests. The employer page can read and write its own sessionStorage and DOM; these tests act as that page (and as a
 * stale document) against the real extension in real Chromium, on owned Workday-shaped fixtures. "Zero writes" means: no Next click, no field
 * written by XpertApply, no navigation, no submit. They exercise realistic page-script powers only: a page cannot call chrome.runtime.
 */
const WP = (n: number) => `/en-US/Careers/job/Phoenix/Engineer_JR${n}/apply/applyManually`;
const wurl = (n: number) => `https://${HOST}${WP(n)}`;
const KEY = "xpertapply.workflow.v1";

async function setup(sid: number, cfg: Record<string, unknown> = {}, delayResolveMs = 0) {
  const s = await site({ [WP(1)]: () => ({ body: fixture({ name: "sec1", noLegal: true, ...cfg }) }), [WP(2)]: () => ({ body: fixture({ name: "sec2", noLegal: true, ...cfg }) }) }, [HOST]);
  const h = await launchFromWebsite({
    html: "<!doctype html><title>u</title>", sessionId: sid, atsType: "workday", officialUrl: wurl(1), launchArgs: s.args,
    profile: { ...PROFILE, first_name: "Riley" }, answers: ANSWERS.map((x) => (x.canonical_key === "first_name" ? answer("first_name", "Riley") : x)), keyFor,
    jobTitle: "Engineer One", company: "Acme", location: "Phoenix, AZ, United States"
  });
  if (delayResolveMs > 0) {
    // Slow the question resolver so a fill response is still in flight when the document changes.
    await h.employer.route(`**/application-sessions/${sid}/resolve-questions`, async (r: any) => { await new Promise((res) => setTimeout(res, delayResolveMs)); await r.fallback(); });
  }
  return { s, h };
}
const tabIdOf = (h: Awaited<ReturnType<typeof launchFromWebsite>>) => h.worker.evaluate(async (host) => (await chrome.tabs.query({})).find((t) => (t.url ?? "").includes(host))!.id as number, HOST);
const first = (p: Page) => p.inputValue("#fn").catch(() => "(none)");
const startRun = async (p: Page) => { const ov = overlayCdp(p); await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true); await clickWidget(ov, "start"); return ov; };
/** What a hostile page could write: a run record shaped exactly like the extension's, with every identifier it can learn or guess. */
const forge = (p: Page, rec: Record<string, unknown>) => p.evaluate(([k, r]) => sessionStorage.setItem(k as string, JSON.stringify(r)), [KEY, rec]);
const baseRecord = (tabId: number, sid: number) => ({ runId: "run-forged", mode: "application", origin: `https://${HOST}`, applicationKey: String(sid), accountKey: "", tabKey: String(tabId), jobKey: `workday:${HOST}/phoenix/engineer_jr1`,
  state: "DETECTING", startedAt: Date.now(), stepsSeen: 0, advances: 0, advancedFrom: [], awaitingChangeFrom: null, pausedAt: null, advancedAt: null, lastSignature: null, reason: null, paused: false });

test("S1 a page that forges a perfectly shaped run record (right tab, origin, application, job) cannot make XpertApply click Next", async () => {
  test.setTimeout(240_000);
  const { s, h } = await setup(8501);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    const tabId = await tabIdOf(h);
    await forge(a, baseRecord(tabId, 8501));
    await a.reload();
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    await a.waitForTimeout(25_000);
    const e = await emp(a);
    expect(e.clicks.next).toBe(0);
    expect(e.clicks.submit).toBe(0);
    expect(e.visited.at(-1)).toBe("My Information");
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("S2 an OLD genuine run record replayed after Cancel cannot restart automation", async () => {
  test.setTimeout(300_000);
  const { s, h } = await setup(8502, { nextDelay: 8000 });
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    const ov = await startRun(a);
    await expect.poll(async () => await a.evaluate((k) => sessionStorage.getItem(k), KEY), { timeout: 60_000 }).not.toBeNull();
    const saved = await a.evaluate((k) => sessionStorage.getItem(k), KEY);
    await clickWidget(ov, "cancel");
    await a.waitForTimeout(1500);
    const nextAtCancel = (await emp(a)).clicks.next;
    await a.evaluate(([k, v]) => sessionStorage.setItem(k as string, v as string), [KEY, saved]);   // replay the earlier, running record
    await a.reload();
    await a.waitForTimeout(30_000);
    expect((await emp(a)).clicks.next).toBeLessThanOrEqual(nextAtCancel + 1);                    // at most the click already in flight at Cancel
    const after = (await emp(a)).clicks.next;
    await a.waitForTimeout(8_000);
    expect((await emp(a)).clicks.next).toBe(after);
    expect((await emp(a)).clicks.submit).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("S3 wrong claimed tab id, wrong claimed job, wrong application: each forged record is ignored", async () => {
  test.setTimeout(300_000);
  const { s, h } = await setup(8503);
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    const tabId = await tabIdOf(h);
    for (const patch of [{ tabKey: String(tabId + 7) }, { jobKey: "workday:other/job" }, { applicationKey: "999999" }, { origin: "https://evil.example" }]) {
      await forge(a, { ...baseRecord(tabId, 8503), ...patch });
      await a.reload();
      await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
      await a.waitForTimeout(8_000);
      expect((await emp(a)).clicks.next).toBe(0);
    }
    expect((await emp(a)).clicks.submit).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("S4 the account behind the session changes mid-run (worker-held account key altered): the run stops advancing", async () => {
  test.setTimeout(300_000);
  const { s, h } = await setup(8504, { nextDelay: 6000 });
  try {
    const { empPage: a } = await h.start();
    await expect.poll(() => first(a), { timeout: 60_000 }).toBe("Riley");
    await startRun(a);
    await expect.poll(async () => (await emp(a)).clicks.next, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);
    // The signed-in account changes: the package the worker holds for the tab now belongs to another user.
    await h.worker.evaluate(async () => {
      const st = await chrome.storage.session.get("sessionPackages");
      for (const pkg of Object.values(st.sessionPackages ?? {}) as any[]) pkg.session.authenticatedUserId = 424242;
      await chrome.storage.session.set({ sessionPackages: st.sessionPackages });
    });
    const frozen = (await emp(a)).clicks.next;
    await a.waitForTimeout(40_000);
    expect((await emp(a)).clicks.next).toBeLessThanOrEqual(frozen + 1);
    expect((await emp(a)).visited.at(-1)).not.toBe("Review");
    expect((await emp(a)).clicks.submit).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("S5 a fill response delayed until the tab shows a DIFFERENT job writes nothing into the new job", async () => {
  test.setTimeout(300_000);
  const { s, h } = await setup(8505, {}, 9000);
  try {
    const { empPage: a } = await h.start();
    await a.waitForTimeout(1500);                                    // the resolver call is now in flight, held for 9 s
    await a.evaluate((p) => { history.pushState({}, "", p); document.querySelectorAll<HTMLInputElement>("input").forEach((i) => { i.value = ""; }); }, WP(2));
    await a.waitForTimeout(25_000);                                  // the old response lands after the move
    expect(await first(a)).toBe("");
    expect((await emp(a)).clicks.next).toBe(0);
    expect((await emp(a)).clicks.submit).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});
