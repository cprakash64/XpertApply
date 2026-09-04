import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLaunch } from "../messages";

type Listener = (raw: unknown, sender: unknown, respond: (value: unknown) => void) => boolean | void;

const EMPLOYER = "https://careers.mongodb.com/jobs/123/apply";
const EMPLOYER_ORIGIN = "https://careers.mongodb.com";
const ATS = "https://boards.greenhouse.io/embed/mongodb/1";
const ATS_PATTERN = "https://boards.greenhouse.io/*";
const ADS = "https://ads.doubleclick.net/widget";

function launch(): PendingLaunch {
  return {
    version: 1, applicationId: "55", jobId: "1", applicationUrl: EMPLOYER,
    status: "prepared", handoffToken: "t", requestId: "r", sessionId: 55,
    launchToken: "t", officialUrl: EMPLOYER, expectedOrigin: EMPLOYER_ORIGIN,
    createdAt: Date.now(), expiresAt: Date.now() + 900_000,
    state: "package_ready", protocolVersion: 3, atsType: null
  };
}

function installChrome() {
  const store: Record<string, unknown> = {};
  const listeners: Listener[] = [];
  const injected = new Set([0]); // employer top frame was already injected
  const executeScript = vi.fn(async (options: {
    target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
    files?: string[];
    func?: () => unknown;
  }) => {
    const frames = [
      { frameId: 0, url: EMPLOYER },
      { frameId: 3, url: ATS },
      { frameId: 4, url: ADS }
    ];
    const granted = frames.filter((frame) => frame.frameId !== 4);
    if (options.func) return granted.map((frame) => ({ frameId: frame.frameId, result: frame.url }));
    const targets = options.target.frameIds ?? (options.target.allFrames ? granted.map((frame) => frame.frameId) : [0]);
    for (const frameId of targets) injected.add(frameId);
    return targets.map((frameId) => ({ frameId }));
  });

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => undefined },
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
      lastError: undefined,
      getManifest: () => ({ update_url: undefined, version: "0.2.0" })
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (value: Record<string, unknown>) => Object.assign(store, value),
        remove: async (key: string) => { delete store[key]; }
      }
    },
    tabs: {
      onRemoved: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
      onCreated: { addListener: () => undefined },
      get: vi.fn(async () => ({ id: 7, url: EMPLOYER })),
      query: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 7 })),
      update: vi.fn(async () => ({})),
      sendMessage: vi.fn((_tabId: number, message: { type?: string }, options: unknown, callback?: (value: unknown) => void) => {
        const done = typeof options === "function" ? options as (value: unknown) => void : callback;
        const frameId = typeof options === "object" && options
          ? (options as { frameId?: number }).frameId
          : 0;
        if (!injected.has(frameId ?? 0)) return done?.(undefined);
        if (message.type === "JOBPILOT_PROBE_FRAME_APPLICATION") {
          return done?.({ ok: true, evidence: frameId === 3, fieldCount: frameId === 3 ? 8 : 0 });
        }
        return done?.({ ok: true });
      })
    },
    windows: { update: vi.fn(async () => ({})) },
    scripting: { executeScript },
    permissions: {
      contains: vi.fn(async (query: { origins?: string[]; permissions?: string[] }) => {
        if (query.permissions) return false;
        return (query.origins ?? []).every((origin) => [ATS_PATTERN, `${EMPLOYER_ORIGIN}/*`].includes(origin));
      }),
      request: vi.fn(async () => true)
    },
    webNavigation: undefined,
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  return { listeners, executeScript };
}

function dispatch(listeners: Listener[], raw: unknown, sender: unknown = {}): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    for (const listener of listeners) {
      listener(raw, sender, (value) => {
        if (!done) { done = true; resolve(value); }
      });
    }
  });
}

describe("Stage 3C-3 post-grant embedded ATS activation", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes Chrome identity and injects only the concrete trusted ATS frame", async () => {
    const { listeners, executeScript } = installChrome();
    const state = await import("../state");
    const pending = launch();
    await state.putActive(pending);
    await state.putPending(7, pending);
    const view = state.initialView(7, pending, "MongoDB", "Engineer");
    await state.putView(7, {
      ...view,
      siteAccess: "site_access_required",
      siteAccessPattern: ATS_PATTERN,
      siteAccessOrigin: "boards.greenhouse.io",
      siteAccessScope: "frame",
      siteAccessFramePathShape: "/embed/mongodb/<id>"
    });
    await import("../background");

    const result = await dispatch(listeners, {
      type: "JOBPILOT_SITE_ACCESS_RESULT", tabId: 7, pattern: ATS_PATTERN, granted: true
    });

    expect(result).toMatchObject({ ok: true, state: "site_access_granted" });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [3] }, files: ["content.js"]
    });
    expect(executeScript).not.toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ allFrames: true }), files: ["content.js"]
    }));
  });

  it("9 · a bootstrap handshake from an untrusted frame receives no session or documents", async () => {
    const { listeners } = installChrome();
    const state = await import("../state");
    const pending = launch();
    await state.putActive(pending);
    await state.putPending(7, pending);
    await import("../background");

    const response = await dispatch(listeners, {
      type: "JOBPILOT_CONTENT_READY",
      // Forged message fields claim the legitimate ATS. Chrome's sender below
      // is the unrelated ad and must remain authoritative.
      url: ATS,
      title: "Apply",
      protocolVersion: 3,
      isTopFrame: false,
      topUrl: EMPLOYER,
      detectedAts: "greenhouse",
      probe: {
        isTopFrame: false,
        sanitizedUrl: ATS,
        rootConfident: true,
        applicationLabelsFound: ["first_name", "last_name"],
        bestScore: 50
      }
    }, {
      tab: { id: 7, url: EMPLOYER },
      frameId: 4,
      url: ADS,
      origin: "https://ads.doubleclick.net"
    }) as { matched?: boolean; error?: string; session?: unknown; launch?: unknown };

    expect(response.matched).toBe(false);
    expect(response.error).toBe("FRAME_ORIGIN_NOT_IN_WORKFLOW");
    expect(response.session ?? null).toBeNull();
    expect(response.launch ?? null).toBeNull();
  });
});
