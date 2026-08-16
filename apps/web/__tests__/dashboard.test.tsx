import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardClient } from "../components/DashboardClient";
import {
  __resetDashboardSummaryCache,
  invalidateDashboardSummary
} from "../lib/dashboardSummary";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

const SUMMARY = {
  freshMatches: 227,
  applications: { saved: 4, inProgress: 15, interviews: 2, offers: 1 },
  recentApplications: [
    {
      id: "1",
      title: "Platform Engineer",
      company: "Northstar",
      status: "interview",
      updatedAt: "2026-08-01T12:00:00Z",
      logoUrl: "/jobs/companies/northstar/logo"
    }
  ],
  topMatches: [
    {
      id: 22,
      title: "Senior Software Engineer",
      company: "Acme",
      location: "Remote",
      fitScore: 91
    }
  ],
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
    expect(screen.getByRole("link", { name: /find jobs/i })).toBeInTheDocument();
    expect(screen.getByText("Application pipeline")).toBeInTheDocument();
    expect(screen.getByText("Best matches this week")).toBeInTheDocument();
    expect(screen.getAllByText("Fresh matches")[0]).toBeInTheDocument();

    // And the data regions are skeletons, not empty space.
    expect(screen.getByTestId("recent-applications-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("top-matches-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("next-action-skeleton")).toBeInTheDocument();

    release();
  });

  it("renders counts, recent applications, and best matches once loaded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));

    expect(await screen.findByText("Welcome back, Chandra.")).toBeInTheDocument();
    expect(screen.getByText("227")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
    expect(screen.getByText("Senior Software Engineer")).toBeInTheDocument();
    expect(screen.getByText("91% fit")).toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: /find jobs/i })).toBeInTheDocument();
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
        applications: { saved: 0, inProgress: 0, interviews: 0, offers: 0 },
        recentApplications: [],
        topMatches: []
      })
    );
    render(React.createElement(DashboardClient));

    expect(
      await screen.findByText("Applications you save or start will appear here.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Run job discovery to see your strongest matches here.")
    ).toBeInTheDocument();
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
  it("uses the new orienting subtitle", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");
    expect(screen.getByText("Here’s where your job search stands.")).toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Pipeline
  // ------------------------------------------------------------------ //
  it("renders the pipeline as labelled stages, not a second scoreboard", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");

    const pipeline = screen.getByRole("group", { name: "Application pipeline" });
    // A description list gives assistive tech stage/count pairs.
    expect(pipeline.tagName).toBe("DL");
    for (const stage of ["Saved", "In progress", "Interview", "Offer"]) {
      expect(within(pipeline).getByText(stage)).toBeInTheDocument();
    }
    // "Saved" is the stage the metrics row does not duplicate.
    expect(within(pipeline).getByText("4")).toBeInTheDocument();
  });

  it("shows every pipeline count as text, not colour or width alone", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SUMMARY));
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");

    const values = within(screen.getByRole("group", { name: "Application pipeline" }))
      .getAllByRole("definition")
      .map((node) => node.textContent);
    expect(values).toEqual(["4", "15", "2", "1"]);
  });

  it("shows a pipeline empty state when nothing has been applied to", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...SUMMARY,
        applications: { saved: 0, inProgress: 0, interviews: 0, offers: 0 }
      })
    );
    render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Chandra.");

    expect(
      screen.getByText("Save or start an application and your pipeline will appear here.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Application pipeline" })).not.toBeInTheDocument();
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

    const row = screen.getByText("Platform Engineer").closest("a");
    expect(row).toHaveAttribute("href", "/tracker");
    expect(within(row as HTMLElement).getByText(/Northstar ·/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("Interview")).toBeInTheDocument();
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
});
