/**
 * The Jobs list is ranked, filtered and paged by the SERVER. These tests use a fake server that honours `sort`, `limit` and
 * `cursor`, and assert what the CLIENT does with it: it asks for exactly what the user chose, renders the server's order
 * verbatim, continues with the server's own cursor, never repeats or reshuffles a job, and stops cleanly at the end.
 * (The ranking maths itself is proved in `apps/api/app/tests/test_job_ranking.py`.)
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobDiscovery } from "../components/JobDiscovery";
import { clearPeopleCache } from "../lib/peopleClient";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const makeJob = (id: number, over: Record<string, unknown> = {}) => ({
  id, title: `Role ${String(id).padStart(3, "0")}`, company: `Company ${id}`, company_domain: "", company_logo_url: "", source: "greenhouse",
  location: "Remote", workplace_type: "remote", employment_type: "full-time", seniority_level: "mid",
  posted_at: new Date(Date.now() - id * 3_600_000).toISOString(), discovered_at: new Date().toISOString(),
  application_url: `https://boards.greenhouse.io/acme/${id}`, source_url: `https://boards.greenhouse.io/acme/${id}`,
  description_clean: "Build systems.", required_skills: ["Python"], preferred_skills: [], responsibilities: [],
  match: { fit_score: 90 - (id % 40), fit_label: "Strong fit", score_state: "scored", match_reasons: [], missing_skills: [], risk_factors: [] },
  ...over
});

type Call = { path: string; params: URLSearchParams };
let calls: Call[];
/** Each sort mode's server order: deliberately NOT what a client-side date or score sort would produce. */
let orders: Record<string, number[]>;
let failCursor: string | null;
let gate: Promise<void> | null;
/** First-page responses held per sort, to make a slow response arrive after a newer one. */
let holdFirst: Partial<Record<string, Promise<void>>>;

function install(total = 60) {
  const all = Array.from({ length: total }, (_, index) => index + 1);
  const rotated = (by: number) => [...all.slice(by), ...all.slice(0, by)];
  orders = { best_recent: rotated(7), fit: rotated(13), newest: rotated(21) };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/jobs/tracker/")) return json({ applications: [] });
    if (url.pathname !== "/jobs") return json({});
    calls.push({ path: url.pathname, params: url.searchParams });
    const sort = url.searchParams.get("sort") ?? "best_recent";
    const limit = Number(url.searchParams.get("limit") ?? total);
    const cursor = url.searchParams.get("cursor");
    if (cursor && cursor === failCursor) {
      failCursor = null;
      return json({ detail: "boom" }, 500);
    }
    if (gate && cursor) await gate;
    if (!cursor && holdFirst[sort]) await holdFirst[sort];
    const start = cursor ? Number(cursor.replace("c:", "")) : 0;
    let ids = orders[sort];
    const workplace = url.searchParams.get("workplace_type");
    const role = url.searchParams.get("role");
    const minFit = Number(url.searchParams.get("min_fit_score") ?? 0);
    ids = ids.filter((id) => {
      const job = makeJob(id, id % 4 === 0 ? { workplace_type: "hybrid" } : {});
      return (!workplace || job.workplace_type === workplace) && (!role || job.title.toLowerCase().includes(role.toLowerCase())) && (job.match.fit_score ?? 0) >= minFit;
    });
    const slice = ids.slice(start, start + limit);
    const more = start + limit < ids.length;
    return json({
      profile_complete: true, criteria: { role_queries: [], skills: [], seniority_targets: [] },
      profile_filters: { target_roles: [], target_levels: [], preferred_locations: [], work_preference: "remote" },
      jobs: slice.map((id) => makeJob(id, id % 4 === 0 ? { workplace_type: "hybrid" } : {})),
      page: { sort, total: ids.length, limit, returned: slice.length, has_more: more, next_cursor: more ? `c:${start + limit}` : null }
    });
  });
}

const titles = () => screen.getAllByTestId("job-card").map((card) => within(card).getByRole("button", { name: /Role \d+/ }).textContent);
const jobsCalls = () => calls.filter((call) => call.path === "/jobs");

beforeEach(() => {
  localStorage.setItem("jobpilot_token", "token");
  window.history.replaceState(null, "", "/jobs");
  clearPeopleCache();
  calls = [];
  failCursor = null;
  gate = null;
  holdFirst = {};
  install();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Jobs list: server ranking and paging", () => {
  it("asks for the default Best & recent order with a page size, and counts the whole result set", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    const first = jobsCalls()[0].params;
    expect(first.get("sort")).toBe("best_recent");
    expect(first.get("limit")).toBe("25");
    expect(first.get("posted_within_days")).toBe("7");
    expect(first.get("cursor")).toBeNull();
    expect(screen.getAllByTestId("job-card")).toHaveLength(25);
    // 25 loaded, 60 match: the count is the server's total, not what has been downloaded.
    expect(screen.getByText("60 jobs for you")).toBeInTheDocument();
  });

  it("renders the server's order verbatim and does not re-sort it", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    const expected = orders.best_recent.slice(0, 25).map((id) => `Role ${String(id).padStart(3, "0")}`);
    expect(titles()).toEqual(expected);
  });

  it("continues with the server's cursor, appends without repeating, and ends cleanly", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    await userEvent.click(screen.getByRole("button", { name: "Show more jobs" }));
    await waitFor(() => expect(screen.getAllByTestId("job-card")).toHaveLength(50));
    expect(jobsCalls()[1].params.get("cursor")).toBe("c:25");
    expect(jobsCalls()[1].params.get("sort")).toBe("best_recent"); // the sort and filters ride along on every page
    await userEvent.click(screen.getByRole("button", { name: "Show more jobs" }));
    await waitFor(() => expect(screen.getAllByTestId("job-card")).toHaveLength(60));
    expect(jobsCalls()[2].params.get("cursor")).toBe("c:50");
    const seen = titles();
    expect(new Set(seen).size).toBe(60);                                                // no duplicates
    expect(seen).toEqual(orders.best_recent.map((id) => `Role ${String(id).padStart(3, "0")}`)); // no gaps, same order as the server
    expect(await screen.findByText(/You’ve reached the end · 60 jobs/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more jobs" })).not.toBeInTheDocument();
    expect(jobsCalls()).toHaveLength(3);                                                 // and it stopped asking
  });

  it("shows a job returned on two pages only once", async () => {
    const original = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    orders.best_recent = [...orders.best_recent.slice(0, 25), orders.best_recent[3], ...orders.best_recent.slice(25)]; // a repeat at the boundary
    void original;
    await userEvent.click(screen.getByRole("button", { name: "Show more jobs" }));
    await waitFor(() => expect(screen.getAllByTestId("job-card").length).toBeGreaterThan(25));
    const seen = titles();
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("changing the sort starts a new server-ranked list from the first page", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    await userEvent.selectOptions(screen.getByLabelText("Sort jobs"), "fit");
    await waitFor(() => expect(jobsCalls().at(-1)!.params.get("sort")).toBe("fit"));
    expect(jobsCalls().at(-1)!.params.get("cursor")).toBeNull();
    await waitFor(() => expect(titles()[0]).toBe(`Role ${String(orders.fit[0]).padStart(3, "0")}`));
    expect(window.location.search).toContain("sort=fit");
    await userEvent.selectOptions(screen.getByLabelText("Sort jobs"), "newest");
    await waitFor(() => expect(jobsCalls().at(-1)!.params.get("sort")).toBe("newest"));
    await userEvent.selectOptions(screen.getByLabelText("Sort jobs"), "best_recent");
    await waitFor(() => expect(jobsCalls().at(-1)!.params.get("sort")).toBe("best_recent"));
    expect(window.location.search).not.toContain("sort=");        // the default is not written to the URL
  });

  it("offers Best & Recent, Best Fit and Newest First, in that order", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    const options = within(screen.getByLabelText("Sort jobs")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Best & Recent", "Best Fit", "Newest First"]);
    expect((screen.getByLabelText("Sort jobs") as HTMLSelectElement).value).toBe("best_recent");
  });

  it("sends every filter to the server and reloads from the first page", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    await userEvent.selectOptions(screen.getByLabelText("Workplace type"), "hybrid");
    await waitFor(() => expect(jobsCalls().at(-1)!.params.get("workplace_type")).toBe("hybrid"));
    await userEvent.selectOptions(screen.getByLabelText("Minimum fit score"), "70");
    await waitFor(() => expect(jobsCalls().at(-1)!.params.get("min_fit_score")).toBe("70"));
    await userEvent.selectOptions(screen.getByLabelText("Posted within days"), "14");
    await waitFor(() => expect(jobsCalls().at(-1)!.params.get("posted_within_days")).toBe("14"));
    const last = jobsCalls().at(-1)!.params;
    expect(last.get("workplace_type")).toBe("hybrid");
    expect(last.get("min_fit_score")).toBe("70");
    expect(last.get("cursor")).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId("job-card").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText(/jobs? for you/).textContent).not.toMatch(/^60 /));   // the total follows the filters
  });

  it("debounces typing into a single request carrying the search as `role`", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    const before = jobsCalls().length;
    await userEvent.type(screen.getByLabelText("Role or skill"), "Role 01");
    await waitFor(() => expect(jobsCalls().at(-1)!.params.get("role")).toBe("Role 01"));
    expect(jobsCalls().length - before).toBe(1);
    await waitFor(() => expect(screen.getAllByTestId("job-card")).toHaveLength(10));      // Role 010..019 and Role 01x
  });

  it("ignores a page that arrives after the filters changed", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    let release: () => void = () => undefined;
    gate = new Promise<void>((resolve) => { release = resolve; });
    await userEvent.click(screen.getByRole("button", { name: "Show more jobs" }));       // page 2 of the OLD list is now held
    await userEvent.selectOptions(screen.getByLabelText("Sort jobs"), "newest");
    await waitFor(() => expect(jobsCalls().at(-1)!.params.get("sort")).toBe("newest"));
    gate = null;
    release();
    await waitFor(() => expect(titles()[0]).toBe(`Role ${String(orders.newest[0]).padStart(3, "0")}`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const seen = titles();
    expect(seen).toEqual(orders.newest.slice(0, 25).map((id) => `Role ${String(id).padStart(3, "0")}`)); // nothing from the old list leaked in
  });

  it("a slow first page for an old filter that arrives AFTER the new filter's page never replaces it", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    let release: () => void = () => undefined;
    holdFirst.fit = new Promise<void>((resolve) => { release = resolve; });
    await userEvent.selectOptions(screen.getByLabelText("Sort jobs"), "fit");            // slow: held
    await userEvent.selectOptions(screen.getByLabelText("Sort jobs"), "newest");         // fast: answers first
    await waitFor(() => expect(titles()[0]).toBe(`Role ${String(orders.newest[0]).padStart(3, "0")}`));
    release();                                                                           // the stale `fit` page lands now
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(titles()).toEqual(orders.newest.slice(0, 25).map((id) => `Role ${String(id).padStart(3, "0")}`));
    expect(screen.queryByText("Could not load more jobs.")).not.toBeInTheDocument();
  });

  it("several quick filter changes end on the last one, and every request carries the filters it was made for", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    await userEvent.selectOptions(screen.getByLabelText("Workplace type"), "remote");
    await userEvent.selectOptions(screen.getByLabelText("Minimum fit score"), "70");
    await userEvent.selectOptions(screen.getByLabelText("Sort jobs"), "fit");
    await userEvent.selectOptions(screen.getByLabelText("Posted within days"), "14");
    await waitFor(() => {
      const last = jobsCalls().at(-1)!.params;
      expect([last.get("workplace_type"), last.get("min_fit_score"), last.get("sort"), last.get("posted_within_days")]).toEqual(["remote", "70", "fit", "14"]);
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const expected = orders.fit.filter((id) => id % 4 !== 0 && (90 - (id % 40)) >= 70).slice(0, 25).map((id) => `Role ${String(id).padStart(3, "0")}`);
    expect(titles()).toEqual(expected);
    expect(jobsCalls().every((call) => !call.params.has("cursor"))).toBe(true);          // no stale cursor was ever reused across filters
  });

  it("a double click on Show more sends exactly one request for the next page", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    const before = jobsCalls().length;
    let release: () => void = () => undefined;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const more = screen.getByRole("button", { name: "Show more jobs" });
    await userEvent.dblClick(more);
    release();
    await waitFor(() => expect(screen.getAllByTestId("job-card")).toHaveLength(50));
    expect(jobsCalls().length - before).toBe(1);
    expect(new Set(titles()).size).toBe(50);                                              // and nothing repeated
  });

  it("a failed page shows a retry that continues from the same cursor", async () => {
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    failCursor = "c:25";
    await userEvent.click(screen.getByRole("button", { name: "Show more jobs" }));
    expect(await screen.findByText("Could not load more jobs.")).toBeInTheDocument();
    expect(screen.getAllByTestId("job-card")).toHaveLength(25);                          // what was loaded stays
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getAllByTestId("job-card")).toHaveLength(50));
    expect(jobsCalls().at(-1)!.params.get("cursor")).toBe("c:25");
  });

  it("falls back to the legacy full list when the API returns no page block", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/jobs/tracker/")) return json({ applications: [] });
      return json({ profile_complete: true, criteria: {}, profile_filters: {}, jobs: [makeJob(1), makeJob(2)] });
    });
    render(React.createElement(JobDiscovery));
    expect(await screen.findAllByTestId("job-card")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Show more jobs" })).not.toBeInTheDocument();
    expect(screen.getByText("2 jobs for you")).toBeInTheDocument();
  });
});
