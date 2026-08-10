import { describe, expect, it } from "vitest";

import { PEOPLE_MESSAGES, derivePeopleView, peopleActionSummary } from "@/lib/peopleState";
import type { PeopleResponse } from "@/lib/api";

/**
 * The panel has exactly four things it can tell a user, and a live run got the
 * fourth one wrong: it reported spent provider capacity for a search that a
 * later provider's rejected request had actually stopped. These pin the
 * separation, and pin that no message names a vendor.
 */

const EMPTY_CATEGORIES = {
  likely_recruiters: [],
  potential_hiring_managers: [],
  potential_referrers: []
};

function payload(overrides: Partial<PeopleResponse>): PeopleResponse {
  return {
    status: "complete",
    availability_reason: "available",
    beta: false,
    categories: EMPTY_CATEGORIES,
    warnings: [],
    controls: { email_discovery: true, outreach_drafting: true },
    ...overrides
  } as PeopleResponse;
}

function view(overrides: Partial<PeopleResponse>) {
  return derivePeopleView({
    data: payload(overrides),
    error: null,
    loading: false,
    requested: true
  });
}

describe("People failure copy", () => {
  it("renders cards, and says nothing, when contacts were accepted", () => {
    const result = derivePeopleView({
      data: payload({
        status: "complete",
        categories: {
          ...EMPTY_CATEGORIES,
          likely_recruiters: [
            {
              recommendation_id: 1,
              full_name: "Rita Recruiter",
              professional_profile_url: "https://www.linkedin.com/in/rita-recruiter"
            }
          ]
        } as unknown as PeopleResponse["categories"]
      }),
      error: null,
      loading: false,
      requested: true
    });
    expect(result.state).toBe("success");
    expect(result.message).toBe("");
  });

  it("says nobody was found when the search completed empty", () => {
    expect(view({ status: "no_reliable_matches" }).message).toBe(
      "No verified professional profiles were found for this company yet."
    );
  });

  it.each([
    ["provider_unavailable", "provider_schema_error"],
    ["provider_unavailable", "provider_timeout"],
    ["provider_unavailable", "provider_unauthorized"],
    ["provider_unavailable", "provider_response_invalid"],
    ["invalid_request", "provider_request_invalid"],
    ["provider_configuration_error", "provider_forbidden"]
  ])(
    "gives a non-budget integration failure the generic temporary line (%s/%s)",
    (status, reason) => {
      const result = view({ status, availability_reason: reason } as Partial<PeopleResponse>);
      expect(result.message).toBe(
        "People search is temporarily unavailable. Please try again later."
      );
      // Never the capacity explanation: the budget did not stop this search.
      expect(result.message).not.toContain("capacity");
    }
  );

  it("reserves the capacity line for an all-budget outcome", () => {
    const result = view({
      status: "provider_budget_exhausted",
      availability_reason: "provider_budget_exceeded"
    });
    expect(result.message).toBe(
      "People search is temporarily unavailable because provider capacity has been reached."
    );
    expect(result.canRetry).toBe(false);
  });

  it("keeps the user's own allowance separate from provider capacity", () => {
    const result = view({
      status: "user_budget_exhausted",
      quota: {
        daily_limit: 20,
        daily_used: 20,
        daily_remaining: 0,
        resets_at: "2026-08-01T00:00:00Z",
        hourly_limit: 10,
        broadened_search_cost: 1
      }
    } as Partial<PeopleResponse>);
    expect(result.message).toContain("20 people searches");
    expect(result.message).not.toContain("capacity");
  });

  /**
   * A retired search contract means the stored result is no longer an answer
   * about this company. Reporting it as a verified empty result is the one
   * claim this module exists to prevent — and it is the claim users saw while
   * the PDL adapter was dropping every candidate it normalized.
   */
  it("treats a retired-contract result as unsearched, not as nobody found", () => {
    const result = view({ status: "stale" });
    expect(result.state).toBe("not_loaded");
    expect(result.message).not.toBe(PEOPLE_MESSAGES.empty);
    expect(result.message).not.toMatch(/no verified professional profiles/i);
  });

  it("agrees with the job-card summary about a retired-contract result", () => {
    // Two derivations of the same fact must not contradict each other.
    expect(peopleActionSummary(payload({ status: "stale" })).state).toBe("not_searched");
    expect(view({ status: "stale" }).state).toBe("not_loaded");
  });

  it("never names a provider in any user-facing message", () => {
    const forbidden = /\b(apollo|pdl|people data labs|openai|hunter)\b/i;
    for (const [key, message] of Object.entries(PEOPLE_MESSAGES)) {
      expect(message, key).not.toMatch(forbidden);
    }
  });
});
