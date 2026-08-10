import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * "A successful application moves to Tracker", end to end in a real browser.
 *
 * The API is mocked, but STATEFULLY: the fake backend keeps one application
 * record per (user, job) behind the same uniqueness rule the real one enforces,
 * and its /jobs response excludes jobs that have an applied record. That is what
 * makes the refresh and duplicate-event assertions meaningful — the job stays
 * gone because the server stopped returning it, not because the page hid it.
 */

const API = process.env.API_BASE_URL ?? "http://localhost:8000";

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function job(id: number, title: string, company: string, days: number) {
  return {
    id,
    title,
    company,
    company_domain: "",
    company_logo_url: "",
    source: "greenhouse",
    location: "Remote, United States",
    location_display: "Remote",
    workplace_type: "remote",
    employment_type: "full-time",
    seniority_level: "mid",
    posted_at: daysAgo(days),
    discovered_at: daysAgo(days),
    application_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    source_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    description_clean: "Build reliable data systems.",
    required_skills: ["Python"],
    preferred_skills: [],
    responsibilities: [],
    salary_min: null,
    salary_max: null,
    salary_currency: "USD",
    match: {
      fit_score: 88,
      fit_label: "Strong fit",
      score_state: "scored",
      match_reasons: [],
      missing_skills: [],
      risk_factors: [],
      recommended_resume_angle: "",
      confidence: 0.9,
      explanation_source: "deterministic",
      fit_summary: ""
    }
  };
}

const ALL_JOBS = [
  job(1, "Machine Learning Engineer", "Acme AI", 1),
  job(2, "Data Platform Engineer", "Northwind", 2),
  job(3, "Backend Engineer", "Contoso", 3)
];

const NOT_STARTED_PEOPLE = {
  status: "not_started",
  availability_reason: "available",
  beta: true,
  quota: { daily_limit: 20, daily_used: 0, daily_remaining: 20, resets_at: "2026-08-05T00:00:00.000Z" },
  categories: { likely_recruiters: [], potential_hiring_managers: [], potential_referrers: [] },
  warnings: [],
  controls: { email_discovery: true, outreach_drafting: true }
};

async function json(route: Route, body: object, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

type Application = {
  id: number;
  job_id: number;
  status: string;
  applied_at: string | null;
  applied_source: string | null;
};

/** A stateful stand-in for the application ledger, with the real uniqueness rule. */
function createFakeBackend() {
  const applications = new Map<number, Application>();
  const calls: string[] = [];
  let nextId = 1;

  function markApplied(jobId: number, source: string) {
    const existing = applications.get(jobId);
    if (existing) {
      // Idempotent: the same record, and the original applied_at is kept.
      return { application: existing, created: false, already_applied: true, job_id: jobId };
    }
    const record: Application = {
      id: nextId++,
      job_id: jobId,
      status: "applied",
      applied_at: new Date().toISOString(),
      applied_source: source
    };
    applications.set(jobId, record);
    return { application: record, created: true, already_applied: false, job_id: jobId };
  }

  return { applications, calls, markApplied };
}

async function installApi(page: Page) {
  const backend = createFakeBackend();

  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic-e2e-token"));

  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    backend.calls.push(`${method} ${path}`);

    // Server-side exclusion: a job with an application record is not returned.
    if (method === "GET" && path === "/jobs") {
      return json(route, {
        profile_complete: true,
        criteria: { role_queries: [], skills: [], seniority_targets: [] },
        profile_filters: {
          target_roles: [],
          target_levels: [],
          preferred_locations: [],
          work_preference: "remote"
        },
        jobs: ALL_JOBS.filter((entry) => !backend.applications.has(entry.id))
      });
    }

    if (path === "/jobs/tracker/submitted" || path === "/jobs/tracker/all") {
      return json(route, {
        applications: [...backend.applications.values()].map((application) => ({
          ...application,
          notes: null,
          submission_reference: null,
          opened_at: null,
          application_url: `https://job-boards.greenhouse.io/acme/jobs/${application.job_id}`,
          follow_up_date: null,
          created_at: application.applied_at,
          updated_at: application.applied_at,
          documents: { resume: null, cover_letter: null },
          job: ALL_JOBS.find((entry) => entry.id === application.job_id)
        }))
      });
    }

    const confirm = path.match(/^\/jobs\/(\d+)\/applications\/confirm-applied$/);
    if (confirm && method === "POST") {
      const body = request.postDataJSON() as { confirmed?: boolean };
      if (!body?.confirmed) {
        return json(route, { detail: "confirmation required" }, 422);
      }
      return json(route, backend.markApplied(Number(confirm[1]), "user_confirmed"));
    }

    // The extension's confirmation arrives against the SESSION, which carries
    // the job identity server-side.
    if (path.match(/^\/application-sessions\/\d+\/submission-confirmed$/) && method === "POST") {
      const body = request.postDataJSON() as { evidence_type?: string };
      if (!body?.evidence_type || !["success_page", "success_response", "success_message"].includes(body.evidence_type)) {
        return json(route, { detail: "insufficient evidence" }, 422);
      }
      return json(route, { ok: true, ...backend.markApplied(1, "extension_confirmed") });
    }

    if (path === "/application-sessions" || path.startsWith("/application-sessions/")) {
      return json(route, {
        session_id: 55,
        status: "ready",
        official_application_url: "https://job-boards.greenhouse.io/acme/jobs/1",
        ats_type: "greenhouse",
        job: { id: 1, title: "Machine Learning Engineer", company: "Acme AI", location: "Remote" },
        profile: {},
        resume: { status: "ready", document_id: 1, download_url: "/application-sessions/55/resume" },
        cover_letter: { status: "ready", document_id: 2, download_url: "/application-sessions/55/cover-letter" },
        answers_available: 4,
        review_required_count: 0,
        unresolved_questions: [],
        warnings: [],
        created_at: null,
        expires_at: null,
        completed_at: null,
        extension_launch_token: "launch-token"
      });
    }

    if (path.match(/^\/jobs\/\d+\/people$/)) {
      return json(route, NOT_STARTED_PEOPLE);
    }
    if (path.endsWith("/save")) {
      return json(route, { tracker: { id: 1, job_id: 1, status: "saved" } });
    }
    return json(route, {}, 404);
  });

  return backend;
}

test("an extension-confirmed submission moves the job from Jobs to Tracker", async ({ page }) => {
  const backend = await installApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. The user sees the job in Jobs.
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  await expect(page.getByTestId("job-card")).toHaveCount(3);

  await page.getByTestId("job-card").first().click({ position: { x: 200, y: 12 } });
  await expect(page).toHaveURL(/\?job=1$/);
  await expect(page.getByRole("heading", { level: 1, name: "Machine Learning Engineer" })).toBeVisible();

  // 2. The user opens the external application.
  await page.getByRole("button", { name: /apply on official site/i }).first().click();
  await expect(page.getByRole("dialog", { name: "Assisted application" })).toBeVisible();

  // 3. Opening alone leaves the job in Jobs — nothing was confirmed.
  expect(backend.calls.filter((call) => call.includes("confirm"))).toEqual([]);
  expect(backend.applications.size).toBe(0);
  // Leaving the apply modal (here by reloading, as a user closing the tab would)
  // still leaves all three jobs listed: the server was never told anything.
  await page.reload();
  await expect(page.getByTestId("compact-job-card")).toHaveCount(3);
  expect(backend.applications.size).toBe(0);

  // 4 + 5. A simulated extension confirmation arrives and the backend applies it.
  const confirmed = await page.evaluate(async (api) => {
    const response = await fetch(`${api}/application-sessions/55/submission-confirmed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer session-scoped-token" },
      body: JSON.stringify({
        evidence_type: "success_page",
        confirmation_source: "extension_confirmed",
        submission_timestamp: new Date().toISOString(),
        submission_reference: "ACME-1",
        ats: "greenhouse"
      })
    });
    return response.json();
  }, API);
  expect(confirmed.application.status).toBe("applied");
  expect(confirmed.application.applied_source).toBe("extension_confirmed");
  expect(confirmed.already_applied).toBe(false);

  // 11 (early). A duplicate extension event changes nothing.
  const duplicate = await page.evaluate(async (api) => {
    const response = await fetch(`${api}/application-sessions/55/submission-confirmed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer session-scoped-token" },
      body: JSON.stringify({
        evidence_type: "success_page",
        confirmation_source: "extension_confirmed",
        submission_timestamp: new Date().toISOString(),
        submission_reference: "ACME-1",
        ats: "greenhouse"
      })
    });
    return response.json();
  }, API);
  expect(duplicate.already_applied).toBe(true);
  expect(duplicate.application.id).toBe(confirmed.application.id);
  expect(backend.applications.size).toBe(1);

  // 6 + 12. The job disappears from Jobs on the next load, with no blank screen.
  // The deep link to the now-applied job resolves to an honest message rather
  // than an empty pane, and the surrounding workspace stays fully rendered.
  await page.reload();
  await expect(page.getByTestId("compact-job-card")).toHaveCount(2);
  await expect(page.getByTestId("compact-job-card").first()).toContainText("Data Platform Engineer");
  await expect(page.getByRole("complementary", { name: "Job results" })).toBeVisible();
  await expect(page.getByText(/no longer listed/i)).toBeVisible();

  // 8 + 10. Tracker shows it under Applied, exactly once.
  await page.goto("/tracker");
  await expect(page.getByRole("heading", { name: "Machine Learning Engineer" })).toHaveCount(1);
  await expect(page.getByText(/confirmed by the jobpilot extension/i)).toBeVisible();

  // 9. Back on Jobs after a full navigation, it is still absent.
  await page.goto("/jobs");
  await expect(page.getByTestId("job-card")).toHaveCount(2);
  await expect(page.getByText("Machine Learning Engineer")).toHaveCount(0);
});

test("manual Mark as applied moves the job and selects the next one", async ({ page }) => {
  const backend = await installApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/jobs?job=1");
  await expect(page.getByRole("heading", { level: 1, name: "Machine Learning Engineer" })).toBeVisible();

  // The dialog asks before anything changes.
  await page.getByTestId("mark-applied-action").first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm application submitted" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Did you successfully submit this application?");
  expect(backend.applications.size).toBe(0);

  // Cancelling changes nothing at all.
  await dialog.getByRole("button", { name: /not yet/i }).click();
  await expect(dialog).toBeHidden();
  expect(backend.applications.size).toBe(0);
  await expect(page).toHaveURL(/\?job=1$/);

  // Confirming does.
  await page.getByTestId("mark-applied-action").first().click();
  await page.getByRole("button", { name: /yes, mark as applied/i }).click();

  await expect(page.getByText(/marked as applied and moved to tracker/i)).toBeVisible();
  // 7. The next job is selected, and the URL follows it.
  await expect(page).toHaveURL(/\?job=2$/);
  await expect(page.getByRole("heading", { level: 1, name: "Data Platform Engineer" })).toBeVisible();
  await expect(page.getByTestId("compact-job-card")).toHaveCount(2);

  expect(backend.applications.get(1)?.applied_source).toBe("user_confirmed");

  // The Tracker holds exactly one record for it.
  await page.goto("/tracker");
  await expect(page.getByRole("heading", { name: "Machine Learning Engineer" })).toHaveCount(1);
  await expect(page.getByText(/you marked this as applied/i)).toBeVisible();
});

test("the last remaining job leaves an intentional empty state", async ({ page }) => {
  const backend = await installApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Apply to the first two so only one is left.
  await page.goto("/jobs");
  backend.markApplied(2, "user_confirmed");
  backend.markApplied(3, "user_confirmed");
  await page.goto("/jobs?job=1");
  await expect(page.getByRole("heading", { level: 1, name: "Machine Learning Engineer" })).toBeVisible();

  await page.getByTestId("mark-applied-action").first().click();
  await page.getByRole("button", { name: /yes, mark as applied/i }).click();

  // No job left: the workspace closes, ?job= is dropped, and the empty state is
  // rendered. Never a blank screen and never a stale detail pane.
  await expect(page).toHaveURL(/\/jobs(\?.*)?$/);
  await expect(page).not.toHaveURL(/job=1/);
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  await expect(page.getByTestId("job-card")).toHaveCount(0);
  await expect(page.getByText(/0 jobs for you/i)).toBeVisible();
});

test("a failed confirmation rolls the workspace back", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic-e2e-token"));
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === "GET" && path === "/jobs") {
      return json(route, {
        profile_complete: true,
        criteria: { role_queries: [], skills: [], seniority_targets: [] },
        profile_filters: { target_roles: [], target_levels: [], preferred_locations: [], work_preference: "remote" },
        jobs: ALL_JOBS
      });
    }
    if (path.startsWith("/jobs/tracker/")) {
      return json(route, { applications: [] });
    }
    if (path.endsWith("/applications/confirm-applied")) {
      return json(route, { detail: "database unavailable" }, 503);
    }
    if (path.match(/^\/jobs\/\d+\/people$/)) {
      return json(route, NOT_STARTED_PEOPLE);
    }
    return json(route, {}, 404);
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/jobs?job=1");
  await expect(page.getByRole("heading", { level: 1, name: "Machine Learning Engineer" })).toBeVisible();

  await page.getByTestId("mark-applied-action").first().click();
  await page.getByRole("button", { name: /yes, mark as applied/i }).click();

  // The failure is reported honestly, inside the dialog that is still open.
  // (Scoped to the dialog: Next renders its own role="alert" route announcer.)
  const failureDialog = page.getByRole("dialog", { name: "Confirm application submitted" });
  await expect(failureDialog.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/marked as applied and moved to tracker/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\?job=1$/);
  await expect(page.getByRole("heading", { level: 1, name: "Machine Learning Engineer" })).toBeVisible();
  await expect(page.getByTestId("compact-job-card")).toHaveCount(3);
});
