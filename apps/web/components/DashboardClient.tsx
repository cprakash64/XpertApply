"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Bookmark,
  BookmarkCheck,
  BriefcaseBusiness,
  CalendarCheck2,
  CalendarClock,
  Check,
  ChevronRight,
  CircleUserRound,
  Compass,
  FileText,
  Loader2,
  Search,
  Sparkles,
  Target,
  Trophy
} from "lucide-react";
import { CompanyLogo } from "@/components/CompanyLogo";
import { FitScoreChip } from "@/components/jobs/badges";
import { Alert, Button, StatusBadge } from "@/components/ui";
import { formatApplicationStatus, getApplicationStatusTone } from "@/lib/applicationStatus";
import { api } from "@/lib/api";
import {
  invalidateDashboardSummary,
  useDashboardSummary,
  type DashboardApplicationCounts,
  type DashboardNextAction,
  type DashboardNextActionKind,
  type DashboardProfile,
  type DashboardRecentApplication,
  type DashboardTopMatch
} from "@/lib/dashboardSummary";

/**
 * The Dashboard is a summary screen, and it renders like one: the shell, the headings and the card frames are static markup
 * that paints on the first frame, and only the numbers inside them wait on the network. A skeleton occupies the exact space
 * its value will, so nothing moves when the data lands.
 *
 * Everything on the page comes from one `/dashboard/summary` request (plus an explicit Save when the user presses it). The
 * metrics, the top matches, the recent table, the profile card and the pipeline are all views over that single payload; none
 * of them fetches anything of its own, and no number is computed or invented here.
 *
 * Layout: a compact welcome with a job search, four metrics, then the main column (top matches, recent applications) beside
 * a narrow rail (profile completion, pipeline). Below `xl` the rail drops under the main column.
 */

const CARD = "rounded-card border border-line-default bg-surface-card";
const SECTION_LINK =
  "ds-focus-ring ds-touch-target inline-flex shrink-0 items-center gap-1 rounded-control text-sm font-semibold text-foreground-link";

export function DashboardClient() {
  const { data, loading, error, reload } = useDashboardSummary();

  return (
    <div className="pb-10">
      <Welcome firstName={data?.nextAction.firstName} loading={loading} />

      {error && (
        <Alert tone="danger" className="mt-4">
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

      <NextActionBar action={data?.nextAction} loading={loading} />

      <section aria-label="Search metrics" className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          icon={<Sparkles />}
          label="Job matches"
          value={data?.freshMatches}
          note={data && data.strongMatches > 0 ? `${data.strongMatches} strong fit${data.strongMatches === 1 ? "" : "s"}` : undefined}
          loading={loading}
        />
        <Metric
          icon={<BriefcaseBusiness />}
          label="Applications"
          value={data ? submittedCount(data.applications) : undefined}
          hint="Applications you have submitted or started. Roles that are only saved are not counted."
          loading={loading}
        />
        <Metric icon={<CalendarCheck2 />} label="Interviews" value={data?.applications.interviews} loading={loading} />
        <Metric icon={<Trophy />} label="Offers" value={data?.applications.offers} loading={loading} />
      </section>

      {/* `min-w-0` on the grid children is load-bearing: a grid item's automatic minimum is its min-content width, and the
        * truncating titles below would otherwise size the track to the longest string and push the page sideways. */}
      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="top-matches-title">
            <div className="flex items-end justify-between gap-4">
              <h2 id="top-matches-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">
                Top job matches for you
              </h2>
              <Link href="/jobs" className={SECTION_LINK}>
                View all <ChevronRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
            <TopMatches matches={data?.topMatches} loading={loading} />
          </section>

          <section aria-labelledby="recent-title" className={`${CARD} relative overflow-hidden`}>
            <div className="flex items-center justify-between gap-4 px-4 pt-4 sm:px-5">
              <h2 id="recent-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">
                Recent applications
              </h2>
              <Link href="/tracker" className={SECTION_LINK}>
                View all <ChevronRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
            <RecentApplications applications={data?.recentApplications} loading={loading} />
          </section>
        </div>

        <aside aria-label="Profile and pipeline" className="min-w-0 space-y-6">
          <ProfileCompletion profile={data?.profile} fallbackPercent={data?.nextAction.profileProgress} loading={loading} />
          <PipelineCard counts={data?.applications} loading={loading} />
        </aside>
      </div>
    </div>
  );
}

/** Applications the user has acted on: everything in the ledger except roles that are only saved. */
function submittedCount(counts: DashboardApplicationCounts): number {
  return counts.inProgress + counts.interviews + counts.offers + (counts.rejected ?? 0);
}

/* ---------------------------------------------------------------------- */
/* Welcome, search, next action                                           */
/* ---------------------------------------------------------------------- */

function Welcome({ firstName, loading }: { firstName?: string; loading: boolean }) {
  // Empty on the server and during hydration, the real date afterwards: the server and the browser can disagree about
  // "today", and a mismatch there is a hydration error. A string snapshot compares by value, so this never re-renders.
  const today = useSyncExternalStore(noSubscription, readToday, () => "");

  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
          <Greeting firstName={firstName} loading={loading} />
        </h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Here’s where your job search stands{today ? ` · ${today}` : ""}.
        </p>
      </div>
      <JobSearch />
    </header>
  );
}

const noSubscription = () => () => undefined;
const readToday = () => new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());

function Greeting({ firstName, loading }: { firstName?: string; loading: boolean }) {
  if (loading) {
    return (
      <span className="inline-flex items-center" aria-hidden>
        <Skeleton className="h-7 w-64 sm:h-8" />
        <span className="sr-only">Loading your workspace</span>
      </span>
    );
  }
  return <>Welcome back{firstName ? `, ${firstName}` : ""}.</>;
}

/**
 * Hands the search to the Jobs workspace, which already searches role, company text and skills. It is a jobs search and says so:
 * the Applications list has its own search, and there is no combined index to pretend otherwise.
 */
function JobSearch() {
  const router = useRouter();
  const [term, setTerm] = useState("");
  return (
    <form
      role="search"
      aria-label="Search jobs"
      className="relative w-full sm:w-72"
      onSubmit={(event) => {
        event.preventDefault();
        const value = term.trim();
        router.push(value ? `/jobs?q=${encodeURIComponent(value)}` : "/jobs");
      }}
    >
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted" />
      <input
        aria-label="Search jobs"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search jobs by role or skill"
        className="ds-field ds-focus-ring h-10 w-full rounded-field border border-line-interactive bg-surface-card pl-9 pr-3 text-sm text-foreground transition duration-fast ease-standard placeholder:text-foreground-muted hover:border-line-strong"
      />
    </form>
  );
}

const NEXT_ACTION_ICONS: Record<DashboardNextActionKind, typeof Target> = {
  complete_profile: CircleUserRound,
  needs_attention: FileText,
  interview_upcoming: CalendarClock,
  strong_matches: Target,
  advance_saved: FileText,
  discover: Compass
};

/**
 * The next best action, as one slim row. Every word of it (which action, its count, its wording) is decided by the server from
 * state the product already records; the client picks an icon and renders it.
 */
function NextActionBar({ action, loading }: { action?: DashboardNextAction; loading: boolean }) {
  if (loading || !action) {
    return (
      <div className={`mt-4 flex items-center gap-3 ${CARD} px-4 py-3`} data-testid="next-action-skeleton">
        <Skeleton className="h-9 w-9 rounded-control" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="mt-2 h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="hidden h-9 w-32 rounded-control sm:block" />
        <span className="sr-only">Loading your next action</span>
      </div>
    );
  }
  const Icon = NEXT_ACTION_ICONS[action.kind] ?? Target;
  return (
    <aside
      aria-labelledby="next-action-title"
      data-action-kind={action.kind}
      className="mt-4 flex flex-col gap-3 rounded-card border border-line-selected bg-surface-selected px-4 py-3 sm:flex-row sm:items-center"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control border border-line-default bg-surface-card text-brand-primary">
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-brand-primary">{action.eyebrow}</p>
        <h2 id="next-action-title" className="text-sm font-semibold text-foreground">
          {action.title}
        </h2>
        <p className="text-sm text-foreground-muted">
          {action.body}
          {action.dueOn && <span className="ml-1 font-medium text-foreground-secondary">{formatDueDate(action.dueOn)}</span>}
        </p>
      </div>
      <Link
        href={action.href}
        className="ds-focus-ring inline-flex h-9 shrink-0 items-center justify-center gap-2 self-start rounded-control bg-action-primary px-4 text-sm font-semibold text-action-primary-foreground transition duration-fast ease-standard hover:bg-action-primary-hover active:translate-y-px sm:self-auto"
      >
        {action.cta} <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </aside>
  );
}

function formatDueDate(value: string): string {
  // A date-only value is a calendar date, not an instant. `new Date("2026-08-14")` parses as UTC midnight, which formats as
  // the previous day for anyone west of UTC, so the parts are read directly and built in local time.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const due = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(value);
  if (Number.isNaN(due.getTime())) return "";
  return due.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/* ---------------------------------------------------------------------- */
/* Metrics                                                                */
/* ---------------------------------------------------------------------- */

/** A number, not a colour: the icon stays muted so the value carries the hierarchy. No trend arrows, because none is computed. */
function Metric({
  icon,
  label,
  value,
  note,
  hint,
  loading
}: {
  icon: React.ReactNode;
  label: string;
  value?: number;
  note?: string;
  /** What the number counts, for the cases where the label alone is ambiguous. */
  hint?: string;
  loading: boolean;
}) {
  return (
    <div className={`${CARD} flex items-center gap-3 px-4 py-3.5`} title={hint}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control border border-line-default bg-surface-subtle text-foreground-muted [&>svg]:h-[18px] [&>svg]:w-[18px]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-2xl font-semibold leading-none tabular-nums text-foreground">
          {loading || value === undefined ? <Skeleton className="h-6 w-10" /> : value}
        </p>
        <p className="mt-1 truncate text-xs text-foreground-muted">
          {label}
          {note && <span className="hidden text-foreground-muted sm:inline"> · {note}</span>}
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Top matches                                                            */
/* ---------------------------------------------------------------------- */

function TopMatches({ matches, loading }: { matches?: DashboardTopMatch[]; loading: boolean }) {
  if (loading || matches === undefined) {
    return (
      <div className="mt-3 grid gap-4 md:grid-cols-3" data-testid="top-matches-skeleton">
        {[0, 1, 2].map((card) => (
          <div key={card} className={`${CARD} overflow-hidden`}>
            <Skeleton className="block h-24 w-full rounded-none" />
            <div className="p-4">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="mt-2 h-4 w-1/2" />
              <Skeleton className="mt-4 h-6 w-28 rounded-pill" />
              <Skeleton className="mt-4 h-12 w-full" />
            </div>
          </div>
        ))}
        <span className="sr-only">Loading your best matches</span>
      </div>
    );
  }
  if (matches.length === 0) {
    return (
      <div className={`mt-3 ${CARD} px-5 py-8 text-center`}>
        <p className="text-sm font-semibold text-foreground">No scored matches yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-foreground-muted">
          Your best roles appear here once jobs have been matched to your profile.
        </p>
        <Link href="/jobs" className={`${SECTION_LINK} mt-3`}>
          Browse jobs <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    );
  }
  return (
    <ul className="mt-3 grid gap-4 md:grid-cols-3">
      {matches.map((match) => (
        <li key={match.id} className="min-w-0">
          <MatchCard match={match} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One vertical match card. The image area is the company's own logo on a neutral field: there is no licensed employer
 * photography in the data, and a stock or generated picture would imply one. "Review & apply" opens the job in the Jobs
 * workspace, where the real apply flow lives (prepare documents, open the official site, confirm it yourself); nothing here
 * submits an application.
 */
function MatchCard({ match }: { match: DashboardTopMatch }) {
  const [saved, setSaved] = useState(Boolean(match.saved));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const meta = [match.location, match.workplaceType && capitalise(match.workplaceType), match.employmentType && capitalise(match.employmentType)]
    .filter((part): part is string => Boolean(part));
  const skills = match.matchedSkills ?? [];

  async function save() {
    if (saved || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await api(`/jobs/${match.id}/save`, { method: "POST" });
      setSaved(true);
      invalidateDashboardSummary();
    } catch {
      setSaveError("Could not save this job.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article aria-label={`${match.title} at ${match.company}`} className={`${CARD} flex h-full flex-col overflow-hidden`}>
      <div className="relative flex h-24 items-center justify-center bg-surface-subtle">
        <span aria-hidden="true">
          <CompanyLogo
            company={match.company}
            logoUrl={null}
            proxyPath={match.logoUrl ?? null}
            companyDomain={null}
            size={48}
          />
        </span>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saved || saving}
          aria-pressed={saved}
          aria-label={saved ? `${match.title} is saved` : `Save ${match.title} at ${match.company}`}
          className="ds-focus-ring ds-touch-target absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-control border border-line-default bg-surface-card text-foreground-secondary transition duration-fast ease-standard hover:text-foreground disabled:cursor-default"
        >
          {saving ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : saved ? <BookmarkCheck aria-hidden className="h-4 w-4 text-brand-primary" /> : <Bookmark aria-hidden className="h-4 w-4" />}
        </button>
      </div>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-2 text-[0.95rem] font-semibold leading-snug text-foreground">{match.title}</h3>
        <p className="mt-0.5 truncate text-sm text-foreground-muted">{match.company}</p>
        {meta.length > 0 && <p className="mt-1 line-clamp-2 text-xs text-foreground-muted">{meta.join(" · ")}</p>}
        <div className="mt-3">
          <FitScoreChip score={match.fitScore} scoreState={match.fitScore == null ? null : "scored"} />
        </div>
        {skills.length > 0 && (
          <ul aria-label="Skills you share with this role" className="mt-3 flex flex-wrap gap-1.5">
            {skills.slice(0, 3).map((skill) => (
              <li key={skill} className="rounded-pill border border-line-default bg-surface-subtle px-2 py-0.5 text-xs text-foreground-secondary">
                {skill}
              </li>
            ))}
            {skills.length > 3 && <li className="px-1 py-0.5 text-xs text-foreground-muted">+{skills.length - 3}</li>}
          </ul>
        )}
        {match.snippet && <p className="mt-3 line-clamp-3 text-sm leading-6 text-foreground-muted">{match.snippet}</p>}
        <div className="mt-auto pt-4">
          {saveError && (
            <p role="alert" className="mb-2 text-xs text-status-danger">
              {saveError}
            </p>
          )}
          <Link
            href={`/jobs?job=${match.id}`}
            className="ds-focus-ring inline-flex h-10 w-full items-center justify-center gap-2 rounded-control bg-action-primary px-4 text-sm font-semibold text-action-primary-foreground transition duration-fast ease-standard hover:bg-action-primary-hover active:translate-y-px"
          >
            Review &amp; apply <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>
    </article>
  );
}

function capitalise(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/* ---------------------------------------------------------------------- */
/* Recent applications                                                    */
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
      <div className="mt-3 divide-y divide-line-subtle px-4 pb-2 sm:px-5" data-testid="recent-applications-skeleton">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 py-3">
            <Skeleton className="h-8 w-8 shrink-0 rounded-control" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="mt-1.5 h-3.5 w-28" />
            </div>
            <Skeleton className="h-6 w-20 rounded-pill" />
          </div>
        ))}
        <span className="sr-only">Loading your applications</span>
      </div>
    );
  }
  if (applications.length === 0) {
    return (
      <p className="px-4 pb-5 pt-3 text-sm text-foreground-muted sm:px-5">
        No applications yet. Applications appear here after you confirm that you submitted them, or save a role.{" "}
        <Link href="/jobs" className="font-semibold text-foreground-link underline">
          Browse jobs
        </Link>
      </p>
    );
  }
  return (
    // `relative` matters: the visually hidden "Actions" header text is absolutely positioned, and an unpositioned scroll wrapper
    // does not clip it, so it would stretch the whole page sideways on a phone.
    <div className="relative mt-2 overflow-x-auto">
      <table className="w-full table-auto text-left text-sm">
        <caption className="sr-only">Your most recently updated applications</caption>
        <thead className="text-xs uppercase tracking-wide text-foreground-muted">
          <tr className="border-b border-line-subtle">
            <th scope="col" className="px-4 py-2 font-medium sm:px-5">Role</th>
            <th scope="col" className="hidden px-2 py-2 font-medium md:table-cell">Applied</th>
            <th scope="col" className="px-2 py-2 font-medium">Status</th>
            <th scope="col" className="hidden px-2 py-2 font-medium sm:table-cell">Fit</th>
            <th scope="col" className="px-4 py-2 text-right font-medium sm:px-5"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-subtle">
          {applications.map((application) => (
            <tr key={application.id}>
              <td className="w-full max-w-0 px-4 py-3 sm:px-5">
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="shrink-0">
                    <CompanyLogo company={application.company} logoUrl={null} proxyPath={application.logoUrl} companyDomain={null} size={32} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{application.title}</p>
                    <p className="truncate text-xs text-foreground-muted">{application.company}</p>
                  </div>
                </div>
              </td>
              <td className="hidden whitespace-nowrap px-2 py-3 text-foreground-muted md:table-cell">
                {application.appliedAt ? formatShortDate(application.appliedAt) : <span aria-label="Not applied yet">—</span>}
              </td>
              <td className="px-2 py-3">
                <StatusBadge tone={getApplicationStatusTone(application.status)}>
                  {formatApplicationStatus(application.status)}
                </StatusBadge>
              </td>
              <td className="hidden px-2 py-3 sm:table-cell">
                {application.fitScore != null ? (
                  <FitScoreChip score={application.fitScore} scoreState="scored" />
                ) : (
                  <span aria-label="No fit score" className="text-foreground-muted">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-right sm:px-5">
                <Link
                  href="/tracker"
                  aria-label={`Open ${application.title} at ${application.company} in Applications${application.updatedAt ? `, updated ${formatRelative(application.updatedAt)}` : ""}`}
                  className="ds-focus-ring ds-touch-target inline-flex items-center gap-1 rounded-control text-sm font-semibold text-foreground-link"
                >
                  View <ChevronRight className="h-4 w-4" aria-hidden />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatRelative(value: string): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "recently";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return formatShortDate(value);
}

/* ---------------------------------------------------------------------- */
/* Profile completion                                                     */
/* ---------------------------------------------------------------------- */

function ProfileCompletion({
  profile,
  fallbackPercent,
  loading
}: {
  profile?: DashboardProfile;
  fallbackPercent?: number;
  loading: boolean;
}) {
  if (loading) {
    return (
      <section className={`${CARD} p-5`} data-testid="profile-skeleton">
        <h2 className="text-base font-semibold text-foreground">Profile completion</h2>
        <Skeleton className="mt-4 block h-2 w-full rounded-pill" />
        <Skeleton className="mt-4 block h-24 w-full" />
        <span className="sr-only">Loading your profile completion</span>
      </section>
    );
  }
  // An older API sends only the percentage (inside the next action); show that and nothing it cannot back up.
  const percent = profile?.percent ?? fallbackPercent ?? 0;
  const missing = profile?.missing ?? [];
  const completed = profile?.completed ?? [];
  return (
    <section aria-labelledby="profile-title" className={`${CARD} p-5`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="profile-title" className="text-base font-semibold text-foreground">
          Profile completion
        </h2>
        <p className="text-sm font-semibold tabular-nums text-foreground">{percent}%</p>
      </div>
      <div
        role="progressbar"
        aria-label="Profile completion"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-3 h-1.5 overflow-hidden rounded-pill bg-surface-subtle"
      >
        <div className="h-full rounded-pill bg-brand-accent transition-[width] duration-normal ease-standard" style={{ width: `${percent}%` }} />
      </div>
      {(completed.length > 0 || missing.length > 0) && (
        <ul className="mt-4 space-y-2 text-sm">
          {completed.map((section) => (
            <li key={section.key} className="flex items-center gap-2 text-foreground-secondary">
              <Check aria-hidden className="h-4 w-4 shrink-0 text-status-success" />
              <span>{section.label}</span>
              <span className="sr-only"> (done)</span>
            </li>
          ))}
          {missing.map((section) => (
            <li key={section.key} className="flex items-start gap-2 text-foreground-muted">
              <span aria-hidden className="mt-1.5 h-3 w-3 shrink-0 rounded-pill border border-line-strong" />
              <span>{section.label}</span>
              <span className="sr-only"> (to do)</span>
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/profile"
        className="ds-focus-ring mt-4 inline-flex h-9 w-full items-center justify-center rounded-control border border-action-secondary-border bg-action-secondary px-3 text-sm font-semibold text-action-secondary-foreground transition duration-fast ease-standard hover:bg-action-ghost-hover"
      >
        {percent >= 100 ? "Review profile" : "Continue profile"}
      </Link>
    </section>
  );
}

/* ---------------------------------------------------------------------- */
/* Application pipeline                                                   */
/* ---------------------------------------------------------------------- */

/**
 * The buckets are the backend's own and are disjoint (see `STATUS_BUCKETS`): `withdrawn` belongs to none, so nothing is counted
 * twice and the centre total is exactly the sum of the slices. The colours are the semantic ones used for status elsewhere;
 * every slice is also named and counted in the legend, so the chart is never colour-only.
 */
const PIPELINE: { key: keyof DashboardApplicationCounts; label: string; color: string }[] = [
  // The same hues the status badges use for these stages, so the chart and the table above it agree.
  { key: "saved", label: "Saved", color: "var(--color-border-interactive)" },
  { key: "inProgress", label: "In progress", color: "var(--color-status-warning)" },
  { key: "interviews", label: "Interviews", color: "var(--color-status-info)" },
  { key: "offers", label: "Offers", color: "var(--color-status-success)" },
  { key: "rejected", label: "Rejected", color: "var(--color-status-danger)" }
];

function PipelineCard({ counts, loading }: { counts?: DashboardApplicationCounts; loading: boolean }) {
  if (loading || !counts) {
    return (
      <section className={`${CARD} p-5`} data-testid="pipeline-skeleton">
        <h2 className="text-base font-semibold text-foreground">Application pipeline</h2>
        <Skeleton className="mx-auto mt-5 block h-32 w-32 rounded-pill" />
        <span className="sr-only">Loading your application pipeline</span>
      </section>
    );
  }
  const slices = PIPELINE.map((stage) => ({ ...stage, value: counts[stage.key] ?? 0 }));
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  return (
    <section aria-labelledby="pipeline-title" className={`${CARD} p-5`}>
      <h2 id="pipeline-title" className="text-base font-semibold text-foreground">
        Application pipeline
      </h2>
      {total === 0 ? (
        <p className="mt-3 text-sm text-foreground-muted">
          Save or start an application and your pipeline will appear here.{" "}
          <Link href="/jobs" className="font-semibold text-foreground-link underline">
            Browse jobs
          </Link>
        </p>
      ) : (
        <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row xl:flex-col">
          <Donut slices={slices} total={total} />
          <dl className="w-full space-y-1.5 text-sm">
            {slices.map((slice) => (
              <div key={slice.key} className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-foreground-secondary">
                  <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-pill" style={{ backgroundColor: slice.color }} />
                  {slice.label}
                </dt>
                <dd className="font-semibold tabular-nums text-foreground">{slice.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

function Donut({ slices, total }: { slices: { key: string; value: number; color: string }[]; total: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  // Each arc starts where the previous one ended; computed up front so rendering stays free of mutation.
  const arcs = slices
    .filter((slice) => slice.value > 0)
    .reduce<{ key: string; color: string; start: number; length: number }[]>((acc, slice) => {
      const start = acc.length ? acc[acc.length - 1].start + acc[acc.length - 1].length : 0;
      return [...acc, { key: slice.key, color: slice.color, start, length: (slice.value / total) * circumference }];
    }, []);
  return (
    <div className="relative h-32 w-32 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden focusable="false">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--color-surface-subtle)" strokeWidth="12" />
        {arcs.map((arc) => (
          <circle
            key={arc.key}
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth="12"
            strokeDasharray={`${arc.length} ${circumference - arc.length}`}
            strokeDashoffset={-arc.start}
          />
        ))}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="text-2xl font-semibold leading-none tabular-nums text-foreground">{total}</p>
          <p className="mt-0.5 text-[11px] text-foreground-muted">tracked</p>
        </div>
      </div>
    </div>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`inline-block animate-pulse rounded bg-skeleton align-middle ${className}`} />;
}
