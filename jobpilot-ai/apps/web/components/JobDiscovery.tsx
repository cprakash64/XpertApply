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
import { Button } from "@/components/Button";
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

  const [jobs, setJobs] = useState<Job[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  // The FIRST jobs request is a distinct state from "the list is empty".
  //
  // Root cause of the reported blank/broken workspace on a cold hard refresh:
  // `listLoaded` gated only the detail pane, so while the very first request
  // was still in flight the list rendered its terminal empty state — "0 jobs
  // for you / No jobs match the current filters" in the workspace, and "Click
  // Find fresh jobs" in the list view. On a warm reload that window is too
  // short to see, which is exactly why a second refresh appeared to "fix" it.
  // Nothing here may render a terminal state until the first response lands.
  const [listError, setListError] = useState("");
  const [profileComplete, setProfileComplete] = useState(true);
  const [hasDiscovered, setHasDiscovered] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  // Which posted-within window the currently shown list came from. Derived
  // rather than flagged, so the spinner cannot get stuck out of sync with the
  // window the user selected.
  const [loadedWindow, setLoadedWindow] = useState<number | null>(null);

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

  // Re-fetch from the server whenever the "Posted within" window changes so the
  // list actually reflects the selected range. The backend applies the date
  // filter — widening the window can surface jobs the server previously
  // withheld, which a client-only filter could never do.
  useEffect(() => {
    let active = true;
    const requestedWindow = query.postedWithin;
    void (async () => {
      try {
        const result = await api<JobsResponse>(`/jobs?posted_within_days=${requestedWindow}`);
        if (!active) return;
        setJobs(result.jobs);
        setProfileComplete(result.profile_complete);
        setListError("");
      } catch (loadError) {
        if (active) {
          // Recorded separately from the generic action error so the workspace
          // can render a retryable list-level error instead of an empty list
          // that looks like "no jobs matched".
          setListError(
            loadError instanceof Error ? loadError.message : "Could not load jobs."
          );
        }
      } finally {
        if (active) {
          setLoadedWindow(requestedWindow);
          setListLoaded(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [query.postedWithin]);

  const dateRefreshing = loadedWindow !== query.postedWithin;

  // Re-read the list from the server. Used after an action changes what the
  // server would return — notably a confirmed application, which the backend
  // now excludes from discovery for this user.
  const refreshJobs = useCallback(async (): Promise<boolean> => {
    try {
      const result = await api<JobsResponse>(`/jobs?posted_within_days=${query.postedWithin}`);
      setJobs(result.jobs);
      setProfileComplete(result.profile_complete);
      setListError("");
      return true;
    } catch {
      // Silent by design: this runs after a confirmed application, where the
      // optimistic state already reflects the change and the next load
      // reconciles. The caller decides whether a failure is worth surfacing —
      // `reloadJobs` (explicit "Try again") does surface it.
      return false;
    }
  }, [query.postedWithin]);

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

  useEffect(() => {
    if (!hasPendingScores) {
      return;
    }
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const result = await api<JobsResponse>(`/jobs?posted_within_days=${query.postedWithin}`);
        if (active) {
          setJobs(result.jobs);
        }
      } catch {
        // Transient; the next tick (or a manual action) will retry.
      }
    }, 4000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [hasPendingScores, query.postedWithin, jobs]);

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

  const filtered = useMemo(() => {
    // Filtering "posted within N days" is inherently time-dependent.
    // eslint-disable-next-line react-hooks/purity
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
  }, [jobs, query.q, query.workplace, query.minFit, query.postedWithin, query.sort]);

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
      setJobs(result.jobs);
      setProfileComplete(result.profile_complete);
      setHasDiscovered(true);
      applyDiscoverySummary(result.discovery);
    } catch (discoverError) {
      setError(discoverError instanceof Error ? discoverError.message : "Job discovery failed.");
      setMessage("");
    } finally {
      setDiscovering(false);
    }
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
      const result = await api<{ jobs: Job[]; summary: RefreshSummary; profile_complete: boolean }>(
        `/jobs/refresh-matches?posted_within_days=${query.postedWithin}`,
        { method: "POST" }
      );
      setJobs(result.jobs);
      setProfileComplete(result.profile_complete);
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
  }, [markApplied, jobs, tracker, selectedId, filtered, closeJob, selectJob, refreshJobs, loadTracker]);

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
  const resultSummary = bootstrapping
    ? "Loading jobs…"
    : workspaceState === "error"
      ? "Jobs unavailable"
      : `${filtered.length} job${filtered.length === 1 ? "" : "s"} for you`;

  /** Explicit "Try again" from the error state. Returns to `bootstrapping`
   * (skeleton) rather than leaving the failed empty list on screen. */
  const reloadJobs = useCallback(() => {
    setListLoaded(false);
    setListError("");
    void (async () => {
      const ok = await refreshJobs();
      if (!ok) setListError("Could not load jobs.");
      setListLoaded(true);
    })();
  }, [refreshJobs]);

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
            className="shrink-0 border-b border-line bg-[var(--success-surface)] px-5 py-2 text-sm text-[var(--accent)]"
          >
            {message}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <aside
            aria-label="Job results"
            className="hidden w-[304px] shrink-0 flex-col border-r border-line bg-[var(--background)] md:flex lg:w-[340px]"
          >
            <div className="shrink-0 px-3 pb-2.5 pt-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[var(--text-muted)]" />
                  <input
                    aria-label="Role or skill"
                    className="h-9 w-full rounded-lg border border-line bg-panel/40 pl-9 pr-3 text-sm"
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
                  className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-panel hover:text-[var(--text-secondary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-2.5 px-0.5 text-xs text-[var(--text-muted)]">{resultSummary}</p>
            </div>
            <CompactJobList
              jobs={filtered}
              selectedId={selectedId}
              tracker={tracker}
              state={workspaceState}
              onRetry={reloadJobs}
              onSelect={(jobId) => openJob(jobId)}
            />
          </aside>

          <section className="min-w-0 flex-1 bg-[var(--background)]">
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
                  ? () => openJob(filtered[selectedIndex + 1].id)
                  : null
              }
              position={selectedIndex >= 0 ? `${selectedIndex + 1} of ${filtered.length}` : null}
            />
          </section>
        </div>
        {modals}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] px-5 pb-16 pt-8 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem] font-semibold tracking-[-0.02em]">Jobs</h1>
          <p className="mt-1.5 text-[15px] text-[var(--text-muted)]">
            Fresh roles matched to your profile, from official application sources.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={findFreshJobs} disabled={busy}>
            {discovering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Find fresh jobs
          </Button>
          <Button variant="secondary" type="button" onClick={refreshMatches} disabled={busy}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh matches
          </Button>
        </div>
      </header>

      {(message || error) && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {message && <p className="text-sm text-[var(--text-muted)]">{message}</p>}
          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
        </div>
      )}

      {!profileComplete && (
        <div className="mt-5 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-surface)] p-4 text-sm text-[var(--warning)]">
          <p className="font-semibold">Complete your profile to discover better jobs.</p>
          <p className="mt-1 leading-6">
            Add target roles and skills on your <Link className="font-medium text-pine underline" href="/profile">profile</Link> so we can
            match jobs to you. You can still run a basic search with what you have.
          </p>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-5 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-surface)] p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
            <div className="text-sm text-[var(--warning)]">
              <p className="font-semibold">A small number of sources are temporarily unavailable</p>
              <ul className="mt-1 list-disc pl-5 leading-6">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="mt-6">
        <JobsFilterBar query={query} onChange={onFilterChange} dateRefreshing={dateRefreshing} />
      </div>

      <div className="mt-5 flex flex-wrap items-baseline justify-between gap-2 text-sm text-[var(--text-muted)]">
        <p>
          <span className="font-medium text-[var(--text-secondary)]">{resultSummary}</span>
          {` · Posted in the last ${query.postedWithin === 1 ? "24 hours" : `${query.postedWithin} days`}`}
        </p>
        {hasDiscovered && filtered.length > 0 && filtered.length < 10 && (
          <p className="text-[var(--text-muted)]">
            Only a few strict matches — add target roles or locations to broaden results.
          </p>
        )}
      </div>

      <div className="mt-3.5 grid gap-3">
        {/* Bootstrapping renders a skeleton, never an empty state: telling the
          * user "no jobs matched" before the first response has landed is the
          * cold-refresh defect, and it is indistinguishable from a broken page. */}
        {bootstrapping &&
          [0, 1, 2].map((row) => (
            <div
              key={row}
              data-testid="job-card-skeleton"
              aria-hidden="true"
              className="animate-pulse rounded-2xl border border-line bg-white p-5"
            >
              <div className="h-3.5 w-28 rounded bg-line" />
              <div className="mt-3 h-5 w-2/3 rounded bg-line" />
              <div className="mt-3 h-3.5 w-1/2 rounded bg-line" />
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

        {workspaceState === "error" && (
          <div className="rounded-2xl border border-[var(--danger-border)] bg-[var(--danger-surface)] px-6 py-10 text-center">
            <p className="text-sm font-medium text-[var(--danger)]">We couldn’t load your jobs.</p>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-[var(--text-muted)]">
              This is usually temporary. Your saved and applied jobs are unaffected.
            </p>
            <Button className="mt-4" variant="secondary" type="button" onClick={reloadJobs}>
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          </div>
        )}

        {!bootstrapping && workspaceState !== "error" && filtered.length === 0 && (
          <div className="rounded-2xl border border-line bg-white px-6 py-14 text-center">
            <p className="mx-auto max-w-sm text-sm leading-6 text-[var(--text-muted)]">
              {!profileComplete
                ? "Complete your profile to discover better jobs."
                : hasDiscovered
                  ? "No fresh jobs matched your selected roles, level, and locations. Try broadening your target roles or locations."
                  : "Click “Find fresh jobs” to pull recent postings matched to your profile."}
            </p>
          </div>
        )}
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
  onSelect
}: {
  jobs: Job[];
  selectedId: number | null;
  tracker: Record<number, TrackerStatus>;
  state: "bootstrapping" | "error" | "empty" | "loaded";
  onRetry: () => void;
  onSelect: (jobId: number) => void;
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
            <div className="animate-pulse rounded-lg border border-line bg-panel/40 p-3">
              <div className="h-3 w-1/3 rounded bg-line" />
              <div className="mt-2 h-3.5 w-4/5 rounded bg-line" />
              <div className="mt-2 h-3 w-1/2 rounded bg-line" />
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
        <li className="px-3 py-6 text-sm text-[var(--text-muted)]">
          <p className="text-[var(--danger)]">Could not load jobs.</p>
          <button
            type="button"
            onClick={onRetry}
            className="focus-ring mt-2 inline-flex h-8 items-center rounded-lg border border-line bg-white px-3 text-sm font-medium text-[var(--text-secondary)] hover:bg-panel"
          >
            Try again
          </button>
        </li>
      )}
      {state !== "error" && jobs.length === 0 && (
        <li className="px-3 py-6 text-sm text-[var(--text-muted)]">No jobs match the current filters.</li>
      )}
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
