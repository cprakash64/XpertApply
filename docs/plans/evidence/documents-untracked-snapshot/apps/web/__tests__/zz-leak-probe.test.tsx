import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardClient } from "../components/DashboardClient";
import { __resetDashboardSummaryCache } from "../lib/dashboardSummary";

function j(b: unknown) {
  return new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
}
const mk = (name: string, fresh: number) => ({
  freshMatches: fresh,
  applications: { saved: 0, inProgress: 0, interviews: 0, offers: 0 },
  recentApplications: [], topMatches: [], strongMatches: 0,
  nextAction: { kind: "discover", eyebrow: "", title: "Discover new opportunities",
    body: "", href: "/jobs", cta: "Find jobs", firstName: name, profileProgress: 100 }
});

describe("cross-user cache probe", () => {
  beforeEach(() => __resetDashboardSummaryCache());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); __resetDashboardSummaryCache(); });

  it("must not show user A's data to user B after a token switch", async () => {
    localStorage.setItem("jobpilot_token", "token-A");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(j(mk("Alice", 227)));
    const a = render(React.createElement(DashboardClient));
    await screen.findByText("Welcome back, Alice.");
    a.unmount();

    // User B signs in in the same tab (router.push — no page reload).
    localStorage.setItem("jobpilot_token", "token-B");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(j(mk("Bob", 3)));
    render(React.createElement(DashboardClient));
    expect(screen.queryByText("Welcome back, Alice.")).not.toBeInTheDocument();
    expect(screen.queryByText("227")).not.toBeInTheDocument();
  });
});
