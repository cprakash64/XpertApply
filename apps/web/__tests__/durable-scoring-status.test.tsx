import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import { useScoringStatus } from "@/lib/useScoringStatus";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: vi.fn() };
});
const request = vi.mocked(api);
const pending = { enabled: true, status: "pending" as const };
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => { vi.useFakeTimers(); request.mockReset(); vi.spyOn(Math, "random").mockReturnValue(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("durable actor status polling", () => {
  it("polls with no cards and stops at completion without repeating intake", async () => {
    request.mockResolvedValueOnce({ enabled: true, status: "processing" })
      .mockResolvedValueOnce({ enabled: true, status: "complete" });
    const settled = vi.fn();
    const { result, unmount } = renderHook(() => useScoringStatus(pending, settled));
    expect(result.current.message).toContain("processing");
    await advance(4999);
    expect(request).not.toHaveBeenCalled();
    await advance(1);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(5000);
    expect(result.current.message).toBe("Fit scoring complete.");
    expect(settled).toHaveBeenCalledTimes(1);
    await advance(60000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([path, options]) => path === "/jobs/scoring-status" && !options?.method)).toBe(true);
    unmount();
  });

  it("backs off network failures and clears timers and aborts on unmount", async () => {
    request.mockRejectedValue(new Error("network unavailable"));
    const { unmount } = renderHook(() => useScoringStatus(pending));
    await advance(5000);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(9999);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(request).toHaveBeenCalledTimes(2);
    const signal = request.mock.calls[0][1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await advance(120000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops on authentication failure", async () => {
    request.mockRejectedValue(new ApiError({ code: "auth_expired", status: 401, message: "Expired", retryable: false }));
    renderHook(() => useScoringStatus(pending));
    await advance(65000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("pauses while hidden and resumes without a request burst", async () => {
    let hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    request.mockResolvedValue({ enabled: true, status: "pending" });
    const { unmount } = renderHook(() => useScoringStatus(pending));
    await advance(60000);
    expect(request).not.toHaveBeenCalled();
    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(5000);
    expect(request).toHaveBeenCalledTimes(1);
    unmount();
  });

  it.each(["complete", "failed", "superseded", "canceled"] as const)("does not poll terminal %s", async status => {
    renderHook(() => useScoringStatus({ enabled: true, status }));
    await advance(60000);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not poll legacy or disabled responses", async () => {
    renderHook(() => useScoringStatus());
    renderHook(() => useScoringStatus({ enabled: false, status: "pending" }));
    await advance(60000);
    expect(request).not.toHaveBeenCalled();
  });
});
