import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Release-candidate regressions for three responsive defects found in review:
 *  A. the marketing hamburger sat beside the logo instead of at the bar's right edge;
 *  B. job cards were very tall on phones (fit badge stacked on its own block);
 *  C. the tracker's "Word" download button wrapped under "Download resume" at ~1024px.
 * The API is mocked with synthetic data; only layout is asserted.
 */
const json = (route: Route, body: object) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

const job = (id: number, title: string) => ({
  id, title, company: "Acme AI", company_domain: "", company_logo_url: "", source: "greenhouse",
  location: "Remote, United States", location_display: "Remote", workplace_type: "remote", employment_type: "full-time",
  seniority_level: "mid", posted_at: ago(1), discovered_at: ago(1), application_url: "https://example.test/x",
  source_url: "https://example.test/x", description_clean: "Build systems.", required_skills: ["Python"],
  preferred_skills: [], responsibilities: [], salary_min: 150000, salary_max: 190000, salary_currency: "USD",
  match: { fit_score: 88, fit_label: "Strong fit", score_state: "scored", match_reasons: ["Your Python experience aligns with this role."],
    missing_skills: [], risk_factors: [], recommended_resume_angle: "", confidence: 0.9, explanation_source: "deterministic", fit_summary: "Strong overlap." }
});
const doc = (path: string) => ({ id: 1, title: "t", created_at: ago(3), prepared_for_application: true, attached_by_extension: false, frozen: true, formats: ["pdf", "docx"], download_path: path });
const application = {
  id: 31, job_id: 7, status: "applied", applied_at: ago(3), applied_source: "user_confirmed", notes: null, submission_reference: null,
  opened_at: null, application_url: "https://example.test/x", follow_up_date: null, created_at: ago(3), updated_at: ago(3),
  documents: { resume: doc("/jobs/tracker/31/documents/resume"), cover_letter: doc("/jobs/tracker/31/documents/cover-letter") },
  job: { id: 7, title: "Senior Machine Learning Engineer", company: "Acme AI", company_domain: "", company_logo_url: "", location: "Remote",
    workplace_type: "remote", employment_type: "full-time", posted_at: ago(4), application_url: "https://example.test/x", match: null }
};

async function mockApi(page: Page) {
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic-rc-token"));
  await page.route((url) => url.port === "8001" || url.port === "8000", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/jobs") {
      return json(route, { profile_complete: true, criteria: { role_queries: [], skills: [], seniority_targets: [] },
        profile_filters: { target_roles: [], target_levels: [], preferred_locations: [], work_preference: "remote" },
        jobs: [job(1, "Machine Learning Engineer")] });
    }
    if (path.startsWith("/jobs/tracker/")) return json(route, { applications: [application] });
    return json(route, {});
  });
}

test("A. mobile menu button sits at the right edge, is a 44px target, and works by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Open menu" });
  const bar = page.locator("header.xa-nav");
  const [t, b] = [await toggle.boundingBox(), await bar.boundingBox()];
  expect(t!.width).toBeGreaterThanOrEqual(44);
  expect(t!.height).toBeGreaterThanOrEqual(44);
  // The button's right edge is within the bar's right padding (~11px) of the bar edge.
  expect(b!.x + b!.width - (t!.x + t!.width)).toBeLessThanOrEqual(16);
  // Not hugging the logo: far from the bar's left half.
  expect(t!.x).toBeGreaterThan(b!.x + b!.width / 2);
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#xa-mobile-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#xa-mobile-menu")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("B. a phone job card is compact: one-row fit badge, Apply spans the width, nothing overflows", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/jobs");
  const card = page.getByTestId("job-card").first();
  await expect(card).toBeVisible();
  const badge = card.locator("[data-fit-tone]").first();
  const [c, bd] = [await card.boundingBox(), await badge.boundingBox()];
  expect(bd!.height).toBeLessThan(48); // was ~90px as a stacked block
  const apply = card.getByRole("button", { name: /Apply on official site/ }).or(card.getByRole("link", { name: /Apply on official site/ }));
  const ab = await apply.first().boundingBox();
  expect(ab!.width).toBeGreaterThan(c!.width * 0.8);
  for (const name of [/Save/, /Resume/, /Cover Letter/, /Find people/]) {
    const box = await card.getByRole("button", { name }).first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);
  }
  console.log(`CARD_HEIGHT_390=${Math.round(c!.height)}`);
  expect(c!.height).toBeLessThan(430);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const width of [768, 900, 1024, 1180]) {
  test(`C. tracker keeps "Download resume" and "Word" on one row at ${width}px`, async ({ page }) => {
    await mockApi(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tracker");
    const resume = page.getByRole("button", { name: /Download resume for/i });
    const word = page.getByRole("button", { name: "Download resume as Word document" });
    await expect(resume).toBeVisible();
    const [r, w] = [await resume.boundingBox(), await word.boundingBox()];
    expect(Math.abs(r!.y - w!.y)).toBeLessThan(4); // same row
    expect(w!.height).toBeLessThan(56); // label not wrapped
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
