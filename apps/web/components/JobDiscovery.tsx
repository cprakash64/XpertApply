"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2, RefreshCw, Search, X } from "lucide-react";
import {
  api,
  ApiError,
  type DiscoverySummary,
  type GeneratedDocument,
  type Job,
  type JobsResponse,
  type RefreshSummary
} from "@/lib/api";
import { useJobsQuery, type JobsQuery } from "@/lib/jobsQuery";
import { useJobsFeed } from "@/lib/useJobsFeed";
import { LoadMore } from "@/components/jobs/LoadMore";
import { Alert, Button } from "@/components/ui";
import { useAppShell } from "@/components/AppShell";
import { AutoApplyModal } from "@/components/AutoApplyModal";
import type { TrackerApplication, TrackerStatus } from "@/components/TrackerClient";
import { CompactJobCard, JobCard, type JobCardActions } from "@/components/jobs/JobCard";
import {
  DocumentGenerationModal,
  DocumentModal,
  type DocType
} from "@/components/jobs/documents";
import { JobDetailPanel, useEscapeToClose, type DetailTab } from "@/components/jobs/JobDetailPanel";
import { JobsFilterBar } from "@/components/jobs/JobsFilterBar";
import { MarkAppliedDialog } from "@/components/jobs/MarkAppliedDialog";
import { dateValue, daysAgo } from "@/components/jobs/format";
import { APPLIED_TOAST, confirmApplied, nextSelectionAfterRemoval } from "@/lib/markApplied";

/**
 * The Jobs workspace.
 *
 * One component owns the list, the selection, and the detail view, because they
 * are one screen: opening a job collapses the app sidebar and splits the
 * workspace into a compact list and a large detail panel, without leaving the
 * page or unmounting the list. The open job lives in the URL, so reload, Back,
 * Forward, and a shared link all resolve to the same state.
 */
export function JobDiscovery() {
  const { query, setQuery, selectJob, closeJob } = useJobsQuery();
  const shell = useAppShell();

  // The list is ranked, filtered and paged by the SERVER (see `useJobsFeed`). The FIRST request is a distinct state from
  // "the list is empty": nothing may render a terminal empty state until the first response lands, which is the cold-refresh
  // defect this guards against.
  const feed = useJobsFeed(query);
  const { jobs, setJobs, profileComplete, setProfileComplete } = feed;
  const listLoaded = feed.status !== "bootstrapping";
  const listError = feed.status === "error" ? "Could not load jobs." : "";
  const [hasDiscovered, setHasDiscovered] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  const [applyJobId, setApplyJobId] = useState<number | null>(null);
  const [docModal, setDocModal] = useState<{ doc: GeneratedDocument; subtitle: string } | null>(null);
  const [documents, setDocuments] = useState<Record<number, Partial<Record<DocType, GeneratedDocument>>>>({});
  const [generating, setGenerating] = useState<{ jobId: number; type: DocType } | null>(null);
  const [tracker, setTracker] = useState<Record<number, TrackerStatus>>({});

  // The active tab is stored against the job it belongs to, so switching jobs
  // resolves to Overview during the *first* render of the new job rather than
  // in an effect afterwards. That ordering matters: a Networking tab left
  // mounted for even one commit would read the new job's people.
  const [tabState, setTabState] = useState<{ jobId: number | null; tab: DetailTab }>({
    jobId: null,
    tab: "overview"
  });
  const listScroll = useRef(0);
  const generatingRef = useRef(false);

  const selectedId = query.job;
  const detailOpen = selectedId !== null;

  // The app sidebar becomes a slim brand rail while a job is open, and returns
  // when the workspace closes. The user's own toggle still wins until then.
  useEffect(() => {
    shell?.requestCollapsed(detailOpen);
  }, [detailOpen, shell]);

  // A changed filter or window re-requests from the server while the previous results stay on screen.
  const dateRefreshing = feed.refetching;

  // Re-read after an action changes what the server would return (a confirmed application is now excluded for this user).
  // Scores are patched in place; the list is not re-ranked under the reader.
  const refreshJobs = feed.refreshScores;

  // Saved/applied state comes from the user's own ledger, so a card can show it
  // without every card asking for it.
  const loadTracker = useCallback(async () => {
    try {
      const result = await api<{ applications?: TrackerApplication[] }>("/jobs/tracker/all");
      const next: Record<number, TrackerStatus> = {};
      for (const application of result.applications ?? []) {
        next[application.job_id] = application.status;
      }
      setTracker(next);
    } catch {
      // The list is fully usable without tracker decoration.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadTracker();
    })();
  }, [loadTracker]);

  // Controlled polling: while any visible job is still being scored in the
  // background, re-fetch the list on a light interval so "Calculating fit…"
  // resolves into a real score without a manual refresh. Polling STOPS as soon
  // as no visible score is pending, so a fully-scored list never polls.
  const hasPendingScores = useMemo(
    () =>
      jobs.some((job) => {
        const state = job.match?.score_state ?? (job.match?.fit_score == null ? "pending" : "scored");
        return state === "pending" || state === "scoring";
      }),
    [jobs]
  );

  const { refreshScores } = feed;
  useEffect(() => {
    if (!hasPendingScores) {
      return;
    }
    const timer = setTimeout(() => void refreshScores(), 4000);
    return () => clearTimeout(timer);
  }, [hasPendingScores, refreshScores, jobs]);

  /**
   * The one explicit state the workspace is in. Every branch below renders from
   * this, so there is no path where an async state paints an empty shell.
   *
   * `bootstrapping` is the state the cold-refresh defect lived in: it is NOT
   * `empty`, and must never render an empty state or a "no results" message.
   */
  const workspaceState: "bootstrapping" | "error" | "empty" | "loaded" = !listLoaded
    ? "bootstrapping"
    : listError
      ? "error"
      : jobs.length === 0
        ? "empty"
        : "loaded";
  const bootstrapping = workspaceState === "bootstrapping";

  // The server has already filtered and ranked what it returned, so that list is shown as it arrived. Only a legacy full list
  // (no `page` block: an older API, or a discover/refresh response) is filtered and ordered here, as it always was.
  const { serverRanked } = feed;
  const filtered = useMemo(() => {
    if (serverRanked) return jobs;
    // Filtering "posted within N days" is inherently time-dependent.
    const now = Date.now();
    return jobs
      .filter((job) => {
        const haystack = `${job.title} ${job.description_clean} ${job.required_skills.join(" ")}`.toLowerCase();
        const fit = job.match?.fit_score ?? 0;
        const withinDays = daysAgo(job.posted_at, now);
        return (
          (!query.q || haystack.includes(query.q.toLowerCase())) &&
          (!query.workplace || (job.workplace_type || "").toLowerCase() === query.workplace) &&
          fit >= query.minFit &&
          (withinDays === null || withinDays <= query.postedWithin)
        );
      })
      .sort((a, b) => {
        if (query.sort === "fit") {
          return (b.match?.fit_score ?? -1) - (a.match?.fit_score ?? -1);
        }
        const postedDifference = dateValue(b.posted_at) - dateValue(a.posted_at);
        return postedDifference || (b.match?.fit_score ?? -1) - (a.match?.fit_score ?? -1);
      });
  }, [serverRanked, jobs, query.q, query.workplace, query.minFit, query.postedWithin, query.sort]);

  const jobFromList = useMemo(
    () => (selectedId === null ? null : jobs.find((job) => job.id === selectedId) ?? null),
    [jobs, selectedId]
  );

  // A deep link (or a job filtered out of the current list) is fetched on its
  // own, once, after the list has had its chance to supply it. Both pieces of
  // state are tagged with the job they describe, so a stale response or an old
  // error can never be shown against the job now open.
  const [fetchedJob, setFetchedJob] = useState<Job | null>(null);
  const [detailAttempt, setDetailAttempt] = useState<{ jobId: number; error: string } | null>(null);

  const detailResolved =
    selectedId !== null && (fetchedJob?.id === selectedId || detailAttempt?.jobId === selectedId);
  const needsDetailFetch = selectedId !== null && !jobFromList && listLoaded && !detailResolved;

  useEffect(() => {
    if (!needsDetailFetch || selectedId === null) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await api<{ job: Job }>(`/jobs/${selectedId}`, { signal: controller.signal });
        setFetchedJob(result.job);
        setDetailAttempt({ jobId: selectedId, error: "" });
      } catch (loadError) {
        if (loadError instanceof ApiError && loadError.code === "request_cancelled") {
          return;
        }
        setDetailAttempt({
          jobId: selectedId,
          error:
            loadError instanceof ApiError && loadError.code === "not_found"
              ? "This job is no longer listed."
              : "This job could not be loaded."
        });
      }
    })();
    // Any in-flight detail request for a job the user has moved away from is
    // dropped, so a slow response can never overwrite the current job.
    return () => controller.abort();
  }, [needsDetailFetch, selectedId]);

  const selectedJob = jobFromList ?? (fetchedJob?.id === selectedId ? fetchedJob : null);
  const detailLoading = selectedId !== null && !selectedJob && (!listLoaded || needsDetailFetch);
  const detailError = detailAttempt?.jobId === selectedId ? detailAttempt.error : "";

  const tab: DetailTab = tabState.jobId === selectedId ? tabState.tab : "overview";
  const setTab = useCallback(
    (next: DetailTab) => setTabState({ jobId: selectedId, tab: next }),
    [selectedId]
  );

  const selectedIndex = useMemo(
    () => (selectedId === null ? -1 : filtered.findIndex((job) => job.id === selectedId)),
    [filtered, selectedId]
  );

  const openJob = useCallback(
    (jobId: number, targetTab?: DetailTab) => {
      if (typeof window !== "undefined") {
        listScroll.current = window.scrollY;
      }
      // Claiming the tab for the job being opened means the panel's first
      // render already shows the right section.
      setTabState({ jobId, tab: targetTab ?? "overview" });
      selectJob(jobId);
    },
    [selectJob]
  );

  // Returning to the list puts the user back where they were reading.
  useEffect(() => {
    if (detailOpen || typeof window === "undefined" || !listScroll.current) {
      return;
    }
    const offset = listScroll.current;
    listScroll.current = 0;
    window.scrollTo(0, offset);
  }, [detailOpen]);

  async function findFreshJobs() {
    setDiscovering(true);
    setError("");
    setMessage("Searching official/public job sources…");
    setWarnings([]);
    try {
      const result = await api<JobsResponse>("/jobs/discover", {
        method: "POST",
        body: JSON.stringify({ posted_within_days: query.postedWithin })
      });
      await showDiscoveredJobs(result);
      setHasDiscovered(true);
      applyDiscoverySummary(result.discovery);
    } catch (discoverError) {
      setError(discoverError instanceof Error ? discoverError.message : "Job discovery failed.");
      setMessage("");
    } finally {
      setDiscovering(false);
    }
  }

  /**
   * After discover or refresh. A response carrying a `page` block was ranked by the server for its default order, so the list
   * is re-read through the paged endpoint with the user's own filters and sort; a response without one is a legacy full list
   * and is shown as returned.
   */
  async function showDiscoveredJobs(result: { jobs: Job[]; profile_complete: boolean; page?: unknown }) {
    if (result.page) {
      setProfileComplete(result.profile_complete);
      if (!(await feed.reload())) feed.showLegacyList(result.jobs, result.profile_complete);
      return;
    }
    feed.showLegacyList(result.jobs, result.profile_complete);
  }

  function applyDiscoverySummary(discovery?: DiscoverySummary) {
    setWarnings(summarizeSourceWarnings(discovery?.source_warnings ?? []));
    if (!discovery) {
      setMessage("");
      return;
    }
    const eligible = discovery.eligible ?? discovery.fresh;
    setMessage(`Showing ${eligible} job(s) matched to your profile.`);
  }

  async function refreshMatches() {
    setRefreshing(true);
    setError("");
    setMessage("Re-scoring jobs against your profile…");
    try {
      const result = await api<{ jobs: Job[]; summary: RefreshSummary; profile_complete: boolean; page?: unknown }>(
        `/jobs/refresh-matches?posted_within_days=${query.postedWithin}`,
        { method: "POST" }
      );
      await showDiscoveredJobs(result);
      setWarnings(summarizeSourceWarnings(result.summary.source_warnings ?? []));
      setMessage(`Re-scored ${result.summary.rescored_count} jobs · ${result.summary.matched_count} match your profile.`);
    } catch (refreshError) {
      if (process.env.NODE_ENV === "development") {
        console.error("refresh-matches failed", refreshError);
      }
      const raw = refreshError instanceof Error ? refreshError.message : "";
      // A readable backend message (e.g. the 422 profile message) is shown as-is;
      // opaque network errors become a friendly retry message.
      setError(raw && !/failed to fetch/i.test(raw) ? raw : "Could not refresh matches. Please try again.");
    } finally {
      setRefreshing(false);
    }
  }

  const jobById = useCallback(
    (jobId: number) => jobs.find((job) => job.id === jobId) ?? (fetchedJob?.id === jobId ? fetchedJob : null),
    [jobs, fetchedJob]
  );

  const generateDocument = useCallback(
    async (jobId: number, type: DocType) => {
      const job = jobById(jobId);
      // A ref, not the state, so a second click cannot slip through before the
      // re-render — and so the card callbacks stay referentially stable.
      if (!job || generatingRef.current) {
        return;
      }
      generatingRef.current = true;
      setGenerating({ jobId, type });
      setError("");
      try {
        const path = type === "resume" ? `/jobs/${jobId}/generate-resume` : `/jobs/${jobId}/generate-cover-letter`;
        const doc = await api<GeneratedDocument>(path, { method: "POST" });
        setDocuments((current) => ({ ...current, [jobId]: { ...current[jobId], [type]: doc } }));
        setDocModal({ doc, subtitle: `${job.title} · ${job.company}` });
      } catch (genError) {
        if (process.env.NODE_ENV === "development") {
          console.error("document generation failed", genError);
        }
        setError("Could not generate this document. Please check that your profile has enough information.");
      } finally {
        generatingRef.current = false;
        setGenerating(null);
      }
    },
    [jobById]
  );

  // --- Confirmed application → Tracker ------------------------------------ //
  // Opening the employer site never reaches this. Only an explicit user
  // confirmation (this dialog) or an extension-confirmed submission does.
  // The job's own details are held here rather than looked up from `jobs`,
  // because the optimistic removal takes it out of that list while the request
  // is still in flight — a lookup would unmount the dialog mid-submit.
  const [markApplied, setMarkApplied] = useState<{
    id: number;
    title: string;
    company: string;
  } | null>(null);
  const [markingApplied, setMarkingApplied] = useState(false);
  const [markAppliedError, setMarkAppliedError] = useState("");
  // A ref, not state, so a double-click cannot slip a second request through
  // before React re-renders with the disabled button.
  const markingRef = useRef(false);

  const confirmMarkApplied = useCallback(async () => {
    const jobId = markApplied?.id ?? null;
    if (jobId === null || markingRef.current) {
      return;
    }
    markingRef.current = true;
    setMarkingApplied(true);
    setMarkAppliedError("");

    // Everything needed to put the workspace back exactly as it was.
    const previousJobs = jobs;
    const previousTracker = tracker;
    const previousSelection = selectedId;
    const nextSelection = nextSelectionAfterRemoval(filtered, jobId);

    // Optimistic: the card goes immediately, and the selection moves with it so
    // the detail pane is never left rendering a job that is no longer listed.
    setJobs((current) => current.filter((entry) => entry.id !== jobId));
    setTracker((current) => ({ ...current, [jobId]: "applied" }));
    if (previousSelection === jobId) {
      if (nextSelection === null) {
        // No job left to show: close to an intentional empty state and drop
        // ?job= from the URL, rather than leaving a dangling selection.
        closeJob();
      } else {
        selectJob(nextSelection);
        setTabState({ jobId: nextSelection, tab: "overview" });
      }
    }

    try {
      await confirmApplied(jobId);
      setMarkApplied(null);
      setError("");
      setMessage(APPLIED_TOAST);
      // Reconcile with the server: the optimistic state was a prediction, and
      // the server list is the answer. This is also what makes the removal
      // survive a refresh — the job is filtered out server-side now.
      await Promise.all([refreshJobs(), loadTracker()]);
    } catch (confirmError) {
      // The transaction did not succeed, so nothing may look as if it did:
      // both caches and the selection go back.
      setJobs(previousJobs);
      setTracker(previousTracker);
      if (previousSelection !== null) {
        selectJob(previousSelection);
      }
      setMarkAppliedError(
        confirmError instanceof ApiError && confirmError.message
          ? confirmError.message
          : "Could not mark this application as applied. Please try again."
      );
    } finally {
      markingRef.current = false;
      setMarkingApplied(false);
    }
  }, [markApplied, jobs, tracker, selectedId, filtered, closeJob, selectJob, refreshJobs, loadTracker, setJobs]);

  const cancelMarkApplied = useCallback(() => {
    // Cancelling changes nothing at all: no request, no list change, no status.
    if (markingRef.current) return;
    setMarkApplied(null);
    setMarkAppliedError("");
  }, []);

  const openMarkApplied = useCallback(
    (jobId: number) => {
      const job = jobById(jobId);
      if (!job) return;
      setMarkAppliedError("");
      setMarkApplied({ id: job.id, title: job.title, company: job.company });
    },
    [jobById]
  );

  const saveJob = useCallback(async (jobId: number) => {
    try {
      const result = await api<{ tracker: { status: TrackerStatus } }>(`/jobs/${jobId}/save`, { method: "POST" });
      setTracker((current) => ({ ...current, [jobId]: result.tracker?.status ?? "saved" }));
      setMessage("Job saved to your tracker.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save job.");
    }
  }, []);

  const cardActions = useMemo<JobCardActions>(
    () => ({
      onSelect: (jobId) => openJob(jobId),
      onSave: (jobId) => void saveJob(jobId),
      onApply: (jobId) => setApplyJobId(jobId),
      onGenerate: (jobId, type) => void generateDocument(jobId, type),
      onOpenPeople: (jobId) => openJob(jobId, "networking")
    }),
    [openJob, saveJob, generateDocument]
  );

  const applyJob = applyJobId === null ? null : jobById(applyJobId);
  const modalOpen = Boolean(applyJob || docModal || generating || markApplied);
  useEscapeToClose(detailOpen && !modalOpen, closeJob);

  const busy = discovering || refreshing;
  const onFilterChange = useCallback((patch: Partial<JobsQuery>) => setQuery(patch, "replace"), [setQuery]);

  // A count is only truthful once a response has actually landed. While
  // bootstrapping "0 jobs for you" is false, and after a failed request it is
  // equally false — the answer is unknown, not zero.
  // The server's total counts every matching job, not only the pages loaded so far.
  const shownTotal = feed.total ?? filtered.length;
  const resultSummary = bootstrapping
    ? "Loading jobs…"
    : workspaceState === "error"
      ? "Jobs unavailable"
      : `${shownTotal} job${shownTotal === 1 ? "" : "s"} for you`;

  /** Explicit "Try again" from the error state. Returns to `bootstrapping`
   * (skeleton) rather than leaving the failed empty list on screen. */
  const { reload: reloadFeed } = feed;
  const reloadJobs = useCallback(() => {
    void reloadFeed();
  }, [reloadFeed]);

  const modals = (
    <>
      {generating && (
        <DocumentGenerationModal type={generating.type} job={jobById(generating.jobId)} />
      )}
      {docModal && <DocumentModal doc={docModal.doc} subtitle={docModal.subtitle} onClose={() => setDocModal(null)} />}
      {applyJob && (
        <AutoApplyModal
          jobId={applyJob.id}
          jobTitle={applyJob.title}
          company={applyJob.company}
          officialUrl={applyJob.application_url}
          onMarkApplied={() => {
            setApplyJobId(null);
            openMarkApplied(applyJob.id);
          }}
          onClose={() => {
            setApplyJobId(null);
            // Closing the apply modal deliberately does NOT mark anything
            // applied — it only re-reads the ledger, which an extension
            // confirmation may have updated in the meantime.
            void loadTracker();
            void refreshJobs();
          }}
        />
      )}
      {markApplied && (
        <MarkAppliedDialog
          jobTitle={markApplied.title}
          company={markApplied.company}
          submitting={markingApplied}
          error={markAppliedError}
          onConfirm={() => void confirmMarkApplied()}
          onCancel={cancelMarkApplied}
        />
      )}
    </>
  );

  if (detailOpen) {
    return (
      // Exactly two scroll regions live below: the compact list and the detail
      // panel. This container is pinned to the viewport and never scrolls, and
      // AppShell pins the document behind it.
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <p role="status" aria-live="polite" className="sr-only">
          {selectedJob ? `Showing ${selectedJob.title} at ${selectedJob.company}` : "Loading job details"}
        </p>
        {/* Confirmations that happen inside the workspace (notably moving a job
          * to the Tracker) need to be visible HERE — the list view's message
          * strip is not rendered while a job is open. */}
        {message && (
          <div
            role="status"
            aria-live="polite"
            className="shrink-0 border-b border-status-success-border bg-status-success-surface px-5 py-2 text-sm text-status-success"
          >
            {message}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <aside
            aria-label="Job results"
            className="hidden w-[304px] shrink-0 flex-col border-r border-line-default bg-surface-page md:flex lg:w-[340px]"
          >
            <div className="shrink-0 px-3 pb-2.5 pt-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-foreground-muted" />
                  <input
                    aria-label="Role or skill"
                    className="ds-focus-ring ds-field h-9 w-full rounded-control border border-line-strong bg-surface-card pl-9 pr-3 text-sm text-foreground"
                    placeholder="Search role or skill"
                    value={query.q}
                    onChange={(event) => onFilterChange({ q: event.target.value })}
                  />
                </div>
                <button
                  type="button"
                  onClick={closeJob}
                  aria-label="Show all jobs"
                  title="Show all jobs"
                  className="ds-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-control text-foreground-muted transition-colors duration-fast hover:bg-surface-subtle hover:text-foreground-secondary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-2.5 px-0.5 text-xs text-foreground-muted">{resultSummary}</p>
            </div>
            <CompactJobList
              jobs={filtered}
              selectedId={selectedId}
              tracker={tracker}
              state={workspaceState}
              onRetry={reloadJobs}
              onSelect={(jobId) => openJob(jobId)}
              foot={
                <LoadMore
                  compact
                  hasMore={feed.hasMore}
                  loading={feed.loadingMore}
                  error={feed.moreError}
                  onLoadMore={() => void feed.loadMore()}
                  loadedCount={filtered.length}
                  total={feed.total}
                />
              }
            />
          </aside>

          <section className="min-w-0 flex-1 bg-surface-page">
            <JobDetailPanel
              key={selectedId}
              job={selectedJob}
              loading={detailLoading}
              error={detailError || error}
              tab={tab}
              onTabChange={setTab}
              trackerStatus={selectedJob ? tracker[selectedJob.id] ?? null : null}
              generating={generating?.jobId === selectedId ? generating.type : null}
              documents={selectedId !== null ? documents[selectedId] ?? {} : {}}
              onClose={closeJob}
              onSave={() => selectedJob && void saveJob(selectedJob.id)}
              onApply={() => selectedJob && setApplyJobId(selectedJob.id)}
              onMarkApplied={() => selectedJob && openMarkApplied(selectedJob.id)}
              onGenerate={(type) => selectedJob && void generateDocument(selectedJob.id, type)}
              onPreviewDocument={(doc) =>
                selectedJob && setDocModal({ doc, subtitle: `${selectedJob.title} · ${selectedJob.company}` })
              }
              onPrevious={
                selectedIndex > 0 ? () => openJob(filtered[selectedIndex - 1].id) : null
              }
              onNext={
                selectedIndex >= 0 && selectedIndex < filtered.length - 1
                  ? () => {
                      // Reaching the last loaded job pulls the next page, so "Next" never dead-ends while more exist.
                      if (selectedIndex + 2 >= filtered.length && feed.hasMore) void feed.loadMore();
                      openJob(filtered[selectedIndex + 1].id);
                    }
                  : null
              }
              position={selectedIndex >= 0 ? `${selectedIndex + 1} of ${shownTotal}` : null}
            />
          </section>
        </div>
        {modals}
      </div>
    );
  }

  return (
    <div className="w-full pb-16">
      {/* The active navigation item already names this page; the h1 stays for screen readers and the document outline. */}
      <h1 className="sr-only">Jobs</h1>

      {/* The navbar spans the whole workspace; everything below it shares one deliberate max width (wide enough for
        * the rows, capped so a 4K display does not stretch a job across the room). */}
      <JobsFilterBar
        query={query}
        onChange={onFilterChange}
        dateRefreshing={dateRefreshing}
        summary={resultSummary}
        actions={
          <>
            <Button type="button" variant="sapphire" size="sm" className="whitespace-nowrap max-sm:gap-1.5 max-sm:px-1.5 max-sm:text-[13px]" onClick={findFreshJobs} disabled={busy}>
              {discovering ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Search aria-hidden className="h-4 w-4" />} Find fresh jobs
            </Button>
            <Button type="button" variant="ghost" size="sm" className="whitespace-nowrap max-sm:gap-1.5 max-sm:px-1.5 max-sm:text-[13px]" onClick={refreshMatches} disabled={busy}>
              {refreshing ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden className="h-4 w-4" />} Refresh matches
            </Button>
          </>
        }
      />

      <div className="mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8">
      {(message || error) && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {message && <p className="text-sm text-foreground-muted">{message}</p>}
          {error && <p className="text-sm font-medium text-status-danger">{error}</p>}
        </div>
      )}

      {!profileComplete && (
        <Alert tone="warning" className="mt-5" title="Complete your profile to discover better jobs.">
          Add target roles and skills on your{" "}
          <Link className="ds-focus-ring rounded-control font-semibold underline" href="/profile">
            profile
          </Link>{" "}
          so we can match jobs to you. You can still run a basic search with what you have.
        </Alert>
      )}

      {warnings.length > 0 && (
        <Alert tone="warning" className="mt-5" title="A small number of sources are temporarily unavailable">
          <ul className="mt-1 list-disc pl-5 leading-6">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Alert>
      )}

      {hasDiscovered && filtered.length > 0 && filtered.length < 10 && (
        <p className="mt-2 text-sm text-foreground-muted">
          Only a few strict matches — add target roles or locations to broaden results.
        </p>
      )}

      <div className="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
        {/* Bootstrapping renders a skeleton, never an empty state: telling the
          * user "no jobs matched" before the first response has landed is the
          * cold-refresh defect, and it is indistinguishable from a broken page. */}
        {bootstrapping &&
          [0, 1, 2].map((row) => (
            <div
              key={row}
              data-testid="job-card-skeleton"
              aria-hidden="true"
              className="animate-pulse rounded-card border border-line-default bg-surface-card p-5"
            >
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 shrink-0 rounded-control bg-skeleton" />
                <div className="min-w-0 flex-1">
                  <div className="h-3.5 w-28 rounded bg-skeleton" />
                  <div className="mt-3 h-5 w-2/3 rounded bg-skeleton" />
                  <div className="mt-3 h-3.5 w-1/2 rounded bg-skeleton" />
                </div>
                <div className="h-16 w-24 shrink-0 rounded-card bg-skeleton" />
              </div>
            </div>
          ))}

        {!bootstrapping &&
          filtered.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              generating={generating?.jobId === job.id ? generating.type : null}
              trackerStatus={tracker[job.id] ?? null}
              actions={cardActions}
            />
          ))}

        {!bootstrapping && workspaceState === "loaded" && (
          <LoadMore
            hasMore={feed.hasMore}
            loading={feed.loadingMore}
            error={feed.moreError}
            onLoadMore={() => void feed.loadMore()}
            loadedCount={filtered.length}
            total={feed.total}
          />
        )}

        {workspaceState === "error" && (
          <div
            role="alert"
            className="rounded-card border border-status-danger-border bg-status-danger-surface px-6 py-10 text-center"
          >
            <p className="text-sm font-semibold text-status-danger">We couldn’t load your jobs.</p>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-foreground-muted">
              This is usually temporary. Your saved and applied jobs are unaffected.
            </p>
            <Button className="mt-4" variant="secondary" type="button" onClick={reloadJobs}>
              <RefreshCw aria-hidden className="h-4 w-4" /> Try again
            </Button>
          </div>
        )}

        {/* Two different problems, told apart by whether the *filters* emptied
          * the list. Jobs were loaded and the filters excluded all of them is a
          * one-click fix; an empty workspace is not, and offering "Clear
          * filters" there would be a dead end. */}
        {!bootstrapping && workspaceState !== "error" && filtered.length === 0 && (
          <div className="rounded-card border border-dashed border-line-default bg-surface-card px-6 py-14 text-center">
            {jobs.length > 0 ? (
              <>
                <p className="font-semibold text-foreground">No jobs match these filters</p>
                <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-foreground-muted">
                  {`${jobs.length} job${jobs.length === 1 ? " is" : "s are"} loaded, but none match the filters you have set.`}
                </p>
                <Button
                  className="mt-4"
                  variant="secondary"
                  type="button"
                  onClick={() => onFilterChange({ q: "", workplace: "", minFit: 0 })}
                >
                  Clear filters
                </Button>
              </>
            ) : (
              <p className="mx-auto max-w-sm text-sm leading-6 text-foreground-muted">
                {!profileComplete
                  ? "Complete your profile to discover better jobs."
                  : hasDiscovered
                    ? "No fresh jobs matched your selected roles, level, and locations. Try broadening your target roles or locations."
                    : "Click “Find fresh jobs” to pull recent postings matched to your profile."}
              </p>
            )}
          </div>
        )}
      </div>
      </div>
      {modals}
    </div>
  );
}

function CompactJobList({
  jobs,
  selectedId,
  tracker,
  state,
  onRetry,
  onSelect,
  foot
}: {
  jobs: Job[];
  selectedId: number | null;
  tracker: Record<number, TrackerStatus>;
  state: "bootstrapping" | "error" | "empty" | "loaded";
  onRetry: () => void;
  onSelect: (jobId: number) => void;
  foot?: React.ReactNode;
}) {
  const container = useRef<HTMLUListElement>(null);

  // Keep the open job visible when the selection moves from the detail panel
  // (previous/next) rather than from a click in this list.
  useEffect(() => {
    const selected = container.current?.querySelector('[data-selected="true"]');
    if (selected instanceof HTMLElement && typeof selected.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedId]);

  // The first request in flight is NOT "no results". Rendering skeleton rows
  // here is what keeps the cold-refresh workspace structurally correct instead
  // of showing an empty rail with a false "no jobs match" message.
  if (state === "bootstrapping") {
    return (
      <ul
        aria-busy="true"
        aria-label="Loading jobs"
        className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-3"
      >
        {[0, 1, 2, 3, 4].map((row) => (
          <li key={row} data-testid="compact-job-skeleton" className="px-1 py-1.5">
            <div className="animate-pulse rounded-card border border-line-default bg-surface-card p-3">
              <div className="h-3 w-1/3 rounded bg-skeleton" />
              <div className="mt-2 h-3.5 w-4/5 rounded bg-skeleton" />
              <div className="mt-2 h-3 w-1/2 rounded bg-skeleton" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul
      ref={container}
      className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-3"
    >
      {jobs.map((job) => (
        <CompactJobCard
          key={job.id}
          job={job}
          selected={job.id === selectedId}
          trackerStatus={tracker[job.id] ?? null}
          onSelect={onSelect}
        />
      ))}
      {state === "error" && jobs.length === 0 && (
        <li className="px-3 py-6 text-sm text-foreground-muted">
          <p className="text-status-danger">Could not load jobs.</p>
          <button
            type="button"
            onClick={onRetry}
            className="ds-focus-ring mt-2 inline-flex h-8 items-center rounded-control border border-line-strong bg-surface-card px-3 text-sm font-medium text-foreground-secondary hover:bg-surface-subtle"
          >
            Try again
          </button>
        </li>
      )}
      {state !== "error" && jobs.length === 0 && (
        <li className="px-3 py-6 text-sm text-foreground-muted">No jobs match the current filters.</li>
      )}
      {foot && <li>{foot}</li>}
    </ul>
  );
}

function summarizeSourceWarnings(warnings: string[]): string[] {
  const timeouts = warnings.filter((warning) => /TimeoutError|timed?\s*out/i.test(warning));
  const other = warnings.filter((warning) => !/TimeoutError|timed?\s*out/i.test(warning));
  const summary = timeouts.length > 0
    ? [`${timeouts.length} source${timeouts.length === 1 ? "" : "s"} responded too slowly. Jobs from all other sources are shown, and the daily refresh will retry automatically.`]
    : [];
  return [...summary, ...other.slice(0, 5)];
}
