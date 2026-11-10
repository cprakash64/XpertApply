import { expect, test } from "@playwright/test";
import { APPLY, HOST, fixture } from "./workday-shared";
import { begin, clickWidget, emp, launch, startReady, status, visibleRows } from "./workday-driver";
import { site } from "./employer-site";

/**
 * EXT-LIVE-07 résumé-parse reconciliation barrier, in real Chromium with the real extension against OWNED asynchronous fixtures.
 * Not evidence about how a live Workday tenant parses résumés.
 */
const BETA = { title: "Software Engineer", company: "Beta Systems", location: "Tempe", sm: "06", sy: "2018", em: "02", ey: "2021" };
const ACME = { title: "Senior Engineer", company: "Acme Robotics", sm: "03", sy: "2021", current: true };
const ASU = { school: "Arizona State University", degree: "Master's Degree", fos: ["Computer Science"], fy: "2016", ly: "2018" };
const sitesDone = async (p: import("@playwright/test").Page) => (await visibleRows(p)).sites.filter(Boolean).length;

async function run(name: string, cfg: Record<string, unknown>, id: number, body: (c: Awaited<ReturnType<typeof begin>> & { h: Awaited<ReturnType<typeof launch>> }) => Promise<void>) {
  const s = await site({ [APPLY]: () => ({ body: fixture({ name, startStep: 1, ...cfg }) }) }, [HOST]);
  const h = await launch(s, id);
  try { const b = await begin(h); await body({ ...b, h }); } finally { await h.close().catch(() => undefined); s.close(); }
}

test("P1 parse finishes early: rows reconciled, only the missing job and degree are added", async () => {
  test.setTimeout(200_000);
  await run("p1", { parseOnLoad: 800, parsed: { work: [BETA, ACME], edu: [ASU] } }, 7500, async ({ empPage }) => {
    await expect.poll(() => sitesDone(empPage), { timeout: 90_000 }).toBe(2);
    const r = await visibleRows(empPage);
    expect(r.work.map((w) => w.company).sort()).toEqual(["Acme Robotics", "Beta Systems", "Gamma Labs"]);
    expect(r.edu.map((e) => e.school)).toEqual(["Arizona State University", "University of Arizona"]);
    expect((await emp(empPage)).clicks.add).toBe(1 + 1 + 2);
  });
});

test("P2 parse finishes late: NOTHING is added while parsing, then only the missing records", async () => {
  test.setTimeout(200_000);
  await run("p2", { parseOnLoad: 12_000, parsed: { work: [BETA, ACME], edu: [ASU] } }, 7501, async ({ empPage }) => {
    await empPage.waitForTimeout(8000);                                  // still parsing
    expect((await emp(empPage)).clicks.add).toBe(0);
    expect((await visibleRows(empPage)).work).toHaveLength(0);
    await expect.poll(() => sitesDone(empPage), { timeout: 120_000 }).toBe(2);
    const r = await visibleRows(empPage);
    expect(r.work).toHaveLength(3);
    expect(r.edu).toHaveLength(2);
    expect((await emp(empPage)).clicks.add).toBe(1 + 1 + 2);
  });
});

test("P3 parse returns partial records: blank fields are completed, nothing is duplicated", async () => {
  test.setTimeout(200_000);
  const partial = [{ company: "Beta Systems", title: "" }, { company: "Acme Robotics", title: "" }];
  await run("p3", { parseOnLoad: 800, parsed: { work: partial, edu: [{ school: "Arizona State University", fos: [] }] } }, 7502, async ({ empPage }) => {
    await expect.poll(() => sitesDone(empPage), { timeout: 90_000 }).toBe(2);
    const r = await visibleRows(empPage);
    expect(r.work).toHaveLength(3);
    expect(r.work.find((w) => w.company === "Beta Systems")).toMatchObject({ title: "Software Engineer", from: "06/2018" });
    expect(r.work.find((w) => w.company === "Acme Robotics")).toMatchObject({ title: "Senior Engineer", from: "03/2021", current: true });
    expect(r.edu).toHaveLength(2);
    expect(r.edu[0]).toMatchObject({ school: "Arizona State University", degree: "Master's Degree" });
  });
});

test("P4 rows trickle in after the spinner clears: the quiet period holds back additions, so nothing is duplicated", async () => {
  test.setTimeout(200_000);
  await run("p4", { parseOnLoad: 800, trickle: true, parsed: { work: [BETA, ACME], edu: [ASU] } }, 7503, async ({ empPage }) => {
    await expect.poll(() => sitesDone(empPage), { timeout: 120_000 }).toBe(2);
    const r = await visibleRows(empPage);
    expect(r.work.map((w) => w.company).sort()).toEqual(["Acme Robotics", "Beta Systems", "Gamma Labs"]);
    expect(r.edu).toHaveLength(2);
  });
});

test("P5 a parse that appends duplicate-like rows after the fill: nothing is deleted or re-added and the person is told", async () => {
  test.setTimeout(240_000);
  await run("p5", { asyncParse: 1500, parseMode: "append", parsed: { work: [BETA], edu: [ASU] } }, 7504, async ({ empPage, ov }) => {
    await expect.poll(() => sitesDone(empPage), { timeout: 90_000 }).toBe(2);
    const added = (await emp(empPage)).clicks.add;
    await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true);
    await clickWidget(ov, "start");
    // The person uploads a résumé AFTER XpertApply filled; the employer's parser then appends its own (duplicate-like) rows.
    await empPage.setInputFiles("#resume-file", { name: "cv.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") });
    await expect.poll(async () => (await visibleRows(empPage)).work.length, { timeout: 60_000 }).toBe(4);
    await expect.poll(() => status(ov), { timeout: 90_000 }).toMatch(/duplicate/i);
    const r = await visibleRows(empPage);
    expect(r.work).toHaveLength(4);                       // 3 ours + 1 parsed: none deleted
    expect(r.edu).toHaveLength(3);
    expect((await emp(empPage)).clicks.add).toBe(added);  // and no new Add clicks
    expect((await emp(empPage)).clicks.next).toBe(0);     // the run did not advance past possible duplicates
  });
});

test("P6 a parse that never settles: the run pauses, adds nothing, and continues once the parse is done", async () => {
  test.setTimeout(240_000);
  await run("p6", { parseOnLoad: 600_000, parsed: { work: [BETA, ACME], edu: [ASU] } }, 7505, async ({ empPage, ov }) => {
    await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true);
    await clickWidget(ov, "start");
    await expect.poll(() => status(ov), { timeout: 90_000 }).toMatch(/parsing/i);
    expect((await emp(empPage)).clicks.add).toBe(0);
    expect((await emp(empPage)).clicks.next).toBe(0);
    // The parse finally completes (the person waited / retried): the run reconciles and goes on to add only what is missing.
    await empPage.evaluate(() => (window as unknown as { finishParse: () => void }).finishParse());
    await expect.poll(() => sitesDone(empPage), { timeout: 120_000 }).toBe(2);
    expect((await visibleRows(empPage)).work).toHaveLength(3);
  });
});

test("P7 reload during parsing, and a row the person edited, are both respected", async () => {
  test.setTimeout(240_000);
  await run("p7", { parseOnLoad: 5000, parsed: { work: [BETA, ACME], edu: [ASU] } }, 7506, async ({ empPage }) => {
    await expect.poll(() => sitesDone(empPage), { timeout: 120_000 }).toBe(2);
    const title = empPage.locator('[data-automation-id="workExperience-2"] [data-automation-id="jobTitle"]');
    await title.fill("Lead Engineer (edited by me)");
    await empPage.waitForTimeout(500);
    await empPage.reload();
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });
    await empPage.waitForTimeout(15_000);
    const r = await visibleRows(empPage);
    expect(r.work).toHaveLength(3);
    expect(r.work.some((w) => w.title === "Lead Engineer (edited by me)")).toBe(true);
    expect((await emp(empPage)).clicks.add).toBe(1 + 1 + 2);
  });
});
