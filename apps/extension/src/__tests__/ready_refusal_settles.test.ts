/**
 * (EXT-E2C copy of the handoff harness.) Background gating tests for the broad-host-permissions model: the ATS
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
                applicationLabelsFound: (globalThis as typeof globalThis & { __testProbeLabels?: string[] })
                  .__testProbeLabels ?? ["first_name", "last_name", "email", "resume"],
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


const URL_ = "https://careers.mongodb.com/jobs/123/apply";
const READY = { type: "JOBPILOT_CONTENT_READY", url: URL_, title: "Apply", protocolVersion: 3, isTopFrame: true, topUrl: URL_, detectedAts: null };
const SENDER = (tabId: number) => ({ tab: { id: tabId, url: URL_ }, frameId: 0, url: URL_ });
const probes = (sent: Array<{ message: unknown }>) => sent.filter(({ message }) => (message as { type?: string }).type === "JOBPILOT_PROBE_FRAME_APPLICATION").length;

/**
 * EXT-E2C: the three answers handleContentReady gave a page without recording why (DOCUMENT_ID_UNAVAILABLE, HOST_PERMISSION_MISSING,
 * STALE_AUTHORITY on expiry) left the tab's view on its initial "detecting" state. Each now ends it in a stated state, only for the
 * session that still owns the tab, and a later retry that succeeds supersedes the stated refusal.
 */
describe("a refusal answered to the page is also a terminal state of the view", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("grant withdrawn: the view says access was removed with the button that asks again, and a retry supersedes it", async () => {
    installFakeFetch();
    const { fakeChrome, messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    const first = (await dispatch(messageListeners, READY, SENDER(60))) as { matched: boolean };
    expect(first.matched).toBe(true);
    expect((await state.getView(60))?.siteAccess).not.toBe("site_access_revoked");

    fakeChrome.permissions.contains.mockResolvedValue(false);
    const refused = (await dispatch(messageListeners, READY, SENDER(60))) as { matched: boolean; error?: string };
    expect(refused).toMatchObject({ matched: false, error: "HOST_PERMISSION_MISSING" });
    await vi.waitFor(async () => {
      const view = await state.getView(60);
      expect(view?.siteAccess).toBe("site_access_revoked");
      expect(view?.siteAccessPattern).toBe("https://careers.mongodb.com/*");
      expect(view?.running).toBe(false);
    });

    fakeChrome.permissions.contains.mockResolvedValue(true);
    const again = (await dispatch(messageListeners, READY, SENDER(60))) as { matched: boolean };
    expect(again.matched).toBe(true);
    await vi.waitFor(async () => expect((await state.getView(60))?.siteAccess).toBe("site_access_granted"));
  });

  it("a page whose document Chrome cannot identify ends in a stated failure, and a retry clears it", async () => {
    installFakeFetch();
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");

    let reply: { error?: string } | undefined;
    for (const listener of messageListeners) {
      listener(READY, { tab: { id: 61, url: URL_ }, frameId: 0, url: URL_ }, (r) => { reply = r as { error?: string }; });
    }
    await vi.waitFor(() => expect(reply?.error).toBe("DOCUMENT_ID_UNAVAILABLE"));
    await vi.waitFor(async () => {
      const view = await state.getView(61);
      expect(view?.failureCode).toBe("DOCUMENT_ID_UNAVAILABLE");
      expect(view?.state).toBe("failed");
      expect(view?.failureRecoverable).toBe(true);
    });

    const ok = (await dispatch(messageListeners, READY, SENDER(61))) as { matched: boolean };
    expect(ok.matched).toBe(true);
    await vi.waitFor(async () => {
      const view = await state.getView(61);
      expect(view?.failureCode).toBeNull();
      expect(view?.packageLoaded).toBe(true);
    });
  });

  it("a launch that expires while the page is probed ends in a stated expiry for its own session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    installFakeFetch();
    const { fakeChrome, messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff({ expiresAt: Date.now() + 5_000 }));
    await import("../background");
    const original = fakeChrome.tabs.sendMessage.getMockImplementation()!;
    fakeChrome.tabs.sendMessage.mockImplementation((...args: Parameters<typeof original>) => {
      if ((args[1] as { type?: string }).type === "JOBPILOT_PROBE_FRAME_APPLICATION") vi.setSystemTime(Date.now() + 10_000);
      return original(...args);
    });
    const resp = (await dispatch(messageListeners, READY, SENDER(62))) as { error?: string };
    expect(resp.error).toBe("STALE_AUTHORITY");
    await vi.waitFor(async () => {
      const view = await state.getView(62);
      expect(view?.failureCode).toBe("HANDOFF_EXPIRED");
      expect(view?.state).toBe("failed");
    });
  });

  it("a refusal never writes over a newer workflow that took the tab while the page was being checked", async () => {
    installFakeFetch();
    const { fakeChrome, messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");
    await dispatch(messageListeners, READY, SENDER(63));
    const before = await state.getView(63);
    // First grant check passes; by the second the tab belongs to a different session, and the grant is gone.
    let calls = 0;
    fakeChrome.permissions.contains.mockImplementation(async () => {
      calls += 1;
      if (calls < 2) return true;
      await state.putPending(63, seedHandoff({ sessionId: 99, requestId: "req-2", targetTabId: 63 }), state.captureAuthorityGeneration());
      return false;
    });
    const refused = (await dispatch(messageListeners, READY, SENDER(63))) as { error?: string };
    expect(refused.error).toBe("HOST_PERMISSION_MISSING");
    await new Promise((r) => setTimeout(r, 80));
    const after = await state.getView(63);
    expect(after?.siteAccess).toBe(before?.siteAccess);
    expect(after?.siteAccess).not.toBe("site_access_revoked");
  });

  it("no retry is needed to stay terminal: nothing is probed, filled or submitted by a refusal", async () => {
    installFakeFetch();
    const { fakeChrome, messageListeners, sentToTabs } = installFakeChrome();
    fakeChrome.permissions.contains.mockResolvedValue(false);
    const state = await import("../state");
    await state.putActive(seedHandoff());
    await import("../background");
    await dispatch(messageListeners, READY, SENDER(64));
    expect(probes(sentToTabs)).toBe(0);
    expect(sentToTabs.some(({ message }) => /AUTOFILL|FILL/.test(String((message as { type?: string }).type)))).toBe(false);
  });
});

/**
 * EXT-E2C: what the E2B repair did and did not change. The remembered website record (account and deployment of the LAST website
 * launch) is consulted ONLY by the runtime handshake. For a direct draft it is no longer offered; every other guard is untouched.
 */
describe("the remembered website record: direct drafts versus website launches", () => {
  const RECORD = { webEnvironment: "staging", webApiBase: "https://api-staging.xpertapply.com", webAuthenticatedUserId: 9 };
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function identity(tabId: number, pending: PendingLaunch | null) {
    installFakeFetch();
    const { messageListeners, store } = installFakeChrome({ jobpilotWebRuntimeV2: RECORD });
    const state = await import("../state");
    if (pending) await state.putPending(tabId, pending, state.captureAuthorityGeneration());
    await import("../background");
    void store;
    return (await dispatch(messageListeners, { type: "JOBPILOT_RUNTIME_IDENTITY" }, SENDER(tabId))) as Record<string, unknown>;
  }

  it("a website launch still carries the record, so a different account or deployment is still refused", async () => {
    const resp = await identity(70, seedHandoff({ targetTabId: 70 }));
    expect(resp).toMatchObject({ ok: true, webEnvironment: "staging", webAuthenticatedUserId: 9, webApiBase: "https://api-staging.xpertapply.com" });
  });

  it("an unbound page is answered exactly as before", async () => {
    const resp = await identity(71, null);
    expect(resp).toMatchObject({ webEnvironment: "staging", webAuthenticatedUserId: 9 });
  });

  it("a direct draft is not offered the record", async () => {
    const { buildDirectPending } = await import("../direct/directApplication");
    const direct = buildDirectPending({ tabId: 72, sessionId: 7000, userId: 7, url: new URL(URL_), atsType: null, now: Date.now(), ttlMs: 60_000, requestId: "direct-x", protocolVersion: 3 });
    const resp = await identity(72, direct);
    expect(resp).toMatchObject({ ok: true, webEnvironment: null, webApiBase: null, webAuthenticatedUserId: null });
  });

  it("the record is not offered to a DIFFERENT tab because another tab holds a direct draft", async () => {
    const { buildDirectPending } = await import("../direct/directApplication");
    const direct = buildDirectPending({ tabId: 73, sessionId: 7000, userId: 7, url: new URL(URL_), atsType: null, now: Date.now(), ttlMs: 60_000, requestId: "direct-x", protocolVersion: 3 });
    installFakeFetch();
    const { messageListeners } = installFakeChrome({ jobpilotWebRuntimeV2: RECORD });
    const state = await import("../state");
    await state.putPending(73, direct, state.captureAuthorityGeneration());
    await state.putPending(74, seedHandoff({ targetTabId: 74 }), state.captureAuthorityGeneration());
    await import("../background");
    expect(await dispatch(messageListeners, { type: "JOBPILOT_RUNTIME_IDENTITY" }, SENDER(74))).toMatchObject({ webAuthenticatedUserId: 9 });
    expect(await dispatch(messageListeners, { type: "JOBPILOT_RUNTIME_IDENTITY" }, SENDER(73))).toMatchObject({ webAuthenticatedUserId: null });
  });
});

describe("the handshake still refuses a direct draft's incoherent runtime", async () => {
  const { evaluateHandshake } = await import("../runtimeIdentity");
  const self = { buildId: "b1", version: "0.3.0", environment: "staging" as const, apiBase: "https://api-staging.xpertapply.com" };
  const direct = { webEnvironment: null, webApiBase: null, webAuthenticatedUserId: null, extensionAuthenticatedUserId: 7 };

  it("passes when the parts agree", () => {
    expect(evaluateHandshake({ contentScript: self, serviceWorker: self, widget: self, sidePanel: null, ...direct }).ok).toBe(true);
  });
  it("refuses a worker from another build", () => {
    expect(evaluateHandshake({ contentScript: self, serviceWorker: { ...self, buildId: "b2" }, widget: self, sidePanel: null, ...direct }).reason).toBe("build_mismatch");
  });
  it("refuses a worker on another environment (staging versus production mixing)", () => {
    const prod = { ...self, environment: "production" as const, apiBase: "https://api.xpertapply.com" };
    expect(evaluateHandshake({ contentScript: self, serviceWorker: prod, widget: self, sidePanel: null, ...direct }).reason).toBe("environment_mismatch");
  });
  it("refuses a worker that did not answer", () => {
    expect(evaluateHandshake({ contentScript: self, serviceWorker: null, widget: self, sidePanel: null, ...direct }).reason).toBe("worker_unreachable");
  });
});
