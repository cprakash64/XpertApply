import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleWhoCanHelp } from "../components/PeopleWhoCanHelp";
import { clearPeopleCache } from "../lib/peopleClient";

/**
 * The Networking tab shows contacts. Everything about *how* the search ran —
 * scope, freshness, allowance, which provider answered — is either behind
 * "About these results" or nowhere in the UI at all.
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

function install(body: unknown) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as Response)
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Networking tab — simplified surface", () => {
  afterEach(() => {
    cleanup();
    clearPeopleCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drops every explanatory, quota and scope line from the visible tab", async () => {
    install(payload());
    render(<PeopleWhoCanHelp jobId={9001} />);
    await screen.findByText("Rita Recruiter");

    for (const removed of [
      /Contacts to research, with the evidence behind each one/,
      /Roles are potential matches, not confirmed assignments\./,
      /recruiter · /,
      /searches remaining/,
      /people searches remaining today/,
      /Some categories did not have strong matches/,
      /Search details/,
      /Scope: Hiring company only/,
      /Location used as a soft signal/,
      /Last checked:/,
      /Related-company matches were not included/,
      /Exact-company search completed/,
      /Using current cached search/
    ]) {
      expect(screen.queryByText(removed)).not.toBeInTheDocument();
    }
    // The heading and the contacts are what remain.
    expect(screen.getByRole("heading", { name: "People Who Can Help" })).toBeInTheDocument();
  });

  it("keeps the metadata reachable behind About these results", async () => {
    install(payload());
    render(<PeopleWhoCanHelp jobId={9002} />);
    await screen.findByText("Rita Recruiter");

    const toggle = screen.getByRole("button", { name: "About these results" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    expect(screen.getByText(/Roles are potential matches, not confirmed assignments/)).toBeInTheDocument();
    expect(screen.getByText(/Searched: hiring company only/)).toBeInTheDocument();
    expect(screen.getByText(/12 of 20 searches left today/)).toBeInTheDocument();
    expect(screen.getByText("This feature is in beta.")).toBeInTheDocument();
    // No provider name, credit count, or cache state anywhere in the panel.
    expect(screen.queryByText(/pdl|apollo|hunter|openai|credit|cache/i)).not.toBeInTheDocument();
  });

  it("renders only the categories that returned someone", async () => {
    install(
      payload({
        categories: {
          likely_recruiters: [RECRUITER],
          potential_hiring_managers: [MANAGER],
          potential_referrers: []
        }
      })
    );
    render(<PeopleWhoCanHelp jobId={9003} />);

    expect(await screen.findByRole("heading", { name: "Likely Recruiters" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Potential Hiring Managers" })).toBeInTheDocument();
    // The empty third category contributes neither a heading nor a paragraph.
    expect(
      screen.queryByRole("heading", { name: "Potential Referral Candidates" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No relevant employee met/)).not.toBeInTheDocument();
  });

  it("keeps the LinkedIn and email actions on the contact card", async () => {
    install(payload());
    render(<PeopleWhoCanHelp jobId={9004} />);
    await screen.findByText("Rita Recruiter");

    expect(screen.getByRole("link", { name: /LinkedIn/ })).toHaveAttribute(
      "href",
      "https://www.linkedin.com/in/rita-recruiter"
    );
    expect(screen.getByRole("button", { name: /Find work email/ })).toBeInTheDocument();
  });

  it("shows one concise unavailable state and never names the provider that failed", async () => {
    install(
      payload({
        status: "provider_unavailable",
        availability_reason: "provider_budget_exceeded",
        categories: {
          likely_recruiters: [],
          potential_hiring_managers: [],
          potential_referrers: []
        }
      })
    );
    render(<PeopleWhoCanHelp jobId={9005} />);

    expect(
      await screen.findByText(
        "People search is temporarily unavailable because provider capacity has been reached."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/PDL|Apollo|Hunter|OpenAI/i)).not.toBeInTheDocument();
  });

  it("shows contacts, not an upstream error, when a later provider succeeded", async () => {
    // The waterfall fell back after the first provider's budget ran out. The
    // user gets contacts and no failure text at all.
    install(
      payload({
        status: "complete",
        warnings: [],
        categories: {
          likely_recruiters: [RECRUITER],
          potential_hiring_managers: [MANAGER],
          potential_referrers: []
        }
      })
    );
    render(<PeopleWhoCanHelp jobId={9006} />);

    expect(await screen.findByText("Rita Recruiter")).toBeInTheDocument();
    expect(screen.getByText("Morgan Manager")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable|budget|rate limit/i)).not.toBeInTheDocument();
  });

  it("issues no request until the panel is mounted by an explicit tab open", async () => {
    const fetchMock = install(payload({ status: "not_started" }));
    // Nothing is rendered: no component, no request.
    expect(fetchMock).not.toHaveBeenCalled();

    render(<PeopleWhoCanHelp jobId={9007} />);
    // Mounting reads stored results (GET) but never starts a paid search.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
});
