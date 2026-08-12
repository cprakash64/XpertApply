"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * One implementation of "don't lose my edits", shared by every profile editor.
 *
 * The App Router gives no navigation-blocking API, so this guard works by
 * intercepting the events that actually precede a navigation rather than trying
 * to cancel one already in progress:
 *
 * * **In-app links** — a capture-phase click listener on the document. It runs
 *   before Next's own handler, so calling `preventDefault()` there genuinely
 *   stops the route change instead of racing it. Only plain left-clicks on
 *   same-origin anchors are intercepted; modified clicks (⌘/ctrl/shift/alt),
 *   `target="_blank"`, downloads and external hosts are left alone, because
 *   those open somewhere else and do not discard the page.
 * * **Browser back/forward** — a `popstate` listener. The history entry has
 *   already changed by the time this fires, so the guard pushes the current
 *   entry back and then asks. Confirming replays the navigation.
 * * **Reload and tab close** — `beforeunload`, registered *only while dirty* so
 *   the browser's native prompt never appears on a clean page.
 *
 * Programmatic navigation (a button that calls `router.push`) goes through
 * {@link UnsavedChangesGuard.requestNavigation} instead.
 *
 * `dirty` must reflect a real difference from what the server holds — not focus
 * or touch — or every editor becomes a nag.
 */

export type UnsavedChangesGuard = {
  /** True while the confirmation dialog should be shown. */
  prompting: boolean;
  /** Stay on the page and keep the edits. */
  keepEditing: () => void;
  /** Throw the edits away and continue to the pending destination. */
  discard: () => void;
  /**
   * Run the caller's save, then continue only if it succeeded. The dialog stays
   * open (showing the error) when the save fails, so a failure can never
   * silently navigate away.
   */
  saveAndContinue: () => Promise<void>;
  /** True while `saveAndContinue` is in flight; blocks duplicate submits. */
  saving: boolean;
  /** Error text from the last failed `saveAndContinue`, if any. */
  saveError: string;
  /**
   * Ask to navigate somewhere programmatically. Returns true when the guard
   * allowed it immediately (nothing to lose), false when it opened the dialog.
   */
  requestNavigation: (href: string) => boolean;
};

type Pending =
  | { kind: "href"; href: string }
  | { kind: "back" }
  | null;

export function useUnsavedChangesGuard({
  dirty,
  onSave,
  onDiscard
}: {
  dirty: boolean;
  /**
   * Persist the edits. Must reject (or throw) on failure — the guard treats a
   * resolved promise as server-confirmed success and navigates on it.
   */
  onSave?: () => Promise<void>;
  /** Reset local edits. Called before navigating away on Discard. */
  onDiscard?: () => void;
}): UnsavedChangesGuard {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Read inside listeners that are registered once, so they always see current
  // values without being torn down and rebuilt on every keystroke.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Set while the guard itself is navigating, so its own router call is not
  // re-intercepted by the click/popstate listeners.
  const bypass = useRef(false);

  const navigate = useCallback(
    (target: Pending) => {
      bypass.current = true;
      if (target?.kind === "href") {
        router.push(target.href);
      } else if (target?.kind === "back") {
        router.back();
      }
      // Cleared on the next tick: the navigation has been handed to the router
      // by then, and leaving it set would disable the guard for the next page.
      window.setTimeout(() => {
        bypass.current = false;
      }, 0);
    },
    [router]
  );

  /* -------------------------------------------------------------- */
  /* Reload / tab close                                              */
  /* -------------------------------------------------------------- */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // The wording is the browser's; assigning returnValue is what opts in.
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /* -------------------------------------------------------------- */
  /* In-app links                                                    */
  /* -------------------------------------------------------------- */
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!dirtyRef.current || bypass.current) return;
      if (event.defaultPrevented) return;
      // Let the browser handle anything that is not a plain left-click.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (anchor.hasAttribute("download") || anchor.getAttribute("target") === "_blank") return;

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      // A different origin leaves the SPA entirely — beforeunload covers that.
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setSaveError("");
      setPending({ kind: "href", href: `${url.pathname}${url.search}` });
    };

    // Capture phase: this has to win against Next's Link handler.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  /* -------------------------------------------------------------- */
  /* Browser back / forward                                          */
  /* -------------------------------------------------------------- */
  useEffect(() => {
    const onPopState = () => {
      if (!dirtyRef.current || bypass.current) return;
      // popstate fires *after* the entry changed, so restore it and then ask.
      history.pushState(null, "", window.location.href);
      setSaveError("");
      setPending({ kind: "back" });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /* -------------------------------------------------------------- */
  /* Dialog actions                                                  */
  /* -------------------------------------------------------------- */
  const keepEditing = useCallback(() => {
    setPending(null);
    setSaveError("");
  }, []);

  const discard = useCallback(() => {
    const target = pending;
    setPending(null);
    setSaveError("");
    onDiscard?.();
    // The edits are gone, so the guard must not re-prompt on the way out.
    dirtyRef.current = false;
    navigate(target);
  }, [pending, onDiscard, navigate]);

  const saveAndContinue = useCallback(async () => {
    if (saving || !onSave) return;
    setSaving(true);
    setSaveError("");
    try {
      await onSave();
      const target = pending;
      dirtyRef.current = false;
      setPending(null);
      navigate(target);
    } catch (cause: unknown) {
      // Stay put and surface it. Navigating here would discard the very edits
      // the user asked to keep.
      setSaveError(cause instanceof Error ? cause.message : "Could not save your changes.");
    } finally {
      setSaving(false);
    }
  }, [saving, onSave, pending, navigate]);

  const requestNavigation = useCallback(
    (href: string) => {
      if (!dirtyRef.current) {
        navigate({ kind: "href", href });
        return true;
      }
      setSaveError("");
      setPending({ kind: "href", href });
      return false;
    },
    [navigate]
  );

  return {
    prompting: pending !== null,
    keepEditing,
    discard,
    saveAndContinue,
    saving,
    saveError,
    requestNavigation
  };
}
