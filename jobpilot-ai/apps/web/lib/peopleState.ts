import { ApiError, type PeopleQuota, type PeopleResponse } from "@/lib/api";

/**
 * The People Who Can Help panel used to collapse every failure into one
 * message: "People search is temporarily paused after repeated provider
 * failures." That was shown for empty results, unresolved company domains, and
 * per-user budget limits, none of which are provider outages.
 *
 * These states are explicit so each one gets the message — and the retry
 * affordance — that actually matches its cause.
 */
export type PeopleUiState =
  | "not_loaded"
  | "loading"
  | "success"
  | "empty"
  | "retryable_error"
  | "configuration_error"
  | "budget_exhausted"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_budget_exhausted"
  | "invalid_request"
  | "partial"
  | "domain_unresolved";

export type PeopleView = {
  state: PeopleUiState;
  message: string;
  /** Only retryable states offer a Retry control. */
  canRetry: boolean;
  retryAfterSeconds: number | null;
  /** True when the shown results predate a provider outage. */
  cached: boolean;
};

/**
 * Four distinct outcomes, and no fifth.
 *
 * A live run reported "the provider budget has been reached" for a search the
 * budget never stopped — an integration defect in a later provider was the real
 * cause. Two rules follow, and both live here:
 *
 * 1. Capacity copy is reserved for the one case where every eligible provider
 *    really was blocked by a budget. Every other failure gets the neutral
 *    temporary-unavailability line, because the user can do nothing differently
 *    in either case and a wrong explanation is worse than none.
 * 2. No message names a provider. Which vendor answered is an operational
 *    detail; it is in the logs, and it is not the user's business.
 */
export const PEOPLE_MESSAGES = {
  not_loaded: "Find recruiters, hiring-team members, and potential referrals.",
  loading: "Looking for recruiters and referral candidates…",
  empty: "No verified professional profiles were found for this company yet.",
  // Some categories matched and some did not. Quiet, because people are shown.
  partial: "Some categories did not have strong matches.",
  domain_unresolved: "We could not confidently identify this company yet.",
  // A request we got wrong. From the user's side it is indistinguishable from
  // any other temporary integration failure, and it is described as one.
  invalid_request: "People search is temporarily unavailable. Please try again later.",
  rate_limited:
    "People search is temporarily unavailable. Try again after the displayed time.",
  // The user's own allowance, counted in deliberate searches.
  budget_exhausted: "You have used all of today's people searches.",
  // Operational capacity. Only shown when every eligible provider was blocked
  // by a budget — never when a later provider failed for any other reason.
  provider_budget_exhausted:
    "People search is temporarily unavailable because provider capacity has been reached.",
  configuration_error: "People search is temporarily unavailable. Please try again later.",
  provider_unavailable: "People search is temporarily unavailable. Please try again later.",
  retryable_error: "People recommendations could not be loaded. Please try again.",
  disabled_rollout: "People recommendations are currently available to selected beta users.",
  disabled_configuration: "People recommendations are temporarily unavailable.",
  disabled_account: "People recommendations are not enabled for this account.",
  persistence_error:
    "EZJobFind found potential contacts but could not save the results. No additional search will run unless you retry."
} as const;

/** "Resets Jul 30 at 12:00 AM" — the user's own locale and timezone. */
export function formatResetTime(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const day = parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = parsed.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

/** "12 of 20 people searches remaining today." */
export function quotaSummary(quota: PeopleQuota | undefined): string | null {
  if (!quota || !quota.daily_limit) return null;
  return `${quota.daily_remaining} of ${quota.daily_limit} people searches remaining today.`;
}

export function quotaExhaustedMessage(quota: PeopleQuota | undefined): string {
  if (!quota || !quota.daily_limit) return PEOPLE_MESSAGES.budget_exhausted;
  const reset = formatResetTime(quota.resets_at);
  const base = `You have used all ${quota.daily_limit} people searches for today.`;
  return reset ? `${base} Your limit resets ${reset}.` : base;
}

/**
 * The compact People control on a job card.
 *
 * Derived ONLY from what the client already holds — this never triggers a
 * request. A card that has never been searched says so; a card whose results are
 * already loaded shows the count. Rendering, scrolling, and filtering a list of
 * jobs must never reach the people API.
 */
export type PeopleActionState =
  | "not_searched"
  | "loading"
  | "results"
  | "empty"
  | "quota_exhausted"
  | "unavailable";

export type PeopleAction = { state: PeopleActionState; label: string; count: number };

export function peopleActionSummary(data: PeopleResponse | null): PeopleAction {
  if (!data || data.status === "not_started") {
    return { state: "not_searched", label: "Find people", count: 0 };
  }
  const count = Object.values(data.categories).reduce(
    (total, items) => total + renderableContacts(items).length,
    0
  );
  if (data.status === "in_progress") {
    return { state: "loading", label: "Finding people…", count };
  }
  // Results already loaded stay visible whatever the account's remaining
  // allowance is — showing them costs nothing.
  if (count > 0) {
    return { state: "results", label: `${count} ${count === 1 ? "person" : "people"}`, count };
  }
  switch (data.status) {
    case "user_budget_exhausted":
      return { state: "quota_exhausted", label: "People limit reached", count: 0 };
    case "provider_budget_exhausted":
    case "provider_configuration_error":
    case "provider_unavailable":
    case "persistence_error":
    case "domain_unresolved":
    case "invalid_request":
    case "disabled":
      return { state: "unavailable", label: "People unavailable", count: 0 };
    case "stale":
      return { state: "not_searched", label: "Find people", count: 0 };
    default:
      return { state: "empty", label: "No people found", count: 0 };
  }
}

/**
 * The client half of the actionable-contact policy.
 *
 * The backend already refuses to persist or serve a masked or linkless
 * contact, at three separate layers. This is the fourth, and it exists because
 * the failure it guards against actually shipped: records written under an
 * older contract rendered as cards with a greyed-out "No LinkedIn" button and
 * a surname replaced by block characters. If malformed legacy data ever
 * reaches this component again, it is dropped here rather than drawn.
 *
 * Kept deliberately simple — a name a human could read, and a link they could
 * open. Anything subtler belongs on the server, where the evidence lives.
 */
const MASKED_NAME = /[*#•·…\u2580-\u259F]|\b([a-z])\1{2,}\b/i;

export function isRenderableContact(person: {
  full_name?: string | null;
  professional_profile_url?: string | null;
}): boolean {
  const name = (person.full_name ?? "").trim();
  if (!name || MASKED_NAME.test(name)) return false;
  // Two usable tokens: "Priya R." and "Priya" are not names a user can act on.
  if (name.split(/\s+/).filter((token) => token.replace(/[^A-Za-z]/g, "").length > 1).length < 2) {
    return false;
  }
  const url = (person.professional_profile_url ?? "").trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "linkedin.com" || parsed.hostname.endsWith(".linkedin.com")) &&
      parsed.pathname.startsWith("/in/")
    );
  } catch {
    return false;
  }
}

export function renderableContacts<T extends { full_name?: string | null; professional_profile_url?: string | null }>(
  items: readonly T[] | undefined
): T[] {
  return (items ?? []).filter((item) => isRenderableContact(item));
}

function hasResults(data: PeopleResponse | null): boolean {
  return Boolean(
    data &&
      data.status !== "disabled" &&
      Object.values(data.categories).some((items) => renderableContacts(items).length > 0)
  );
}

/** The subset of states that carry a message keyed in PEOPLE_MESSAGES. */
type PeopleFailureState = Exclude<PeopleUiState, "success">;

/** Maps a transport-level failure onto the taxonomy. */
function stateForApiError(error: ApiError): PeopleFailureState {
  if (
    error.serverCode === "PEOPLE_USER_BUDGET_EXCEEDED" ||
    error.serverCode === "PEOPLE_GLOBAL_BUDGET_EXCEEDED"
  ) {
    return "budget_exhausted";
  }
  if (error.code === "rate_limited") return "rate_limited";
  if (error.code === "auth_expired") return "configuration_error";
  return "retryable_error";
}

/**
 * One reason deserves wording more specific than its state's default: a run
 * that found contacts and could not save them is a different promise to the
 * user than one that found nothing.
 */
const REASON_MESSAGE_OVERRIDES: Record<string, string> = {
  recommendation_commit_failed: PEOPLE_MESSAGES.persistence_error
};

/** Maps a backend availability reason onto the taxonomy. */
function stateForReason(reason: string | undefined): PeopleFailureState {
  switch (reason) {
    case "company_domain_unresolved":
      return "domain_unresolved";
    case "provider_rate_limited":
      return "rate_limited";
    case "user_daily_limit_reached":
      return "budget_exhausted";
    case "provider_user_limit_exceeded":
    case "provider_budget_exceeded":
      // A provider cost stop is not the user running out of searches.
      return "provider_budget_exhausted";
    case "provider_not_configured":
    case "provider_unauthorized":
    case "provider_forbidden":
    case "provider_master_key_required_or_forbidden":
    case "provider_configuration_circuit_open":
      return "configuration_error";
    case "provider_circuit_open":
    case "provider_timeout":
    case "provider_network_error":
    case "provider_unavailable":
      return "provider_unavailable";
    case "provider_request_invalid":
    case "provider_route_invalid":
      // A genuinely malformed request. PDL answers a valid query that matched
      // nothing with 404, and that is handled as an empty result upstream, so
      // this state is now only reached by a real request defect.
      return "invalid_request";
    case "provider_schema_error":
    case "provider_response_invalid":
      // Adapter-shaped failures: specific copy, no user-facing retry.
      return "configuration_error";
    default:
      // Reached only for status provider_unavailable, so the honest default is
      // a transient provider outage rather than a generic client error.
      return "provider_unavailable";
  }
}

const RETRYABLE_STATES: ReadonlySet<PeopleUiState> = new Set<PeopleUiState>([
  "retryable_error",
  "provider_unavailable",
  "rate_limited"
]);

/**
 * Derives everything the panel renders from the response, the transport error,
 * and whether the user has asked for a search yet. Deliberately pure so the
 * mapping is testable without rendering a component.
 */
export function derivePeopleView({
  data,
  error,
  loading,
  requested
}: {
  data: PeopleResponse | null;
  error: unknown;
  loading: boolean;
  requested: boolean;
}): PeopleView {
  if (loading) {
    return {
      state: "loading",
      message: PEOPLE_MESSAGES.loading,
      canRetry: false,
      retryAfterSeconds: null,
      cached: false
    };
  }

  if (error instanceof ApiError) {
    if (error.code === "request_cancelled") {
      // A cancelled request is not a failure; fall back to the idle state.
      return {
        state: "not_loaded",
        message: PEOPLE_MESSAGES.not_loaded,
        canRetry: false,
        retryAfterSeconds: null,
        cached: false
      };
    }
    const state = stateForApiError(error);
    return {
      state,
      message: PEOPLE_MESSAGES[state],
      canRetry: RETRYABLE_STATES.has(state),
      retryAfterSeconds: null,
      cached: false
    };
  }
  if (error) {
    return {
      state: "retryable_error",
      message: PEOPLE_MESSAGES.retryable_error,
      canRetry: true,
      retryAfterSeconds: null,
      cached: false
    };
  }

  if (!data || (!requested && data.status === "not_started")) {
    return {
      state: "not_loaded",
      message: PEOPLE_MESSAGES.not_loaded,
      canRetry: false,
      retryAfterSeconds: null,
      cached: false
    };
  }

  const cached = data.result_freshness === "stale";
  if (hasResults(data)) {
    // People were found, but at least one category was answered with nobody.
    // Say so quietly rather than implying full coverage.
    const partial = data.status === "partial";
    return {
      state: partial ? "partial" : "success",
      message: partial ? PEOPLE_MESSAGES.partial : "",
      canRetry: false,
      retryAfterSeconds: null,
      cached
    };
  }

  switch (data.status) {
    case "not_started":
      return {
        state: "not_loaded",
        message: PEOPLE_MESSAGES.not_loaded,
        canRetry: false,
        retryAfterSeconds: null,
        cached: false
      };
    case "in_progress":
      return {
        state: "loading",
        message: PEOPLE_MESSAGES.loading,
        canRetry: false,
        retryAfterSeconds: null,
        cached: false
      };
    case "no_reliable_matches":
    case "complete":
    case "partial":
      return {
        state: "empty",
        message: PEOPLE_MESSAGES.empty,
        canRetry: false,
        retryAfterSeconds: null,
        cached
      };
    // The stored result was produced under a retired search contract, so it is
    // no longer an answer about this company — it is an absence of one. Falling
    // through to `default` reported it as a verified empty result, which is the
    // exact claim this module exists to stop the panel from making. The backend
    // already offers "Refresh people" for this status; peopleActionSummary
    // likewise treats it as never-searched, and these two must not disagree.
    case "stale":
      return {
        state: "not_loaded",
        message: PEOPLE_MESSAGES.not_loaded,
        canRetry: false,
        retryAfterSeconds: null,
        cached: false
      };
    case "invalid_request":
      return {
        state: "invalid_request",
        message: PEOPLE_MESSAGES.invalid_request,
        canRetry: false,
        retryAfterSeconds: null,
        cached: false
      };
    case "domain_unresolved":
      return {
        state: "domain_unresolved",
        message: PEOPLE_MESSAGES.domain_unresolved,
        canRetry: false,
        retryAfterSeconds: null,
        cached: false
      };
    case "user_budget_exhausted":
      return {
        state: "budget_exhausted",
        message: quotaExhaustedMessage(data.quota),
        canRetry: false,
        retryAfterSeconds: null,
        cached
      };
    case "provider_budget_exhausted":
      return {
        state: "provider_budget_exhausted",
        message: PEOPLE_MESSAGES.provider_budget_exhausted,
        canRetry: false,
        retryAfterSeconds: null,
        cached
      };
    case "provider_configuration_error":
      return {
        state: "configuration_error",
        message: PEOPLE_MESSAGES.configuration_error,
        canRetry: false,
        retryAfterSeconds: null,
        cached
      };
    case "persistence_error":
      return {
        state: "retryable_error",
        message: PEOPLE_MESSAGES.persistence_error,
        canRetry: data.retry_eligible !== false,
        retryAfterSeconds: data.retry_after_seconds ?? null,
        cached
      };
    case "provider_unavailable": {
      const state = stateForReason(data.availability_reason);
      return {
        state,
        message:
          REASON_MESSAGE_OVERRIDES[data.availability_reason ?? ""] ??
          PEOPLE_MESSAGES[state],
        canRetry: RETRYABLE_STATES.has(state) && data.retry_eligible !== false,
        retryAfterSeconds: data.retry_after_seconds ?? null,
        cached
      };
    }
    default:
      return {
        state: "empty",
        message: PEOPLE_MESSAGES.empty,
        canRetry: false,
        retryAfterSeconds: null,
        cached
      };
  }
}
