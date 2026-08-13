import { PRODUCT_NAME, chromeExtensionUrl } from "@/lib/siteConfig";

/**
 * The "Add to Chrome" call to action.
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
  variant = "primary",
  label = "Add to Chrome →",
  /** Unique within the page — two CTAs must not share a describedby target. */
  id,
  /** Whether to render the visible explanation under an unavailable CTA. */
  showNote = true,
  className = ""
}: {
  variant?: "primary" | "ghost";
  label?: string;
  id: string;
  showNote?: boolean;
  className?: string;
}) {
  const href = chromeExtensionUrl();
  const base = `xa-btn xa-btn--${variant} ${className}`.trim();

  if (href) {
    return (
      <a className={base} href={href} target="_blank" rel="noopener noreferrer">
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
      aria-label={`${label}. Not available yet.`}
      aria-describedby={showNote ? noteId : undefined}
      className={base}
    >
      {label}
    </button>
  );

  if (!showNote) return control;

  return (
    <span className="xa-cta-note">
      {control}
      <span id={noteId}>
        The {PRODUCT_NAME} extension is not published to the Chrome Web Store yet.
      </span>
    </span>
  );
}
