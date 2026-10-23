import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLaunch } from "../messages";
import { buildDirectPending } from "../direct/directApplication";

function installStorage() {
  const store: Record<string, unknown> = {};
  const area = {
    get: async (key?: string | string[]) => {
      if (typeof key === "string") return { [key]: store[key] };
      return { ...store };
    },
    set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
    remove: async (key: string | string[]) => { for (const k of [key].flat()) delete store[k]; }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { session: area, local: area } };
}

const website = (requestId: string): PendingLaunch => ({
  version: 1, applicationId: requestId, jobId: "1", applicationUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
  status: "prepared", handoffToken: "h", requestId, sessionId: 55, launchToken: "l",
  officialUrl: "https://job-boards.greenhouse.io/acme/jobs/1", expectedOrigin: "https://job-boards.greenhouse.io",
  createdAt: 1, expiresAt: Date.now() + 60_000, state: "package_ready", protocolVersion: 3, atsType: null
});
const direct = () => buildDirectPending({
  tabId: 9, sessionId: 77, userId: 7, url: new URL("https://careers.withwaymo.com/jobs/ml"), atsType: null,
  now: Date.now(), ttlMs: 60_000, requestId: "direct-1", protocolVersion: 3
});

describe("a direct draft is never the website launch other tabs may claim", () => {
  beforeEach(() => { vi.resetModules(); installStorage(); });

  it("does not become the global active handoff, even when none exists", async () => {
    const state = await import("../state");
    await state.putPending(9, direct());
    expect((await state.getPending(9))?.source).toBe("direct");
    expect(await state.getActive()).toBeNull();
  });

  it("does not displace a website launch, and a website launch still becomes active", async () => {
    const state = await import("../state");
    await state.putPending(3, website("site-1"));
    expect((await state.getActive())?.requestId).toBe("site-1");
    await state.putPending(9, direct());
    expect((await state.getActive())?.requestId).toBe("site-1");
    await state.updatePending(9, { status: "filling" });
    expect((await state.getActive())?.requestId).toBe("site-1");
  });
});
