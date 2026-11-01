import { describe, expect, it, vi } from "vitest";
import { PROVIDERS, applicationProviderForUrl, providerForUrl } from "../ats/providers";
import { createSiteRegistrar, planRegistration, registrablePattern, scriptIdFor } from "../siteRegistration";
import { activationLabel, deriveActivationState } from "../activation";
import { isAutoOpenDisabled, setAutoOpenDisabled } from "../activationPrefs";
import { requestAtsOriginInGesture } from "../toolbarOverlay";

describe("provider registry", () => {
  it.each([
    ["https://job-boards.greenhouse.io/acme/jobs/4012345", "greenhouse"],
    ["https://boards.greenhouse.io/acme/jobs/123", "greenhouse"],
    ["https://jobs.lever.co/zoox/11111111-2222-3333-4444-555555555555/apply", "lever"],
    ["https://jobs.ashbyhq.com/acme/abc123/application", "ashby"],
    ["https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Remote/Engineer_R1/apply", "workday"],
    ["https://jobs.smartrecruiters.com/Acme/743999/apply", "smartrecruiters"],
    ["https://acme.applytojob.com/apply/AbC123/Engineer", "jazzhr"],
    ["https://careers.teamtailor.com/jobs/123456-engineer", "teamtailor"]
  ])("recognises the application page %s as %s", (url, id) => {
    expect(applicationProviderForUrl(url)?.id).toBe(id);
  });

  it.each([
    "https://job-boards.greenhouse.io/acme",            // company listing
    "https://boards.greenhouse.io/",                     // marketing/home
    "https://jobs.lever.co/zoox",                        // listing
    "https://jobs.lever.co/zoox/11111111-2222-3333-4444-555555555555", // job description, not the apply page
    "https://jobs.ashbyhq.com/acme",
    "https://www.greenhouse.io/blog/hiring",
    "https://greenhouse.io.evil.test/acme/jobs/1",       // suffix lookalike
    "http://boards.greenhouse.io/acme/jobs/1",           // not https
    "https://evil.test/?u=boards.greenhouse.io/acme/jobs/1"
  ])("does not treat %s as an application page", (url) => {
    expect(applicationProviderForUrl(url)).toBeNull();
  });

  it("is honest about Indeed and about the limited providers", () => {
    expect(providerForUrl("https://apply.indeed.com/x")?.support).toBe("unsupported");
    expect(applicationProviderForUrl("https://apply.indeed.com/x")).toBeNull();
    expect(Object.fromEntries(PROVIDERS.map((p) => [p.id, p.support]))).toMatchObject({
      greenhouse: "adapter", lever: "adapter", ashby: "adapter", workday: "limited", smartrecruiters: "limited",
      rippling: "limited", bamboohr: "limited", jazzhr: "limited", teamtailor: "limited", indeed: "unsupported"
    });
  });
});

describe("persistent registration plan", () => {
  const opts = { excluded: ["https://xpertapply.com/*", "https://www.xpertapply.com/*"], allowLoopback: false, refresh: false };

  it("registers one script per granted exact origin and nothing broader", () => {
    const plan = planRegistration([
      "https://job-boards.greenhouse.io/*", "https://jobs.lever.co/*",
      "https://*/*", "*://*/*", "https://*.lever.co/*", "http://insecure.example/*", "file:///*", "https://xpertapply.com/*",
      "https://api.xpertapply.com/*"
    ], [], opts);
    expect(plan.register.map((s) => s.matches[0]).sort()).toEqual([
      "https://api.xpertapply.com/*", "https://job-boards.greenhouse.io/*", "https://jobs.lever.co/*"
    ]);
    expect(plan.unregister).toEqual([]);
    for (const script of plan.register) {
      expect(script).toMatchObject({ js: ["content.js"], runAt: "document_idle", allFrames: false, persistAcrossSessions: true });
    }
  });

  it("is idempotent: a second pass with everything registered does nothing", () => {
    const granted = ["https://jobs.lever.co/*"];
    const first = planRegistration(granted, [], opts);
    expect(planRegistration(granted, first.register.map((s) => s.id), opts)).toEqual({ register: [], unregister: [] });
  });

  it("removes the script when Chrome no longer grants the origin, and never touches ids it did not create", () => {
    const plan = planRegistration([], [scriptIdFor("https://jobs.lever.co/*"), "someone-elses-script"], opts);
    expect(plan.unregister).toEqual([scriptIdFor("https://jobs.lever.co/*")]);
    expect(plan.register).toEqual([]);
  });

  it("refresh replaces existing registrations (after an extension update)", () => {
    const id = scriptIdFor("https://jobs.lever.co/*");
    const plan = planRegistration(["https://jobs.lever.co/*"], [id], { ...opts, refresh: true });
    expect(plan.unregister).toEqual([id]);
    expect(plan.register.map((s) => s.id)).toEqual([id]);
  });

  it("plain-http loopback only when a non-production build allows it", () => {
    expect(registrablePattern("http://localhost/*", false)).toBe(false);
    expect(registrablePattern("http://localhost/*", true)).toBe(true);
    expect(registrablePattern("http://evil.example/*", true)).toBe(false);
  });

  it("serialises concurrent reconciles so a grant and a startup cannot race", async () => {
    const order: string[] = [];
    const grants = [["https://jobs.lever.co/*"], []];   // what Chrome reports on the 1st and 2nd reconcile
    let call = 0;
    const registered: string[] = [];
    const reconcile = createSiteRegistrar({
      grantedOrigins: async () => { await Promise.resolve(); return grants[Math.min(call++, 1)]; },
      registeredIds: async () => [...registered],
      register: async (scripts) => { order.push(`add:${scripts.length}`); registered.push(...scripts.map((s) => s.id)); },
      unregister: async (ids) => { order.push(`rm:${ids.length}`); for (const id of ids) registered.splice(registered.indexOf(id), 1); },
      options: async () => ({ excluded: [], allowLoopback: false })
    });
    const a = reconcile();
    const b = reconcile();
    await Promise.all([a, b]);
    expect(order).toEqual(["add:1", "rm:1"]);
    expect(registered).toEqual([]);
  });
});

describe("activation states", () => {
  const base = { siteAccess: "no_workflow", siteAccessRequestedAt: undefined, contentReady: false, packageLoaded: false, running: false,
    state: "idle", failureCode: null, failureRecoverable: null, atsId: null, sessionId: null, reviewRequired: 0, fieldsDiscovered: 0 } as const;
  const view = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as Parameters<typeof deriveActivationState>[0];

  it.each([
    [{ siteAccess: "site_access_required" }, "SITE_ACCESS_REQUIRED"],
    [{ siteAccess: "site_access_required", siteAccessRequestedAt: 1 }, "SITE_ACCESS_REQUESTED"],
    [{ siteAccess: "site_access_denied" }, "SITE_ACCESS_DENIED"],
    [{ siteAccess: "site_access_revoked" }, "SITE_ACCESS_REVOKED"],
    [{ siteAccess: "site_access_granted", contentReady: true }, "CONTENT_SCRIPT_READY"],
    [{ siteAccess: "site_access_granted" }, "SITE_ACCESS_GRANTED"],
    [{ contentReady: true, atsId: "greenhouse", failureCode: "DIRECT_VISIT_NO_SESSION" }, "APPLICATION_DETECTED"],
    [{ sessionId: 1, packageLoaded: true, fieldsDiscovered: 0, contentReady: true }, "APPLICATION_DETECTED"],
    [{ sessionId: 1, packageLoaded: true, fieldsDiscovered: 12, contentReady: true, state: "discovering_fields" }, "AUTOFILL_READY"],
    [{ running: true, sessionId: 1, packageLoaded: true }, "AUTOFILL_RUNNING"],
    [{ state: "completed_with_review", sessionId: 1, packageLoaded: true, reviewRequired: 3 }, "REVIEW_REQUIRED"],
    [{ failureCode: "SESSION_UNAUTHORIZED" }, "ERROR"]
  ])("%j -> %s", (patch, expected) => {
    expect(deriveActivationState(view(patch))).toBe(expected);
  });

  it("never reports 'ready' while site access is missing, and names the site", () => {
    const missing = deriveActivationState(view({ siteAccess: "site_access_required", contentReady: true, sessionId: 1, packageLoaded: true, fieldsDiscovered: 9 }));
    expect(missing).toBe("SITE_ACCESS_REQUIRED");
    expect(activationLabel(missing, "job-boards.greenhouse.io")).toBe("Permission required for job-boards.greenhouse.io");
    expect(activationLabel("SITE_ACCESS_REQUESTED", null)).toBe("Waiting for your approval in Chrome");
    expect(activationLabel("AUTOFILL_RUNNING", null)).toBeNull();
  });
});

describe("per-site off switch", () => {
  it("stores origins only and can be undone", async () => {
    const store: Record<string, unknown> = {};
    const area = { get: async (k: string) => ({ [k]: store[k] }), set: async (v: Record<string, unknown>) => { Object.assign(store, v); } } as never;
    expect(await isAutoOpenDisabled("https://jobs.lever.co", area)).toBe(false);
    await setAutoOpenDisabled("https://jobs.lever.co", true, area);
    expect(await isAutoOpenDisabled("https://jobs.lever.co", area)).toBe(true);
    expect(await isAutoOpenDisabled("https://boards.greenhouse.io", area)).toBe(false);
    await setAutoOpenDisabled("https://jobs.lever.co", false, area);
    expect(await isAutoOpenDisabled("https://jobs.lever.co", area)).toBe(false);
    expect(JSON.stringify(store)).not.toMatch(/apply|jobs\/|[?#]/);
  });
});

describe("gesture-bound origin request", () => {
  it("asks Chrome synchronously, for a known ATS origin only", async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal("chrome", { permissions: { request } });
    const pending = requestAtsOriginInGesture("https://jobs.lever.co/zoox/abc/apply");
    expect(request).toHaveBeenCalledTimes(1);              // called before the first await resolves
    expect(request).toHaveBeenCalledWith({ origins: ["https://jobs.lever.co/*"] });
    expect(await pending).toBe(true);
    for (const url of ["https://example.com/", "https://apply.indeed.com/x", "http://jobs.lever.co/x", null, undefined, "chrome://extensions"]) {
      expect(await requestAtsOriginInGesture(url as string)).toBe(false);
    }
    expect(request).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("a dismissed or failing dialog resolves false instead of throwing", async () => {
    vi.stubGlobal("chrome", { permissions: { request: vi.fn(async () => { throw new Error("user cancelled"); }) } });
    expect(await requestAtsOriginInGesture("https://jobs.lever.co/x/y/apply")).toBe(false);
    vi.unstubAllGlobals();
  });
});
