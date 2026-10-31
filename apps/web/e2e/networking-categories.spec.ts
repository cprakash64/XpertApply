import { expect, test, type Page, type Route } from "@playwright/test";
import { injectAxe } from "./support/axe";

/**
 * Networking categories and work-email states, end to end against a mocked API.
 *
 * Every person, address and provider answer here is synthetic. These specs prove
 * how the screen behaves for each documented response; they are not evidence
 * that a real provider account works.
 */

const API = process.env.API_BASE_URL ?? "http://localhost:8000";
const JOB_ID = 731;

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function person(id: number, name: string, title: string, category: string, extra: Record<string, unknown> = {}) {
  return {
    recommendation_id: id,
    full_name: name,
    current_title: title,
    current_company: "Acme AI",
    category,
    category_label: category,
    relevance_score: 80,
    confidence: "high",
    current_employment_confidence: 0.95,
    employment_validation_status: "confirmed_exact_company_verified",
    employment_last_verified_at: daysAgo(1),
    employment_warning: null,
    email_lookup_allowed: true,
    reasons: ["Currently listed by a professional data source at the hiring company."],
    limitations: ["Responsibility for this specific opening has not been confirmed."],
    last_checked_at: daysAgo(1),
    professional_profile_url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, "-")}`,
    email_status: "not_requested",
    professional_email: null,
    email_verified_at: null,
    saved: false,
    contacted: false,
    ...extra
  };
}

const MANAGERS = [
  person(1, "Morgan Manager", "Director of Machine Learning", "potential_hiring_manager"),
  person(2, "Maya Manager", "Engineering Manager, ML Platform", "potential_hiring_manager")
];
const RECRUITERS: ReturnType<typeof person>[] = [];
const REFERRERS = [person(3, "Pat Referrer", "Machine Learning Engineer", "potential_referrer")];

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
  posted_at: daysAgo(1),
  discovered_at: daysAgo(1),
  application_url: "https://job-boards.greenhouse.io/acme/jobs/provider-9981",
  source_url: "https://job-boards.greenhouse.io/acme/jobs/provider-9981",
  description_clean: "Build production machine-learning systems.",
  required_skills: ["Python"],
  preferred_skills: [],
  responsibilities: ["Ship reliable models."],
  match: {
    fit_score: 92,
    fit_label: "Strong fit",
    score_state: "scored",
    match_reasons: ["Your production Python experience aligns with this role."],
    missing_skills: [],
    risk_factors: [],
    recommended_resume_angle: "Lead with production ML systems.",
    confidence: 0.9,
    explanation_source: "deterministic"
  }
};

type EmailAnswer = { status: number; body: Record<string, unknown> };

async function json(route: Route, body: object, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function setup(
  page: Page,
  options: {
    theme?: "light" | "dark";
    width?: number;
    height?: number;
    categories?: { hiring: unknown[]; recruiters: unknown[]; referrers: unknown[] };
    emailAnswers?: EmailAnswer[];
  } = {}
) {
  const emailCalls: string[] = [];
  const answers = [...(options.emailAnswers ?? [])];
  const categories = options.categories ?? { hiring: MANAGERS, recruiters: RECRUITERS, referrers: REFERRERS };
  const theme = options.theme ?? "light";
  await page.addInitScript(
    ([mode]) => {
      localStorage.setItem("jobpilot_token", "synthetic-e2e-token");
      localStorage.setItem("xa-theme", mode);
    },
    [theme]
  );
  await page.setViewportSize({ width: options.width ?? 1280, height: options.height ?? 900 });
  await page.context().route("https://www.linkedin.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>Provider profile</title>" })
  );
  await page.route(`${API}/jobs**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/jobs") {
      return json(route, {
        profile_complete: true,
        criteria: { role_queries: [], skills: [], seniority_targets: [] },
        profile_filters: { target_roles: [], target_levels: [], preferred_locations: [], work_preference: "remote" },
        jobs: [JOB]
      });
    }
    if (url.pathname.startsWith("/jobs/tracker/")) return json(route, { applications: [] });
    if (request.method() === "POST" && /^\/jobs\/\d+\/people\/\d+\/email$/.test(url.pathname)) {
      emailCalls.push(url.pathname);
      const next = answers.shift();
      if (!next) return json(route, { status: "provider_unavailable", professional_email: null, verified_at: null });
      return json(route, next.body, next.status);
    }
    if (url.pathname === `/jobs/${JOB_ID}/people`) {
      return json(route, {
        status: "complete",
        availability_reason: "available",
        beta: true,
        categories: {
          likely_recruiters: categories.recruiters,
          potential_hiring_managers: categories.hiring,
          potential_referrers: categories.referrers
        },
        warnings: [],
        controls: { email_discovery: true, outreach_drafting: true }
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto("/jobs");
  await page.getByTestId("job-card").first().click({ position: { x: 60, y: 12 } });
  await page.getByRole("tab", { name: "Networking" }).click();
  await expect(page.getByRole("tablist", { name: "Contact category" })).toBeVisible();
  return { emailCalls };
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}\\b`) });

test("three categories show counts, the right people, one employer and a helpful empty state", async ({ page }) => {
  await setup(page);
  // The role's likely owner comes first, and counts come from the response.
  await expect(tab(page, "Hiring Managers")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Hiring Managers")).toContainText("2");
  await expect(tab(page, "Recruiters")).toContainText("0");
  await expect(tab(page, "Referral Candidates")).toContainText("1");
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText("Morgan Manager")).toBeVisible();
  await expect(panel.getByText("Maya Manager")).toBeVisible();
  await expect(panel.getByText("Pat Referrer")).toHaveCount(0);
  await expect(panel.getByText("Acme AI")).toHaveCount(2);
  await expect(panel.getByText(/Responsibility for this specific opening has not been confirmed/)).toHaveCount(2);

  await tab(page, "Recruiters").click();
  await expect(page.getByText(/No recruiters were found at this employer/)).toBeVisible();
  await expect(page.getByText("Morgan Manager")).toHaveCount(0);

  await tab(page, "Referral Candidates").click();
  await expect(page.getByRole("tabpanel").getByText("Pat Referrer")).toBeVisible();
});

test("tabs follow the keyboard pattern: arrows, Home and End, one tab stop", async ({ page }) => {
  await setup(page);
  await tab(page, "Hiring Managers").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Recruiters")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Referral Candidates")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Hiring Managers")).toBeFocused();
  await page.keyboard.press("End");
  await expect(tab(page, "Referral Candidates")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tab(page, "Hiring Managers")).toBeFocused();
  await expect(page.getByRole("tablist", { name: "Contact category" }).locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
});

test("every email state is distinct, retries are one click each, and a usage limit offers none", async ({ page }) => {
  const { emailCalls } = await setup(page, {
    emailAnswers: [
      { status: 200, body: { status: "rate_limited", professional_email: null, verified_at: null } },
      { status: 200, body: { status: "budget_exceeded", professional_email: null, verified_at: null } }
    ]
  });
  const card = page.getByRole("tabpanel").locator("article").first();
  await card.getByRole("button", { name: "Find work email" }).click();
  await expect(card.getByText(/rate limit has been reached/)).toBeVisible();
  // Nothing retries on its own.
  await page.waitForTimeout(500);
  expect(emailCalls).toHaveLength(1);

  await card.getByRole("button", { name: "Retry work email" }).click();
  await expect(card.getByText(/daily limit was reached/)).toBeVisible();
  await expect(card.getByRole("button", { name: /work email/i })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(emailCalls).toHaveLength(2);
});

test("verified, stored not-found and service-problem answers read differently", async ({ page }) => {
  const { emailCalls } = await setup(page, {
    emailAnswers: [
      { status: 200, body: { status: "verified", professional_email: "morgan.manager@acme.example", verified_at: daysAgo(0) } },
      { status: 200, body: { status: "not_found", professional_email: null, verified_at: daysAgo(3), cached: true } }
    ]
  });
  const cards = page.getByRole("tabpanel").locator("article");
  await cards.nth(0).getByRole("button", { name: "Find work email" }).click();
  await expect(cards.nth(0).getByText(/Deliverable work email: morgan\.manager@acme\.example/)).toBeVisible();
  await cards.nth(1).getByRole("button", { name: "Find work email" }).click();
  await expect(cards.nth(1).getByText(/No work email was found when last checked on/)).toBeVisible();
  await expect(cards.nth(1).getByRole("button", { name: /work email/i })).toHaveCount(0);
  expect(emailCalls).toHaveLength(2);
});

test("a rejected request or a credential failure never shows an address", async ({ page }) => {
  await setup(page, {
    emailAnswers: [
      { status: 404, body: { detail: "Not found" } },
      { status: 200, body: { status: "provider_error", professional_email: null, verified_at: null } }
    ]
  });
  const card = page.getByRole("tabpanel").locator("article").first();
  await card.getByRole("button", { name: "Find work email" }).click();
  await expect(page.getByText(/Deliverable work email/)).toHaveCount(0);
  await expect(card.getByRole("button", { name: /work email/i })).toBeVisible();
  await card.getByRole("button", { name: /work email/i }).click();
  await expect(card.getByText(/service problem/)).toBeVisible();
  await expect(page.getByText(/Deliverable work email/)).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 }
  ]) {
    test(`Networking has no axe violations (${theme}, ${viewport.name}) in every tab`, async ({ page }) => {
      await setup(page, {
        theme,
        width: viewport.width,
        height: viewport.height,
        emailAnswers: [{ status: 200, body: { status: "rate_limited", professional_email: null, verified_at: null } }]
      });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await injectAxe(page);
      const run = () =>
        page.evaluate(async () => {
          const tablist = document.querySelector('[role="tablist"][aria-label="Contact category"]');
          let scope: Element | null = tablist;
          while (scope && !scope.querySelector('[role="tabpanel"]')) scope = scope.parentElement;
          // @ts-expect-error axe is injected above
          const result = await window.axe.run(scope ?? document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] }
          });
          return result.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} x${v.nodes.length}`);
        });
      expect(await run()).toEqual([]);
      await page.getByRole("tabpanel").locator("article").first().getByRole("button", { name: "Find work email" }).click();
      await expect(page.getByText(/rate limit has been reached/)).toBeVisible();
      expect(await run()).toEqual([]);
      await tab(page, "Recruiters").click();
      expect(await run()).toEqual([]);
      await tab(page, "Referral Candidates").click();
      expect(await run()).toEqual([]);
    });
  }
}
