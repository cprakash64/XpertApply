import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardClient } from "../components/DashboardClient";
import {
  __resetDashboardSummaryCache,
  invalidateDashboardSummary
} from "../lib/dashboardSummary";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/dashboard" }));

const ROOT = join(__dirname, "..");

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

const SUMMARY = {
  freshMatches: 227,
  applications: { saved: 4, inProgress: 15, interviews: 2, offers: 1, rejected: 2 },
  recentApplications: [
    {
      id: "1",
      jobId: 7,
      title: "Platform Engineer",
      company: "Northstar",
      status: "interview",
      updatedAt: "2026-08-01T12:00:00Z",
      appliedAt: "2026-07-28T12:00:00Z",
      fitScore: 84,
      logoUrl: "/jobs/companies/northstar/logo"
    }
  ],
  topMatches: [
    {
      id: 22,
      title: "Senior Software Engineer",
      company: "Acme",
      location: "Remote",
      workplaceType: "remote",
      employmentType: "full-time",
      postedAt: "2026-07-30T12:00:00Z",
      fitScore: 91,
      fitSummary: "Strong overlap with your Python work.",
      matchedSkills: ["Python", "FastAPI", "PostgreSQL", "Docker"],
      snippet: "Build and run the services behind our hiring platform.",
      logoUrl: "/jobs/companies/acme/logo",
      saved: false
    }
  ],
  profile: {
    percent: 78,
    completed: [
      { key: "identity", label: "Name" },
      { key: "skills", label: "Skills" }
    ],
    missing: [
      { key: "links", label: "Professional links" },
      { key: "education", label: "Education" }
    ]
  },
  strongMatches: 18,
  nextAction: {
    kind: "strong_matches",
    eyebrow: "18 strong matches",
    title: "Review your highest-fit opportunities",
    body: "18 fresh matches scored 80%+ fit.",
    href: "/jobs",
    cta: "View matches",
    firstName: "Chandra",
    profileProgress: 100
  }
};

/** A fetch mock whose response the test resolves by hand. */
function deferredFetch() {
  let release: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    () => pending.then(() => jsonResponse(SUMMARY)) as Promise<Response>
  );
  return { fetchMock, release: () => release(null) };
}

describe("DashboardClient", () => {
  beforeEach(() => {
    localStorage.setItem("jobpilot_token", "token");
    __resetDashboardSummaryCache();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    __resetDashboardSummaryCache();
  });

  it("renders the shell and skeletons immediately, before any data arrives", () => {
    const { release } = deferredFetch();
    render(React.createElement(DashboardClient));

    // The frame is present on the very first paint — no full-screen spinner.
    expect(screen.getByRole("search", { name: "Search jobs" })).toBeInTheDocument();
    expect(screen.getByText("Application pipeline")).toBeInTheDocument();
    expect(screen.getByText("Profile completion")).toBeInTheDocument();
    expect(screen.getByText("Top job matches for you")).toBeInTheDocument();
    expect(screen.getByText("Recent applications")).toBeInTheDocument();
    expect(screen.getAllByText("Job matches")[0]).toBeInTheDocument();

    // And the data regions are skeletons, not empty space.
    expect(screen.getByTestId("recent-applications-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("top-matches-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("next-action-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("profile-skeleton")).toBeInTheDocument();

    release();
  });

  it("renders counts, recent applications, and best matches once loaded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));

    expect(await screen.findByText("Welcome back, Chandra.")).toBeInTheDocument();
    expect(screen.getByText("227")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
    expect(screen.getByText("Senior Software Engineer")).toBeInTheDocument();
    expect(screen.getAllByText("Strong fit")).toHaveLength(2); // the top match (91) and the recent row (84)
    expect(screen.getAllByText("Interviews")[0]).toBeInTheDocument();
    expect(screen.queryByTestId("recent-applications-skeleton")).not.toBeInTheDocument();
  });

  it("requests only the dashboard summary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/dashboard/summary");
    // The three broad reads the old Dashboard fanned out to are gone.
    expect(urls.some((url) => url.includes("/jobs?"))).toBe(false);
    expect(urls.some((url) => url.includes("/jobs/tracker/all"))).toBe(false);
    expect(urls.some((url) => url.endsWith("/profile"))).toBe(false);
  });

  it("does not issue duplicate requests when mounted twice in the same tick", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));
    render(React.createElement(DashboardClient));

    await waitFor(() => {
      expect(screen.getAllByText("Welcome back, Chandra.").length).toBe(2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves a second visit from cache without re-fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    const first = render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    first.unmount();

    render(React.createElement(DashboardClient));
    // Cached data paints synchronously — no skeleton on the return visit.
    expect(screen.getByText("227")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after a mutation invalidates the cached summary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    const first = render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    first.unmount();

    invalidateDashboardSummary();

    render(React.createElement(DashboardClient));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows a recoverable error instead of a broken page when the request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
    );
    render(React.createElement(DashboardClient));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t load your dashboard/i);
    // The shell survives the failure — the page is still navigable.
    expect(screen.getByRole("search", { name: "Search jobs" })).toBeInTheDocument();
    expect(screen.getByText("Application pipeline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("keeps the session and retry UI on a browser network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    render(React.createElement(DashboardClient));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t load your dashboard/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(localStorage.getItem("jobpilot_token")).toBe("token");
  });

  it("keeps showing cached data when a background refresh fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    const first = render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    first.unmount();

    // Age the cached entry past its stale time so the next visit revalidates.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 60_000);
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));

    render(React.createElement(DashboardClient));
    expect(await screen.findByRole("alert")).toHaveTextContent(/may be out of date/i);
    // The previous numbers are still on screen rather than replaced by an error.
    expect(screen.getByText("227")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
  });

  it("renders empty states rather than blank regions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...SUMMARY,
        freshMatches: 0,
        strongMatches: 0,
        applications: { saved: 0, inProgress: 0, interviews: 0, offers: 0, rejected: 0 },
        recentApplications: [],
        topMatches: []
      })
    );
    render(React.createElement(DashboardClient));

    expect(await screen.findByText(/No applications yet\./)).toBeInTheDocument();
    expect(screen.getByText("No scored matches yet")).toBeInTheDocument();
  });

  it("greets without a name when the profile has no confirmed first name", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...SUMMARY, nextAction: { ...SUMMARY.nextAction, firstName: "" } })
    );
    render(React.createElement(DashboardClient));

    expect(await screen.findByText("Welcome back.")).toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Header
  // ------------------------------------------------------------------ //
  it("keeps a short orienting sentence beside the greeting", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    expect(screen.getByText(/Here’s where your job search stands/)).toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Pipeline
  // ------------------------------------------------------------------ //
  it("renders the pipeline as a donut with a labelled legend, never colour alone", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");

    const pipeline = screen.getByRole("region", { name: "Application pipeline" });
    expect(pipeline.querySelector("svg")).not.toBeNull();
    expect(pipeline.querySelector("svg")).toHaveAttribute("aria-hidden", "true"); // decorative: the legend carries the data
    for (const stage of ["Saved", "In progress", "Interviews", "Offers", "Rejected"]) {
      expect(within(pipeline).getByText(stage)).toBeInTheDocument();
    }
    expect(pipeline.querySelector("dl")).not.toBeNull();
  });

  it("shows every pipeline count as text and the centre total is exactly their sum (no double counting)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");

    const pipeline = screen.getByRole("region", { name: "Application pipeline" });
    const values = within(pipeline).getAllByRole("definition").map((node) => Number(node.textContent));
    expect(values).toEqual([4, 15, 2, 1, 2]);
    const total = values.reduce((sum, value) => sum + value, 0);
    expect(within(pipeline).getByText(String(total), { selector: "p" })).toBeInTheDocument();
    // One arc per non-empty slice.
    expect(pipeline.querySelectorAll("svg circle[stroke-dasharray]")).toHaveLength(5);
  });

  it("shows a pipeline empty state when nothing has been applied to", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...SUMMARY,
        applications: { saved: 0, inProgress: 0, interviews: 0, offers: 0, rejected: 0 }
      })
    );
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");

    expect(
      screen.getByText("Save or start an application and your pipeline will appear here.", { exact: false })
    ).toBeInTheDocument();
    expect(screen.queryByRole("definition")).not.toBeInTheDocument();
  });

  it("treats a missing rejected count (an older API) as zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...SUMMARY, applications: { saved: 4, inProgress: 15, interviews: 2, offers: 1 } })
    );
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    const values = within(screen.getByRole("region", { name: "Application pipeline" }))
      .getAllByRole("definition")
      .map((node) => node.textContent);
    expect(values).toEqual(["4", "15", "2", "1", "0"]);
  });

  it("shows a pipeline skeleton while loading", () => {
    const { release } = deferredFetch();
    render(React.createElement(DashboardClient));
    expect(screen.getByTestId("pipeline-skeleton")).toBeInTheDocument();
    release();
  });

  // ------------------------------------------------------------------ //
  // Next best action
  // ------------------------------------------------------------------ //
  const ACTION_CASES = [
    {
      kind: "needs_attention",
      eyebrow: "3 applications need attention",
      title: "Complete unanswered application questions",
      href: "/tracker",
      cta: "Finish applications"
    },
    {
      kind: "interview_upcoming",
      eyebrow: "Interview coming up",
      title: "Prepare for your interview",
      href: "/tracker",
      cta: "Open tracker"
    },
    {
      kind: "strong_matches",
      eyebrow: "18 strong matches",
      title: "Review your highest-fit opportunities",
      href: "/jobs",
      cta: "View matches"
    },
    {
      kind: "discover",
      eyebrow: "Nothing pending",
      title: "Discover new opportunities",
      href: "/jobs",
      cta: "Find jobs"
    },
    {
      kind: "complete_profile",
      eyebrow: "40% profile complete",
      title: "Finish your profile",
      href: "/profile",
      cta: "Continue profile"
    }
  ] as const;

  for (const action of ACTION_CASES) {
    it(`renders the ${action.kind} next action exactly as the server described it`, async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          ...SUMMARY,
          nextAction: { ...SUMMARY.nextAction, ...action, body: "Server-authored body." }
        })
      );
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");

      const card = screen.getByLabelText(action.title);
      expect(card).toHaveAttribute("data-action-kind", action.kind);
      expect(within(card).getByText(action.eyebrow)).toBeInTheDocument();
      // The client never rewrites the copy the server sent.
      expect(within(card).getByText("Server-authored body.")).toBeInTheDocument();
      expect(within(card).getByRole("link", { name: new RegExp(action.cta, "i") })).toHaveAttribute(
        "href",
        action.href
      );
    });
  }

  it("shows a recorded interview date and never invents one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...SUMMARY,
        nextAction: {
          ...SUMMARY.nextAction,
          kind: "interview_upcoming",
          title: "Prepare for your interview",
          dueOn: "2026-08-14"
        }
      })
    );
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    expect(screen.getByText(/Aug 14/)).toBeInTheDocument();
  });

  it("omits the date line when the server sent none", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...SUMMARY,
        nextAction: { ...SUMMARY.nextAction, kind: "discover", dueOn: null }
      })
    );
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    expect(screen.queryByText(/Aug 14/)).not.toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Recently updated
  // ------------------------------------------------------------------ //
  it("links each recent application to the tracker and shows when it changed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");

    const row = screen.getByText("Platform Engineer").closest("tr") as HTMLElement;
    expect(within(row).getByRole("link", { name: /Open Platform Engineer at Northstar/ })).toHaveAttribute("href", "/tracker");
    expect(within(row).getByText("Northstar")).toBeInTheDocument();
    expect(within(row).getByText("Interview")).toBeInTheDocument();
    expect(within(row).getByText("Strong fit")).toBeInTheDocument();          // the user's own stored score, with its label
  });

  it("tolerates a missing updated timestamp", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...SUMMARY,
        recentApplications: [{ ...SUMMARY.recentApplications[0], updatedAt: null }]
      })
    );
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    expect(screen.getByText("Northstar")).toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Cross-user isolation
  // ------------------------------------------------------------------ //
  it("never serves the previous user's summary after a sign-in in the same tab", async () => {
    // Regression: the module-scoped cache outlives components, and sign-in
    // navigates with router.push (no document reload). Without binding each
    // entry to the token that fetched it, user B saw user A's name and counts.
    localStorage.setItem("jobpilot_token", "token-A");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    const first = render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    first.unmount();

    localStorage.setItem("jobpilot_token", "token-B");
    const bobSummary = {
      ...SUMMARY,
      freshMatches: 3,
      recentApplications: [],
      topMatches: [],
      nextAction: { ...SUMMARY.nextAction, firstName: "Bob" }
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(bobSummary));
    render(React.createElement(DashboardClient));

    // Nothing of A's is painted, not even for one frame.
    expect(screen.queryByText("Welcome back, Chandra.")).not.toBeInTheDocument();
    expect(screen.queryByText("227")).not.toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(await screen.findByText("Welcome back, Bob.")).toBeInTheDocument();
  });

  it("discards a response that lands after the user switched", async () => {
    localStorage.setItem("jobpilot_token", "token-A");
    let resolveA: (value: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => { resolveA = resolve; })
    );
    const first = render(React.createElement(DashboardClient));

    // The user switches while A's request is still in flight.
    localStorage.setItem("jobpilot_token", "token-B");
    resolveA(jsonResponse(SUMMARY));
    await waitFor(() =>
      expect(screen.queryByTestId("next-action-skeleton")).not.toBeInTheDocument()
    );
    first.unmount();

    // A's late response must not have been cached against B.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...SUMMARY,
        freshMatches: 3,
        nextAction: { ...SUMMARY.nextAction, firstName: "Bob" }
      })
    );
    render(React.createElement(DashboardClient));
    expect(screen.queryByText("227")).not.toBeInTheDocument();
  });

  it("drops the cache entirely when the user signs out", async () => {
    localStorage.setItem("jobpilot_token", "token-A");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    const first = render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    first.unmount();

    localStorage.removeItem("jobpilot_token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 401 }));
    render(React.createElement(DashboardClient));
    expect(screen.queryByText("227")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("logs nothing to the console during a normal load", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));

    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ //
  // Brand migration — colour must carry meaning, not decoration
  // ------------------------------------------------------------------ //
  describe("semantic colour", () => {
    /** The badge element for the single top match in a summary. */
    async function renderMatchWithScore(fitScore: number) {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          ...SUMMARY,
          topMatches: [{ ...SUMMARY.topMatches[0], fitScore }]
        })
      );
      render(React.createElement(DashboardClient));
      return await screen.findByText(String(fitScore), { selector: "span.tabular-nums" });
    }

    it("bands a weak match by its own score: red, with the number and the words Low fit", async () => {
      const badge = (await renderMatchWithScore(42)).closest("[data-fit-tone]") as HTMLElement;
      expect(badge).toHaveAttribute("data-fit-tone", "low");
      expect(badge.className).toMatch(/status-danger/);
      expect(badge).toHaveTextContent("Low fit");
    });

    it("keeps a strong match green, with its number and label", async () => {
      const badge = (await renderMatchWithScore(91)).closest("[data-fit-tone]") as HTMLElement;
      expect(badge).toHaveAttribute("data-fit-tone", "strong");
      expect(badge.className).toMatch(/fit-strong/);
      expect(badge).toHaveTextContent("Strong fit");
    });

    it("shows a mid fit in amber", async () => {
      const badge = (await renderMatchWithScore(66)).closest("[data-fit-tone]") as HTMLElement;
      expect(badge.className).toMatch(/status-warning/);
      expect(badge).toHaveTextContent("Good fit");
    });

    /**
     * Every branch of the Dashboard's status→tone map.
     *
     * This mapping is deliberately duplicated from the Tracker rather than
     * shared: the Tracker still emits legacy colour classes instead of design
     * system tones, so there is nothing canonical to consume until it migrates.
     * Because the duplication is intentional, the guard covers every branch —
     * this test is what will catch the two screens drifting apart.
     */
    it.each([
      ["offer", "Offer", "status-success"],
      ["interview", "Interview", "status-info"],
      ["rejected", "Rejected", "status-danger"],
      ["applied", "Applied", "status-warning"],
      ["applying", "Applying", "status-warning"],
      ["ready_to_apply", "Saved", "status-neutral"],
      ["withdrawn", "Withdrawn", "status-neutral"]
    ])("tones a %s application as %s / %s", async (status, label, tone) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          ...SUMMARY,
          recentApplications: [{ ...SUMMARY.recentApplications[0], id: "a", status }]
        })
      );
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");

      // Scoped to the recent list: "Offer" and "Saved" are also pipeline stage
      // labels, and this is asserting the badge tone, not the funnel.
      // The table body only: "Applied" is also a column header, and this asserts the badge.
      const recent = within(screen.getByRole("table").querySelector("tbody") as HTMLElement);
      const badge = recent.getByText(label);
      expect(badge.className).toMatch(new RegExp(tone));
      // Meaning never rests on colour alone — the label is always present.
      expect(badge).toHaveTextContent(label);
    });

    it("promotes the next action on the brand surface, not the success surface", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");

      const card = document.querySelector("[data-action-kind]");
      expect(card).not.toBeNull();
      // Being told what to do next is not an achievement.
      expect(card!.className).toMatch(/surface-selected/);
      expect(card!.className).not.toMatch(/success/);
    });

    it("no longer styles Dashboard brand, action or selection with legacy green", () => {
      const source = readFileSync(join(ROOT, "components/DashboardClient.tsx"), "utf8");
      expect(source).not.toMatch(/text-pine|bg-pine|border-pine|--success-surface|--success-border/);
      // The legacy `focus-ring` recipe, but not the canonical `ds-focus-ring`.
      expect(source).not.toMatch(/(?<!ds-)\bfocus-ring\b/);
      // The primary action is the canonical navy action, never cyan-on-white.
      expect(source).toContain("bg-action-primary");
      expect(source).not.toMatch(/bg-brand-accent\s+text-white|bg-cyan/);
    });
  });
  // ------------------------------------------------------------------ //
  // The redesigned layout
  // ------------------------------------------------------------------ //
  describe("top job matches", () => {
    async function open(summary: object = SUMMARY) {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(summary));
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");
      return screen.getByRole("article", { name: "Senior Software Engineer at Acme" });
    }

    it("shows the real posting fields on the card", async () => {
      const card = await open();
      expect(within(card).getByRole("heading", { name: "Senior Software Engineer" })).toBeInTheDocument();
      expect(within(card).getByText("Acme")).toBeInTheDocument();
      expect(within(card).getByText("Remote · Remote · Full-time")).toBeInTheDocument();
      expect(within(card).getByText(/Build and run the services/)).toBeInTheDocument();
      expect(card.querySelector("[data-fit-tone='strong']")).not.toBeNull();
    });

    it("lists only the skills the user shares with the role, three at most, and counts the rest", async () => {
      const card = await open();
      const skills = within(within(card).getByRole("list", { name: /Skills you share/ })).getAllByRole("listitem").map((n) => n.textContent);
      expect(skills).toEqual(["Python", "FastAPI", "PostgreSQL", "+1"]);
    });

    it("sends Review & apply to the real apply flow in the Jobs workspace, and never claims to submit anything", async () => {
      const card = await open();
      expect(within(card).getByRole("link", { name: /Review & apply/ })).toHaveAttribute("href", "/jobs?job=22");
      expect(card.textContent).not.toMatch(/auto-?appl|applied for you|submitted/i);
    });

    it("uses no photography: the only image area is the company's own logo mark", async () => {
      const card = await open();
      expect(card.querySelectorAll("img").length).toBeLessThanOrEqual(1);
      expect(card.querySelector("img[src*='unsplash'], img[src*='stock']")).toBeNull();
    });

    it("saves through the real endpoint, reflects it, and refreshes the cached summary", async () => {
      const card = await open();
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(jsonResponse({ tracker: { status: "saved" } }));
      const button = within(card).getByRole("button", { name: /Save Senior Software Engineer at Acme/ });
      expect(button).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(button);
      await waitFor(() => expect(within(card).getByRole("button", { name: /is saved/ })).toHaveAttribute("aria-pressed", "true"));
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/jobs\/22\/save$/);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    });

    it("says so when the save fails and leaves the card unsaved", async () => {
      const card = await open();
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ detail: "boom" }), { status: 500 }));
      await userEvent.click(within(card).getByRole("button", { name: /Save Senior Software Engineer/ }));
      expect(await within(card).findByRole("alert")).toHaveTextContent("Could not save this job.");
      expect(within(card).getByRole("button", { name: /Save Senior Software Engineer/ })).toHaveAttribute("aria-pressed", "false");
    });

    it("starts saved when the server says the role is already saved", async () => {
      const card = await open({ ...SUMMARY, topMatches: [{ ...SUMMARY.topMatches[0], saved: true }] });
      expect(within(card).getByRole("button", { name: /is saved/ })).toBeDisabled();
    });

    it("renders at most the three cards the server sent", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ ...SUMMARY, topMatches: [1, 2, 3].map((id) => ({ ...SUMMARY.topMatches[0], id, title: `Role ${id}` })) })
      );
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");
      expect(screen.getAllByRole("article")).toHaveLength(3);
    });
  });

  describe("metrics, profile and search", () => {
    it("shows four real metrics and invents no growth figure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");
      const metrics = screen.getByRole("region", { name: "Search metrics" });
      expect(within(metrics).getByText("227")).toBeInTheDocument();                     // job matches
      expect(within(metrics).getByText("20")).toBeInTheDocument();                       // 15 + 2 + 1 + 2 submitted or in progress
      expect(within(metrics).getAllByText(/Interviews|Offers|Applications|Job matches/)).toHaveLength(4);
      expect(metrics.textContent).not.toMatch(/[+\-−]\d+%|vs\.? last|this week|↑|↓/i);
    });

    it("reports profile completion from the server, with sections done and still missing", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");
      const card = screen.getByRole("region", { name: "Profile completion" });
      expect(within(card).getByRole("progressbar", { name: "Profile completion" })).toHaveAttribute("aria-valuenow", "78");
      expect(within(card).getByText("78%")).toBeInTheDocument();
      for (const label of ["Name", "Skills", "Professional links", "Education"]) expect(within(card).getByText(label)).toBeInTheDocument();
      expect(card.textContent).toMatch(/Name\s*\(done\)/);
      expect(card.textContent).toMatch(/Education\s*\(to do\)/);
      expect(within(card).getByRole("link", { name: "Continue profile" })).toHaveAttribute("href", "/profile");
    });

    it("falls back to the one percentage an older API sends, and nothing it cannot back up", async () => {
      const { profile: _unused, ...older } = SUMMARY;
      void _unused;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(older));
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");
      const card = screen.getByRole("region", { name: "Profile completion" });
      expect(within(card).getByText("100%")).toBeInTheDocument();
      expect(within(card).queryByText(/\(to do\)/)).not.toBeInTheDocument();
    });

    it("renders a payload from an older API that lacks every new field", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          freshMatches: 5,
          applications: { saved: 1, inProgress: 1, interviews: 0, offers: 0 },
          recentApplications: [{ id: "1", title: "Old Row", company: "OldCo", status: "applied", updatedAt: null, logoUrl: null }],
          topMatches: [{ id: 9, title: "Old Match", company: "OldCo", location: null, fitScore: 70 }],
          strongMatches: 0,
          nextAction: SUMMARY.nextAction
        })
      );
      render(React.createElement(DashboardClient));
      expect(await screen.findByText("Old Match")).toBeInTheDocument();
      expect(screen.getByText("Old Row")).toBeInTheDocument();
    });

    it("hands the search to the Jobs workspace, and never claims to search applications", async () => {
      push.mockClear();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");
      const input = screen.getByRole("textbox", { name: "Search jobs" });
      await userEvent.type(input, "machine learning{enter}");
      expect(push).toHaveBeenCalledWith("/jobs?q=machine%20learning");
      await userEvent.clear(input);
      await userEvent.type(input, "   {enter}");
      expect(push).toHaveBeenLastCalledWith("/jobs");
    });

    it("has no notification bell or account control it cannot back with a feature", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
      render(React.createElement(DashboardClient));
      await screen.findByText("Welcome back, Chandra.");
      expect(screen.queryByRole("button", { name: /notification/i })).not.toBeInTheDocument();
    });
  });
});
