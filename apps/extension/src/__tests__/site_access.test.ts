/**
 * XA-06 — least-privilege host access.
 *
 * The finding: installing the extension granted authority over every website
 * the user visits (a wildcard https host permission plus a content script
 * matching every https page in every frame). Stage 3A's dormancy gate meant the
 * script did not ACT on unrelated pages, but the authority was real from the
 * moment of install, and a defect anywhere in that gate exposed every site at
 * once.
 *
 * The invariant under test:
 *
 *   AN EMPLOYER SITE THE USER HAS NEVER AUTHORIZED FOR AN XPERTAPPLY WORKFLOW
 *   IS NEITHER READABLE NOR SCRIPTABLE MERELY BECAUSE THE EXTENSION IS
 *   INSTALLED.
 *
 * Two things follow, and both are asserted here: the built manifest must not
 * carry that authority, and the runtime must not act as though it does —
 * injection is gated on a real grant, a denial stops the workflow, and
 * navigation to a new origin never inherits the previous origin's permission.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { originPatternFor, siteAccessNeedFor, displayOrigin } from "../security/siteAccess";
import { JOBPILOT_WEB_ORIGINS } from "../config";
import type { PendingLaunch } from "../messages";

// --------------------------------------------------------------------------- //
// §20 — the BUILT manifest, not the source
// --------------------------------------------------------------------------- //

const DIST_MANIFEST = path.resolve(__dirname, "..", "..", "dist", "manifest.json");

type Manifest = {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: { matches: string[]; all_frames?: boolean; exclude_matches?: string[] }[];
  web_accessible_resources?: unknown;
  externally_connectable?: unknown;
};

/** A pattern that grants authority over sites in general, however written. */
function isBlanketHostPattern(pattern: string): boolean {
  if (pattern === "<all_urls>") return true;
  // Anything whose HOST part is a bare wildcard: https://*/*, *://*/*, http://*/*
  const match = /^(?:\*|https?):\/\/([^/]*)\//.exec(pattern);
  return match ? match[1] === "*" : false;
}

describe("XA-06 · the built manifest takes no authority over employer sites", () => {
  const manifest: Manifest = JSON.parse(readFileSync(DIST_MANIFEST, "utf8"));

  it("requires no blanket host permission", () => {
    for (const pattern of manifest.host_permissions ?? []) {
      expect(isBlanketHostPattern(pattern), pattern).toBe(false);
    }
  });

  it("requires host permissions only for XpertApply's own origins and API", () => {
    const first = /^https:\/\/([a-z0-9-]+\.)*(xpertapply\.com|jobpilot\.ai|ezjobfind\.com)\//;
    for (const pattern of manifest.host_permissions ?? []) {
      expect(pattern, pattern).toMatch(first);
    }
  });

  it("keeps the runtime-discoverable wildcard optional, where it grants nothing until asked", () => {
    const optional = manifest.optional_host_permissions ?? [];
    expect(optional.some(isBlanketHostPattern)).toBe(true);
  });

  it("registers no content script on sites the user has not authorised", () => {
    for (const entry of manifest.content_scripts ?? []) {
      for (const pattern of entry.matches) {
        expect(isBlanketHostPattern(pattern), pattern).toBe(false);
      }
    }
  });

  it("runs its one static content script in the top frame of XpertApply's own origins only", () => {
    const entries = manifest.content_scripts ?? [];
    expect(entries).toHaveLength(1);
    for (const pattern of entries[0].matches) {
      expect(
        JOBPILOT_WEB_ORIGINS.some((origin) => pattern.startsWith(origin)),
        pattern
      ).toBe(true);
    }
    // all_frames only where justified — the bridge has no reason to run in a
    // subframe of XpertApply's own site.
    expect(entries[0].all_frames).toBe(false);
  });

  it("exposes no resources and accepts external messages only from production XpertApply", () => {
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toEqual({
      matches: ["https://xpertapply.com/*", "https://www.xpertapply.com/*"]
    });
  });

  it("keeps API permissions minimal and unchanged by this stage", () => {
    // `scripting` is now load-bearing (programmatic injection) and must stay.
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.optional_permissions).toContain("webNavigation");
    for (const risky of ["cookies", "webRequest", "downloads", "history", "<all_urls>"]) {
      expect(manifest.permissions ?? []).not.toContain(risky);
    }
  });
});

// --------------------------------------------------------------------------- //
// §10 — origin canonicalisation
// --------------------------------------------------------------------------- //

describe("permission patterns are built from parsed URLs, never string concatenation", () => {
  it("asks for exactly one origin", () => {
    expect(originPatternFor("https://jobs.example.com/apply?x=1#f")).toBe("https://jobs.example.com/*");
    expect(originPatternFor("https://Jobs.Example.COM/apply")).toBe("https://jobs.example.com/*");
  });

  it("never widens a subdomain into a domain wildcard", () => {
    const pattern = originPatternFor("https://jobs.example.com/apply");
    expect(pattern).not.toContain("*.example.com");
    expect(pattern).toBe("https://jobs.example.com/*");
  });

  it("refuses every scheme an application cannot live on", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<h1>x",
      "file:///etc/passwd",
      "chrome://settings",
      "chrome-extension://abcdef/page.html",
      "about:blank",
      "ftp://example.com/x"
    ]) {
      expect(originPatternFor(url), url).toBeNull();
    }
  });

  it("refuses malformed input rather than guessing", () => {
    for (const url of ["", "not a url", "https://", "://example.com", null, undefined]) {
      expect(originPatternFor(url as string | null), String(url)).toBeNull();
    }
  });

  it("refuses a URL carrying credentials", () => {
    expect(originPatternFor("https://user:pass@example.com/apply")).toBeNull();
    expect(originPatternFor("https://attacker@example.com/apply")).toBeNull();
  });

  it("refuses plain http except on loopback", () => {
    expect(originPatternFor("http://example.com/apply")).toBeNull();
    expect(originPatternFor("http://localhost:3000/apply")).toBe("http://localhost/*");
    expect(originPatternFor("http://127.0.0.1:8080/apply")).toBe("http://127.0.0.1/*");
  });

  it("does not let a misleading host broaden the pattern", () => {
    // A suffix that merely LOOKS like a trusted domain gets its own origin and
    // nothing more.
    expect(originPatternFor("https://greenhouse.io.evil.test/apply"))
      .toBe("https://greenhouse.io.evil.test/*");
    expect(originPatternFor("https://xpertapply.com.evil.test/apply"))
      .toBe("https://xpertapply.com.evil.test/*");
    // A wildcard smuggled through the host never reaches a match pattern.
    expect(originPatternFor("https://*.example.com/apply")).toBeNull();
  });

  it("shows the user a host, never a URL that could carry an identifier", () => {
    expect(displayOrigin("https://jobs.example.com/apply?email=a@b.test")).toBe("jobs.example.com");
    expect(displayOrigin("javascript:alert(1)")).toBeNull();
  });

  it("reports a distinct state for a URL no permission can be requested for", () => {
    expect(siteAccessNeedFor("chrome://settings", false).state).toBe("site_access_unavailable");
    expect(siteAccessNeedFor("https://example.com/x", false).state).toBe("site_access_required");
    expect(siteAccessNeedFor("https://example.com/x", true).state).toBe("site_access_granted");
  });
});

// --------------------------------------------------------------------------- //
// §19 — the runtime gate
// --------------------------------------------------------------------------- //

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void;

const APPLICATION_URL = "https://careers.acme.com/jobs/1/apply";

function launch(url = APPLICATION_URL): PendingLaunch {
  return {
    version: 1, applicationId: "1", jobId: "1", applicationUrl: url,
    status: "prepared", handoffToken: "t", requestId: "r", sessionId: 1, launchToken: "t",
    officialUrl: url, expectedOrigin: new URL(url).origin,
    createdAt: Date.now(), expiresAt: Date.now() + 900_000,
    state: "package_ready", protocolVersion: 3, atsType: null
  };
}

/** A fake Chrome whose permission set is controllable, so the gate can be
 * driven through grant, denial and revocation without a browser. */
function installFakeChrome(granted: string[] = [], tabUrl = APPLICATION_URL) {
  const store: Record<string, unknown> = {};
  const messageListeners: Listener[] = [];
  const injected: { tabId: number; allFrames?: boolean }[] = [];
  const permissions = new Set(granted);
  const fake = {
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
      onRemoved: { addListener: () => undefined }, onUpdated: { addListener: () => undefined },
      onCreated: { addListener: () => undefined },
      create: vi.fn(async () => ({ id: 7 })),
      get: vi.fn(async () => ({ id: 7, url: tabUrl })),
      update: vi.fn(async () => ({})),
      // Honour the url filter. A fake that answers every query with the same
      // tab makes the worker's startup revival look like a permission leak.
      query: vi.fn(async (q: { url?: string } = {}) => {
        if (!q.url) return [{ id: 7, url: tabUrl }];
        const prefix = q.url.replace(/\*$/, "");
        return tabUrl.startsWith(prefix) ? [{ id: 7, url: tabUrl }] : [];
      }),
      sendMessage: vi.fn((_t: number, _m: unknown, ...rest: unknown[]) => {
        const cb = rest.find((r) => typeof r === "function") as ((r: unknown) => void) | undefined;
        cb?.(undefined); // nothing answers: no content script present
      })
    },
    windows: { update: vi.fn(async () => ({})) },
    scripting: {
      executeScript: vi.fn(async (opts: { target: { tabId: number; allFrames?: boolean } }) => {
        injected.push({ tabId: opts.target.tabId, allFrames: opts.target.allFrames });
        return [];
      })
    },
    permissions: {
      contains: vi.fn(async (req: { origins?: string[] }) =>
        (req.origins ?? []).every((origin) => permissions.has(origin))),
      request: vi.fn(async () => false),
      remove: vi.fn(async () => true)
    },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { messageListeners, injected, permissions, fake };
}

/** The worker does revival work on import; let it finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function dispatch(listeners: Listener[], raw: unknown, from: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    for (const fn of listeners) {
      const keep = fn(raw, from, (r) => { if (!done) { done = true; resolve(r); } });
      if (!keep && !done) continue;
    }
  });
}

describe("XA-06 · the runtime never acts on authority it does not have", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("B/C · injects nothing for a workflow whose origin has not been granted", async () => {
    const { injected } = installFakeChrome([]);
    const state = await import("../state");
    await state.putPending(7, launch());
    const bg = await import("../background");
    await settle();
    const need = await bg.siteAccessFor(APPLICATION_URL);
    expect(need).toMatchObject({
      state: "site_access_required",
      pattern: "https://careers.acme.com/*",
      origin: "careers.acme.com"
    });
    expect(injected).toEqual([]);
  });

  it("E · reports granted once Chrome allows exactly that origin", async () => {
    installFakeChrome(["https://careers.acme.com/*"]);
    const bg = await import("../background");
    expect((await bg.siteAccessFor(APPLICATION_URL)).state).toBe("site_access_granted");
  });

  it("G · a grant for one origin is not a grant for another", async () => {
    installFakeChrome(["https://careers.acme.com/*"]);
    const bg = await import("../background");
    expect((await bg.siteAccessFor("https://unrelated.example.com/x")).state).toBe("site_access_required");
  });

  it("H · navigating to a new origin does not inherit the previous grant", async () => {
    // The workflow crosses origins by design; crossing is not consent.
    installFakeChrome(["https://careers.acme.com/*"]);
    const bg = await import("../background");
    expect((await bg.siteAccessFor("https://identity.okta-like.test/login")).state)
      .toBe("site_access_required");
  });

  it("P/Q · never forms a request for a URL that cannot carry one", async () => {
    installFakeChrome([]);
    const bg = await import("../background");
    for (const url of ["chrome://settings", "javascript:alert(1)", "not a url", ""]) {
      const need = await bg.siteAccessFor(url);
      expect(need.state, url).toBe("site_access_unavailable");
      expect(need.pattern, url).toBeNull();
    }
  });

  it("D · a declined grant stops the workflow instead of re-asking", async () => {
    const { messageListeners } = installFakeChrome([]);
    const state = await import("../state");
    await state.putPending(7, launch());
    const bg = await import("../background");
    await settle();
    await state.putView(7, state.initialView(7, launch(), null, null));
    void bg;

    const result = (await dispatch(
      messageListeners,
      { type: "JOBPILOT_SITE_ACCESS_RESULT", tabId: 7, pattern: "https://careers.acme.com/*", granted: false },
      {}
    )) as { ok: boolean; state: string };

    expect(result).toMatchObject({ ok: false, state: "site_access_denied" });
    const view = await state.getView(7);
    expect(view?.siteAccess).toBe("site_access_denied");
  });

  it("F · a grant already held needs no second prompt", async () => {
    const { messageListeners, fake } = installFakeChrome(["https://careers.acme.com/*"]);
    const state = await import("../state");
    await state.putPending(7, launch());
    await state.putView(7, state.initialView(7, launch(), null, null));
    await import("../background");
    await settle();

    const need = (await dispatch(messageListeners, { type: "JOBPILOT_GET_SITE_ACCESS", tabId: 7 }, {})) as
      { ok: boolean; need: { state: string } };
    expect(need.need.state).toBe("site_access_granted");
    // The worker only ever checks; it must never try to request.
    expect(fake.permissions.request).not.toHaveBeenCalled();
  });

  it("O · access removed mid-workflow fails closed on the next injection", async () => {
    const { permissions, injected } = installFakeChrome(["https://careers.acme.com/*"]);
    const state = await import("../state");
    await state.putPending(7, launch());
    await state.putView(7, state.initialView(7, launch(), null, null));
    const bg = await import("../background");
    await settle();
    injected.length = 0; // ignore the worker's own startup revival

    expect((await bg.siteAccessFor(APPLICATION_URL)).state).toBe("site_access_granted");
    permissions.clear(); // user revokes via chrome://extensions
    expect((await bg.siteAccessFor(APPLICATION_URL)).state).toBe("site_access_required");
    expect(injected).toEqual([]);
  });

  it("the worker never calls permissions.request — only a user gesture can", async () => {
    // Chrome requires a gesture and a service worker has none; a request from
    // here either rejects or raises a prompt nothing is waiting on.
    const source = readFileSync(path.resolve(__dirname, "..", "background.ts"), "utf8");
    const calls = source.split("\n").filter((line) =>
      line.includes("permissions.request(") && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    expect(calls).toEqual([]);
  });
});
