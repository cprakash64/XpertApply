import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleWhoCanHelp } from "../components/PeopleWhoCanHelp";
import { clearPeopleCache } from "../lib/peopleClient";

/**
 * NET-01: category navigation and the work-email action. All data is synthetic;
 * the "API" is a scripted fetch mock, so none of this proves a real provider.
 */

const RECRUITER = {
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
  contacted: false
};

const MANAGER = {
  ...RECRUITER,
  recommendation_id: 2,
  full_name: "Morgan Manager",
  current_title: "Director of Machine Learning",
  category: "potential_hiring_manager",
  category_label: "Potential hiring manager"
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    status: "complete",
    availability_reason: "available",
    result_freshness: "fresh",
    beta: true,
    generated_at: "2026-07-26T12:00:00Z",
    warnings: [],
    quota: {
      daily_limit: 20,
      daily_used: 8,
      daily_remaining: 12,
      resets_at: "2026-07-30T00:00:00.000Z",
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
      likely_recruiters: [RECRUITER],
      potential_hiring_managers: [],
      potential_referrers: []
    },
    controls: { email_discovery: true, outreach_drafting: true },
    ...overrides
  };
}


const REFERRER = {
  ...RECRUITER,
  recommendation_id: 3,
  full_name: "Pat Referrer",
  current_title: "Staff Machine Learning Engineer",
  category: "potential_referrer",
  category_label: "Potential referral candidate"
};

function install(body: unknown, emailResponses: Array<{ status: number; body: unknown }> = []) {
  const queue = [...emailResponses];
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/email")) {
      const next = queue.shift() ?? { status: 500, body: { detail: "unscripted" } };
      return Promise.resolve({
        ok: next.status < 400,
        status: next.status,
        json: async () => next.body,
        text: async () => JSON.stringify(next.body)
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const emailCalls = (fetchMock: ReturnType<typeof install>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/email"));

describe("Networking categories and Get Email (NET-01)", () => {
  afterEach(() => {
    cleanup();
    clearPeopleCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers the three categories with counts and switches between them", async () => {
    install(payload({
      categories: {
        likely_recruiters: [RECRUITER],
        potential_hiring_managers: [MANAGER],
        potential_referrers: [REFERRER]
      }
    }));
    render(<PeopleWhoCanHelp jobId={9101} />);
    await screen.findByText("Morgan Manager");

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Hiring Managers1", "Recruiters1", "Referral Candidates1"
    ]);
    expect(screen.queryByText("Rita Recruiter")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Recruiters/ }));
    expect(screen.getByText("Rita Recruiter")).toBeInTheDocument();
    expect(screen.queryByText("Morgan Manager")).not.toBeInTheDocument();
    // Each card is labelled with its own category, never a blanket label.
    expect(screen.getByText("Recruiter", { selector: "span" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Referral Candidates/ }));
    expect(screen.getByText("Pat Referrer")).toBeInTheDocument();
    expect(screen.getByText("Referral", { selector: "span" })).toBeInTheDocument();
  });

  it("explains an empty category instead of hiding it", async () => {
    install(payload());
    render(<PeopleWhoCanHelp jobId={9102} />);
    await screen.findByText("Rita Recruiter");
    fireEvent.click(screen.getByRole("tab", { name: /Hiring Managers/ }));
    expect(screen.getByText(/No potential hiring managers were found/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Referral Candidates/ }));
    expect(screen.getByText(/No referral candidates were found/)).toBeInTheDocument();
  });

  it("supports arrow, Home and End keys on the tab list", async () => {
    install(payload({
      categories: {
        likely_recruiters: [RECRUITER],
        potential_hiring_managers: [MANAGER],
        potential_referrers: [REFERRER]
      }
    }));
    render(<PeopleWhoCanHelp jobId={9103} />);
    await screen.findByText("Morgan Manager");
    const first = screen.getByRole("tab", { name: /Hiring Managers/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Recruiters/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Recruiters/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: /Recruiters/ }), { key: "End" });
    expect(screen.getByRole("tab", { name: /Referral Candidates/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /Referral Candidates/ }), { key: "Home" });
    expect(screen.getByRole("tab", { name: /Hiring Managers/ })).toHaveAttribute("aria-selected", "true");
    // Roving tabindex: only the selected tab is in the tab order.
    expect(screen.getByRole("tab", { name: /Recruiters/ })).toHaveAttribute("tabindex", "-1");
  });

  it("shows a verified email only after the backend returns one", async () => {
    const fetchMock = install(payload(), [{
      status: 200,
      body: { status: "verified", professional_email: "rita.recruiter@acme.example", verified_at: "2026-10-31T10:00:00Z" }
    }]);
    render(<PeopleWhoCanHelp jobId={9104} />);
    await screen.findByText("Rita Recruiter");
    expect(screen.queryByText(/Verified work email/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Find work email/ }));
    expect(await screen.findByText(/Verified work email: rita.recruiter@acme.example/)).toBeInTheDocument();
    expect(emailCalls(fetchMock)).toHaveLength(1);
  });

  it("says plainly when no email exists and offers no retry", async () => {
    const fetchMock = install(payload(), [{ status: 200, body: { status: "not_found", professional_email: null, verified_at: "2026-10-31T10:00:00Z" } }]);
    render(<PeopleWhoCanHelp jobId={9105} />);
    await screen.findByText("Rita Recruiter");
    fireEvent.click(screen.getByRole("button", { name: /Find work email/ }));
    expect(await screen.findByText(/No work email was found when last checked on/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /work email/i })).not.toBeInTheDocument();
    expect(emailCalls(fetchMock)).toHaveLength(1);
  });

  it.each([
    ["rate_limited", /rate limit has been reached/],
    ["provider_unavailable", /temporarily unavailable/],
    ["provider_error", /service problem/],
    ["searching", /already running/]
  ])("keeps a retry available after a %s answer and never shows an email", async (status, note) => {
    const fetchMock = install(payload(), [
      { status: 200, body: { status, professional_email: null, verified_at: null } },
      { status: 200, body: { status: "verified", professional_email: "rita.recruiter@acme.example", verified_at: "2026-10-31T10:00:00Z" } }
    ]);
    render(<PeopleWhoCanHelp jobId={9106} />);
    await screen.findByText("Rita Recruiter");
    fireEvent.click(screen.getByRole("button", { name: "Find work email" }));
    expect(await screen.findByText(note)).toBeInTheDocument();
    expect(screen.queryByText(/Verified work email/)).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry work email" });
    fireEvent.click(retry);
    expect(await screen.findByText(/Verified work email: rita.recruiter@acme.example/)).toBeInTheDocument();
    expect(emailCalls(fetchMock)).toHaveLength(2);
  });

  it("treats a usage-limit answer as final for now and offers no retry", async () => {
    const fetchMock = install(payload(), [{ status: 200, body: { status: "budget_exceeded", professional_email: null, verified_at: null } }]);
    render(<PeopleWhoCanHelp jobId={9107} />);
    await screen.findByText("Rita Recruiter");
    fireEvent.click(screen.getByRole("button", { name: "Find work email" }));
    expect(await screen.findByText(/daily limit was reached/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /work email/i })).not.toBeInTheDocument();
    expect(emailCalls(fetchMock)).toHaveLength(1);
  });

  it("shows a recoverable error when the request itself fails", async () => {
    install(payload(), [{ status: 500, body: { detail: "boom" } }]);
    render(<PeopleWhoCanHelp jobId={9107} />);
    await screen.findByText("Rita Recruiter");
    fireEvent.click(screen.getByRole("button", { name: /Find work email/ }));
    expect(await screen.findByText(/Work-email lookup is temporarily unavailable\. No email was displayed\./)).toBeInTheDocument();
    expect(screen.queryByText(/Verified work email/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Find work email/ })).toBeEnabled();
  });

  it("distinguishes a disabled lookup from a contact with no email", async () => {
    const fetchMock = install(payload({ controls: { email_discovery: false, outreach_drafting: true } }));
    render(<PeopleWhoCanHelp jobId={9108} />);
    await screen.findByText("Rita Recruiter");
    expect(screen.queryByRole("button", { name: /work email/i })).not.toBeInTheDocument();
    expect(screen.getByText("Email unavailable")).toBeInTheDocument();
    expect(screen.getByText("Work-email lookup is not enabled right now.")).toBeInTheDocument();
    expect(screen.queryByText("No email")).not.toBeInTheDocument();
    expect(emailCalls(fetchMock)).toHaveLength(0);
  });
});
