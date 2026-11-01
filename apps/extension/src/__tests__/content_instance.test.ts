import { describe, expect, it, vi } from "vitest";
import { claimContentInstance, makeContentInstanceId } from "../content/instance";

describe("content-script reload ownership", () => {
  it("lets a newly injected instance supersede an orphaned page instance", () => {
    const pageWorld: Record<string, unknown> = { __jobpilotContentLoaded: true };
    const firstIsCurrent = claimContentInstance(pageWorld, "old-runtime");
    expect(firstIsCurrent()).toBe(true);

    const nextIsCurrent = claimContentInstance(pageWorld, "new-runtime");
    expect(firstIsCurrent()).toBe(false);
    expect(nextIsCurrent()).toBe(true);
    // The legacy boolean never blocks the new owner.
    expect(pageWorld.__jobpilotContentLoaded).toBe(true);
  });

  it("creates a distinct id for repeated injections of the same build", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.2);
    expect(makeContentInstanceId("build-a")).not.toBe(makeContentInstanceId("build-a"));
  });
});

describe("same-document workflow reinjection", () => {
  it("retains the live ledger owner instead of publishing fresh discovery", async () => {
    const { claimWorkflowContentInstance } = await import("../content/instance");
    const world: Record<string, unknown> = {};
    const live = claimWorkflowContentInstance(world, "first", "build-a", () => true);
    const reinjected = claimWorkflowContentInstance(world, "second", "build-a", () => true);
    expect(live()).toBe(true);
    expect(reinjected()).toBe(false);
    expect(world.__jobpilotContentInstance).toBe("first");
  });

  it.each([false, "throws"])("replaces an orphaned runtime (%s), including the same build", async invalid => {
    const { claimWorkflowContentInstance } = await import("../content/instance");
    const world: Record<string, unknown> = {};
    const old = claimWorkflowContentInstance(world, "old", "build-a", () => {
      if (invalid === "throws") throw new Error("Extension context invalidated");
      return false;
    });
    const current = claimWorkflowContentInstance(world, "new", "build-a", () => true);
    expect(old()).toBe(false);
    expect(current()).toBe(true);
  });

  it("permits a changed build to supersede the previous owner", async () => {
    const { claimWorkflowContentInstance } = await import("../content/instance");
    const world: Record<string, unknown> = {};
    const old = claimWorkflowContentInstance(world, "old", "build-a", () => true);
    const current = claimWorkflowContentInstance(world, "new", "build-b", () => true);
    expect(old()).toBe(false);
    expect(current()).toBe(true);
  });
});
