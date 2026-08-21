"use client";

import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";

/**
 * Shared building blocks for the Profile overview.
 *
 * Every colour here is a semantic token, so the surface is a dark charcoal card
 * on a near-black background in dark mode and a white card on warm paper in
 * light mode, with no per-component overrides. Green is reserved for the
 * primary action, the active meter fill and the Edit affordance — the cards
 * themselves stay neutral so the accent still means something.
 */

/**
 * One overview card.
 *
 * The hover treatment is deliberately restrained: the border brightens by one
 * step and the card lifts 1px. `motion-safe` scopes the movement so users who
 * asked for reduced motion get the border change without the translation.
 */
export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    // `min-w-0` matters: a grid/flex item defaults to min-width:auto, so without
    // it a long email or URL inside the card would push the card wider than its
    // column instead of truncating. The same reasoning applies to the inner
    // wrappers below.
    <section
      className={`group/card min-w-0 rounded-card border border-line-default bg-surface-card p-5 transition duration-150 hover:border-line-interactive motion-safe:hover:-translate-y-px ${className}`}
    >
      {children}
    </section>
  );
}


/**
 * A profile-overview card whose whole surface opens its editor.
 *
 * The semantics matter here. A `div` with an `onClick` is invisible to keyboard
 * and assistive tech, and wrapping the card in an `<a>` would make every nested
 * link an invalid anchor-inside-anchor. So the card stays a plain `<section>`
 * and the *heading's* Edit link is the real control — it is stretched over the
 * card with an absolutely-positioned `::after` (`stretched-link`). That gives:
 *
 * * one focusable, correctly-named link per card (Tab reaches it once);
 * * Enter activation for free, because it is a genuine link;
 * * a real href, so middle-click and ⌘-click open a new tab as expected.
 *
 * Nested links (LinkedIn, a project URL, a credential) sit above the stretched
 * overlay via `relative z-10`, so clicking one opens *it* rather than the
 * editor — no `stopPropagation`, no click-target guessing.
 */
export function ClickableCard({
  href,
  title,
  icon,
  children,
  className = ""
}: {
  href: string;
  title: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={`relative isolate ${className}`}>
      <SectionHeading title={title} icon={icon} href={href} stretched />
      {children}
    </Card>
  );
}

/** Card title plus its Edit action. */
export function SectionHeading({
  title,
  icon: Icon,
  href,
  stretched = false
}: {
  title: string;
  icon?: LucideIcon;
  href: string;
  /** Expand this heading's Edit link to cover the whole card. */
  stretched?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold tracking-[-0.01em]">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-foreground-muted" aria-hidden />}
        <span className="truncate">{title}</span>
      </h2>
      <EditLink href={href} label={`Edit ${title.toLowerCase()}`} stretched={stretched} />
    </div>
  );
}

/**
 * The Edit affordance.
 *
 * The arrow nudges right on hover. The accessible name is explicit because
 * "Edit" repeated down the page tells a screen-reader user nothing about which
 * section they are about to open.
 */
export function EditLink({
  href,
  label,
  stretched = false
}: {
  href: string;
  label: string;
  stretched?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className={`ds-focus-ring group/edit inline-flex shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-sm font-medium text-foreground-muted transition hover:text-foreground-link ${
        stretched ? "stretched-link" : ""
      }`}
    >
      Edit
      <ArrowRight
        aria-hidden
        className="h-3.5 w-3.5 transition-transform duration-150 motion-safe:group-hover/edit:translate-x-0.5"
      />
    </Link>
  );
}

/** A labelled progress bar. Values are clamped so the fill can never overflow. */
export function ProgressMeter({
  label,
  percent,
  hint
}: {
  label: string;
  percent: number;
  hint?: string;
}) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <p className="truncate text-xs font-medium uppercase tracking-[0.08em] text-foreground-muted">
          {label}
        </p>
        <p className="shrink-0 text-sm font-semibold tabular-nums">{value}%</p>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle"
      >
        <span
          className="block h-full rounded-full bg-brand-accent transition-[width] duration-300"
          style={{ width: `${value}%` }}
        />
      </div>
      {hint && <p className="mt-1.5 truncate text-xs text-foreground-muted">{hint}</p>}
    </div>
  );
}

/** Only http(s) may become a clickable destination. */
function isSafeExternalUrl(value?: string): value is string {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A compact icon row for contact details.
 *
 * External links carry `rel="noopener noreferrer"`: these URLs come from the
 * user's own profile, but they are still arbitrary destinations and must not be
 * handed a reference to this window.
 *
 * The scheme is re-checked here rather than trusted from the caller. `PUT
 * /profile` validates URLs as HttpUrl, but the resume-import apply path accepts
 * an untyped links object, so a stored value is not guaranteed to be http(s) —
 * and a `javascript:` href in an anchor is script execution, not a bad link.
 * Anything that does not validate is rendered as plain text: the user still
 * sees what is stored, it is simply not clickable.
 */
/**
 * Any icon component that accepts a className — the lucide set, or the inline
 * brand marks in BrandIcons.tsx.
 */
export type MetaRowIcon = (props: { className?: string }) => React.ReactNode;

/** Which restrained tint a row's icon chip uses. */
export type MetaRowTone =
  | "email"
  | "phone"
  | "location"
  | "linkedin"
  | "github"
  | "x"
  | "website";

/**
 * Per-row tints.
 *
 * LinkedIn keeps its own brand token (already defined for the outbound-action
 * button elsewhere) because a blue LinkedIn mark is instantly recognizable.
 * Everything else maps onto existing semantic tokens rather than new colours,
 * so the card reads as a few muted accents on neutral chips instead of a
 * rainbow — and every tone still has a text label beside it.
 */
const TONE_CLASSES: Record<MetaRowTone, string> = {
  email: "bg-[var(--email-action-surface)] text-[var(--email-action)]",
  phone: "bg-surface-selected text-brand-primary",
  location: "bg-status-warning-surface text-status-warning",
  linkedin: "bg-[var(--linkedin-surface)] text-[var(--linkedin)]",
  // X and GitHub are monochrome brands; a neutral chip is the honest rendering
  // and keeps contrast in both themes.
  github: "bg-surface-subtle text-foreground",
  x: "bg-surface-subtle text-foreground",
  website: "bg-surface-subtle text-foreground-muted"
};

export function MetaRow({
  icon: Icon,
  label,
  value,
  href,
  tone
}: {
  icon: MetaRowIcon;
  label: string;
  value: string;
  href?: string;
  tone?: MetaRowTone;
}) {
  return (
    <li className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-control ${
          tone ? TONE_CLASSES[tone] : "bg-surface-subtle text-foreground-muted"
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-foreground-muted">{label}</span>
        {isSafeExternalUrl(href) ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            /* Above the card's stretched overlay, so clicking this opens the
               link itself rather than the section editor. */
            className="ds-focus-ring relative z-10 block truncate text-sm text-foreground-secondary transition hover:text-foreground-link"
          >
            {value}
          </a>
        ) : (
          <span className="block truncate text-sm text-foreground-secondary">{value}</span>
        )}
      </span>
    </li>
  );
}

/** The "+N more" pill used wherever a list is truncated. */
export function MoreCount({ count }: { count: number }) {
  return (
    <span className="rounded-control border border-dashed border-line-default px-2 py-1 text-xs text-foreground-muted">
      +{count} more
    </span>
  );
}
