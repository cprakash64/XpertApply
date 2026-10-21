import { describe, expect, it, vi } from "vitest";
import { createPermissionsChangedHandler } from "../permissionFlow";
import type { LaunchViewState } from "../messages";

const view = (siteAccess: LaunchViewState["siteAccess"], pattern: string | null): LaunchViewState =>
  ({ siteAccess, siteAccessPattern: pattern } as LaunchViewState);

function harness(views: Record<number, LaunchViewState>) {
  const applied: Array<[number, string, boolean]> = [];
  const patched: Array<[number, Partial<LaunchViewState>]> = [];
  const handler = createPermissionsChangedHandler({
    workflowTabIds: async () => Object.keys(views).map(Number),
    getView: async (tabId) => views[tabId] ?? null,
    patchView: async (tabId, patch) => { patched.push([tabId, patch]); },
    applySiteAccessResult: async (tabId, pattern, granted) => { applied.push([tabId, pattern, granted]); }
  });
  return { handler, applied, patched };
}

const GH = "https://job-boards.greenhouse.io/*";
const LEVER = "https://jobs.lever.co/*";

describe("permission changes reported by Chrome", () => {
  it("resumes only the tab waiting on exactly the origin that was granted", async () => {
    const { handler, applied } = harness({
      1: view("site_access_required", GH),
      2: view("site_access_required", LEVER),
      3: view("site_access_required", null)
    });
    await handler([GH], true);
    expect(applied).toEqual([[1, GH, true]]);
  });

  it("does not repeat work for a tab that is already granted (repeat visit, duplicate event)", async () => {
    const { handler, applied, patched } = harness({ 1: view("site_access_granted", GH) });
    await handler([GH], true);
    await handler([GH], true);
    expect(applied).toEqual([]);
    expect(patched).toEqual([]);
  });

  it("puts a granted tab back to 'access required' when Chrome revokes the origin", async () => {
    const { handler, applied, patched } = harness({ 1: view("site_access_granted", GH), 2: view("site_access_granted", LEVER) });
    await handler([GH], false);
    expect(patched).toEqual([[1, { siteAccess: "site_access_required" }]]);
    expect(applied).toEqual([]);
  });

  it("ignores a revocation for a tab that was never granted, and empty events", async () => {
    const { handler, applied, patched } = harness({ 1: view("site_access_required", GH), 2: view("site_access_denied", LEVER) });
    await handler([GH, LEVER], false);
    await handler([], true);
    expect(applied).toEqual([]);
    expect(patched).toEqual([]);
  });

  it("a denied tab resumes when the user later grants the origin from Chrome's own UI", async () => {
    const { handler, applied } = harness({ 1: view("site_access_denied", GH) });
    await handler([GH], true);
    expect(applied).toEqual([[1, GH, true]]);
  });

  it("one failing resume does not stop the others", async () => {
    const views = { 1: view("site_access_required", GH), 2: view("site_access_required", GH) };
    const applied: number[] = [];
    const handler = createPermissionsChangedHandler({
      workflowTabIds: async () => [1, 2],
      getView: async (id) => views[id as 1 | 2],
      patchView: vi.fn(),
      applySiteAccessResult: async (id) => { applied.push(id); if (id === 1) throw new Error("tab closed"); }
    });
    await handler([GH], true);
    expect(applied).toEqual([1, 2]);
  });
});
