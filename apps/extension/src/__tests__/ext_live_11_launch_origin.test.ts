import { describe, expect, it, vi } from "vitest";
import { requestLaunchOriginInGesture } from "../toolbarOverlay";
import { applicationProviderForUrl, providerForUrl } from "../ats/providers";
import { SITE_GROUPS, grantCovers, grantPatternFor, siteGroupForHost } from "../siteGrants";

/** EXT-LIVE-11: the Apply click names the destination; Workable is a known provider with an exact-host grant. */
describe("requestLaunchOriginInGesture", () => {
  const request = (granted: boolean) => vi.fn().mockResolvedValue(granted);
  it("asks for exactly the employer origin of a launch to an unknown custom domain (never a wildcard)", async () => {
    const api = request(true);
    const original = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = { permissions: { request: api } };
    try {
      expect(await requestLaunchOriginInGesture("https://careers.acme-corp.example/jobs/1/apply")).toBe("granted");
      expect(api).toHaveBeenCalledWith({ origins: ["https://careers.acme-corp.example/*"] });
    } finally { (globalThis as { chrome?: unknown }).chrome = original; }
  });
  it("asks for the group grant of a supported ATS, and for Workable exactly apply.workable.com", async () => {
    const api = request(true);
    const original = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = { permissions: { request: api } };
    try {
      await requestLaunchOriginInGesture("https://job-boards.greenhouse.io/acme/jobs/123");
      await requestLaunchOriginInGesture("https://apply.workable.com/acme-co/j/ABC123DEF4/apply/");
      expect(api).toHaveBeenNthCalledWith(1, { origins: ["https://*.greenhouse.io/*"] });
      expect(api).toHaveBeenNthCalledWith(2, { origins: ["https://apply.workable.com/*"] });
    } finally { (globalThis as { chrome?: unknown }).chrome = original; }
  });
  it("reports a refusal as 'denied' (so it is respected) and never asks for a provider with no fill engine", async () => {
    const original = (globalThis as { chrome?: unknown }).chrome;
    const api = request(false);
    (globalThis as { chrome?: unknown }).chrome = { permissions: { request: api } };
    try {
      expect(await requestLaunchOriginInGesture("https://apply.workable.com/acme-co/j/ABC123DEF4/apply/")).toBe("denied");
      expect(await requestLaunchOriginInGesture("https://www.indeed.com/viewjob?jk=1")).toBe("not_requested");
      expect(api).toHaveBeenCalledTimes(1);
    } finally { (globalThis as { chrome?: unknown }).chrome = original; }
  });
  it("never requests plain http or a non-origin", async () => {
    const api = request(true);
    const original = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = { permissions: { request: api } };
    try {
      expect(await requestLaunchOriginInGesture("http://careers.acme-corp.example/jobs/1")).toBe("not_requested");
      expect(await requestLaunchOriginInGesture("not a url")).toBe("not_requested");
      expect(api).not.toHaveBeenCalled();
    } finally { (globalThis as { chrome?: unknown }).chrome = original; }
  });
});

describe("Workable provider and grant", () => {
  it("recognises only its application page, on apply.workable.com", () => {
    expect(applicationProviderForUrl("https://apply.workable.com/acme-co/j/ABC123DEF4/apply/")?.id).toBe("workable");
    expect(applicationProviderForUrl("https://apply.workable.com/acme-co/j/ABC123DEF4/")).toBeNull();         // the posting, not the form
    expect(applicationProviderForUrl("https://apply.workable.com/acme-co/")).toBeNull();                          // a company listing
    expect(providerForUrl("https://careers.workable.com/")).toBeNull();                                           // other hosts are not widened
    expect(providerForUrl("https://apply.workable.com.evil.test/acme/j/ABC123DEF4/apply/")).toBeNull();
  });
  it("the grant is the one verified host; lookalikes and sibling hosts are not covered", () => {
    expect(siteGroupForHost("apply.workable.com")?.id).toBe("workable");
    expect(siteGroupForHost("jobs.workable.com")).toBeNull();
    expect(grantPatternFor("https://apply.workable.com/*")).toBe("https://apply.workable.com/*");
    expect(grantCovers("https://apply.workable.com/*", "https://apply.workable.com/*")).toBe(true);
    expect(grantCovers("https://apply.workable.com/*", "https://evil.workable.com/*")).toBe(false);
    expect(SITE_GROUPS.find((g) => g.id === "workable")?.pattern).toBe("https://apply.workable.com/*");
  });
});
