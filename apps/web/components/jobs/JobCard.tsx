"use client";

import { memo, useCallback, useId, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  Banknote,
  Bookmark,
  BookmarkCheck,
  Briefcase,
  Building2,
  CalendarDays,
  FileText,
  Loader2,
  Mail,
  MapPin,
  Users
} from "lucide-react";
import type { Job, PeopleResponse } from "@/lib/api";
import { getScoreDisplay } from "@/lib/fitScore";
import { peopleActionSummary } from "@/lib/peopleState";
import { getCachedPeople, subscribeToPeople } from "@/lib/peopleClient";
import { CompanyLogo } from "@/components/CompanyLogo";
import { StatusBadge } from "@/components/ui";
import {
  formatApplicationStatus,
  getApplicationStatusTone
} from "@/lib/applicationStatus";
import { FitBadge, FitPill, Meta, SalaryChip, SourceBadge } from "@/components/jobs/badges";
import { AssistedApplyButton } from "@/components/jobs/ApplyButton";
import {
  capitalize,
  formatEmployment,
  formatSalary,
  postedLabel,
  shortPostedLabel,
  showsWorkplaceType
} from "@/components/jobs/format";
import type { DocType } from "@/components/jobs/documents";
import type { TrackerStatus } from "@/components/TrackerClient";

export type JobCardActions = {
  onSelect: (jobId: number) => void;
  onSave: (jobId: number) => void;
  onApply: (jobId: number) => void;
  onGenerate: (jobId: number, type: DocType) => void;
  /** Opens the job with its Networking section active. Never starts a search. */
  onOpenPeople: (jobId: number) => void;
};

/**
 * Selecting a job by clicking the card body.
 *
 * The card is not itself a control: its title is a real button (so the card has
 * exactly one keyboard stop, Enter and Space work natively, and the action
 * buttons are not nested inside another interactive element). This handler adds
 * the convenience of clicking anywhere else on the card, while deliberately
 * ignoring clicks that mean something else.
 */
function cardClickOpens(event: React.MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented) return false;
  // Modifier-clicks are "open somewhere else" gestures elsewhere in the web;
  // silently selecting instead would be surprising.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest("a,button,input,select,textarea,label,[role='button']")) return false;
  // Do not swallow a click that ended a text selection.
  if (typeof window !== "undefined" && window.getSelection()?.toString()) return false;
  return true;
}

function stop(event: React.MouseEvent) {
  event.stopPropagation();
}

export const JobCard = memo(function JobCard({
  job,
  generating,
  trackerStatus,
  actions
}: {
  job: Job;
  generating: DocType | null;
  trackerStatus: TrackerStatus | null;
  actions: JobCardActions;
}) {
  const titleId = useId();
  const fit = job.match?.fit_score ?? null;
  const salary = formatSalary(job.salary_min, job.salary_max, job.salary_currency);
  const reasons = job.match?.match_reasons?.slice(0, 2) ?? [];
  const posted = postedLabel(job.posted_at);
  const scoreDisplay = getScoreDisplay(job.match?.score_state ?? null, job.match?.fit_score ?? null);

  return (
    <article
      data-testid="job-card"
      data-job-id={job.id}
      aria-labelledby={titleId}
      onClick={(event) => {
        if (cardClickOpens(event)) actions.onSelect(job.id);
      }}
      // `min-w-0`: the card is a grid item, whose default `min-width: auto`
      // refuses to shrink below the content's min-content width. Without it a
      // long role title pushed the whole card ~130px past a 390px viewport and
      // gave the document a horizontal scrollbar.
      className="group relative min-w-0 cursor-pointer rounded-card border border-line-default bg-surface-card p-4 transition-[border-color,background-color] duration-fast ease-standard hover:border-line-interactive hover:bg-surface-subtle has-[:focus-visible]:border-line-selected sm:p-6"
    >
      {/* Two columns so the score card never pushes the title down: identity and
        * context stay one continuous block on the left. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-3">
            <CompanyLogo
              company={job.company}
              logoUrl={job.company_logo_url}
              proxyPath={job.company_logo_proxy_path}
              companyDomain={job.company_domain}
              size={40}
            />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-foreground-muted">{job.company}</p>
              <h2
                id={titleId}
                className="mt-0.5 text-[1.15rem] font-semibold leading-snug tracking-[-0.01em] text-foreground"
              >
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    actions.onSelect(job.id);
                  }}
                  // The focus ring is drawn around the whole card instead, so the
                  // card itself reads as the focused element.
                  className="rounded text-left focus-visible:outline-none"
                >
                  {job.title}
                </button>
              </h2>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[13px] text-foreground-muted">
            {job.location && (
              <Meta icon={<MapPin className="h-3.5 w-3.5" />}>{job.location_display || job.location}</Meta>
            )}
            {showsWorkplaceType(job.workplace_type, job.location_display || job.location) && (
              <Meta icon={<Building2 className="h-3.5 w-3.5" />}>{capitalize(job.workplace_type!)}</Meta>
            )}
            {job.employment_type && (
              <Meta icon={<Briefcase className="h-3.5 w-3.5" />}>{formatEmployment(job.employment_type)}</Meta>
            )}
            {posted && <Meta icon={<CalendarDays className="h-3.5 w-3.5" />}>{posted}</Meta>}
            <SourceBadge source={job.source} />
            <TrackerPill status={trackerStatus} />
            {/* Compensation earns its own weight rather than blending into the
              * metadata — and is simply absent when the employer published none. */}
            {salary && <SalaryChip value={salary} />}
          </div>

          {reasons.length > 0 ? (
            <ul className="mt-3.5 grid gap-1.5 text-sm leading-6 text-foreground-secondary">
              {reasons.map((reason) => (
                <li key={reason} className="flex gap-2.5">
                  <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-pill bg-brand-accent" />
                  <span className="line-clamp-2">{reason}</span>
                </li>
              ))}
            </ul>
          ) : scoreDisplay.kind !== "score" ? (
            <p className="mt-3.5 flex items-center gap-2 text-sm text-foreground-muted">
              {scoreDisplay.kind === "calculating" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{scoreDisplay.helper}</span>
              {scoreDisplay.kind === "profile_incomplete" && (
                <Link href="/profile" className="ds-focus-ring rounded-control font-medium text-foreground-link underline" onClick={stop}>
                  Complete profile
                </Link>
              )}
            </p>
          ) : null}
        </div>

        {/* Below the identity block on a phone, beside it from `sm` up: the
          * role and the company are what a scan is looking for first. */}
        <div>
          <FitBadge score={fit} label={job.match?.fit_label ?? null} scoreState={job.match?.score_state ?? null} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line-subtle pt-4">
        <AssistedApplyButton url={job.application_url} onApply={() => actions.onApply(job.id)} />
        <CardAction
          label={trackerStatus ? "Saved" : "Save"}
          icon={trackerStatus ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
          onClick={() => actions.onSave(job.id)}
        />
        <CardAction
          label={generating === "resume" ? "Generating resume…" : "Resume"}
          icon={generating === "resume" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          disabled={generating !== null}
          onClick={() => actions.onGenerate(job.id, "resume")}
        />
        <CardAction
          label={generating === "cover_letter" ? "Generating cover letter…" : "Cover Letter"}
          icon={generating === "cover_letter" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
          disabled={generating !== null}
          onClick={() => actions.onGenerate(job.id, "cover_letter")}
        />
        <PeopleAction jobId={job.id} onOpen={() => actions.onOpenPeople(job.id)} />
      </div>
    </article>
  );
});

/** Secondary action: quieter than Apply, still a 40px target. */
function CardAction({
  label,
  icon,
  onClick,
  disabled
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="ds-focus-ring inline-flex h-10 items-center gap-2 rounded-control border border-action-secondary-border bg-action-secondary px-3 text-sm font-semibold text-action-secondary-foreground transition duration-fast ease-standard hover:bg-action-ghost-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * People state without a request.
 *
 * The label reflects only what the client already knows (a search this session,
 * or nothing). Mounting, scrolling, filtering, or re-rendering the list can
 * never call the people API from here — pressing it opens the job's Networking
 * section, where a search is still an explicit, separate choice.
 */
function PeopleAction({ jobId, onOpen }: { jobId: number; onOpen: () => void }) {
  // Subscribing to the client-side cache — never a fetch. The label changes only
  // because a search the user asked for elsewhere published a result.
  const data = useSyncExternalStore<PeopleResponse | null>(
    useCallback((notify) => subscribeToPeople(jobId, notify), [jobId]),
    useCallback(() => getCachedPeople(jobId), [jobId]),
    () => null
  );

  const summary = peopleActionSummary(data);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      data-people-state={summary.state}
      className="ds-focus-ring inline-flex h-10 items-center gap-2 rounded-control border border-action-secondary-border bg-action-secondary px-3 text-sm font-semibold text-action-secondary-foreground transition duration-fast ease-standard hover:bg-action-ghost-hover"
    >
      {summary.state === "loading" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Users className="h-4 w-4" />
      )}
      {summary.label}
    </button>
  );
}

/**
 * The job's place in the tracker, told with the same vocabulary as the Tracker
 * and the Dashboard.
 *
 * This used to collapse every post-save state into a green "In tracker", which
 * spent the success colour on merely having applied and hid which stage the
 * application had actually reached. Tone and wording now come from the shared
 * application-status module, so an offer is the only green here and a rejection
 * finally looks like one.
 */
function TrackerPill({ status }: { status: TrackerStatus | null }) {
  if (!status) {
    return null;
  }
  return (
    <StatusBadge tone={getApplicationStatusTone(status)} className="gap-1">
      <BookmarkCheck aria-hidden className="h-3 w-3" />
      {formatApplicationStatus(status)}
    </StatusBadge>
  );
}

/**
 * The list card once a job is open: identity, one line of context, and state.
 * Everything explanatory lives in the detail panel, so scanning 100 roles stays
 * a scanning task.
 */
export const CompactJobCard = memo(function CompactJobCard({
  job,
  selected,
  trackerStatus,
  onSelect
}: {
  job: Job;
  selected: boolean;
  trackerStatus: TrackerStatus | null;
  onSelect: (jobId: number) => void;
}) {
  const posted = shortPostedLabel(job.posted_at);
  const salary = formatSalary(job.salary_min, job.salary_max, job.salary_currency);
  const place =
    job.location_display ||
    job.location ||
    (job.workplace_type && job.workplace_type !== "unknown"
      ? job.workplace_type[0].toUpperCase() + job.workplace_type.slice(1)
      : null);

  return (
    <li>
      <button
        type="button"
        data-testid="compact-job-card"
        data-job-id={job.id}
        data-selected={selected ? "true" : "false"}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(job.id)}
        className={`ds-focus-ring block w-full rounded-control border px-3 py-3 text-left transition-colors duration-fast ease-standard ${
          selected
            ? "border-line-selected bg-surface-selected"
            : "border-transparent bg-transparent hover:border-line-default hover:bg-surface-subtle"
        }`}
      >
        <div className="flex items-start gap-3">
          <CompanyLogo
            company={job.company}
            logoUrl={job.company_logo_url}
            proxyPath={job.company_logo_proxy_path}
            companyDomain={job.company_domain}
            size={32}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="truncate text-xs font-medium text-foreground-muted">{job.company}</p>
              <FitPill
                score={job.match?.fit_score ?? null}
                label={job.match?.fit_label ?? null}
                scoreState={job.match?.score_state ?? null}
              />
            </div>
            <p className={`mt-0.5 line-clamp-2 text-sm font-semibold leading-snug ${selected ? "text-brand-primary" : "text-foreground"}`}>
              {job.title}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-foreground-muted">
              {place && <span className="truncate">{place}</span>}
              {place && posted && <span aria-hidden>·</span>}
              {posted && <span>{posted}</span>}
              {salary && (
                <>
                  <span aria-hidden>·</span>
                  <span className="font-medium text-foreground-secondary">
                    <span className="sr-only">Salary range </span>
                    {salary}
                  </span>
                </>
              )}
            </p>
            {trackerStatus && (
              <p className="mt-1.5">
                <TrackerPill status={trackerStatus} />
              </p>
            )}
          </div>
        </div>
      </button>
    </li>
  );
});
