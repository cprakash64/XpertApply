import { expect, test, type Route } from "@playwright/test";

/**
 * Two waterfall outcomes, seen from the user's side of the glass.
 *
 * The backend is mocked, so nothing here spends a provider credit. What is
 * asserted is what the tab shows: contacts when *any* provider answered, and a
 * single quiet sentence only when every one of them is unavailable. Which
 * provider failed is never on screen.
 */

const API = process.env.API_BASE_URL ?? "http://localhost:8000";
const JOB_ID = 8801;

function contact(overrides: Record<string, unknown> = {}) {
  return {
    recommendation_id: 1,
    full_name: "Rita Recruiter",
    current_title: "Senior Technical Recruiter",
    current_company: "Acme AI",
    category: "likely_recruiter",
    category_label: "Likely recruiter",
    relevance_score: 88,
    confidence: "high",
    current_employment_confidence: 0.95,
    employment_validation_status: "confirmed_exact_company_verified",
    employment_last_verified_at: "2026-07-25T12:00:00Z",
    employment_warning: null,
    email_lookup_allowed: true,
    reasons: ["Currently listed at the hiring company."],
    limitations: [],
    last_checked_at: "2026-07-25T12:00:00Z",
    professional_profile_url: "https://www.linkedin.com/in/rita-recruiter",
    email_status: "not_requested",
    professional_email: null,
    email_verified_at: null,
    saved: false,
    contacted: false,
    ...overrides
  };
}

const JOB = {
  id: JOB_ID,
  title: "Machine Learning Engineer",
  company: "Acme AI",
  company_domain: "acme.example",
  company_logo_url: "",
  source: "greenhouse",
  location: "Remote",
  workplace_type: "remote",
  employment_type: "full-time",
  seniority_level: "mid",
  posted_at: "2026-07-28T12:00:00Z",
  discovered_at: "2026-07-28T12:00:00Z",
  application_url: "https://job-boards.greenhouse.io/acme/8801",
  source_url: "https://job-boards.greenhouse.io/acme/8801",
  description_clean: "Build production ML systems.",
  required_skills: ["Python"],
  preferred_skills: [],
  responsibilities: ["Ship models."],
  match: {
    fit_score: 90,
    fit_label: "Strong fit",
    score_state: "scored",
    match_reasons: ["Your production Python experience aligns."],
    missing_skills: [],
    risk_factors: [],
    recommended_resume_angle: "Lead with production ML.",
    confidence: 0.9,
    explanation_source: "deterministic"
  }
};

async function json(route: Route, body: object) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

function peoplePayload(overrides: Record<string, unknown> = {}) {
  return {
    status: "complete",
    availability_reason: "available",
    result_freshness: "fresh",
    beta: true,
    generated_at: "2026-07-29T12:00:00Z",
    warnings: [],
    quota: {
      daily_limit: 20,
      daily_used: 8,
      daily_remaining: 12,
      resets_at: "2026-07-31T00:00:00.000Z",
      broadened_search_cost: 1
    },
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
    categories: {
      likely_recruiters: [],
      potential_hiring_managers: [],
      potential_referrers: []
    },
    controls: { email_discovery: true, outreach_drafting: true },
    ...overrides
  };
}

test("a PDL budget stop is invisible when Apollo carries the discovery", async ({ page }) => {
  // PDL is budget-exhausted; Apollo answers with two recruiters and a manager.
  // The waterfall charges one user action for the whole thing.
  let discovered = false;
  let discoveryCalls = 0;
  let quotaRemaining = 12;

  const apolloResults = {
    likely_recruiters: [
      contact(),
      contact({ recommendation_id: 2, full_name: "Sam Sourcer", current_title: "Technical Recruiter" })
    ],
    potential_hiring_managers: [
      contact({
        recommendation_id: 3,
        full_name: "Morgan Manager",
        current_title: "Engineering Manager",
        category: "potential_hiring_manager",
        category_label: "Potential hiring manager"
      })
    ],
    potential_referrers: []
  };

  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic-e2e-token"));
  await page.route(`${API}/jobs**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/jobs/tracker/")) {
      return json(route, { applications: [] });
    }
    if (request.method() === "GET" && url.pathname === "/jobs") {
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
    if (url.pathname === `/jobs/${JOB_ID}/people`) {
      return json(
        route,
        discovered
          ? peoplePayload({
              categories: apolloResults,
              quota: { ...peoplePayload().quota, daily_used: 9, daily_remaining: quotaRemaining }
            })
          : peoplePayload({ status: "not_started" })
      );
    }
    if (url.pathname === `/jobs/${JOB_ID}/people/discover`) {
      discoveryCalls += 1;
      discovered = true;
      // One user unit for one click, however many providers ran behind it.
      quotaRemaining = 11;
      return json(
        route,
        peoplePayload({
          categories: apolloResults,
          quota: { ...peoplePayload().quota, daily_used: 9, daily_remaining: 11 }
        })
      );
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/jobs?job=${JOB_ID}`);
  await page.getByRole("tab", { name: "Networking" }).click();
  await page.getByRole("button", { name: "Find people" }).click();

  // The contacts render normally.
  await expect(page.getByText("Rita Recruiter")).toBeVisible();
  await expect(page.getByText("Sam Sourcer")).toBeVisible();
  await expect(page.getByText("Morgan Manager")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Likely Recruiters" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Potential Hiring Managers" })).toBeVisible();
  // The empty referral category is simply absent.
  await expect(page.getByRole("heading", { name: "Potential Referral Candidates" })).toHaveCount(0);

  // No trace of the upstream PDL budget stop, and no provider named anywhere.
  await expect(page.getByText(/temporarily unavailable/i)).toHaveCount(0);
  await expect(page.getByText(/budget/i)).toHaveCount(0);
  await expect(page.getByText(/PDL|Apollo|OpenAI|Hunter/)).toHaveCount(0);
  // No error is *announced* either. (An empty live region is part of the
  // panel's normal structure; what matters is that it says nothing.)
  const announced = (await page.getByRole("alert").allTextContents()).filter((text) => text.trim());
  expect(announced).toEqual([]);

  // Exactly one user action was spent for the whole waterfall.
  expect(discoveryCalls).toBe(1);
  await page.getByRole("button", { name: "About these results" }).click();
  await expect(page.getByText(/11 of 20 searches left today/)).toBeVisible();
});

test("every provider unavailable shows one concise sentence", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic-e2e-token"));
  await page.route(`${API}/jobs**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/jobs/tracker/")) {
      return json(route, { applications: [] });
    }
    if (request.method() === "GET" && url.pathname === "/jobs") {
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
    if (url.pathname.startsWith(`/jobs/${JOB_ID}/people`)) {
      // Every enabled provider is disabled, spent, or circuit-open.
      return json(
        route,
        peoplePayload({
          status: "provider_unavailable",
          availability_reason: "provider_budget_exceeded",
          retry_eligible: false
        })
      );
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/jobs?job=${JOB_ID}`);
  await page.getByRole("tab", { name: "Networking" }).click();

  await expect(
    page.getByText("People search is temporarily unavailable because provider capacity has been reached.")
  ).toBeVisible();
  // One sentence — not a per-provider breakdown.
  await expect(page.getByText(/PDL|Apollo|OpenAI|Hunter/)).toHaveCount(0);
  await expect(page.getByText(/credit|cache|circuit/i)).toHaveCount(0);
});

test("a public-web candidate renders with conservative wording and no invented contact data", async ({
  page
}) => {
  // The last resort answered: one sourced recruiter, no verified employment,
  // no email, and a profile link only because a retrieved page carried it.
  const webCandidate = contact({
    recommendation_id: 9,
    full_name: "Wren Webfound",
    current_title: "Technical Recruiter",
    employment_validation_status: "exact_company_current_but_unverified_freshness",
    employment_last_verified_at: null,
    employment_warning:
      "Found on a public web page. Current employment has not been independently verified.",
    confidence: "moderate",
    current_employment_confidence: 0.7,
    email_lookup_allowed: false,
    email_status: "not_found",
    reasons: ["Listed as a recruiter on the company's public team page."],
    limitations: ["Recruiting responsibility for this specific opening has not been confirmed."]
  });

  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic-e2e-token"));
  await page.route(`${API}/jobs**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/jobs/tracker/")) {
      return json(route, { applications: [] });
    }
    if (request.method() === "GET" && url.pathname === "/jobs") {
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
    if (url.pathname.startsWith(`/jobs/${JOB_ID}/people`)) {
      return json(
        route,
        peoplePayload({
          categories: {
            likely_recruiters: [webCandidate],
            potential_hiring_managers: [],
            potential_referrers: []
          }
        })
      );
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/jobs?job=${JOB_ID}`);
  await page.getByRole("tab", { name: "Networking" }).click();

  await expect(page.getByText("Wren Webfound")).toBeVisible();
  // Conservative wording, not a verification claim.
  await expect(page.getByText(/has not been independently verified/)).toBeVisible();
  await expect(page.getByText(/employment verified/)).toHaveCount(0);
  // No email was invented: the action is an honest disabled state.
  await expect(page.getByRole("button", { name: /Find work email/ })).toHaveCount(0);
  await expect(page.getByText("No work email was found.")).toBeVisible();
});
