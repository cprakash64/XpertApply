"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Job, type JobsResponse } from "@/lib/api";
import type { JobsQuery } from "@/lib/jobsQuery";

/**
 * The Jobs list, ranked and paged by the SERVER.
 *
 * Order is decided over the whole matching set by `GET /jobs?sort=...` (see `apps/api/app/jobs/ranking.py`); this hook only
 * asks for the next page with the cursor the server returned. It never sorts, and it never filters a page the server has
 * already filtered, so scrolling cannot reshuffle what is on screen and a second page cannot repeat or skip a job.
 *
 * A response WITHOUT a `page` block is a full legacy list (an older API, or the discover/refresh endpoints). It is shown as
 * returned and the caller falls back to filtering and ordering it locally, exactly as before.
 */
export const JOBS_PAGE_SIZE = 25;
/** The server's own ceiling for `limit`. */
const MAX_LIMIT = 100;
const QUERY_DEBOUNCE_MS = 250;

export type JobsFeedStatus = "bootstrapping" | "error" | "loaded";

type PageInfo = { total: number; hasMore: boolean; nextCursor: string | null };

type FeedQuery = Pick<JobsQuery, "q" | "workplace" | "minFit" | "postedWithin" | "sort">;

/** Every filter the server applies, plus the sort. A change in any of them starts a new list. */
export function feedKey(query: FeedQuery): string {
  return JSON.stringify([query.postedWithin, query.sort, query.q.trim().toLowerCase(), query.workplace, query.minFit]);
}

export function jobsParams(query: FeedQuery, limit: number | null, cursor?: string | null): string {
  const params = new URLSearchParams();
  params.set("posted_within_days", String(query.postedWithin));
  params.set("sort", query.sort);
  if (limit !== null) params.set("limit", String(limit));
  const role = query.q.trim();
  if (role) params.set("role", role);
  if (query.workplace) params.set("workplace_type", query.workplace);
  if (query.minFit > 0) params.set("min_fit_score", String(query.minFit));
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function readPage(result: JobsResponse): PageInfo | null {
  const page = result.page;
  if (!page) return null;
  return { total: page.total, hasMore: Boolean(page.has_more), nextCursor: page.next_cursor ?? null };
}

export function useJobsFeed(query: FeedQuery) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [page, setPage] = useState<PageInfo | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [profileComplete, setProfileComplete] = useState(true);
  // The key whose results are on screen, and the key being asked for. They differ while a changed filter is loading.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // Typing in the search box must not fire a request per keystroke.
  const [debouncedQ, setDebouncedQ] = useState(query.q);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(query.q), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query.q]);

  const effective = useMemo<FeedQuery>(
    () => ({ q: debouncedQ, workplace: query.workplace, minFit: query.minFit, postedWithin: query.postedWithin, sort: query.sort }),
    [debouncedQ, query.workplace, query.minFit, query.postedWithin, query.sort]
  );
  const key = feedKey(effective);
  const keyRef = useRef(key);
  // Written after each commit rather than during render; every reader below runs from an event or an async callback.
  useEffect(() => {
    keyRef.current = key;
  }, [key]);
  const moreInFlight = useRef(false);

  const applyFirstPage = useCallback((result: JobsResponse) => {
    setJobs(result.jobs);
    setPage(readPage(result));
    setProfileComplete(result.profile_complete);
    setError("");
    setMoreError("");
  }, []);

  useEffect(() => {
    let active = true;
    const requestKey = key;
    void (async () => {
      try {
        const result = await api<JobsResponse>(`/jobs?${jobsParams(effective, JOBS_PAGE_SIZE)}`);
        if (!active) return;
        applyFirstPage(result);
      } catch (loadError) {
        // Recorded separately so the workspace can show a retryable list-level error instead of an empty list that looks
        // like "no jobs matched".
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load jobs.");
      } finally {
        if (active) {
          setLoadedKey(requestKey);
          setInitialLoaded(true);
        }
      }
    })();
    return () => {
      active = false;
    };
    // `effective` is derived from `key`; depending on the key alone avoids a request when only an object identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, applyFirstPage]);

  const loadMore = useCallback(async () => {
    if (!page?.hasMore || !page.nextCursor || moreInFlight.current) return;
    moreInFlight.current = true;
    setLoadingMore(true);
    setMoreError("");
    const requestKey = keyRef.current;
    try {
      const result = await api<JobsResponse>(`/jobs?${jobsParams(effective, JOBS_PAGE_SIZE, page.nextCursor)}`);
      if (requestKey !== keyRef.current) return; // the filters changed while this was in flight: it belongs to a list that is gone
      setJobs((current) => {
        const seen = new Set(current.map((job) => job.id));
        return [...current, ...result.jobs.filter((job) => !seen.has(job.id))];
      });
      setPage(readPage(result));
    } catch {
      if (requestKey === keyRef.current) setMoreError("Could not load more jobs.");
    } finally {
      moreInFlight.current = false;
      setLoadingMore(false);
    }
  }, [page, effective]);

  /** Start over from the first page (explicit retry, or after discovery/refresh changed what the server returns). */
  const reload = useCallback(async (): Promise<boolean> => {
    try {
      const result = await api<JobsResponse>(`/jobs?${jobsParams(effective, JOBS_PAGE_SIZE)}`);
      applyFirstPage(result);
      setLoadedKey(keyRef.current);
      setInitialLoaded(true);
      return true;
    } catch {
      return false;
    }
  }, [effective, applyFirstPage]);

  /**
   * Re-read the jobs already on screen and update their SCORES in place. The order and the set of jobs stay as they are, so
   * a score that finishes calculating never moves a card under the reader. (A new request would re-rank; that happens on the
   * next explicit reload.)
   */
  const refreshScores = useCallback(async (): Promise<boolean> => {
    try {
      const limit = Math.min(MAX_LIMIT, Math.max(JOBS_PAGE_SIZE, jobs.length));
      const result = await api<JobsResponse>(`/jobs?${jobsParams(effective, limit)}`);
      const fresh = new Map(result.jobs.map((job) => [job.id, job]));
      setJobs((current) => current.map((job) => (fresh.has(job.id) ? { ...job, match: fresh.get(job.id)?.match ?? job.match } : job)));
      setProfileComplete(result.profile_complete);
      return true;
    } catch {
      return false;
    }
  }, [effective, jobs.length]);

  /** Show a full list that has no paging block (discover/refresh against an older API). */
  const showLegacyList = useCallback((list: Job[], complete: boolean) => {
    setJobs(list);
    setPage(null);
    setProfileComplete(complete);
    setError("");
  }, []);

  const status: JobsFeedStatus = !initialLoaded ? "bootstrapping" : error ? "error" : "loaded";
  return {
    jobs,
    setJobs,
    /** True when the server ranked and paged this list; false for a legacy full list. */
    serverRanked: page !== null,
    total: page?.total ?? null,
    hasMore: page?.hasMore ?? false,
    status,
    /** A changed filter is loading while the previous results are still shown. */
    refetching: initialLoaded && loadedKey !== key,
    loadingMore,
    moreError,
    profileComplete,
    setProfileComplete,
    loadMore,
    reload,
    refreshScores,
    showLegacyList
  };
}
