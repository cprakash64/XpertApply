"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BriefcaseBusiness,
  Download,
  ExternalLink,
  Loader2,
  Search
} from "lucide-react";
import Link from "next/link";
import { CompanyLogo } from "@/components/CompanyLogo";
import { FitScoreChip } from "@/components/jobs/badges";
import { Alert, Chip, StatusBadge } from "@/components/ui";
import {
  formatApplicationStatus,
  getApplicationStatusTone
} from "@/lib/applicationStatus";
import { api, downloadTrackerDocument, TrackerDownloadError, type Job, type TrackerDocumentKind } from "@/lib/api";
import { invalidateDashboardSummary } from "@/lib/dashboardSummary";

export type TrackerStatus =
  | "saved"
  | "ready_to_apply"
  | "applying"
  | "applied"
  | "interview"
  | "offer"
  | "rejected"
  | "withdrawn";

export type TrackerDocument = {
  id: number | null;
  title: string | null;
  created_at: string | null;
  /** The document XpertApply prepared for THIS application. A different claim from the next one. */
  prepared_for_application?: boolean;
  /** The extension reported attaching it to the employer's form. Never employer confirmation, and Applied does not imply it. */
  attached_by_extension?: boolean;
  /** An immutable copy made when the application was marked applied; false for older records (the saved copy as it is now). */
  frozen?: boolean;
  formats?: string[];
  /** "confirming_session" or "sole_session": the evidence that tied this document to this application. */
  association?: string;
  /** The download is the saved text re-rendered on request, not the byte stream once attached to an employer. */
  reproduction?: string;
};

/** Why the documents are what they are: an immutable copy, an older record's saved copy, an ambiguous history, or nothing. */
export type TrackerDocumentsAvailability = "frozen" | "historical" | "unknown_association" | "none";

/** Why nothing is available, when the server knows from stored facts. Never a guess: absent means "no reason recorded". */
export type TrackerDocumentsUnavailableReason =
  | "no_session"
  | "documents_not_prepared"
  | "job_documents_not_linked"
  | "unknown_association";

const UNAVAILABLE_REASON: Record<TrackerDocumentsUnavailableReason, string> = {
  no_session: "This application was recorded without an XpertApply session, so no documents were prepared for it.",
  documents_not_prepared: "XpertApply didn’t prepare a resume or cover letter for this application.",
  job_documents_not_linked: "Documents exist for this job, but nothing links them to this application.",
  unknown_association: "We can’t tell which saved documents were used for this application."
};

export type TrackerApplication = {
  id: number;
  job_id: number;
  status: TrackerStatus;
  notes?: string | null;
  applied_at?: string | null;
  /** How the submission was confirmed — see AppliedSource on the backend. */
  applied_source?: "extension_confirmed" | "auto_apply_confirmed" | "user_confirmed" | null;
  submission_reference?: string | null;
  opened_at?: string | null;
  application_url?: string | null;
  /** The tailored documents that were prepared for this application, if any. */
  documents?: { resume: TrackerDocument | null; cover_letter: TrackerDocument | null };
  documents_availability?: TrackerDocumentsAvailability;
  documents_unavailable_reason?: TrackerDocumentsUnavailableReason | null;
  created_at?: string | null;
  updated_at?: string | null;
  job: Pick<
    Job,
    | "id"
    | "title"
    | "company"
    | "company_domain"
    | "company_logo_url"
    | "company_logo_proxy_path"
    | "location"
    | "workplace_type"
    | "employment_type"
    | "posted_at"
    | "application_url"
    | "match"
  >;
};

type TrackerFilter = "all" | "applied" | "interview" | "offer" | "rejected";

const DOWNLOAD_ERROR: Record<string, string> = {
  not_available: "This document is no longer available.",
  unreadable: "This saved document can't be opened.",
  signed_out: "Your session expired. Sign in again to download.",
  unavailable: "Couldn't download. Check your connection and try again."
};

const DOCUMENT_LABEL: Record<TrackerDocumentKind, string> = { resume: "resume", cover_letter: "cover letter" };

/**
 * The documents prepared for one application, with a download for each.
 *
 * "Prepared for this application" and "attached on the employer's form" are different claims and are worded differently: the
 * second appears only when the extension reported attaching the file, and even then it is not the employer's confirmation.
 * A document that was never prepared or kept says "Not available" instead of offering a file that does not exist.
 */
function TrackerDocuments({ application }: { application: TrackerApplication }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<TrackerDocumentKind, string>>>({});

  async function download(kind: TrackerDocumentKind, format: "pdf" | "docx") {
    const key = `${kind}:${format}`;
    if (busy) return;
    setBusy(key);
    setErrors((current) => ({ ...current, [kind]: undefined }));
    try {
      await downloadTrackerDocument(application.id, kind, format);
    } catch (error) {
      const code = error instanceof TrackerDownloadError ? error.code : "unavailable";
      setErrors((current) => ({ ...current, [kind]: DOWNLOAD_ERROR[code] }));
    } finally {
      setBusy(null);
    }
  }

  const kinds: TrackerDocumentKind[] = ["resume", "cover_letter"];
  return (
    <div role="group" className="grid grid-cols-1 gap-3" aria-label={`Documents for ${application.job.title}`}>
      {kinds.map((kind) => {
        const doc = application.documents?.[kind] ?? null;
        const label = DOCUMENT_LABEL[kind];
        if (!doc) {
          return (
            <div key={kind} className="rounded-control border border-line-default px-3 py-2.5 text-xs text-foreground-muted">
              <span className="font-medium capitalize text-foreground-secondary">{label}</span>: Not available
              {application.documents_unavailable_reason && UNAVAILABLE_REASON[application.documents_unavailable_reason] && (
                <span className="block">{UNAVAILABLE_REASON[application.documents_unavailable_reason]}</span>
              )}
            </div>
          );
        }
        const loading = busy?.startsWith(`${kind}:`) ?? false;
        return (
          <div key={kind} className="rounded-control border border-line-default px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void download(kind, "pdf")}
                disabled={busy !== null}
                aria-label={`Download ${label} for ${application.job.title} at ${application.job.company}`}
                className="ds-focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-control bg-action-primary px-3 text-sm font-semibold text-action-primary-foreground transition duration-fast ease-standard hover:bg-action-primary-hover disabled:opacity-60"
              >
                {loading && busy?.endsWith("pdf") ? (
                  <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                ) : (
                  <Download aria-hidden className="h-4 w-4" />
                )}
                {loading ? "Preparing…" : `Download ${label}`}
              </button>
              {doc.formats?.includes("docx") && (
                <button
                  type="button"
                  onClick={() => void download(kind, "docx")}
                  disabled={busy !== null}
                  aria-label={`Download ${label} as Word document`}
                  className="ds-focus-ring inline-flex min-h-10 items-center whitespace-nowrap rounded-control border border-line-interactive px-3 text-sm font-medium text-foreground-secondary hover:border-line-strong disabled:opacity-60"
                >
                  Word
                </button>
              )}
            </div>
            <p className="mt-1.5 text-xs text-foreground-muted">
              {doc.frozen === false
                ? "Saved document prepared for this application (current saved copy; may have changed since)"
                : "Saved document prepared for this application"}
              {" · Re-created from the saved text, so the file can differ from the one you attached · "}
              {doc.attached_by_extension
                ? "XpertApply reported attaching it on the employer’s form (not confirmed by the employer)"
                : "Not confirmed as uploaded to the employer"}
            </p>
            {errors[kind] && (
              <p role="alert" className="mt-1 text-xs font-medium text-status-danger">
                {errors[kind]}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

const STATUS_OPTIONS: { value: TrackerStatus; label: string }[] = [
  { value: "applied", label: "Applied" },
  { value: "interview", label: "Interview" },
  { value: "offer", label: "Offer / selected" },
  { value: "rejected", label: "Rejected" }
];

/** Plain-language provenance, so "why is this in my Tracker?" has an answer. */
const APPLIED_SOURCE_LABEL: Record<string, string> = {
  extension_confirmed: "Confirmed by the XpertApply extension",
  auto_apply_confirmed: "Confirmed by assisted apply",
  user_confirmed: "You marked this as applied"
};

const FILTERS: { value: TrackerFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "applied", label: "Applied" },
  { value: "interview", label: "Interviews" },
  { value: "offer", label: "Offers" },
  { value: "rejected", label: "Rejected" }
];

/**
 * The shared card contract for this screen: border-first, no shadow, no gradient.
 * The Tracker is a list you scan, and a page of shadowed panels reads as noise
 * long before it reads as depth.
 */
const CARD = "rounded-card border border-line-default bg-surface-card";

/**
 * The Tracker owns its failure copy rather than echoing the transport's
 * normalized message, matching the Dashboard and the Jobs workspace.
 *
 * `/jobs/tracker/*` defines no user-facing failure wording of its own: what
 * reaches the client is either the API's safe catch-all or an infrastructure
 * `detail` written for an operator — the shared auth dependency answers a
 * database outage by naming the migration command to run. Neither belongs in a
 * red banner at the top of someone's application list.
 */
const LOAD_ERROR = "We couldn’t load your applications.";
const UPDATE_ERROR = "We couldn’t update that application. Please try again.";

type TrackerSort = "recent" | "oldest";
const SELECTED_STORAGE_KEY = "xa-tracker-selected";

/** The date an application is ordered and shown by: when it was applied, else when it was added. */
function applicationTime(application: TrackerApplication): number {
  const value = application.applied_at ?? application.created_at ?? application.updated_at ?? null;
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

function readStoredSelection(): number | null {
  try {
    const raw = window.sessionStorage.getItem(SELECTED_STORAGE_KEY);
    const id = raw ? Number(raw) : Number.NaN;
    return Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

function storeSelection(id: number): void {
  try {
    window.sessionStorage.setItem(SELECTED_STORAGE_KEY, String(id));
  } catch {
    /* selection simply is not remembered across reloads */
  }
}

export function TrackerClient() {
  const [applications, setApplications] = useState<TrackerApplication[]>([]);
  const [filter, setFilter] = useState<TrackerFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TrackerSort>("recent");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Below the desktop breakpoint only one panel is on screen: the list, or the
  // chosen application's details with a way back.
  const [detailOpen, setDetailOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api<{ applications: TrackerApplication[] }>("/jobs/tracker/submitted")
      .then((result) => {
        if (!active) return;
        setError("");
        setApplications(result.applications);
        const remembered = readStoredSelection();
        if (remembered !== null && result.applications.some((row) => row.id === remembered)) {
          setSelectedId(remembered);
        }
      })
      .catch(() => {
        if (!active) return;
        setError(LOAD_ERROR);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function update(application: TrackerApplication, status: TrackerStatus) {
    setUpdatingId(application.id);
    setError("");
    try {
      await api(`/jobs/${application.job_id}/tracker`, {
        method: "PUT",
        body: JSON.stringify({ status })
      });
      // A status move re-buckets this application on the Dashboard, so the
      // cached summary is no longer accurate.
      invalidateDashboardSummary();
      setApplications((current) =>
        current.map((row) =>
          row.id === application.id
            ? {
                ...row,
                status,
                applied_at:
                  row.applied_at ??
                  (["applied", "interview", "offer", "rejected"].includes(status)
                    ? new Date().toISOString()
                    : null)
              }
            : row
        )
      );
      setMessage(`Moved to ${statusLabel(status)}.`);
      window.setTimeout(() => setMessage(""), 2500);
    } catch {
      setError(UPDATE_ERROR);
    } finally {
      setUpdatingId(null);
    }
  }

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const rows = applications.filter((application) => {
      const matchesFilter = filter === "all" ? true : application.status === filter;
      const matchesQuery =
        !normalizedQuery ||
        `${application.job.title} ${application.job.company}`.toLowerCase().includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
    // Stable for equal dates: the server's order breaks ties.
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const delta = applicationTime(b.row) - applicationTime(a.row);
        return (sort === "recent" ? delta : -delta) || a.index - b.index;
      })
      .map(({ row }) => row);
  }, [applications, filter, query, sort]);

  // The chosen application when it is still listed; otherwise the first one, so
  // a filter or a search never leaves the details pointing at something hidden.
  const selected = visible.find((row) => row.id === selectedId) ?? visible[0] ?? null;

  function choose(application: TrackerApplication) {
    setSelectedId(application.id);
    storeSelection(application.id);
    setDetailOpen(true);
  }

  // Skeletons in the shape of the real thing, rather than a spinner that
  // occupies none of the eventual space: the toolbar, the list rows and the
  // details panel all land where their placeholder sat, so nothing jumps. The
  // request itself is untouched.
  if (loading) {
    return (
      <section aria-busy="true">
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3, 4].map((chip) => (
            <Skeleton key={chip} className="h-9 w-20 rounded-pill" />
          ))}
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] lg:gap-6">
          <div className={`${CARD} divide-y divide-line-subtle`}>
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-3 px-4 py-3">
                <Skeleton className="h-9 w-9 shrink-0 rounded-control" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-4 w-48 max-w-full" />
                  <Skeleton className="mt-2 h-3.5 w-28" />
                </div>
                <Skeleton className="h-6 w-20 rounded-pill" />
              </div>
            ))}
          </div>
          <div className={`${CARD} hidden p-6 md:block`}>
            <Skeleton className="h-6 w-64 max-w-full" />
            <Skeleton className="mt-3 h-4 w-40" />
            <Skeleton className="mt-8 h-10 w-full rounded-control" />
            <Skeleton className="mt-6 h-24 w-full rounded-control" />
          </div>
        </div>
        <span className="sr-only" role="status">Loading your applications…</span>
      </section>
    );
  }

  return (
    <section>
      {/* The stage-move confirmation is announced politely and the region is
          always present, so a screen reader hears the change as well as sees it. */}
      <p role="status" aria-live="polite" className={message ? "mb-3 text-sm font-medium text-status-success" : "sr-only"}>
        {message}
      </p>

      {applications.length > 0 && (
        // On a phone the filters belong to the list; while one application's details are open they would only push it down.
        <div className={`${detailOpen && selected ? "hidden" : "flex"} flex-col gap-3 md:flex md:flex-row md:items-center md:justify-between`}>
          {/* Chips, not custom buttons: a filter is a toggle, and the primitive
              carries `aria-pressed` plus the canonical selected treatment, so the
              active stage is announced rather than only coloured. */}
          <div
            role="group"
            aria-label="Application status filters"
            className="scroll-strip flex gap-1.5 overflow-x-auto"
          >
            {FILTERS.map((item) => (
              <Chip
                key={item.value}
                selected={filter === item.value}
                onClick={() => setFilter(item.value)}
                className="whitespace-nowrap"
              >
                {item.label}
              </Chip>
            ))}
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center md:w-auto">
            {/* The icon sits inside the control, which the Input primitive's chrome
                does not express — so this keeps its own markup and borrows the
                field's visual contract instead. */}
            <label className="relative block w-full sm:w-64">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted"
              />
              <span className="sr-only">Search applications</span>
              <input
                aria-label="Search applications"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search company or role"
                className="ds-field ds-focus-ring h-10 w-full rounded-field border border-line-interactive bg-surface-card pl-9 pr-3 text-sm text-foreground transition duration-fast ease-standard placeholder:text-foreground-muted hover:border-line-strong"
              />
            </label>
            {/* Quiet on purpose: the page is for the applications you already have. */}
            <Link
              href="/jobs"
              className="ds-focus-ring inline-flex h-10 shrink-0 items-center justify-center rounded-control px-3 text-sm font-medium text-foreground-link transition duration-fast ease-standard hover:bg-surface-subtle"
            >
              Find more jobs
            </Link>
          </div>
        </div>
      )}

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}

      {applications.length === 0 ? (
        <div className="mt-4 rounded-card border border-dashed border-line-default bg-surface-card px-6 py-14 text-center">
          <BriefcaseBusiness aria-hidden className="mx-auto h-9 w-9 text-foreground-muted" />
          <h2 className="mt-3 font-semibold text-foreground">No applications yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-foreground-muted">
            Applications appear here after you confirm that you submitted them.
          </p>
          {/* Only the genuinely empty tracker gets a call to action — a search
              that matched nothing needs a different query, not a new job. */}
          <Link
            className="ds-focus-ring mt-4 inline-flex h-10 items-center rounded-control bg-action-primary px-5 text-sm font-semibold text-action-primary-foreground transition duration-fast ease-standard hover:bg-action-primary-hover active:translate-y-px"
            href="/jobs"
          >
            Find jobs
          </Link>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2 md:items-start lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] lg:gap-6">
          <section
            aria-labelledby="tracked-applications-heading"
            className={`${detailOpen && selected ? "hidden" : ""} min-w-0 md:block`}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <h2 id="tracked-applications-heading" className="whitespace-nowrap text-sm font-semibold text-foreground">
                Tracked applications{" "}
                <span className="font-normal text-foreground-muted">({visible.length})</span>
              </h2>
              <label className="flex items-center gap-2 text-sm text-foreground-muted">
                <span className="hidden sm:inline">Sort by</span>
                <select
                  aria-label="Sort applications"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as TrackerSort)}
                  className="ds-field ds-focus-ring h-9 rounded-field border border-line-interactive bg-surface-card px-2 pr-7 text-sm font-medium text-foreground transition duration-fast ease-standard hover:border-line-strong"
                >
                  <option value="recent">Most recent</option>
                  <option value="oldest">Oldest first</option>
                </select>
              </label>
            </div>

            {visible.length === 0 ? (
              <div className={`${CARD} px-6 py-12 text-center`}>
                <h3 className="font-semibold text-foreground">No applications found</h3>
                <p className="mx-auto mt-1 max-w-md text-sm text-foreground-muted">
                  Try another status or search term.
                </p>
              </div>
            ) : (
              <ul aria-label="Tracked applications" className={`${CARD} divide-y divide-line-subtle overflow-hidden`}>
                {visible.map((application) => (
                  <li key={application.id}>
                    <ApplicationRow
                      application={application}
                      selected={selected?.id === application.id}
                      onSelect={() => choose(application)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-label="Selected application"
            className={`${detailOpen && selected ? "" : "hidden"} min-w-0 md:sticky md:top-6 md:block`}
          >
            {selected ? (
              <ApplicationDetail
                key={selected.id}
                application={selected}
                updating={updatingId === selected.id}
                onUpdate={(status) => update(selected, status)}
                onBack={() => setDetailOpen(false)}
              />
            ) : (
              <div className={`${CARD} px-6 py-12 text-center text-sm text-foreground-muted`}>
                Select an application to see its details.
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}

/**
 * One compact row. The whole row is a single button (no nested controls), so it is
 * one tab stop, one accessible name and one hit target; `aria-current` marks the
 * application whose details are open.
 */
function ApplicationRow({
  application,
  selected,
  onSelect
}: {
  application: TrackerApplication;
  selected: boolean;
  onSelect: () => void;
}) {
  const { job } = application;
  const when = application.applied_at ?? application.created_at ?? null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`ds-focus-ring flex w-full items-center gap-3 border-l-2 px-3 py-3 text-left transition-colors duration-fast ease-standard sm:px-4 ${
        selected
          ? "border-line-selected bg-surface-selected"
          : "border-transparent hover:bg-surface-subtle"
      }`}
    >
      {/* Decorative here: the company name is the adjacent text, so a screen reader
          should not also read "<company> generated company mark" in front of it. */}
      <span aria-hidden="true" className="shrink-0">
        <CompanyLogo
          company={job.company}
          logoUrl={job.company_logo_url}
          proxyPath={job.company_logo_proxy_path}
          companyDomain={job.company_domain}
          size={36}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold leading-snug text-foreground">{job.title}</span>
        {/* Secondary, not muted, on the selected row: the tint behind it lowers the contrast of the muted role below AA in dark mode. */}
        <span className={`block truncate text-sm ${selected ? "text-foreground-secondary" : "text-foreground-muted"}`}>{job.company}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {/* Tone from the shared domain module, wording from this screen. */}
        <StatusBadge tone={getApplicationStatusTone(application.status)}>
          {statusLabel(application.status)}
        </StatusBadge>
        {when && (
          <span className={`text-xs ${selected ? "text-foreground-secondary" : "text-foreground-muted"}`}>{formatDate(when)}</span>
        )}
      </span>
    </button>
  );
}

function ApplicationDetail({
  application,
  updating,
  onUpdate,
  onBack
}: {
  application: TrackerApplication;
  updating: boolean;
  onUpdate: (status: TrackerStatus) => void;
  onBack: () => void;
}) {
  const { job } = application;
  const fitScore = job.match?.fit_score;
  const statusId = `application-status-${application.id}`;
  const appliedLink = application.application_url;
  return (
    <article aria-labelledby={`application-title-${application.id}`} className={`${CARD} p-4 sm:p-6 md:p-4 lg:p-6`}>
      <button
        type="button"
        onClick={onBack}
        className="ds-focus-ring -ml-1 mb-3 inline-flex h-9 items-center gap-1.5 rounded-control px-2 text-sm font-medium text-foreground-link hover:bg-surface-subtle md:hidden"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" /> All applications
      </button>

      <header className="flex items-start gap-3">
        <span aria-hidden="true" className="shrink-0">
          <CompanyLogo
            company={job.company}
            logoUrl={job.company_logo_url}
            proxyPath={job.company_logo_proxy_path}
            companyDomain={job.company_domain}
            size={44}
          />
        </span>
        <div className="min-w-0">
          <h2
            id={`application-title-${application.id}`}
            className="text-xl font-semibold leading-snug tracking-[-0.02em] text-foreground"
          >
            {job.title}
          </h2>
          <p className="mt-0.5 text-foreground-muted">{job.company}</p>
        </div>
      </header>

      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
        {job.location && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Location</dt>
            <dd className="mt-0.5 text-foreground">{job.location}</dd>
          </div>
        )}
        {(application.applied_at ?? application.created_at) && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
              {application.applied_at ? "Applied" : "Added"}
            </dt>
            <dd className="mt-0.5 text-foreground">
              {formatDate((application.applied_at ?? application.created_at) as string)}
            </dd>
          </div>
        )}
        {/* The same semantic fit chip as Jobs and the Dashboard (number plus label plus colour). Only an existing score is shown:
            nothing is computed here. */}
        {fitScore != null && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Fit score</dt>
            <dd className="mt-1">
              <FitScoreChip score={fitScore} scoreState="scored" />
            </dd>
          </div>
        )}
        {application.applied_source && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Recorded by</dt>
            <dd className="mt-0.5 text-foreground">{APPLIED_SOURCE_LABEL[application.applied_source]}</dd>
          </div>
        )}
      </dl>

      <div className="mt-6 border-t border-line-subtle pt-5">
        <label htmlFor={statusId} className="block text-sm font-semibold text-foreground">
          Application status
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <select
            id={statusId}
            aria-label={`Update status for ${job.title}`}
            value={application.status}
            disabled={updating}
            onChange={(event) => onUpdate(event.target.value as TrackerStatus)}
            className="ds-field ds-focus-ring h-10 rounded-field border border-line-interactive bg-surface-card px-3 pr-8 text-sm font-medium text-foreground transition duration-fast ease-standard hover:border-line-strong"
          >
            {/* A tracked application can sit in a state this control cannot
              * move it *to* — saved, applying, withdrawn, or something a
              * later backend adds. Without an option carrying that value the
              * native select falls back to rendering its first option, so a
              * withdrawn application silently read as "Applied".
              *
              * The real state is added as its own option so the control tells
              * the truth, and disabled so it stays a description of where the
              * application is rather than an offer to move it there. The set
              * of permitted destinations below is unchanged. */}
            {!isTransitionTarget(application.status) && (
              <option value={application.status} disabled>
                {statusLabel(application.status)}
              </option>
            )}
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <StatusBadge tone={getApplicationStatusTone(application.status)}>
            {statusLabel(application.status)}
          </StatusBadge>
          {updating && <Loader2 aria-hidden className="h-4 w-4 animate-spin text-foreground-muted" />}
        </div>
        {/* What this status does and does not mean. Nothing here claims the employer received anything. */}
        <p className="mt-3 text-xs leading-relaxed text-foreground-muted">
          This status comes from what you or the XpertApply extension confirmed. Employers don’t confirm
          submissions to XpertApply, so it is not an employer receipt.
        </p>
      </div>

      <div className="mt-6 border-t border-line-subtle pt-5">
        <h3 className="text-sm font-semibold text-foreground">Prepared documents</h3>
        <div className="mt-3">
          <TrackerDocuments application={application} />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line-subtle pt-5">
        {/* Secondary, not primary: leaving for the posting is a normal step. */}
        <a
          href={job.application_url}
          target="_blank"
          rel="noopener noreferrer"
          className="ds-focus-ring inline-flex h-10 items-center gap-1.5 rounded-control border border-action-secondary-border bg-action-secondary px-3 text-sm font-semibold text-action-secondary-foreground transition duration-fast ease-standard hover:bg-action-ghost-hover"
        >
          View job posting <ExternalLink aria-hidden className="h-3.5 w-3.5" />
        </a>
        {appliedLink && (
          <a
            className="ds-focus-ring inline-flex items-center gap-1 rounded-control text-sm font-medium text-foreground-link underline"
            href={appliedLink}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink aria-hidden className="h-3.5 w-3.5" /> Application link
          </a>
        )}
      </div>
    </article>
  );
}

/**
 * The Tracker's name for a stage.
 *
 * Only `offer` differs from the shared compact label: on this screen the value
 * is the name of the stage you *move an application into*, and "Offer /
 * selected" says that some employers call it an offer and some call it being
 * selected. The Dashboard's dense badge has no room for that nuance and says
 * "Offer". Same domain state, different context — so the wording is local and
 * only the meaning is shared.
 */
function statusLabel(status: string): string {
  if (status === "offer") return "Offer / selected";
  return formatApplicationStatus(status);
}

/** Whether this status is one the control is allowed to move an application to. */
function isTransitionTarget(status: string): boolean {
  return STATUS_OPTIONS.some((option) => option.value === status);
}

/**
 * A neutral placeholder block. Inline-block so it occupies a text line's box.
 *
 * Uses the canonical `--color-skeleton` role: a dedicated loading value that
 * stays perceptible on the page, on a card, and on a tinted selected row in
 * both themes, so a loading state never depends on the pulse animation alone.
 */
function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block animate-pulse rounded bg-skeleton align-middle ${className}`}
    />
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}
