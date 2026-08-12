import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Cold-load and hard-refresh integrity for the Jobs workspace.
 *
 * The defect these lock down: while the FIRST jobs request was in flight the
 * workspace rendered its terminal empty state — "0 jobs for you", "No jobs
 * match the current filters", "Click Find fresh jobs" — which is both false and
 * indistinguishable from a broken page. A warm second refresh hid it by making
 * the window too short to see, which is why it kept being reported as
 * "repairs itself after another refresh".
 *
 * Every test here therefore asserts on the FIRST load. A second refresh is
 * never treated as success.
 */

const API = process.env.API_BASE_URL ?? "http://localhost:8000";

function daysAgo(days: number) {
  return new Date(Date.now() - days * 864e5).toISOString();
}

function job(id: number, title: string, company: string, days: number) {
  return {
    id, title, company, company_domain: "", company_logo_url: "", source: "greenhouse",
    location: "Remote, United States", location_display: "Remote", workplace_type: "remote",
    employment_type: "full-time", seniority_level: "mid",
    posted_at: daysAgo(days), discovered_at: daysAgo(days),
    application_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    source_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    description_clean: "Build reliable systems.", required_skills: ["Python"],
    preferred_skills: [], responsibilities: [],
    salary_min: null, salary_max: null, salary_currency: "USD",
    match: {
      fit_score: 88, fit_label: "Strong fit", score_state: "scored", match_reasons: [],
      missing_skills: [], risk_factors: [], recommended_resume_angle: "", confidence: 0.9,
      explanation_source: "deterministic", fit_summary: ""
    }
  };
}

const JOBS = [
  job(1, "Machine Learning Engineer", "Acme AI", 1),
  job(2, "Data Platform Engineer", "Northwind", 2),
  job(3, "Backend Engineer", "Contoso", 3)
];

const PEOPLE = {
  status: "not_started", availability_reason: "available", beta: true,
  quota: { daily_limit: 20, daily_used: 0, daily_remaining: 20, resets_at: "2026-08-05T00:00:00.000Z" },
  categories: { likely_recruiters: [], potential_hiring_managers: [], potential_referrers: [] },
  warnings: [], controls: { email_discovery: true, outreach_drafting: true }
};

async function json(route: Route, body: object, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

type Options = { jobsDelayMs?: number; jobsStatus?: number };

async function install(page: Page, options: Options = {}) {
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "cold-load-token"));
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/jobs") {
      if (options.jobsDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.jobsDelayMs));
      }
      if (options.jobsStatus && options.jobsStatus >= 400) {
        return json(route, { detail: "upstream unavailable" }, options.jobsStatus);
      }
      return json(route, {
        profile_complete: true,
        criteria: { role_queries: [], skills: [], seniority_targets: [] },
        profile_filters: {
          target_roles: [], target_levels: [], preferred_locations: [], work_preference: "remote"
        },
        jobs: JOBS
      });
    }
    if (path.startsWith("/jobs/tracker/")) return json(route, { applications: [] });
    if (path.match(/^\/jobs\/\d+\/people$/)) return json(route, PEOPLE);
    const byId = path.match(/^\/jobs\/(\d+)$/);
    if (byId) {
      const found = JOBS.find((entry) => entry.id === Number(byId[1]));
      return found ? json(route, { job: found }) : json(route, { detail: "not found" }, 404);
    }
    return json(route, {}, 404);
  });
}

/** Text that must NEVER appear while the first request is still in flight. */
const FALSE_EMPTY_COPY = [
  /no jobs match the current filters/i,
  /click .find fresh jobs./i,
  /no fresh jobs matched/i,
  /\b0 jobs for you/i
];

async function assertNoFalseEmptyState(page: Page) {
  const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  for (const pattern of FALSE_EMPTY_COPY) {
    expect(text, `false empty state rendered while loading: ${pattern}`).not.toMatch(pattern);
  }
}

/**
 * The workspace must always render real structure, never an empty shell.
 *
 * Measured as painted content rather than text: a skeleton state is
 * deliberately near-textless, so counting characters would call a correct
 * loading state "blank". What actually matters is that something of real size
 * occupies the main region.
 */
async function assertNotBlank(page: Page) {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return { height: 0, painted: 0, textLength: 0 };
    const painted = Array.from(main.querySelectorAll("*")).filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 40 && box.height > 8;
    }).length;
    return {
      height: (main as HTMLElement).getBoundingClientRect().height,
      painted,
      textLength: (main.textContent ?? "").trim().length
    };
  });
  expect(metrics.height, "main region has no height").toBeGreaterThan(200);
  expect(metrics.painted, "main region painted almost nothing").toBeGreaterThan(10);
}

test.describe("cold load", () => {
  test("plain /jobs shows a skeleton, never a false empty state", async ({ page }) => {
    await install(page, { jobsDelayMs: 2000 });
    await page.goto("/jobs", { waitUntil: "load" });

    await expect(page.getByTestId("job-card-skeleton").first()).toBeVisible();
    await expect(page.getByText("Loading jobs…")).toBeVisible();
    await assertNoFalseEmptyState(page);
    await assertNotBlank(page);

    // …and resolves into the real list without a second refresh.
    await expect(page.getByTestId("job-card")).toHaveCount(3, { timeout: 10_000 });
    await expect(page.getByTestId("job-card-skeleton")).toHaveCount(0);
  });

  test("/jobs?job=<id> shows list and detail skeletons, never a blank workspace", async ({ page }) => {
    await install(page, { jobsDelayMs: 2000 });
    await page.goto("/jobs?job=1", { waitUntil: "load" });

    await expect(page.getByTestId("compact-job-skeleton").first()).toBeVisible();
    await expect(page.getByTestId("job-detail-skeleton")).toBeVisible();
    await assertNoFalseEmptyState(page);
    await assertNotBlank(page);

    await expect(page.getByRole("heading", { level: 1, name: "Machine Learning Engineer" }))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("compact-job-card")).toHaveCount(3);
  });

  test("the job header is visible immediately, with the detail pane at the top", async ({ page }) => {
    await install(page);
    await page.goto("/jobs?job=2", { waitUntil: "load" });

    const heading = page.getByRole("heading", { level: 1, name: "Data Platform Engineer" });
    await expect(heading).toBeVisible();
    await expect(heading).toBeInViewport();

    // No stale scroll restoration hiding the top of the detail pane.
    const scrollTops = await page.evaluate(() =>
      Array.from(document.querySelectorAll("div,section,aside"))
        .filter((el) => el.scrollHeight > el.clientHeight + 4)
        .map((el) => el.scrollTop)
    );
    for (const top of scrollTops) expect(top).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("three repeated cold loads are correct on the FIRST paint each time", async ({ page }) => {
    await install(page);
    for (let pass = 1; pass <= 3; pass++) {
      await page.goto("/jobs?job=1", { waitUntil: "load" });
      await assertNoFalseEmptyState(page);
      await assertNotBlank(page);
      await expect(page.getByRole("heading", { level: 1, name: "Machine Learning Engineer" }))
        .toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("compact-job-card")).toHaveCount(3);
      // Deliberately no second reload: the first load must be correct.
    }
  });

  test("hard reload of a workspace URL is correct on the first attempt", async ({ page }) => {
    await install(page);
    await page.goto("/jobs", { waitUntil: "load" });
    await expect(page.getByTestId("job-card")).toHaveCount(3);
    await page.getByTestId("job-card").first().click({ position: { x: 200, y: 12 } });
    await expect(page).toHaveURL(/\?job=1$/);

    await page.reload({ waitUntil: "load" });
    await assertNoFalseEmptyState(page);
    await assertNotBlank(page);
    await expect(page.getByRole("heading", { level: 1, name: "Machine Learning Engineer" })).toBeVisible();
    await expect(page.getByTestId("compact-job-card")).toHaveCount(3);
  });

  test("the route job id wins over an unrelated persisted selection", async ({ page }) => {
    await install(page);
    // Anything a previous session may have left behind must not override ?job=.
    await page.addInitScript(() => {
      localStorage.setItem("jobpilot_selected_job", "3");
      sessionStorage.setItem("jobpilot_selected_job", "3");
    });
    await page.goto("/jobs?job=2", { waitUntil: "load" });
    await expect(page.getByRole("heading", { level: 1, name: "Data Platform Engineer" })).toBeVisible();
    await expect(page).toHaveURL(/\?job=2$/);
  });

  test("an invalid job id renders an explicit not-available state, not a blank pane", async ({ page }) => {
    await install(page);
    await page.goto("/jobs?job=99999", { waitUntil: "load" });

    await expect(page.getByRole("heading", { name: /this job is not available/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /back to jobs/i })).toBeVisible();
    // The rest of the workspace still works.
    await expect(page.getByTestId("compact-job-card")).toHaveCount(3);
    await assertNotBlank(page);
  });

  test("a failed jobs request shows a retryable error, not an empty list", async ({ page }) => {
    await install(page, { jobsStatus: 503 });
    await page.goto("/jobs", { waitUntil: "load" });

    await expect(page.getByText(/we couldn.t load your jobs/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
    await assertNoFalseEmptyState(page);
    await assertNotBlank(page);
  });

  test("retrying after a failure recovers without a page refresh", async ({ page }) => {
    let failNext = true;
    await page.addInitScript(() => localStorage.setItem("jobpilot_token", "cold-load-token"));
    await page.route(`${API}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/jobs") {
        if (failNext) {
          failNext = false;
          return json(route, { detail: "upstream unavailable" }, 503);
        }
        return json(route, {
          profile_complete: true,
          criteria: { role_queries: [], skills: [], seniority_targets: [] },
          profile_filters: {
            target_roles: [], target_levels: [], preferred_locations: [], work_preference: "remote"
          },
          jobs: JOBS
        });
      }
      if (path.startsWith("/jobs/tracker/")) return json(route, { applications: [] });
      if (path.match(/^\/jobs\/\d+\/people$/)) return json(route, PEOPLE);
      return json(route, {}, 404);
    });

    await page.goto("/jobs", { waitUntil: "load" });
    await page.getByRole("button", { name: /try again/i }).click();
    await expect(page.getByTestId("job-card")).toHaveCount(3);
    await expect(page.getByText(/we couldn.t load your jobs/i)).toHaveCount(0);
  });

  test("no render exception or hydration error on a workspace cold load", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" && /hydrat|Minified React error|Text content does not match/i.test(text)) {
        problems.push(`console: ${text}`);
      }
    });

    await install(page);
    await page.goto("/jobs?job=1", { waitUntil: "load" });
    await expect(page.getByRole("heading", { level: 1, name: "Machine Learning Engineer" })).toBeVisible();
    await page.waitForTimeout(500);

    expect(problems, problems.join("\n")).toEqual([]);
  });
});
