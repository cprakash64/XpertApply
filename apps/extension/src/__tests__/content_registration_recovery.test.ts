import { describe, expect, it, vi } from "vitest";
import { createContentRegistrationRecovery } from "../contentRegistrationRecovery";

describe("bounded worker-start content registration recovery", () => {
  it("signals HTTP tabs once without depending on frame inventory", async () => {
    const signal = vi.fn(async () => ({ forgedTabId: 99, frameId: 8 }));
    const recover = createContentRegistrationRecovery({ candidateTabs: async () => [
      { id: 7, url: "https://employer.example/apply" },
      { id: 8, url: "http://localhost/apply" }, { id: 7, url: "https://employer.example/apply" },
      { id: 9, url: "chrome://settings" }, { url: "https://missing.example" },
      { id: -1, url: "https://invalid.example" }
    ], signal });
    await recover();
    expect(signal.mock.calls).toEqual([[7], [8]]);
  });
  it("coalesces concurrent triggers into one pass", async () => {
    let resolve!: (tabs: Array<{ id: number; url: string }>) => void;
    const candidateTabs = vi.fn(() => new Promise<Array<{ id: number; url: string }>>(done => { resolve = done; }));
    const signal = vi.fn(async () => undefined);
    const recover = createContentRegistrationRecovery({ candidateTabs, signal });
    const first = recover(); const second = recover();
    expect(first).toBe(second);
    await Promise.resolve(); resolve([{ id: 7, url: "https://employer.example" }]);
    await first;
    expect(candidateTabs).toHaveBeenCalledTimes(1); expect(signal).toHaveBeenCalledTimes(1);
  });
  it("never rescans completed recovery on later overlay requests", async () => {
    const candidateTabs = vi.fn(async () => []);
    const recover = createContentRegistrationRecovery({ candidateTabs, signal: vi.fn() });
    await recover(); await recover(); await recover();
    expect(candidateTabs).toHaveBeenCalledTimes(1);
  });
  it("treats a no-receiver rejection as benign and still signals other tabs", async () => {
    const signal = vi.fn(async (id: number) => { if (id === 7) throw Error("Receiving end does not exist"); });
    const recover = createContentRegistrationRecovery({ candidateTabs: async () => [
      { id: 7, url: "https://ordinary.example" }, { id: 8, url: "https://employer.example" }
    ], signal });
    await expect(recover()).resolves.toBeUndefined(); expect(signal.mock.calls).toEqual([[7], [8]]);
  });
  it("handles synchronous messaging exceptions without escaping the pass", async () => {
    const recover = createContentRegistrationRecovery({ candidateTabs: async () => [{ id: 7, url: "https://employer.example" }],
      signal: () => { throw Error("API unavailable"); } });
    await expect(recover()).resolves.toBeUndefined();
  });
  it("clears a failed inventory pass and does not introduce retries or timers", async () => {
    const candidateTabs = vi.fn(async () => { throw Error("inventory unavailable"); });
    const signal = vi.fn(); const interval = vi.spyOn(globalThis, "setInterval");
    try {
      const recover = createContentRegistrationRecovery({ candidateTabs, signal });
      await expect(recover()).resolves.toBeUndefined(); await expect(recover()).resolves.toBeUndefined();
      expect(candidateTabs).toHaveBeenCalledTimes(1); expect(signal).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
    } finally { interval.mockRestore(); }
  });
  it("defers inventory until synchronous listener installation can complete", async () => {
    const order: string[] = [];
    const recover = createContentRegistrationRecovery({ candidateTabs: async () => { order.push("inventory"); return [{ id: 7, url: "https://employer.example" }]; },
      signal: async () => { order.push("broadcast"); } });
    const pending = recover(); order.push("listeners"); await pending;
    expect(order).toEqual(["listeners", "inventory", "broadcast"]);
  });
});

it("keeps child workflow progress from creating a canonical overlay", async () => {
  const { createWidget } = await import("../content/widget");
  vi.stubGlobal("window", { top: {} });
  try {
    const widget = createWidget({ retry: vi.fn(), clear: vi.fn(), complete: vi.fn() });
    widget.update({ stage: "review", total: 2 });
    widget.showSubmissionConfirmation(); widget.destroy();
    expect(document.querySelector("#xpertapply-assistant-overlay-v1")).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
