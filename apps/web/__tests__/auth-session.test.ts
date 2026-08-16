import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  __resetAuthSessionForTests,
  hasUsableStoredSession,
  invalidateAuthSession,
  loginHrefFor,
  safeReturnPath,
  storeAuthToken,
  type AuthSessionInvalidationDetail
} from "@/lib/authSession";

function response(status: number, detail = "failure") {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function jwt(exp: number): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "1", exp })}.signature`;
}

describe("central auth-session handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    __resetAuthSessionForTests();
    window.history.replaceState({}, "", "/profile/preferences");
  });

  it("accepts only known internal protected return paths", () => {
    expect(safeReturnPath("/profile/preferences?step=2")).toBe("/profile/preferences?step=2");
    expect(loginHrefFor("/profile/preferences")).toBe(
      "/login?next=%2Fprofile%2Fpreferences"
    );
    for (const unsafe of [
      "https://attacker.example/steal",
      "//attacker.example/steal",
      "/\\attacker.example",
      "/login?next=/dashboard",
      "/signup",
      "/privacy",
      "/dashboard?access_token=secret"
    ]) {
      expect(safeReturnPath(unsafe)).toBeNull();
    }
  });

  it("rejects an expired or malformed JWT-shaped token before protected rendering", () => {
    storeAuthToken(jwt(Math.floor(Date.now() / 1000) - 60));
    expect(hasUsableStoredSession()).toBe(false);
    storeAuthToken("malformed.jwt.value");
    expect(hasUsableStoredSession()).toBe(false);
    storeAuthToken(jwt(Math.floor(Date.now() / 1000) + 60));
    expect(hasUsableStoredSession()).toBe(true);
  });

  it("turns a protected 401 into one cleanup and one safe login event", async () => {
    storeAuthToken("stale-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(401, "Invalid token"));
    const details: AuthSessionInvalidationDetail[] = [];
    window.addEventListener(
      AUTH_SESSION_INVALIDATED_EVENT,
      ((event: Event) => {
        details.push((event as CustomEvent<AuthSessionInvalidationDetail>).detail);
      }) as EventListener,
      { once: true }
    );

    await expect(api("/profile")).rejects.toMatchObject({ status: 401, code: "auth_expired" });

    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    expect(details).toEqual([
      {
        loginHref: "/login?next=%2Fprofile%2Fpreferences",
        reason: "expired"
      }
    ]);
  });

  it("coordinates parallel 401 responses into one invalidation", async () => {
    storeAuthToken("stale-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(401, "Invalid token"));
    const listener = vi.fn();
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);

    await Promise.allSettled([api("/dashboard/summary"), api("/profile")]);

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
  });

  it("does not let a late 401 from an old token clear a newer login", async () => {
    storeAuthToken("old-token");
    let release!: (value: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => { release = resolve; })
    );

    const oldRequest = api("/profile").catch((cause: unknown) => cause);
    storeAuthToken("new-token");
    release(response(401, "Invalid token"));
    await oldRequest;

    expect(localStorage.getItem("jobpilot_token")).toBe("new-token");
  });

  it.each([
    [403, "forbidden"],
    [422, "validation"],
    [500, "server_error"]
  ] as const)("does not invalidate the session for HTTP %s", async (status, code) => {
    storeAuthToken("valid-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(status));
    const listener = vi.fn();
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);

    const error = await api("/profile", { method: "PATCH", body: "{}" }).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code });
    expect(localStorage.getItem("jobpilot_token")).toBe("valid-token");
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
  });

  it("does not invalidate the session for a network failure", async () => {
    storeAuthToken("valid-token");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    await expect(api("/dashboard/summary")).rejects.toMatchObject({
      code: "network_unreachable",
      status: undefined
    });
    expect(localStorage.getItem("jobpilot_token")).toBe("valid-token");
  });

  it("keeps login usable with stale auth data and does not attach it", async () => {
    storeAuthToken("stale-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response(401, "Invalid credentials"));
    await expect(api("/auth/login", { method: "POST", body: "{}" })).rejects.toMatchObject({
      status: 401
    });
    expect(localStorage.getItem("jobpilot_token")).toBe("stale-token");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("explicit logout clears the token without preserving a protected return", () => {
    storeAuthToken("valid-token");
    const result = invalidateAuthSession({ reason: "logout", returnTo: null });
    expect(result).toEqual({ initiated: true, loginHref: "/login" });
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
  });
});
