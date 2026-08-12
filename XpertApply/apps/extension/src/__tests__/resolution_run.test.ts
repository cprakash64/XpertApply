import { describe, expect, it } from "vitest";
import { ResolutionRunCoordinator } from "../content/resolutionRun";

describe("eligibility resolution run coordination", () => {
  it("Retry creates a new run and rejects the old run's late response", () => {
    const coordinator = new ResolutionRunCoordinator();
    const oldRun = coordinator.begin("build-a", 1000);
    const retryRun = coordinator.begin("build-a", 1001);

    expect(retryRun.id).not.toBe(oldRun.id);
    expect(coordinator.accepts(oldRun.id)).toBe(false);
    expect(coordinator.accepts(retryRun.id)).toBe(true);
  });

  it("records build identity and creation time in every run", () => {
    const coordinator = new ResolutionRunCoordinator();
    const run = coordinator.begin("44364f1-dirty", Date.parse("2026-08-06T01:00:00.000Z"));
    expect(run.id).toContain("44364f1-dirty");
    expect(run.createdAt).toBe("2026-08-06T01:00:00.000Z");
  });
});
