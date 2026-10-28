/** TEMPORARY Stage 3C-V reachability probe. Deleted before the stage ends. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

type Listener = (raw: unknown, sender: unknown, respond: (r: unknown) => void) => boolean | undefined;

const EMPLOYER = "https://employer.fixture/apply";
const ATS = "https://ats.fixture/embed/1";
const ADS = "https://ads.fixture/banner";

function launch() {
  const now = Date.now();
  return {
    version: 1, applicationId: "55", jobId: "1", applicationUrl: EMPLOYER,
    status: "prepared", handoffToken: "t", requestId: "r", sessionId: 55,
    launchToken: "t", officialUrl: EMPLOYER, expectedOrigin: "https://employer.fixture",
    createdAt: now, expiresAt: now + 900_000, state: "package_ready",
    protocolVersion: 3, atsType: null
  };
}

/** Chrome as PRODUCTION has it after only employer.fixture was granted. */
function installProdChrome() {
  const store: Record<string, unknown> = {};
  const messageListeners: Listener[] = [];
  const granted = new Set(["https://employer.fixture/*"]);
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
      create: vi.fn(async () => ({ id: 900 })),
      get: vi.fn(async () => ({ id: 7, url: EMPLOYER })),
      update: vi.fn(async () => ({})),
      query: vi.fn(async () => []),
      // Only frame 0 has a content script (only employer.fixture is granted).
      sendMessage: vi.fn((_t: number, msg: { type: string }, opts: unknown, cb?: (r: unknown) => void) => {
        const done = typeof opts === "function" ? opts as (r: unknown) => void : cb;
        const frameId = (opts as { frameId?: number })?.frameId;
        if (frameId === 0) return done?.({ ok: true, evidence: false, fieldCount: 0 });
        return done?.(undefined);
      })
    },
    windows: { update: vi.fn(async () => ({})) },
    scripting: {
      // executeScript reports ONE RESULT PER INJECTABLE FRAME. The ungranted
      // ats.fixture frame is not injectable, so Chrome omits it entirely.
      executeScript: vi.fn(async () => [{ frameId: 0, result: "https://employer.fixture/apply" }])
    },
    permissions: {
      contains: vi.fn(async (q: { origins?: string[]; permissions?: string[] }) => {
        // webNavigation is optional and NOTHING in the codebase requests it.
        if (q.permissions) return false;
        return (q.origins ?? []).every((o) => granted.has(o));
      }),
      request: vi.fn(async () => true)
    },
    // Not present: the optional permission was never granted.
    webNavigation: undefined,
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;
  return { messageListeners, store, fakeChrome };
}

function dispatch(listeners: Listener[], raw: unknown, from: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    for (const fn of listeners) fn(raw, from, (r) => { if (!done) { done = true; resolve(r); } });
  });
}

/** What the granted top frame ACTUALLY sees in its own DOM. */
const OBSERVED = [
  {
    frameIndex: 0, origin: "https://ats.fixture", pathShape: "/embed/<id>", urlKind: "https",
    srcObservable: true, sandboxTokens: [], sandboxed: false, opaqueOrigin: false,
    sameOriginReadable: false, readableFieldCount: 0
  },
  {
    frameIndex: 1, origin: "https://ads.fixture", pathShape: "/banner", urlKind: "https",
    srcObservable: true, sandboxTokens: [], sandboxed: false, opaqueOrigin: false,
    sameOriginReadable: false, readableFieldCount: 0
  }
];

describe("STAGE 3C-V: embedded ATS permission discovery, production Chrome", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reports the outcome the shipped worker actually returns", async () => {
    const { messageListeners } = installProdChrome();
    const state = await import("../state");
    await state.putActive(launch() as never);
    await state.putPending(7, launch() as never);
    await import("../background");

    const report = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_INSPECT_APPLICATION_FRAMES", observed: OBSERVED },
      { tab: { id: 7, url: EMPLOYER }, frameId: 0, url: EMPLOYER, origin: "https://employer.fixture" }
    )) as { ok?: boolean; outcome?: string; reopenOrigin?: string | null; enumerationSource?: string;
            enumerationComplete?: boolean; frames?: unknown[] };

    console.log("\n=== INSPECT_APPLICATION_FRAMES (production permission state) ===");
    console.log(JSON.stringify({
      outcome: report.outcome,
      reopenOrigin: report.reopenOrigin,
      enumerationSource: report.enumerationSource,
      enumerationComplete: report.enumerationComplete,
      framesSeen: report.frames
    }, null, 2));

    // Bootstrap only offers the permission remedy when outcome is exactly this:
    const permissionRemedyOffered = report.outcome === "APPLICATION_FRAME_PERMISSION_MISSING";
    console.log("permission remedy offered to user:", permissionRemedyOffered);
    console.log("ats.fixture present in worker frame list:",
      JSON.stringify(report.frames).includes("ats.fixture"));

    expect(report.ok).toBe(true);
  });

  it("shows what the DOM-side verdict would have said", async () => {
    const { frameVerdict, selectApplicationFrame } = await import("../frames/frameInventory");
    const candidate = selectApplicationFrame(OBSERVED as never);
    const verdict = frameVerdict({
      frame: candidate, contentScriptResponds: false, hostPermissionGranted: false, reportedFieldCount: null
    });
    console.log("\n=== DOM-side (content script) view ===");
    console.log("selected candidate origin:", candidate?.origin);
    console.log("frameVerdict:", verdict);
    expect(verdict).toBe("APPLICATION_FRAME_PERMISSION_MISSING");
  });
});
