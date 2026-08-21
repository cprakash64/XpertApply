"use client";

/**
 * Route-level error boundary — the LAST resort.
 *
 * Expected failures (API down, session expired, validation rejected) are meant
 * to be handled in-place by components/SectionError.tsx, which keeps the user's
 * navigation and offers a way forward. Reaching this file means a render threw
 * unexpectedly.
 *
 * Next.js's built-in fallback is an unstyled page that ignores the app theme
 * entirely; this one uses the same tokens as everything else, so it is readable
 * in light and dark, and it shows the digest so a report can be correlated with
 * a server log. It never renders the raw error message or stack: those can
 * contain internal detail or personal data.
 */

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

export default function ErrorBoundary({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Console only — never surfaced to the user.
    console.error("Unhandled render error", error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-page p-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-card border border-line-default bg-surface-card p-6 shadow-raised"
      >
        <AlertTriangle aria-hidden="true" className="h-6 w-6 text-status-danger" />
        <h1 className="mt-3 text-xl font-semibold text-foreground">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-foreground-secondary">
          This section failed to load. Trying again usually fixes it — your saved data is unaffected.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="ds-focus-ring inline-flex h-10 items-center rounded-control bg-action-primary px-4 text-sm font-semibold text-action-primary-foreground hover:bg-action-primary-hover"
          >
            Try again
          </button>
          <a
            href="/dashboard"
            className="ds-focus-ring inline-flex h-10 items-center rounded-control border border-line-strong px-4 text-sm font-semibold text-foreground hover:bg-surface-subtle"
          >
            Back to dashboard
          </a>
        </div>

        {error.digest && (
          <p className="mt-4 text-xs text-foreground-muted">
            Reference: <code className="font-mono">{error.digest}</code>
          </p>
        )}
      </div>
    </main>
  );
}
