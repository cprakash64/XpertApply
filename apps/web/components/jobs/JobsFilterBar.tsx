"use client";

import { Loader2, Search } from "lucide-react";
import type { JobsQuery, JobSort } from "@/lib/jobsQuery";

const WORKPLACE_OPTIONS = ["", "remote", "hybrid", "onsite"] as const;

/**
 * One compact row of controls. The filters live in the URL, so a link to a
 * filtered list is shareable and reloading keeps the list the user built.
 */
export function JobsFilterBar({
  query,
  onChange,
  dateRefreshing,
  summary,
  actions
}: {
  query: JobsQuery;
  onChange: (patch: Partial<JobsQuery>) => void;
  dateRefreshing: boolean;
  /** The result count, shown right under the controls. */
  summary?: string;
  /** Page-level actions (find, refresh), kept quiet and out of the way of the filters. */
  actions?: React.ReactNode;
}) {
  const hasFilters = Boolean(query.q || query.workplace || query.minFit > 0);
  const window = query.postedWithin === 1 ? "24 hours" : `${query.postedWithin} days`;
  return (
    <>
    <div className="flex flex-wrap items-center gap-2">
      {/* Search stays first and widest: it is the control people reach for
        * before any of the dropdowns. */}
      <label className="min-w-[220px] flex-1">
        <span className="sr-only">Role or skill</span>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted"
          />
          <input
            aria-label="Role or skill"
            className="ds-field ds-focus-ring h-10 w-full rounded-field border border-line-interactive bg-surface-card pl-9 pr-3 text-sm text-foreground transition duration-fast ease-standard placeholder:text-foreground-muted hover:border-line-strong"
            placeholder="Search role or skill"
            value={query.q}
            onChange={(event) => onChange({ q: event.target.value })}
          />
        </div>
      </label>

      <FilterSelect
        ariaLabel="Workplace type"
        value={query.workplace}
        onChange={(value) => onChange({ workplace: value })}
        options={WORKPLACE_OPTIONS.map((option) => ({
          value: option,
          label: option ? option[0].toUpperCase() + option.slice(1) : "Any workplace"
        }))}
      />

      <FilterSelect
        ariaLabel="Minimum fit score"
        value={String(query.minFit)}
        onChange={(value) => onChange({ minFit: Number(value) })}
        options={[
          { value: "0", label: "Any fit" },
          { value: "60", label: "60% and above" },
          { value: "70", label: "70% and above" },
          { value: "80", label: "80% and above" }
        ]}
      />

      <div className="relative">
        <FilterSelect
          ariaLabel="Posted within days"
          value={String(query.postedWithin)}
          onChange={(value) => onChange({ postedWithin: Number(value) })}
          options={[
            { value: "1", label: "Past 24 hours" },
            { value: "3", label: "Past 3 days" },
            { value: "7", label: "Past 7 days" },
            { value: "14", label: "Past 14 days" },
            { value: "30", label: "Past 30 days" }
          ]}
        />
        {dateRefreshing && (
          <Loader2
            aria-label="Refreshing date range"
            className="pointer-events-none absolute right-7 top-3 h-4 w-4 animate-spin text-brand-accent"
          />
        )}
      </div>

      <FilterSelect
        ariaLabel="Sort jobs"
        value={query.sort}
        onChange={(value) => onChange({ sort: value as JobSort })}
        options={[
          { value: "best_recent", label: "Best & recent" },
          { value: "fit", label: "Best fit" },
          { value: "newest", label: "Newest first" }
        ]}
      />

      {hasFilters && (
        <button
          type="button"
          onClick={() => onChange({ q: "", workplace: "", minFit: 0 })}
          className="ds-focus-ring h-10 rounded-control px-3 text-[13px] font-medium text-foreground-muted transition-colors duration-fast ease-standard hover:bg-surface-subtle hover:text-foreground"
        >
          Clear filters
        </button>
      )}
    </div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p className="text-sm text-foreground-muted">
        {summary && <span className="font-semibold text-foreground">{summary}</span>}
        {` · Posted in the last ${window}`}
        {/* Said once, here, so a shorter list is never a mystery: the posting date is the employer's, never the day we found it. */}
        <span className="hidden sm:inline"> · Jobs without a posting date are not shown</span>
      </p>
      {actions && <div className="flex flex-wrap items-center gap-1">{actions}</div>}
    </div>
    </>
  );
}

function FilterSelect({
  ariaLabel,
  value,
  onChange,
  options
}: {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label>
      <span className="sr-only">{ariaLabel}</span>
      <select
        aria-label={ariaLabel}
        className="ds-field ds-focus-ring h-10 rounded-field border border-line-interactive bg-surface-card px-2.5 text-[13px] font-medium text-foreground transition duration-fast ease-standard hover:border-line-strong"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value || "any"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
