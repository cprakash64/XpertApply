import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../components/AppShell";
import { JobDiscovery } from "../components/JobDiscovery";
import { nextSelectionAfterRemoval } from "../lib/markApplied";

const routerMock = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/jobs",
  useRouter: () => routerMock
}));

/**
 * "Successful application moves to Tracker", from the Jobs workspace.
 *
 * The invariant these tests protect: a job leaves the Jobs list ONLY after the
 * backend has confirmed the application. Opening the employer site does not do
 * it, cancelling the dialog does not do it, and a failed request must put the
 * workspace back exactly as it was.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const NOT_STARTED_PEOPLE = {
  status: "not_started",
  beta: true,
  categories: { likely_recruiters: [], potential_hiring_managers: [], potential_referrers: [] },
  warnings: [],
  quota: { daily_limit: 20, daily_used: 0, daily_remaining: 20, resets_at: "2026-08-05T00:00:00.000Z" },
  controls: { email_discovery: true, outreach_drafting: true }
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Machine Learning Engineer",
    company: "Acme",
    company_domain: "",
    company_logo_url: "",
    source: "greenhouse",
    location: "Remote, United States",
    location_display: "Remote",
    workplace_type: "remote",
    employment_type: "full-time",
    seniority_level: "mid",
    posted_at: isoDaysAgo(1),
    discovered_at: isoDaysAgo(0),
    application_url: "https://job-boards.greenhouse.io/acme/1",
    source_url: "https://job-boards.greenhouse.io/acme/1",
    description_clean: "Build ML systems.",
    required_skills: ["Python"],
    preferred_skills: [],
    responsibilities: [],
    salary_min: null,
    salary_max: null,
    salary_currency: "USD",
    match: {
      fit_score: 90,
      fit_label: "Strong fit",
      score_state: "scored",
      match_reasons: [],
      missing_skills: [],
      risk_factors: [],
      recommended_resume_angle: "",
      confidence: 0.8,
      explanation_source: "deterministic",
      fit_summary: ""
    },
    ...overrides
  };
}

/** What POST /application-sessions really returns — the apply modal reads
 * `resume`/`cover_letter` unconditionally, so a stubbed `{}` would crash it. */
const APPLICATION_SESSION = {
  session_id: 55,
  status: "ready",
  official_application_url: "https://job-boards.greenhouse.io/acme/1",
  ats_type: "greenhouse",
  job: { id: 1, title: "Machine Learning Engineer", company: "Acme", location: "Remote" },
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
};

const THREE_JOBS = [
  job({ id: 1, title: "Machine Learning Engineer", company: "Acme", posted_at: isoDaysAgo(1) }),
  job({ id: 2, title: "Data Platform Engineer", company: "Northwind", posted_at: isoDaysAgo(2) }),
  job({ id: 3, title: "Backend Engineer", company: "Contoso", posted_at: isoDaysAgo(3) })
];

type Options = {
  /** Successive /jobs responses. The last one repeats once exhausted. */
  jobPages?: unknown[][];
  confirmStatus?: number;
  confirmBody?: unknown;
  trackerPages?: unknown[][];
};

function mockApi(options: Options = {}) {
  const calls: string[] = [];
  const jobPages = options.jobPages ?? [THREE_JOBS];
  let jobsIndex = 0;
  const trackerPages = options.trackerPages ?? [[]];
  let trackerIndex = 0;

  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(String(input), "http://localhost:8000");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);

    if (url.pathname === "/jobs") {
      const page = jobPages[Math.min(jobsIndex, jobPages.length - 1)];
      jobsIndex += 1;
      return Promise.resolve(
        jsonResponse({
          profile_complete: true,
          criteria: { role_queries: [], skills: [], seniority_targets: [] },
          profile_filters: {
            target_roles: [],
            target_levels: [],
            preferred_locations: [],
            work_preference: "remote"
          },
          jobs: page
        })
      );
    }
    if (url.pathname.startsWith("/jobs/tracker/")) {
      const page = trackerPages[Math.min(trackerIndex, trackerPages.length - 1)];
      trackerIndex += 1;
      return Promise.resolve(jsonResponse({ applications: page }));
    }
    if (url.pathname.endsWith("/applications/confirm-applied")) {
      const status = options.confirmStatus ?? 200;
      const jobId = Number(url.pathname.split("/")[2]);
      return Promise.resolve(
        jsonResponse(
          options.confirmBody ?? {
            application: {
              id: 10,
              job_id: jobId,
              status: "applied",
              applied_at: "2026-08-04T10:00:00Z",
              applied_source: "user_confirmed",
              submission_reference: null,
              opened_at: null,
              application_url: null,
              notes: null,
              created_at: null,
              updated_at: null
            },
            created: true,
            already_applied: false,
            job_id: jobId
          },
          status
        )
      );
    }
    if (url.pathname === "/application-sessions") {
      return Promise.resolve(jsonResponse(APPLICATION_SESSION, 201));
    }
    if (url.pathname.startsWith("/application-sessions/")) {
      return Promise.resolve(jsonResponse(APPLICATION_SESSION));
    }
    if (url.pathname.match(/^\/jobs\/\d+\/people$/)) {
      return Promise.resolve(jsonResponse(NOT_STARTED_PEOPLE));
    }
    if (url.pathname.match(/^\/jobs\/\d+$/)) {
      return Promise.resolve(jsonResponse({ detail: "Job not found" }, 404));
    }
    return Promise.resolve(jsonResponse({}));
  });

  return {
    fetchMock,
    calls,
    confirmCalls: () => calls.filter((call) => call.includes("confirm-applied"))
  };
}

function renderWorkspace(search = "") {
  window.history.replaceState(null, "", `/jobs${search}`);
  return render(
    <AppShell workspace>
      <JobDiscovery />
    </AppShell>
  );
}

async function openMarkAppliedDialog() {
  await userEvent.click(await screen.findByRole("button", { name: /mark as applied/i }));
  return screen.findByRole("dialog", { name: /confirm application submitted/i });
}

function confirmButton() {
  return screen.getByRole("button", { name: /yes, mark as applied/i });
}

beforeEach(() => {
  window.localStorage.setItem("jobpilot_token", "test-token");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// --------------------------------------------------------------------------- //
// Opening the official site is not applying
// --------------------------------------------------------------------------- //
describe("opening the official application", () => {
  it("does not call confirm-applied", async () => {
    const { confirmCalls } = mockApi();
    renderWorkspace("?job=1");

    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });
    // The panel renders a compact and a large action bar; either opens the same modal.
    await userEvent.click(screen.getAllByRole("button", { name: /apply on official site/i })[0]);

    // The apply modal opens and prepares a session. Nothing confirms anything.
    await waitFor(() => expect(screen.getByRole("dialog", { name: /assisted application/i })).toBeTruthy());
    expect(confirmCalls()).toEqual([]);
  });

  it("leaves the job in the list", async () => {
    mockApi();
    renderWorkspace("?job=1");

    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });
    // The panel renders a compact and a large action bar; either opens the same modal.
    await userEvent.click(screen.getAllByRole("button", { name: /apply on official site/i })[0]);
    await screen.findByRole("dialog", { name: /assisted application/i });

    const list = screen.getByRole("complementary", { name: /job results/i });
    expect(within(list).getByText("Machine Learning Engineer")).toBeTruthy();
  });
});

// --------------------------------------------------------------------------- //
// The confirmation dialog
// --------------------------------------------------------------------------- //
describe("mark as applied confirmation", () => {
  it("asks before changing anything", async () => {
    const { confirmCalls } = mockApi();
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    const dialog = await openMarkAppliedDialog();
    expect(within(dialog).getByText(/did you successfully submit this application\?/i)).toBeTruthy();
    // Asking is not doing.
    expect(confirmCalls()).toEqual([]);
  });

  it("cancelling changes nothing", async () => {
    const { confirmCalls } = mockApi();
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    await openMarkAppliedDialog();
    await userEvent.click(screen.getByRole("button", { name: /not yet/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(confirmCalls()).toEqual([]);
    const list = screen.getByRole("complementary", { name: /job results/i });
    expect(within(list).getByText("Machine Learning Engineer")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("job")).toBe("1");
  });

  it("removes the job, shows the toast, and selects the next job", async () => {
    const { confirmCalls } = mockApi({
      jobPages: [THREE_JOBS, THREE_JOBS.filter((entry) => entry.id !== 1)]
    });
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    await openMarkAppliedDialog();
    await userEvent.click(confirmButton());

    await waitFor(() => expect(confirmCalls()).toEqual(["POST /jobs/1/applications/confirm-applied"]));
    // Next visible job becomes the selection.
    await screen.findByRole("heading", { name: "Data Platform Engineer", level: 1 });
    expect(new URLSearchParams(window.location.search).get("job")).toBe("2");

    const list = screen.getByRole("complementary", { name: /job results/i });
    await waitFor(() => expect(within(list).queryByText("Machine Learning Engineer")).toBeNull());
    expect(await screen.findByText(/marked as applied and moved to tracker/i)).toBeTruthy();
  });

  it("refetches Jobs and the Tracker from the server after success", async () => {
    const { calls } = mockApi({
      jobPages: [THREE_JOBS, THREE_JOBS.filter((entry) => entry.id !== 1)]
    });
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    const before = {
      jobs: calls.filter((call) => call === "GET /jobs").length,
      tracker: calls.filter((call) => call.startsWith("GET /jobs/tracker/")).length
    };

    await openMarkAppliedDialog();
    await userEvent.click(confirmButton());

    // Both caches are invalidated against the server — this is what makes the
    // removal survive a refresh rather than being a local illusion.
    await waitFor(() =>
      expect(calls.filter((call) => call === "GET /jobs").length).toBeGreaterThan(before.jobs)
    );
    await waitFor(() =>
      expect(calls.filter((call) => call.startsWith("GET /jobs/tracker/")).length).toBeGreaterThan(
        before.tracker
      )
    );
  });

  it("selects the previous job when the applied one was last", async () => {
    const { confirmCalls } = mockApi({
      jobPages: [THREE_JOBS, THREE_JOBS.filter((entry) => entry.id !== 3)]
    });
    renderWorkspace("?job=3");
    await screen.findByRole("heading", { name: "Backend Engineer", level: 1 });

    await openMarkAppliedDialog();
    await userEvent.click(confirmButton());

    await waitFor(() => expect(confirmCalls().length).toBe(1));
    await screen.findByRole("heading", { name: "Data Platform Engineer", level: 1 });
    expect(new URLSearchParams(window.location.search).get("job")).toBe("2");
  });

  it("shows an intentional empty state when the last job is applied to", async () => {
    const only = [job({ id: 1, title: "Machine Learning Engineer", company: "Acme" })];
    const { confirmCalls } = mockApi({ jobPages: [only, []] });
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    await openMarkAppliedDialog();
    await userEvent.click(confirmButton());

    await waitFor(() => expect(confirmCalls().length).toBe(1));

    // The workspace closes to the list, ?job= is dropped, and a real empty
    // state is rendered — never a blank screen and never a stale detail pane.
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("job")).toBeNull());
    expect(await screen.findByRole("heading", { name: "Jobs", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Machine Learning Engineer", level: 1 })).toBeNull();
    expect(screen.getByText(/0 jobs for you/i)).toBeTruthy();
  });

  it("never renders a blank workspace during the transition", async () => {
    const { confirmCalls } = mockApi({
      jobPages: [THREE_JOBS, THREE_JOBS.filter((entry) => entry.id !== 1)]
    });
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    await openMarkAppliedDialog();
    await userEvent.click(confirmButton());

    // At every point there is either a job heading or the list view — the
    // previously-observed blank-screen defect would fail here.
    await waitFor(() => expect(confirmCalls().length).toBe(1));
    await waitFor(() => {
      const hasDetail = screen.queryByRole("heading", { level: 1 });
      expect(hasDetail).not.toBeNull();
    });
  });

  it("sends exactly one request for a double-click", async () => {
    const { confirmCalls } = mockApi({
      jobPages: [THREE_JOBS, THREE_JOBS.filter((entry) => entry.id !== 1)]
    });
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    await openMarkAppliedDialog();
    const button = confirmButton();
    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.click(button);

    await waitFor(() => expect(confirmCalls().length).toBe(1));
  });

  it("does not restore the applied job on a later list refresh", async () => {
    // The server stops returning the job once it is applied; a refresh must not
    // bring it back.
    const remaining = THREE_JOBS.filter((entry) => entry.id !== 1);
    const { confirmCalls } = mockApi({ jobPages: [THREE_JOBS, remaining, remaining] });
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    await openMarkAppliedDialog();
    await userEvent.click(confirmButton());
    await waitFor(() => expect(confirmCalls().length).toBe(1));

    const list = await screen.findByRole("complementary", { name: /job results/i });
    await waitFor(() => expect(within(list).queryByText("Machine Learning Engineer")).toBeNull());
    expect(within(list).getByText("Data Platform Engineer")).toBeTruthy();
  });

  it("hides the action for a job that is already applied", async () => {
    mockApi({
      trackerPages: [
        [
          {
            id: 9,
            job_id: 1,
            status: "applied",
            applied_at: "2026-08-01T00:00:00Z",
            job: { id: 1, title: "Machine Learning Engineer", company: "Acme" }
          }
        ]
      ]
    });
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^mark as applied$/i })).toBeNull()
    );
  });
});

// --------------------------------------------------------------------------- //
// Rollback
// --------------------------------------------------------------------------- //
describe("backend failure", () => {
  it("restores the job, the selection, and the URL", async () => {
    mockApi({ confirmStatus: 500, confirmBody: { detail: "boom" } });
    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    await openMarkAppliedDialog();
    await userEvent.click(confirmButton());

    // The dialog stays open and reports the failure honestly.
    const dialog = await screen.findByRole("dialog", { name: /confirm application submitted/i });
    await waitFor(() => expect(within(dialog).getByRole("alert")).toBeTruthy());

    // Nothing may look as though it succeeded.
    expect(screen.queryByText(/marked as applied and moved to tracker/i)).toBeNull();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("job")).toBe("1"));
    const list = screen.getByRole("complementary", { name: /job results/i });
    expect(within(list).getByText("Machine Learning Engineer")).toBeTruthy();
  });

  it("allows a retry after a failure", async () => {
    let attempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(String(input), "http://localhost:8000");
      if (url.pathname === "/jobs") {
        return Promise.resolve(
          jsonResponse({
            profile_complete: true,
            criteria: { role_queries: [], skills: [], seniority_targets: [] },
            profile_filters: {
              target_roles: [],
              target_levels: [],
              preferred_locations: [],
              work_preference: "remote"
            },
            jobs: attempt === 0 ? THREE_JOBS : THREE_JOBS.filter((entry) => entry.id !== 1)
          })
        );
      }
      if (url.pathname.startsWith("/jobs/tracker/")) {
        return Promise.resolve(jsonResponse({ applications: [] }));
      }
      if (url.pathname.endsWith("/applications/confirm-applied")) {
        attempt += 1;
        if (attempt === 1) {
          return Promise.resolve(jsonResponse({ detail: "temporary" }, 503));
        }
        return Promise.resolve(
          jsonResponse({
            application: { id: 10, job_id: 1, status: "applied", applied_at: "2026-08-04T10:00:00Z" },
            created: true,
            already_applied: false,
            job_id: 1
          })
        );
      }
      if (url.pathname.match(/^\/jobs\/\d+\/people$/)) {
        return Promise.resolve(jsonResponse(NOT_STARTED_PEOPLE));
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWorkspace("?job=1");
    await screen.findByRole("heading", { name: "Machine Learning Engineer", level: 1 });

    await openMarkAppliedDialog();
    await userEvent.click(confirmButton());
    await screen.findByRole("alert");

    await userEvent.click(confirmButton());
    expect(await screen.findByText(/marked as applied and moved to tracker/i)).toBeTruthy();
  });
});

// --------------------------------------------------------------------------- //
// Selection rule
// --------------------------------------------------------------------------- //
describe("nextSelectionAfterRemoval", () => {
  const visible = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("prefers the next job", () => {
    expect(nextSelectionAfterRemoval(visible, 2)).toBe(3);
  });

  it("falls back to the previous job for the last entry", () => {
    expect(nextSelectionAfterRemoval(visible, 3)).toBe(2);
  });

  it("returns null when nothing is left", () => {
    expect(nextSelectionAfterRemoval([{ id: 1 }], 1)).toBeNull();
  });

  it("returns null for a job that is not visible", () => {
    expect(nextSelectionAfterRemoval(visible, 99)).toBeNull();
  });
});
