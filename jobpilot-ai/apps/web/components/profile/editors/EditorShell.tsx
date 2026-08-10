"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/Button";

/**
 * Shared chrome for a focused editor: loading, a recoverable load failure, and
 * the section body. Keeps every editor's failure behaviour identical, and keeps
 * a failed load section-scoped rather than a page crash.
 */
export function EditorShell({
  loading,
  loadError,
  onRetry,
  children
}: {
  loading: boolean;
  loadError: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <div className="grid min-h-64 place-items-center" data-testid="editor-loading">
        <span className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading your profile…
        </span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-[var(--danger-border)] bg-[var(--danger-surface)] px-5 py-4 text-sm text-[var(--danger)]"
      >
        <p>We couldn’t load this section.</p>
        <Button type="button" variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
