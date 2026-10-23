import { describe, expect, it, vi } from "vitest";
import { AUTH_STORAGE_KEY, AuthUnavailableError, base64Url, createExtensionAuth, type AuthDeps } from "../auth/extensionAuth";

const REDIRECT = "https://" + "a".repeat(32) + ".chromiumapp.org/xpertapply";

function harness(overrides: Partial<AuthDeps> = {}) {
  const store: Record<string, unknown> = {};
  let clock = 1_000_000;
  const calls: { path: string; body: any }[] = [];
  let launched: string | null = null;
  const respond = vi.fn(async (_path: string, _body: any): Promise<Response> => new Response("{}", { status: 500 }));
  const deps: AuthDeps = {
    storage: {
      get: async (key: string) => ({ [key]: store[key] }),
      set: async (obj: Record<string, unknown>) => { Object.assign(store, obj); },
      remove: async (key: string) => { delete store[key]; }
    } as AuthDeps["storage"],
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body });
      return respond(path, body);
    }) as typeof fetch,
    apiBase: async () => "https://api.example.test",
    webBase: async () => "https://web.example.test",
    redirectUrl: () => REDIRECT,
    launchWebAuthFlow: async ({ url }) => {
      launched = url;
      const u = new URL(url);
      return `${REDIRECT}?code=the-code&state=${u.searchParams.get("state")}`;
    },
    now: () => clock,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    ...overrides
  };
  return { auth: createExtensionAuth(deps), store, calls, respond, advance: (ms: number) => { clock += ms; }, launched: () => launched };
}

const tokens = (id = 7, access = "acc-1", refresh = "ref-1", expiresIn = 1800) => new Response(JSON.stringify({
  access_token: access, refresh_token: refresh, expires_in: expiresIn, user: { id, email: `u${id}@example.test` }
}), { status: 200 });

async function sha256(verifier: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

describe("extension sign-in (authorization code + PKCE)", () => {
  it("sends only the challenge to the browser and the verifier only to the token endpoint", async () => {
    const h = harness();
    h.respond.mockResolvedValueOnce(tokens());
    const result = await h.auth.connect();
    const url = new URL(h.launched()!);
    expect(url.origin + url.pathname).toBe("https://web.example.test/extension/connect");
    const exchange = h.calls[0];
    expect(exchange.path).toBe("/extension/auth/token");
    expect(exchange.body).toMatchObject({ grant_type: "authorization_code", code: "the-code", redirect_uri: REDIRECT });
    expect(url.searchParams.get("challenge")).toBe(await sha256(exchange.body.code_verifier));
    expect(h.launched()).not.toContain(exchange.body.code_verifier);
    expect(result).toEqual({ userId: 7, email: "u7@example.test", previousUserId: null });
    expect(await h.auth.state()).toEqual({ status: "signed_in", userId: 7, email: "u7@example.test" });
  });

  it("refuses a response whose state does not match (CSRF) and stores nothing", async () => {
    const h = harness({ launchWebAuthFlow: async () => `${REDIRECT}?code=c&state=forged` });
    await expect(h.auth.connect()).rejects.toThrow("AUTH_REJECTED");
    expect(h.calls).toHaveLength(0);
    expect(await h.auth.state()).toEqual({ status: "signed_out" });
  });

  it("refuses a redirect that is not the extension's own", async () => {
    const h = harness({ launchWebAuthFlow: async ({ url }) => `https://evil.example/cb?code=c&state=${new URL(url).searchParams.get("state")}` });
    await expect(h.auth.connect()).rejects.toThrow("AUTH_REJECTED");
    expect(h.calls).toHaveLength(0);
  });

  it("reports a cancelled window as cancelled", async () => {
    const h = harness({ launchWebAuthFlow: async () => undefined });
    await expect(h.auth.connect()).rejects.toThrow("AUTH_CANCELLED");
  });

  it("reports the previous account so the caller can purge on a switch", async () => {
    const h = harness();
    h.respond.mockResolvedValueOnce(tokens(7)).mockResolvedValueOnce(tokens(9, "acc-9", "ref-9"));
    await h.auth.connect();
    expect((await h.auth.connect()).previousUserId).toBe(7);
  });
});

describe("token lifetime", () => {
  it("returns the stored token while fresh, and refreshes (once, rotating) near expiry", async () => {
    const h = harness();
    h.respond.mockResolvedValueOnce(tokens(7, "acc-1", "ref-1", 1800));
    await h.auth.connect();
    expect((await h.auth.accessToken())?.token).toBe("acc-1");
    expect(h.calls).toHaveLength(1);

    h.advance(1_790_000);
    h.respond.mockResolvedValueOnce(tokens(7, "acc-2", "ref-2", 1800));
    const [a, b] = await Promise.all([h.auth.accessToken(), h.auth.accessToken()]);
    expect(a?.token).toBe("acc-2");
    expect(b?.token).toBe("acc-2");
    const refreshes = h.calls.filter((c) => c.body?.grant_type === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body.refresh_token).toBe("ref-1");
    expect((h.store[AUTH_STORAGE_KEY] as { refreshToken: string }).refreshToken).toBe("ref-2");
  });

  it("signs out locally when the server refuses the refresh (revoked, expired or replayed)", async () => {
    const h = harness();
    h.respond.mockResolvedValueOnce(tokens());
    await h.auth.connect();
    h.advance(1_800_000);
    h.respond.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(await h.auth.accessToken()).toBeNull();
    expect(h.store[AUTH_STORAGE_KEY]).toBeUndefined();
    expect(await h.auth.state()).toEqual({ status: "signed_out" });
  });

  it("keeps the credential through an outage instead of signing the user out", async () => {
    const h = harness();
    h.respond.mockResolvedValueOnce(tokens());
    await h.auth.connect();
    h.advance(1_800_000);
    h.respond.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(h.auth.accessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(h.store[AUTH_STORAGE_KEY]).toBeDefined();
  });

  it("refuses a refresh that answers as a different account", async () => {
    const h = harness();
    h.respond.mockResolvedValueOnce(tokens(7));
    await h.auth.connect();
    h.advance(1_800_000);
    h.respond.mockResolvedValueOnce(tokens(8, "acc-8", "ref-8"));
    expect(await h.auth.accessToken()).toBeNull();
    expect(await h.auth.state()).toEqual({ status: "signed_out" });
  });

  it("disconnect forgets the credential and revokes it server-side", async () => {
    const h = harness();
    h.respond.mockResolvedValueOnce(tokens(7, "acc-1", "ref-1"));
    await h.auth.connect();
    h.respond.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await h.auth.disconnect();
    expect(h.store[AUTH_STORAGE_KEY]).toBeUndefined();
    expect(h.calls.at(-1)).toEqual({ path: "/extension/auth/revoke", body: { refresh_token: "ref-1" } });
  });

  it("disconnect still signs out locally when the server is unreachable", async () => {
    const h = harness();
    h.respond.mockResolvedValueOnce(tokens());
    await h.auth.connect();
    h.respond.mockRejectedValueOnce(new Error("offline"));
    await h.auth.disconnect();
    expect(await h.auth.state()).toEqual({ status: "signed_out" });
  });
});
