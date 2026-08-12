"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { readAuthToken } from "@/lib/authToken";

/**
 * The Dashboard's single data source.
 *
 * The screen used to assemble itself from `/jobs`, `/jobs/tracker/all` and
 * `/profile` — three broad reads, none of them shaped for a summary, all three
 * awaited before anything rendered. `/dashboard/summary` returns exactly the
 * numbers, the three recent rows, and the one next action that the page shows.
 *
 * A small module-scoped cache backs it so that returning to the Dashboard (from
 * Jobs, from Tracker, via Back) paints from memory instead of re-fetching. This
 * is deliberately the only cache in front of this endpoint: the app has no
 * query library to defer to, and adding one for a single screen would be the
 * bigger change.
 */

export type DashboardApplicationCounts = {
  saved: number;
  inProgress: number;
  interviews: number;
  offers: number;
};

export type DashboardRecentApplication = {
  id: string;
  title: string;
  company: string;
  status: string;
  updatedAt: string | null;
  logoUrl: string | null;
};

/**
 * The server decides which action is most useful and why; the client only
 * renders it. Keeping the decision server-side is what stops the Dashboard
 * having to load the data needed to make it.
 */
export type DashboardNextActionKind =
  | "complete_profile"
  | "needs_attention"
  | "interview_upcoming"
  | "strong_matches"
  | "advance_saved"
  | "discover";

export type DashboardNextAction = {
  kind: DashboardNextActionKind;
  eyebrow: string;
  title: string;
  body: string;
  href: string;
  cta: string;
  firstName: string;
  profileProgress: number;
  /** Set only for `interview_upcoming` — the date the user actually recorded. */
  dueOn?: string | null;
};

export type DashboardTopMatch = {
  id: number;
  title: string;
  company: string;
  location: string | null;
  fitScore: number | null;
};

export type DashboardSummary = {
  freshMatches: number;
  applications: DashboardApplicationCounts;
  recentApplications: DashboardRecentApplication[];
  topMatches: DashboardTopMatch[];
  /** Fresh matches whose stored fit score clears the strong-fit bar. */
  strongMatches: number;
  nextAction: DashboardNextAction;
};

/**
 * How long a cached summary is served without a background refresh. Short,
 * because the numbers move whenever the user applies to something; long enough
 * that navigating between tabs does not re-request on every visit.
 */
const STALE_TIME_MS = 30_000;

type CacheEntry = { data: DashboardSummary; fetchedAt: number; token: string };

let cache: CacheEntry | null = null;
/** De-duplicates concurrent callers: two mounts in the same tick share one request. */
let inFlight: Promise<DashboardSummary> | null = null;

/**
 * The bearer token the current page is acting as.
 *
 * This cache lives at module scope, so it outlives any component — and sign-in
 * navigates with `router.push`, which does NOT reload the document. Without
 * binding each entry to the identity that fetched it, signing in as a second
 * user in the same tab would paint the first user's counts, recent
 * applications and name. Every read compares this, so a token change (sign in,
 * sign out, account deletion, refresh) can never serve the previous user.
 */
function currentToken(): string {
  if (typeof window === "undefined") return "";
  return readAuthToken() ?? "";
}

/** The cache entry, only if it belongs to whoever is signed in right now. */
function ownedCache(): CacheEntry | null {
  if (cache === null) return null;
  if (cache.token !== currentToken()) {
    // Drop it rather than just ignoring it: the previous user's data has no
    // further use and should not sit in memory.
    cache = null;
    return null;
  }
  return cache;
}

export function fetchDashboardSummary(): Promise<DashboardSummary> {
  if (inFlight) {
    return inFlight;
  }
  // Captured at request time so a response that lands after a user switch is
  // never written into the new user's cache.
  const requestToken = currentToken();
  inFlight = api<DashboardSummary>("/dashboard/summary")
    .then((data) => {
      if (requestToken === currentToken()) {
        cache = { data, fetchedAt: Date.now(), token: requestToken };
      }
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Drop the cached summary. Call after any mutation that changes the counts —
 * marking an application applied, moving one through the tracker — so the next
 * Dashboard visit reflects it rather than the pre-mutation numbers.
 */
export function invalidateDashboardSummary(): void {
  cache = null;
}

/** Test seam; also used by the invalidation tests. */
export function __resetDashboardSummaryCache(): void {
  cache = null;
  inFlight = null;
}

export type DashboardSummaryState = {
  data: DashboardSummary | null;
  /** True only while there is nothing to show yet. */
  loading: boolean;
  error: string;
  reload: () => void;
};

export function useDashboardSummary(): DashboardSummaryState {
  // Seeded from cache so a return visit renders content on the first paint
  // rather than flashing skeletons at data we already hold. Both initial values
  // are derived here rather than written back by the effect, which keeps the
  // effect free of synchronous state updates.
  const [data, setData] = useState<DashboardSummary | null>(() => ownedCache()?.data ?? null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => ownedCache() === null);
  const mounted = useRef(true);

  /** Fetch and apply the result. Every state write here is asynchronous. */
  const refresh = useCallback(() => {
    fetchDashboardSummary()
      .then((summary) => {
        if (!mounted.current) return;
        setData(summary);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!mounted.current) return;
        // Previous data is kept on screen; the error is surfaced alongside it
        // rather than replacing a working Dashboard with a failure state.
        setError(cause instanceof Error ? cause.message : "Could not load your dashboard.");
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    // A cache entry inside its stale time is served as-is: the state was
    // already seeded from it, so there is nothing to do and nothing to fetch.
    const owned = ownedCache();
    const fresh = owned !== null && Date.now() - owned.fetchedAt < STALE_TIME_MS;
    if (!fresh) {
      refresh();
    }
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  return { data, loading, error, reload: refresh };
}
