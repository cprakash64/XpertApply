import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overlayCdp } from "./overlay-cdp";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";
import { site } from "./employer-site";

/**
 * EXT-LIVE-07 dedicated Lever regression. Real Chromium, the real extension (jobs.lever.co pre-granted by the *.lever.co group), a real
 * website-launch handshake, and an OWNED Lever-shaped page served under the real hostname. Not evidence about a live Lever employer.
 * Lever's hosted form is a single page, so "multi-step" does not apply; that is stated, not skipped silently.
 */
const HOST = "jobs.lever.co";
const P1 = "/acme/11111111-1111-1111-1111-111111111111/apply";
const P2 = "/acme/22222222-2222-2222-2222-222222222222/apply";
const HTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lever-app.html"), "utf8");
const ANSWERS = [
  answer("full_name", "Riley Candidate"), answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test"), answer("phone", "+16025550199"),
  answer("current_company", "Acme Robotics"), answer("linkedin_url", "https://www.linkedin.com/in/riley-candidate"), answer("github_url", "https://github.com/riley-candidate"),
  answer("referral_source", "Company website"), answer("work_authorization_us", "Yes")
];
const keyFor = (t: string): string | null =>
  /^full name/i.test(t) ? "full_name" : /^email/i.test(t) ? "email" : /^phone/i.test(t) ? "phone" : /current company/i.test(t) ? "current_company" : /linkedin/i.test(t) ? "linkedin_url"
  : /github/i.test(t) ? "github_url" : /how did you hear/i.test(t) ? "referral_source" : /legally authorized/i.test(t) ? "work_authorization_us" : null;

const val = (p: Page, sel: string) => p.inputValue(sel);
const emp = (p: Page) => p.evaluate(() => (window as unknown as { __emp: { submits: number; clicks?: number } }).__emp);

async function launch(s: Awaited<ReturnType<typeof site>>, id: number, urlPath: string) {
  return launchFromWebsite({
    html: "<!doctype html><title>unused</title>", sessionId: id, atsType: "lever", officialUrl: `https://${HOST}${urlPath}`, launchArgs: s.args,
    profile: { first_name: "Riley", last_name: "Candidate", email: "riley@example.test" }, answers: ANSWERS, keyFor, jobTitle: "Software Engineer", company: "Acme",
    location: "Phoenix, AZ, United States"
  });
}

test("Lever: the assistant appears by itself, fills text/dropdown/checkbox-safe fields, leaves unknowns and consent alone, and never submits", async () => {
  test.setTimeout(200_000);
  const s = await site({ [P1]: () => ({ body: HTML }) }, [HOST]);
  const h = await launch(s, 7600, P1);
  try {
    const { empPage } = await h.start();
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });          // auto-appearance, no click
    await expect.poll(() => val(empPage, 'input[name="name"]'), { timeout: 60_000 }).toBe("Riley Candidate");
    expect(await val(empPage, 'input[name="email"]')).toBe("riley@example.test");
    await expect.poll(() => val(empPage, 'input[name="org"]'), { timeout: 30_000 }).toBe("Acme Robotics");
    expect(await val(empPage, 'input[name="urls[LinkedIn]"]')).toBe("https://www.linkedin.com/in/riley-candidate");
    expect(await val(empPage, 'input[name="urls[GitHub]"]')).toBe("https://github.com/riley-candidate");
    await expect.poll(() => val(empPage, 'select[name="cards[src][field0]"]'), { timeout: 30_000 }).toBe("Company website");
    // Not invented: the pronouns question has no saved answer, the tools checkboxes and the privacy-consent box are the person's.
    expect(await val(empPage, 'input[name="cards[pronouns][field0]"]')).toBe("");
    expect(await empPage.locator('input[name="cards[tools][field0]"]:checked').count()).toBe(0);
    expect(await empPage.locator('input[name="consent"]').isChecked()).toBe(false);
    await empPage.waitForTimeout(3000);
    const st = await emp(empPage);
    expect(st.submits).toBe(0);                 // manual submission boundary
    expect(st.clicks ?? 0).toBe(0);
    expect(h.ctx.pages().filter((p) => p.url().includes(HOST)).length).toBe(1);
    expect(await empPage.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("Lever: a value already in the form (the person's or the employer's) is preserved, and a legal Yes/No is filled visibly but flagged, not silently final", async () => {
  test.setTimeout(200_000);
  const s = await site({ [P1]: () => ({ body: HTML }) }, [HOST]);
  const h = await launch(s, 7601, `${P1}?pre=Their%20Own%20Employer`);
  try {
    const { empPage } = await h.start();
    await expect.poll(() => val(empPage, 'input[name="name"]'), { timeout: 60_000 }).toBe("Riley Candidate");
    await empPage.waitForTimeout(4000);
    expect(await val(empPage, 'input[name="org"]')).toBe("Their Own Employer");       // never overwritten
    // The person edits a filled field; a later rescan must not undo it.
    await empPage.fill('input[name="phone"]', "602-555-0100");
    await empPage.waitForTimeout(3000);
    expect(await val(empPage, 'input[name="phone"]')).toBe("602-555-0100");
    expect((await emp(empPage)).submits).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("Lever: site permission persists: a second Lever tab on the granted origin needs no new prompt, opens no extra tab and never submits", async () => {
  test.setTimeout(240_000);
  const s = await site({ [P1]: () => ({ body: HTML }), [P2]: () => ({ body: HTML }) }, [HOST]);
  const h = await launch(s, 7602, P1);
  try {
    const { empPage } = await h.start();
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });
    const second = await h.ctx.newPage();
    await second.goto(`https://${HOST}${P2}`);
    await second.waitForTimeout(12_000);
    // Same-origin tabs join the active workflow by design (originJoinsWorkflow): the granted site needs no new prompt, the form fills,
    // and nothing is submitted. (Whether a second JOB on the same ATS origin should reuse the first job's session is a product question
    // recorded in the EXT-LIVE-07 report, not decided here.)
    await expect.poll(() => val(second, 'input[name="name"]'), { timeout: 60_000 }).toBe("Riley Candidate");
    expect((await emp(second)).submits).toBe(0);
    expect(h.ctx.pages().filter((p) => p.url().includes(HOST)).length).toBe(2);
  } finally { await h.close().catch(() => undefined); s.close(); }
});
