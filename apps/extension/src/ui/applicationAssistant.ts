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
  requestSiteAccess(pattern: string): Promise<boolean>;
  reportSiteAccess(tabId: number, pattern: string, granted: boolean): Promise<ActionResponse | undefined>;
}

export interface ApplicationAssistantContextAdapter {
  get(): Promise<ApplicationAssistantContext>;
  subscribe(listener: () => void): () => void;
}

export interface ApplicationAssistantViewAdapter {
  get(tabId: number): Promise<LaunchViewState | null>;
  subscribe(listener: (tabId: number, view: LaunchViewState | null) => void): () => void;
}

export interface ApplicationAssistantOptions {
  document: Document;
  context: ApplicationAssistantContextAdapter;
  views: ApplicationAssistantViewAdapter;
  actions: ApplicationAssistantActions;
  diagnostics?: {
    enabled: boolean;
    surface: string;
  };
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
  HANDOFF_NOT_FOUND: "No prepared application is waiting for this tab. Start from XpertApply.",
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

  const element = (id: string): HTMLElement => {
    const found = options.document.getElementById(id);
    if (!found) throw new Error(`Missing application assistant element: ${id}`);
    return found;
  };
  const setText = (id: string, text: string): void => { element(id).textContent = text; };
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
    for (const id of ["fill", "rescan", "next", "clear", "complete", "grantSiteAccess"]) button(id).disabled = true;
  }

  function renderSiteAccess(current: LaunchViewState): void {
    const block = element("siteAccess");
    const needed = current.siteAccess === "site_access_required" || current.siteAccess === "site_access_denied";
    block.hidden = !needed;
    if (!needed) return;
    const site = current.siteAccessOrigin ?? "this site";
    const where = current.siteAccessScope === "frame"
      ? `The application is embedded from ${site}.`
      : `The application is on ${site}.`;
    setText("siteAccessText", current.siteAccess === "site_access_denied"
      ? `${where} Access was declined. If you choose to allow this site, XpertApply will read relevant application-page and form information to help fill this application. Relevant information may be sent to XpertApply's service for the features you request.`
      : `${where} To help fill this application, XpertApply needs access to this site. It will read relevant application-page and form information. Relevant information may be sent to XpertApply's service for the features you request.`);
    setText("grantSiteAccess", `Allow XpertApply on ${site}`);
    button("grantSiteAccess").disabled = false;
  }

  function renderDiagnostics(current: LaunchViewState): void {
    const diagnostics = options.diagnostics;
    element("diag").hidden = !diagnostics?.enabled;
    if (!diagnostics?.enabled) return;
    element("diagBody").textContent = [
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

  function render(): void {
    const current = view;
    if (!current) {
      renderUnavailable();
      return;
    }
    setText("job", current.jobTitle ? `${current.jobTitle}${current.company ? " · " + current.company : ""}` : "Application detected");
    setText("stage", STAGE_LABEL[current.state] ?? current.state);
    setText("ats", current.atsDisplayName ? (current.limited ? `${current.atsDisplayName} (limited)` : current.atsDisplayName) : "Detecting…");
    setText("discovered", String(current.fieldsDiscovered));
    setText("filled", String(current.filled));
    setText("skipped", String(current.skipped));
    setText("review", String(current.reviewRequired));
    element("limited").hidden = !current.limited;
    element("final").hidden = !current.reachedFinalStep;
    setText("resume", documentLabel(current.resumeStatus));
    setText("cover", documentLabel(current.coverStatus));
    const errorBox = element("errors");
    if (current.failureCode) {
      errorBox.hidden = false;
      errorBox.textContent = FAILURE_LABEL[current.failureCode] ?? current.failureMessage ?? `Issue: ${current.failureCode}`;
    } else {
      errorBox.hidden = true;
    }
    const terminal = current.failureCode != null && current.failureRecoverable === false;
    button("fill").disabled = current.running || terminal;
    setText("fill", current.running ? "Filling…" : terminal ? "Reopen from XpertApply" : "Fill application");
    for (const id of ["rescan", "next", "clear", "complete"]) button(id).disabled = false;
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
  }

  async function withTab(operation: (tabId: number) => Promise<ActionResponse | undefined>, label: string): Promise<void> {
    const id = context.tabId;
    if (!context.available || id == null) {
      showButtonError("No job application tab is connected.");
      return;
    }
    const response = await operation(id);
    if (response?.ok === false) {
      showButtonError(`${label}: ${FAILURE_LABEL[response.error ?? ""] ?? response.error ?? "unknown error"}`);
    }
  }

  listen("fill", "click", () => void withTab((id) => options.actions.startAutofill(id, "manual_retry"), "Couldn’t start"));
  listen("rescan", "click", () => void withTab((id) => options.actions.startAutofill(id, "continue_after_navigation"), "Couldn’t continue"));
  listen("next", "click", () => void refresh());
  listen("clear", "click", () => void withTab((id) => options.actions.clearSession(id), "Couldn’t clear"));
  listen("grantSiteAccess", "click", async () => {
    const id = context.tabId;
    const pattern = view?.siteAccessPattern;
    if (!context.available || id == null || !pattern) return;
    let granted = false;
    try {
      granted = await options.actions.requestSiteAccess(pattern);
    } catch (error) {
      showButtonError(`Couldn't ask for site access: ${String(error).slice(0, 80)}`);
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
    if (!context.available || tabId == null || !sessionId
      || !confirm("Confirm you submitted this application on the employer's website?")) return;
    const response = await options.actions.completeSession(tabId, sessionId);
    if (response?.ok === false) showButtonError(`Couldn’t mark complete: ${response.error ?? "unknown error"}`);
  });

  ownedListeners.push(options.context.subscribe(() => void refresh()));
  ownedListeners.push(options.views.subscribe((tabId, nextView) => {
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
