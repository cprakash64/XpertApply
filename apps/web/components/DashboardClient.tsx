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
import { Alert, Button, StatusBadge } from "@/components/ui";
import {
  formatApplicationStatus,
  getApplicationStatusTone
} from "@/lib/applicationStatus";
import { getFitScoreTone } from "@/lib/fitScore";
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
 *
 * Visually this page speaks the canonical XpertApply system: navy is the
 * primary action, cyan marks progress and the promoted next action, and green
 * is reserved for outcomes that genuinely mean success (an offer). The page
 * canvas is still owned by the AppShell and is deliberately left alone here —
 * repainting it would recolour every unmigrated page at once.
 */

/** The shared card contract, applied to the semantic element each region needs. */
const CARD = "rounded-card border border-line-default bg-surface-card";

/** Section title + description + trailing link, repeated by the two big panels. */
/* `ds-touch-target` only bites under `pointer: coarse`, where these
 * section links were a 20px-tall tap target beside a full-width card. */
const SECTION_LINK =
  "ds-focus-ring ds-touch-target inline-flex shrink-0 items-center gap-1 rounded-control text-sm font-semibold text-foreground-link";

export function DashboardClient() {
  const { data, loading, error, reload } = useDashboardSummary();

  return (
    <div className="pb-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          {/* The 36px welcome is the documented display exception for this page. */}
          <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">
            <Greeting firstName={data?.nextAction.firstName} loading={loading} />
          </h1>
          <p className="mt-2 text-foreground-muted">Here’s where your job search stands.</p>
        </div>
        <Link
          href="/jobs"
          className="ds-focus-ring inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-action-primary px-5 text-sm font-semibold text-action-primary-foreground shadow-subtle transition duration-fast ease-standard hover:bg-action-primary-hover active:translate-y-px"
        >
          <BriefcaseBusiness className="h-4 w-4" aria-hidden /> Find jobs
        </Link>
      </header>

      {error && (
        <Alert tone="danger" className="mt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {data
                ? "We couldn’t refresh your dashboard, so these numbers may be out of date."
                : "We couldn’t load your dashboard."}
            </span>
            <Button variant="secondary" size="sm" onClick={reload} className="self-start sm:self-auto">
              Try again
            </Button>
          </div>
        </Alert>
      )}

      <section className={`mt-8 overflow-hidden ${CARD}`} aria-label="Search metrics">
        {/* A 1px gap over the border colour draws the separators, which keeps
            them correct in both the 2×2 phone grid and the 4-up row — `divide-*`
            cannot express a grid that changes column count. */}
        <div className="grid grid-cols-2 gap-px bg-line-default sm:grid-cols-4">
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

      {/* `min-w-0` on the grid children is load-bearing, not tidiness. A grid
        * item's automatic minimum is its min-content width, and the truncating
        * job titles below report a min-content the width of the untruncated
        * string — so on a narrow screen the track was sized to the longest job
        * title and pushed the whole document sideways. */}
      <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_.75fr]">
        <section className={`min-w-0 ${CARD} p-5 sm:p-6`}>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
                Application pipeline
              </h2>
              <p className="mt-1 text-sm text-foreground-muted">
                How your applications are progressing.
              </p>
            </div>
            <Link href="/tracker" className={SECTION_LINK}>
              Open tracker <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>

          <Pipeline counts={data?.applications} loading={loading} />

          <div className="mt-7 border-t border-line-subtle pt-5">
            <h3 className="text-sm font-semibold text-foreground">Recently updated</h3>
            <RecentApplications applications={data?.recentApplications} loading={loading} />
          </div>
        </section>

        <NextActionCard action={data?.nextAction} loading={loading} />
      </div>

      <section className={`mt-6 ${CARD} p-5 sm:p-6`}>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
              Best matches this week
            </h2>
            <p className="mt-1 text-sm text-foreground-muted">Highest-fit roles that are still open.</p>
          </div>
          <Link href="/jobs" className={SECTION_LINK}>
            View all <ChevronRight className="h-4 w-4" aria-hidden />
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

/**
 * A metric is a number, not a colour. The four icons stay muted so the values
 * carry the hierarchy — tinting each tile would turn the row into decoration
 * and spend the status palette on things that are not statuses.
 */
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
    <div className="flex items-center gap-3 bg-surface-card px-4 py-4 sm:px-5 sm:py-5">
      <span className="h-5 w-5 shrink-0 text-foreground-muted">{icon}</span>
      <div>
        {/* The number and its skeleton share a line box, so the row height is
            identical before and after the value arrives. */}
        <p className="text-2xl font-semibold leading-none tabular-nums text-foreground">
          {loading || value === undefined ? <Skeleton className="h-6 w-10" /> : value}
        </p>
        <p className="mt-1 text-xs text-foreground-muted">{label}</p>
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
            <Skeleton className="h-2 w-full rounded-pill" />
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

  const reached = lastReachedStage(counts);

  return (
    <dl role="group" className="mt-6 grid gap-3" aria-label="Application pipeline">
      {PIPELINE_STAGES.map((stage, index) => {
        const value = counts[stage.key];
        const isCurrent = value > 0 && index === reached;
        return (
          <div key={stage.key} className="grid grid-cols-[5.5rem_1fr_2rem] items-center gap-3">
            <dt className="truncate text-sm text-foreground-secondary">{stage.label}</dt>
            <div
              aria-hidden
              className="h-2 overflow-hidden rounded-pill bg-surface-subtle"
              // Stage bars are relative to the busiest stage, so an empty stage
              // reads as empty rather than as a rounding artefact.
            >
              <span
                className={`block h-full rounded-pill transition-[width] duration-normal ease-standard ${
                  // Only the furthest stage the user has actually reached is
                  // accented. Reaching *Offer* is a genuine positive outcome, so
                  // that one stage earns semantic green; every earlier stage is
                  // progress, which is brand cyan rather than success.
                  isCurrent
                    ? stage.key === "offers"
                      ? "bg-status-success"
                      : "bg-brand-accent"
                    : "bg-line-strong"
                }`}
                style={{ width: value === 0 ? "0%" : `${Math.max((value / peak) * 100, 4)}%` }}
              />
            </div>
            <dd className="text-right text-sm font-semibold tabular-nums text-foreground">{value}</dd>
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
      <div className="mt-2 divide-y divide-line-subtle" data-testid="recent-applications-skeleton">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 py-3.5">
            <Skeleton className="h-9 w-9 shrink-0 rounded-control" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="mt-1.5 h-3 w-28 max-w-full" />
            </div>
            <Skeleton className="h-6 w-16 shrink-0 rounded-pill" />
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
    <ul className="mt-2 divide-y divide-line-subtle">
      {applications.map((application) => (
        <li key={application.id}>
          <Link
            href="/tracker"
            className="ds-focus-ring -mx-2 flex items-center gap-3 rounded-control px-2 py-3.5 transition-colors duration-fast ease-standard hover:bg-surface-subtle"
          >
            <CompanyLogo company={application.company} proxyPath={application.logoUrl} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                {application.title}
              </span>
              <span className="mt-0.5 block truncate text-xs text-foreground-muted">
                {application.company}
                {application.updatedAt ? ` · ${relativeDate(application.updatedAt)}` : ""}
              </span>
            </span>
            {/* Meaning comes from the shared domain module; the compact wording
                is this screen's own — the Tracker names the same stage
                "Offer / selected" because that is what you move an application
                into, while a dense row just says "Offer". */}
            <StatusBadge tone={getApplicationStatusTone(application.status)} className="shrink-0">
              {formatApplicationStatus(application.status)}
            </StatusBadge>
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

/** The promoted next action sits on the brand selection surface, not on the
 * success surface it used to borrow: being told what to do next is not an
 * achievement, and green here made every visit look like a win. */
const NEXT_ACTION_SURFACE =
  "min-w-0 self-start rounded-card border border-line-selected bg-surface-selected";

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
    // Deliberately the neutral card, not the tinted one: placeholder blocks are
    // a hair lighter than the brand tint and vanish into it, which reads as an
    // empty panel rather than as content arriving. The tint appears with the
    // action it is promoting.
    return (
      <aside className={`min-w-0 self-start ${CARD} p-6`} data-testid="next-action-skeleton">
        <Skeleton className="h-11 w-11 rounded-control" />
        <Skeleton className="mt-8 h-3 w-32" />
        <Skeleton className="mt-3 h-7 w-52 max-w-full" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-1.5 h-4 w-3/4" />
        <Skeleton className="mt-6 h-11 w-40 rounded-control" />
        <span className="sr-only">Loading your next action</span>
      </aside>
    );
  }

  const Icon = NEXT_ACTION_ICONS[action.kind] ?? Target;

  return (
    <aside
      aria-labelledby="next-action-title"
      data-action-kind={action.kind}
      className={`${NEXT_ACTION_SURFACE} p-6`}
    >
      <span className="grid h-11 w-11 place-items-center rounded-control border border-line-default bg-surface-card text-brand-primary">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      {/* Brand primary, not the cyan text role: at 12px the dark-cyan sits at
          4.4:1 on this tinted surface, just under AA. Navy (cyan in dark) keeps
          the brand voice and clears the bar comfortably in both themes. */}
      <p className="mt-8 text-xs font-semibold uppercase tracking-[0.12em] text-brand-primary">
        {action.eyebrow}
      </p>
      <h2
        id="next-action-title"
        className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground"
      >
        {action.title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-foreground-muted">{action.body}</p>
      {action.dueOn && (
        <p className="mt-2 text-sm font-medium text-foreground-secondary">{formatDueDate(action.dueOn)}</p>
      )}
      <Link
        href={action.href}
        className="ds-focus-ring mt-6 inline-flex h-11 items-center gap-2 rounded-control bg-action-primary px-5 text-sm font-semibold text-action-primary-foreground shadow-subtle transition duration-fast ease-standard hover:bg-action-primary-hover active:translate-y-px"
      >
        {action.cta} <ArrowRight className="h-4 w-4" aria-hidden />
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
      <div className="mt-4 divide-y divide-line-subtle" data-testid="top-matches-skeleton">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-4 py-4">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-5 w-56 max-w-full" />
              <Skeleton className="mt-1.5 h-4 w-40 max-w-full" />
            </div>
            <Skeleton className="h-10 w-20 shrink-0 rounded-control" />
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
    <ul className="mt-4 divide-y divide-line-subtle">
      {matches.map((job) => {
        // The score's own band carries its meaning — a 46% match must not wear
        // the same green as a 91% one just because the Dashboard shows both.
        const fit = getFitScoreTone(job.fitScore);
        return (
          <li key={job.id}>
            <Link
              href={`/jobs?job=${job.id}`}
              className="ds-focus-ring -mx-2 flex items-center gap-4 rounded-control px-2 py-4 transition-colors duration-fast ease-standard hover:bg-surface-subtle"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground">{job.title}</p>
                <p className="mt-1 truncate text-sm text-foreground-muted">
                  {job.company}
                  {job.location ? ` · ${job.location}` : ""}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-control border px-3 py-2 text-sm font-semibold tabular-nums ${fit.container}`}
              >
                {Math.round(job.fitScore ?? 0)}% fit
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------------------------------------------- */
/* Shared                                                                 */
/* ---------------------------------------------------------------------- */

function EmptyLine({ text, href, label }: { text: string; href: string; label: string }) {
  return (
    <div className="mt-4 flex flex-col items-start justify-between gap-3 rounded-field border border-line-subtle bg-surface-subtle px-4 py-4 sm:flex-row sm:items-center">
      <p className="text-sm text-foreground-muted">{text}</p>
      <Link
        href={href}
        className="ds-focus-ring shrink-0 rounded-control text-sm font-semibold text-foreground-link"
      >
        {label}
      </Link>
    </div>
  );
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

export type { DashboardSummary };
