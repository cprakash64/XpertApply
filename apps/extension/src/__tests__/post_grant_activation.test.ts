import { describe, expect, it, vi } from "vitest";
import {
  activateGrantedApplicationFrame,
  type PostGrantActivationDependencies,
  type PostGrantFrame
} from "../frames/postGrantActivation";

const ATS_ORIGIN = "https://boards.greenhouse.io";
const ATS_URL = `${ATS_ORIGIN}/embed/1`;
const ADS_URL = "https://ads.doubleclick.net/widget";

function dependencies(overrides: Partial<PostGrantActivationDependencies> = {}) {
  const active = new Set<number>();
  const inject = vi.fn(async (frameIds: number[]) => {
    for (const frameId of frameIds) active.add(frameId);
  });
  const value: PostGrantActivationDependencies = {
    permissionGranted: vi.fn(async () => true),
    enumerate: vi.fn(async () => [{ frameId: 3, url: ATS_URL }]),
    workflowTrusted: vi.fn(() => true),
    frameMatches: vi.fn(() => true),
    ping: vi.fn(async (frameId) => active.has(frameId)),
    inject,
    wait: vi.fn(async () => undefined),
    ...overrides
  };
  return { value, active, inject };
}

describe("post-grant frame reconciliation", () => {
  it("1 · replaces an observed-only null identity with Chrome's concrete frame id", async () => {
    // The pre-grant observation deliberately is not an input: it had frameId
    // null and can justify only the exact permission question.
    const observedBeforeGrant = { origin: ATS_ORIGIN, frameId: null };
    const { value, inject } = dependencies();
    const result = await activateGrantedApplicationFrame(observedBeforeGrant.origin, value);

    expect(observedBeforeGrant.frameId).toBeNull();
    expect(result).toMatchObject({ state: "active", frameIds: [3] });
    expect(inject).toHaveBeenCalledWith([3]);
  });

  it("3 · excludes an ad in the same tab from the targeted injection", async () => {
    const { value, inject } = dependencies({
      enumerate: vi.fn(async () => [
        { frameId: 0, url: "https://careers.mongodb.com/jobs/1" },
        { frameId: 2, url: ADS_URL },
        { frameId: 3, url: ATS_URL }
      ])
    });
    await activateGrantedApplicationFrame(ATS_ORIGIN, value);
    expect(inject).toHaveBeenCalledWith([3]);
    expect(inject).not.toHaveBeenCalledWith(expect.arrayContaining([2]));
  });

  it("4 · rejects a same-origin-looking frame that does not join the workflow", async () => {
    const { value, inject } = dependencies({ workflowTrusted: vi.fn(() => false) });
    const result = await activateGrantedApplicationFrame(ATS_ORIGIN, value, 2);
    expect(result).toMatchObject({ state: "pending", reason: "frame_not_confirmed", frameIds: [] });
    expect(inject).not.toHaveBeenCalled();
  });

  it("fails closed when two same-origin frames match the observed application path", async () => {
    const { value, inject } = dependencies({
      enumerate: vi.fn(async () => [
        { frameId: 3, url: ATS_URL },
        { frameId: 8, url: ATS_URL }
      ])
    });
    const result = await activateGrantedApplicationFrame(ATS_ORIGIN, value, 2);
    expect(result).toMatchObject({
      state: "pending", reason: "frame_not_confirmed", frameIds: [3, 8]
    });
    expect(inject).not.toHaveBeenCalled();
  });

  it("5 · never fabricates an id when Chrome confirms no matching frame", async () => {
    const { value, inject } = dependencies({
      enumerate: vi.fn(async () => [{ frameId: 0, url: "https://careers.mongodb.com/jobs/1" }])
    });
    const result = await activateGrantedApplicationFrame(ATS_ORIGIN, value, 2);
    expect(result).toEqual({
      state: "pending", frameIds: [], attempts: 2, reason: "frame_not_confirmed"
    });
    expect(inject).not.toHaveBeenCalled();
  });

  it("6 · uses the current Chrome id after navigation, never an observed stale id", async () => {
    const observedStaleFrameId = 3;
    const { value, inject } = dependencies({
      enumerate: vi.fn(async () => [{ frameId: 9, url: `${ATS_ORIGIN}/embed/2` }])
    });
    const result = await activateGrantedApplicationFrame(ATS_ORIGIN, value);
    expect(result).toMatchObject({ state: "active", frameIds: [9] });
    expect(inject).toHaveBeenCalledWith([9]);
    expect(inject).not.toHaveBeenCalledWith([observedStaleFrameId]);
  });

  it("7 · fails closed when permission is revoked after discovery", async () => {
    const permissionGranted = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { value, inject } = dependencies({ permissionGranted });
    const result = await activateGrantedApplicationFrame(ATS_ORIGIN, value);
    expect(result).toEqual({ state: "permission_revoked", frameIds: [], attempts: 1 });
    expect(inject).not.toHaveBeenCalled();
  });

  it("8 · keeps executeScript failure recoverable and refreshes before retry", async () => {
    const enumerate = vi.fn(async (): Promise<PostGrantFrame[]> => [{ frameId: 3, url: ATS_URL }]);
    const inject = vi.fn(async () => { throw new Error("frame navigated"); });
    const { value } = dependencies({ enumerate, inject });
    const result = await activateGrantedApplicationFrame(ATS_ORIGIN, value, 2);
    expect(result).toMatchObject({ state: "pending", reason: "injection_failed", frameIds: [3] });
    expect(enumerate).toHaveBeenCalledTimes(2);
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it("9 · does not call a frame active when bootstrap never answers", async () => {
    const inject = vi.fn(async () => undefined);
    const { value } = dependencies({ inject, ping: vi.fn(async () => false) });
    const result = await activateGrantedApplicationFrame(ATS_ORIGIN, value, 2);
    expect(result).toMatchObject({ state: "pending", reason: "bootstrap_unconfirmed", frameIds: [3] });
  });

  it("re-enumerates until Chrome exposes a newly granted frame", async () => {
    const enumerate = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ frameId: 7, url: ATS_URL }]);
    const { value, inject } = dependencies({ enumerate });
    const result = await activateGrantedApplicationFrame(ATS_ORIGIN, value);
    expect(result).toMatchObject({ state: "active", frameIds: [7], attempts: 2 });
    expect(inject).toHaveBeenCalledWith([7]);
  });
});
