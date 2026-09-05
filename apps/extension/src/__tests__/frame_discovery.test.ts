/**
 * Stage 3C-2 — embedded ATS permission discovery, and the destination trust
 * boundary that shares its policy.
 *
 * The defects these lock down
 * ---------------------------
 * 1. PERMISSION DISCOVERY CIRCULARITY. Stage 3C made employer/ATS host access
 *    optional, so an embedded ATS frame starts ungranted. The worker worked out
 *    which frames existed from `scripting.executeScript({ allFrames: true })`,
 *    which reports one result per INJECTABLE frame — so the ungranted frame,
 *    the only one whose problem was the missing grant, never appeared. The
 *    optional `webNavigation` path that would have seen it is never requested.
 *    `APPLICATION_FRAME_PERMISSION_MISSING` was therefore unreachable in the
 *    shipped build and the user was offered "reopen as a tab" instead of the
 *    one grant that would have worked.
 *
 * 2. DESTINATION TRUST GAP. Candidate frames were ranked on application SHAPE
 *    alone, and `ACTIVATE_APPLICATION_DESTINATION` checked session and scheme
 *    but not origin. An ad, consent or analytics iframe could therefore be
 *    reopened as "the application" and named to the user as the site needing
 *    access.
 *
 * These tests drive the REAL `chrome.runtime.onMessage` listener that
 * background.ts registers, against a chrome mock that models the ACTUAL
 * production permission state. In particular `permissions.contains` is NOT
 * stubbed to `true`: it answers from a granted set, `webNavigation` is absent
 * and ungranted, and `executeScript` omits frames the extension may not inject
 * into — which is precisely the condition that hid the defect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalFrameOrigin,
  frameDiscoveryOutcome,
  mergeFrameInventories,
  selectTrustedApplicationCandidate,
  type FrameDiscoveryRecord
} from "../frames/frameDiscovery";
import { observeFrames } from "../frames/frameInventory";

type Listener = (raw: unknown, sender: unknown, respond: (r: unknown) => void) => boolean | undefined;

const EMPLOYER = "https://careers.mongodb.com/jobs/123/apply";
const EMPLOYER_ORIGIN = "https://careers.mongodb.com";
const ATS = "https://boards.greenhouse.io/embed/mongodb/1";
const ATS_ORIGIN = "https://boards.greenhouse.io";
const ADS_ORIGIN = "https://ads.doubleclick.net";

/** Synthetic marker; a leak of session data would carry it. Never a real person. */
const PROFILE_MARKER = "stage3c2-marker@example.test";

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

/** One iframe as the top document reports it. */
function observedFrame(
  frameIndex: number,
  origin: string | null,
  extra: Record<string, unknown> = {}
) {
  return {
    frameIndex, origin, pathShape: "/embed/<id>", urlKind: "https",
    srcObservable: true, sandboxTokens: [], sandboxed: false, opaqueOrigin: false,
    sameOriginReadable: false, readableFieldCount: 0, ...extra
  };
}

/**
 * Chrome as production actually has it.
 *
 * `granted` is the set of origins the user has allowed. Everything else follows
 * from it the way the browser makes it follow: an ungranted origin cannot be
 * injected into, so it is absent from `executeScript` results and silent to
 * `tabs.sendMessage`.
 */
function installProductionChrome(options: {
  granted: string[];
  /** Every frame really in the tab, granted or not. Chrome reveals a subset. */
  liveFrames: { frameId: number; url: string; fieldCount?: number; evidence?: boolean }[];
  webNavigationGranted?: boolean;
}) {
  const store: Record<string, unknown> = {};
  const messageListeners: Listener[] = [];
  const granted = new Set(options.granted.map((origin) => `${origin}/*`));
  const injected = new Set<number>([0]);
  const isGranted = (url: string) => {
    try {
      return granted.has(`${new URL(url).origin}/*`);
    } catch {
      return false;
    }
  };
  const injectable = () => options.liveFrames.filter((frame) => isGranted(frame.url));

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
      },
      session: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (o: Record<string, unknown>) => Object.assign(store, o),
        remove: async (key: string) => { delete store[key]; }
      }
    },
    tabs: {
      onRemoved: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
      onCreated: { addListener: () => undefined },
      create: vi.fn(async () => ({ id: 900 })),
      get: vi.fn(async () => ({ id: 7, url: EMPLOYER })),
      update: vi.fn(async () => ({})),
      query: vi.fn(async () => []),
      // Only an injected frame can answer. That is the browser's behaviour, and
      // reproducing it is the whole point of this mock.
      sendMessage: vi.fn((_tab: number, _msg: unknown, opts: unknown, cb?: (r: unknown) => void) => {
        const done = typeof opts === "function" ? (opts as (r: unknown) => void) : cb;
        const frameId = typeof opts === "object" && opts ? (opts as { frameId?: number }).frameId : undefined;
        const frame = injectable().find((f) => f.frameId === frameId && injected.has(f.frameId));
        if (!frame) return done?.(undefined);
        return done?.({ ok: true, evidence: Boolean(frame.evidence), fieldCount: frame.fieldCount ?? 0 });
      })
    },
    windows: { update: vi.fn(async () => ({})) },
    scripting: {
      executeScript: vi.fn(async (request: {
        target: { frameIds?: number[]; allFrames?: boolean };
        func?: () => unknown;
        files?: string[];
      }) => {
        const available = injectable();
        if (request.func) return available.map((frame) => ({ frameId: frame.frameId, result: frame.url }));
        const targetIds = request.target.frameIds
          ?? (request.target.allFrames ? available.map((frame) => frame.frameId) : [0]);
        for (const frameId of targetIds) injected.add(frameId);
        return targetIds.map((frameId) => ({ frameId }));
      })
    },
    permissions: {
      contains: vi.fn(async (q: { origins?: string[]; permissions?: string[] }) => {
        // The optional API permission. Nothing in the extension requests it, so
        // in production this is false and getAllFrames is unavailable.
        if (q.permissions) return options.webNavigationGranted === true;
        return (q.origins ?? []).every((origin) => granted.has(origin));
      }),
      request: vi.fn(async () => true)
    },
    // Absent, exactly as it is when the optional permission was never granted.
    webNavigation: undefined,
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;
  return { messageListeners, store, fakeChrome, granted, injected };
}

function installFakeFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/application-sessions/token")) {
      return new Response(JSON.stringify({ session_token: "tok" }), { status: 200 });
    }
    if (/\/application-sessions\/\d+\/answers$/.test(url)) {
      return new Response(JSON.stringify({ answers: [], unresolved_questions: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      session_id: 55, ats_type: null, official_application_url: EMPLOYER,
      job: { title: "Engineer", company: "MongoDB" }, profile: { email: PROFILE_MARKER }
    }), { status: 200 });
  }));
}

function dispatch(listeners: Listener[], raw: unknown, from: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    for (const fn of listeners) fn(raw, from, (r) => { if (!done) { done = true; resolve(r); } });
  });
}

type Inspection = {
  ok?: boolean;
  outcome?: string;
  candidateOrigin?: string | null;
  candidatePattern?: string | null;
  candidateSource?: string | null;
  frames?: { origin: string | null; source: string; frameId: number | null }[];
};

/** Boot the worker with an active launch, then ask it to inspect frames. */
async function inspect(options: Parameters<typeof installProductionChrome>[0] & {
  observed: ReturnType<typeof observedFrame>[];
  launchOverrides?: Record<string, unknown>;
}): Promise<Inspection> {
  installFakeFetch();
  const { messageListeners } = installProductionChrome(options);
  const state = await import("../state");
  await state.putActive(launch(options.launchOverrides) as never);
  await state.putPending(7, launch(options.launchOverrides) as never);
  await import("../background");
  return (await dispatch(
    messageListeners,
    { type: "JOBPILOT_INSPECT_APPLICATION_FRAMES", observed: options.observed },
    { tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER, origin: EMPLOYER_ORIGIN }
  )) as Inspection;
}

async function inspectRuntime(options: Parameters<typeof installProductionChrome>[0] & {
  observed: ReturnType<typeof observedFrame>[];
  sender?: unknown;
}) {
  installFakeFetch();
  const runtime = installProductionChrome(options);
  runtime.store.jobpilotRuntimeRevivedV1 = Date.now();
  const state = await import("../state");
  const pending = launch() as never;
  await state.putActive(pending);
  await state.putPending(7, pending);
  await state.putView(7, state.initialView(7, pending, "MongoDB", "Engineer"));
  await import("../background");
  const report = await dispatch(
    runtime.messageListeners,
    { type: "JOBPILOT_INSPECT_APPLICATION_FRAMES", observed: options.observed },
    options.sender ?? {
      tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER, origin: EMPLOYER_ORIGIN
    }
  ) as Inspection;
  return { ...runtime, report, state };
}

const TOP_ONLY = [{ frameId: 0, url: EMPLOYER }];

// --------------------------------------------------------------------------- //
// §13 — frame discovery matrix, against the real production permission state
// --------------------------------------------------------------------------- //

describe("embedded ATS discovery, employer granted and ATS not", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("A: finds the ungranted ATS frame Chrome refuses to report", async () => {
    const report = await inspect({
      granted: [EMPLOYER_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 1, url: ATS }],
      observed: [observedFrame(0, ATS_ORIGIN)]
    });

    // Chrome's own enumeration cannot see it …
    expect(report.frames?.some((f) => f.origin === ATS_ORIGIN && f.source === "chrome_confirmed")).toBe(false);
    // … the top document can, and that is enough to ask about it.
    expect(report.outcome).toBe("APPLICATION_FRAME_PERMISSION_MISSING");
    expect(report.candidateOrigin).toBe(ATS_ORIGIN);
    expect(report.candidatePattern).toBe(`${ATS_ORIGIN}/*`);
    expect(report.candidateSource).toBe("observed_ungranted");
    // Observation is never identity: no frame id is invented for it.
    expect(report.frames?.find((f) => f.origin === ATS_ORIGIN)?.frameId).toBeNull();
  });

  it("B: an ad frame earlier in DOM order does not displace the ATS frame", async () => {
    const report = await inspect({
      granted: [EMPLOYER_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 1, url: `${ADS_ORIGIN}/banner` }, { frameId: 2, url: ATS }],
      // The ad is observed FIRST — the ordering that used to decide the winner.
      observed: [observedFrame(0, ADS_ORIGIN), observedFrame(1, ATS_ORIGIN)]
    });

    expect(report.candidateOrigin).toBe(ATS_ORIGIN);
    expect(report.outcome).toBe("APPLICATION_FRAME_PERMISSION_MISSING");
  });

  it("C: an ad frame that outscores the ATS on shape is removed before ranking", async () => {
    const report = await inspect({
      granted: [EMPLOYER_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 1, url: `${ADS_ORIGIN}/banner` }, { frameId: 2, url: ATS }],
      observed: [
        // A far more application-shaped frame — and still not ours to ask for.
        observedFrame(0, ADS_ORIGIN, { readableFieldCount: 40, sameOriginReadable: true }),
        observedFrame(1, ATS_ORIGIN)
      ]
    });

    expect(report.candidateOrigin).toBe(ATS_ORIGIN);
    expect(report.frames?.find((f) => f.origin === ADS_ORIGIN)).toBeTruthy(); // recorded …
    expect(report.candidateOrigin).not.toBe(ADS_ORIGIN);                      // … never chosen
  });

  it("D: lookalike and suffix-confusion ATS hostnames are refused", async () => {
    for (const host of [
      "https://boards.greenhouse.io.evil.test",
      "https://notgreenhouse.io",
      "https://greenhouse.example.attacker.test",
      "https://careers.mongodb.com.evil.test"
    ]) {
      vi.resetModules();
      const report = await inspect({
        granted: [EMPLOYER_ORIGIN],
        liveFrames: TOP_ONLY,
        observed: [observedFrame(0, host)]
      });
      expect(report.candidateOrigin, host).toBeNull();
      expect(report.outcome, host).toBe("APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE");
    }
  });

  it("E: once the ATS is granted, Chrome-confirmed identity takes over", async () => {
    const report = await inspect({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 3, url: ATS, fieldCount: 12, evidence: true }],
      observed: [observedFrame(0, ATS_ORIGIN)]
    });

    expect(report.candidateOrigin).toBe(ATS_ORIGIN);
    expect(report.candidateSource).toBe("chrome_confirmed");
    // A real frame id, from Chrome — not the null of an observed record.
    expect(report.frames?.find((f) => f.origin === ATS_ORIGIN)?.frameId).toBe(3);
    expect(report.outcome).toBe("APPLICATION_FRAME_DISCOVERY_COMPLETED");
  });

  it("F: with no trusted frame there is no permission target and nothing to reopen", async () => {
    const report = await inspect({
      granted: [EMPLOYER_ORIGIN],
      liveFrames: TOP_ONLY,
      observed: [observedFrame(0, ADS_ORIGIN), observedFrame(1, "https://cdn.jsdelivr.net")]
    });

    expect(report.candidateOrigin).toBeNull();
    expect(report.candidatePattern).toBeNull();
    expect(report.outcome).toBe("APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE");
  });

  it("G: two indistinguishable trusted ATS origins fail closed rather than asking for both", async () => {
    const report = await inspect({
      granted: [EMPLOYER_ORIGIN],
      liveFrames: TOP_ONLY,
      observed: [
        observedFrame(0, "https://boards.greenhouse.io"),
        observedFrame(1, "https://jobs.lever.co")
      ]
    });

    expect(report.candidateOrigin).toBeNull();
    expect(report.outcome).toBe("APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE");
  });

  it("H: malformed and non-web observed URLs never become permission targets", async () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "file:///etc/passwd",
      "chrome://settings",
      "chrome-extension://abcdef/page.html",
      "about:blank",
      "https://user:pass@boards.greenhouse.io",
      "https://*.greenhouse.io",
      "not a url",
      ""
    ]) {
      vi.resetModules();
      const report = await inspect({
        granted: [EMPLOYER_ORIGIN],
        liveFrames: TOP_ONLY,
        observed: [observedFrame(0, value)]
      });
      expect(report.candidateOrigin, value).toBeNull();
    }
  });

  it("J: an opaque sandboxed frame is named unreachable, not unpermitted", async () => {
    const report = await inspect({
      granted: [EMPLOYER_ORIGIN],
      liveFrames: TOP_ONLY,
      observed: [observedFrame(0, ATS_ORIGIN, { sandboxed: true, opaqueOrigin: true, sandboxTokens: [] })]
    });

    // Requesting a grant for an opaque origin would be a lie: no pattern matches it.
    expect(report.outcome).toBe("APPLICATION_FRAME_SANDBOXED_OPAQUE");
    expect(report.candidateOrigin).toBe(ATS_ORIGIN);
  });

  it("does not require webNavigation to reach the permission-missing verdict", async () => {
    const report = await inspect({
      granted: [EMPLOYER_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 1, url: ATS }],
      observed: [observedFrame(0, ATS_ORIGIN)],
      webNavigationGranted: false
    });
    expect(report.outcome).toBe("APPLICATION_FRAME_PERMISSION_MISSING");
  });
});

describe("Stage 3C-4 persisted-grant restart activation", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("1 · persisted exact ATS permission activates a fresh frame without requesting permission", async () => {
    const run = await inspectRuntime({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 9, url: ATS, fieldCount: 9, evidence: true }],
      observed: [observedFrame(0, ATS_ORIGIN)]
    });

    expect(run.fakeChrome.permissions.request).not.toHaveBeenCalled();
    expect(run.fakeChrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [9] }, files: ["content.js"]
    });
    expect(run.report.outcome).toBe("APPLICATION_FRAME_DISCOVERY_COMPLETED");
  });

  it("2 · a prior frame id is never reused when Chrome confirms a new frame id", async () => {
    const run = await inspectRuntime({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 9, url: ATS, fieldCount: 9, evidence: true }],
      observed: [observedFrame(0, ATS_ORIGIN)]
    });
    const injections = run.fakeChrome.scripting.executeScript.mock.calls
      .map(([call]) => call)
      .filter((call: { files?: string[] }) => call.files);
    expect(injections).toEqual([{ target: { tabId: 7, frameIds: [9] }, files: ["content.js"] }]);
    expect(JSON.stringify(injections)).not.toContain("3");
  });

  it("4 · persisted employer and ATS grants require no prompt but still bootstrap the ATS", async () => {
    const run = await inspectRuntime({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 12, url: ATS, fieldCount: 2, evidence: true }],
      observed: [observedFrame(0, ATS_ORIGIN)]
    });
    expect(run.fakeChrome.permissions.contains).toHaveBeenCalledWith({ origins: [`${ATS_ORIGIN}/*`] });
    expect(run.fakeChrome.permissions.request).not.toHaveBeenCalled();
    expect(run.injected.has(12)).toBe(true);
  });

  it("5 · a persisted grant with no live ATS frame fabricates no id and injects no data", async () => {
    const run = await inspectRuntime({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN], liveFrames: TOP_ONLY,
      observed: [observedFrame(0, ATS_ORIGIN)]
    });
    const targeted = run.fakeChrome.scripting.executeScript.mock.calls
      .map(([call]) => call as { target?: { frameIds?: number[] } })
      .filter((call) => call.target?.frameIds);
    expect(targeted).toHaveLength(0);
    expect(run.report.outcome).toBe("APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE");
    expect(JSON.stringify(run.report)).not.toContain(PROFILE_MARKER);
  });

  it("6 · a grant revoked while closed returns to the exact permission-required state", async () => {
    const run = await inspectRuntime({
      granted: [EMPLOYER_ORIGIN], liveFrames: TOP_ONLY,
      observed: [observedFrame(0, ATS_ORIGIN)]
    });
    const view = await run.state.getView(7);
    expect(run.report.outcome).toBe("APPLICATION_FRAME_PERMISSION_MISSING");
    expect(view).toMatchObject({
      siteAccess: "site_access_required", siteAccessPattern: `${ATS_ORIGIN}/*`, siteAccessScope: "frame"
    });
    expect(run.fakeChrome.scripting.executeScript.mock.calls
      .some(([call]) => Boolean((call as { target?: { frameIds?: number[] } }).target?.frameIds))).toBe(false);
  });

  it("revocation after a successful restart activation removes cached authority on the next workflow", async () => {
    const liveFrames: { frameId: number; url: string; fieldCount?: number; evidence?: boolean }[] = [
      ...TOP_ONLY,
      { frameId: 9, url: ATS, fieldCount: 9, evidence: true },
      { frameId: 4, url: `${ADS_ORIGIN}/widget`, fieldCount: 20, evidence: true }
    ];
    installFakeFetch();
    const runtime = installProductionChrome({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN], liveFrames
    });
    runtime.store.jobpilotRuntimeRevivedV1 = Date.now();
    const state = await import("../state");
    const pending = launch() as never;
    await state.putPending(7, pending);
    await state.putView(7, state.initialView(7, pending, "MongoDB", "Engineer"));
    await import("../background");
    const sender = {
      tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER, origin: EMPLOYER_ORIGIN
    };
    await dispatch(runtime.messageListeners,
      { type: "JOBPILOT_INSPECT_APPLICATION_FRAMES", observed: [observedFrame(0, ATS_ORIGIN)] },
      sender);
    expect(runtime.injected.has(9)).toBe(true);

    runtime.granted.delete(`${ATS_ORIGIN}/*`);
    liveFrames.splice(1, 1, { frameId: 11, url: ATS, fieldCount: 9, evidence: true });
    const before = runtime.fakeChrome.scripting.executeScript.mock.calls.length;
    const revoked = await dispatch(runtime.messageListeners,
      { type: "JOBPILOT_INSPECT_APPLICATION_FRAMES", observed: [observedFrame(0, ATS_ORIGIN)] },
      sender) as Inspection;
    const laterCalls = runtime.fakeChrome.scripting.executeScript.mock.calls.slice(before);
    const view = await state.getView(7);

    expect(revoked.outcome).toBe("APPLICATION_FRAME_PERMISSION_MISSING");
    expect(view).toMatchObject({
      siteAccess: "site_access_required", siteAccessPattern: `${ATS_ORIGIN}/*`, siteAccessScope: "frame"
    });
    expect(laterCalls.some(([call]) =>
      (call as { target?: { frameIds?: number[] } }).target?.frameIds?.includes(11))).toBe(false);
    expect(runtime.injected.has(11)).toBe(false);
    expect(runtime.injected.has(4)).toBe(false);
    expect(JSON.stringify(revoked)).not.toContain(PROFILE_MARKER);
  });

  it("7 · an ad present after restart is neither permission target nor injection target", async () => {
    const run = await inspectRuntime({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN],
      liveFrames: [
        ...TOP_ONLY,
        { frameId: 8, url: `${ADS_ORIGIN}/banner`, fieldCount: 40, evidence: true },
        { frameId: 9, url: ATS, fieldCount: 9, evidence: true }
      ],
      observed: [observedFrame(0, ADS_ORIGIN, { readableFieldCount: 40 }), observedFrame(1, ATS_ORIGIN)]
    });
    expect(run.report.candidateOrigin).toBe(ATS_ORIGIN);
    expect(run.injected.has(8)).toBe(false);
    expect(run.fakeChrome.permissions.request).not.toHaveBeenCalled();
  });

  it("8 · duplicate same-origin ATS frames fail closed without targeted injection", async () => {
    const run = await inspectRuntime({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN],
      liveFrames: [
        ...TOP_ONLY,
        { frameId: 9, url: ATS },
        { frameId: 10, url: ATS }
      ],
      observed: [observedFrame(0, ATS_ORIGIN)]
    });
    const targeted = run.fakeChrome.scripting.executeScript.mock.calls
      .map(([call]) => call as { target?: { frameIds?: number[] } })
      .filter((call) => call.target?.frameIds);
    expect(targeted).toHaveLength(0);
    expect(run.report.outcome).toBe("APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE");
  });

  it("10 · retry performs a fresh inventory and activates an ATS that appeared later", async () => {
    const liveFrames: { frameId: number; url: string; fieldCount?: number; evidence?: boolean }[] = [...TOP_ONLY];
    installFakeFetch();
    const runtime = installProductionChrome({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN], liveFrames
    });
    runtime.store.jobpilotRuntimeRevivedV1 = Date.now();
    const state = await import("../state");
    const pending = launch() as never;
    await state.putPending(7, pending);
    await state.putView(7, state.initialView(7, pending, "MongoDB", "Engineer"));
    await import("../background");
    const sender = {
      tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER, origin: EMPLOYER_ORIGIN
    };

    await dispatch(runtime.messageListeners,
      { type: "JOBPILOT_INSPECT_APPLICATION_FRAMES", observed: [observedFrame(0, ATS_ORIGIN)] },
      sender);
    liveFrames.push({ frameId: 9, url: ATS, fieldCount: 9, evidence: true });
    const retried = await dispatch(runtime.messageListeners,
      { type: "JOBPILOT_INSPECT_APPLICATION_FRAMES", observed: [observedFrame(0, ATS_ORIGIN)] },
      sender) as Inspection;

    expect(runtime.fakeChrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [9] }, files: ["content.js"]
    });
    expect(retried.outcome).toBe("APPLICATION_FRAME_DISCOVERY_COMPLETED");
  });

  it("11 · a bootstrap timeout delivers no profile or resume", async () => {
    const run = installProductionChrome({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 9, url: ATS }]
    });
    run.store.jobpilotRuntimeRevivedV1 = Date.now();
    run.fakeChrome.scripting.executeScript.mockImplementation(async (request: { func?: () => unknown }) => {
      if (request.func) return [
        { frameId: 0, result: EMPLOYER },
        { frameId: 9, result: ATS }
      ];
      return [{ frameId: 9 }]; // execute returned, but bootstrap never answers
    });
    installFakeFetch();
    const state = await import("../state");
    const pending = launch() as never;
    await state.putPending(7, pending);
    await state.putView(7, state.initialView(7, pending, "MongoDB", "Engineer"));
    await import("../background");
    const report = await dispatch(run.messageListeners,
      { type: "JOBPILOT_INSPECT_APPLICATION_FRAMES", observed: [observedFrame(0, ATS_ORIGIN)] },
      { tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER, origin: EMPLOYER_ORIGIN }
    );
    expect(JSON.stringify(report)).not.toContain(PROFILE_MARKER);
    expect(run.fakeChrome.tabs.sendMessage).not.toHaveBeenCalledWith(
      7, expect.objectContaining({ type: "JOBPILOT_REQUEST_DOCUMENT" }), expect.anything(), expect.anything()
    );
  });

  it("12 · forged payload claims cannot turn a nested ad sender into the trusted top frame", async () => {
    const run = await inspectRuntime({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN],
      liveFrames: [...TOP_ONLY, { frameId: 9, url: ATS }],
      observed: [observedFrame(0, ATS_ORIGIN)],
      sender: {
        tab: { id: 7, url: EMPLOYER }, frameId: 4,
        url: `${ADS_ORIGIN}/widget`, origin: ADS_ORIGIN,
        isTopFrame: true, frameIdClaim: 0, originClaim: EMPLOYER_ORIGIN
      }
    });
    expect(run.report.candidateOrigin).toBeNull();
    expect(run.injected.has(9)).toBe(false);
    expect(JSON.stringify(run.report)).not.toContain(PROFILE_MARKER);
  });
});

// --------------------------------------------------------------------------- //
// §13-I — relative iframe URLs, resolved against the parent document
// --------------------------------------------------------------------------- //

describe("observed iframe URLs", () => {
  it("I: resolves a relative src against the parent document's origin", () => {
    document.body.innerHTML = `<iframe src="/apply/embed"></iframe>`;
    const [frame] = observeFrames(document);
    // jsdom serves the test document from localhost, which is a loopback origin
    // the extension does treat as a web origin.
    expect(frame.urlKind === "https" || frame.urlKind === "http_local").toBe(true);
    expect(frame.origin).toBe(window.location.origin);
    expect(frame.pathShape).toBe("/apply/embed");
    document.body.innerHTML = "";
  });

  it("canonicalizes to a portless origin, matching Chrome match-pattern semantics", () => {
    expect(canonicalFrameOrigin("https://boards.greenhouse.io:8443/x")).toBe("https://boards.greenhouse.io");
    expect(canonicalFrameOrigin("https://BOARDS.Greenhouse.IO/x")).toBe("https://boards.greenhouse.io");
  });
});

// --------------------------------------------------------------------------- //
// §5 / §21 — the state machine, exercised directly
// --------------------------------------------------------------------------- //

function record(overrides: Partial<FrameDiscoveryRecord>): FrameDiscoveryRecord {
  return {
    source: "observed_ungranted", frameId: null, parentFrameId: null,
    origin: ATS_ORIGIN, pathShape: null, urlKind: "https",
    contentScriptResponds: false, hostPermissionGranted: false,
    applicationEvidence: false, fieldCount: 0, sandboxTokens: [],
    opaqueOrigin: false, workflowTrusted: true, ...overrides
  };
}

describe("frame discovery states stay distinguishable", () => {
  it("merges rather than overriding: an unreportable frame survives enumeration", () => {
    const merged = mergeFrameInventories(
      [record({ source: "chrome_confirmed", frameId: 0, origin: EMPLOYER_ORIGIN, hostPermissionGranted: true, contentScriptResponds: true })],
      [record({ origin: ATS_ORIGIN })]
    );
    expect(merged.map((f) => f.origin)).toEqual([EMPLOYER_ORIGIN, ATS_ORIGIN]);
  });

  it("prefers Chrome-confirmed identity for a frame both sources can see", () => {
    const merged = mergeFrameInventories(
      [record({ source: "chrome_confirmed", frameId: 4, hostPermissionGranted: true, contentScriptResponds: true })],
      [record({ origin: ATS_ORIGIN })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("chrome_confirmed");
    expect(merged[0].frameId).toBe(4);
  });

  it("collapses several iframes on one origin into a single permission question", () => {
    const merged = mergeFrameInventories([], [
      record({ origin: ATS_ORIGIN }), record({ origin: ATS_ORIGIN })
    ]);
    expect(merged).toHaveLength(1);
    expect(selectTrustedApplicationCandidate(merged)?.origin).toBe(ATS_ORIGIN);
  });

  it("never lets an untrusted frame reach ranking", () => {
    const chosen = selectTrustedApplicationCandidate([
      record({ origin: ADS_ORIGIN, workflowTrusted: false, applicationEvidence: true, fieldCount: 50 }),
      record({ origin: ATS_ORIGIN, workflowTrusted: true })
    ]);
    expect(chosen?.origin).toBe(ATS_ORIGIN);
  });

  it("never proposes the top frame as the embedded application", () => {
    expect(selectTrustedApplicationCandidate([
      record({ source: "chrome_confirmed", frameId: 0, origin: EMPLOYER_ORIGIN })
    ])).toBeNull();
  });

  it("orders permission before injectability, so a grant is offered instead of a shrug", () => {
    expect(frameDiscoveryOutcome(record({ hostPermissionGranted: false, contentScriptResponds: false })))
      .toBe("APPLICATION_FRAME_PERMISSION_MISSING");
    expect(frameDiscoveryOutcome(record({ hostPermissionGranted: true, contentScriptResponds: false })))
      .toBe("APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE");
    expect(frameDiscoveryOutcome(null)).toBe("APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE");
  });
});

// --------------------------------------------------------------------------- //
// §12 — no permission request for unrelated embedded origins
// --------------------------------------------------------------------------- //

describe("unrelated embedded origins are never surfaced as needing access", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const UNRELATED = [
    "https://ads.doubleclick.net",          // advertising
    "https://www.google-analytics.com",     // analytics
    "https://widget.intercom.io",           // chat
    "https://consent.cookiebot.com",        // consent manager
    "https://cdn.jsdelivr.net",             // CDN widget
    "https://boards.greenhouse.io.evil.test", // suffix confusion
    "https://notgreenhouse.io"              // prefix confusion
  ];

  it("refuses every one of them as a permission target", async () => {
    for (const origin of UNRELATED) {
      vi.resetModules();
      const report = await inspect({
        granted: [EMPLOYER_ORIGIN],
        liveFrames: TOP_ONLY,
        // Application-shaped, and still not part of this workflow.
        observed: [observedFrame(0, origin, { readableFieldCount: 25 })]
      });
      expect(report.candidateOrigin, origin).toBeNull();
      expect(report.candidatePattern, origin).toBeNull();
      expect(JSON.stringify(report), origin).not.toContain(PROFILE_MARKER);
    }
  });

  it("refuses them at the permission-request gate too, not only in ranking", async () => {
    installFakeFetch();
    const { messageListeners } = installProductionChrome({
      granted: [EMPLOYER_ORIGIN], liveFrames: TOP_ONLY
    });
    const state = await import("../state");
    await state.putActive(launch() as never);
    await state.putPending(7, launch() as never);
    await import("../background");

    for (const origin of UNRELATED) {
      const result = (await dispatch(
        messageListeners,
        { type: "JOBPILOT_REQUEST_FRAME_PERMISSION", origin },
        { tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER }
      )) as { ok?: boolean; reason?: string };
      expect(result.ok, origin).toBe(false);
      expect(result.reason, origin).toBe("ORIGIN_NOT_IN_WORKFLOW");
    }
  });

  it("accepts the legitimate ATS origin at that same gate", async () => {
    installFakeFetch();
    const { messageListeners } = installProductionChrome({
      granted: [EMPLOYER_ORIGIN], liveFrames: TOP_ONLY
    });
    const state = await import("../state");
    await state.putActive(launch() as never);
    await state.putPending(7, launch() as never);
    await import("../background");

    const result = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_REQUEST_FRAME_PERMISSION", origin: ATS_ORIGIN },
      { tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER }
    )) as { ok?: boolean; reason?: string };
    // Not granted yet — but recognized, and recorded for the side panel to ask.
    expect(result.reason).toBe("SITE_ACCESS_REQUIRED");
  });

  it("records the ATS origin — and only it — on the tab's view for the side panel", async () => {
    installFakeFetch();
    const { messageListeners } = installProductionChrome({
      granted: [EMPLOYER_ORIGIN], liveFrames: TOP_ONLY
    });
    const state = await import("../state");
    await state.putActive(launch() as never);
    await state.putPending(7, launch() as never);
    // The tab already has a view by this point in a real run: binding creates
    // one before any frame can report a remedy.
    await state.putView(7, state.initialView(7, launch() as never, "MongoDB", "Engineer"));
    await import("../background");

    await dispatch(
      messageListeners,
      { type: "JOBPILOT_REQUEST_FRAME_PERMISSION", origin: ATS_ORIGIN },
      { tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER }
    );

    const view = await state.getView(7);
    expect(view?.siteAccess).toBe("site_access_required");
    expect(view?.siteAccessPattern).toBe(`${ATS_ORIGIN}/*`);
    expect(view?.siteAccessOrigin).toBe("boards.greenhouse.io");
    expect(view?.siteAccessScope).toBe("frame");
    // Never a wildcard, and never the ad origin.
    expect(view?.siteAccessPattern).not.toContain("*.");
    expect(JSON.stringify(view)).not.toContain("doubleclick");
  });
});

// --------------------------------------------------------------------------- //
// §17 — discovery visibility is not sender identity (Stage 3A unchanged)
// --------------------------------------------------------------------------- //

describe("being observable to the top document buys a frame nothing", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function bindAndReport(frameUrl: string) {
    installFakeFetch();
    const { messageListeners } = installProductionChrome({
      granted: [EMPLOYER_ORIGIN, ATS_ORIGIN], liveFrames: TOP_ONLY
    });
    const state = await import("../state");
    await state.putActive(launch() as never);
    await import("../background");

    // Bind the tab with an honest top-frame handshake.
    await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: EMPLOYER, title: "Apply", protocolVersion: 3,
        isTopFrame: true, topUrl: EMPLOYER, detectedAts: null },
      { tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER, origin: EMPLOYER_ORIGIN }
    );

    // Then let discovery see every iframe on the page, including this one.
    await dispatch(
      messageListeners,
      { type: "JOBPILOT_INSPECT_APPLICATION_FRAMES",
        observed: [observedFrame(0, new URL(frameUrl).origin), observedFrame(1, ATS_ORIGIN)] },
      { tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER, origin: EMPLOYER_ORIGIN }
    );

    // Now the frame itself reports in. Chrome supplies its real URL.
    return (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: frameUrl, title: "x", protocolVersion: 3,
        isTopFrame: false, topUrl: null, detectedAts: null },
      { tab: { id: 7, url: EMPLOYER }, frameId: 21, url: frameUrl, origin: new URL(frameUrl).origin }
    )) as { matched?: boolean; error?: string; session?: unknown; launch?: unknown };
  }

  it("gives an observed third-party frame no session, profile or résumé", async () => {
    const reply = await bindAndReport("https://ads.doubleclick.net/apply");
    expect(reply.matched).toBe(false);
    expect(reply.error).toBe("FRAME_ORIGIN_NOT_IN_WORKFLOW");
    expect(reply.session ?? null).toBeNull();
    expect(reply.launch ?? null).toBeNull();
    expect(JSON.stringify(reply)).not.toContain(PROFILE_MARKER);
  });

  it("still authorizes the real ATS frame once it is actually running there", async () => {
    const reply = await bindAndReport(ATS);
    expect(reply.matched).toBe(true);
    expect(reply.session).toBeTruthy();
  });
});
