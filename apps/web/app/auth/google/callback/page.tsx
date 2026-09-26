"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { completeGoogleAuth, finishGoogleLogin } from "@/lib/googleAuth";
import { googleCallbackError, mapAuthError } from "@/lib/authErrors";

export default function GoogleCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [linkTicket, setLinkTicket] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [linking, setLinking] = useState(false);
  const [returnTo, setReturnTo] = useState("/dashboard");
  const callbackHandled = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (callbackHandled.current) return;
    callbackHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthError = params.get("error");
    window.history.replaceState({}, "", window.location.pathname);
    if (oauthError) {
      queueMicrotask(() => setError(googleCallbackError(oauthError).formError ?? ""));
      return;
    }
    if (!code) {
      queueMicrotask(() => setError("The Google sign-in completion is missing. Please try again."));
      return;
    }
    void completeGoogleAuth(code)
      .then(async (result) => {
        if (result.result === "link_required" && result.link_ticket) {
          setLinkTicket(result.link_ticket);
          setReturnTo(result.return_to);
          return;
        }
        if (!result.access_token) throw new Error("Google sign-in did not return a session.");
        router.replace(await finishGoogleLogin(result.access_token, result.return_to));
      })
      .catch((cause) => setError(mapAuthError("google", cause).formError ?? ""));
  }, [router]);

  async function link(event: React.FormEvent) {
    event.preventDefault();
    if (!linkTicket || linking) return;
    if (!password) {
      setError("Enter your password.");
      window.requestAnimationFrame(() => passwordRef.current?.focus());
      return;
    }
    setLinking(true);
    setError("");
    try {
      const result = await api<{ access_token: string }>("/auth/google/link", { method: "POST", body: JSON.stringify({ link_ticket: linkTicket, password }) });
      router.replace(await finishGoogleLogin(result.access_token, returnTo));
    } catch (cause) {
      setError(mapAuthError("link", cause).formError ?? "");
      setLinking(false);
      window.requestAnimationFrame(() => {
        if (cause instanceof ApiError && cause.status === 401) passwordRef.current?.focus();
        else errorRef.current?.focus();
      });
    }
  }

  return <main className="mx-auto flex min-h-screen max-w-lg items-center px-5 py-12">
    <section className="w-full rounded-[28px] border border-line-default bg-surface-card p-8" aria-labelledby="google-auth-title">
      <h1 id="google-auth-title" className="text-2xl font-semibold">Google sign-in</h1>
      {!error && !linkTicket && <p className="mt-3 text-sm text-foreground-muted" role="status">Finishing your secure sign-in…</p>}
      {error && <p id="google-link-error" ref={errorRef} tabIndex={-1} className="mt-4 break-words rounded-field border border-status-danger-border bg-status-danger-surface p-3 text-sm text-status-danger" role="alert">{error}</p>}
      {linkTicket && <form onSubmit={link} noValidate className="mt-5">
        <p className="text-sm text-foreground-muted">This Google sign-in can’t be connected automatically. Enter your existing XpertApply password to connect Google.</p>
        <label htmlFor="google-link-password" className="mt-5 block text-sm font-medium">Password</label>
        <input ref={passwordRef} id="google-link-password" type="password" autoComplete="current-password" required value={password} aria-invalid={error ? "true" : undefined} aria-describedby={error ? "google-link-error" : undefined} onChange={(event) => { setPassword(event.target.value); if (error) setError(""); }} className="auth-input ds-field mt-2 h-12 w-full rounded-field border border-line-default px-4 text-foreground" />
        <button type="submit" disabled={linking} className="ds-focus-ring mt-5 h-12 w-full rounded-field bg-action-primary font-semibold text-action-primary-foreground hover:bg-action-primary-hover disabled:opacity-70">{linking ? "Connecting…" : "Sign in and connect Google"}</button>
      </form>}
    </section>
  </main>;
}
