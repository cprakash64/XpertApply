import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLaunch } from "../messages";

function installStorage() {
  const store: Record<string, unknown> = {};
  const area = {
    get: async (key?: string | string[]) => (typeof key === "string" ? { [key]: store[key] } : { ...store }),
    set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
    remove: async (key: string | string[]) => { for (const k of [key].flat()) delete store[k]; }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { session: area, local: area } };
}

const launch = (sessionId: number, url: string, extra: Partial<PendingLaunch> = {}): PendingLaunch => ({
  version: 1, applicationId: String(sessionId), jobId: String(sessionId), applicationUrl: url, status: "opening", handoffToken: "h",
  requestId: `req-${sessionId}`, sessionId, launchToken: "l", officialUrl: url, expectedOrigin: new URL(url).origin,
  createdAt: 1, expiresAt: Date.now() + 60_000, state: "opening_tab", protocolVersion: 3, atsType: null, ...extra
});
const view = (state: any, l: PendingLaunch, tabId: number, patch: object = {}) => ({ ...state.initialView(tabId, l, null, null), ...patch });

describe("XA-NAV-02 unclaimed launches are kept per request, not as one global slot", () => {
  beforeEach(() => { vi.resetModules(); installStorage(); });

  it("a second launch does not erase the first one's record", async () => {
    const state = await import("../state");
    await state.putUnbound(launch(1, "https://jobs.ashbyhq.com/elevenlabs/a/application"));
    await state.putUnbound(launch(2, "https://job-boards.greenhouse.io/sofi/jobs/7"));
    expect((await state.listUnbound()).map((l) => l.sessionId).sort()).toEqual([1, 2]);
  });

  it("a newer launch of the SAME application supersedes the older unclaimed one", async () => {
    const state = await import("../state");
    await state.putUnbound(launch(1, "https://x.test/a", { requestId: "old" }));
    await state.putUnbound(launch(1, "https://x.test/a", { requestId: "new" }));
    expect((await state.listUnbound()).map((l) => l.requestId)).toEqual(["new"]);
  });

  it("expired launches are not candidates", async () => {
    const state = await import("../state");
    await state.putUnbound(launch(1, "https://x.test/a", { expiresAt: Date.now() - 1 }));
    expect(await state.listUnbound()).toEqual([]);
  });

  it("claiming a tab removes only that launch from the registry", async () => {
    const state = await import("../state");
    const a = launch(1, "https://x.test/a"); const b = launch(2, "https://y.test/b");
    await state.putUnbound(a); await state.putUnbound(b);
    await state.claimTabForLaunch(11, a, view(state, a, 11));
    expect((await state.listUnbound()).map((l) => l.sessionId)).toEqual([2]);
    expect((await state.getPending(11))?.sessionId).toBe(1);
  });

  it("the claim keeps a binding (and its progress) that the tab's first document already made, and marks it user-started", async () => {
    const state = await import("../state");
    const a = launch(1, "https://x.test/a");
    await state.putUnbound(a);
    await state.putPending(11, { ...a, status: "detecting", state: "detecting_ats" });          // the early self-bind: no userStarted
    await state.putView(11, view(state, a, 11, { contentReady: true, packageLoaded: true }));
    await state.claimTabForLaunch(11, { ...a, userStarted: true }, view(state, a, 11));
    expect((await state.getPending(11))?.userStarted).toBe(true);
    expect((await state.getPending(11))?.state).toBe("detecting_ats");                          // not reset to opening
    expect((await state.getView(11))?.contentReady).toBe(true);                                 // progress not wiped
  });

  it("two applications in two tabs stay separate when one is cleared", async () => {
    const state = await import("../state");
    const a = launch(1, "https://x.test/a"); const b = launch(2, "https://y.test/b");
    await state.claimTabForLaunch(11, a, view(state, a, 11));
    await state.claimTabForLaunch(12, b, view(state, b, 12));
    await state.clearWorkflowSession(1);
    expect(await state.getPending(11)).toBeNull();
    expect((await state.getPending(12))?.sessionId).toBe(2);
    expect((await state.getView(12))?.sessionId).toBe(2);
  });
});
