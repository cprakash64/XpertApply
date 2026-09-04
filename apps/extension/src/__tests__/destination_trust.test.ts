/**
 * Stage 3C-2 — the application-destination trust boundary.
 *
 * The defect this locks down: every URL reaching
 * `ACTIVATE_APPLICATION_DESTINATION` is PAGE-DERIVED — an anchor href read off
 * the listing, or the `src` of an embedded frame. The handler validated the
 * scheme and that the session matched, but never asked whether the destination
 * ORIGIN belonged to the workflow. It was therefore a second, weaker trust
 * system beside the one the permission path uses, and an application-shaped ad,
 * consent or analytics frame could be reopened as "the application" and then
 * named to the user as the site needing access.
 *
 * The fix reuses `originJoinsWorkflow` — the same predicate as Stage 3A's frame
 * gate and the host-permission gate — rather than adding a private allow-list.
 * These tests drive the real message listener.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (raw: unknown, sender: unknown, respond: (r: unknown) => void) => boolean | undefined;

const EMPLOYER = "https://careers.mongodb.com/jobs/123/apply";
const EMPLOYER_ORIGIN = "https://careers.mongodb.com";

function launch(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    version: 1, applicationId: "55", jobId: "1", applicationUrl: EMPLOYER,
    status: "prepared", handoffToken: "t", requestId: "r", sessionId: 55,
    launchToken: "t", officialUrl: EMPLOYER, expectedOrigin: EMPLOYER_ORIGIN,
    createdAt: now, expiresAt: now + 900_000, state: "package_ready",
    protocolVersion: 3, atsType: null, ...overrides
  };
}

function installChrome() {
  const store: Record<string, unknown> = {};
  const messageListeners: Listener[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const fakeChrome = {
    runtime: {
      onInstalled: { addListener: () => undefined },
      onMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
      lastError: undefined,
      getManifest: () => ({ update_url: undefined, version: "0.2.0" })
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (o: Record<string, unknown>) => Object.assign(store, o),
        remove: async (key: string) => { delete store[key]; }
      }
    },
    tabs: {
      onRemoved: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
      onCreated: { addListener: () => undefined },
      create: vi.fn(async (opts: { url: string }) => { created.push(opts.url); return { id: 900 }; }),
      get: vi.fn(async () => ({ id: 7, url: EMPLOYER })),
      update: vi.fn(async (_id: number, opts: { url?: string }) => {
        if (opts?.url) updated.push(opts.url);
        return {};
      }),
      query: vi.fn(async () => []),
      sendMessage: vi.fn((_t: number, _m: unknown, opts: unknown, cb?: (r: unknown) => void) => {
        const done = typeof opts === "function" ? (opts as (r: unknown) => void) : cb;
        done?.(undefined);
      })
    },
    windows: { update: vi.fn(async () => ({})) },
    scripting: { executeScript: vi.fn(async () => []) },
    permissions: {
      // Deliberately NOT a blanket true: the destination gate must refuse on
      // origin policy, not because a permission check happened to pass.
      contains: vi.fn(async (q: { origins?: string[] }) =>
        (q.origins ?? []).every((o) => o === `${EMPLOYER_ORIGIN}/*`)),
      request: vi.fn(async () => true)
    },
    webNavigation: undefined,
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;
  return { messageListeners, created, updated, fakeChrome };
}

function dispatch(listeners: Listener[], raw: unknown, from: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    for (const fn of listeners) fn(raw, from, (r) => { if (!done) { done = true; resolve(r); } });
  });
}

type NavResult = { ok?: boolean; error?: string; tabId?: number };

async function boot(launchOverrides?: Record<string, unknown>, withLaunch = true) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  const harness = installChrome();
  const state = await import("../state");
  if (withLaunch) {
    await state.putActive(launch(launchOverrides) as never);
    await state.putPending(7, launch(launchOverrides) as never);
  }
  await import("../background");
  return harness;
}

function activate(
  listeners: Listener[],
  url: string,
  overrides: Record<string, unknown> = {}
): Promise<NavResult> {
  return dispatch(
    listeners,
    {
      type: "JOBPILOT_ACTIVATE_APPLICATION_DESTINATION",
      sessionId: 55, url, newTab: true, source: "embedded_application_frame",
      ...overrides
    },
    { tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER }
  ) as Promise<NavResult>;
}

describe("application destination navigation", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("A: opens a legitimate embedded ATS destination", async () => {
    const { messageListeners, created } = await boot();
    const result = await activate(messageListeners, "https://boards.greenhouse.io/embed/mongodb/1");
    expect(result.ok).toBe(true);
    expect(created).toEqual(["https://boards.greenhouse.io/embed/mongodb/1"]);
  });

  it("A2: opens the employer's own apply URL", async () => {
    const { messageListeners, created } = await boot();
    const result = await activate(messageListeners, "https://careers.mongodb.com/jobs/123/apply/form");
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("B: refuses an advertising origin", async () => {
    const { messageListeners, created } = await boot();
    const result = await activate(messageListeners, "https://ads.doubleclick.net/apply");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ORIGIN_NOT_IN_WORKFLOW");
    expect(created).toEqual([]);
  });

  it("C: refuses an unrelated origin however application-shaped its URL looks", async () => {
    const { messageListeners, created } = await boot();
    for (const url of [
      "https://widget.intercom.io/apply/form",
      "https://consent.cookiebot.com/jobs/apply",
      "https://www.google-analytics.com/application/submit",
      "https://cdn.jsdelivr.net/apply"
    ]) {
      const result = await activate(messageListeners, url);
      expect(result.error, url).toBe("ORIGIN_NOT_IN_WORKFLOW");
    }
    expect(created).toEqual([]);
  });

  it("D: refuses suffix- and prefix-confusion hostnames", async () => {
    const { messageListeners, created } = await boot();
    for (const url of [
      "https://boards.greenhouse.io.evil.test/embed/1",
      "https://notgreenhouse.io/embed/1",
      "https://greenhouse.example.attacker.test/embed/1",
      "https://careers.mongodb.com.evil.test/apply"
    ]) {
      const result = await activate(messageListeners, url);
      expect(result.error, url).toBe("ORIGIN_NOT_IN_WORKFLOW");
    }
    expect(created).toEqual([]);
  });

  it("E: refuses an unsupported scheme", async () => {
    const { messageListeners } = await boot();
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "http://boards.greenhouse.io/x"]) {
      const result = await activate(messageListeners, url);
      expect(["UNSAFE_SCHEME", "INVALID_URL"], url).toContain(result.error);
    }
  });

  it("F: refuses a destination claimed for a different session", async () => {
    const { messageListeners } = await boot();
    const result = await activate(
      messageListeners, "https://boards.greenhouse.io/embed/1", { sessionId: 999 }
    );
    expect(result.error).toBe("SESSION_MISMATCH");
  });

  it("G: refuses when there is no active launch at all", async () => {
    const { messageListeners } = await boot(undefined, false);
    const result = await activate(messageListeners, "https://boards.greenhouse.io/embed/1");
    expect(result.error).toBe("SESSION_MISMATCH");
  });

  it("H: refuses a malformed URL", async () => {
    const { messageListeners } = await boot();
    for (const url of ["not a url", "", "https://"]) {
      const result = await activate(messageListeners, url);
      expect(result.ok, url).toBe(false);
    }
  });

  it("the workflow's own ATS is reachable even when it is not the launch URL", async () => {
    // officialUrl is the employer listing; the application lives on an
    // allow-listed ATS. That hop is the normal shape of an assisted apply.
    const { messageListeners } = await boot({ officialUrl: EMPLOYER, applicationUrl: EMPLOYER });
    const result = await activate(messageListeners, "https://jobs.lever.co/mongodb/1");
    expect(result.ok).toBe(true);
  });
});
