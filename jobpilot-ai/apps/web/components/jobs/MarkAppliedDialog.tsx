"use client";

import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/Button";

/**
 * Explicit confirmation before a job moves to the Tracker.
 *
 * This dialog is the manual fallback for when the extension cannot PROVE the
 * submission. It is deliberately a question ("did you submit?") and never an
 * announcement ("we marked this applied"), and it is never shown automatically
 * on returning from the employer site — coming back from a tab says nothing
 * about whether anything was submitted, and guessing wrong silently removes a
 * job the user still needs to apply to.
 */
export function MarkAppliedDialog({
  jobTitle,
  company,
  submitting,
  error,
  onConfirm,
  onCancel
}: {
  jobTitle: string;
  company: string;
  submitting: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape must not cancel mid-request: the backend write may already have
      // happened, and closing here would leave the list disagreeing with it.
      if (event.key === "Escape" && !submitting) {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, submitting]);

  return (
    <div
      className="assisted-application-backdrop fixed inset-0 z-[60] grid place-items-center p-4"
      data-testid="mark-applied-backdrop"
      onClick={() => !submitting && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm application submitted"
        className="assisted-application-dialog w-full max-w-[440px] overflow-hidden rounded-[24px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-6 pt-6">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--success-surface)] text-pine">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <h3 className="mt-4 text-lg font-semibold tracking-[-0.02em]">
            Did you successfully submit this application?
          </h3>
          <p className="mt-1.5 truncate text-sm text-[var(--text-muted)]">
            {jobTitle} · {company}
          </p>
          <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
            Confirming moves this job out of Jobs and into your Tracker under Applied. Only confirm
            if the employer&apos;s site showed you a completed or submitted confirmation.
          </p>

          {error && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-surface)] p-3 text-sm text-[var(--danger)]"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-6 py-4">
          <Button variant="secondary" type="button" onClick={onCancel} disabled={submitting}>
            Not yet
          </Button>
          <Button
            autoFocus
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            data-testid="mark-applied-confirm"
            aria-busy={submitting}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {submitting ? "Marking as applied…" : "Yes, mark as applied"}
          </Button>
        </div>
      </div>
    </div>
  );
}
