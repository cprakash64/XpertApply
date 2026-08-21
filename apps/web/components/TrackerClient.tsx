"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  MapPin,
  Search,
  Trophy
} from "lucide-react";
import Link from "next/link";
import { CompanyLogo } from "@/components/CompanyLogo";
import { Alert, Chip, StatusBadge } from "@/components/ui";
import {
  formatApplicationStatus,
  getApplicationStatusTone
} from "@/lib/applicationStatus";
import { api, type Job } from "@/lib/api";
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

export type TrackerDocument = { id: number; title: string | null; created_at: string | null };

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
 * The shared card contract for this screen — border-first, no shadow. The
 * Tracker is a list you scan, and a page of shadowed panels reads as noise
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

export function TrackerClient() {
  const [applications, setApplications] = useState<TrackerApplication[]>([]);
  const [filter, setFilter] = useState<TrackerFilter>("all");
  const [query, setQuery] = useState("");
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

  const counts = useMemo(
    () => ({
      all: applications.length,
      applied: applications.filter((row) => row.status === "applied").length,
      interview: applications.filter((row) => row.status === "interview").length,
      offer: applications.filter((row) => row.status === "offer").length
    }),
    [applications]
  );

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return applications.filter((application) => {
      const matchesFilter =
        filter === "all"
          ? true
          : application.status === filter;
      const matchesQuery =
        !normalizedQuery ||
        `${application.job.title} ${application.job.company}`
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [applications, filter, query]);

  // Skeletons in the shape of the real thing, rather than a spinner that
  // occupies none of the eventual space: the summary row, the toolbar and the
  // first cards all land where their placeholder sat, so nothing jumps. The
  // request itself is untouched.
  if (loading) {
    return (
      <section aria-busy="true">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((card) => (
            <div key={card} className={`${CARD} p-4`}>
              <div className="flex items-center justify-between">
                <Skeleton className="h-9 w-9 rounded-control" />
                <Skeleton className="h-7 w-10" />
              </div>
              <Skeleton className="mt-3 h-4 w-24" />
            </div>
          ))}
        </div>
        <Skeleton className="mt-5 h-16 w-full rounded-card" />
        <div className="mt-4 grid gap-3">
          {[0, 1, 2].map((row) => (
            <div key={row} className={`${CARD} p-4 sm:p-5`}>
              <div className="flex items-start gap-3">
                <Skeleton className="h-10 w-10 shrink-0 rounded-control" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="mt-2 h-5 w-64 max-w-full" />
                  <Skeleton className="mt-2 h-3.5 w-48 max-w-full" />
                </div>
              </div>
            </div>
          ))}
        </div>
        <span className="sr-only" role="status">Loading your applications…</span>
      </section>
    );
  }

  return (
    <section>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          icon={<BriefcaseBusiness className="h-5 w-5" />}
          label="Total tracked"
          value={counts.all}
        />
        <SummaryCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Applied"
          value={counts.applied}
        />
        <SummaryCard
          icon={<CalendarDays className="h-5 w-5" />}
          label="Interviews"
          value={counts.interview}
        />
        <SummaryCard icon={<Trophy className="h-5 w-5" />} label="Offers" value={counts.offer} />
      </div>

      <div className={`mt-5 flex flex-col gap-3 ${CARD} p-3 lg:flex-row lg:items-center lg:justify-between`}>
        {/* Chips, not custom buttons: a filter is a toggle, and the primitive
            carries `aria-pressed` plus the canonical selected treatment, so the
            active stage is announced rather than only coloured. */}
        <div
          role="group"
          aria-label="Application status filters"
          className="scroll-strip flex gap-1 overflow-x-auto"
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
        {/* The icon sits inside the control, which the Input primitive's chrome
            does not express — so this keeps its own markup and borrows the
            field's visual contract instead. */}
        <label className="relative block w-full lg:max-w-xs">
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
      </div>

      {error ? (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      ) : message ? (
        // A stage move is a genuine positive outcome, so the confirmation is
        // allowed the success tone the badges use.
        <p role="status" className="mt-3 text-sm font-medium text-status-success">
          {message}
        </p>
      ) : null}

      <div className="mt-4 grid gap-3">
        {visible.map((application) => (
          <ApplicationCard
            key={application.id}
            application={application}
            updating={updatingId === application.id}
            onUpdate={(status) => update(application, status)}
          />
        ))}
      </div>

      {visible.length === 0 && (
        <div className="mt-4 rounded-card border border-dashed border-line-default bg-surface-card px-6 py-14 text-center">
          <BriefcaseBusiness aria-hidden className="mx-auto h-9 w-9 text-foreground-muted" />
          <h2 className="mt-3 font-semibold text-foreground">
            {applications.length === 0 ? "No applications yet" : "No applications found"}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-foreground-muted">
            {applications.length === 0
              ? "Applications appear here after you confirm that you submitted them."
              : "Try another status or search term."}
          </p>
          {/* Only the genuinely empty tracker gets a call to action — a search
              that matched nothing needs a different query, not a new job. */}
          {applications.length === 0 && (
            <Link
              className="ds-focus-ring mt-4 inline-flex h-10 items-center rounded-control bg-action-primary px-5 text-sm font-semibold text-action-primary-foreground shadow-subtle transition duration-fast ease-standard hover:bg-action-primary-hover active:translate-y-px"
              href="/jobs"
            >
              Find jobs
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A count, not a colour. These four are the same kind of object as the
 * Dashboard's metric row and get the same restraint: the number carries the
 * hierarchy and the icon stays muted. The old green tile spent the success
 * palette on "Total tracked", which is not an achievement.
 */
function SummaryCard({
  icon,
  label,
  value
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className={`${CARD} p-4`}>
      <div className="flex items-center justify-between">
        <span className="rounded-control border border-line-default bg-surface-subtle p-2 text-foreground-muted">
          {icon}
        </span>
        <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
      </div>
      <p className="mt-3 text-sm font-medium text-foreground-secondary">{label}</p>
    </div>
  );
}

function ApplicationCard({
  application,
  updating,
  onUpdate
}: {
  application: TrackerApplication;
  updating: boolean;
  onUpdate: (status: TrackerStatus) => void;
}) {
  const { job } = application;
  const fitScore = job.match?.fit_score;
  return (
    <article
      className={`${CARD} p-4 transition-colors duration-fast ease-standard hover:border-line-interactive sm:p-5`}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <CompanyLogo
            company={job.company}
            logoUrl={job.company_logo_url}
            proxyPath={job.company_logo_proxy_path}
            companyDomain={job.company_domain}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-foreground-secondary">{job.company}</p>
              {/* Tone from the shared domain module, wording from this screen. */}
              <StatusBadge tone={getApplicationStatusTone(application.status)}>
                {statusLabel(application.status)}
              </StatusBadge>
            </div>
            <h2 className="mt-1 text-lg font-semibold leading-snug text-foreground">{job.title}</h2>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground-muted">
              {job.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin aria-hidden className="h-3.5 w-3.5" />
                  {job.location}
                </span>
              )}
              {application.applied_at && (
                <span className="inline-flex items-center gap-1">
                  <CalendarDays aria-hidden className="h-3.5 w-3.5" />
                  Applied {formatDate(application.applied_at)}
                </span>
              )}
              {/* Fit stays plain metadata here. The score's colour bands are a
                  Jobs/Dashboard signal; in a dense tracker row the stage is the
                  thing being scanned, and a second coloured chip competes. */}
              {fitScore != null && <span>{Math.round(fitScore)}% fit</span>}
            </div>
            {/* What was actually prepared and how the submission was confirmed.
              * These come from the one application record, so the Tracker never
              * needs a second copy of the job. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-muted">
              {application.applied_source && (
                <span>{APPLIED_SOURCE_LABEL[application.applied_source]}</span>
              )}
              {application.documents?.resume && (
                <span className="inline-flex items-center gap-1">
                  <FileText aria-hidden className="h-3 w-3" /> Tailored resume
                </span>
              )}
              {application.documents?.cover_letter && (
                <span className="inline-flex items-center gap-1">
                  <Mail aria-hidden className="h-3 w-3" /> Cover letter
                </span>
              )}
              {application.application_url && (
                <a
                  className="ds-focus-ring inline-flex items-center gap-1 rounded-control font-medium text-foreground-link underline"
                  href={application.application_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink aria-hidden className="h-3 w-3" /> Application
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <label className="relative">
            <span className="sr-only">Update status for {job.title}</span>
            <select
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
          </label>
          {/* Secondary, not primary: leaving for the posting is a normal step,
              and a card full of filled buttons has no hierarchy left. */}
          <a
            href={job.application_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ds-focus-ring inline-flex h-10 items-center gap-1.5 rounded-control border border-action-secondary-border bg-action-secondary px-3 text-sm font-semibold text-action-secondary-foreground transition duration-fast ease-standard hover:bg-action-ghost-hover"
          >
            View job <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          </a>
          {updating && (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin text-foreground-muted" />
          )}
        </div>
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
