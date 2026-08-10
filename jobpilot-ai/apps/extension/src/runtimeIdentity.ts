/**
 * Who is actually running, and against which backend.
 *
 * This exists because of a specific class of live failure that a green test
 * suite cannot catch: the browser is running an EARLIER build than the one that
 * was tested, or the extension is talking to a different backend than the web
 * app the user saved their answers in. Both look exactly like a logic bug from
 * the outside — questions sit empty, the widget contradicts itself — and both
 * are invisible unless the runtime says so out loud.
 *
 * An MV3 extension makes the first one easy to hit: the service worker, the
 * content script and the widget are separate execution contexts loaded at
 * different moments. Reloading the extension without reopening the tab leaves a
 * NEW worker talking to an OLD content script, and the two disagree silently.
 *
 * Everything here is data the user may safely paste into a bug report: build
 * ids, an environment CATEGORY, and low-cardinality codes. Never a hostname the
 * deployment considers sensitive, never a token, never an answer.
 */

/** Which deployment the extension is pointed at. A category, not a hostname. */
export type ApiEnvironment = "local" | "staging" | "production" | "unknown";

/**
 * Classify an API base or web origin.
 *
 * Deliberately conservative: anything unrecognised is `unknown` rather than
 * being assumed to be production. An `unknown` never *blocks* on its own — it
 * would strand a legitimate self-hosted deployment — but it is reported, so a
 * misconfiguration is visible.
 */
export function classifyEnvironment(rawUrl: string): ApiEnvironment {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
    return "local";
  }
  if (/(^|[.-])(staging|stage|preview|dev|qa|test)([.-]|$)/.test(host)) return "staging";
  if (host === "jobpilot.ai" || host.endsWith(".jobpilot.ai")) return "production";
  return "unknown";
}

/** Origin plus optional API base pathname, with credentials/query/fragment removed. */
export function safeApiBase(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "unknown";
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return "unknown";
  }
}

/** What one execution context reports about itself. */
export interface RuntimeIdentity {
  /** Short git revision of the build this context was loaded from. */
  buildId: string;
  version: string;
  /** The backend this context would talk to. */
  environment: ApiEnvironment;
  apiBase?: string;
}

/** Everything the handshake gathers, for diagnostics and for the verdict. */
export interface RuntimeHandshake {
  contentScript: RuntimeIdentity;
  /** null when the worker did not answer at all. */
  serviceWorker: RuntimeIdentity | null;
  /**
   * The widget is created BY the content script, so it cannot be a different
   * build — they are the same bundle in the same context. It is reported
   * separately anyway, because "the widget is stale" is a thing users say, and
   * showing that it provably matches is faster than arguing about it.
   */
  widget: RuntimeIdentity;
  /** Identity last published by the side panel. Null/absent until the panel has
   * opened at least once in this extension runtime. */
  sidePanel?: RuntimeIdentity | null;
  /** Environment of the JobPilot web app that launched this application. */
  webEnvironment: ApiEnvironment | null;
  webApiBase?: string | null;
  webAuthenticatedUserId?: number | null;
  extensionAuthenticatedUserId?: number | null;
}

export type HandshakeReason =
  | "ok"
  | "build_mismatch"
  | "worker_unreachable"
  | "environment_mismatch"
  | "account_mismatch";

export interface HandshakeVerdict {
  ok: boolean;
  reason: HandshakeReason;
  /** What the user is told. Empty when ok. */
  message: string;
}

/** The two blocking messages, fixed so the copy cannot drift between callers. */
export const BUILD_MISMATCH_MESSAGE =
  "JobPilot was updated. Reload the extension and reopen this application.";
export const ENVIRONMENT_MISMATCH_MESSAGE =
  "Your JobPilot profile and extension are connected to different environments. Reload the correct extension build.";
export const WORKER_UNREACHABLE_MESSAGE =
  "JobPilot lost its connection to the extension. Reload the extension and reopen this application.";
export const ACCOUNT_MISMATCH_MESSAGE =
  "Your JobPilot web app and extension are signed in as different accounts. Reopen the application from the correct account.";

/**
 * Decide whether it is safe to autofill.
 *
 * Build identity is checked before environment: a mixed-build runtime cannot be
 * trusted to report its own environment correctly, so saying "different
 * environments" first would send the user to fix the wrong thing.
 *
 * A `dev` build id is what every context reports under Vitest, where esbuild's
 * `define` never runs. Two `dev` contexts genuinely are the same build, so this
 * is not special-cased — it falls out of the equality check.
 */
export function evaluateHandshake(handshake: RuntimeHandshake): HandshakeVerdict {
  const { contentScript, serviceWorker, widget, sidePanel, webEnvironment } = handshake;

  if (serviceWorker === null) {
    return { ok: false, reason: "worker_unreachable", message: WORKER_UNREACHABLE_MESSAGE };
  }
  if (
    contentScript.buildId !== serviceWorker.buildId
    || contentScript.buildId !== widget.buildId
    || (sidePanel != null && contentScript.buildId !== sidePanel.buildId)
  ) {
    return { ok: false, reason: "build_mismatch", message: BUILD_MISMATCH_MESSAGE };
  }

  // The extension and the worker must agree on the backend, and both must agree
  // with the web app the user saved their answers in — an answer saved against
  // one backend is simply not present in another, which is indistinguishable
  // from "you never answered" unless it is checked here.
  if (
    contentScript.environment !== serviceWorker.environment
    || (
      sidePanel != null
      && sidePanel.environment !== "unknown"
      && contentScript.environment !== "unknown"
      && contentScript.environment !== sidePanel.environment
    )
  ) {
    return { ok: false, reason: "environment_mismatch", message: ENVIRONMENT_MISMATCH_MESSAGE };
  }
  if (
    handshake.webAuthenticatedUserId != null
    && handshake.extensionAuthenticatedUserId != null
    && handshake.webAuthenticatedUserId !== handshake.extensionAuthenticatedUserId
  ) {
    return { ok: false, reason: "account_mismatch", message: ACCOUNT_MISMATCH_MESSAGE };
  }
  const known = (value: string | null | undefined) => Boolean(value && value !== "unknown");
  if (
    (known(contentScript.apiBase) && known(serviceWorker.apiBase)
      && contentScript.apiBase !== serviceWorker.apiBase)
    || (sidePanel != null && known(contentScript.apiBase) && known(sidePanel.apiBase)
      && contentScript.apiBase !== sidePanel.apiBase)
    || (known(contentScript.apiBase) && known(handshake.webApiBase)
      && contentScript.apiBase !== handshake.webApiBase)
  ) {
    return { ok: false, reason: "environment_mismatch", message: ENVIRONMENT_MISMATCH_MESSAGE };
  }
  // `unknown` on either side is not evidence of a mismatch: a self-hosted
  // deployment is unrecognised but perfectly consistent. Only two DIFFERENT
  // recognised environments are a real conflict.
  if (
    webEnvironment !== null
    && webEnvironment !== "unknown"
    && contentScript.environment !== "unknown"
    && webEnvironment !== contentScript.environment
  ) {
    return { ok: false, reason: "environment_mismatch", message: ENVIRONMENT_MISMATCH_MESSAGE };
  }

  return { ok: true, reason: "ok", message: "" };
}

/**
 * The handshake, reduced to something safe to paste into a bug report.
 *
 * Build ids and environment categories only. No hostname: a deployment may
 * treat its backend address as sensitive, and the category is what actually
 * answers the question being asked.
 */
export function handshakeSummary(
  handshake: RuntimeHandshake,
  verdict: HandshakeVerdict
): Record<string, string> {
  return {
    contentScriptBuild: handshake.contentScript.buildId,
    serviceWorkerBuild: handshake.serviceWorker?.buildId ?? "unreachable",
    widgetBuild: handshake.widget.buildId,
    sidePanelBuild: handshake.sidePanel?.buildId ?? "not_observed",
    extensionEnvironment: handshake.contentScript.environment,
    serviceWorkerEnvironment: handshake.serviceWorker?.environment ?? "unreachable",
    sidePanelEnvironment: handshake.sidePanel?.environment ?? "not_observed",
    webEnvironment: handshake.webEnvironment ?? "unknown",
    contentApiBase: handshake.contentScript.apiBase ?? "unknown",
    serviceWorkerApiBase: handshake.serviceWorker
      ? handshake.serviceWorker.apiBase ?? "unknown"
      : "unreachable",
    sidePanelApiBase: handshake.sidePanel
      ? handshake.sidePanel.apiBase ?? "unknown"
      : "not_observed",
    webApiBase: handshake.webApiBase ?? "unknown",
    webAuthenticatedUserId: handshake.webAuthenticatedUserId == null
      ? "unknown"
      : String(handshake.webAuthenticatedUserId),
    extensionAuthenticatedUserId: handshake.extensionAuthenticatedUserId == null
      ? "unknown"
      : String(handshake.extensionAuthenticatedUserId),
    verdict: verdict.reason
  };
}

export const SIDE_PANEL_RUNTIME_KEY = "sidePanelRuntimeIdentityV1";
