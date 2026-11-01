import { describe, expect, it, vi } from "vitest";
import { requestAtsOriginInGesture, requestOriginInGesture } from "../toolbarOverlay";

const api = (impl: (req: { origins: string[] }) => Promise<boolean>) => ({ request: vi.fn(impl) }) as unknown as Pick<typeof chrome.permissions, "request"> & { request: ReturnType<typeof vi.fn> };

// XA-RC-06: on careers.withwaymo.com the assistant's "Allow" button did nothing visible and could be clicked forever. The request for
// the origin was only ever made for KNOWN ATS hosts, so a custom careers domain never got Chrome's consent dialog.
describe("XA-RC-06 gesture-bound origin request", () => {
  it("asks Chrome for exactly the custom careers origin, once, and reports a grant", async () => {
    const permissions = api(async () => true);
    await expect(requestOriginInGesture("https://careers.withwaymo.com/jobs/123/apply?gh_jid=1#x", permissions)).resolves.toBe("granted");
    expect(permissions.request).toHaveBeenCalledTimes(1);
    expect(permissions.request).toHaveBeenCalledWith({ origins: ["https://careers.withwaymo.com/*"] });
  });

  it("reports a refusal as a refusal, not as a missing gesture", async () => {
    await expect(requestOriginInGesture("https://careers.withwaymo.com/jobs/1", api(async () => false))).resolves.toBe("denied");
  });

  it("tells a lost user gesture apart from a refusal, so the worker can fall back to Chrome's toolbar request", async () => {
    const lost = api(async () => { throw new Error("This function must be called during a user gesture"); });
    await expect(requestOriginInGesture("https://careers.withwaymo.com/jobs/1", lost)).resolves.toBe("no_gesture");
    const syncThrow = { request: () => { throw new Error("This function must be called during a user gesture"); } } as unknown as Pick<typeof chrome.permissions, "request">;
    await expect(requestOriginInGesture("https://careers.withwaymo.com/jobs/1", syncThrow)).resolves.toBe("no_gesture");
    await expect(requestOriginInGesture("https://careers.withwaymo.com/jobs/1", api(async () => { throw new Error("boom"); }))).resolves.toBe("unavailable");
  });

  it("never requests anything but one exact https host", async () => {
    for (const url of ["http://careers.withwaymo.com/jobs/1", "chrome://extensions", "file:///etc/hosts", "https://*.example.com/", "not a url", null, undefined, ""]) {
      const permissions = api(async () => true);
      await expect(requestOriginInGesture(url as string | null | undefined, permissions), String(url)).resolves.toBe("not_requested");
      expect(permissions.request).not.toHaveBeenCalled();
    }
  });

  it("reports an unavailable API instead of a refusal", async () => {
    await expect(requestOriginInGesture("https://careers.withwaymo.com/jobs/1", undefined as never)).resolves.toBe("unavailable");
  });

  it("keeps the toolbar click and launches limited to known ATS hosts", async () => {
    const original = (globalThis as { chrome?: unknown }).chrome;
    const request = vi.fn(async () => true);
    (globalThis as { chrome?: unknown }).chrome = { permissions: { request } };
    try {
      await expect(requestAtsOriginInGesture("https://careers.withwaymo.com/jobs/123/apply")).resolves.toBe(false);
      expect(request).not.toHaveBeenCalled();
      await expect(requestAtsOriginInGesture("https://job-boards.greenhouse.io/acme/jobs/4012345")).resolves.toBe(true);
      expect(request).toHaveBeenCalledWith({ origins: ["https://job-boards.greenhouse.io/*"] });
    } finally { (globalThis as { chrome?: unknown }).chrome = original; }
  });
});
