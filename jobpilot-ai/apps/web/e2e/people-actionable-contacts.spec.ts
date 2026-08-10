import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The product rule, checked in a real browser against the running stack:
 * **every rendered contact is actionable.**
 *
 * A contact card exists to do one thing — open the person's LinkedIn profile.
 * A card without that is a dead end, and dead-end cards shipped once already:
 * masked surnames beside a greyed-out "No LinkedIn" button. This spec fails if
 * any of that comes back.
 *
 * The People API is stubbed at the network boundary, so no provider is called
 * and no quota is spent. The stack still has to be up: the point is to check
 * what the real component renders, not what jsdom thinks it renders.
 */

const API = process.env.API_BASE_URL ?? "http://localhost:8000";
const JOB_ID = 4242;

const CONTACT = {
  recommendation_id: 1,
  full_name: "Priya Raghavan",
  current_title: "Senior Technical Recruiter",
  current_company: "Northwind Robotics",
  category: "likely_recruiter",
  category_label: "Likely recruiter",
  relevance_score: 88,
  confidence: "high",
  current_employment_confidence: 0.95,
  employment_validation_status: "confirmed_exact_company_verified",
  employment_last_verified_at: daysAgo(1),
  employment_warning: null,
  email_lookup_allowed: true,
  reasons: ["Currently listed at the hiring company."],
  limitations: [],
  last_checked_at: daysAgo(1),
  professional_profile_url: "https://www.linkedin.com/in/priya-raghavan",
  email_status: "not_requested",
  professional_email: null,
  email_verified_at: null,
  saved: false,
  contacted: false
};

/** Records that must never render, whichever provider produced them. */
const MASKED = {
  ...CONTACT,
  recommendation_id: 2,
  full_name: "Daniel O███████",
  professional_profile_url: "https://www.linkedin.com/in/daniel-o"
};
const LINKLESS = {
  ...CONTACT,
  recommendation_id: 3,
  full_name: "Lena Fischer",
  professional_profile_url: null
};
const OFF_PLATFORM = {
  ...CONTACT,
  recommendation_id: 4,
  full_name: "Ravi Menon",
  professional_profile_url: "https://profiles.invalid/in/ravi-menon"
};

/**
 * Fixture dates must be relative to now.
 *
 * These were hardcoded ("2026-07-25T12:00:00Z"), which passed when written and
 * then silently started failing once more than seven days had elapsed: the Jobs
 * list defaults to "Posted within: past 7 days" and filtered the seeded job out
 * client-side, so the job card never appeared and every test that opens
 * Networking timed out. The page and the People feature were both fine — the
 * fixture had simply aged out. jobs-workspace.spec.ts already does this.
 */
function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const JOB = {
  id: JOB_ID,
  title: "Senior Backend Engineer",
  company: "Northwind Robotics",
  company_domain: "northwindrobotics.example",
  company_logo_url: "",
  source: "greenhouse",
  location: "Remote",
  workplace_type: "remote",
  employment_type: "full-time",
  seniority_level: "senior",
  posted_at: daysAgo(1),
  discovered_at: daysAgo(1),
  application_url: "https://job-boards.greenhouse.io/nw/jobs/1",
  source_url: "https://job-boards.greenhouse.io/nw/jobs/1",
  description_clean: "Build backend services.",
  required_skills: ["Python"],
  preferred_skills: [],
  responsibilities: ["Ship services."],
  match: {
    fit_score: 90,
    fit_label: "Strong fit",
    score_state: "scored",
    match_reasons: ["Backend Python experience aligns."],
    missing_skills: [],
    risk_factors: [],
    recommended_resume_angle: "Lead with backend systems.",
    confidence: 0.9,
    explanation_source: "deterministic"
  }
};

function peoplePayload(contacts: unknown[]) {
  return {
    status: contacts.length ? "complete" : "no_reliable_matches",
    availability_reason: "available",
    result_freshness: "fresh",
    beta: false,
    generated_at: "2026-07-31T12:00:00Z",
    categories: {
      likely_recruiters: contacts,
      potential_hiring_managers: [],
      potential_referrers: []
    },
    warnings: [],
    search_scope: {
      company_scope: "Hiring company only",
      location_filter: "soft",
      parent_company_matches_included: false,
      refresh_eligible: false,
      exact_company_search_completed: true,
      related_company_search_attempted: false,
      broaden_eligible: false,
      broaden_attempted: false
    },
    quota: {
      daily_limit: 20,
      daily_used: 1,
      daily_remaining: 19,
      resets_at: "2026-08-01T00:00:00Z",
      hourly_limit: 10,
      broadened_search_cost: 1
    },
    controls: { email_discovery: true, outreach_drafting: true }
  };
}

async function json(route: Route, body: object) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

async function openNetworking(page: Page) {
  await page
    .getByTestId("job-card")
    .filter({ hasText: JOB.title })
    .first()
    .click({ position: { x: 60, y: 12 } });
  await expect(page.getByRole("heading", { level: 1, name: JOB.title })).toBeVisible();
  await page.getByRole("tab", { name: "Networking" }).click();
}

async function install(page: Page, contacts: unknown[], counters: { posts: number }) {
  await page.addInitScript(() =>
    localStorage.setItem("jobpilot_token", "synthetic-e2e-token")
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.context().route("https://www.linkedin.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Provider profile</title>"
    });
  });
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/profile") return json(route, { full_name: "Sam Candidate" });
    if (path.startsWith("/jobs/tracker/")) return json(route, { applications: [] });
    if (path.match(/^\/jobs\/\d+\/people/)) {
      if (request.method() === "POST") counters.posts += 1;
      return json(route, peoplePayload(contacts));
    }
    if (path.startsWith("/jobs")) {
      return json(route, {
        profile_complete: true,
        criteria: { role_queries: [], skills: [], seniority_targets: [] },
        profile_filters: {
          target_roles: [],
          target_levels: [],
          preferred_locations: [],
          work_preference: "remote"
        },
        jobs: [JOB]
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
}

test.beforeEach(async ({ page }) => {
  const reachable = await page
    .request.get(`${API}/health`, { timeout: 4000 })
    .then((response) => response.ok())
    .catch(() => false);
  test.skip(!reachable, `API not reachable at ${API}; start the stack first`);
});

test("every rendered contact carries a working validated LinkedIn link", async ({ page }) => {
  const counters = { posts: 0 };
  // One good contact, plus three the policy must withhold.
  await install(page, [CONTACT, MASKED, LINKLESS, OFF_PLATFORM], counters);

  await page.goto("/jobs");
  await openNetworking(page);
  await expect(page.getByText("Priya Raghavan")).toBeVisible();

  const linkedInLinks = page.getByRole("link", { name: /LinkedIn/ });
  await expect(linkedInLinks).toHaveCount(1);
  await expect(linkedInLinks.first()).toHaveAttribute(
    "href",
    "https://www.linkedin.com/in/priya-raghavan"
  );
  await expect(linkedInLinks.first()).toHaveAttribute("target", "_blank");
  await expect(linkedInLinks.first()).toHaveAttribute("rel", /noopener/);

  // None of the other three renders, and no masked fragment reaches the DOM.
  for (const withheld of ["Daniel O", "Lena Fischer", "Ravi Menon"]) {
    await expect(page.getByText(withheld, { exact: false })).toHaveCount(0);
  }
  await expect(page.getByText("No LinkedIn")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("███");
});

test("a page of only non-actionable records shows the neutral empty state", async ({ page }) => {
  const counters = { posts: 0 };
  await install(page, [MASKED, LINKLESS, OFF_PLATFORM], counters);

  await page.goto("/jobs");
  await openNetworking(page);

  await expect(
    page.getByText("No verified professional profiles were found for this company yet.")
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /LinkedIn/ })).toHaveCount(0);
  // No provider is ever named to a user.
  for (const vendor of ["Bright Data", "brightdata", "Apollo", "Hunter", "OpenAI"]) {
    await expect(page.locator("body")).not.toContainText(vendor);
  }
});

test("opening and reopening the section spends no quota", async ({ page }) => {
  const counters = { posts: 0 };
  await install(page, [CONTACT], counters);

  await page.goto("/jobs");
  await openNetworking(page);
  await expect(page.getByText("Priya Raghavan")).toBeVisible();

  // Switch away and back: reading stored results is free.
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("tab", { name: "Networking" }).click();
  await expect(page.getByText("Priya Raghavan")).toBeVisible();

  // Only an explicit Find people costs a unit, and nothing here clicked it.
  expect(counters.posts).toBe(0);
});
