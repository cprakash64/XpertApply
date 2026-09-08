import { AUTH_TOKEN_STORAGE_KEY, readAuthToken } from "@/lib/authToken";
import { EXTERNAL_SESSION_END, connectExternalExtension } from "@/lib/extensionRuntime";

export const AUTH_SESSION_INVALIDATED_EVENT = "xpertapply:auth-session-invalidated";
const AUTH_SESSION_CHANGED_EVENT = "xpertapply:auth-session-changed";
const SESSION_END_TIMEOUT_MS = 1_600;

export type AuthSessionInvalidationReason = "expired" | "logout" | "account_deleted";

export type AuthSessionInvalidationDetail = {
  loginHref: string;
  reason: AuthSessionInvalidationReason;
};

type Cleanup = () => void;

const protectedRouteRoots = [
  "/dashboard",
  "/jobs",
  "/resume",
  "/tracker",
  "/profile",
  "/settings",
  "/matches",
  "/application-answers",
  "/cover-letter"
] as const;

const cleanups = new Set<Cleanup>();
let invalidationStarted = false;
let activeLoginHref = "/login";

function isProtectedPath(pathname: string): boolean {
  return protectedRouteRoots.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`)
  );
}

/**
 * Return an internal protected destination, or null for anything that could be
 * public, recursive, or attacker-controlled.
 */
export function safeReturnPath(candidate: string | null | undefined): string | null {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return null;
  if (candidate.includes("\\")) return null;
  try {
    const parsed = new URL(candidate, "https://xpertapply.invalid");
    if (parsed.origin !== "https://xpertapply.invalid") return null;
    if (!isProtectedPath(parsed.pathname)) return null;
    for (const key of ["token", "access_token", "refresh_token", "id_token", "code"]) {
      if (parsed.searchParams.has(key)) return null;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function currentProtectedReturnPath(): string | null {
  if (typeof window === "undefined") return null;
  return safeReturnPath(`${window.location.pathname}${window.location.search}`);
}

export function loginHrefFor(returnTo?: string | null): string {
  const safe = safeReturnPath(returnTo);
  return safe ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  // Opaque/test tokens are left to the server. The production access token is
  // JWT-shaped; a malformed JWT-shaped value is known-invalid locally.
  if (parts.length !== 3) return {};
  try {
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const payload = JSON.parse(window.atob(padded));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** False only when auth is absent or a JWT is obviously malformed/expired. */
export function hasUsableStoredSession(): boolean {
  const token = readAuthToken();
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (payload === null) return false;
  if (!("exp" in payload)) return true;
  return typeof payload.exp === "number" && payload.exp > Date.now() / 1000;
}

function runCleanups(): void {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Cleanup must never prevent credential removal or navigation.
    }
  }
}

function notifySessionChanged(): void {
  window.dispatchEvent(new Event(AUTH_SESSION_CHANGED_EVENT));
}

function isTeardownSuccess(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const value = response as { ok?: unknown };
  return value.ok === true && Object.keys(value).length === 1;
}

/** Tell the installed extension to discard the prior account's workflow state
 * through Chrome's externally-connectable runtime channel. No page-visible
 * postMessage result participates in extension presence or authorization. */
export async function requestExtensionSessionEnd(
  reason: AuthSessionInvalidationReason | "account_changed",
  timeoutMs = SESSION_END_TIMEOUT_MS
): Promise<"acknowledged" | "extension_absent"> {
  const presence = await connectExternalExtension(timeoutMs);
  if (presence.kind === "absent") return "extension_absent";
  if (presence.kind === "timeout") throw new Error("Extension presence check timed out.");
  if (presence.kind !== "present") throw new Error("Extension presence check failed.");
  const teardown = await presence.channel.request(
    { type: EXTERNAL_SESSION_END, reason },
    timeoutMs
  );
  if (teardown.kind === "timeout") {
    throw new Error("Installed extension did not acknowledge session teardown.");
  }
  if (teardown.kind !== "response" || !isTeardownSuccess(teardown.response)) {
    throw new Error("Extension session teardown failed.");
  }
  return "acknowledged";
}

/** React/external consumers can observe login, logout, expiry, and other tabs. */
export function subscribeAuthSession(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(AUTH_SESSION_CHANGED_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function registerAuthSessionCleanup(cleanup: Cleanup): () => void {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

/** The only supported token write path. It also opens a fresh invalidation cycle. */
export async function storeAuthToken(token: string): Promise<void> {
  if (typeof window === "undefined") return;
  const previousToken = readAuthToken();
  runCleanups();
  if (previousToken && previousToken !== token) {
    // Fail closed between accounts: old web authority is removed immediately,
    // and replacement authority is not activated until the extension confirms
    // its security-critical purge (or bounded detection establishes absence).
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    notifySessionChanged();
    await requestExtensionSessionEnd("account_changed");
  }
  window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  invalidationStarted = false;
  activeLoginHref = "/login";
  notifySessionChanged();
}

export function clearAuthSession(reason: AuthSessionInvalidationReason = "logout"): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  runCleanups();
  notifySessionChanged();
  void requestExtensionSessionEnd(reason).catch(() => undefined);
}

/**
 * Idempotently invalidate the current browser session. Parallel 401 responses
 * remove state and emit at most one navigation event.
 */
export function invalidateAuthSession({
  reason = "expired",
  returnTo = reason === "expired" ? currentProtectedReturnPath() : null
}: {
  reason?: AuthSessionInvalidationReason;
  returnTo?: string | null;
} = {}): { initiated: boolean; loginHref: string } {
  if (typeof window === "undefined") {
    return { initiated: false, loginHref: loginHrefFor(returnTo) };
  }
  if (invalidationStarted) {
    return { initiated: false, loginHref: activeLoginHref };
  }
  invalidationStarted = true;
  activeLoginHref = loginHrefFor(returnTo);
  clearAuthSession(reason);
  window.dispatchEvent(
    new CustomEvent<AuthSessionInvalidationDetail>(AUTH_SESSION_INVALIDATED_EVENT, {
      detail: { loginHref: activeLoginHref, reason }
    })
  );
  return { initiated: true, loginHref: activeLoginHref };
}

/** Test seam for module state that intentionally survives component unmounts. */
export function __resetAuthSessionForTests(): void {
  invalidationStarted = false;
  activeLoginHref = "/login";
}
