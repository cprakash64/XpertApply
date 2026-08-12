import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleWhoCanHelp } from "../components/PeopleWhoCanHelp";
import { clearPeopleCache } from "../lib/peopleClient";

/**
 * "Improve with AI" is the only control in this panel that may reach OpenAI,
 * and it must cost a deliberate click. The tests that matter most here are the
 * negative ones: rendering the panel, opening the dialog, and using LinkedIn or
 * Email must never produce a request to the improve endpoint.
 */

const person = {
  recommendation_id: 11,
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

const DETERMINISTIC = {
  message_type: "linkedin_message",
  subject: null,
  body: "Hi Rita, deterministic draft body.",
  linkedin_body: "Hi Rita — deterministic linkedin body.",
  facts_used: [],
  assumptions: [],
  omitted_uncertain_facts: [],
  character_count: 34,
  requires_manual_review: true,
  generation_path: "deterministic_template",
  recipient_name: "Rita Recruiter",
  linkedin_url: "https://www.linkedin.com/in/rita-recruiter"
};

function peopleResponse(aiEnabled: boolean) {
  return {
    status: "complete",
    beta: true,
    categories: {
      likely_recruiters: [person],
      potential_hiring_managers: [],
      potential_referrers: []
    },
    warnings: [],
    generated_at: "2026-07-26T12:00:00Z",
    controls: {
      email_discovery: true,
      outreach_drafting: true,
      outreach_ai_improvement: aiEnabled
    }
  };
}

function mockFetch(aiEnabled: boolean, improveResult: object) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const ok = (payload: object) => ({
      ok: true,
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    });
    if (path.includes("/outreach-draft/improve")) return ok(improveResult);
    if (path.includes("/outreach-draft")) return ok(DETERMINISTIC);
    return ok(peopleResponse(aiEnabled));
  });
}

function improveCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("/outreach-draft/improve")
  );
}

async function openDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Draft message" }));
  await screen.findByText("Hi Rita, deterministic draft body.");
}

describe("Improve with AI", () => {
  afterEach(() => {
    cleanup();
    clearPeopleCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the deterministic draft immediately and offers the AI action", async () => {
    const fetchMock = mockFetch(true, {});
    vi.stubGlobal("fetch", fetchMock);
    render(<PeopleWhoCanHelp jobId={7} />);
    await openDialog();
    expect(screen.getByRole("button", { name: /Improve with AI/ })).toBeInTheDocument();
    // Opening the dialog must not have generated anything.
    expect(improveCalls(fetchMock)).toHaveLength(0);
  });

  it("hides the AI action when the backend says it is unavailable", async () => {
    vi.stubGlobal("fetch", mockFetch(false, {}));
    render(<PeopleWhoCanHelp jobId={7} />);
    await openDialog();
    expect(screen.queryByRole("button", { name: /Improve with AI/ })).not.toBeInTheDocument();
  });

  it("replaces the draft when the backend returns a validated result", async () => {
    const improved = {
      ...DETERMINISTIC,
      body: "Hi Rita, refined body.",
      linkedin_body: "Hi Rita — refined linkedin body.",
      generation_path: "openai_validated"
    };
    const fetchMock = mockFetch(true, improved);
    vi.stubGlobal("fetch", fetchMock);
    render(<PeopleWhoCanHelp jobId={7} />);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /Improve with AI/ }));
    expect(await screen.findByText("Hi Rita, refined body.")).toBeInTheDocument();
    // Both the status note and the button label read "Improved with AI".
    expect((await screen.findAllByText(/Improved with AI/)).length).toBeGreaterThan(0);
    expect(improveCalls(fetchMock)).toHaveLength(1);
  });

  it("keeps the original draft when the backend falls back", async () => {
    const fetchMock = mockFetch(true, {
      ...DETERMINISTIC,
      generation_path: "deterministic_fallback",
      ai_fallback_reason: "unsupported_proper_noun"
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PeopleWhoCanHelp jobId={7} />);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /Improve with AI/ }));
    expect(
      await screen.findByText(/Couldn’t safely improve — using the original draft/)
    ).toBeInTheDocument();
    // The working content survives, and the internal reason is not shown.
    expect(screen.getByText("Hi Rita, deterministic draft body.")).toBeInTheDocument();
    expect(screen.queryByText(/unsupported_proper_noun/)).not.toBeInTheDocument();
  });

  it("treats one double-click as one request", async () => {
    const fetchMock = mockFetch(true, {
      ...DETERMINISTIC,
      generation_path: "openai_validated"
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PeopleWhoCanHelp jobId={7} />);
    await openDialog();
    const button = screen.getByRole("button", { name: /Improve with AI/ });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(improveCalls(fetchMock).length).toBeGreaterThan(0));
    expect(improveCalls(fetchMock)).toHaveLength(1);
  });

  it("never shows internal grounding identifiers to an ordinary user", async () => {
    // facts_used / omitted_uncertain_facts stay in the API for auditing and for
    // the validator, but they are internal identifiers and were being printed
    // verbatim in the dialog footer for every user.
    const fetchMock = mockFetch(true, {});
    vi.stubGlobal("fetch", fetchMock);
    render(<PeopleWhoCanHelp jobId={7} />);
    await openDialog();
    for (const leaked of [
      /Grounded in/i,
      /Omitted as uncertain/i,
      /recruiter_assignment_unconfirmed/,
      /applicant_skill:/,
      /job_skill:/
    ]) {
      expect(screen.queryByText(leaked)).not.toBeInTheDocument();
    }
    // The honest review reminder stays.
    expect(screen.getByText(/never sends this message automatically/i)).toBeInTheDocument();
  });

  it("starts idle, with no failure status before any attempt", async () => {
    vi.stubGlobal("fetch", mockFetch(true, {}));
    render(<PeopleWhoCanHelp jobId={7} />);
    await openDialog();
    expect(screen.queryByText(/Couldn’t safely improve/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Improve with AI$/ })).toBeInTheDocument();
  });

  it("clears a fallback status when the dialog is closed and reopened", async () => {
    // The defect: the status line said "Couldn't safely improve" while the
    // button still read "Improve with AI", because they were separate state.
    vi.stubGlobal("fetch", mockFetch(true, {
      ...DETERMINISTIC,
      generation_path: "deterministic_fallback"
    }));
    render(<PeopleWhoCanHelp jobId={7} />);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /Improve with AI/ }));
    await screen.findByText(/Couldn’t safely improve/);
    fireEvent.click(screen.getByRole("button", { name: /Close outreach draft/i }));
    await openDialog();
    expect(screen.queryByText(/Couldn’t safely improve/)).not.toBeInTheDocument();
  });

  // NOT COVERED: distinguishing "unavailable" (404 / feature disabled) from a
  // validation fallback. The mapping exists in improveWithAi(), but a reliable
  // test for it was not landed — see the report. The two states are separate in
  // AiImproveState and produce different copy; that separation is untested.
  it("never reaches the improve endpoint from LinkedIn or Email", async () => {
    const fetchMock = mockFetch(true, {});
    vi.stubGlobal("fetch", fetchMock);
    render(<PeopleWhoCanHelp jobId={7} />);
    const link = await screen.findByRole("link", { name: /LinkedIn/ });
    fireEvent.mouseOver(link);
    fireEvent.focus(link);
    fireEvent.click(link);
    fireEvent.click(screen.getByRole("button", { name: /Find work email/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(improveCalls(fetchMock)).toHaveLength(0);
  });
});
