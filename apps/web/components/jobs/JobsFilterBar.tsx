"use client";

import { useRef, useState } from "react";
import { ArrowUpDown, Building2, CalendarDays, ChevronDown, Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import type { JobsQuery, JobSort } from "@/lib/jobsQuery";
import { JOBS_QUERY_DEFAULTS } from "@/lib/jobsQuery";

const WORKPLACE_OPTIONS = ["", "remote", "hybrid", "onsite"] as const;

/**
 * The Jobs top navigation: one full-width, borderless row of integrated items
 * separated by fine vertical rules, with the page actions at the right end. The
 * filters live in the URL, so a link to a filtered list is shareable and
 * reloading keeps the list the user built.
 *
 * Each filter is a native <select> restyled to read as a navbar item. That keeps
 * the platform's own menu (mouse, keyboard and the touch picker) instead of a
 * hand-built popover.
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
  /** The result count, shown right under the navbar. */
  summary?: string;
  /** Page-level actions (find, refresh), placed at the right end of the navbar. */
  actions?: React.ReactNode;
}) {
  const hasFilters = Boolean(query.q || query.workplace || query.minFit > 0);
  const window = query.postedWithin === 1 ? "24 hours" : `${query.postedWithin} days`;
  return (
    <>
      <div className="border-b border-line-default bg-surface-page sm:sticky sm:top-0 sm:z-10">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-1 gap-y-1 px-4 py-2.5 xl:flex-nowrap sm:px-6 lg:px-8">
          <SearchItem value={query.q} onChange={(q) => onChange({ q })} />

          <Divider />
          <FilterSelect
            ariaLabel="Workplace type"
            icon={<Building2 aria-hidden className="h-4 w-4" />}
            value={query.workplace}
            isDefault={query.workplace === JOBS_QUERY_DEFAULTS.workplace}
            onChange={(value) => onChange({ workplace: value })}
            options={WORKPLACE_OPTIONS.map((option) => ({
              value: option,
              label: option ? option[0].toUpperCase() + option.slice(1) : "Any workplace"
            }))}
          />

          <Divider />
          <FilterSelect
            ariaLabel="Minimum fit score"
            icon={<SlidersHorizontal aria-hidden className="h-4 w-4" />}
            value={String(query.minFit)}
            isDefault={query.minFit === JOBS_QUERY_DEFAULTS.minFit}
            onChange={(value) => onChange({ minFit: Number(value) })}
            options={[
              { value: "0", label: "Any fit" },
              { value: "60", label: "60% and above" },
              { value: "70", label: "70% and above" },
              { value: "80", label: "80% and above" }
            ]}
          />

          <Divider />
          <FilterSelect
            ariaLabel="Posted within days"
            icon={
              dateRefreshing ? (
                <Loader2 aria-label="Refreshing date range" className="h-4 w-4 animate-spin text-brand-accent" />
              ) : (
                <CalendarDays aria-hidden className="h-4 w-4" />
              )
            }
            value={String(query.postedWithin)}
            isDefault={query.postedWithin === JOBS_QUERY_DEFAULTS.postedWithin}
            onChange={(value) => onChange({ postedWithin: Number(value) })}
            options={[
              { value: "1", label: "Past 24 hours" },
              { value: "3", label: "Past 3 days" },
              { value: "7", label: "Past 7 days" },
              { value: "14", label: "Past 14 days" },
              { value: "30", label: "Past 30 days" }
            ]}
          />

          <Divider />
          <FilterSelect
            ariaLabel="Sort jobs"
            icon={<ArrowUpDown aria-hidden className="h-4 w-4" />}
            value={query.sort}
            isDefault={query.sort === JOBS_QUERY_DEFAULTS.sort}
            onChange={(value) => onChange({ sort: value as JobSort })}
            options={[
              { value: "best_recent", label: "Best & Recent" },
              { value: "fit", label: "Best Fit" },
              { value: "newest", label: "Newest First" }
            ]}
          />

          {actions && (
            <>
              <Divider />
              <div className="mt-1 flex w-full items-center gap-2 sm:ml-auto sm:mt-0 sm:w-auto sm:shrink-0 sm:pl-2 [&>*]:max-sm:flex-1">
                {actions}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 sm:px-6 lg:px-8">
        <p className="text-sm text-foreground-muted">
          {summary && <span className="font-semibold text-foreground">{summary}</span>}
          {` · Posted in the last ${window}`}
          {/* Said once, here, so a shorter list is never a mystery: the posting date is the employer's, never the day we found it. */}
          <span className="hidden sm:inline"> · Jobs without a posting date are not shown</span>
        </p>
        {hasFilters && (
          <button
            type="button"
            onClick={() => onChange({ q: "", workplace: "", minFit: 0 })}
            className="ds-focus-ring -my-1 h-8 rounded-control px-2.5 text-[13px] font-medium text-foreground-muted transition-colors duration-fast ease-standard hover:bg-surface-subtle hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>
    </>
  );
}

/** A fine vertical rule between navbar groups; it disappears where the controls wrap into a grid. */
function Divider() {
  return <span aria-hidden className="mx-1 hidden h-5 w-px shrink-0 bg-line-default sm:block" />;
}

/**
 * Search is compact ("Search") until it is wanted, then takes the spare row
 * width. The input is always mounted, so it stays a real, labelled form control
 * for assistive tech; only its footprint changes. It stays open while it holds a
 * query so the active search is never hidden.
 */
function SearchItem({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const open = focused || value !== "";
  return (
    <label
      className={`group flex h-10 min-w-0 cursor-text items-center gap-2 rounded-control px-2.5 text-foreground-secondary transition-[flex-grow,flex-basis,background-color] duration-200 ease-standard hover:bg-surface-subtle focus-within:bg-surface-subtle focus-within:ring-2 focus-within:ring-line-selected max-sm:w-full max-sm:basis-full ${
        open ? "grow basis-[200px]" : "grow-0 basis-[104px]"
      }`}
    >
      <Search aria-hidden className="h-4 w-4 shrink-0" />
      <input
        ref={input}
        aria-label="Role or skill"
        className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-foreground focus-visible:outline-none placeholder:text-foreground-secondary focus:placeholder:text-foreground-muted"
        placeholder={open ? "Role, company or skill" : "Search"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          // Escape leaves the field; an empty one then collapses back to "Search". A typed query is kept.
          if (event.key === "Escape") input.current?.blur();
        }}
      />
      {value !== "" && (
        <button
          type="button"
          aria-label="Clear search"
          // Keep the input focused: the button must not blur it before the click lands.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
          className="ds-focus-ring -mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-foreground-muted hover:text-foreground"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      )}
    </label>
  );
}

function FilterSelect({
  ariaLabel,
  icon,
  value,
  isDefault,
  onChange,
  options
}: {
  ariaLabel: string;
  icon: React.ReactNode;
  value: string;
  /** A non-default choice is shown in full-strength text so an active filter is visible at a glance. */
  isDefault: boolean;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? "";
  return (
    <label
      className={`relative flex h-10 min-w-0 items-center rounded-control transition-colors duration-fast ease-standard hover:bg-surface-subtle focus-within:bg-surface-subtle sm:shrink-0 max-sm:basis-[calc(50%-0.125rem)] ${
        isDefault ? "text-foreground-secondary" : "text-foreground"
      }`}
    >
      <span className="sr-only">{ariaLabel}</span>
      <span className="pointer-events-none absolute left-2.5 flex items-center">{icon}</span>
      {/* Sizes the control to the CHOSEN label: a native select is as wide as its longest option, which left "Any fit"
        * with a 175px box. The select is laid over this ghost text. */}
      <span aria-hidden className="invisible whitespace-nowrap pl-8 pr-9 text-[13px] font-medium max-sm:w-full max-sm:pl-7 max-sm:pr-6 max-sm:truncate">
        {selectedLabel}
      </span>
      <select
        aria-label={ariaLabel}
        className="ds-focus-ring absolute inset-0 h-10 w-full min-w-0 cursor-pointer appearance-none truncate rounded-control bg-transparent pl-8 pr-9 max-sm:pl-7 max-sm:pr-6 text-[13px] font-medium text-inherit"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value || "any"} value={option.value} className="bg-surface-card text-foreground">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-foreground-muted" />
    </label>
  );
}
