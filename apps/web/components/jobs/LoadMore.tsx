"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

/**
 * The foot of a paged list.
 *
 * Scrolling near the end asks for the next page automatically (an IntersectionObserver on a sentinel). The button does the
 * same thing, so a keyboard user, a screen-reader user and a browser without IntersectionObserver can always continue, and a
 * failed page has a visible retry instead of a silent stall. When nothing is left it says so, once, and stops.
 */
export function LoadMore({
  hasMore,
  loading,
  error,
  onLoadMore,
  loadedCount,
  total,
  compact = false,
  paused = false,
  scrollRoot
}: {
  hasMore: boolean;
  loading: boolean;
  error: string;
  onLoadMore: () => void;
  loadedCount: number;
  total: number | null;
  compact?: boolean;
  /** Fit scores are still being calculated: page boundaries are not final, so continuing is held until they are. */
  paused?: boolean;
  /** The scrolling element when the list scrolls inside a panel rather than the page. */
  scrollRoot?: React.RefObject<HTMLElement | null>;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const callback = useRef(onLoadMore);
  useEffect(() => {
    callback.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const node = sentinel.current;
    // No observer, nothing left, a request running or a failed page waiting for an explicit retry: do not auto-request.
    if (!node || !hasMore || loading || error || paused || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      { root: scrollRoot?.current ?? null, rootMargin: "600px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, error, paused, scrollRoot, loadedCount]);

  if (!hasMore && !loading && !error) {
    if (loadedCount === 0) return null;
    return (
      <p className={`text-center text-xs text-foreground-muted ${compact ? "px-3 py-3" : "py-6"}`}>
        {total !== null && total > 0 ? `You’ve reached the end · ${total} job${total === 1 ? "" : "s"}` : "You’ve reached the end"}
      </p>
    );
  }

  return (
    <div ref={sentinel} className={`flex flex-col items-center gap-2 ${compact ? "px-3 py-3" : "py-6"}`}>
      {error && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loading || paused}
        className="ds-focus-ring inline-flex h-9 items-center gap-2 rounded-control border border-line-interactive bg-surface-card px-4 text-sm font-medium text-foreground-secondary transition duration-fast ease-standard hover:border-line-strong hover:bg-surface-subtle disabled:opacity-60"
      >
        {loading && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
        {loading ? "Loading more jobs…" : paused ? "Waiting for fit scores…" : error ? "Try again" : "Show more jobs"}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {loading ? "Loading more jobs" : ""}
      </span>
    </div>
  );
}
