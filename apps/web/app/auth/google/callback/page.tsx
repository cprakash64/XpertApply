"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { completeGoogleAuth, finishGoogleLogin } from "@/lib/googleAuth";

const messages: Record<string, string> = {
  GOOGLE_AUTH_CANCELLED: "Google sign-in was cancelled.",
  GOOGLE_EMAIL_UNVERIFIED: "Google could not confirm this email address.",
  GOOGLE_TOKEN_INVALID: "Google sign-in could not be verified. Please try again.",
  OAUTH_TEMPORARY_FAILURE: "Google sign-in is temporarily unavailable. Please try again."
};

export default function GoogleCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [linkTicket, setLinkTicket] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [linking, setLinking] = useState(false);
  const [returnTo, setReturnTo] = useState("/dashboard");
  const callbackHandled = useRef(false);

  useEffect(() => {
    if (callbackHandled.current) return;
    callbackHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthError = params.get("error");
    window.history.replaceState({}, "", window.location.pathname);
    if (oauthError) {
      queueMicrotask(() => setError(messages[oauthError] ?? "Google sign-in did not complete. Please try again."));
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
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Google sign-in failed."));
  }, [router]);

  async function link(event: React.FormEvent) {
    event.preventDefault();
    if (!linkTicket || linking) return;
    setLinking(true);
    setError("");
    try {
      const result = await api<{ access_token: string }>("/auth/google/link", { method: "POST", body: JSON.stringify({ link_ticket: linkTicket, password }) });
      router.replace(await finishGoogleLogin(result.access_token, returnTo));
    } catch (cause) {
      const apiError = cause instanceof ApiError ? cause : null;
      setError(apiError?.status === 401 ? "The password was not accepted." : "Google could not be connected. Please try again.");
      setLinking(false);
    }
  }

  return <main className="mx-auto flex min-h-screen max-w-lg items-center px-5 py-12">
    <section className="w-full rounded-[28px] border border-line bg-panel p-8" aria-labelledby="google-auth-title">
      <h1 id="google-auth-title" className="text-2xl font-semibold">Google sign-in</h1>
      {!error && !linkTicket && <p className="mt-3 text-sm text-[var(--text-muted)]" role="status">Finishing your secure sign-in…</p>}
      {error && <p className="mt-4 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-surface)] p-3 text-sm text-[var(--danger)]" role="alert">{error}</p>}
      {linkTicket && <form onSubmit={link} className="mt-5">
        <p className="text-sm text-[var(--text-muted)]">This Google sign-in can’t be connected automatically. Enter your existing XpertApply password to connect Google.</p>
        <label htmlFor="google-link-password" className="mt-5 block text-sm font-medium">Password</label>
        <input id="google-link-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className="auth-input mt-2 h-12 w-full rounded-xl border border-line px-4" />
        <button type="submit" disabled={linking} className="focus-ring mt-5 h-12 w-full rounded-xl bg-pine font-semibold text-white disabled:opacity-70">{linking ? "Connecting…" : "Sign in and connect Google"}</button>
      </form>}
    </section>
  </main>;
}
