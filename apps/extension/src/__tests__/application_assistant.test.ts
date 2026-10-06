import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentReadyViewPatch, projectWorkflowProgress } from "../content/workflowProgress";
import type { ProgressPayload } from "../messages";
import type { LaunchViewState } from "../messages";
import {
  createApplicationAssistant,
  type ApplicationAssistantActions,
  type ApplicationAssistantContext,
  type ApplicationAssistantController
} from "../ui/applicationAssistant";

const ids = ["job", "stage", "ats", "discovered", "filled", "skipped", "review", "limited", "final", "resume", "cover", "errors", "siteAccess", "siteAccessText", "diag", "diagBody"];
const buttons = ["fill", "rescan", "next", "clear", "complete", "grantSiteAccess"];

function mount(): void {
  document.body.innerHTML = [
    ...ids.map((id) => `<div id="${id}" hidden></div>`),
    ...buttons.map((id) => `<button id="${id}">${id}</button>`)
  ].join("");
}

function makeView(overrides: Partial<LaunchViewState> = {}): LaunchViewState {
  return {
    tabId: 42,
    requestId: "request-1",
    sessionId: 7,
    state: "completed_with_review",
    company: "Example Co",
    jobTitle: "Engineer",
    atsId: "greenhouse",
    atsDisplayName: "Greenhouse",
    limited: false,
    fieldsDiscovered: 6,
    filled: 4,
    skipped: 1,
    reviewRequired: 1,
    requiredReviewRemaining: 0,
    resumeStatus: "uploaded",
    coverStatus: "review",
    reachedFinalStep: true,
    contentReady: true,
    packageLoaded: true,
    running: false,
    failureCode: null,
    failureMessage: null,
    confirmationRequired: false,
    confirmationDismissed: false,
    submissionGestureAt: null,
    submissionAttempt: 0,
    failureRecoverable: null,
    siteAccess: "site_access_granted",
    siteAccessPattern: null,
    siteAccessOrigin: null,
    siteAccessScope: "page",
    updatedAt: 1,
    ...overrides
  };
}

function deferred(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("shared application assistant", () => {
  let context: ApplicationAssistantContext;
  let view: LaunchViewState | null;
  let contextListener: (() => void) | undefined;
  let viewListener: ((tabId: number, view: LaunchViewState | null | undefined) => void) | undefined;
  let actions: ApplicationAssistantActions;
  let controller: ApplicationAssistantController;
  let createController: () => ApplicationAssistantController;
  let removeContext: () => void;
  let removeView: () => void;
  let getContext: () => Promise<ApplicationAssistantContext>;
  let getView: (tabId: number) => Promise<LaunchViewState | null>;

  beforeEach(() => {
    mount();
    context = { available: true, tabId: 42 };
    view = makeView();
    removeContext = vi.fn();
    removeView = vi.fn();
    getContext = vi.fn(async (): Promise<ApplicationAssistantContext> => context);
    getView = vi.fn(async (_tabId: number): Promise<LaunchViewState | null> => view);
    actions = {
      startAutofill: vi.fn().mockResolvedValue({ ok: true }),
      clearSession: vi.fn().mockResolvedValue({ ok: true }),
      completeSession: vi.fn().mockResolvedValue({ ok: true }),
      requestSiteAccess: vi.fn().mockResolvedValue(true),
      reportSiteAccess: vi.fn().mockResolvedValue({ ok: true })
    };
    createController = () => createApplicationAssistant({
        root: document,
        confirmAction: (message) => window.confirm(message),
        context: {
          get: getContext,
          subscribe(listener) { contextListener = listener; return removeContext; }
        },
        views: {
          get: getView,
          subscribe(listener) { viewListener = listener; return removeView; }
        },
        actions,
        diagnostics: { enabled: false, surface: "sidePanel" }
      });
    controller = createController();
  });

  it("renders authenticated workflow, discovery counts, documents, and manual-submit warning", async () => {
    await controller.refresh();
    expect(document.getElementById("job")?.textContent).toBe("Engineer · Example Co");
    expect(document.getElementById("stage")?.textContent).toContain("review");
    expect(document.getElementById("discovered")?.textContent).toBe("6");
    expect(document.getElementById("resume")?.textContent).toBe("Uploaded ✓");
    expect((document.getElementById("final") as HTMLElement).hidden).toBe(false);
  });

  it("presents unauthenticated and other worker failures without weakening their message", async () => {
    view = makeView({ failureCode: "SESSION_UNAUTHORIZED", state: "failed", failureRecoverable: false });
    await controller.refresh();
    expect(document.getElementById("errors")?.textContent).toContain("session is no longer valid");
    expect((document.getElementById("fill") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the safe-limit explanation when the authoritative failure arrives after terminal status", async () => {
    view = makeView({ state: "failed", failureCode: null });
    await controller.refresh();
    expect((document.getElementById("errors") as HTMLElement).hidden).toBe(true);
    view = makeView({ state: "failed", failureCode: "APPLICATION_FORM_TOO_LARGE", filled: 0 });
    viewListener?.(42, view);
    await vi.waitFor(() => {
      const errors = document.getElementById("errors")!;
      expect(errors.hidden).toBe(false);
      expect(errors.textContent).toContain("safe limit of 1,000");
      expect(errors.textContent).toContain("Nothing was filled");
      expect(errors.textContent).not.toContain("Something went wrong while preparing");
    });
  });

  it("preserves generic preparation copy for an unknown failure and renders no raw failure text", async () => {
    view = makeView({ state: "failed", failureCode: "UNKNOWN_PREPARATION_FAILURE", failureMessage: "<img src=x onerror=alert(1)>" });
    await controller.refresh();
    expect(document.getElementById("errors")?.textContent).toBe("Something went wrong while preparing this application. Try again or reopen it from XpertApply.");
    expect(document.getElementById("errors")?.querySelector("img")).toBeNull();
  });

  it("renders unsupported/no-view state and disables actions", async () => {
    view = null;
    await controller.refresh();
    expect(document.getElementById("stage")?.textContent).toContain("Open an application");
    expect((document.getElementById("fill") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables actions when explicit tab context is absent", async () => {
    context = { available: false };
    await controller.refresh();
    document.getElementById("fill")?.click();
    expect(actions.startAutofill).not.toHaveBeenCalled();
    expect(document.getElementById("stage")?.textContent).toContain("No active application tab");
  });

  it("routes fill, continue, and clear through the provided tab only", async () => {
    await controller.refresh();
    document.getElementById("fill")?.click();
    document.getElementById("rescan")?.click();
    document.getElementById("clear")?.click();
    await deferred();
    expect(actions.startAutofill).toHaveBeenNthCalledWith(1, 42, "manual_retry");
    expect(actions.startAutofill).toHaveBeenNthCalledWith(2, 42, "continue_after_navigation");
    expect(actions.clearSession).toHaveBeenCalledWith(42);
  });

  it("surfaces fill action errors", async () => {
    vi.mocked(actions.startAutofill).mockResolvedValue({ ok: false, error: "NO_FIELDS_DISCOVERED" });
    await controller.refresh();
    document.getElementById("fill")?.click();
    await deferred();
    expect(document.getElementById("errors")?.textContent).toContain("No fillable fields");
  });

  it("requests only the worker-provided origin from the direct permission click", async () => {
    view = makeView({ siteAccess: "site_access_required", siteAccessPattern: "https://jobs.example/*", siteAccessOrigin: "jobs.example" });
    await controller.refresh();
    expect(actions.requestSiteAccess).not.toHaveBeenCalled();
    document.getElementById("grantSiteAccess")?.click();
    await deferred();
    expect(actions.requestSiteAccess).toHaveBeenCalledWith("https://jobs.example/*");
    expect(actions.reportSiteAccess).toHaveBeenCalledWith(42, "https://jobs.example/*", true);
  });

  it("preserves permission denial presentation", async () => {
    view = makeView({ siteAccess: "site_access_denied", siteAccessPattern: "https://jobs.example/*", siteAccessOrigin: "jobs.example" });
    vi.mocked(actions.requestSiteAccess).mockResolvedValue(false);
    await controller.refresh();
    expect(document.getElementById("siteAccessText")?.textContent).toContain("Access was declined");
    document.getElementById("grantSiteAccess")?.click();
    await deferred();
    expect(document.getElementById("errors")?.textContent).toContain("without access");
  });

  it("reacts to permission revocation and runtime/storage view updates", async () => {
    await controller.refresh();
    viewListener?.(42, makeView({ siteAccess: "site_access_required", siteAccessPattern: "https://frame.example/*" }));
    expect((document.getElementById("siteAccess") as HTMLElement).hidden).toBe(false);
    viewListener?.(99, makeView({ tabId: 99, filled: 99 }));
    expect(document.getElementById("filled")?.textContent).toBe("4");
  });

  it("refreshes when the context adapter reports a tab change", async () => {
    await controller.refresh();
    context = { available: false };
    contextListener?.();
    await deferred();
    expect((document.getElementById("fill") as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["detecting_ats", "discovering_fields", "package_ready", "filling", "completed_with_review", "failed"] as const)(
    "preserves legitimate %s state and zero ledger counts", state => {
      const projected = projectWorkflowProgress({
        state, atsId: null, atsDisplayName: null, limited: false,
        fieldsDiscovered: 0, filled: 0, skipped: 0, reviewRequired: 0,
        reachedFinalStep: false, documentsUploaded: [], reviewDocuments: []
      }, { discovered: 0, filled_and_verified: 0, needs_information: 0,
        needs_confirmation: 0, needs_user_gesture: 0, technical_issues: 0,
        legal_manual_actions: 0, optional_skipped: 0, unsupported: 0 });
      expect(projected).toMatchObject({ state, fieldsDiscovered: 0, filled: 0, reviewRequired: 0 });
      expect(contentReadyViewPatch(makeView({ state, packageLoaded: true }))).toMatchObject({ state, contentReady: true });
    }
  );

  it("renders ledger progress after a committed view invalidation without polling", async () => {
    view = makeView({ state: "detecting_ats", packageLoaded: false, fieldsDiscovered: 0, filled: 0, reviewRequired: 0 });
    const state = await import("../state");
    const stored: Record<string, unknown> = {};
    const invalidate = vi.fn(() => viewListener?.(0, undefined));
    let emit = false;
    const oldChrome = globalThis.chrome;
    vi.stubGlobal("chrome", { storage: { session: {
      get: async (key: string) => structuredClone({ [key]: stored[key] }),
      set: async (values: Record<string, unknown>) => {
        Object.assign(stored, structuredClone(values));
        if (emit) invalidate(); // storage.onChanged -> payload-free event
      }
    } } });
    try {
      await state.putView(42, view!);
      vi.mocked(getView).mockImplementation(tabId => state.getView(tabId));
      await controller.refresh();
      emit = true;
      expect(document.getElementById("discovered")?.textContent).toBe("0");
      expect(document.getElementById("filled")?.textContent).toBe("0");
      const progress = projectWorkflowProgress({
        state: "completed_with_review", atsId: "greenhouse", atsDisplayName: "Greenhouse",
        limited: false, fieldsDiscovered: 0, filled: 0, skipped: 0, reviewRequired: 0,
        reachedFinalStep: true, documentsUploaded: ["resume"], reviewDocuments: []
      } satisfies ProgressPayload, {
        discovered: 9, filled_and_verified: 2, needs_information: 1,
        needs_confirmation: 0, needs_user_gesture: 0, technical_issues: 5,
        legal_manual_actions: 1, optional_skipped: 0, unsupported: 0
      });
      await state.patchView(42, contentReadyViewPatch);
      expect((await state.getView(42))?.state).toBe("fetching_package");
      // Use the production serialized worker store. Its storage event triggers
      // the canonical fresh-view adapter; there is no manual renderer update.
      await state.patchView(42, { ...progress, packageLoaded: true });
      await vi.waitFor(() => expect(document.getElementById("filled")?.textContent).toBe("2"));
      expect(document.getElementById("discovered")?.textContent).toBe("9");
      expect(document.getElementById("review")?.textContent).toBe("7");
      expect(document.getElementById("stage")?.textContent).toContain("review");
      expect(progress.documentsUploaded).toEqual(["resume"]);
      const accepted = await state.getView(42);
      await state.patchView(42, contentReadyViewPatch);
      expect(await state.getView(42)).toMatchObject({
        state: "completed_with_review", fieldsDiscovered: 9, filled: 2, reviewRequired: 7
      });
      expect((await state.getView(42))?.sessionId).toBe(accepted?.sessionId);
      expect(invalidate).toHaveBeenCalledTimes(3);
      await vi.waitFor(() => expect(document.getElementById("stage")?.textContent).toContain("review"));
    } finally { vi.stubGlobal("chrome", oldChrome); }
  });

  it("coalesces duplicate payload-free invalidations and fetches authoritative state", async () => {
    await controller.refresh();
    vi.mocked(getContext).mockClear();
    vi.mocked(getView).mockClear();
    view = makeView({ filled: 9 });
    viewListener?.(0, undefined);
    viewListener?.(0, undefined);
    await vi.waitFor(() => expect(document.getElementById("filled")?.textContent).toBe("9"));
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(getView).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale refresh response after a newer generation renders", async () => {
    controller.dispose();
    let resolveOld!: (value: ApplicationAssistantContext) => void;
    let calls = 0;
    controller = createApplicationAssistant({
      root: document,
      confirmAction: vi.fn(async () => true),
      context: {
        get: vi.fn(() => ++calls === 1
          ? new Promise<ApplicationAssistantContext>((resolve) => { resolveOld = resolve; })
          : Promise.resolve({ available: true, tabId: 42 })),
        subscribe: () => () => undefined
      },
      views: { get: async () => makeView({ filled: 8 }), subscribe: () => () => undefined },
      actions
    });
    const old = controller.refresh();
    await controller.refresh();
    expect(document.getElementById("filled")?.textContent).toBe("8");
    resolveOld({ available: false });
    await old;
    expect(document.getElementById("filled")?.textContent).toBe("8");
  });

  it("does not mutate presentation when an in-flight refresh resolves after dispose", async () => {
    controller.dispose();
    let resolveContext!: (value: ApplicationAssistantContext) => void;
    controller = createApplicationAssistant({
      root: document,
      confirmAction: vi.fn(async () => true),
      context: {
        get: () => new Promise<ApplicationAssistantContext>((resolve) => { resolveContext = resolve; }),
        subscribe: () => () => undefined
      },
      views: { get: async () => makeView({ filled: 9 }), subscribe: () => () => undefined },
      actions
    });
    const pending = controller.refresh();
    controller.dispose();
    resolveContext({ available: true, tabId: 42 });
    await pending;
    expect(document.getElementById("filled")?.textContent).not.toBe("9");
  });

  it("does not reuse a stale tab after context loss", async () => {
    await controller.refresh();
    context = { available: false };
    contextListener?.();
    await deferred();
    document.getElementById("clear")?.click();
    expect(actions.clearSession).not.toHaveBeenCalled();
  });

  it("disables Complete with required review and preserves review guidance", async () => {
    view = makeView({ requiredReviewRemaining: 2 });
    await controller.refresh();
    const complete = document.getElementById("complete") as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
    expect(complete.getAttribute("aria-describedby")).toBe("stage review");
    complete.click();
    expect(actions.completeSession).not.toHaveBeenCalled();
  });

  it("fails closed when the required-review projection is absent", async () => {
    view = makeView({ requiredReviewRemaining: undefined });
    await controller.refresh();
    expect((document.getElementById("complete") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps completion manual and reports only the session after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await controller.refresh();
    document.getElementById("complete")?.click();
    await deferred();
    expect(confirmSpy).toHaveBeenCalled();
    expect(actions.completeSession).toHaveBeenCalledWith(42, 7);
  });

  it("disposes subscriptions once and recreates without duplicate DOM actions", async () => {
    await controller.refresh();
    controller.dispose();
    controller.dispose();
    expect(vi.mocked(removeContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(removeView)).toHaveBeenCalledTimes(1);
    document.getElementById("fill")?.click();
    expect(actions.startAutofill).not.toHaveBeenCalled();
    const replacement = createController();
    await replacement.refresh();
    document.getElementById("fill")?.click();
    await deferred();
    expect(actions.startAutofill).toHaveBeenCalledTimes(1);
    replacement.dispose();
  });

  it("scopes every lookup to the supplied ShadowRoot", async () => {
    document.body.innerHTML = '<div id="job">employer decoy</div><div id="errors">employer error</div>';
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = [
      ...ids.map((id) => `<div id="${id}" hidden></div>`),
      ...buttons.map((id) => `<button id="${id}">${id}</button>`)
    ].join("");
    const isolated = createApplicationAssistant({
      root,
      confirmAction: vi.fn(async () => true),
      context: { get: async () => context, subscribe: () => () => undefined },
      views: { get: async () => view, subscribe: () => () => undefined },
      actions,
      diagnostics: { enabled: false, surface: "sidePanel" }
    });
    await isolated.refresh();
    expect(root.getElementById("job")?.textContent).toBe("Engineer · Example Co");
    expect(document.getElementById("job")?.textContent).toBe("employer decoy");
    isolated.dispose();
  });

  it("uses the injected confirmation adapter and cancels safely", async () => {
    const confirmAction = vi.fn(async () => false);
    controller.dispose();
    controller = createApplicationAssistant({
      root: document,
      confirmAction,
      context: { get: async () => context, subscribe: () => () => undefined },
      views: { get: async () => view, subscribe: () => () => undefined },
      actions,
      diagnostics: { enabled: false, surface: "sidePanel" }
    });
    await controller.refresh();
    document.getElementById("complete")?.click();
    await deferred();
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(actions.completeSession).not.toHaveBeenCalled();
  });

  it("fails deterministically when a required scoped control is missing", () => {
    document.getElementById("fill")?.remove();
    expect(() => createController()).toThrow("Missing application assistant element: fill");
  });
});
