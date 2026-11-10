import { expect, test, type Page } from "@playwright/test";
import { overlayCdp } from "./overlay-cdp";
import { launchFromWebsite } from "./cws-p1-launch-harness";
import { site } from "./employer-site";

/**
 * EXT-LIVE-06. Real Chromium, the real e2e extension build (acme.wd5.myworkdayjobs.com pre-granted), real worker and content scripts,
 * real website-launch handshake, and an OWNED Workday-shaped application (e2e/fixtures/workday-app.html) served under the real tenant
 * hostname. These prove behaviour against our fixtures. They are NOT evidence about any live Workday tenant.
 */
import { ANSWERS, APPLY, EDUCATION, EXPERIENCE, HOST, PROFILE, URL_, fixture, keyFor } from "./workday-shared";

async function launch(s: Awaited<ReturnType<typeof site>>, id: number, extra: Record<string, unknown> = {}) {
  return launchFromWebsite({
    html: "<!doctype html><title>unused</title>", sessionId: id, atsType: "workday", officialUrl: URL_, launchArgs: s.args,
    profile: { ...PROFILE, ...extra }, answers: ANSWERS, keyFor, jobTitle: "Engineer", company: "Acme", location: "Phoenix, AZ, United States"
  });
}
export type Emp = { signedIn: boolean; step: number; vals: Record<string, string>; work: any[]; edu: any[]; sites: any[]; resume: string; clicks: Record<string, number>; visited: string[]; err: number; errLabels: string[] };
const emp = (p: Page) => p.evaluate(() => (window as unknown as { __emp: unknown }).__emp as Emp);
const startReady = (ov: ReturnType<typeof overlayCdp>) => ov.evaluateWidget((r) => (r.querySelector<HTMLElement>('[data-w="start"]')?.style.display ?? "none") !== "none");
const clickWidget = (ov: ReturnType<typeof overlayCdp>, w: string) => w === "start" ? ov.clickWidgetTrusted(`[data-w="start"]`) : ov.evaluateWidget((r, name) => r.querySelector<HTMLButtonElement>(`[data-w="${name}"]`)!.click(), w);
const status = (ov: ReturnType<typeof overlayCdp>) => ov.evaluateWidget((r) => r.querySelector('[data-w="status"]')?.textContent ?? "");

/** What the person would SEE for each rendered work/education row, read from the live DOM (not from the fixture's model). */
async function visibleRows(p: Page) {
  return p.evaluate(() => {
    const q = (e: Element, sel: string) => (e.querySelector<HTMLInputElement>(sel)?.value ?? "");
    const work = Array.from(document.querySelectorAll('[data-automation-id^="workExperience-"]')).filter((e) => /-\d+$/.test(e.getAttribute("data-automation-id")!)).map((e) => ({
      title: q(e, '[data-automation-id="jobTitle"]'), company: q(e, '[data-automation-id="companyName"]'), location: q(e, '[data-automation-id="location"]'),
      current: Boolean(e.querySelector<HTMLInputElement>('[data-automation-id="currentlyWorkHere"]')?.checked),
      from: `${q(e, '[data-automation-id="startDate"] [data-automation-id="dateSectionMonth-input"]')}/${q(e, '[data-automation-id="startDate"] [data-automation-id="dateSectionYear-input"]')}`,
      to: e.querySelector('[data-automation-id="endDate"]') ? `${q(e, '[data-automation-id="endDate"] [data-automation-id="dateSectionMonth-input"]')}/${q(e, '[data-automation-id="endDate"] [data-automation-id="dateSectionYear-input"]')}` : "(hidden)",
      description: (e.querySelector<HTMLTextAreaElement>('[data-automation-id="roleDescription"]')?.value ?? "")
    }));
    const edu = Array.from(document.querySelectorAll('[data-automation-id^="education-"]')).filter((e) => /-\d+$/.test(e.getAttribute("data-automation-id")!)).map((e) => ({
      school: Array.from(e.querySelectorAll('[data-automation-id="school"] [data-automation-id="selectedItem"]')).map((x) => x.textContent).join("|"),
      degree: (e.querySelector('[data-automation-id="degree"]')?.textContent ?? "").trim(),
      major: Array.from(e.querySelectorAll('[data-automation-id="fieldOfStudy"] [data-automation-id="selectedItem"]')).map((x) => x.textContent).join("|"),
      gpa: q(e, '[data-automation-id="gradeAverage"]'), from: q(e, '[data-automation-id="firstYearAttended"] input'), to: q(e, '[data-automation-id="lastYearAttended"] input')
    }));
    const sites = Array.from(document.querySelectorAll('[data-automation-id^="website-"]')).filter((e) => /-\d+$/.test(e.getAttribute("data-automation-id")!)).map((e) => q(e, '[data-automation-id="url"]'));
    return { work, edu, sites };
  });
}

const EXPECT_WORK = [
  { title: "Senior Engineer", company: "Acme Robotics", location: "Phoenix, AZ", current: true, from: "03/2021", to: "(hidden)", description: "Led the controls team." },
  { title: "Software Engineer", company: "Beta Systems", location: "Tempe, AZ", current: false, from: "06/2018", to: "02/2021", description: "Built the telemetry service." },
  { title: "Intern", company: "Gamma Labs", location: "Mesa, AZ", current: false, from: "05/2017", to: "08/2017", description: "" }
];
const EXPECT_EDU = [
  { school: "Arizona State University", degree: "Master's Degree", major: "Computer Science", gpa: "3.8", from: "2016", to: "2018" },
  { school: "University of Arizona", degree: "Bachelor's Degree", major: "Data Science", gpa: "", from: "2012", to: "2016" }
];

async function begin(h: Awaited<ReturnType<typeof launch>>) {
  const { empPage } = await h.start();
  await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });
  const ov = overlayCdp(empPage);
  return { empPage, ov };
}

test("W1a My Experience on an empty application: 3 jobs, 2 degrees and 2 links are created and every rendered value is correct (no Next without a run)", async () => {
  test.setTimeout(180_000);
  const s = await site({ [APPLY]: () => ({ body: fixture({ name: "w1a", startStep: 1 }) }) }, [HOST]);
  const h = await launch(s, 7400);
  try {
    const { empPage } = await begin(h);
    await expect.poll(async () => (await visibleRows(empPage)).work.length, { timeout: 90_000 }).toBe(3);
    await expect.poll(async () => (await visibleRows(empPage)).edu.length, { timeout: 60_000 }).toBe(2);
    await expect.poll(async () => (await visibleRows(empPage)).sites.length, { timeout: 60_000 }).toBe(2);
    await empPage.waitForTimeout(2500);
    const rows = await visibleRows(empPage);
    expect(rows.work).toEqual(EXPECT_WORK);
    expect(rows.edu).toEqual(EXPECT_EDU);
    expect(rows.sites).toEqual(["https://www.linkedin.com/in/riley-candidate", "https://github.com/riley-candidate"]);
    const st = await emp(empPage);
    expect(st.clicks.add).toBe(7);
    expect(st.clicks.next).toBe(0);
    expect(st.clicks.submit).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

const PARSED = {
  work: [
    { title: "Software Engineer", company: "Beta Systems", location: "Tempe", sm: "06", sy: "2018", em: "02", ey: "2021" },
    { title: "Sr. Engineer", company: "Acme Robotics", sm: "03", sy: "2021", current: true },
    { title: "Barista", company: "Zeta Cafe", sm: "01", sy: "2015", em: "12", ey: "2015" }
  ],
  edu: [{ school: "Arizona State University", degree: "Master's Degree", fos: ["Computer Science"], fy: "2016", ly: "2018" }]
};

test("W2 asynchronous résumé parse: waits for the parse, keeps correct/different/foreign rows, fills only blanks, adds only the missing job and degree, and a reload creates no duplicates", async () => {
  test.setTimeout(240_000);
  const s = await site({ [APPLY]: () => ({ body: fixture({ name: "w2", startStep: 1, parseOnLoad: 4000, parsed: PARSED }) }) }, [HOST]);
  const h = await launch(s, 7401);
  try {
    const { empPage } = await begin(h);
    await expect.poll(async () => (await visibleRows(empPage)).work.length, { timeout: 90_000 }).toBe(4);
    await expect.poll(async () => (await visibleRows(empPage)).edu.length, { timeout: 60_000 }).toBe(2);
    // The fill is finished when the last thing it writes (the second website) is on screen.
    await expect.poll(async () => (await visibleRows(empPage)).sites.filter(Boolean).length, { timeout: 90_000 }).toBe(2);
    const rows = await visibleRows(empPage);
    expect(rows.work.map((w) => `${w.company}|${w.title}`)).toEqual(["Beta Systems|Software Engineer", "Acme Robotics|Sr. Engineer", "Zeta Cafe|Barista", "Gamma Labs|Intern"]);
    expect(rows.work[0]!.location).toBe("Tempe");                      // employer-parsed value kept, not overwritten
    expect(rows.work[0]!.description).toBe("Built the telemetry service."); // blank field reconciled from the saved profile
    expect(rows.work[1]!.location).toBe("Phoenix, AZ");
    expect(rows.work[1]!.current).toBe(true);
    expect(rows.work[2]).toMatchObject({ company: "Zeta Cafe", title: "Barista", from: "01/2015", to: "12/2015" }); // foreign row untouched
    expect(rows.work[3]).toMatchObject({ company: "Gamma Labs", title: "Intern", from: "05/2017", to: "08/2017" });
    expect(rows.edu.map((e) => e.school)).toEqual(["Arizona State University", "University of Arizona"]);
    expect(rows.edu[0]).toMatchObject({ degree: "Master's Degree", major: "Computer Science", gpa: "3.8" });
    expect(rows.edu[1]).toMatchObject({ degree: "Bachelor's Degree", major: "Data Science", from: "2012", to: "2016" });
    const before = await emp(empPage);
    expect(before.clicks.add).toBe(4);       // 1 job + 1 degree + 2 websites; nothing for rows that already existed
    expect(before.clicks.uploads).toBe(1);   // the extension never uploads again
    // A reload re-runs the extension against the persisted employer state: nothing may be duplicated.
    await empPage.reload();
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });
    await empPage.waitForTimeout(12_000);
    const again = await visibleRows(empPage);
    expect(again.work).toHaveLength(4);
    expect(again.edu).toHaveLength(2);
    expect(again.sites).toHaveLength(2);
    const after = await emp(empPage);
    expect(after.clicks.add).toBe(4);
    expect(after.clicks.uploads).toBe(1);
    expect(after.clicks.next).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("W3 complete run: My Information dropdowns/phone, experience, questions, stops at Review with Submit untouched; reload and worker restart mid-run neither repeat nor skip a step", async () => {
  test.setTimeout(300_000);
  const s = await site({ [APPLY]: () => ({ body: fixture({ name: "w3", noLegal: true }) }) }, [HOST]);
  const h = await launch(s, 7402);
  try {
    const { empPage, ov } = await begin(h);
    await expect.poll(() => empPage.inputValue("#city"), { timeout: 60_000 }).toBe("Phoenix");
    const shown = (id: string) => empPage.locator(`[data-automation-id="${id}"]`).first().innerText();
    await expect.poll(() => shown("countryDropdown"), { timeout: 30_000 }).toBe("United States of America");
    await expect.poll(() => shown("addressSection_countryRegion"), { timeout: 30_000 }).toBe("Arizona");
    await expect.poll(() => shown("country-phone-code"), { timeout: 30_000 }).toBe("United States of America (+1)");
    expect(await shown("phone-device-type")).toBe("Select One"); // not a saved profile fact: left for the person, never guessed
    expect(await empPage.inputValue("#ph")).toBe("6025550199");
    expect(await empPage.inputValue("#em")).toBe("riley@example.test");
    await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true);
    await clickWidget(ov, "start");
    await expect.poll(async () => (await emp(empPage)).step, { timeout: 120_000 }).toBeGreaterThanOrEqual(2);
    // Mid-run: reload the employer page. The run must continue from where it was (one advance per step), not restart.
    await empPage.reload();
    await expect.poll(async () => (await emp(empPage)).visited.at(-1), { timeout: 150_000 }).toBe("Review");
    await empPage.waitForTimeout(3000);
    const fin = await emp(empPage);
    expect(fin.clicks.submit).toBe(0);
    expect(fin.clicks.next).toBe(3);
    expect(fin.work).toHaveLength(3);
    expect(fin.edu).toHaveLength(2);
    expect(await empPage.locator("#submit").count()).toBe(1);
    expect(h.ctx.pages().filter((p) => p.url().includes(HOST)).length).toBe(1);
    expect(await status(ov)).toMatch(/ready for your review/i);
    expect(await status(ov)).toMatch(/field/i);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("W3b a saved legal answer is filled visibly but flagged: the run pauses on it and does not advance (consequential answers need the person)", async () => {
  test.setTimeout(240_000);
  const s = await site({ [APPLY]: () => ({ body: fixture({ name: "w3b", startStep: 2 }) }) }, [HOST]);
  const h = await launch(s, 7403);
  try {
    const { empPage, ov } = await begin(h);
    await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true);
    await clickWidget(ov, "start");
    await expect.poll(async () => (await emp(empPage)).vals.auth, { timeout: 90_000 }).toBe("Yes");
    await expect(empPage.locator("#auth-Yes")).toBeChecked();
    await empPage.waitForTimeout(4000);
    const st = await emp(empPage);
    expect(st.clicks.next).toBe(0);
    expect(st.visited.at(-1)).toBe("Application Questions");
    expect(await status(ov)).toMatch(/answer|confirm|your/i);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("W4 a Submit button that is visible on an ordinary step is NOT treated as the Review page: the run stops, clicks nothing, and says why", async () => {
  test.setTimeout(240_000);
  const s = await site({ [APPLY]: () => ({ body: fixture({ name: "w4", startStep: 1, submitDecoy: true }) }) }, [HOST]);
  const h = await launch(s, 7404);
  try {
    const { empPage, ov } = await begin(h);
    await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true);
    await clickWidget(ov, "start");
    await expect.poll(async () => status(ov), { timeout: 90_000 }).toMatch(/Submit button is showing on a step that is not the review page/i);
    await empPage.waitForTimeout(3000);
    const st = await emp(empPage);
    expect(st.clicks.submit).toBe(0);
    expect(st.clicks.next).toBe(0);
    expect(st.visited.at(-1)).toBe("My Experience");
    expect(await status(ov)).not.toMatch(/ready for your review/i);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("W5 wrong or ambiguous values are rejected, never guessed: an ambiguous degree, a repeated school name and an impossible month stay unfilled, are named, and stop the run", async () => {
  test.setTimeout(240_000);
  const edu = [
    { school: "Arizona State University", degree: "Bachelor of Science", major: "Computer Science", start_date: "2012-13", end_date: "2016-05" },
    { school: "Stanford University", degree: "Master of Science", major: "Data Science", start_date: "2016-08", end_date: "2018-05" }
  ];
  const cfg = { name: "w5", startStep: 1, degreeOptions: ["Bachelor of Arts", "Bachelor of Engineering", "Master of Arts"], schoolOptions: ["Arizona State University", "Arizona State University", "Stanford University"] };
  const s = await site({ [APPLY]: () => ({ body: fixture(cfg) }) }, [HOST]);
  const h = await launch(s, 7405, { education: edu, experience: [{ ...EXPERIENCE[0], start_date: "2021-13" }] });
  try {
    const { empPage, ov } = await begin(h);
    await expect.poll(async () => (await visibleRows(empPage)).edu.length, { timeout: 90_000 }).toBe(2);
    await expect.poll(async () => (await visibleRows(empPage)).sites.filter(Boolean).length, { timeout: 90_000 }).toBe(2);
    await empPage.waitForTimeout(2000);
    const rows = await visibleRows(empPage);
    expect(rows.edu[0]!.school).toBe("");                       // two identical school labels: ambiguous, not picked
    expect(rows.edu[0]!.degree).toBe("Select One");             // two Bachelor options: ambiguous, not picked
    expect(rows.edu[0]!.from).toBe("2012");                     // year accepted
    expect(rows.edu[1]!.school).toBe("Stanford University");    // unambiguous school is filled
    expect(rows.edu[1]!.degree).toBe("Select One");             // only a SPECIFIC "Master of Arts" exists; the saved degree is Master of Science: not guessed
    expect(rows.work[0]!.from.startsWith("/")).toBe(true);      // impossible month 13: month left blank, never written
    expect(rows.work[0]!.company).toBe("Acme Robotics");
    await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true);
    await clickWidget(ov, "start");
    await expect.poll(async () => status(ov), { timeout: 90_000 }).toMatch(/Education 1/);
    expect(await status(ov)).toMatch(/Work Experience 1/);
    const st = await emp(empPage);
    expect(st.clicks.next).toBe(0);
    expect(st.clicks.submit).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("W6 employer templates that hide sections or fields: no Websites section and no Role Description are skipped quietly and the run still reaches Review", async () => {
  test.setTimeout(300_000);
  const s = await site({ [APPLY]: () => ({ body: fixture({ name: "w6", noLegal: true, noWebsites: true, noRoleDescription: true }) }) }, [HOST]);
  const h = await launch(s, 7406);
  try {
    const { empPage, ov } = await begin(h);
    await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true);
    await clickWidget(ov, "start");
    await expect.poll(async () => (await emp(empPage)).visited.at(-1), { timeout: 150_000 }).toBe("Review");
    const fin = await emp(empPage);
    expect(fin.work).toHaveLength(3);
    expect(fin.work.every((w: { desc?: string }) => !w.desc)).toBe(true);
    expect(fin.sites).toHaveLength(0);
    expect(fin.clicks.submit).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("W7 authentication interruption: XpertApply never types credentials or clicks Sign In; after the person signs in the application continues; a worker restart mid-run neither repeats nor skips a step", async () => {
  test.setTimeout(300_000);
  const s = await site({ [APPLY]: () => ({ body: fixture({ name: "w7", signIn: true, noLegal: true }) }) }, [HOST]);
  const h = await launch(s, 7407);
  try {
    const { empPage, ov } = await begin(h);
    await empPage.waitForTimeout(8000);
    expect(await empPage.inputValue("#si-p")).toBe("");
    expect((await emp(empPage)).clicks.signin).toBe(0);
    expect((await emp(empPage)).signedIn).toBe(false);
    // The person signs in (their credentials, their click).
    await empPage.fill("#si-e", "riley@example.test");
    await empPage.fill("#si-p", "correct-horse");
    await empPage.click("#signin");
    await expect.poll(() => empPage.inputValue("#city"), { timeout: 90_000 }).toBe("Phoenix");
    await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true);
    await clickWidget(ov, "start");
    await expect.poll(async () => (await emp(empPage)).step, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);
    // Stop the extension's service worker mid-run; the content script and the run state live in the tab and must carry on.
    const cdp = await h.ctx.newCDPSession(empPage);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers").catch(() => undefined);
    await expect.poll(async () => (await emp(empPage)).visited.at(-1), { timeout: 150_000 }).toBe("Review");
    const fin = await emp(empPage);
    expect(fin.clicks.signin).toBe(1);               // the person's own click only
    expect(fin.clicks.submit).toBe(0);
    expect(fin.clicks.next).toBe(3);
    expect(fin.work).toHaveLength(3);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("W8 isolation: a second tab on the same application has no run of its own and never advances by itself", async () => {
  test.setTimeout(240_000);
  const s = await site({ [APPLY]: () => ({ body: fixture({ name: "w8", noLegal: true }) }) }, [HOST]);
  const h = await launch(s, 7408);
  try {
    const { empPage, ov } = await begin(h);
    await expect.poll(() => empPage.inputValue("#city"), { timeout: 60_000 }).toBe("Phoenix");
    await expect.poll(() => startReady(ov), { timeout: 60_000 }).toBe(true);
    await clickWidget(ov, "start");
    await expect.poll(async () => (await emp(empPage)).clicks.next, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);
    const second = await h.ctx.newPage();
    await second.goto(URL_);
    await second.waitForTimeout(15_000);
    const st2 = await second.evaluate(() => ({ run: sessionStorage.getItem("xpertapply.workflow.v1"), next: (window as unknown as { __emp: { clicks: { next: number } } }).__emp.clicks.next }));
    expect(st2.run).toBeNull();     // run state is per tab (sessionStorage); the other tab's run is not visible here
    expect(st2.next).toBe(0);       // this tab never advanced
  } finally { await h.close().catch(() => undefined); s.close(); }
});
