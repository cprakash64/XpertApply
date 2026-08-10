"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { api } from "@/lib/api";

/**
 * Employer-portal accounts, managed in Settings rather than on the career
 * profile — a password is a credential, not a career fact.
 *
 * What this component may know is deliberately limited. The API reports only
 * whether a credential exists (`workday_password_configured`); the stored value
 * is encrypted at rest and is never returned to a browser, so there is nothing
 * here that could render it. The password field is write-only: it is cleared
 * the moment a save succeeds, and its value is never persisted to
 * localStorage, a URL, or component state that outlives the request.
 */

/** Mirrors WorkdayCredentialsIn on the server (min_length=8). */
const MIN_PASSWORD_LENGTH = 8;

type AccountState = {
  configured: boolean;
};

export function ApplicationAccounts() {
  const [state, setState] = useState<AccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(() => {
    api<{ profile: { workday_password_configured?: boolean } | null }>("/profile")
      .then((result) => {
        if (!mounted.current) return;
        setState({ configured: Boolean(result.profile?.workday_password_configured) });
        setLoadError("");
      })
      .catch((cause: unknown) => {
        if (!mounted.current) return;
        setLoadError(cause instanceof Error ? cause.message : "Could not load your accounts.");
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  async function save() {
    if (!password) return;
    // Mirrors the server's own constraint (8–128) so the user gets a direct
    // message instead of a raw validation payload. The server still enforces it.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setStatus("");
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setSaving(true);
    setError("");
    setStatus("");
    try {
      await api("/profile/workday-credentials", {
        method: "PUT",
        body: JSON.stringify({ password })
      });
      if (!mounted.current) return;
      // Cleared immediately on success: the value has no further use in the
      // browser, and the server will never hand it back.
      setPassword("");
      setState({ configured: true });
      setStatus("Password stored securely.");
    } catch (cause: unknown) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Could not store the password.");
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    setError("");
    setStatus("");
    try {
      await api("/profile/workday-credentials", { method: "DELETE" });
      if (!mounted.current) return;
      setState({ configured: false });
      setPassword("");
      setConfirmRemove(false);
      setStatus("Stored password removed.");
    } catch (cause: unknown) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Could not remove the password.");
      }
    } finally {
      if (mounted.current) setRemoving(false);
    }
  }

  const configured = state?.configured ?? false;

  return (
    <section aria-labelledby="application-accounts-heading" className="mt-8">
      <h2 id="application-accounts-heading" className="text-lg font-semibold tracking-[-0.02em]">
        Application accounts
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">
        JobPilot uses this only when an application requires authentication.
      </p>

      <div className="mt-4 rounded-2xl border border-line bg-white p-5">
        {loading ? (
          <p className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
          </p>
        ) : loadError ? (
          <div role="alert" className="text-sm text-[var(--danger)]">
            <p>{loadError}</p>
            <Button type="button" variant="secondary" className="mt-3" onClick={load}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span
                  aria-hidden
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-panel text-[var(--text-muted)]"
                >
                  <KeyRound className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Workday</p>
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                    {configured
                      ? "Password stored securely"
                      : "No password stored"}
                  </p>
                  {/* A fixed-length mask, never the stored value — the browser
                      is never given the password, so this cannot reveal it. */}
                  {configured && (
                    <p aria-hidden className="mt-2 font-mono text-sm tracking-[0.2em] text-[var(--text-muted)]">
                      ••••••••••
                    </p>
                  )}
                </div>
              </div>

              <span
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium ${
                  configured
                    ? "border-[var(--success-border)] bg-[var(--success-surface)] text-pine"
                    : "border-line text-[var(--text-muted)]"
                }`}
              >
                {/* Status carries an icon and a word, not colour alone. */}
                {configured ? (
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                )}
                {configured ? "Connected" : "Not connected"}
              </span>
            </div>

            <div className="mt-5 border-t border-line pt-4">
              <label htmlFor="workday-password" className="block text-sm font-medium">
                {configured ? "Replace password" : "Workday password"}
              </label>
              <p id="workday-password-hint" className="mt-1 text-xs text-[var(--text-muted)]">
                At least 8 characters. Stored encrypted — JobPilot never displays it again and
                never returns it to this page.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  id="workday-password"
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  aria-describedby="workday-password-hint"
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-[var(--input-background)] px-3 text-sm"
                />
                <Button type="button" onClick={() => void save()} disabled={saving || !password}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {configured ? "Update" : "Save"}
                </Button>
                {configured && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setConfirmRemove(true)}
                    disabled={removing}
                  >
                    Remove
                  </Button>
                )}
              </div>

              {confirmRemove && (
                <div
                  role="alertdialog"
                  aria-labelledby="remove-credential-title"
                  className="mt-4 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-surface)] p-4"
                >
                  <p id="remove-credential-title" className="text-sm font-semibold text-[var(--danger)]">
                    Remove the stored Workday password?
                  </p>
                  <p className="mt-1 text-xs text-[var(--danger)]">
                    Applications that need it will ask you to sign in yourself.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button type="button" variant="secondary" onClick={() => setConfirmRemove(false)}>
                      Cancel
                    </Button>
                    <Button type="button" variant="danger" onClick={() => void remove()} disabled={removing}>
                      {removing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                      Remove password
                    </Button>
                  </div>
                </div>
              )}

              <p aria-live="polite" className="mt-3 min-h-5 text-sm">
                {status && (
                  <span className="inline-flex items-center gap-2 text-pine">
                    <Check className="h-3.5 w-3.5" aria-hidden /> {status}
                  </span>
                )}
                {error && (
                  <span role="alert" className="inline-flex items-center gap-2 text-[var(--danger)]">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {error}
                  </span>
                )}
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
