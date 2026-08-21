"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Download, Loader2, Trash2 } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { invalidateAuthSession } from "@/lib/authSession";

/** Typed exactly, so a reflexive second click can never delete an account. */
const CONFIRM_PHRASE = "DELETE";

/**
 * Account deletion shows THIS, never the server's message.
 *
 * `DELETE /privacy/account` defines no user-facing failure of its own: every
 * expected error comes from shared infrastructure. The catch-all 500 is already
 * safe ("Something went wrong. Please try again."), but the shared auth
 * dependency answers a database outage with a 503 whose `detail` is an operator
 * runbook instruction — it names the migration tool to run. Rendering the
 * normalized `ApiError` message verbatim, as export does, put that in front of
 * the user on the most sensitive screen in the product.
 *
 * Export keeps showing the server message: its endpoint returns data the user
 * asked for, and the wording there is worth passing through. Deletion has no
 * such wording to pass through, so a stable sentence is strictly better than
 * whatever the transport happened to normalize. It stays accurate for every
 * case: the account was not deleted, and retrying is the right next step.
 */
const DELETE_FAILURE_MESSAGE = "We couldn’t delete your account. Please try again.";

export function PrivacyControls() {
  const [exported, setExported] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [message, setMessage] = useState("");
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Export never used to handle failure: the rejection went unhandled and the
   * button simply looked inert. The message comes from the shared `ApiError`,
   * which is already normalized for humans — a response body is never shown.
   */
  async function exportData() {
    if (exporting) return;
    setExporting(true);
    setExportError("");
    try {
      const result = await api<Record<string, unknown>>("/privacy/export");
      setExported(JSON.stringify(result, null, 2));
    } catch (cause) {
      setExported("");
      setExportError(cause instanceof Error ? cause.message : "Could not export your data.");
    } finally {
      setExporting(false);
    }
  }

  /**
   * Deletion is irreversible, so the request is issued only from inside the
   * confirmation dialog, only once the phrase has been typed, and only once at
   * a time. A 401 is still handled by the shared transport's single
   * invalidation contract; everything else stays local and retryable.
   */
  async function deleteAccount() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api<void>("/privacy/account", { method: "DELETE" });
      setMessage("Account deleted.");
      invalidateAuthSession({ reason: "account_deleted", returnTo: null });
    } catch {
      // The dialog stays open: the user's intent has not changed, and the
      // action is worth retrying. A 401 never reaches here as visible text —
      // the shared transport invalidates the session and routes to login.
      setDeleteError(DELETE_FAILURE_MESSAGE);
      setDeleting(false);
    }
  }

  return (
    <>
      <section aria-labelledby="data-controls-title">
        <h2 id="data-controls-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">
          Your data
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
          Export everything XpertApply holds about you as JSON.
        </p>

        <div className="mt-4 rounded-card border border-line-default bg-surface-card p-5">
          <Button type="button" variant="secondary" onClick={() => void exportData()} disabled={exporting}>
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            {exporting ? "Preparing export…" : "Export JSON"}
          </Button>

          <p aria-live="polite" className="mt-3 min-h-5 text-sm">
            {exportError && (
              <span role="alert" className="inline-flex items-start gap-2 text-status-danger">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {exportError}
              </span>
            )}
          </p>

          {exported && (
            <pre className="mt-2 max-h-[520px] overflow-auto rounded-control border border-line-default bg-surface-subtle p-4 text-xs text-foreground">
              {exported}
            </pre>
          )}
        </div>
      </section>

      {/* Deleting an account is irreversible, so it gets its own region rather
        * than sitting beside a harmless export button. The danger tone is on
        * the boundary and the control, not smeared across a whole red panel. */}
      <section aria-labelledby="danger-zone-title" className="mt-8">
        <h2 id="danger-zone-title" className="text-lg font-semibold tracking-[-0.02em] text-status-danger">
          Danger zone
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
          Deleting your account removes your profile, applications, and generated documents. This
          cannot be undone.
        </p>

        <div className="mt-4 rounded-card border border-status-danger-border bg-surface-card p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              ref={deleteTriggerRef}
              type="button"
              variant="destructive"
              onClick={() => {
                setDeleteError("");
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden /> Delete account
            </Button>
            {message && (
              <p role="status" className="self-center text-sm font-medium text-status-danger">
                {message}
              </p>
            )}
          </div>
        </div>
      </section>

      {confirmOpen && (
        <DeleteAccountDialog
          deleting={deleting}
          error={deleteError}
          onCancel={() => {
            setConfirmOpen(false);
            setDeleteError("");
          }}
          onConfirm={() => void deleteAccount()}
          restoreFocusTo={deleteTriggerRef}
        />
      )}
    </>
  );
}

/**
 * Follows the same contract as the profile's unsaved-changes prompt: focus is
 * trapped, Escape resolves to the safe choice, and focus returns to whatever
 * opened it. The backdrop is deliberately not a dismiss target.
 */
function DeleteAccountDialog({
  deleting,
  error,
  onCancel,
  onConfirm,
  restoreFocusTo
}: {
  deleting: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
  restoreFocusTo: React.RefObject<HTMLButtonElement>;
}) {
  const [phrase, setPhrase] = useState("");
  const inputId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmed = phrase.trim() === CONFIRM_PHRASE;

  useEffect(() => {
    // The input is the safe landing spot: the destructive button stays
    // disabled until the phrase matches, so nothing here can delete by reflex.
    inputRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [href], [tabindex]:not([tabindex="-1"])'
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
    const restore = restoreFocusTo;
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restore.current?.focus?.();
    };
  }, [deleting, onCancel, restoreFocusTo]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-surface-overlay p-4" role="presentation">
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        aria-describedby="delete-account-body"
        className="w-full max-w-md rounded-card border border-line-default bg-surface-card p-6 shadow-overlay"
      >
        <span
          aria-hidden
          className="grid h-10 w-10 place-items-center rounded-card bg-status-danger-surface text-status-danger"
        >
          <AlertTriangle className="h-5 w-5" />
        </span>
        <h2 id="delete-account-title" className="mt-4 text-lg font-semibold tracking-[-0.02em] text-foreground">
          Delete your account?
        </h2>
        <p id="delete-account-body" className="mt-1.5 text-sm leading-6 text-foreground-muted">
          This deletes your profile, applications, and generated documents. It cannot be undone.
        </p>

        <div className="mt-5">
          <Input
            ref={inputRef}
            id={inputId}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            disabled={deleting}
            autoComplete="off"
            spellCheck={false}
            label={`Type ${CONFIRM_PHRASE} to confirm`}
          />
        </div>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-card border border-status-danger-border bg-status-danger-surface px-3 py-2 text-sm text-status-danger"
          >
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={!confirmed || deleting}>
            {deleting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {deleting ? "Deleting…" : "Delete account"}
          </Button>
        </div>
      </div>
    </div>
  );
}
