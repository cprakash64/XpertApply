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

const TEST_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const PING_RESPONSE = {
  ok: true,
  info: { installed: true, version: "0.2.0", protocolVersion: 3, capabilities: ["fill"] }
};

function installExternalRuntime() {
  type Call = {
    extensionId: string;
    message: { type: string; reason?: string };
    callback: (response: unknown) => void;
  };
  const calls: Call[] = [];
  const runtime: {
    lastError?: { message: string };
    sendMessage: (extensionId: string, message: Call["message"], callback: Call["callback"]) => void;
  } = {
    sendMessage(extensionId, message, callback) {
      calls.push({ extensionId, message, callback });
    }
  };
  vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", TEST_EXTENSION_ID);
  vi.stubGlobal("chrome", { runtime });
  return {
    calls,
    async respond(index: number, response: unknown) {
      calls[index].callback(response);
      await Promise.resolve();
      await Promise.resolve();
    },
    fail(index: number, message: string) {
      runtime.lastError = { message };
      calls[index].callback(undefined);
      delete runtime.lastError;
    }
  };
}

describe("central auth-session handling", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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
    const external = installExternalRuntime();
    storeAuthToken("old-token");
    let release!: (value: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => { release = resolve; })
    );

    const oldRequest = api("/profile").catch((cause: unknown) => cause);
    const replacement = storeAuthToken("new-token");
    await external.respond(0, PING_RESPONSE);
    await external.respond(1, { ok: true });
    await replacement;
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

  it("explicit logout clears the token and requests browser-routed teardown", async () => {
    const external = installExternalRuntime();
    storeAuthToken("valid-token");
    const result = invalidateAuthSession({ reason: "logout", returnTo: null });
    expect(result).toEqual({ initiated: true, loginHref: "/login" });
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    expect(external.calls[0]).toMatchObject({
      extensionId: TEST_EXTENSION_ID,
      message: { type: "XPERTAPPLY_EXTERNAL_PING" }
    });
    await external.respond(0, PING_RESPONSE);
    expect(external.calls[1].message).toEqual({
      type: "XPERTAPPLY_EXTERNAL_SESSION_END", reason: "logout"
    });
  });

  it("does not activate a replacement token until the extension acknowledges teardown", async () => {
    const external = installExternalRuntime();
    const postMessage = vi.spyOn(window, "postMessage");
    storeAuthToken("user-a-token");
    expect(postMessage).not.toHaveBeenCalled();

    storeAuthToken("user-a-token");
    expect(postMessage).not.toHaveBeenCalled();

    const replacement = storeAuthToken("user-b-token");
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
    expect(external.calls[0].message).toEqual({ type: "XPERTAPPLY_EXTERNAL_PING" });
    await external.respond(0, PING_RESPONSE);
    expect(external.calls[1].message).toEqual({
      type: "XPERTAPPLY_EXTERNAL_SESSION_END", reason: "account_changed"
    });
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    await external.respond(1, { ok: true });
    await replacement;
    expect(localStorage.getItem("jobpilot_token")).toBe("user-b-token");
  });

  it("same-page legacy PONG and exact forged ACK cannot authorize replacement", async () => {
    const external = installExternalRuntime();
    storeAuthToken("user-a-token");
    const replacement = storeAuthToken("user-b-token");
    for (const data of [
      { source: "jobpilot-extension", type: "JOBPILOT_PONG" },
      { source: "jobpilot-extension", type: "JOBPILOT_SESSION_END_RESULT", requestId: "known-old-request", ok: true }
    ]) window.dispatchEvent(new MessageEvent("message", {
      source: window, origin: window.location.origin, data
    }));
    await Promise.resolve();
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    expect(external.calls).toHaveLength(1);
    await external.respond(0, PING_RESPONSE);
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    await external.respond(1, { ok: true });
    await replacement;
    expect(localStorage.getItem("jobpilot_token")).toBe("user-b-token");
  });

  it("negative control: the retired page-visible ACK design authorizes the same forgery", async () => {
    localStorage.setItem("jobpilot_token", "user-a-token");
    const legacyReplacement = new Promise<void>((resolve) => {
      const requestId = "observable-request";
      window.addEventListener("message", function legacyListener(event) {
        const data = event.data as { source?: string; type?: string; requestId?: string; ok?: boolean };
        if (event.source !== window || event.origin !== window.location.origin
          || data.source !== "jobpilot-extension" || data.type !== "JOBPILOT_SESSION_END_RESULT"
          || data.requestId !== requestId || data.ok !== true) return;
        window.removeEventListener("message", legacyListener);
        localStorage.setItem("jobpilot_token", "user-b-token");
        resolve();
      });
      localStorage.removeItem("jobpilot_token");
      window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_SESSION_END", requestId }, window.location.origin);
    });
    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: {
        source: "jobpilot-extension", type: "JOBPILOT_SESSION_END_RESULT",
        requestId: "observable-request", ok: true
      }
    }));
    await legacyReplacement;
    expect(localStorage.getItem("jobpilot_token")).toBe("user-b-token");
  });

  it("fails closed on an explicit teardown failure", async () => {
    const external = installExternalRuntime();
    storeAuthToken("user-a-token");
    const replacement = storeAuthToken("user-b-token");
    await external.respond(0, PING_RESPONSE);
    await external.respond(1, { ok: false, error: "SESSION_END_FAILED" });
    await expect(replacement).rejects.toThrow("teardown failed");
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
  });

  it("permits replacement when Chrome reports no receiving extension", async () => {
    const external = installExternalRuntime();
    storeAuthToken("user-a-token");
    const replacement = storeAuthToken("user-b-token");
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    external.fail(0, "Could not establish connection. Receiving end does not exist.");
    await replacement;
    expect(localStorage.getItem("jobpilot_token")).toBe("user-b-token");
  });

  it("does not activate replacement authority when an installed extension times out", async () => {
    vi.useFakeTimers();
    const external = installExternalRuntime();
    storeAuthToken("user-a-token");
    const replacement = storeAuthToken("user-b-token");
    await external.respond(0, PING_RESPONSE);
    const rejected = expect(replacement).rejects.toThrow("did not acknowledge");
    await vi.advanceTimersByTimeAsync(1_600);
    await rejected;
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    vi.useRealTimers();
  });

  it.each(["expired", "account_deleted"] as const)(
    "forwards the %s invalidation reason without account data",
    async (reason) => {
      const external = installExternalRuntime();
      storeAuthToken("valid-token");
      invalidateAuthSession({ reason, returnTo: null });
      await external.respond(0, PING_RESPONSE);
      expect(external.calls[1].message).toEqual({
        type: "XPERTAPPLY_EXTERNAL_SESSION_END", reason
      });
    }
  );
});
