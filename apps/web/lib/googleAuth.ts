import { API_URL, api } from "@/lib/api";
import { safeReturnPath, storeAuthToken } from "@/lib/authSession";

export const GOOGLE_HANDOFF_VERIFIER_KEY = "xpertapply.google.handoff_verifier";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Challenge(verifier: string): Promise<string> {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function prepareGoogleAuth(returnTo: string | null): Promise<string> {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  const verifier = base64url(bytes);
  const challenge = await sha256Challenge(verifier);
  window.sessionStorage.setItem(GOOGLE_HANDOFF_VERIFIER_KEY, verifier);
  const safe = safeReturnPath(returnTo) ?? "/dashboard";
  const query = new URLSearchParams({ handoff_challenge: challenge, return_to: safe });
  return `${API_URL}/auth/google/start?${query.toString()}`;
}

export async function beginGoogleAuth(returnTo: string | null): Promise<void> {
  const destination = await prepareGoogleAuth(returnTo);
  // The destination is the separately hosted API/Google flow, not a Next.js route.
  window.location.href = destination;
}

export async function completeGoogleAuth(code: string) {
  const verifier = window.sessionStorage.getItem(GOOGLE_HANDOFF_VERIFIER_KEY);
  window.sessionStorage.removeItem(GOOGLE_HANDOFF_VERIFIER_KEY);
  if (!verifier) throw new Error("The Google sign-in session is missing. Please try again.");
  return api<{ result: "authenticated" | "link_required"; access_token?: string; link_ticket?: string; return_to: string }>("/auth/google/complete", {
    method: "POST",
    body: JSON.stringify({ code, verifier })
  });
}

export async function finishGoogleLogin(token: string, returnTo: string): Promise<string> {
  await storeAuthToken(token);
  return safeReturnPath(returnTo) ?? "/dashboard";
}
