// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ONBOARDING_PATTERNS, anyGrantCovers, grantCovers, grantPatternFor, isSupportedAtsWildcard, siteGroupForHost } from "../siteGrants";
import { planRegistration, registrablePattern, scriptIdFor } from "../siteRegistration";
import { createPermissionsChangedHandler } from "../permissionFlow";
import { createWatchBudget, countFormControls, plausibleApplicationForm } from "../content/formWatch";
import { clearSuppression, forgetOffered, markOffered, suppress, suppressedReason, wasOffered, setOnboarding, getOnboarding } from "../siteAccessStore";
import type { LaunchViewState } from "../messages";

function memoryArea() {
  const data: Record<string, unknown> = {};
  return { get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}), set: async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)); } } as never;
}

describe("supported-ATS group grants", () => {
  it("asks once for the supported ATS domains and nothing else", () => {
    expect([...ONBOARDING_PATTERNS]).toEqual([
      "https://*.greenhouse.io/*", "https://*.lever.co/*", "https://*.ashbyhq.com/*", "https://*.myworkdayjobs.com/*"
    ]);
  });
  it("widens only supported ATS hosts; a custom employer domain stays exact", () => {
    expect(grantPatternFor("https://job-boards.greenhouse.io/*")).toBe("https://*.greenhouse.io/*");
    expect(grantPatternFor("https://jobs.lever.co/*")).toBe("https://*.lever.co/*");
    expect(grantPatternFor("https://acme.wd5.myworkdayjobs.com/*")).toBe("https://*.myworkdayjobs.com/*");
    expect(grantPatternFor("https://careers.example.com/*")).toBe("https://careers.example.com/*");
    // lookalikes are not ATS hosts
    expect(grantPatternFor("https://greenhouse.io.evil.test/*")).toBe("https://greenhouse.io.evil.test/*");
    expect(grantPatternFor("https://notlever.co/*")).toBe("https://notlever.co/*");
    // smartrecruiters etc. are not part of the group grant
    expect(grantPatternFor("https://jobs.smartrecruiters.com/*")).toBe("https://jobs.smartrecruiters.com/*");
    expect(siteGroupForHost("boards.greenhouse.io")?.id).toBe("greenhouse");
  });
  it("matches a group grant to the exact page pattern, and nothing broader", () => {
    expect(grantCovers("https://*.lever.co/*", "https://jobs.lever.co/*")).toBe(true);
    expect(grantCovers("https://*.lever.co/*", "https://lever.co/*")).toBe(true);
    expect(grantCovers("https://*.lever.co/*", "https://jobs.lever.co.evil.test/*")).toBe(false);
    expect(grantCovers("https://*.lever.co/*", "https://jobs.ashbyhq.com/*")).toBe(false);
    expect(grantCovers("https://jobs.lever.co/*", "https://other.lever.co/*")).toBe(false);
    expect(anyGrantCovers(["https://*.greenhouse.io/*"], "https://job-boards.greenhouse.io/*")).toBe(true);
  });
  it("registers only the allowlisted wildcards, never an arbitrary wildcard", () => {
    expect(registrablePattern("https://*.greenhouse.io/*", false)).toBe(true);
    expect(registrablePattern("https://*.example.com/*", false)).toBe(false);
    expect(registrablePattern("https://*/*", false)).toBe(false);
    expect(registrablePattern("*://*.lever.co/*", false)).toBe(false);
    expect(isSupportedAtsWildcard("https://*.lever.co/*")).toBe(true);
    expect(scriptIdFor("https://*.lever.co/*")).toBe("xa-site-ats-lever.co");
  });
  it("serves an exact host covered by a group grant with the group's script only", () => {
    const plan = planRegistration(["https://*.lever.co/*", "https://jobs.lever.co/*", "https://careers.example.com/*"], [], { excluded: [], allowLoopback: false, refresh: false });
    expect(plan.register.map((s) => s.id).sort()).toEqual(["xa-site-ats-lever.co", "xa-site-careers.example.com"]);
    const after = planRegistration(["https://careers.example.com/*"], ["xa-site-ats-lever.co", "xa-site-careers.example.com"], { excluded: [], allowLoopback: false, refresh: false });
    expect(after).toEqual({ register: [], unregister: ["xa-site-ats-lever.co"] });
  });
});

describe("permission changes with group grants", () => {
  const view = (siteAccess: LaunchViewState["siteAccess"], pattern: string) => ({ siteAccess, siteAccessPattern: pattern } as LaunchViewState);
  it("resumes a tab waiting on one host when its ATS group is granted", async () => {
    const applied: Array<[number, string, boolean]> = [];
    const handler = createPermissionsChangedHandler({
      workflowTabIds: async () => [1, 2], getView: async (id) => (id === 1 ? view("site_access_required", "https://jobs.lever.co/*") : view("site_access_required", "https://jobs.ashbyhq.com/*")),
      patchView: async () => undefined, applySiteAccessResult: async (t, p, g) => { applied.push([t, p, g]); }
    });
    await handler(["https://*.lever.co/*"], true);
    expect(applied).toEqual([[1, "https://jobs.lever.co/*", true]]);
  });
  it("does not mark a tab revoked while an exact grant still covers it", async () => {
    const patched: unknown[] = [];
    const handler = createPermissionsChangedHandler({
      workflowTabIds: async () => [1], getView: async () => view("site_access_granted", "https://jobs.lever.co/*"),
      patchView: async (_t, p) => { patched.push(p); }, applySiteAccessResult: async () => undefined,
      stillGranted: async () => true
    });
    await handler(["https://*.lever.co/*"], false);
    expect(patched).toEqual([]);
  });
});

describe("form watch budget", () => {
  it("spends only on real looks and restores on navigation", () => {
    const budget = createWatchBudget({ maxLooks: 2, windowMs: 1000 });
    expect(budget.spend(0)).toBe(true);
    expect(budget.spend(10)).toBe(true);
    expect(budget.spend(20)).toBe(false);
    expect(budget.exhausted(20)).toBe(true);
    budget.reset(30);
    expect(budget.exhausted(40)).toBe(false);
    expect(budget.spend(40)).toBe(true);
  });
  it("expires by time", () => {
    const budget = createWatchBudget({ maxLooks: 5, windowMs: 100 });
    expect(budget.spend(0)).toBe(true);
    expect(budget.spend(500)).toBe(false);
  });
  it("counts form controls cheaply and ignores hidden, search and button inputs", () => {
    document.body.innerHTML = `<input type="hidden"><input type="search"><input type="submit"><div hidden><input></div><input><textarea></textarea>`;
    expect(countFormControls(document)).toBe(2);
    expect(plausibleApplicationForm(document)).toBe(false);
    document.body.innerHTML += `<select></select>`;
    expect(plausibleApplicationForm(document)).toBe(true);
    document.body.innerHTML = `<input type="file">`;
    expect(plausibleApplicationForm(document)).toBe(true);
  });
});

describe("remembered site-access state", () => {
  it("remembers an offer across worker restarts and forgets by prefix", async () => {
    const area = memoryArea();
    expect(await wasOffered("5:https://jobs.lever.co", area)).toBe(false);
    await markOffered("5:https://jobs.lever.co", area);
    expect(await wasOffered("5:https://jobs.lever.co", area)).toBe(true);
    await forgetOffered("5:", area);
    expect(await wasOffered("5:https://jobs.lever.co", area)).toBe(false);
  });
  it("keeps declined and revoked origins out of passive requests until cleared", async () => {
    const area = memoryArea();
    await suppress("https://*.lever.co/*", "revoked", 1, area);
    expect(await suppressedReason("https://*.lever.co/*", area)).toBe("revoked");
    await clearSuppression("https://*.lever.co/*", area);
    expect(await suppressedReason("https://*.lever.co/*", area)).toBeNull();
  });
  it("records the onboarding choice", async () => {
    const area = memoryArea();
    expect(await getOnboarding(area)).toBeNull();
    await setOnboarding("declined", 7, area);
    expect(await getOnboarding(area)).toEqual({ status: "declined", at: 7 });
  });
});
