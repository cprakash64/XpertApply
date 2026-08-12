import { Chrome } from "lucide-react";
import { PRODUCT_NAME, chromeExtensionUrl } from "@/lib/siteConfig";

/**
 * The Install-extension call to action.
 *
 * One component owns BOTH states so no caller has to know whether a store
 * listing exists yet:
 *
 *   • configured   → a real outbound link to the Chrome Web Store, opened in a
 *                    new tab with `rel="noopener noreferrer"` so the store page
 *                    never receives a handle on this window.
 *   • unconfigured → an explicitly unavailable control. Never a link to a
 *                    guessed store ID: a dead link is worse than an honest
 *                    "not yet".
 *
 * The unavailable control uses `aria-disabled` rather than the `disabled`
 * attribute. A `disabled` button leaves the tab order entirely, so a keyboard or
 * screen-reader user would never learn the extension is coming at all; this one
 * stays focusable, announces itself as unavailable, and carries the reason in
 * its own accessible name.
 *
 * Publishing the extension therefore needs no code change — only
 * NEXT_PUBLIC_CHROME_EXTENSION_URL in production configuration.
 */
export function ExtensionCta({
  variant = "secondary",
  size = "md",
  label = "Install Chrome Extension",
  /** Shorter wording for tight spots (the nav). */
  unavailableLabel = "Chrome extension coming soon",
  /** Unique within the page — two CTAs must not share a describedby target. */
  id,
  /** Whether to render the visible explanation under an unavailable CTA. */
  showNote = true,
  className = ""
}: {
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  label?: string;
  unavailableLabel?: string;
  id: string;
  showNote?: boolean;
  className?: string;
}) {
  const href = chromeExtensionUrl();

  const shape =
    size === "sm"
      ? "h-10 rounded-lg px-3.5 text-sm"
      : "h-12 rounded-xl px-5 text-sm";
  const base = `focus-ring inline-flex shrink-0 items-center justify-center gap-2 font-semibold transition ${shape}`;
  const skin =
    variant === "primary"
      ? "bg-pine text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]"
      : "border border-line bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-panel";

  if (href) {
    return (
      <a
        className={`${base} ${skin} ${className}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Chrome className="h-4 w-4" aria-hidden />
        {label}
        <span className="sr-only"> (opens the Chrome Web Store in a new tab)</span>
      </a>
    );
  }

  const noteId = `${id}-unavailable`;
  const control = (
    <button
      type="button"
      id={id}
      aria-disabled="true"
      aria-label={`${unavailableLabel}. Not available yet.`}
      aria-describedby={showNote ? noteId : undefined}
      className={`${base} cursor-not-allowed border border-dashed border-line bg-panel text-[var(--text-muted)] ${className}`}
    >
      <Chrome className="h-4 w-4" aria-hidden />
      {unavailableLabel}
    </button>
  );

  if (!showNote) return control;

  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      {control}
      <span id={noteId} className="text-xs text-[var(--text-muted)]">
        The {PRODUCT_NAME} extension is not published to the Chrome Web Store yet.
      </span>
    </span>
  );
}
