"use client";

import Link from "next/link";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarCheck2,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Compass,
  FileText,
  Sparkles,
  Target,
  Trophy
} from "lucide-react";
import { CompanyLogo } from "@/components/CompanyLogo";
import {
  useDashboardSummary,
  type DashboardApplicationCounts,
  type DashboardNextAction,
  type DashboardNextActionKind,
  type DashboardRecentApplication,
  type DashboardSummary,
  type DashboardTopMatch
} from "@/lib/dashboardSummary";

/**
 * The Dashboard is a summary screen, and it renders like one: the shell, the
 * headings and the card frames are static markup that paints on the first
 * frame, and only the numbers inside them wait on the network. There is no
 * full-screen spinner — a skeleton occupies the exact space its value will,
 * so nothing moves when the data lands.
 *
 * Everything on the page comes from one `/dashboard/summary` request. The
 * pipeline, the metrics and the next-best-action are all views over that single
 * payload — none of them fetches anything of its own.
 */
export function DashboardClient() {
  const { data, loading, error, reload } = useDashboardSummary();

  return (
    <div className="pb-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
            <Greeting firstName={data?.nextAction.firstName} loading={loading} />
          </h1>
          <p className="mt-2 text-[var(--text-muted)]">Here’s where your job search stands.</p>
        </div>
        <Link
          href="/jobs"
          className="focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-pine px-4 text-sm font-semibold text-white hover:bg-[var(--accent-hover)]"
        >
          <BriefcaseBusiness className="h-4 w-4" /> Find jobs
        </Link>
      </header>

      {error && (
        <div
          role="alert"
          className="mt-6 flex flex-col gap-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-surface)] px-4 py-3 text-sm text-[var(--danger)] sm:flex-row sm:items-center sm:justify-between"
        >
          <span>
            {data
              ? "We couldn’t refresh your dashboard, so these numbers may be out of date."
              : "We couldn’t load your dashboard."}
          </span>
          <button
            type="button"
            onClick={reload}
            className="focus-ring shrink-0 rounded-lg border border-[var(--danger-border)] px-3 py-1.5 font-semibold"
          >
            Try again
          </button>
        </div>
      )}

      <section className="mt-8 overflow-hidden rounded-2xl border border-line bg-white" aria-label="Search metrics">
        <div className="grid divide-y divide-line sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          <Metric icon={<Sparkles />} label="Fresh matches" value={data?.freshMatches} loading={loading} />
          <Metric
            icon={<CheckCircle2 />}
            label="In progress"
            value={data?.applications.inProgress}
            loading={loading}
          />
          <Metric
            icon={<CalendarCheck2 />}
            label="Interviews"
            value={data?.applications.interviews}
            loading={loading}
          />
          <Metric icon={<Trophy />} label="Offers" value={data?.applications.offers} loading={loading} />
        </div>
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_.75fr]">
        <section className="rounded-2xl border border-line bg-white p-5 sm:p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Application pipeline</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                How your applications are progressing.
              </p>
            </div>
            <Link href="/tracker" className="focus-ring inline-flex items-center gap-1 text-sm font-semibold text-pine">
              Open tracker <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          <Pipeline counts={data?.applications} loading={loading} />

          <div className="mt-7 border-t border-line pt-5">
            <h3 className="text-sm font-semibold">Recently updated</h3>
            <RecentApplications applications={data?.recentApplications} loading={loading} />
          </div>
        </section>

        <NextActionCard action={data?.nextAction} loading={loading} />
      </div>

      <section className="mt-6 rounded-2xl border border-line bg-white p-5 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em]">Best matches this week</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Highest-fit roles that are still open.</p>
          </div>
          <Link href="/jobs" className="focus-ring inline-flex items-center gap-1 text-sm font-semibold text-pine">
            View all <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
        <TopMatches matches={data?.topMatches} loading={loading} />
      </section>
    </div>
  );
}

function Greeting({ firstName, loading }: { firstName?: string; loading: boolean }) {
  if (loading) {
    // Sized to the rendered greeting so the heading does not resize on load.
    return (
      <span className="inline-flex items-center" aria-hidden>
        <Skeleton className="h-8 w-72 sm:h-10" />
        <span className="sr-only">Loading your workspace</span>
      </span>
    );
  }
  return <>Welcome back{firstName ? `, ${firstName}` : ""}.</>;
}

function Metric({
  icon,
  label,
  value,
  loading
}: {
  icon: React.ReactNode;
  label: string;
  value?: number;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-5">
      <span className="h-5 w-5 text-pine">{icon}</span>
      <div>
        {/* The number and its skeleton share a line box, so the row height is
            identical before and after the value arrives. */}
        <p className="text-2xl font-semibold leading-none">
          {loading || value === undefined ? <Skeleton className="h-6 w-10" /> : value}
        </p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{label}</p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Pipeline                                                               */
/* ---------------------------------------------------------------------- */

/** The lifecycle in order. `saved` is the stage the metrics row does not show. */
const PIPELINE_STAGES: { key: keyof DashboardApplicationCounts; label: string }[] = [
  { key: "saved", label: "Saved" },
  { key: "inProgress", label: "In progress" },
  { key: "interviews", label: "Interview" },
  { key: "offers", label: "Offer" }
];

/**
 * A progression view, not a second scoreboard.
 *
 * The metrics row above already reports the headline numbers, so repeating them
 * as four equal tiles added nothing. This shows the same lifecycle as a funnel:
 * each stage is a proportional bar against the largest stage, so the *shape* of
 * the search — lots saved, few interviews — is readable at a glance.
 *
 * The bars are decorative; every value is also present as text, and the whole
 * thing is a description list so a screen reader gets stage/count pairs rather
 * than a row of orphaned numbers.
 */
function Pipeline({
  counts,
  loading
}: {
  counts?: DashboardApplicationCounts;
  loading: boolean;
}) {
  if (loading || !counts) {
    return (
      <div className="mt-6 grid gap-3" data-testid="pipeline-skeleton">
        {PIPELINE_STAGES.map((stage) => (
          <div key={stage.key} className="grid grid-cols-[5.5rem_1fr_2rem] items-center gap-3">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-4 w-6" />
          </div>
        ))}
        <span className="sr-only">Loading your application pipeline</span>
      </div>
    );
  }

  const values = PIPELINE_STAGES.map((stage) => counts[stage.key]);
  const peak = Math.max(...values, 1);
  const total = values.reduce((sum, value) => sum + value, 0);

  if (total === 0) {
    return (
      <EmptyLine
        text="Save or start an application and your pipeline will appear here."
        href="/jobs"
        label="Browse jobs"
      />
    );
  }

  return (
    <dl role="group" className="mt-6 grid gap-3" aria-label="Application pipeline">
      {PIPELINE_STAGES.map((stage, index) => {
        const value = counts[stage.key];
        return (
          <div key={stage.key} className="grid grid-cols-[5.5rem_1fr_2rem] items-center gap-3">
            <dt className="truncate text-sm text-[var(--text-secondary)]">{stage.label}</dt>
            <div
              aria-hidden
              className="h-2 overflow-hidden rounded-full bg-panel"
              // Stage bars are relative to the busiest stage, so an empty stage
              // reads as empty rather than as a rounding artefact.
            >
              <span
                className={`block h-full rounded-full transition-[width] duration-300 ${
                  // Only the furthest stage the user has actually reached is
                  // accented, so green stays meaningful instead of filling the card.
                  value > 0 && index === lastReachedStage(counts) ? "bg-pine" : "bg-[var(--border-strong)]"
                }`}
                style={{ width: value === 0 ? "0%" : `${Math.max((value / peak) * 100, 4)}%` }}
              />
            </div>
            <dd className="text-right text-sm font-semibold tabular-nums">{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Index of the furthest stage with at least one application. */
function lastReachedStage(counts: DashboardApplicationCounts): number {
  let reached = -1;
  PIPELINE_STAGES.forEach((stage, index) => {
    if (counts[stage.key] > 0) reached = index;
  });
  return reached;
}

/* ---------------------------------------------------------------------- */
/* Recently updated                                                       */
/* ---------------------------------------------------------------------- */

function RecentApplications({
  applications,
  loading
}: {
  applications?: DashboardRecentApplication[];
  loading: boolean;
}) {
  if (loading || applications === undefined) {
    return (
      <div className="mt-2 divide-y divide-line" data-testid="recent-applications-skeleton">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 py-3.5">
            <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="mt-1.5 h-3 w-28 max-w-full" />
            </div>
            <Skeleton className="h-6 w-16 shrink-0 rounded-full" />
          </div>
        ))}
        <span className="sr-only">Loading recent applications</span>
      </div>
    );
  }

  if (applications.length === 0) {
    return <EmptyLine text="Applications you save or start will appear here." href="/jobs" label="Browse jobs" />;
  }

  return (
    <ul className="mt-2 divide-y divide-line">
      {applications.map((application) => (
        <li key={application.id}>
          <Link href="/tracker" className="focus-ring flex items-center gap-3 py-3.5">
            <CompanyLogo company={application.company} proxyPath={application.logoUrl} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{application.title}</span>
              <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
                {application.company}
                {application.updatedAt ? ` · ${relativeDate(application.updatedAt)}` : ""}
              </span>
            </span>
            <StatusPill status={application.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** "Today" / "3d ago" / a date — short enough for a dense row. */
function relativeDate(value: string): string {
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ---------------------------------------------------------------------- */
/* Next best action                                                       */
/* ---------------------------------------------------------------------- */

const NEXT_ACTION_ICONS: Record<DashboardNextActionKind, typeof Target> = {
  complete_profile: CircleUserRound,
  needs_attention: FileText,
  interview_upcoming: CalendarClock,
  strong_matches: Target,
  advance_saved: FileText,
  discover: Compass
};

/**
 * The next best action.
 *
 * Every word of this card — which action, its count, its wording — is decided
 * by the server from state the product already records, and arrives in the same
 * payload as everything else. The client picks an icon and renders it; it never
 * derives a count, and it never fetches anything to fill this card in.
 */
function NextActionCard({
  action,
  loading
}: {
  action?: DashboardNextAction;
  loading: boolean;
}) {
  if (loading || !action) {
    return (
      <aside
        className="rounded-2xl border border-[var(--success-border)] bg-[var(--success-surface)] p-6"
        data-testid="next-action-skeleton"
      >
        <Skeleton className="h-11 w-11 rounded-xl" />
        <Skeleton className="mt-8 h-3 w-32" />
        <Skeleton className="mt-3 h-7 w-52 max-w-full" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-1.5 h-4 w-3/4" />
        <Skeleton className="mt-6 h-11 w-40 rounded-xl" />
        <span className="sr-only">Loading your next action</span>
      </aside>
    );
  }

  const Icon = NEXT_ACTION_ICONS[action.kind] ?? Target;

  return (
    <aside
      aria-labelledby="next-action-title"
      data-action-kind={action.kind}
      className="rounded-2xl border border-[var(--success-border)] bg-[var(--success-surface)] p-6"
    >
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-white/70 text-pine">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <p className="mt-8 text-xs font-semibold uppercase tracking-[0.12em] text-pine">
        {action.eyebrow}
      </p>
      <h2 id="next-action-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em]">
        {action.title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{action.body}</p>
      {action.dueOn && (
        <p className="mt-2 text-sm font-medium text-pine">{formatDueDate(action.dueOn)}</p>
      )}
      <Link
        href={action.href}
        className="focus-ring mt-6 inline-flex h-11 items-center gap-2 rounded-xl bg-pine px-4 text-sm font-semibold text-white"
      >
        {action.cta} <ArrowRight className="h-4 w-4" />
      </Link>
    </aside>
  );
}

function formatDueDate(value: string): string {
  // A date-only value is a calendar date, not an instant. `new Date("2026-08-14")`
  // parses as UTC midnight, which formats as the *previous* day for anyone west
  // of UTC — so the parts are read directly and built in local time instead.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const due = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(due.getTime())) return "";
  return due.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric"
  });
}

/* ---------------------------------------------------------------------- */
/* Best matches                                                           */
/* ---------------------------------------------------------------------- */

function TopMatches({ matches, loading }: { matches?: DashboardTopMatch[]; loading: boolean }) {
  if (loading || matches === undefined) {
    return (
      <div className="mt-4 divide-y divide-line" data-testid="top-matches-skeleton">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-4 py-4">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-5 w-56 max-w-full" />
              <Skeleton className="mt-1.5 h-4 w-40 max-w-full" />
            </div>
            <Skeleton className="h-10 w-20 shrink-0 rounded-xl" />
          </div>
        ))}
        <span className="sr-only">Loading your best matches</span>
      </div>
    );
  }

  if (matches.length === 0) {
    return <EmptyLine text="Run job discovery to see your strongest matches here." href="/jobs" label="Find matches" />;
  }

  return (
    <ul className="mt-4 divide-y divide-line">
      {matches.map((job) => (
        <li key={job.id}>
          <Link href={`/jobs?job=${job.id}`} className="focus-ring flex items-center gap-4 py-4">
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{job.title}</p>
              <p className="mt-1 truncate text-sm text-[var(--text-muted)]">
                {job.company}
                {job.location ? ` · ${job.location}` : ""}
              </p>
            </div>
            <span className="rounded-xl border border-[var(--success-border)] bg-[var(--success-surface)] px-3 py-2 text-sm font-semibold text-pine">
              {Math.round(job.fitScore ?? 0)}% fit
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------------- */
/* Shared                                                                 */
/* ---------------------------------------------------------------------- */

function StatusPill({ status }: { status: string }) {
  return (
    <span className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-[var(--text-muted)]">
      {status === "ready_to_apply" ? "Saved" : status.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase())}
    </span>
  );
}

function EmptyLine({ text, href, label }: { text: string; href: string; label: string }) {
  return (
    <div className="mt-4 flex flex-col items-start justify-between gap-3 rounded-xl bg-panel px-4 py-4 sm:flex-row sm:items-center">
      <p className="text-sm text-[var(--text-muted)]">{text}</p>
      <Link href={href} className="focus-ring shrink-0 text-sm font-semibold text-pine">{label}</Link>
    </div>
  );
}

/** A neutral placeholder block. Inline-block so it occupies a text line's box. */
function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block animate-pulse rounded bg-[var(--skeleton)] align-middle ${className}`}
    />
  );
}

export type { DashboardSummary };
