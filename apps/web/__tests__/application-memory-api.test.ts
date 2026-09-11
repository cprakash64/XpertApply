import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelApplicationDeletion, fetchHistoricalDocument, getApplicationSnapshot, listApplicationSnapshots } from "../lib/api";

describe("application memory API", () => {
  beforeEach(() => localStorage.setItem("jobpilot_token", "token"));
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["list", () => listApplicationSnapshots(11), "/jobs/tracker/11/snapshots", undefined],
    ["detail", () => getApplicationSnapshot(11, 501), "/jobs/tracker/11/snapshots/501", undefined],
    ["cancel", () => cancelApplicationDeletion(11), "/jobs/tracker/11/cancel-deletion", "POST"]
  ])("uses the owner-scoped %s endpoint", async (_name, invoke, path, method) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ snapshots: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await invoke();
    expect(fetchMock).toHaveBeenCalledWith(`http://localhost:8000${path}`, expect.objectContaining({
      ...(method ? { method } : {}), headers: expect.objectContaining({ Authorization: "Bearer token" })
    }));
  });

  it("retrieves the exact historical document through authenticated response handling", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("document", { status: 200 }));
    const response = await fetchHistoricalDocument(77, "pdf");
    expect(await response.text()).toBe("document");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8000/jobs/documents/77/download/pdf", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token" }) }));
  });
});
