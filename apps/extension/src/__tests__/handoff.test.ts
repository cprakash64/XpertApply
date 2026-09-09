/**
 * Background gating tests for the broad-host-permissions model: the ATS
 * content script is declaratively injected into every https(s) page, so the
 * ONLY thing keeping it dormant on unrelated sites is the background's
 * CONTENT_READY handshake. These tests drive that handshake directly (through
 * the real chrome.runtime.onMessage listener background.ts registers) against
 * a fake chrome + fetch, and inspect durable state via ../state so results
 * don't depend on any UI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLaunch } from "../messages";

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void;

function installFakeChrome(existingStore?: Record<string, unknown>, queryTabs: chrome.tabs.Tab[] = []) {
  const store = existingStore ?? {};
  const messageListeners: Listener[] = [];
  const installedListeners: Array<() => void> = [];
  const sentToTabs: {
    tabId: number;
    message: unknown;
    options?: { frameId?: number; documentId?: string };
  }[] = [];
  const tabsCreated: Array<{ id: number; url: string }> = [];
  const executedScripts: Array<{ tabId: number }> = [];
  let nextTabId = 1000;

  const fakeChrome = {
    runtime: {
      onInstalled: { addListener: (fn: () => void) => installedListeners.push(fn) },
      onMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
      lastError: undefined as { message: string } | undefined,
      getManifest: () => ({ update_url: undefined, version: "0.2.0" })
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
        remove: async (key: string) => { delete store[key]; }
      }
    },
    tabs: {
      onRemoved: { addListener: (_fn: unknown) => undefined },
      onUpdated: { addListener: (_fn: unknown) => undefined },
      // Real Chrome always provides this; the background uses it to adopt a
      // popup/new tab the page itself opened during an apply handoff.
      onCreated: { addListener: (_fn: unknown) => undefined },
      create: vi.fn(async (opts: { url: string }) => {
        const id = nextTabId++;
        tabsCreated.push({ id, url: opts.url });
        return { id };
      }),
      get: vi.fn(async (): Promise<chrome.tabs.Tab> => { throw new Error("no such tab"); }),
      update: vi.fn(async () => ({})),
      query: vi.fn(async (queryInfo: { url?: string }) => {
        if (!queryInfo?.url) return [];
        const prefix = queryInfo.url.replace(/\*$/, "");
        return queryTabs.filter((t) => (t.url ?? "").startsWith(prefix));
      }),
      sendMessage: vi.fn((
        tabId: number,
        message: unknown,
        optionsOrCallback?: { frameId?: number; documentId?: string } | ((r: unknown) => void),
        callback?: (r: unknown) => void
      ) => {
        sentToTabs.push({
          tabId,
          message,
          options: typeof optionsOrCallback === "object" ? optionsOrCallback : undefined
        });
        const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
        cb?.((message as { type?: string }).type === "JOBPILOT_PROBE_FRAME_APPLICATION"
          ? {
              ok: true,
              evidence: true,
              fieldCount: 4,
              probe: {
                isTopFrame: typeof optionsOrCallback === "object"
                  ? (optionsOrCallback.frameId ?? 0) === 0
                  : true,
                sanitizedUrl: (globalThis as typeof globalThis & { __testMessageSenderUrl?: string })
                  .__testMessageSenderUrl ?? "https://careers.mongodb.com/jobs/123/apply",
                rootConfident: true,
                applicationLabelsFound: ["first_name", "last_name", "email", "resume"],
                bestScore: 12
              }
            }
          : undefined);
      })
    },
    windows: { update: vi.fn(async () => ({})) },
    scripting: {
      executeScript: vi.fn(async (opts: { target: { tabId: number } }) => {
        executedScripts.push({ tabId: opts.target.tabId });
      })
    },
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true)
    },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;
  return { fakeChrome, messageListeners, installedListeners, sentToTabs, tabsCreated, executedScripts, store };
}

function installFakeFetch() {
  const impl = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/application-sessions/token")) {
      return new Response(JSON.stringify({ session_token: "sess-tok-abc" }), { status: 200 });
    }
    if (/\/application-sessions\/\d+\/answers$/.test(url)) {
      return new Response(JSON.stringify({ answers: [], unresolved_questions: [] }), { status: 200 });
    }
    if (/\/application-sessions\/\d+$/.test(url)) {
      return new Response(
        JSON.stringify({
          session_id: 55,
          ats_type: null,
          official_application_url: "https://careers.mongodb.com/jobs/123/apply",
          job: { title: "Software Engineer", company: "MongoDB" }
        }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function dispatch(listeners: Listener[], raw: unknown, sender: unknown): Promise<unknown> {
  const supplied = sender as {
    tab?: { id?: number };
    frameId?: number;
    documentId?: string;
    url?: string;
  };
  const chromeSender = supplied.documentId
    ? supplied
    : {
        ...supplied,
        documentId: `document-${supplied.tab?.id ?? "unknown"}-${supplied.frameId ?? -1}`
      };
  (globalThis as typeof globalThis & { __testMessageSenderUrl?: string }).__testMessageSenderUrl =
    chromeSender.url;
  return new Promise((resolve) => {
    let responded = false;
    for (const fn of listeners) {
      const keepAlive = fn(raw, chromeSender, (resp) => {
        if (!responded) { responded = true; resolve(resp); }
      });
      if (!keepAlive && !responded) {
        // Synchronous listener that declined to respond — try the next one.
        continue;
      }
    }
  });
}

function seedHandoff(overrides: Partial<PendingLaunch> = {}): PendingLaunch {
  return {
    version: 1,
    applicationId: "55",
    jobId: "1",
    applicationUrl: "https://careers.mongodb.com/jobs/123/apply",
    status: "prepared",
    handoffToken: "launch-tok",
    requestId: "req-1",
    sessionId: 55,
    launchToken: "launch-tok",
    officialUrl: "https://careers.mongodb.com/jobs/123/apply",
    expectedOrigin: "https://careers.mongodb.com",
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
    state: "package_ready",
    protocolVersion: 3,
    atsType: null,
    ...overrides
  };
}

describe("content-script gating (arbitrary employer domains, e.g. MongoDB Careers)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches a custom employer domain that has an active handoff and returns the session", async () => {
    installFakeFetch();
    const { fakeChrome, messageListeners, sentToTabs } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: "https://careers.mongodb.com/jobs/123/apply", detectedAts: null },
      { tab: { id: 1, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    )) as { ok: boolean; matched: boolean; session?: { company: string } };

    expect(resp.matched).toBe(true);
    expect(resp.ok).toBe(true);
    expect(resp.session?.company).toBe("MongoDB");
    expect(sentToTabs.filter(({ message }) =>
      (message as { type?: string }).type === "JOBPILOT_PROBE_FRAME_APPLICATION"
    )).toHaveLength(1);
    void fakeChrome;
  });

  it("stays dormant (matched:false, HANDOFF_NOT_FOUND) on an unrelated https page with no handoff at all", async () => {
    installFakeFetch();
    const { messageListeners, sentToTabs } = installFakeChrome();
    await import("../background");

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://www.google.com/", title: "Google", protocolVersion: 3, isTopFrame: true, topUrl: "https://www.google.com/", detectedAts: null },
      { tab: { id: 2, url: "https://www.google.com/" }, frameId: 0, url: "https://www.google.com/" }
    )) as { ok: boolean; matched: boolean; error?: string; session?: unknown };

    expect(resp.matched).toBe(false);
    expect(resp.error).toBe("HANDOFF_NOT_FOUND");
    expect(resp.session).toBeUndefined();
    expect(sentToTabs.filter(({ message }) =>
      (message as { type?: string }).type === "JOBPILOT_PROBE_FRAME_APPLICATION"
    )).toHaveLength(0);
  });

  it("stays dormant on an https page whose URL does not match the active handoff", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://evil.example.com/phish", title: "Nope", protocolVersion: 3, isTopFrame: true, topUrl: "https://evil.example.com/phish", detectedAts: null },
      { tab: { id: 3, url: "https://evil.example.com/phish" }, frameId: 0, url: "https://evil.example.com/phish" }
    )) as { ok: boolean; matched: boolean; error?: string };

    expect(resp.matched).toBe(false);
    expect(resp.error).toBe("HANDOFF_URL_MISMATCH");
  });

  it("does not probe when the exact sender-origin grant has been revoked", async () => {
    installFakeFetch();
    const { fakeChrome, messageListeners, sentToTabs } = installFakeChrome();
    fakeChrome.permissions.contains.mockResolvedValue(false);
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY" },
      { tab: { id: 31, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    )) as { matched: boolean; error?: string };

    expect(resp).toMatchObject({ matched: false, error: "HOST_PERMISSION_MISSING" });
    expect(sentToTabs.some(({ message }) =>
      (message as { type?: string }).type === "JOBPILOT_PROBE_FRAME_APPLICATION"
    )).toBe(false);
  });

  it("discards a probe result when authority generation changes in flight", async () => {
    installFakeFetch();
    const { fakeChrome, messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    let releaseProbe: ((response: unknown) => void) | null = null;
    (fakeChrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
      const message = args[1] as { type?: string };
      const callback = args.find((arg) => typeof arg === "function") as ((response: unknown) => void) | undefined;
      if (message.type === "JOBPILOT_PROBE_FRAME_APPLICATION") releaseProbe = callback ?? null;
      else callback?.(undefined);
    });
    const background = await import("../background");

    const responsePromise = dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY" },
      { tab: { id: 32, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    ) as Promise<{ matched: boolean; error?: string }>;
    await vi.waitFor(() => expect(releaseProbe).not.toBeNull());
    state.advanceAuthorityGeneration();
    state.endSessionAuthority(55);
    const respond = releaseProbe as unknown as (response: unknown) => void;
    respond({
      ok: true,
      evidence: true,
      fieldCount: 3,
      probe: {
        isTopFrame: true,
        sanitizedUrl: (globalThis as typeof globalThis & { __testMessageSenderUrl?: string })
          .__testMessageSenderUrl ?? "https://careers.mongodb.com/jobs/123/apply",
        rootConfident: true,
        applicationLabelsFound: ["first_name", "email"],
        bestScore: 20
      }
    });

    await expect(responsePromise).resolves.toMatchObject({ matched: false, error: "STALE_AUTHORITY" });
    expect(background.frameRegistrySnapshot(32)).toEqual([]);
  });

  it("does not transfer READY authorization to a replacement document reusing the frame id", async () => {
    installFakeFetch();
    const { fakeChrome, messageListeners, sentToTabs } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    const background = await import("../background");

    let releasePermission: ((granted: boolean) => void) | null = null;
    let currentDocumentId = "document-a";
    let replacementDocumentProbeCount = 0;
    fakeChrome.permissions.contains.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      releasePermission = resolve;
    }));
    (fakeChrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
      const message = args[1] as { type?: string };
      const options = args[2] as { frameId?: number; documentId?: string };
      const callback = args.find((arg) => typeof arg === "function") as ((response: unknown) => void) | undefined;
      sentToTabs.push({ tabId: Number(args[0]), message, options });
      if (message.type !== "JOBPILOT_PROBE_FRAME_APPLICATION") return callback?.(undefined);
      if (options.documentId === currentDocumentId) {
        if (currentDocumentId === "document-b") replacementDocumentProbeCount += 1;
        return callback?.({ ok: true });
      }
      fakeChrome.runtime.lastError = { message: "No document with the given ID" };
      callback?.(undefined);
      fakeChrome.runtime.lastError = undefined;
    });

    const responsePromise = dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY" },
      {
        tab: { id: 33, url: "https://careers.mongodb.com/jobs/123/apply" },
        frameId: 0,
        documentId: "document-a",
        url: "https://careers.mongodb.com/jobs/123/apply"
      }
    ) as Promise<{ matched: boolean; error?: string }>;
    await vi.waitFor(() => expect(releasePermission).not.toBeNull());

    // Navigation keeps tab/frame 33:0 but replaces immutable document A with B.
    currentDocumentId = "document-b";
    const allow = releasePermission as unknown as (granted: boolean) => void;
    allow(true);

    await expect(responsePromise).resolves.toMatchObject({ matched: true, error: "NO_MATCHING_FRAME" });
    expect(sentToTabs.find(({ message }) =>
      (message as { type?: string }).type === "JOBPILOT_PROBE_FRAME_APPLICATION"
    )?.options).toEqual({ frameId: 0, documentId: "document-a" });
    expect(replacementDocumentProbeCount).toBe(0);
    expect(background.frameRegistrySnapshot(33)).toEqual([]);
  });

  it("trusts a nested iframe once the tab is bound, even though the iframe's own URL looks unrelated (embedded ATS widget)", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    // Top frame reports in first and binds the tab.
    await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: "https://careers.mongodb.com/jobs/123/apply", detectedAts: null },
      { tab: { id: 7, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    );

    // A nested iframe (e.g. an embedded Greenhouse widget) with an unrelated
    // URL reports in next, on the SAME tab. It must still be trusted.
    const iframeResp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://boards.greenhouse.io/embed/mongodb/1", title: "", protocolVersion: 3, isTopFrame: false, topUrl: null, detectedAts: null },
      { tab: { id: 7, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 3, url: "https://boards.greenhouse.io/embed/mongodb/1" }
    )) as { ok: boolean; matched: boolean; session?: unknown };

    expect(iframeResp.matched).toBe(true);
    expect(iframeResp.session).toBeTruthy();
  });

  it("recovers a manually-opened tab: no pre-recorded tab id, binds on the first matching CONTENT_READY", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    // Simulate "Open manually": a prepared handoff exists (staged before the
    // user clicked a plain link), but no tab was ever recorded for it.
    await state.putActive(seedHandoff());
    await import("../background");
    expect(await state.getPending(42)).toBeNull();

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: "https://careers.mongodb.com/jobs/123/apply", detectedAts: null },
      { tab: { id: 42, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    )) as { ok: boolean; matched: boolean };

    expect(resp.matched).toBe(true);
    expect((await state.getPending(42))?.targetTabId).toBe(42);
  });

  it("survives a service-worker restart: durable handoff persisted in chrome.storage.local is still resolvable after the module is reloaded", async () => {
    installFakeFetch();
    const first = installFakeChrome();
    const state1 = await import("../state");
    await state1.putActive(seedHandoff());
    await import("../background");
    await dispatch(
      first.messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: "https://careers.mongodb.com/jobs/123/apply", detectedAts: null },
      { tab: { id: 9, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    );
    expect((await state1.getPending(9))?.applicationId).toBe("55");

    // Simulate the MV3 service worker being torn down and restarted: fresh
    // module registry, fresh in-memory listener list, SAME chrome.storage.
    vi.resetModules();
    const second = installFakeChrome(first.store);
    const state2 = await import("../state");
    await import("../background");

    expect((await state2.getPending(9))?.applicationId).toBe("55");
    const resp = (await dispatch(
      second.messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: "https://careers.mongodb.com/jobs/123/apply", detectedAts: null },
      { tab: { id: 9, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    )) as { ok: boolean; matched: boolean; session?: unknown };
    expect(resp.matched).toBe(true);
    expect(resp.session).toBeTruthy();
  });

  it("never touches chrome.sidePanel to do its work — operates correctly with the side panel closed", async () => {
    installFakeFetch();
    const { fakeChrome, messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: "https://careers.mongodb.com/jobs/123/apply", detectedAts: null },
      { tab: { id: 11, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    );

    // setPanelBehavior is only ever wired to onInstalled (never invoked by our
    // fake onInstalled listener), and nothing else in the handoff path calls
    // chrome.sidePanel — the side panel is a purely optional viewer.
    expect(fakeChrome.sidePanel.setPanelBehavior).not.toHaveBeenCalled();
  });
});

describe("Stage 3C-4 workflow generation isolation", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("3 · a new request for the same application gets a new tab and a fresh view", async () => {
    installFakeFetch();
    const runtime = installFakeChrome();
    runtime.fakeChrome.tabs.get.mockResolvedValue({ id: 81, windowId: 1 } as chrome.tabs.Tab);
    const state = await import("../state");
    const old = seedHandoff({ requestId: "old-run", targetTabId: 81 });
    await state.putPending(81, old);
    await state.putView(81, {
      ...state.initialView(81, old, "MongoDB", "Engineer"),
      state: "completed", fieldsDiscovered: 9, filled: 6, resumeStatus: "uploaded"
    });
    await import("../background");

    const response = await dispatch(runtime.messageListeners, {
      type: "JOBPILOT_LAUNCH_REQUEST",
      payload: {
        requestId: "new-run", launchToken: "new-token", sessionId: 55, jobId: 1,
        officialUrl: old.officialUrl, atsType: null
      }
    }, { tab: { id: 1, windowId: 1 }, origin: "http://localhost:3000" }) as { tabId: number };

    expect(response.tabId).toBe(1000);
    expect(runtime.tabsCreated).toHaveLength(1);
    expect(await state.getView(1000)).toMatchObject({
      requestId: "new-run", state: "waiting_for_tab", fieldsDiscovered: 0,
      filled: 0, resumeStatus: "pending", failureCode: null
    });
  });

  it("9 · an old tab update cannot replace the active new workflow generation", async () => {
    installFakeChrome();
    const state = await import("../state");
    const old = seedHandoff({ requestId: "old-run", targetTabId: 81, createdAt: 1 });
    const current = seedHandoff({ requestId: "new-run", targetTabId: 82, createdAt: 2 });
    await state.putPending(81, old);
    await state.putActive(current);
    await state.updatePending(81, { state: "completed", status: "ready" });

    expect(await state.getActive()).toMatchObject({ requestId: "new-run", targetTabId: 82 });
    expect(await state.getPending(81)).toMatchObject({ requestId: "old-run", state: "completed" });
  });

  it("runtime view/tab state is absent after a browser-session storage reset", async () => {
    const localStore: Record<string, unknown> = {
      pendingLaunches: { "81": seedHandoff({ requestId: "old-run", targetTabId: 81 }) },
      viewStates: { "81": { state: "completed", fieldsDiscovered: 9, filled: 6 } },
      activeAssistedApplyHandoffV1: seedHandoff({ requestId: "old-run", targetTabId: 81 })
    };
    const sessionStore: Record<string, unknown> = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: localStore[key] }),
          set: async (value: Record<string, unknown>) => Object.assign(localStore, value),
          remove: async (key: string) => { delete localStore[key]; }
        },
        session: {
          get: async (key: string) => ({ [key]: sessionStore[key] }),
          set: async (value: Record<string, unknown>) => Object.assign(sessionStore, value),
          remove: async (key: string) => { delete sessionStore[key]; }
        }
      }
    };
    const state = await import("../state");
    expect(await state.getPending(81)).toBeNull();
    expect(await state.getView(81)).toBeNull();
    expect(await state.getActive()).toBeNull();
  });
});

describe("view-state failure guard (multi-frame forms)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("does not regress an already-completed tab when a sibling frame reports FORM_NOT_RENDERED", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    // Bind the tab and let one frame report a completed run.
    await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: "https://careers.mongodb.com/jobs/123/apply", detectedAts: null },
      { tab: { id: 21, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    );
    await dispatch(
      messageListeners,
      {
        type: "JOBPILOT_AUTOFILL_PROGRESS",
        payload: {
          state: "completed", atsId: "generic", atsDisplayName: "Generic form", limited: false,
          fieldsDiscovered: 5, filled: 5, skipped: 0, reviewRequired: 0, reachedFinalStep: true,
          documentsUploaded: [], reviewDocuments: []
        }
      },
      { tab: { id: 21 }, frameId: 0 }
    );
    expect((await state.getView(21))?.state).toBe("completed");

    // A sibling iframe with no fields of its own times out and reports
    // FORM_NOT_RENDERED — this must NOT flip the tab back to "failed".
    await dispatch(
      messageListeners,
      { type: "JOBPILOT_AUTOFILL_FAILED", reasonCode: "FORM_NOT_RENDERED", message: "No application form rendered within 30 seconds" },
      { tab: { id: 21 }, frameId: 4 }
    );

    expect((await state.getView(21))?.state).toBe("completed");
  });
});

describe("handshake + stale-handoff regressions", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("returns HANDOFF_NOT_FOUND (not a generic dormant no-op) when no handoff has ever been staged", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome();
    await import("../background");

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: null, detectedAts: null },
      { tab: { id: 1, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    )) as { matched: boolean; error?: string };
    expect(resp.matched).toBe(false);
    expect(resp.error).toBe("HANDOFF_NOT_FOUND");
  });

  it("returns HANDOFF_EXPIRED (not HANDOFF_NOT_FOUND) when the active handoff's TTL has passed", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    // Import (and its startup cleanup sweep) BEFORE seeding the expired
    // handoff, so this test exercises handleContentReady's own expiry check
    // rather than racing the module's fire-and-forget startup cleanup.
    await import("../background");
    await state.putActive(seedHandoff({ expiresAt: Date.now() - 1000 }));

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: null, detectedAts: null },
      { tab: { id: 2, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    )) as { matched: boolean; error?: string };
    expect(resp.matched).toBe(false);
    expect(resp.error).toBe("HANDOFF_EXPIRED");
  });

  // Regression for the exact reported bug: a PREVIOUS Temporal (Ashby)
  // handoff must never attach to a NEW, unrelated Ashby job just because
  // both are on jobs.ashbyhq.com.
  it("does not attach a stale handoff to a different job on the same ATS family host", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff({
      applicationUrl: "https://jobs.ashbyhq.com/temporal/2a3526f9",
      officialUrl: "https://jobs.ashbyhq.com/temporal/2a3526f9"
    }));
    await import("../background");

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://jobs.ashbyhq.com/acme-corp/9f81c3e2", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: null, detectedAts: null },
      { tab: { id: 3, url: "https://jobs.ashbyhq.com/acme-corp/9f81c3e2" }, frameId: 0, url: "https://jobs.ashbyhq.com/acme-corp/9f81c3e2" }
    )) as { matched: boolean; error?: string };
    expect(resp.matched).toBe(false);
    expect(resp.error).toBe("HANDOFF_URL_MISMATCH");
  });

  it("classifies a 401 session-package failure as SESSION_UNAUTHORIZED, not a generic failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: null, detectedAts: null },
      { tab: { id: 4, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    )) as { matched: boolean; error?: string };
    expect(resp.matched).toBe(true);
    expect(resp.error).toBe("SESSION_UNAUTHORIZED");

    const view = await state.getView(4);
    expect(view?.failureCode).toBe("SESSION_UNAUTHORIZED");
    expect(view?.failureRecoverable).toBe(false); // Retry would just repeat the same 401.
  });

  it("classifies a 404 session-package failure as SESSION_NOT_FOUND", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/123/apply", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: null, detectedAts: null },
      { tab: { id: 5, url: "https://careers.mongodb.com/jobs/123/apply" }, frameId: 0, url: "https://careers.mongodb.com/jobs/123/apply" }
    )) as { matched: boolean; error?: string };
    expect(resp.error).toBe("SESSION_NOT_FOUND");
  });

  it("a malformed/old-schema stored handoff is treated as absent, not a crash", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome({
      // Simulates a handoff written by an older extension build missing
      // fields the current code assumes are always present.
      activeAssistedApplyHandoffV1: { applicationId: "1", officialUrl: "https://careers.mongodb.com/jobs/1" }
    });
    await import("../background");

    const resp = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_CONTENT_READY", url: "https://careers.mongodb.com/jobs/1", title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: null, detectedAts: null },
      { tab: { id: 6, url: "https://careers.mongodb.com/jobs/1" }, frameId: 0, url: "https://careers.mongodb.com/jobs/1" }
    )) as { matched: boolean; error?: string };
    expect(resp.matched).toBe(false);
    expect(resp.error).toBe("HANDOFF_NOT_FOUND");
  });

  it("on install/update, re-injects the bridge into already-open XpertApply tabs but never an ATS/employer tab", async () => {
    installFakeFetch();
    const openTabs = [
      { id: 501, url: "https://www.xpertapply.com/jobs" } as chrome.tabs.Tab,
      { id: 502, url: "https://careers.mongodb.com/jobs/123/apply" } as chrome.tabs.Tab
    ];
    const { installedListeners, executedScripts } = installFakeChrome(undefined, openTabs);
    await import("../background");

    expect(installedListeners.length).toBeGreaterThan(0);
    for (const fn of installedListeners) fn();
    // Flush the async revival work queued by the onInstalled listener.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(executedScripts.some((s) => s.tabId === 501)).toBe(true);
    expect(executedScripts.some((s) => s.tabId === 502)).toBe(false);
  });

  it("revives an already-open XpertApply tab when the extension runtime resets even without onInstalled", async () => {
    installFakeFetch();
    const openTabs = [
      { id: 601, url: "https://xpertapply.com/jobs" } as chrome.tabs.Tab
    ];
    const { executedScripts } = installFakeChrome(undefined, openTabs);

    // Importing the service worker models Developer Mode -> Reload. We do not
    // invoke the registered onInstalled callbacks in this regression test.
    await import("../background");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(executedScripts.some((s) => s.tabId === 601)).toBe(true);
  });
});

describe("application-start launch handoff", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("persists PENDING_NAVIGATION before a script-driven CTA is clicked", async () => {
    installFakeFetch();
    const { messageListeners, store } = installFakeChrome();
    const state = await import("../state");
    await state.putPending(71, seedHandoff());
    await state.putPackage(71, {
      sessionToken: "session-token", cachedAt: Date.now(),
      session: { sessionId: 55, atsType: null, officialUrl: "https://careers.mongodb.com/jobs/123", jobTitle: "Engineer", company: "MongoDB", answers: [], unresolvedQuestions: [] }
    });
    await import("../background");

    const response = await dispatch(messageListeners, {
      type: "JOBPILOT_PREPARE_APPLICATION_LAUNCH",
      sessionId: 55,
      sourceUrl: "https://careers.mongodb.com/jobs/123?tracking=secret",
      normalizedCtaText: "i'm interested",
      confidence: 84,
      href: null,
      target: "_blank",
      expectedDestinationOrigin: null,
      jobFingerprint: "job-fingerprint"
    }, { tab: { id: 71, url: "https://careers.mongodb.com/jobs/123" }, frameId: 0 }) as { ok: boolean; launchId: string };

    expect(response.ok).toBe(true);
    expect(response.launchId).toContain("55-");
    expect(store.pendingApplyActivationV1).toMatchObject({
      launchId: response.launchId,
      applicationId: "55",
      sourceTabId: 71,
      sessionId: 55,
      sourceUrl: "https://careers.mongodb.com/jobs/123",
      jobFingerprint: "job-fingerprint",
      state: "PENDING_NAVIGATION",
      normalizedCtaText: "i'm interested",
      confidence: 84
    });
  });

  it("carries the existing package into a new external ATS tab", async () => {
    installFakeFetch();
    const { messageListeners, tabsCreated } = installFakeChrome();
    const state = await import("../state");
    await state.putPending(72, seedHandoff());
    await state.putPackage(72, {
      sessionToken: "session-token", cachedAt: Date.now(),
      session: { sessionId: 55, atsType: null, officialUrl: "https://careers.mongodb.com/jobs/123", jobTitle: "Engineer", company: "MongoDB", answers: [], unresolvedQuestions: [] }
    });
    await import("../background");

    await dispatch(messageListeners, {
      type: "JOBPILOT_PREPARE_APPLICATION_LAUNCH", sessionId: 55,
      sourceUrl: "https://careers.mongodb.com/jobs/123", normalizedCtaText: "i'm interested", confidence: 84,
      href: "https://acme.wd5.myworkdayjobs.com/job/123/apply", target: "_blank",
      expectedDestinationOrigin: "https://acme.wd5.myworkdayjobs.com", jobFingerprint: "job-fingerprint"
    }, { tab: { id: 72 }, frameId: 0 });
    const response = await dispatch(messageListeners, {
      type: "JOBPILOT_ACTIVATE_APPLICATION_DESTINATION", sessionId: 55,
      url: "https://acme.wd5.myworkdayjobs.com/job/123/apply", newTab: true, source: "anchor_href"
    }, { tab: { id: 72 }, frameId: 0 }) as { ok: boolean; tabId: number };

    expect(response.ok).toBe(true);
    expect(tabsCreated[0]?.url).toContain("myworkdayjobs.com/job/123/apply");
    expect((await state.getPending(response.tabId))?.applicationUrl).toContain("myworkdayjobs.com/job/123/apply");
    expect((await state.getPackage(response.tabId))?.sessionToken).toBe("session-token");
  });

  it("rebinds an approved external ATS content script without re-exchanging the token", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putPending(73, seedHandoff({
      targetTabId: 73,
      applicationUrl: "https://acme.wd5.myworkdayjobs.com/job/123/apply",
      expectedOrigin: "https://acme.wd5.myworkdayjobs.com"
    }));
    await state.putPackage(73, {
      sessionToken: "session-token", cachedAt: Date.now(),
      session: { sessionId: 55, atsType: null, officialUrl: "https://careers.mongodb.com/jobs/123", jobTitle: "Engineer", company: "MongoDB", answers: [], unresolvedQuestions: [] }
    });
    await import("../background");
    const response = await dispatch(messageListeners, {
      type: "JOBPILOT_CONTENT_READY", url: "https://acme.wd5.myworkdayjobs.com/job/123/apply",
      title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: "https://acme.wd5.myworkdayjobs.com/job/123/apply", detectedAts: "workday"
    }, { tab: { id: 73, url: "https://acme.wd5.myworkdayjobs.com/job/123/apply" }, frameId: 0, url: "https://acme.wd5.myworkdayjobs.com/job/123/apply" }) as { ok: boolean; matched: boolean };
    expect(response).toMatchObject({ ok: true, matched: true });
    expect((await state.getPackage(73))?.sessionToken).toBe("session-token");
  });
});
