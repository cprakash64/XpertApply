"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { API_URL } from "@/lib/api";
import { readAuthToken } from "@/lib/authToken";
import { loginHrefFor } from "@/lib/authSession";

// Chrome's identity API only ever redirects to https://<extension-id>.chromiumapp.org/.
const EXTENSION_REDIRECT = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/[A-Za-z0-9._~/-]{0,100}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

type Phase = "checking" | "signed_out" | "ready" | "working" | "invalid" | "error";
type Request = { challenge: string; redirect: string; state: string };

function parseRequest(search: string): Request | null {
  const query = new URLSearchParams(search);
  const challenge = query.get("challenge") ?? "";
  const redirect = query.get("redirect_uri") ?? "";
  if (!CHALLENGE.test(challenge) || !EXTENSION_REDIRECT.test(redirect)) return null;
  return { challenge, redirect, state: query.get("state") ?? "" };
}

const subscribeNever = () => () => undefined;

export default function ConnectExtensionPage() {
  // The request and the sign-in live in the browser; render "checking" on the server and first paint.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const [override, setOverride] = useState<Phase | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const params = mounted ? parseRequest(window.location.search) : null;
  const phase: Phase = override
    ?? (!mounted ? "checking" : !params ? "invalid" : readAuthToken() ? "ready" : "signed_out");

  // Say WHICH account is about to be connected, so a second account on this browser is never a surprise.
  const signedIn = mounted && Boolean(params) && Boolean(readAuthToken());
  useEffect(() => {
    const token = readAuthToken();
    if (!signedIn || !token) return;
    let live = true;
    fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.json() : null))
      .then((me: { email?: string } | null) => { if (live && me?.email) setEmail(me.email); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [signedIn]);

  function decline() {
    if (!params) return;
    // Tell the extension the user said no (RFC 6749 4.1.2.1), echoing only the state it sent.
    const target = new URL(params.redirect);
    target.searchParams.set("error", "access_denied");
    if (params.state) target.searchParams.set("state", params.state);
    window.location.assign(target.toString());
  }

  async function approve() {
    const token = readAuthToken();
    if (!params || !token) return setOverride("signed_out");
    setOverride("working");
    try {
      const res = await fetch(`${API_URL}/extension/auth/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code_challenge: params.challenge, redirect_uri: params.redirect })
      });
      if (res.status === 401) return setOverride("signed_out");
      if (!res.ok) return setOverride("error");
      const { code } = (await res.json()) as { code: string };
      const target = new URL(params.redirect);
      target.searchParams.set("code", code);
      if (params.state) target.searchParams.set("state", params.state);
      window.location.assign(target.toString());
    } catch {
      setOverride("error");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Connect the XpertApply extension</h1>
      {phase === "invalid" && <p>This link is not a valid extension connection request. Start again from the extension.</p>}
      {phase === "signed_out" && (
        <>
          <p>Sign in to XpertApply first, then return to the extension and choose Connect again.</p>
          <Link className="underline" href={loginHrefFor(`/extension/connect${params ? window.location.search : ""}`)}>Sign in</Link>
        </>
      )}
      {(phase === "ready" || phase === "working") && (
        <>
          {email && <p className="text-sm text-[var(--text-muted)]">Signed in as <strong>{email}</strong>. Not you? Sign out of XpertApply in this browser first, then connect again.</p>}
          <p>
            Allow the XpertApply browser extension to read your saved profile and answers, and to open application drafts on
            your behalf. It never submits an application, and you can disconnect it at any time from the extension.
          </p>
          <button
            type="button"
            className="rounded-lg bg-[var(--brand,#5b4bff)] px-4 py-2 font-medium text-white disabled:opacity-60"
            disabled={phase === "working"}
            onClick={approve}
          >
            {phase === "working" ? "Connecting…" : "Connect extension"}
          </button>
          <button type="button" className="underline" disabled={phase === "working"} onClick={decline}>Cancel</button>
        </>
      )}
      {phase === "error" && <p>We could not connect the extension. Close this window and try again.</p>}
    </main>
  );
}
