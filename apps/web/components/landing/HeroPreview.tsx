import { ArrowRight, Check } from "lucide-react";

/**
 * The hero's product preview.
 *
 * Deliberately a PRESENTATION component: it renders fixed illustrative content
 * and never fetches anything. The public landing page must stay statically
 * renderable and must never call an authenticated endpoint.
 *
 * It mirrors the real match card in the authenticated app closely enough to be
 * an honest preview, and is labelled as an example so nothing here can be
 * mistaken for a visitor's own data.
 *
 * Motion is CSS-only (an entrance rise and a meter that draws itself once). The
 * global `prefers-reduced-motion` rule in globals.css collapses both to their
 * final state.
 */
const READINESS = [
  { label: "Profile ready", meta: "Complete" },
  { label: "Resume tailored", meta: "Ready" },
  { label: "Cover letter ready", meta: "Ready" },
  { label: "Application preferences ready", meta: "Reusable answers" }
];

export function HeroPreview() {
  return (
    <figure className="landing-rise m-0">
      <div className="rounded-[24px] border border-line bg-panel p-3 shadow-card">
        <div className="rounded-[18px] border border-line bg-[var(--surface)] p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4 border-b border-line pb-5">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-pine">
                Next best match
              </p>
              <p className="mt-2 truncate text-xl font-semibold tracking-[-0.025em] text-ink">
                Senior Software Engineer
              </p>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Remote · Posted today</p>
            </div>
            <div className="shrink-0 rounded-xl border border-[var(--success-border)] bg-[var(--success-surface)] px-3 py-2 text-center">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Fit
              </p>
              <p className="text-2xl font-semibold leading-none text-pine">86</p>
            </div>
          </div>

          <div className="py-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-semibold text-ink">Application readiness</p>
              <p className="text-xs font-medium text-[var(--text-muted)]">4 of 4 prepared</p>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-panel">
              <div className="landing-meter h-full w-full rounded-full bg-pine" />
            </div>
            <ul className="mt-4 grid list-none gap-3 p-0">
              {READINESS.map((item) => (
                <li key={item.label} className="flex items-center gap-3 text-sm">
                  <span
                    aria-hidden
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--success-surface)] text-pine"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="flex-1 text-[var(--text-secondary)]">{item.label}</span>
                  <span className="shrink-0 text-xs font-medium text-[var(--text-muted)]">
                    {item.meta}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-panel px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink">Ready for your review</p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Nothing is submitted without you.
              </p>
            </div>
            <span
              aria-hidden
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-pine text-[var(--accent-foreground)]"
            >
              <ArrowRight className="h-4 w-4" />
            </span>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-[var(--text-muted)]">
        Example of the match view — illustrative content, not real applicant data.
      </figcaption>
    </figure>
  );
}
