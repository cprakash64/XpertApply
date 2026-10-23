/**
 * Extension-first sign-in.
 *
 * The extension signs the user in by itself, through a trusted XpertApply page,
 * so an application opened directly on an employer site never needs a launch
 * from the website.
 *
 *   connect()    OAuth 2.0 authorization-code + PKCE through
 *                `chrome.identity.launchWebAuthFlow`: Chrome opens the XpertApply
 *                connect page in its own auth window, the user approves, and the
 *                code returns to `https://<extension-id>.chromiumapp.org/`.
 *                The verifier never leaves this module, so an intercepted code is
 *                useless on its own.
 *
 *   tokens       A short-lived access token and a rotating refresh credential, in
 *                the extension origin's IndexedDB (see `createIndexedDbAuthStore`): the
 *                service worker and extension pages can read them; content scripts and
 *                employer pages cannot.
 *                The access token is only ever attached to requests the worker
 *                makes; it is never sent in a message, a URL or the page DOM.
 *
 *   revocation   A refresh that the server refuses (revoked, expired, replayed)
 *                signs the extension out locally. Disconnecting revokes the
 *                credential family server-side first.
 *
 * Everything outside this file sees an identity (`userId`) and a token fetched
 * on demand — never storage keys.
 */

export const AUTH_STORAGE_KEY = "xaExtensionAuthV1";
const REFRESH_SKEW_MS = 60_000;

export interface StoredAuth {
  v: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: number;
  email: string;
}

export type AuthState =
  | { status: "signed_out" }
  | { status: "signed_in"; userId: number; email: string };

/** The server could not be reached or failed: say nothing about the credential. */
export class AuthUnavailableError extends Error {
  constructor(message = "AUTH_UNAVAILABLE") {
    super(message);
  }
}

type Area = Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;

export interface AuthDeps {
  storage: Area;
  fetchFn: typeof fetch;
  apiBase: () => Promise<string>;
  webBase: () => Promise<string>;
  redirectUrl: () => string;
  launchWebAuthFlow: (details: { url: string; interactive: boolean }) => Promise<string | undefined>;
  now: () => number;
  randomBytes: (length: number) => Uint8Array;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: number; email: string };
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function isTokenResponse(value: unknown): value is TokenResponse {
  const v = value as Partial<TokenResponse> | null;
  return Boolean(
    v && typeof v.access_token === "string" && typeof v.refresh_token === "string"
      && typeof v.expires_in === "number" && v.user && typeof v.user.id === "number"
      && typeof v.user.email === "string"
  );
}

function isStoredAuth(value: unknown): value is StoredAuth {
  const v = value as Partial<StoredAuth> | null;
  return Boolean(
    v && v.v === 1 && typeof v.accessToken === "string" && typeof v.refreshToken === "string"
      && typeof v.expiresAt === "number" && typeof v.userId === "number" && typeof v.email === "string"
  );
}

export function createExtensionAuth(deps: AuthDeps) {
  let refreshInFlight: Promise<StoredAuth | null> | null = null;

  async function read(): Promise<StoredAuth | null> {
    try {
      const value = (await deps.storage.get(AUTH_STORAGE_KEY))[AUTH_STORAGE_KEY];
      return isStoredAuth(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function write(tokens: TokenResponse): Promise<StoredAuth> {
    const stored: StoredAuth = {
      v: 1,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: deps.now() + tokens.expires_in * 1000,
      userId: tokens.user.id,
      email: tokens.user.email
    };
    await deps.storage.set({ [AUTH_STORAGE_KEY]: stored });
    return stored;
  }

  async function post(path: string, body: unknown): Promise<Response> {
    try {
      return await deps.fetchFn(`${await deps.apiBase()}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch {
      throw new AuthUnavailableError();
    }
  }

  async function refresh(current: StoredAuth): Promise<StoredAuth | null> {
    // One refresh at a time: the server rotates the credential, so two parallel
    // refreshes would present a spent token and be treated as a replay.
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const res = await post("/extension/auth/token", { grant_type: "refresh_token", refresh_token: current.refreshToken });
      if (res.status === 401 || res.status === 400) {
        await deps.storage.remove(AUTH_STORAGE_KEY);
        return null;
      }
      if (!res.ok) throw new AuthUnavailableError();
      const body: unknown = await res.json().catch(() => null);
      if (!isTokenResponse(body)) throw new AuthUnavailableError();
      // A refresh can only continue the same account. Anything else is refused
      // rather than silently adopted.
      if (body.user.id !== current.userId) {
        await deps.storage.remove(AUTH_STORAGE_KEY);
        return null;
      }
      return write(body);
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  return {
    async state(): Promise<AuthState> {
      const stored = await read();
      return stored ? { status: "signed_in", userId: stored.userId, email: stored.email } : { status: "signed_out" };
    },

    /** A usable access token, refreshing when it is about to expire. Null means signed out. */
    async accessToken(): Promise<{ token: string; userId: number } | null> {
      const stored = await read();
      if (!stored) return null;
      if (stored.expiresAt - deps.now() > REFRESH_SKEW_MS) return { token: stored.accessToken, userId: stored.userId };
      const renewed = await refresh(stored);
      return renewed ? { token: renewed.accessToken, userId: renewed.userId } : null;
    },

    /** The server refused a token that looked valid (revoked mid-life): try one refresh, else sign out. */
    async recoverFromUnauthorized(): Promise<{ token: string; userId: number } | null> {
      const stored = await read();
      if (!stored) return null;
      const renewed = await refresh(stored);
      return renewed ? { token: renewed.accessToken, userId: renewed.userId } : null;
    },

    async connect(): Promise<{ userId: number; email: string; previousUserId: number | null }> {
      const previous = await read();
      const verifier = base64Url(deps.randomBytes(32));
      const state = base64Url(deps.randomBytes(16));
      const redirectUri = deps.redirectUrl();
      const url = new URL(`${await deps.webBase()}/extension/connect`);
      url.searchParams.set("challenge", await sha256Challenge(verifier));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      let responseUrl: string | undefined;
      try {
        responseUrl = await deps.launchWebAuthFlow({ url: url.toString(), interactive: true });
      } catch {
        // Chrome rejects when the user closes the window or declines ("The user did not approve access").
        throw new Error("AUTH_CANCELLED");
      }
      if (!responseUrl) throw new Error("AUTH_CANCELLED");
      let returned: URL;
      try {
        returned = new URL(responseUrl);
      } catch {
        throw new Error("AUTH_REJECTED");
      }
      // Origin AND path must be the extension's own redirect; a prefix match would accept lookalikes.
      if (`${returned.origin}${returned.pathname}` !== redirectUri) throw new Error("AUTH_REJECTED");
      // State is verified before anything else in the response is believed, errors included.
      if (returned.searchParams.get("state") !== state) throw new Error("AUTH_REJECTED");
      if (returned.searchParams.get("error")) throw new Error("AUTH_DENIED");
      const code = returned.searchParams.get("code");
      if (!code) throw new Error("AUTH_REJECTED");
      const res = await post("/extension/auth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri
      });
      if (!res.ok) throw new Error(res.status >= 500 ? "AUTH_UNAVAILABLE" : "AUTH_REJECTED");
      const body: unknown = await res.json().catch(() => null);
      if (!isTokenResponse(body)) throw new Error("AUTH_REJECTED");
      const stored = await write(body);
      return { userId: stored.userId, email: stored.email, previousUserId: previous?.userId ?? null };
    },

    /** Revoke server-side (best effort) and forget the credential locally. */
    async disconnect(): Promise<void> {
      const stored = await read();
      await deps.storage.remove(AUTH_STORAGE_KEY);
      if (!stored) return;
      await post("/extension/auth/revoke", { refresh_token: stored.refreshToken }).catch(() => undefined);
    }
  };
}

export type ExtensionAuth = ReturnType<typeof createExtensionAuth>;

/**
 * Where the credential lives: IndexedDB in the extension's own origin.
 *
 * Not `chrome.storage.local`: Chrome exposes that area to content scripts by default, which
 * would let any script running in an employer page's isolated world read a durable refresh
 * token. A content script's IndexedDB is the *page's* database, never the extension's, so
 * this store is reachable only from the service worker and extension pages. It persists
 * across browser restarts like any extension storage.
 */
export function createIndexedDbAuthStore(dbName = "xpertapply-extension-auth"): Area {
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = work(db.transaction("kv", mode).objectStore("kv"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (async (key: string) => ({ [key]: await run("readonly", (store) => store.get(key)) })) as Area["get"],
    set: (async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) await run("readwrite", (store) => store.put(value, key));
    }) as Area["set"],
    remove: (async (key: string) => { await run("readwrite", (store) => store.delete(key)); }) as Area["remove"]
  };
}
