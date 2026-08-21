"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import type { UnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";

/**
 * The confirmation shown when a profile editor is about to lose edits.
 *
 * Focus moves to "Keep editing" on open — the safe, non-destructive choice —
 * and Escape maps to it too, so dismissing the dialog by reflex never throws
 * work away. Focus is trapped while it is open and returned to whatever the
 * user was on when it closes.
 */
export function UnsavedChangesDialog({
  guard,
  canSave = true
}: {
  guard: UnsavedChangesGuard;
  /** False when the form cannot legally be saved yet; hides Save changes. */
  canSave?: boolean;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!guard.prompting) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    keepRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        guard.keepEditing();
        return;
      }
      if (event.key !== "Tab") return;
      // Trap: a dialog the user can Tab out of is a dialog they can lose.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreTo.current?.focus?.();
    };
  }, [guard]);

  if (!guard.prompting) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-surface-overlay p-4"
      // The backdrop is not a dismiss target: clicking away from a
      // "you have unsaved work" prompt should not resolve it either way.
      role="presentation"
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        aria-describedby="unsaved-body"
        className="w-full max-w-md rounded-card border border-line-default bg-surface-card p-6 shadow-[var(--shadow)]"
      >
        <span
          aria-hidden
          className="grid h-10 w-10 place-items-center rounded-card bg-status-warning-surface text-status-warning"
        >
          <AlertTriangle className="h-5 w-5" />
        </span>
        <h2 id="unsaved-title" className="mt-4 text-lg font-semibold tracking-[-0.02em]">
          Unsaved changes
        </h2>
        <p id="unsaved-body" className="mt-1.5 text-sm text-foreground-muted">
          You have changes that haven’t been saved yet.
        </p>

        {guard.saveError && (
          <p
            role="alert"
            className="mt-4 rounded-card border border-status-danger-border bg-status-danger-surface px-3 py-2 text-sm text-status-danger"
          >
            {guard.saveError}
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            ref={keepRef}
            type="button"
            variant="secondary"
            onClick={guard.keepEditing}
            disabled={guard.saving}
          >
            Keep editing
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={guard.discard}
            disabled={guard.saving}
            className="text-status-danger"
          >
            Discard changes
          </Button>
          {canSave && (
            <Button type="button" onClick={() => void guard.saveAndContinue()} disabled={guard.saving}>
              {guard.saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {guard.saving ? "Saving…" : "Save changes"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
