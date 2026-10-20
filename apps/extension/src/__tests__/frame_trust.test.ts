/**
 * Trust-boundary regression tests for the service worker's message gate.
 *
 * The defect these lock down: binding was per TAB, so once any frame matched an
 * active handoff the worker handed the FULL session package — the user's
 * verified profile answers, and by extension the résumé the frame then fetches
 * — to every other frame in that tab. A third-party iframe on an employer page
 * (ad slot, analytics, chat widget) therefore received the candidate's identity
 * and documents with no user interaction. Two things made it possible: nested
 * frames skipped URL validation entirely, and the "am I the top frame?" claim
 * came out of the message body rather than from Chrome.
 *
 * Half of these drive the REAL `chrome.runtime.onMessage` listener that
 * background.ts registers, against a fake chrome + fetch, so they prove the
 * shipped gate rather than a re-implementation of it. The rest exercise the
 * authorization predicate directly, where every branch is cheap to reach.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeFrameForLaunch,
  describeSender,
  originJoinsWorkflow,
  registrableDomain,
  senderCanBindTab
} from "../security/senderTrust";
import { parseRuntimeMessage } from "../messages";
import type { PendingLaunch } from "../messages";

// --------------------------------------------------------------------------- //
// Fixtures
// --------------------------------------------------------------------------- //

const APPLICATION_URL = "https://careers.mongodb.com/jobs/123/apply";

function launch(overrides: Partial<PendingLaunch> = {}): PendingLaunch {
  return {
    version: 1,
    applicationId: "55",
    jobId: "1",
    applicationUrl: APPLICATION_URL,
    status: "prepared",
    handoffToken: "launch-tok",
    requestId: "req-1",
    sessionId: 55,
    launchToken: "launch-tok",
    officialUrl: APPLICATION_URL,
    expectedOrigin: "https://careers.mongodb.com",
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
    state: "package_ready",
    protocolVersion: 3,
    atsType: null,
    ...overrides
  };
}

/** A `MessageSender` exactly as Chrome populates it for a content script. */
function sender(opts: { tabId?: number; frameId: number; url?: string; tabUrl?: string; origin?: string }) {
  return {
    tab: { id: opts.tabId ?? 7, url: opts.tabUrl ?? APPLICATION_URL },
    frameId: opts.frameId,
    url: opts.url,
    origin: opts.origin
  } as unknown as chrome.runtime.MessageSender;
}

function context(opts: Parameters<typeof sender>[0]) {
  return describeSender(sender(opts));
}

// --------------------------------------------------------------------------- //
// The authorization predicate
// --------------------------------------------------------------------------- //

describe("frame authorization — the top frame", () => {
  it("accepts the top frame when its own URL matches the handoff", () => {
    const result = authorizeFrameForLaunch(context({ frameId: 0, url: APPLICATION_URL }), launch());
    expect(result).toEqual({ ok: true, isTopFrame: true });
  });

  it("refuses the top frame once the tab has navigated somewhere unrelated", () => {
    const result = authorizeFrameForLaunch(
      context({ frameId: 0, url: "https://evil.example.com/phish", tabUrl: "https://evil.example.com/phish" }),
      launch()
    );
    expect(result).toEqual({ ok: false, reason: "HANDOFF_URL_MISMATCH" });
  });

  it("identifies the top frame by Chrome's frameId, not by what the message claimed", () => {
    // frameId 0 IS the top frame. A caller that says otherwise in the payload
    // cannot reach the (previously unvalidated) nested-frame path, because the
    // payload is not an input to this function at all.
    const asTopFrame = authorizeFrameForLaunch(
      context({ frameId: 0, url: "https://ads.doubleclick.net/widget" }),
      launch()
    );
    expect(asTopFrame).toEqual({ ok: false, reason: "HANDOFF_URL_MISMATCH" });
  });
});

describe("frame authorization — nested frames", () => {
  it("accepts an embedded ATS widget on an allow-listed host", () => {
    const result = authorizeFrameForLaunch(
      context({ frameId: 3, url: "https://boards.greenhouse.io/embed/mongodb/1" }),
      launch()
    );
    expect(result).toEqual({ ok: true, isTopFrame: false });
  });

  it("accepts a nested frame on the employer's own registrable domain", () => {
    const result = authorizeFrameForLaunch(
      context({ frameId: 4, url: "https://apply.mongodb.com/form" }),
      launch()
    );
    expect(result).toEqual({ ok: true, isTopFrame: false });
  });

  it("refuses an unrelated third-party frame, whatever its document contains", () => {
    for (const url of [
      "https://ads.doubleclick.net/apply",
      "https://widget.intercom.io/frame",
      "https://cdn.some-vendor.example/embed.html",
      "https://analytics.example.net/collect"
    ]) {
      expect(authorizeFrameForLaunch(context({ frameId: 5, url }), launch())).toEqual({
        ok: false,
        reason: "FRAME_ORIGIN_NOT_IN_WORKFLOW"
      });
    }
  });

  it("refuses a suffix-confusion host that only looks like an allow-listed ATS", () => {
    for (const url of [
      "https://greenhouse.io.evil.test/embed",
      "https://notgreenhouse.io/embed",
      "https://mongodb.com.evil.test/apply"
    ]) {
      expect(authorizeFrameForLaunch(context({ frameId: 6, url }), launch())).toEqual({
        ok: false,
        reason: "FRAME_ORIGIN_NOT_IN_WORKFLOW"
      });
    }
  });

  it("refuses a frame whose origin cannot be resolved (sandboxed / opaque)", () => {
    const result = authorizeFrameForLaunch(
      context({ frameId: 7, url: "about:srcdoc", origin: "null" }),
      launch()
    );
    expect(result).toEqual({ ok: false, reason: "FRAME_ORIGIN_UNRESOLVABLE" });
  });

  it("falls back to the inherited origin for an about:srcdoc frame that has one", () => {
    // match_origin_as_fallback injects into srcdoc frames; those inherit the
    // parent's origin, which is the honest answer for authorization.
    const result = authorizeFrameForLaunch(
      context({ frameId: 8, url: "about:srcdoc", origin: "https://careers.mongodb.com" }),
      launch()
    );
    expect(result).toEqual({ ok: true, isTopFrame: false });
  });

  it("refuses an in-workflow frame once the TAB itself has left the workflow", () => {
    // A page that has navigated somewhere unrelated must not be able to
    // re-qualify its children by embedding an ATS-shaped frame.
    const result = authorizeFrameForLaunch(
      context({
        frameId: 9,
        url: "https://boards.greenhouse.io/embed/mongodb/1",
        tabUrl: "https://evil.example.com/harvest"
      }),
      launch()
    );
    expect(result).toEqual({ ok: false, reason: "TAB_LEFT_WORKFLOW" });
  });

  it("refuses when there is no sender tab at all", () => {
    expect(authorizeFrameForLaunch(null, launch())).toEqual({ ok: false, reason: "NO_SENDER_TAB" });
  });

  it("treats a missing frameId as a nested frame rather than as top-frame authority", () => {
    const ctx = describeSender({
      tab: { id: 7, url: APPLICATION_URL },
      url: APPLICATION_URL
    } as unknown as chrome.runtime.MessageSender);
    expect(ctx?.isTopFrame).toBe(false);
  });
});

describe("tab binding is weaker than frame authorization", () => {
  it("lets a nested frame bind the tab using the tab's own URL", () => {
    expect(
      senderCanBindTab(context({ frameId: 3, url: "https://boards.greenhouse.io/e/1" }), launch())
    ).toBe(true);
  });

  it("does not let binding alone authorize a third-party frame", () => {
    const third = context({ frameId: 3, url: "https://ads.doubleclick.net/apply" });
    // It can bind — the TAB really is the application tab …
    expect(senderCanBindTab(third, launch())).toBe(true);
    // … and it still receives nothing.
    expect(authorizeFrameForLaunch(third, launch())).toEqual({
      ok: false,
      reason: "FRAME_ORIGIN_NOT_IN_WORKFLOW"
    });
  });
});

describe("workflow origin graph", () => {
  it("matches on the registrable domain, not on substrings", () => {
    expect(registrableDomain("boards.greenhouse.io")).toBe("greenhouse.io");
    expect(registrableDomain("careers.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomain("acme.com")).toBe("acme.com");
  });

  it("accepts the same employer across subdomains and allow-listed ATS hosts", () => {
    expect(originJoinsWorkflow(APPLICATION_URL, new URL("https://login.mongodb.com/"))).toBe(true);
    expect(originJoinsWorkflow(APPLICATION_URL, new URL("https://jobs.lever.co/acme/1"))).toBe(true);
  });

  it("rejects an unparseable workflow URL rather than defaulting to allow", () => {
    expect(originJoinsWorkflow("not-a-url", new URL("https://careers.mongodb.com/"))).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// The real message listener
// --------------------------------------------------------------------------- //

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void;

function installFakeChrome() {
  const store: Record<string, unknown> = {};
  const messageListeners: Listener[] = [];
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
        set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
        remove: async (key: string) => { delete store[key]; }
      }
    },
    tabs: {
      onRemoved: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
      onCreated: { addListener: () => undefined },
      create: vi.fn(async () => ({ id: 900 })),
      get: vi.fn(async () => { throw new Error("no such tab"); }),
      update: vi.fn(async () => ({})),
      query: vi.fn(async () => []),
      sendMessage: vi.fn((_tabId: number, _message: unknown, cb?: (r: unknown) => void) => cb?.(undefined))
    },
    windows: { update: vi.fn(async () => ({})) },
    scripting: { executeScript: vi.fn(async () => undefined) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;
  return { messageListeners, store };
}

/** The profile marker a leak would carry. Synthetic; never a real person. */
const PROFILE_MARKER = "audit-profile-marker@example.test";

function installFakeFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/application-sessions/token")) {
      return new Response(JSON.stringify({ session_token: "sess-tok-abc" }), { status: 200 });
    }
    if (/\/application-sessions\/\d+\/answers$/.test(url)) {
      return new Response(JSON.stringify({
        answers: [{
          canonical_key: "email", value: PROFILE_MARKER, display_value: PROFILE_MARKER,
          source: "explicit_user_answer", confidence: 1, sensitive: false,
          requires_review: false, verified: true
        }],
        unresolved_questions: []
      }), { status: 200 });
    }
    if (/\/application-sessions\/\d+$/.test(url)) {
      return new Response(JSON.stringify({
        session_id: 55,
        ats_type: null,
        official_application_url: APPLICATION_URL,
        job: { title: "Software Engineer", company: "MongoDB" },
        profile: { email: PROFILE_MARKER }
      }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }));
}

function dispatch(listeners: Listener[], raw: unknown, from: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let responded = false;
    for (const fn of listeners) {
      const keepAlive = fn(raw, from, (resp) => {
        if (!responded) { responded = true; resolve(resp); }
      });
      if (!keepAlive && !responded) continue;
    }
  });
}

function contentReady(extra: Record<string, unknown> = {}) {
  return {
    type: "JOBPILOT_CONTENT_READY",
    url: APPLICATION_URL,
    title: "Apply",
    protocolVersion: 3,
    isTopFrame: true,
    topUrl: APPLICATION_URL,
    detectedAts: null,
    ...extra
  };
}

type ReadyResponse = {
  ok: boolean;
  matched: boolean;
  error?: string;
  launch?: unknown;
  session?: { profileData?: Record<string, unknown>; answers?: unknown[] } | null;
};

/** Bind the tab with a legitimate top-frame handshake and return the listeners. */
async function bindTab() {
  installFakeFetch();
  const { messageListeners, store } = installFakeChrome();
  const state = await import("../state");
  await state.putActive(launch());
  await import("../background");
  const top = (await dispatch(
    messageListeners,
    contentReady(),
    sender({ frameId: 0, url: APPLICATION_URL })
  )) as ReadyResponse;
  expect(top.matched).toBe(true);
  expect(top.session).toBeTruthy();
  return { messageListeners, store };
}

describe("the shipped message listener", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("gives a third-party iframe in a bound tab no launch and no session", async () => {
    const { messageListeners } = await bindTab();

    const third = (await dispatch(
      messageListeners,
      contentReady({ isTopFrame: false, url: "https://ads.doubleclick.net/apply", topUrl: null }),
      sender({ frameId: 12, url: "https://ads.doubleclick.net/apply" })
    )) as ReadyResponse;

    expect(third.matched).toBe(false);
    expect(third.error).toBe("FRAME_ORIGIN_NOT_IN_WORKFLOW");
    expect(third.session ?? null).toBeNull();
    expect(third.launch ?? null).toBeNull();
    expect(JSON.stringify(third)).not.toContain(PROFILE_MARKER);
  });

  it("still gives an embedded ATS iframe the session it needs to fill", async () => {
    const { messageListeners } = await bindTab();

    const ats = (await dispatch(
      messageListeners,
      contentReady({ isTopFrame: false, url: "https://boards.greenhouse.io/embed/mongodb/1", topUrl: null }),
      sender({ frameId: 13, url: "https://boards.greenhouse.io/embed/mongodb/1" })
    )) as ReadyResponse;

    expect(ats.matched).toBe(true);
    expect(ats.session?.profileData?.email).toBe(PROFILE_MARKER);
  });

  it("ignores a message-body claim of being a nested frame — Chrome's frameId decides", async () => {
    const { messageListeners } = await bindTab();

    // frameId 0 is the top frame. Saying `isTopFrame: false` in the payload
    // used to route a caller down the path that skipped URL validation.
    const spoofed = (await dispatch(
      messageListeners,
      contentReady({ isTopFrame: false, url: APPLICATION_URL }),
      sender({ frameId: 0, url: "https://ads.doubleclick.net/apply", tabUrl: "https://ads.doubleclick.net/apply" })
    )) as ReadyResponse;

    expect(spoofed.matched).toBe(true); // the tab is bound …
    expect(spoofed.error).toBe("HANDOFF_URL_MISMATCH"); // … and the frame is still refused
    expect(spoofed.session ?? null).toBeNull();
  });

  it("ignores a message-body URL that disagrees with the sender's real URL", async () => {
    const { messageListeners } = await bindTab();

    const spoofed = (await dispatch(
      messageListeners,
      // Body claims the application URL; Chrome says otherwise.
      contentReady({ isTopFrame: false, url: APPLICATION_URL, topUrl: null }),
      sender({ frameId: 14, url: "https://ads.doubleclick.net/apply" })
    )) as ReadyResponse;

    expect(spoofed.matched).toBe(false);
    expect(spoofed.session ?? null).toBeNull();
  });

  it("does not let a refused frame paint a failure over a healthy tab", async () => {
    const { messageListeners } = await bindTab();
    const state = await import("../state");
    const before = await state.getView(7);

    await dispatch(
      messageListeners,
      contentReady({ isTopFrame: false, url: "https://ads.doubleclick.net/apply", topUrl: null }),
      sender({ frameId: 15, url: "https://ads.doubleclick.net/apply" })
    );

    const after = await state.getView(7);
    expect(after?.failureCode ?? null).toBe(before?.failureCode ?? null);
    expect(after?.failureCode ?? null).toBeNull();
  });

  it("refuses the pull-based handshake for a third-party frame too", async () => {
    const { messageListeners } = await bindTab();

    const pulled = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_GET_PENDING_LAUNCH", url: "https://ads.doubleclick.net/apply" },
      sender({ frameId: 16, url: "https://ads.doubleclick.net/apply" })
    )) as ReadyResponse;

    expect(pulled.matched).toBe(false);
    expect(pulled.session ?? null).toBeNull();
    expect(JSON.stringify(pulled)).not.toContain(PROFILE_MARKER);
  });

  it("still answers the pull-based handshake for the bound top frame", async () => {
    const { messageListeners } = await bindTab();

    const pulled = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_GET_PENDING_LAUNCH", url: APPLICATION_URL },
      sender({ frameId: 0, url: APPLICATION_URL })
    )) as ReadyResponse;

    expect(pulled.matched).toBe(true);
    expect(pulled.session?.profileData?.email).toBe(PROFILE_MARKER);
  });

  it("refuses a sender with no tab (not a content script)", async () => {
    const { messageListeners } = await bindTab();

    const response = (await dispatch(
      messageListeners,
      contentReady(),
      { frameId: 0, url: APPLICATION_URL } // no `tab`
    )) as ReadyResponse;

    expect(response.matched).toBe(false);
    expect(response.error).toBe("NO_TAB");
    expect(response.session ?? null).toBeNull();
  });

  it("answers an extension-controlled message that has no sender tab", async () => {
    // The side panel is a trusted extension context and legitimately has no
    // `sender.tab`; the frame gate must not have broken it.
    const { messageListeners } = await bindTab();

    const view = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_GET_VIEW_STATE", tabId: 7 },
      {}
    )) as { ok: boolean; view?: { sessionId: number | null } | null };

    expect(view.ok).toBe(true);
    expect(view.view?.sessionId).toBe(55);
  });

  it("rejects an unknown message type", async () => {
    const { messageListeners } = await bindTab();
    const response = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_TOTALLY_MADE_UP", sessionId: 55 },
      sender({ frameId: 0, url: APPLICATION_URL })
    )) as { ok: boolean; error?: string };
    expect(response.ok).toBe(false);
    expect(response.error).toBe("UNKNOWN_MESSAGE");
  });

  it("rejects a known type whose payload is malformed, before any handler runs", async () => {
    const { messageListeners } = await bindTab();
    const response = (await dispatch(
      messageListeners,
      // `kind` is a closed vocabulary; "profile" is not in it.
      { type: "JOBPILOT_REQUEST_DOCUMENT", sessionId: 55, kind: "profile" },
      sender({ frameId: 0, url: APPLICATION_URL })
    )) as { ok: boolean; error?: string };
    expect(response.ok).toBe(false);
    expect(response.error).toBe("UNKNOWN_MESSAGE");
  });
});

// --------------------------------------------------------------------------- //
// Payload schema
// --------------------------------------------------------------------------- //

describe("runtime message payload validation", () => {
  it("accepts a well-formed message", () => {
    expect(parseRuntimeMessage({ type: "JOBPILOT_COMPLETE_SESSION", sessionId: 55 })).not.toBeNull();
  });

  it("rejects an unknown type", () => {
    expect(parseRuntimeMessage({ type: "JOBPILOT_NOPE" })).toBeNull();
    expect(parseRuntimeMessage(null)).toBeNull();
    expect(parseRuntimeMessage("JOBPILOT_COMPLETE_SESSION")).toBeNull();
  });

  it("rejects a missing addressing field", () => {
    expect(parseRuntimeMessage({ type: "JOBPILOT_COMPLETE_SESSION" })).toBeNull();
    expect(parseRuntimeMessage({ type: "JOBPILOT_SET_APPLICATION_OVERRIDE", sessionId: 55, value: true })).toBeNull();
    expect(parseRuntimeMessage({ type: "JOBPILOT_REQUEST_FRAME_PERMISSION" })).toBeNull();
  });

  it("rejects a field of the wrong type", () => {
    expect(parseRuntimeMessage({ type: "JOBPILOT_COMPLETE_SESSION", sessionId: "55" })).toBeNull();
    expect(parseRuntimeMessage({ type: "JOBPILOT_COMPLETE_SESSION", sessionId: 5.5 })).toBeNull();
    expect(parseRuntimeMessage({
      type: "JOBPILOT_SET_APPLICATION_OVERRIDE", sessionId: 55, canonicalKey: "work_authorization_us", value: "yes"
    })).toBeNull();
    expect(parseRuntimeMessage({ type: "JOBPILOT_RESOLVE_QUESTIONS", sessionId: 55, questions: "many" })).toBeNull();
  });

  it("rejects a value outside a closed vocabulary", () => {
    expect(parseRuntimeMessage({ type: "JOBPILOT_AUTOFILL_START", reason: "whenever" })).toBeNull();
    expect(parseRuntimeMessage({
      type: "JOBPILOT_SUBMISSION_CONFIRMED", sessionId: 55, evidenceType: "vibes",
      submissionTimestamp: "2026-08-22T00:00:00Z", submissionReference: null, ats: null
    })).toBeNull();
    expect(parseRuntimeMessage({
      type: "JOBPILOT_SAVE_ANSWER", sessionId: 55, canonicalKey: "k", value: "v", scope: "everything"
    })).toBeNull();
  });

  it("rejects oversized fields", () => {
    expect(parseRuntimeMessage({
      type: "JOBPILOT_ACTIVATE_APPLICATION_DESTINATION",
      sessionId: 55, url: `https://x.test/${"a".repeat(4000)}`, newTab: false, source: "cta"
    })).toBeNull();
    expect(parseRuntimeMessage({
      type: "JOBPILOT_RESOLVE_QUESTIONS", sessionId: 55, questions: new Array(500).fill({})
    })).toBeNull();
    expect(parseRuntimeMessage({
      type: "JOBPILOT_SAVE_ANSWER", sessionId: 55, canonicalKey: "k", value: "x".repeat(40_000)
    })).toBeNull();
  });

  it("accepts a long but legitimate free-text answer", () => {
    expect(parseRuntimeMessage({
      type: "JOBPILOT_SAVE_ANSWER", sessionId: 55, canonicalKey: "custom_motivation", value: "x".repeat(8_000)
    })).not.toBeNull();
  });

  it("accepts explicit nulls where the contract allows them", () => {
    expect(parseRuntimeMessage({
      type: "JOBPILOT_SUBMISSION_CONFIRMED", sessionId: 55, evidenceType: "success_page",
      submissionTimestamp: "2026-08-22T00:00:00Z", submissionReference: null, ats: null
    })).not.toBeNull();
    expect(parseRuntimeMessage({ ...contentReady(), topUrl: null, detectedAts: null })).not.toBeNull();
  });

  it("tolerates an unrecognised extra property, so a version-skewed pair still talks", () => {
    // Content script and service worker update on independent schedules; a
    // field one side does not know yet must not break the other.
    expect(parseRuntimeMessage({
      type: "JOBPILOT_COMPLETE_SESSION", sessionId: 55, somethingAddedLater: { nested: true }
    })).not.toBeNull();
  });
});
