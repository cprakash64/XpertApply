import { beforeEach, describe, expect, it } from "vitest";
import { MSG, PROTOCOL_VERSION, parsePageMessage, parseRuntimeMessage } from "../messages";
import { collectManifestFiles, EXPECTED_BUILD_OUTPUTS } from "../manifest-files.mjs";
import manifest from "../../manifest.json";
import { isApprovedJobPilotOrigin } from "../config";

describe("message validation", () => {
  it("accepts configured XpertApply origins and rejects an untrusted origin", () => {
    expect(isApprovedJobPilotOrigin("http://localhost:3000")).toBe(true);
    expect(isApprovedJobPilotOrigin("https://app.jobpilot.ai")).toBe(true);
    expect(isApprovedJobPilotOrigin("https://jobpilot.ai.evil.example")).toBe(false);
  });
  it("accepts a known runtime message and rejects unknown ones", () => {
    expect(parseRuntimeMessage({ type: MSG.CONTENT_READY, url: "x", title: "t", protocolVersion: 3, isTopFrame: true, detectedAts: null })).toBeTruthy();
    expect(parseRuntimeMessage({ type: "SOMETHING_ELSE" })).toBeNull();
    expect(parseRuntimeMessage(null)).toBeNull();
    expect(parseRuntimeMessage("nope")).toBeNull();
  });

  it("accepts known page messages and rejects unknown sources/types", () => {
    expect(parsePageMessage({ source: "jobpilot-web", type: MSG.PING })).toBeTruthy();
    expect(parsePageMessage({ source: "evil", type: MSG.PING })).toBeNull();
    expect(parsePageMessage({ source: "jobpilot-web", type: "HELLO" })).toBeNull();
  });
});

describe("manifest ↔ build outputs (build test)", () => {
  it("only references files the build actually emits", () => {
    const referenced = collectManifestFiles(manifest);
    for (const file of referenced) {
      expect(EXPECTED_BUILD_OUTPUTS).toContain(file);
    }
  });

  it("declares the required MV3 keys and speaks the current protocol", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining(["sidePanel", "storage", "scripting"]));
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.side_panel.default_path).toBe("sidepanel.html");
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it("does not take employer-site authority at install time (XA-06)", () => {
    // This assertion used to require the opposite: a wildcard https host
    // permission, on the reasoning that employer ATS domains cannot be
    // enumerated. They cannot — but that argument justifies discovering the
    // origin at RUNTIME, not holding authority over every site from the moment
    // of install. The wildcard now lives in optional_host_permissions and is
    // requested one origin at a time.
    const required: string[] = manifest.host_permissions ?? [];
    expect(required).not.toContain("https://*/*");
    expect(required).not.toContain("<all_urls>");
    expect(required.some((pattern) => /^https:\/\/\*/.test(pattern))).toBe(false);
    // What remains is first-party only: XpertApply's own web app and its API.
    for (const pattern of required) {
      expect(pattern).toMatch(/^https:\/\/([a-z0-9-]+\.)*(xpertapply\.com|jobpilot\.ai|ezjobfind\.com)\//);
    }
  });

  it("keeps the runtime-discoverable wildcard optional, never required", () => {
    expect(manifest.optional_host_permissions).toEqual(
      expect.arrayContaining(["https://*/*"])
    );
    // Still no enumerated ATS hostnames: the allowlist approach was the root
    // cause of employer-hosted domains being unreachable, and it is not what
    // replaced the wildcard.
    expect((manifest.optional_host_permissions ?? []).some((h: string) => h.includes("greenhouse"))).toBe(false);
  });

  it("statically injects only into XpertApply's own origins", () => {
    // The employer/ATS content script is no longer declarative. It is injected
    // programmatically once an origin has actually been granted, so an
    // unrelated site the user visits has no XpertApply code in it at all.
    const entries: { matches: string[]; all_frames?: boolean }[] = manifest.content_scripts;
    expect(entries).toHaveLength(1);
    for (const entry of entries) {
      for (const pattern of entry.matches) {
        expect(pattern).toMatch(
          /^https:\/\/([a-z0-9-]+\.)*(xpertapply\.com|jobpilot\.ai|ezjobfind\.com)\/|^http:\/\/(localhost|127\.0\.0\.1):3000\//
        );
      }
      // The bridge role only ever runs in the top frame of a XpertApply page.
      expect(entry.all_frames).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------- //
// Durable state (chrome.storage.local), with a minimal fake chrome.
// --------------------------------------------------------------------------- //
describe("tab-scoped launch state", () => {
  beforeEach(() => {
    const store: Record<string, unknown> = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
          remove: async (key: string) => { delete store[key]; }
        }
      }
    };
  });

  it("persists a pending launch by tab id and clears it on tab close", async () => {
    const state = await import("../state");
    const launch = {
      version: 1 as const, applicationId: "7", jobId: "70", applicationUrl: "https://job-boards.greenhouse.io/affirm/jobs/1",
      status: "opening" as const, handoffToken: "tok",
      requestId: "r1", sessionId: 7, launchToken: "tok", officialUrl: "https://job-boards.greenhouse.io/affirm/jobs/1",
      expectedOrigin: "https://job-boards.greenhouse.io", createdAt: 0, expiresAt: Date.now() + 1000,
      state: "waiting_for_tab" as const, protocolVersion: 3, atsType: "greenhouse"
    };
    await state.putPending(101, launch);
    await state.putPending(202, { ...launch, requestId: "r2", sessionId: 8, applicationId: "8" });

    expect((await state.getPending(101))?.sessionId).toBe(7);
    // Never associated by "active tab": tab 202 has its own, independent launch.
    expect((await state.getPending(202))?.sessionId).toBe(8);
    expect((await state.findPendingByRequest("r2"))?.tabId).toBe(202);
    // Adding another tab-scoped record does not implicitly replace the active
    // workflow generation. The launch path promotes it explicitly.
    expect((await state.getActive())?.applicationId).toBe("7");

    await state.clearTab(101);
    expect(await state.getPending(101)).toBeNull();
    expect((await state.getPending(202))?.sessionId).toBe(8); // unaffected
    // The versioned active handoff survives tab cleanup/service-worker restart.
    expect((await state.getActive())?.version).toBe(1);
  });

  it("caches the session package so a single-use token is not re-exchanged", async () => {
    const state = await import("../state");
    await state.putPackage(303, {
      sessionToken: "sess", cachedAt: Date.now(),
      session: {
        sessionId: 9, atsType: "greenhouse", officialUrl: "u", jobTitle: null, company: null,
        answers: [], unresolvedQuestions: []
      }
    });
    expect((await state.getPackage(303))?.sessionToken).toBe("sess");
    await state.clearTab(303);
    expect(await state.getPackage(303)).toBeNull();
  });

  it("preserves false values through session-package cache hydration", async () => {
    const state = await import("../state");
    await state.putPackage(304, {
      sessionToken: "sess",
      cachedAt: Date.now(),
      session: {
        sessionId: 10,
        authenticatedUserId: 3,
        atsType: "generic",
        officialUrl: "u",
        jobTitle: null,
        company: null,
        profileData: { currentSponsorship: false, futureSponsorship: false },
        answers: [],
        unresolvedQuestions: []
      }
    });
    const hydrated = await state.getPackage(304);
    expect(hydrated?.session.profileData).toMatchObject({
      currentSponsorship: false,
      futureSponsorship: false
    });
  });

  it("removes expired durable handoffs and token-bearing packages", async () => {
    const state = await import("../state");
    const launch = {
      version: 1 as const, applicationId: "expired", jobId: "1", applicationUrl: "https://jobs.ashbyhq.com/acme/1",
      status: "prepared" as const, handoffToken: "launch", requestId: "expired", sessionId: 10,
      launchToken: "launch", officialUrl: "https://jobs.ashbyhq.com/acme/1", expectedOrigin: "https://jobs.ashbyhq.com",
      createdAt: 0, expiresAt: 1, state: "package_ready" as const, protocolVersion: 3, atsType: "ashby"
    };
    await state.putPending(404, launch);
    await state.putPackage(404, { sessionToken: "short-lived", cachedAt: 0, session: { sessionId: 10, atsType: "ashby", officialUrl: launch.officialUrl, jobTitle: null, company: null, answers: [], unresolvedQuestions: [] } });
    await state.cleanupExpired(2);
    expect(await state.getPending(404)).toBeNull();
    expect(await state.getPackage(404)).toBeNull();
    expect(await state.getActive()).toBeNull();
  });
});
