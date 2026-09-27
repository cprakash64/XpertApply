import { beforeEach, describe, expect, it, vi } from "vitest";
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
  let viewListener: ((tabId: number, view: LaunchViewState | null) => void) | undefined;
  let actions: ApplicationAssistantActions;
  let controller: ApplicationAssistantController;
  let createController: () => ApplicationAssistantController;
  let removeContext: () => void;
  let removeView: () => void;

  beforeEach(() => {
    mount();
    context = { available: true, tabId: 42 };
    view = makeView();
    removeContext = vi.fn();
    removeView = vi.fn();
    actions = {
      startAutofill: vi.fn().mockResolvedValue({ ok: true }),
      clearSession: vi.fn().mockResolvedValue({ ok: true }),
      completeSession: vi.fn().mockResolvedValue({ ok: true }),
      requestSiteAccess: vi.fn().mockResolvedValue(true),
      reportSiteAccess: vi.fn().mockResolvedValue({ ok: true })
    };
    createController = () => createApplicationAssistant({
        document,
        context: {
          get: vi.fn(async () => context),
          subscribe(listener) { contextListener = listener; return removeContext; }
        },
        views: {
          get: vi.fn(async () => view),
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

  it("does not reuse a stale tab after context loss", async () => {
    await controller.refresh();
    context = { available: false };
    contextListener?.();
    await deferred();
    document.getElementById("clear")?.click();
    expect(actions.clearSession).not.toHaveBeenCalled();
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
});
