import { activationLabel, deriveActivationState } from "../activation";
import { completionFailure } from "../completionAuthority";
import { BUILD_INFO } from "../buildInfo";
import { PROTOCOL_VERSION, type AutofillReason, type LaunchViewState } from "../messages";

export interface ApplicationAssistantContext {
  tabId?: number;
  available: boolean;
  status?: "bound" | "waiting" | "missing" | "unsupported";
}

export interface ActionResponse {
  ok?: boolean;
  error?: string;
}

export interface ApplicationAssistantActions {
  startAutofill(tabId: number, reason: AutofillReason): Promise<ActionResponse | undefined>;
  clearSession(tabId: number): Promise<ActionResponse | undefined>;
  completeSession(tabId: number, sessionId: number): Promise<ActionResponse | undefined>;
  /** true/false: Chrome answered here. "deferred": the request continues on another extension page. */
  requestSiteAccess(pattern: string): Promise<boolean | "deferred">;
  reportSiteAccess(tabId: number, pattern: string, granted: boolean): Promise<ActionResponse | undefined>;
  /** The user's off switch: stop opening the assistant by itself on this site. Only the in-page assistant offers it. */
  disableAutoOpen?(): Promise<ActionResponse | undefined>;
  /** Who the extension is signed in as (email only, never a token). Only the in-page assistant offers it. */
  authState?(): Promise<{ ok?: boolean; state?: { status: "signed_out" } | { status: "signed_in"; email: string } } | undefined>;
  disconnect?(): Promise<{ ok?: boolean; state?: { status: string } } | undefined>;
}

export interface ApplicationAssistantContextAdapter {
  get(): Promise<ApplicationAssistantContext>;
  subscribe(listener: () => void): () => void;
}

export interface ApplicationAssistantViewAdapter {
  get(tabId: number): Promise<LaunchViewState | null>;
  /** `view === undefined` is a payload-free invalidation; fetch authority. */
  subscribe(listener: (tabId: number, view: LaunchViewState | null | undefined) => void): () => void;
}

export interface ApplicationAssistantOptions {
  root: AssistantLookupRoot;
  context: ApplicationAssistantContextAdapter;
  views: ApplicationAssistantViewAdapter;
  actions: ApplicationAssistantActions;
  confirmAction: (message: string) => boolean | Promise<boolean>;
  diagnostics?: {
    enabled: boolean;
    surface: string;
  };
}

/** The controller needs only ID-scoped lookup, not ambient page access. */
export interface AssistantLookupRoot {
  getElementById(id: string): HTMLElement | null;
}

export interface ApplicationAssistantController {
  refresh(): Promise<void>;
  dispose(): void;
}

const STAGE_LABEL: Record<string, string> = {
  idle: "Idle",
  preparing: "Preparing…",
  package_ready: "Ready",
  opening_tab: "Opening application…",
  waiting_for_tab: "Opening application…",
  waiting_for_content_script: "Loading the application form…",
  fetching_package: "Loading your prepared application…",
  detecting_ats: "Detecting application…",
  discovering_fields: "Reading the form…",
  filling: "Filling your application…",
  completed: "Filled — review and submit",
  completed_with_review: "Filled — some items need your review",
  failed: "Something needs your attention"
};

const FAILURE_LABEL: Record<string, string> = {
  DIRECT_VISIT_NO_SESSION: "XpertApply recognized this application page but has no prepared application for it, so nothing was read or filled. To fill it, choose Apply with XpertApply on the job at xpertapply.com.",
  APPLICATION_FORM_TOO_LARGE: "This application exceeds XpertApply’s safe limit of 1,000 form fields. Nothing was filled. Please fill it manually.",
  CONTENT_SCRIPT_NOT_INJECTED: "Couldn’t reach the application page. Reload it and click “Fill application”.",
  FRAME_PERMISSION_GRANTED_PENDING_CONFIRMATION: "Site access is granted, but Chrome hasn’t confirmed the embedded application yet. Click “Fill application” to retry.",
  SESSION_PACKAGE_FAILED: "Your prepared application couldn’t be loaded. Reopen from XpertApply.",
  SESSION_UNAUTHORIZED: "Your session is no longer valid. Reopen the application from XpertApply.",
  SESSION_NOT_FOUND: "This application session no longer exists. Reopen from XpertApply.",
  TOKEN_CONSUMED: "This launch was already used. Reopen the application from XpertApply.",
  HANDOFF_EXPIRED: "This launch expired. Reopen the application from XpertApply.",
  HANDOFF_SCHEMA_OUTDATED: "The extension was updated. Reload this page to continue.",
  ADAPTER_NOT_DETECTED: "This application form isn’t supported yet. Fill it manually.",
  WRONG_ORIGIN: "The opened page didn’t match the expected employer. Nothing was filled.",
  WRONG_TAB: "This panel is bound to a different tab.",
  DOCUMENT_UPLOAD_REJECTED: "The employer blocked automatic file upload. Attach the document manually.",
  HOST_PERMISSION_MISSING: "XpertApply needs permission to access this site. Check the extension's site access settings.",
  AUTH_CANCELLED: "Sign-in was cancelled. Choose “Connect XpertApply” to try again.",
  AUTH_DENIED: "XpertApply wasn’t connected because access was declined. Choose “Connect XpertApply” to try again.",
  AUTH_REJECTED: "The sign-in response couldn’t be verified, so nothing was connected. Try again.",
  AUTH_UNAVAILABLE: "XpertApply couldn’t be reached to finish signing in. Check your connection and try again.",
  DIRECT_SIGNED_OUT: "This looks like a job application, but XpertApply isn’t connected. Choose “Connect XpertApply” to sign in; nothing is filled until you do.",
  DIRECT_UNAVAILABLE: "XpertApply couldn’t prepare this application. Check that your profile is complete and you’re online, then try again.",
  HANDOFF_NOT_FOUND: "No application from XpertApply is open on this page. Choose Apply with XpertApply on a job at xpertapply.com, then use the page it opens.",
  HANDOFF_URL_MISMATCH: "This page doesn’t match the prepared application. Open it from XpertApply.",
  FORM_NOT_RENDERED: "The application form did not render in time. You can retry.",
  NO_FIELDS_DISCOVERED: "No fillable fields were found on this page."
};

export function createApplicationAssistant(options: ApplicationAssistantOptions): ApplicationAssistantController {
  const ownedListeners: Array<() => void> = [];
  let disposed = false;
  let refreshGeneration = 0;
  let context: ApplicationAssistantContext = { available: false };
  let view: LaunchViewState | null = null;
  let refreshQueued = false;

  const element = (id: string): HTMLElement => {
    const found = options.root.getElementById(id);
    if (!found) throw new Error(`Missing application assistant element: ${id}`);
    return found;
  };
  const setText = (id: string, text: string): void => {
    const target = element(id);
    if (target.textContent !== text) target.textContent = text;
  };
  const button = (id: string): HTMLButtonElement => element(id) as HTMLButtonElement;
  const listen = (id: string, event: string, listener: EventListener): void => {
    const target = element(id);
    target.addEventListener(event, listener);
    ownedListeners.push(() => target.removeEventListener(event, listener));
  };

  function showButtonError(message: string): void {
    const errorBox = element("errors");
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  function renderUnavailable(): void {
    setText("job", "Waiting for an application…");
    const message = context.status === "missing"
      ? "The selected job tab is no longer available. Open or select a job application page to continue."
      : context.status === "unsupported"
        ? "Application assistance is unavailable on the selected page."
        : context.status === "waiting"
          ? "Open or select a job application page to begin."
          : context.available
            ? "Open an application from XpertApply to begin."
            : "No active application tab is available.";
    setText("stage", message);
    for (const id of ["fill", "rescan", "next", "clear", "complete", "grantSiteAccess"]) {
      button(id).disabled = true;
      button(id).hidden = id !== "fill";
    }
  }

  function renderSiteAccess(current: LaunchViewState): void {
    const block = element("siteAccess");
    const needed = current.siteAccess === "site_access_required" || current.siteAccess === "site_access_denied" || current.siteAccess === "site_access_revoked";
    block.hidden = !needed;
    if (!needed) return;
    const site = current.siteAccessOrigin ?? "this site";
    const where = current.siteAccessScope === "frame"
      ? `The application is embedded from ${site}.`
      : `The application is on ${site}.`;
    setText("siteAccessText", current.siteAccess === "site_access_revoked"
      ? `${where} Access was removed in Chrome, so XpertApply has stopped reading this page. Allow it again to continue.`
      : current.siteAccess === "site_access_denied"
      ? `${where} Access was declined. XpertApply needs permission to read relevant application-page and form information so it can identify and fill fields.`
      : `${where} XpertApply needs permission to read relevant application-page and form information so it can identify and fill fields. Relevant information may be sent to XpertApply's service only for features you request.`);
    setText("grantSiteAccess", `Allow XpertApply on ${site}`);
    // renderUnavailable() hides this button along with the rest; showing the block
    // without showing its only action left the user a request they could not answer.
    button("grantSiteAccess").hidden = false;
    button("grantSiteAccess").disabled = false;
  }

  function renderDiagnostics(current: LaunchViewState): void {
    const diagnostics = options.diagnostics;
    const diag = options.root.getElementById("diag");
    const diagBody = options.root.getElementById("diagBody");
    if (!diag || !diagBody) return;
    diag.hidden = !diagnostics?.enabled;
    if (!diagnostics?.enabled) return;
    diagBody.textContent = [
      `version: ${BUILD_INFO.version}`,
      `${diagnostics.surface}Build: ${BUILD_INFO.buildId}`,
      `builtAt: ${BUILD_INFO.builtAt}`,
      `protocol: ${PROTOCOL_VERSION}`,
      `tabId: ${current.tabId}`,
      `state: ${current.state}`,
      `contentReady: ${current.contentReady}`,
      `packageLoaded: ${current.packageLoaded}`,
      `adapter: ${current.atsId ?? "—"}`,
      `lastFailure: ${current.failureCode ?? "—"}`
    ].join("\n");
  }

  /** Whether the extension account is signed in, as last reported by the worker. Unknown until it answers. */
  let accountStatus: "unknown" | "signed_in" | "signed_out" = "unknown";

  /**
   * The progress a direct draft shows is only true while the account that owns it is connected. The worker tears a draft
   * down when it learns of a sign-out, but the two answers can arrive in either order; until they agree, trust the account
   * row and show the one honest state: not connected, nothing in progress, "Connect XpertApply".
   */
  function effectiveView(raw: LaunchViewState): LaunchViewState {
    const direct = typeof raw.requestId === "string" && raw.requestId.startsWith("direct-");
    if (!(accountStatus === "signed_out" && direct && raw.sessionId != null)) return raw;
    return {
      ...raw, sessionId: null, state: "failed", failureCode: "DIRECT_SIGNED_OUT", failureRecoverable: true, running: false,
      fieldsDiscovered: 0, filled: 0, skipped: 0, reviewRequired: 0, requiredReviewRemaining: undefined, reachedFinalStep: false,
      atsDisplayName: raw.atsDisplayName, resumeStatus: "—", coverStatus: "—", jobTitle: null
    } as LaunchViewState;
  }

  function render(): void {
    const current = view ? effectiveView(view) : null;
    if (!current) {
      renderUnavailable();
      return;
    }
    setText("job", current.jobTitle ? `${current.jobTitle}${current.company ? " · " + current.company : ""}` : current.sessionId == null ? "No XpertApply application open" : "Application detected");
    const activation = deriveActivationState(current);
    setText("stage", activationLabel(activation, current.siteAccessOrigin) ?? STAGE_LABEL[current.state] ?? current.state);
    setText("ats", current.atsDisplayName ? (current.limited ? `${current.atsDisplayName} (limited)` : current.atsDisplayName) : current.sessionId == null ? "—" : "Detecting…");
    setText("discovered", String(current.fieldsDiscovered));
    setText("filled", String(current.filled));
    setText("skipped", String(current.skipped));
    setText("review", String(current.reviewRequired));
    element("limited").hidden = !current.limited;
    element("final").hidden = !current.reachedFinalStep;
    // Documents belong to a prepared application; with none open there is nothing to prepare.
    setText("resume", current.sessionId == null ? "—" : documentLabel(current.resumeStatus));
    setText("cover", current.sessionId == null ? "—" : documentLabel(current.coverStatus));
    const errorBox = element("errors");
    if (current.failureCode) {
      errorBox.hidden = false;
      errorBox.textContent = FAILURE_LABEL[current.failureCode]
        ?? "Something went wrong while preparing this application. Try again or reopen it from XpertApply.";
    } else {
      errorBox.hidden = true;
    }
    const workflowAvailable = current.sessionId != null;
    const terminal = current.failureCode != null && current.failureRecoverable === false;
    // An application the worker recognised but cannot act on yet: the one button is the way forward.
    const needsConnect = !workflowAvailable && current.failureCode === "DIRECT_SIGNED_OUT";
    const needsRetry = !workflowAvailable && current.failureCode === "DIRECT_UNAVAILABLE";
    button("fill").disabled = needsConnect || needsRetry ? false : !workflowAvailable || current.running || terminal;
    setText("fill", needsConnect ? "Connect XpertApply" : needsRetry ? "Try again" : current.running ? "Filling…" : "Fill application");
    for (const id of ["rescan", "next", "clear", "complete"]) button(id).disabled = !workflowAvailable;
    button("complete").disabled = !workflowAvailable || completionFailure(current) !== null;
    button("complete").setAttribute("aria-describedby", "stage review");
    button("fill").hidden = false;
    button("rescan").hidden = !workflowAvailable || current.running;
    button("next").hidden = !workflowAvailable;
    button("clear").hidden = !workflowAvailable || current.filled === 0;
    button("complete").hidden = !workflowAvailable || !current.reachedFinalStep;
    renderSiteAccess(current);
    renderDiagnostics(current);
  }

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration;
    context = { available: false, status: "waiting" };
    view = null;
    render();
    const nextContext = await options.context.get();
    if (disposed || generation !== refreshGeneration) return;
    context = nextContext;
    const id = nextContext.tabId;
    if (!nextContext.available || id == null) {
      view = null;
      render();
      return;
    }
    const nextView = await options.views.get(id);
    if (disposed || generation !== refreshGeneration) return;
    view = nextView;
    if (!nextView && context.status === "bound") context = { ...context, status: "unsupported" };
    render();
    void refreshAccount();
  }

  function scheduleRefresh(): void {
    if (disposed || refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (!disposed) void refresh();
    });
  }

  async function withTab(operation: (tabId: number) => Promise<ActionResponse | undefined>, label: string): Promise<void> {
    const id = context.tabId;
    if (!context.available || id == null) {
      showButtonError("No job application tab is connected.");
      return;
    }
    const response = await operation(id);
    if (response?.ok === false) {
      showButtonError(`${label}: ${FAILURE_LABEL[response.error ?? ""] ?? "Something went wrong. Try again."}`);
    }
  }

  listen("fill", "click", () => void withTab((id) => options.actions.startAutofill(id, "manual_retry"), "Couldn’t start"));
  listen("rescan", "click", () => void withTab((id) => options.actions.startAutofill(id, "continue_after_navigation"), "Couldn’t continue"));
  listen("next", "click", () => void refresh());
  listen("clear", "click", () => void withTab((id) => options.actions.clearSession(id), "Couldn’t clear"));
  // Optional control: the side panel and assistant window do not have it.
  const disableSite = options.root.getElementById("disableSite");
  if (disableSite && options.actions.disableAutoOpen) {
    const onDisable = async (): Promise<void> => {
      const response = await options.actions.disableAutoOpen!();
      if (response?.ok === false) showButtonError("Couldn’t save that setting. Try again.");
      else {
        (disableSite as HTMLButtonElement).disabled = true;
        disableSite.textContent = "XpertApply won’t open here by itself";
      }
    };
    const onClick = (): void => void onDisable();
    disableSite.addEventListener("click", onClick);
    ownedListeners.push(() => disableSite.removeEventListener("click", onClick));
  }
  // Account status: always visible, so it is clear whether XpertApply can fill, and who it fills as.
  const account = options.root.getElementById("account");
  const disconnect = options.root.getElementById("disconnect") as HTMLButtonElement | null;
  async function refreshAccount(): Promise<void> {
    if (!account || !options.actions.authState) return;
    const response = await options.actions.authState().catch(() => undefined);
    if (disposed || !response?.ok || !response.state) return;
    const before = accountStatus;
    accountStatus = response.state.status === "signed_in" ? "signed_in" : "signed_out";
    if (before !== accountStatus) render();
    account.hidden = false;
    if (response.state.status === "signed_in") {
      account.textContent = `Connected as ${response.state.email}`;
      if (disconnect) disconnect.hidden = !options.actions.disconnect;
    } else {
      account.textContent = "Not connected to XpertApply";
      if (disconnect) disconnect.hidden = true;
    }
  }
  if (disconnect && options.actions.disconnect) {
    const onDisconnect = (): void => {
      void (async () => {
        if (!(await options.confirmAction("Disconnect XpertApply from this browser? Autofill will stop until you connect again."))) return;
        const response = await options.actions.disconnect!();
        if (response?.ok === false) showButtonError("Couldn’t disconnect. Try again.");
        await refreshAccount();
        await refresh();
      })();
    };
    disconnect.addEventListener("click", onDisconnect);
    ownedListeners.push(() => disconnect.removeEventListener("click", onDisconnect));
  }
  void refreshAccount();

  listen("grantSiteAccess", "click", async () => {
    const id = context.tabId;
    const pattern = view?.siteAccessPattern;
    if (!context.available || id == null || !pattern) return;
    let granted: boolean | "deferred" = false;
    try {
      granted = await options.actions.requestSiteAccess(pattern);
    } catch (error) {
      showButtonError(`Couldn't ask for site access: ${String(error).slice(0, 80)}`);
      return;
    }
    if (granted === "deferred") {
      // Chrome's own access prompt is now showing for this tab; the worker resumes on permissions.onAdded.
      showButtonError("Allow XpertApply in Chrome's prompt for this site to continue. If no prompt appears, open the Extensions menu (puzzle icon) and allow XpertApply on this site.");
      return;
    }
    const response = await options.actions.reportSiteAccess(id, pattern, granted);
    if (!granted) showButtonError("XpertApply can't fill this application without access to the site.");
    else if (response?.ok === false) showButtonError("Site access granted, but the application couldn't be reached.");
    await refresh();
  });
  listen("complete", "click", async () => {
    const tabId = context.tabId;
    const sessionId = view?.sessionId;
    if (!context.available || tabId == null || !sessionId || completionFailure(view) !== null
      || !(await options.confirmAction("Confirm you submitted this application on the employer's website?"))) return;
    const response = await options.actions.completeSession(tabId, sessionId);
    if (response?.ok === false) showButtonError(response.error === "REQUIRED_REVIEW_REMAINING" ? "Review the remaining required fields before marking complete." : "Couldn’t mark complete. Try again.");
  });

  ownedListeners.push(options.context.subscribe(scheduleRefresh));
  ownedListeners.push(options.views.subscribe((tabId, nextView) => {
    if (nextView === undefined) {
      scheduleRefresh();
      return;
    }
    if (disposed || tabId !== context.tabId) return;
    view = nextView;
    if (!nextView && context.status === "bound") context = { ...context, status: "unsupported" };
    render();
  }));

  return {
    refresh,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      refreshGeneration += 1;
      for (const remove of ownedListeners.splice(0)) remove();
    }
  };
}

function documentLabel(status: LaunchViewState["resumeStatus"]): string {
  switch (status) {
    case "uploaded": return "Uploaded ✓";
    case "review": return "Attach manually";
    case "pending": return "Preparing…";
    case "unavailable": return "Unavailable";
    default: return "—";
  }
}
