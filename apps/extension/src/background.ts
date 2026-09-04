/**
 * MV3 service worker: the canonical launch state machine.
 *
 * Responsibilities:
 *   • Accept an acknowledged, versioned handoff from the XpertApply bridge,
 *     persist it before navigation, then create/focus the employer tab and bind it
 *     exact tab id in chrome.storage.session.
 *   • Drive a pull-based readiness handshake with the employer content script
 *     (ping → inject fallback → retry with backoff).
 *   • Exchange the single-use launch token exactly once and cache the resulting
 *     session package per tab so refreshes/retries never re-consume the token.
 *   • Never hold important state only in worker memory; never submit anything.
 */

import { BUILD_INFO } from "./buildInfo";
import {
  ApiError,
  completeSession,
  confirmSessionName,
  confirmSubmission,
  exchangeLaunchToken,
  fetchApplicationOverrides,
  fetchSessionData,
  resolveQuestions,
  postEvent,
  reportAutofillResult,
  saveSessionAnswer,
  setApplicationOverride
} from "./api/client";
import { validateOverrideRequest } from "./content/reviewActions";
import { getApiBase, isApprovedJobPilotOrigin, JOBPILOT_WEB_ORIGINS } from "./config";
import {
  classifyEnvironment,
  safeApiBase,
  SIDE_PANEL_RUNTIME_KEY,
  type ApiEnvironment,
  type RuntimeIdentity
} from "./runtimeIdentity";
import { lastError, log } from "./logger";
import {
  MSG,
  PROTOCOL_VERSION,
  parseRuntimeMessage,
  type AutofillReason,
  type AutofillResult,
  type LaunchPayload,
  type PendingLaunch,
  type ObservedFramePayload,
  type ProgressPayload,
  type RuntimeMessage
} from "./messages";
import {
  clearTab,
  cleanupExpired,
  findPackageBySession,
  findPendingByApplication,
  getActive,
  findPackageForSession,
  getPackage,
  getPending,
  getView,
  initialView,
  patchView,
  putPackage,
  putActive,
  putPending,
  putView,
  updatePending,
  type SessionPackage
} from "./state";
import { urlsMatchForHandoff } from "./url";
import {
  authorizeFrameForLaunch,
  describeSender,
  originJoinsLaunchWorkflow,
  originJoinsWorkflow,
  senderCanBindTab,
  type SenderContext
} from "./security/senderTrust";
import {
  NO_ACCESS_NEEDED,
  originPatternFor,
  siteAccessNeedFor,
  type SiteAccessNeed
} from "./security/siteAccess";
import {
  canonicalFrameOrigin,
  frameDiscoveryOutcome,
  mergeFrameInventories,
  patternForOrigin,
  selectTrustedApplicationCandidate,
  type FrameDiscoveryRecord,
  type FrameEvidenceSource
} from "./frames/frameDiscovery";

const LAUNCH_TTL_MS = 15 * 60 * 1000;
const READY_MAX_ATTEMPTS = 6;
const packageLoads = new Map<number, Promise<SessionPackage>>();
void cleanupExpired();

const RUNTIME_REVIVAL_KEY = "jobpilotRuntimeRevivedV1";

// `runtime.onInstalled` is not guaranteed for Developer Mode's Reload button.
// storage.session survives ordinary MV3 worker suspension but is reset with the
// extension runtime, so this runs once after a real extension-context reset —
// not every time the service worker merely wakes up.
void reviveAfterRuntimeReset();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined);
  void reviveOpenJobPilotTabs();
});

/**
 * An XpertApply tab that was already open when the extension was installed or
 * reloaded has an orphaned content script — `chrome.runtime` in that isolated
 * world is invalidated, so it can never bridge to this (new) background no
 * matter how long the page waits. Re-inject the (ATS-only-code-free)
 * web-origin bridge into every already-open, approved XpertApply tab so the
 * user doesn't have to know to manually refresh. Never touches ATS/employer
 * tabs — only the exact origins the bridge role is allowed to run on.
 */
async function reviveOpenJobPilotTabs(): Promise<void> {
  for (const origin of JOBPILOT_WEB_ORIGINS) {
    let tabs: chrome.tabs.Tab[] = [];
    try {
      tabs = await chrome.tabs.query({ url: `${origin}/*` });
    } catch {
      continue;
    }
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        log.debug("bridge revived on existing tab", { tabId: tab.id });
      } catch (err) {
        // Restricted tab (chrome://, a page still loading, etc.) — nothing
        // to do; the user can still reload it manually.
        log.debug("bridge revive skipped", { tabId: tab.id, reason: String(err).slice(0, 40) });
      }
    }
  }
}

async function reviveAfterRuntimeReset(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(RUNTIME_REVIVAL_KEY);
    if (stored[RUNTIME_REVIVAL_KEY]) return;
    await chrome.storage.session.set({ [RUNTIME_REVIVAL_KEY]: Date.now() });
  } catch {
    // Older/fake Chrome environments without storage.session still get the
    // safe best-effort revival.
  }

  await reviveOpenJobPilotTabs();

  // If an employer tab was already open, its old content script and widget are
  // just as stale as the XpertApply bridge. Durable local state contains the
  // exact bound tab, so revive only that user-authorized application tab.
  const active = await getActive().catch(() => null);
  if (
    active?.targetTabId != null &&
    active.expiresAt > Date.now()
  ) {
    await ensureContentReady(active.targetTabId).catch(() => false);
  }
}

// Keep the durable handoff when a tab closes so "Open manually" and reopen can
// bind a new ATS tab. Only discard tab-specific view/package records.
chrome.tabs.onRemoved.addListener((tabId) => {
  clearFrameRegistry(tabId);
  void (async () => {
    const pending = await getPending(tabId);
    if (pending) await putActive({ ...pending, targetTabId: undefined, status: "prepared", state: "package_ready" });
    await clearTab(tabId);
  })();
});

// --------------------------------------------------------------------------- //
// Application-destination navigation (URL-first apply)
//
// The content script cannot and must not touch chrome.tabs. It resolves a
// validated destination and asks here; this is the only place a tab is
// navigated or created for an apply handoff, and the only place a newly
// created tab is bound back to the originating session.
// --------------------------------------------------------------------------- //

/** A navigation we requested and are still waiting to see land. */
interface PendingActivation {
  launchId: string;
  applicationId: string;
  sourceTabId: number;
  sessionId: number;
  sourceUrl: string;
  jobFingerprint: string;
  extensionBuildId: string;
  url: string;
  expectedOrigin: string;
  newTab: boolean;
  createdAt: number;
  expiresAt: number;
  state: "PENDING_NAVIGATION" | "DESTINATION_DETECTED" | "CONTENT_SCRIPT_READY" | "SESSION_REBOUND" | "APPLICATION_DISCOVERED" | "AUTOFILL_READY";
  normalizedCtaText: string;
  confidence: number;
  target: string | null;
  redirectSequence: string[];
  destinationTabId?: number;
  failureCode?: string;
  /** Set once a destination tab has been adopted, so adoption happens once. */
  consumed: boolean;
}

/** Bounded so a stale activation can never adopt an unrelated tab later. */
const PENDING_ACTIVATION_TTL_MS = 90_000;
const ACTIVATION_KEY = "pendingApplyActivationV1";

/**
 * Persisted, not held in a module variable.
 *
 * An MV3 service worker is suspended aggressively — routinely within seconds of
 * going idle, which is easily inside the window between requesting a navigation
 * and the destination page loading. A pending activation kept only in worker
 * memory is therefore lost exactly when a slow employer login page needs it,
 * and the destination tab is never adopted. chrome.storage.session keeps it
 * across restarts without ever writing it to disk.
 *
 * Nothing sensitive is stored: tab ids, an origin, a session reference and
 * timestamps. No tokens, answers, or documents.
 */
async function readPendingActivation(): Promise<PendingActivation | null> {
  try {
    const area = chrome.storage.session ?? chrome.storage.local;
    const store = await area.get(ACTIVATION_KEY);
    const value = store[ACTIVATION_KEY] as PendingActivation | undefined;
    if (!value || typeof value.sourceTabId !== "number") return null;
    if (value.consumed) return null;
    if (Date.now() > (value.expiresAt || value.createdAt + PENDING_ACTIVATION_TTL_MS)) {
      await clearPendingActivation();
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function safeOriginPath(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function launchIdentifier(sessionId: number): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${sessionId}-${Date.now()}-${random}`;
}

async function prepareApplicationLaunch(
  sourceTabId: number,
  message: {
    sessionId: number; sourceUrl: string; normalizedCtaText: string; confidence: number;
    href: string | null; target: string | null; expectedDestinationOrigin: string | null;
    jobFingerprint: string;
  }
): Promise<{ ok: boolean; launchId?: string; error?: string }> {
  const launch = (await getPending(sourceTabId)) ?? (await getActive());
  if (!launch || launch.sessionId !== message.sessionId) return { ok: false, error: "SESSION_MISMATCH" };
  const now = Date.now();
  const record: PendingActivation = {
    launchId: launchIdentifier(message.sessionId),
    applicationId: launch.applicationId,
    sourceTabId,
    sessionId: message.sessionId,
    sourceUrl: safeOriginPath(message.sourceUrl),
    jobFingerprint: message.jobFingerprint,
    extensionBuildId: BUILD_INFO.buildId,
    url: message.href ?? "",
    expectedOrigin: message.expectedDestinationOrigin ?? "",
    newTab: message.target === "_blank",
    createdAt: now,
    expiresAt: now + PENDING_ACTIVATION_TTL_MS,
    state: "PENDING_NAVIGATION",
    normalizedCtaText: message.normalizedCtaText,
    confidence: message.confidence,
    target: message.target,
    redirectSequence: [safeOriginPath(message.sourceUrl)],
    consumed: false
  };
  await writePendingActivation(record);
  log.info("application launch prepared", {
    launchId: record.launchId,
    state: record.state,
    confidence: String(record.confidence),
    expectedOrigin: record.expectedOrigin || "unknown"
  });
  return { ok: true, launchId: record.launchId };
}

async function writePendingActivation(activation: PendingActivation): Promise<void> {
  try {
    const area = chrome.storage.session ?? chrome.storage.local;
    await area.set({ [ACTIVATION_KEY]: activation });
  } catch {
    /* best-effort: a failed write only costs us popup adoption */
  }
}

async function clearPendingActivation(): Promise<void> {
  try {
    const area = chrome.storage.session ?? chrome.storage.local;
    await area.remove(ACTIVATION_KEY);
  } catch {
    /* ignore */
  }
}

async function navigateToApplicationDestination(
  sourceTabId: number,
  message: { sessionId: number; url: string; newTab: boolean; source: string }
): Promise<{ ok: boolean; tabId?: number; created?: boolean; error?: string }> {
  // Re-validate the scheme here even though the content script already did:
  // this is the privileged side, and it must not trust a page-adjacent world.
  let target: URL;
  try {
    target = new URL(message.url);
  } catch {
    return { ok: false, error: "INVALID_URL" };
  }
  const isLocal = ["localhost", "127.0.0.1"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && isLocal)) {
    return { ok: false, error: "UNSAFE_SCHEME" };
  }

  // The launch this navigation belongs to must still be the active one, and it
  // must match the session the content script claims. This is what stops one
  // page from steering another user's workflow.
  const launch = (await getPending(sourceTabId)) ?? (await getActive());
  if (!launch || launch.sessionId !== message.sessionId) {
    return { ok: false, error: "SESSION_MISMATCH" };
  }

  // And the destination must belong to the workflow the user actually started.
  //
  // The finding this closes (XA-06, Stage 3C-2): every URL reaching here is
  // PAGE-DERIVED — an anchor href read off the listing, or the `src` of an
  // embedded frame. Session and scheme were checked; origin was not. That made
  // this a SECOND, weaker trust system beside the one the permission path uses,
  // and an application-shaped ad or widget frame could therefore be reopened as
  // "the application" and then named to the user as the site needing access.
  //
  // The same predicate as Stage 3A's frame gate and the host-permission gate —
  // one policy, not a private allow-list here. Dot-anchored, so a suffix
  // lookalike (`greenhouse.io.evil.test`, `notgreenhouse.io`) fails. The tab
  // gate already refuses to serve a session to an origin outside the workflow;
  // refusing to NAVIGATE there too simply stops the extension steering the user
  // somewhere it would then do nothing.
  const workflowUrl = launch.officialUrl ?? launch.applicationUrl;
  const joinsWorkflow = urlsMatchForHandoff(launch.applicationUrl, target.toString())
    || originJoinsWorkflow(workflowUrl, target)
    || target.origin.toLowerCase() === safeOrigin(launch.applicationUrl);
  if (!joinsWorkflow) {
    log.warn("apply destination refused", { reason: "origin_not_in_workflow", origin: target.origin });
    return { ok: false, error: "ORIGIN_NOT_IN_WORKFLOW" };
  }

  // Persist BEFORE navigating: the worker can be suspended the moment the
  // navigation starts, and the destination may load after it restarts.
  const existingActivation = await readPendingActivation();
  const now = Date.now();
  await writePendingActivation({
    ...(existingActivation ?? {
      launchId: launchIdentifier(message.sessionId), applicationId: launch.applicationId,
      sourceTabId, sessionId: message.sessionId, sourceUrl: safeOriginPath(launch.officialUrl),
      jobFingerprint: `${launch.jobId}:${launch.applicationId}`, extensionBuildId: BUILD_INFO.buildId,
      normalizedCtaText: "unknown", confidence: 0, target: message.newTab ? "_blank" : null,
      redirectSequence: [safeOriginPath(launch.officialUrl)], createdAt: now
    }),
    url: target.toString(), expectedOrigin: target.origin, newTab: message.newTab,
    expiresAt: now + PENDING_ACTIVATION_TTL_MS, state: "PENDING_NAVIGATION", consumed: false
  });
  // Sanitized: origin only, never the full URL (it can carry query identifiers).
  log.info("apply destination navigation requested", {
    source: message.source,
    newTab: String(message.newTab),
    origin: target.origin
  });

  if (message.newTab) {
    const created = await chrome.tabs.create({ url: target.toString(), active: true });
    if (typeof created.id === "number") {
      await bindTabToLaunch(created.id, {
        ...launch, applicationUrl: target.toString(), expectedOrigin: target.origin
      }, sourceTabId);
      const activation = await readPendingActivation();
      if (activation) await writePendingActivation({
        ...activation, destinationTabId: created.id, state: "DESTINATION_DETECTED",
        redirectSequence: [...activation.redirectSequence, safeOriginPath(target.toString())]
      });
      return { ok: true, tabId: created.id, created: true };
    }
    return { ok: false, error: "TAB_CREATE_FAILED" };
  }

  // Same-tab: the tab id does not change, so the existing binding and cached
  // package still apply. The activation record stays until the destination
  // reports in, so a worker restart mid-navigation is still recoverable.
  await putPending(sourceTabId, { ...launch, applicationUrl: target.toString(), expectedOrigin: target.origin });
  await chrome.tabs.update(sourceTabId, { url: target.toString() });
  return { ok: true, tabId: sourceTabId, created: false };
}

/**
 * Re-establish this tab's binding to the active application workflow.
 *
 * Called by a destination page that has no usable session — typically because
 * it bound itself through the getActive() path and never inherited a package.
 * The worker, not the page, decides everything: which workflow is active, which
 * session it refers to, and whether this origin may join it.
 */
async function reconnectWorkflow(
  tabId: number,
  origin: string
): Promise<{ ok: boolean; reason: string; session?: unknown }> {
  const active = (await getPending(tabId)) ?? (await getActive());
  if (!active) return { ok: false, reason: "no_pending_activation" };
  if (Date.now() > active.expiresAt) return { ok: false, reason: "session_expired" };

  let candidate: URL;
  try {
    candidate = new URL(origin);
  } catch {
    return { ok: false, reason: "origin_not_allowed" };
  }
  if (candidate.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(candidate.hostname)) {
    return { ok: false, reason: "origin_not_allowed" };
  }
  if (!originJoinsWorkflow(active.officialUrl ?? active.applicationUrl, candidate)) {
    return { ok: false, reason: "origin_not_allowed" };
  }

  await putPending(tabId, { ...active, targetTabId: tabId });

  // Reuse the SESSION-scoped package. The launch token is single-use and is
  // already spent by the tab that started the workflow, so re-exchanging it
  // would 401 — the very failure this path exists to avoid.
  const inherited = await findPackageForSession(active.sessionId);
  if (inherited) {
    await putPackage(tabId, inherited);
    log.info("workflow reconnected", { stage: "rebind_accepted", reason: "session_scoped_reuse" });
    return { ok: true, reason: "rebound", session: inherited.session };
  }

  // No package anywhere: the launch token may still be unspent. Try once.
  try {
    const pkg = await ensurePackage(tabId, active);
    log.info("workflow reconnected", { stage: "rebind_accepted", reason: "fresh_exchange" });
    return { ok: true, reason: "rebound", session: pkg.session };
  } catch (err) {
    const code = classifyPackageError(err);
    log.info("workflow reconnect failed", { stage: "rebind_request", reason: code.toLowerCase() });
    return { ok: false, reason: code === "SESSION_UNAUTHORIZED" ? "session_unauthorized" : code.toLowerCase() };
  }
}

/**
 * Carry the existing launch onto another tab, without minting a new session.
 *
 * The session PACKAGE must travel with it. `ensurePackage` caches per tab id,
 * and the launch token it exchanges is single-use: the backend consumes it on
 * first exchange and returns 401 afterwards. So a destination tab that arrives
 * without the package re-exchanges a spent token, gets 401, and the widget
 * reports "Your session is no longer valid. Reopen the application from
 * XpertApply." — on a perfectly healthy session, purely because the binding moved
 * tabs. Copying the package is what makes a cross-tab rebind survivable.
 */
async function bindTabToLaunch(
  tabId: number,
  launch: PendingLaunch,
  sourceTabId?: number
): Promise<void> {
  await putPending(tabId, launch);
  if (typeof sourceTabId === "number" && sourceTabId !== tabId) {
    const carried = await getPackage(sourceTabId);
    if (carried) {
      await putPackage(tabId, carried);
      log.info("carried session package to destination tab");
    }
  }
  await ensureContentReady(tabId).catch(() => undefined);
}

// A popup or target="_blank" the PAGE opened (rather than one we created) still
// belongs to this workflow. Adopt it only while an activation is live, only
// when it came from the tab we activated, and only for the origin we expected.
log.info("service worker active", { build: BUILD_INFO.buildId, version: BUILD_INFO.version });

chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    const activation = await readPendingActivation();
    if (!activation || typeof tab.id !== "number") return;
    if (tab.openerTabId !== undefined && tab.openerTabId !== activation.sourceTabId) return;

    const launch = (await getPending(activation.sourceTabId)) ?? (await getActive());
    if (!launch || launch.sessionId !== activation.sessionId) return;

    const destinationUrl = tab.pendingUrl || tab.url || activation.url;
    if (destinationUrl) {
      let candidate: URL;
      try { candidate = new URL(destinationUrl); } catch { return; }
      if (["http:", "https:"].includes(candidate.protocol)
        && activation.expectedOrigin && candidate.origin !== activation.expectedOrigin
        && !originJoinsWorkflow(launch.officialUrl, candidate)) return;
    }
    await bindTabToLaunch(tab.id, {
      ...launch,
      applicationUrl: destinationUrl || launch.applicationUrl,
      expectedOrigin: destinationUrl ? safeOrigin(destinationUrl) : launch.expectedOrigin
    }, activation.sourceTabId);
    await writePendingActivation({
      ...activation, destinationTabId: tab.id, state: "DESTINATION_DETECTED",
      redirectSequence: destinationUrl
        ? [...activation.redirectSequence, safeOriginPath(destinationUrl)]
        : activation.redirectSequence
    });
    log.info("adopted application tab opened by the page", { origin: activation.expectedOrigin });
  })();
});

// When a tab with a pending launch finishes loading (initial load, refresh, or
// SPA navigation reported as complete), make sure the content script is ready.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A top-frame navigation invalidates every frame in the tab.
  if (changeInfo.url) clearFrameRegistry(tabId);
  void (async () => {
    const activation = await readPendingActivation();
    if (activation && (tabId === activation.sourceTabId || tabId === activation.destinationTabId) && changeInfo.url) {
      let destinationAllowed = false;
      try {
        const candidate = new URL(changeInfo.url);
        const sourceLaunch = (await getPending(activation.sourceTabId)) ?? (await getActive());
        destinationAllowed = Boolean(sourceLaunch && (
          candidate.origin === activation.expectedOrigin
          || originJoinsWorkflow(sourceLaunch.officialUrl, candidate)
        ));
        if (destinationAllowed) {
          const bound = (await getPending(tabId)) ?? sourceLaunch;
          if (bound) await putPending(tabId, {
            ...bound,
            applicationUrl: candidate.toString(),
            expectedOrigin: candidate.origin,
            targetTabId: tabId
          });
        }
      } catch {
        destinationAllowed = false;
      }
      if (!destinationAllowed) return;
      const nextPath = safeOriginPath(changeInfo.url);
      const sequence = activation.redirectSequence.at(-1) === nextPath
        ? activation.redirectSequence
        : [...activation.redirectSequence, nextPath].slice(-12);
      await writePendingActivation({
        ...activation, destinationTabId: tabId, state: "DESTINATION_DETECTED", redirectSequence: sequence
      });
    }
    if (changeInfo.status !== "complete") return;
    let pending = await getPending(tabId);
    if (!pending) {
      // Nothing is bound to this tab yet. With the employer content script no
      // longer declarative, there is no script here to announce itself and ask
      // — so the WORKER has to recognise the application tab and bind it.
      //
      // This is what used to happen inside handleContentReady's self-bind path,
      // which could only run because a script was already present on every
      // page. It is the same rule (an unexpired active handoff whose URL
      // matches this tab), moved to the only party that can still apply it.
      const active = await getActive();
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!active || Date.now() > active.expiresAt) return;
      if (!tab?.url) return;
      // Either this IS the application URL, or it is a page the workflow
      // legitimately moved to — the employer's own login host, an allow-listed
      // ATS. Same predicate `reconnectWorkflow` has always used; it is an
      // APPLICATION-level rule and grants no Chrome authority of its own, so
      // injection below still depends on the user having granted this origin.
      const exactMatch = urlsMatchForHandoff(active.applicationUrl, tab.url);
      let joinsWorkflow = exactMatch;
      if (!joinsWorkflow) {
        try {
          joinsWorkflow = originJoinsWorkflow(active.officialUrl ?? active.applicationUrl, new URL(tab.url));
        } catch {
          joinsWorkflow = false;
        }
      }
      if (!joinsWorkflow) return;

      if (exactMatch) {
        pending = { ...active, targetTabId: tabId, status: "detecting", state: "detecting_ats" };
        await putPending(tabId, pending);
        if (!(await getView(tabId))) await putView(tabId, initialView(tabId, pending, null, null));
        log.info("bound application tab", { tabId });
      } else {
        // A page the workflow moved to — the employer's own login host, an
        // allow-listed ATS. Deliberately NOT bound here: binding it to a
        // handoff whose URL it does not match makes the content script's own
        // check fail terminally, instead of taking the reconnect path that
        // exists for exactly this hop. Inject and let it reconnect.
        log.info("workflow origin reached; injecting for reconnect", { tabId });
      }
    }
    // An application workflow crosses origins by design — employer, ATS,
    // identity provider, form. Navigation is NOT authorization: landing on a
    // new origin re-opens the question rather than inheriting the grant the
    // previous origin had. `ensureContentReady` re-checks and records the need,
    // so an unauthorized destination simply gets no content script and the side
    // panel asks about that origin by name.
    await ensureContentReady(tabId).catch(() => undefined);
  })();
});

// --------------------------------------------------------------------------- //
// Message router (validates every message; unknown → structured error)
// --------------------------------------------------------------------------- //
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const message = parseRuntimeMessage(raw);
  if (!message) {
    sendResponse({ ok: false, error: "UNKNOWN_MESSAGE" });
    return false;
  }

  switch (message.type) {
    case MSG.HANDSHAKE:
      // Remember which XpertApply deployment the user is actually using, so a
      // later application can tell whether the extension is pointed somewhere
      // else. Only the CATEGORY is kept, and only for an approved origin.
      void rememberWebRuntime(message.origin, message.apiBase);
      sendResponse({ ok: message.protocolVersion === PROTOCOL_VERSION, protocolVersion: PROTOCOL_VERSION });
      return false;

    case MSG.STAGE_LAUNCH:
      void rememberWebRuntime(
        sender.origin ?? "",
        message.payload.webApiBase,
        message.payload.webAuthenticatedUserId
      );
      void stageHandoff(message.payload)
        .then(() => sendResponse({ ok: true, applicationId: String(message.payload.sessionId) }))
        .catch((err) => sendResponse({ ok: false, code: "INVALID_HANDOFF", message: safeMessage(err) }));
      return true;

    case MSG.LAUNCH_REQUEST:
      void rememberWebRuntime(
        sender.origin ?? "",
        message.payload.webApiBase,
        message.payload.webAuthenticatedUserId
      );
      handleLaunchRequest(message.payload, sender, sendResponse);
      return true;

    case MSG.CONTENT_READY:
      if (sender.tab?.id != null && sender.frameId != null && message.probe) {
        registerFrameProbe(sender.tab.id, sender.frameId, message.probe);
      }
      void handleContentReady(sender, message.probe?.rootConfident === true, sendResponse);
      return true;

    case MSG.GET_PENDING_LAUNCH:
      void handleGetPending(sender, sendResponse);
      return true;

    case MSG.INSPECT_APPLICATION_FRAMES:
      void inspectApplicationFrames(sender, message.observed)
        .then((report) => sendResponse({ ok: true, ...report }))
        .catch((err) => sendResponse({ ok: false, error: String(err).slice(0, 60) }));
      return true;

    case MSG.REQUEST_FRAME_PERMISSION:
      void requestFramePermission(sender, message.origin)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, reason: "PERMISSION_REQUEST_FAILED" }));
      return true;

    case MSG.AUTOFILL_PROGRESS:
      void applyProgress(sender.tab?.id, message.payload).then(() => sendResponse({ ok: true }));
      return true;

    case MSG.AUTOFILL_RESULT:
      void recordResult(sender.tab?.id, message.sessionId, message.result, message.progress)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case MSG.AUTOFILL_FAILED:
      // sender.frameId is Chrome-supplied and therefore trustworthy; a frameId
      // in the message body would be forgeable by a compromised page.
      void applyFailure(sender.tab?.id, message.reasonCode, message.message, sender.frameId).then(() =>
        sendResponse({ ok: true })
      );
      return true;

    case MSG.REQUEST_DOCUMENT:
      void fetchDocument(sender.tab?.id, message.sessionId, message.kind)
        .then((doc) => sendResponse({ ok: true, ...doc }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case MSG.AUDIT_EVENT:
      void auditEvent(sender.tab?.id, message.sessionId, message.action_type, message.field_key, message.status)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case MSG.START_AUTOFILL:
      void startAutofillForTab(message.tabId, message.reason)
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case MSG.CLEAR_SESSION:
      void clearSession(message.tabId).then(() => sendResponse({ ok: true }));
      return true;

    case MSG.COMPLETE_SESSION:
      void completeActive(message.sessionId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case MSG.ACTIVATE_APPLICATION_DESTINATION: {
      const sourceTabId = sender.tab?.id;
      if (typeof sourceTabId !== "number") {
        sendResponse({ ok: false, error: "NO_SOURCE_TAB" });
        return false;
      }
      void navigateToApplicationDestination(sourceTabId, message)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err).slice(0, 80) }));
      return true;
    }

    case MSG.PREPARE_APPLICATION_LAUNCH: {
      const sourceTabId = sender.tab?.id;
      if (typeof sourceTabId !== "number") {
        sendResponse({ ok: false, error: "NO_SOURCE_TAB" });
        return false;
      }
      void prepareApplicationLaunch(sourceTabId, message)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, error: "INTERNAL_HANDOFF_FAILURE" }));
      return true;
    }

    case MSG.RECONNECT_APPLICATION_WORKFLOW: {
      const tabId = sender.tab?.id;
      if (typeof tabId !== "number") {
        sendResponse({ ok: false, reason: "source_tab_missing" });
        return false;
      }
      void reconnectWorkflow(tabId, message.origin)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, reason: "unknown" }));
      return true;
    }

    case MSG.RESOLVE_QUESTIONS: {
      const tabId = sender.tab?.id;
      void (async () => {
        const id = tabId != null ? tabId : await resolveViewTab(undefined);
        const pkg = id != null ? await getPackage(id) : null;
        if (!pkg) {
          sendResponse({ ok: false, error: "SESSION_PACKAGE_FAILED" });
          return;
        }
        try {
          const body = await resolveQuestions(pkg.sessionToken, message.sessionId, message.questions);
          sendResponse({ ok: true, ...body });
        } catch (err) {
          log.info("question resolution failed", { reason: classifyPackageError(err) });
          sendResponse({ ok: false, error: classifyPackageError(err) });
        }
      })();
      return true;
    }

    case MSG.GET_VIEW_STATE:
      void resolveViewTab(message.tabId)
        .then((id) => getView(id ?? -1))
        .then((v) => sendResponse({ ok: true, view: v }));
      return true;

    case MSG.SAVE_ANSWER:
      void handleSaveAnswer(sender.tab?.id, message)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: safeMessage(err) }));
      return true;

    case MSG.RUNTIME_IDENTITY:
      // Answered from THIS worker's own bundle constants, so a stale worker
      // reports its own staleness rather than echoing the caller.
      void (async () => {
        const sidePanelStored = await chrome.storage.local.get(SIDE_PANEL_RUNTIME_KEY);
        const sidePanelCandidate = sidePanelStored[SIDE_PANEL_RUNTIME_KEY] as Partial<RuntimeIdentity> | undefined;
        const sidePanelIdentity = sidePanelCandidate
          && typeof sidePanelCandidate.buildId === "string"
          && typeof sidePanelCandidate.version === "string"
          && typeof sidePanelCandidate.environment === "string"
            ? sidePanelCandidate as RuntimeIdentity
            : null;
        sendResponse({
          ok: true,
          identity: {
            buildId: BUILD_INFO.buildId,
            version: BUILD_INFO.version,
            environment: classifyEnvironment(await getApiBase()),
            apiBase: safeApiBase(await getApiBase())
          },
          sidePanelIdentity,
          // The environment of the XpertApply web app that launched this
          // application, recorded at launch. `null` when nothing launched it.
          ...(await launchWebRuntime())
        });
      })();
      return true;

    case MSG.SET_APPLICATION_OVERRIDE:
      // The background message boundary. The payload is re-validated here even
      // though the content script validated it: this listener is reachable from
      // any script in an extension page, so it cannot assume the caller is the
      // widget.
      void handleSetApplicationOverride(sender.tab?.id, message)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: classifyOverrideError(err) }));
      return true;

    case MSG.GET_APPLICATION_OVERRIDES:
      void handleGetApplicationOverrides(sender.tab?.id, message.sessionId)
        .then((overrides) => sendResponse({ ok: true, overrides }))
        .catch((err) => sendResponse({ ok: false, error: classifyOverrideError(err) }));
      return true;

    case MSG.CONFIRM_NAME:
      void handleConfirmName(sender.tab?.id, message)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: safeMessage(err) }));
      return true;

    case MSG.SUBMISSION_CONFIRMED:
      void confirmSubmissionForSession(message)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: safeMessage(err) }));
      return true;

    case MSG.MANUAL_CONFIRMATION_REQUIRED:
      // The extension could not prove the submission. It records WHY and stops:
      // nothing is marked applied, and the user is asked in the web app.
      void patchView(sender.tab?.id ?? -1, {
        failureCode: message.reason,
        failureRecoverable: true
      }).then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
      return true;

    case MSG.GET_SITE_ACCESS:
      void resolveViewTab(message.tabId)
        .then(async (id) => {
          if (id == null) return { ok: true, need: NO_ACCESS_NEEDED };
          const tab = await chrome.tabs.get(id).catch(() => null);
          const view = await getView(id);
          // A frame-scoped need outranks the page: the page is already granted
          // in that case, and the frame is what the workflow is stuck on.
          if (view?.siteAccess === "site_access_required" && view.siteAccessScope === "frame") {
            return { ok: true, tabId: id, need: {
              state: view.siteAccess, pattern: view.siteAccessPattern,
              origin: view.siteAccessOrigin, scope: "frame" as const
            } };
          }
          return { ok: true, tabId: id, need: await siteAccessFor(tab?.url ?? null) };
        })
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, need: NO_ACCESS_NEEDED }));
      return true;

    case MSG.SITE_ACCESS_RESULT:
      void applySiteAccessResult(message.tabId, message.pattern, message.granted)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case MSG.REQUEST_FILL_LEASE:
      void grantFillLease(sender, message.rootConfident === true)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ granted: false, reason: "LEASE_ERROR" }));
      return true;

    default:
      sendResponse({ ok: false, error: "UNKNOWN_MESSAGE" });
      return false;
  }
});

// --------------------------------------------------------------------------- //
// Launch (user gesture)
// --------------------------------------------------------------------------- //
function handleLaunchRequest(
  payload: LaunchPayload,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void
): void {
  const windowId = sender.tab?.windowId;
  void (async () => {
    try {
      validatePayload(payload);
      const applicationId = String(payload.sessionId);
      const existing = await findPendingByApplication(applicationId);
      if (existing) {
        const tab = await chrome.tabs.get(existing.tabId).catch(() => null);
        if (tab) {
          await chrome.tabs.update(existing.tabId, { active: true, url: payload.officialUrl });
          if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
          await updatePending(existing.tabId, {
            ...handoffFields(payload), targetTabId: existing.tabId, status: "opening", state: "waiting_for_tab"
          });
          await recordSiteAccess(existing.tabId, await siteAccessFor(payload.officialUrl));
          void ensureContentReady(existing.tabId);
          sendResponse({ ok: true, type: MSG.LAUNCH_ACCEPTED, applicationId, tabId: existing.tabId });
          return;
        }
      }
      // Persist first: navigation must never be the only owner of the handoff.
      const pending = await stageHandoff(payload, "opening");
      const created = await chrome.tabs.create({
        url: payload.officialUrl,
        windowId: windowId ?? undefined,
        active: true
      });
      const tabId = created.id;
      if (tabId == null) throw new Error("no tab id");

      const bound = { ...pending, targetTabId: tabId, status: "opening" as const, state: "waiting_for_tab" as const };
      await putPending(tabId, bound);
      await putView(tabId, initialView(tabId, bound, null, null));
      // The employer origin is only knowable now, and a service worker cannot
      // ask Chrome for it. Record what the workflow needs; the side panel —
      // opened by this same user gesture — presents the request.
      await recordSiteAccess(tabId, await siteAccessFor(payload.officialUrl));
      log.info("launch accepted", { requestId: payload.requestId, tabId, origin: pending.expectedOrigin });
      sendResponse({ ok: true, type: MSG.LAUNCH_ACCEPTED, applicationId, tabId });
    } catch (err) {
      log.error("launch failed", { requestId: payload.requestId, reason: "open_or_create" });
      sendResponse({ ok: false, type: MSG.LAUNCH_FAILED, code: "TAB_OPEN_FAILED", message: safeMessage(err) });
    }
  })();
}

async function stageHandoff(payload: LaunchPayload, status: PendingLaunch["status"] = "prepared"): Promise<PendingLaunch> {
  validatePayload(payload);
  const previous = await getActive();
  const createdAt = previous?.applicationId === String(payload.sessionId) ? previous.createdAt : Date.now();
  const launch: PendingLaunch = {
    ...handoffFields(payload), createdAt, expiresAt: Date.now() + LAUNCH_TTL_MS,
    targetTabId: previous?.applicationId === String(payload.sessionId) ? previous.targetTabId : undefined,
    status, state: status === "prepared" ? "package_ready" : "opening_tab"
  };
  await putActive(launch);
  log.info("handoff saved", { requestId: payload.requestId, sessionId: payload.sessionId, state: status });
  return launch;
}

function handoffFields(payload: LaunchPayload) {
  return {
    version: 1 as const, applicationId: String(payload.sessionId), jobId: String(payload.jobId),
    applicationUrl: payload.officialUrl, handoffToken: payload.launchToken,
    requestId: payload.requestId, sessionId: payload.sessionId, launchToken: payload.launchToken,
    officialUrl: payload.officialUrl, expectedOrigin: safeOrigin(payload.officialUrl),
    protocolVersion: PROTOCOL_VERSION, atsType: payload.atsType
  };
}

function validatePayload(payload: LaunchPayload): void {
  if (!payload || !payload.requestId || !payload.launchToken || !Number.isInteger(payload.sessionId) || !Number.isInteger(payload.jobId)) {
    throw new Error("Required handoff fields are missing");
  }
  const parsed = new URL(payload.officialUrl);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    throw new Error("Application URL is unsupported");
  }
}

/**
 * What Chrome host access does this workflow still need?
 *
 * A CHECK, never a request. `chrome.permissions.request()` requires a user
 * gesture and cannot run in a service worker, so the worker's job is to work
 * out which origin is needed and record it; the side panel — an extension page
 * with real clicks — is the only surface that can ask Chrome for it.
 */
export async function siteAccessFor(
  url: string | null | undefined,
  scope: "page" | "frame" = "page"
): Promise<SiteAccessNeed> {
  const pattern = originPatternFor(url);
  if (!pattern) return siteAccessNeedFor(url, false, scope);
  const granted = await chrome.permissions
    .contains({ origins: [pattern] })
    .catch(() => false);
  return siteAccessNeedFor(url, granted, scope);
}

/** Record on the tab's view what the side panel must ask for (or that nothing
 * is outstanding), so the panel renders from durable state rather than from a
 * message that may arrive while it is closed. */
async function recordSiteAccess(tabId: number, need: SiteAccessNeed): Promise<void> {
  await patchView(tabId, {
    siteAccess: need.state,
    siteAccessPattern: need.pattern,
    siteAccessOrigin: need.origin,
    siteAccessScope: need.scope
  });
}

// --------------------------------------------------------------------------- //
// Readiness handshake (pull-based)
// --------------------------------------------------------------------------- //
/**
 * The single gate every ATS-page content script frame must pass before it is
 * allowed to touch the DOM. Employer and ATS origins carry no install-time
 * authority (Stage 3C): there is no declarative content script for them, and a
 * frame only runs XpertApply code after the user has granted its exact origin
 * and the worker has injected there. This gate is what the frame must pass once
 * it is running — Chrome's grant decides whether it runs at all.
 *
 * A tab is "matched" once ANY frame in it (top frame, almost always) reports a
 * URL that matches the active handoff via urlsMatchForHandoff. Binding the tab
 * is NOT the same as trusting what is inside it: a bound tab used to vouch for
 * every frame in itself, which handed the user's profile and résumé to any
 * third-party iframe on the employer's page that happened to look like an
 * application. Each frame is now authorized on its own browser-supplied origin
 * (security/senderTrust) — the top frame against the handoff URL, a nested
 * frame against the workflow's origin graph — so an embedded ATS widget still
 * fills and an unrelated ad, analytics or chat frame gets nothing.
 */
async function handleContentReady(
  sender: chrome.runtime.MessageSender,
  applicationRootDetected: boolean,
  sendResponse: (r: unknown) => void
): Promise<void> {
  // Identity comes from Chrome, never from the message. The frame's URL and
  // whether it is the top frame used to be read out of the payload, which meant
  // the gate below was deciding on the sender's own description of itself.
  const context = describeSender(sender);
  if (!context) {
    sendResponse({ ok: false, matched: false, error: "NO_TAB", launch: null });
    return;
  }
  const { tabId, frameId, isTopFrame } = context;
  let pending = await getPending(tabId);
  let boundVia: "tab_binding" | "active_self_bind" = "tab_binding";
  if (!pending) {
    boundVia = "active_self_bind";
    const active = await getActive();
    if (!active) {
      log.info("destination session resolution", { stage: "tab_binding_lookup", reason: "no_tab_binding" });
      sendResponse({ ok: true, matched: false, error: "HANDOFF_NOT_FOUND", launch: null });
      return;
    }
    if (Date.now() > active.expiresAt) {
      log.info("destination session resolution", { stage: "workflow_lookup", reason: "pending_activation_expired" });
      sendResponse({ ok: true, matched: false, error: "HANDOFF_EXPIRED", launch: null });
      return;
    }
    // Binding the TAB and authorizing this FRAME are different questions. A
    // nested frame that reports in first may bind the tab it lives in — the
    // tab's own top-level URL is honest evidence about the tab — but binding
    // buys it nothing on its own: it still has to pass the frame gate below.
    if (!senderCanBindTab(context, active)) {
      log.info("destination session resolution", { stage: "origin_validation", reason: "handoff_url_mismatch" });
      sendResponse({ ok: true, matched: false, error: "HANDOFF_URL_MISMATCH", launch: null });
      return;
    }
    pending = { ...active, targetTabId: tabId, status: "detecting", state: "detecting_ats" };
    await putPending(tabId, pending);
    await putView(tabId, initialView(tabId, pending, null, null));
  }
  const reject = validateLaunch(pending, context);
  if (reject) {
    // A REFUSED NESTED FRAME IS NOT A TAB FAILURE. Third-party frames — ad
    // slots, analytics, chat widgets — are a normal part of employer pages, and
    // one of them being told "no" says nothing about the application. Reply
    // dormant so that frame goes inert, and leave the tab's state alone:
    // raising a failure here would let any embedded frame paint an error over a
    // perfectly healthy run.
    if (!isTopFrame) {
      log.info("frame refused", { tabId, frameId, reason: reject });
      sendResponse({ ok: true, matched: false, error: reject, launch: null });
      return;
    }
    // The TOP frame is the tab, so its rejection is the tab's rejection.
    // Surface the sanitized launch + a specific error rather than pretending
    // nothing matched — the widget can then show a meaningful failure instead
    // of staying silently blank.
    await applyFailure(tabId, reject);
    sendResponse({ ok: false, matched: true, error: reject, launch: sanitize(pending) });
    return;
  }
  log.info("content script ready", { tabId, frameId, isTopFrame });
  const activation = await readPendingActivation();
  if (activation && (tabId === activation.sourceTabId || tabId === activation.destinationTabId)) {
    await writePendingActivation({
      ...activation,
      destinationTabId: tabId,
      state: applicationRootDetected ? "APPLICATION_DISCOVERED" : "CONTENT_SCRIPT_READY"
    });
  }
  await patchView(tabId, { contentReady: true, state: "fetching_package" });
  // Low-cardinality trace of HOW this tab resolved its binding. No identifiers,
  // no tokens, no URLs — just the shape of the path taken, so a live failure
  // names one specific cause instead of collapsing into "unauthorized".
  log.info("destination session resolution", {
    stage: "package_lookup",
    bound_via: boundVia,
    package_present: String(Boolean(await getPackage(tabId))),
    same_tab: String(pending.targetTabId === tabId)
  });
  try {
    const pkg = await ensurePackage(tabId, pending);
    await patchView(tabId, {
      packageLoaded: true,
      company: pkg.session.company,
      jobTitle: pkg.session.jobTitle,
      sessionId: pkg.session.sessionId
    });
    const rebound = await readPendingActivation();
    if (rebound && (tabId === rebound.sourceTabId || tabId === rebound.destinationTabId)) {
      await writePendingActivation({
        ...rebound,
        destinationTabId: tabId,
        state: applicationRootDetected ? "AUTOFILL_READY" : "SESSION_REBOUND"
      });
    }
    // Hand the content script the meta + session so it can autofill immediately.
    sendResponse({ ok: true, matched: true, launch: sanitize(pending), session: pkg.session, reason: "automatic_launch" as AutofillReason });
  } catch (err) {
    const code = classifyPackageError(err);
    // Name the stage as well as the code: a 401 here means the launch token was
    // already spent AND no session-scoped package could be inherited, which is
    // recoverable, not an expiry.
    log.info("destination session resolution", {
      stage: "backend_session_validation",
      reason: code === "SESSION_UNAUTHORIZED" ? "session_unauthorized" : code.toLowerCase(),
      bound_via: boundVia
    });
    await applyFailure(tabId, code);
    sendResponse({ ok: false, matched: true, error: code, launch: sanitize(pending), recoverable: RECOVERABLE_PACKAGE_CODES.has(code) });
  }
}

// --------------------------------------------------------------------------- //
// Application-frame inspection
//
// The live failure: the destination application renders inside an iframe and
// XpertApply said "the application is inside a frame XpertApply isn't allowed to
// read" — a verdict derived solely from `contentDocument` throwing, which only
// ever proves the frame is cross-origin. Four different causes hide behind that
// sentence, and each has a different remedy:
//
//   • no host permission for the frame origin  -> ask for it, on a user gesture
//   • no content script in the frame           -> inject into that exact frame
//   • sandboxed to an opaque origin            -> reopen the frame as a tab
//   • the frame has no real URL at all         -> nothing to open; say so
//
// This resolves which one it is. Origins and redacted path shapes only: no
// query strings, no tokens, no entered values.
//
// Stage 3C-2: it resolves it from BOTH frame inventories. Chrome's enumeration
// reports only frames the extension may inject into, so the ungranted frame —
// the one whose whole problem is the missing grant — was absent from it, and
// the "no host permission" verdict above was unreachable in the shipped build.
// The top document's own `iframe[src]` markup can see it without any grant, so
// `frames/frameDiscovery` merges the two and marks which is which. Observation
// never becomes identity: those records carry no frame id and are only ever
// candidates after `originJoinsWorkflow` accepts their origin.
// --------------------------------------------------------------------------- //

function frameUrlKind(raw: string | null | undefined): string {
  if (!raw || raw.trim() === "") return "empty";
  const value = raw.trim().toLowerCase();
  if (value === "about:blank") return "about_blank";
  if (value === "about:srcdoc") return "about_srcdoc";
  if (value.startsWith("blob:")) return "blob";
  if (value.startsWith("data:")) return "data";
  if (value.startsWith("https:")) return "https";
  if (value.startsWith("http://localhost") || value.startsWith("http://127.0.0.1")) return "http_local";
  return "other";
}

function redactedFramePath(raw: string | undefined): string | null {
  try {
    const segments = new URL(raw ?? "").pathname.split("/").filter(Boolean).map((segment) => {
      if (/^[a-z]{2}([-_][a-z]{2,4})?$/i.test(segment)) return "<locale>";
      if (/^\d+$/.test(segment)) return "<id>";
      if (/\d/.test(segment) && segment.length >= 8) return "<id>";
      return segment.toLowerCase().slice(0, 32);
    });
    return `/${segments.join("/")}`;
  } catch {
    return null;
  }
}

/**
 * Enumerate this tab's frames.
 *
 * `chrome.webNavigation.getAllFrames` is the only API that reports frames the
 * extension CANNOT reach — which is precisely the case being diagnosed — so it
 * is preferred when the optional permission has been granted. It is optional
 * rather than required because it carries a "read your browsing history"
 * install warning that would otherwise be charged to every user for a
 * diagnostic path most never hit.
 *
 * The fallback derives frame ids from `chrome.scripting.executeScript`, which
 * reports one result per injectable frame. That silently omits frames we lack
 * permission for — a real limitation, and reported as one rather than papered
 * over.
 */
async function enumerateFrames(tabId: number): Promise<{
  frames: { frameId: number; parentFrameId: number; url?: string }[];
  source: "web_navigation" | "scripting_probe";
  complete: boolean;
}> {
  const canUseWebNavigation = await chrome.permissions
    .contains({ permissions: ["webNavigation"] })
    .catch(() => false);
  if (canUseWebNavigation && chrome.webNavigation?.getAllFrames) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
    if (frames) {
      return {
        frames: frames.map((frame) => ({
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          url: frame.url
        })),
        source: "web_navigation",
        complete: true
      };
    }
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      // Returns the frame's own origin+path. Never the query string.
      func: () => `${location.origin}${location.pathname}`
    });
    return {
      frames: results.map((result) => ({
        frameId: result.frameId ?? 0,
        parentFrameId: -1,
        url: typeof result.result === "string" ? result.result : undefined
      })),
      source: "scripting_probe",
      // Frames we cannot inject into never appear here, so this view may be
      // missing exactly the frame we are looking for.
      complete: false
    };
  } catch {
    return { frames: [], source: "scripting_probe", complete: false };
  }
}

/** Ping ONE frame. Unlike a tab-wide ping, this proves that specific frame. */
function pingFrame(tabId: number, frameId: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: MSG.PING_CONTENT }, { frameId }, (resp) => {
        if (lastError()) return resolve(false);
        resolve(Boolean(resp && (resp as { ok?: boolean }).ok));
      });
    } catch {
      resolve(false);
    }
  });
}

/** Ask one frame what application it can see. */
function probeFrameApplication(
  tabId: number,
  frameId: number
): Promise<{ evidence: boolean; fieldCount: number } | null> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: MSG.PROBE_FRAME_APPLICATION }, { frameId }, (resp) => {
        if (lastError()) return resolve(null);
        const value = resp as { evidence?: boolean; fieldCount?: number } | undefined;
        resolve(value ? { evidence: Boolean(value.evidence), fieldCount: Number(value.fieldCount ?? 0) } : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function inspectApplicationFrames(
  sender: chrome.runtime.MessageSender,
  observed: ObservedFramePayload[]
): Promise<{
  tabId: number | null;
  topOrigin: string | null;
  topPathShape: string | null;
  frames: FrameDiscoveryRecord[];
  enumerationSource: string;
  enumerationComplete: boolean;
  outcome: string;
  /** The ONE trusted origin a remedy may target, or null. Exact and portless. */
  candidateOrigin: string | null;
  /** The Chrome match pattern for that origin — never anything broader. */
  candidatePattern: string | null;
  candidateSource: FrameEvidenceSource | null;
}> {
  const tabId = sender.tab?.id ?? null;
  const empty = {
    tabId: null, topOrigin: null, topPathShape: null, frames: [] as FrameDiscoveryRecord[],
    enumerationSource: "none", enumerationComplete: false,
    outcome: "APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE",
    candidateOrigin: null, candidatePattern: null, candidateSource: null
  };
  if (tabId == null) return empty;

  // No workflow, no candidates. Discovery exists to serve an application the
  // user started; without one there is nothing an origin could belong to, and
  // "trusted" would have no meaning to test against.
  const launch = (await getPending(tabId)) ?? (await getActive());
  const workflowUrl = launch?.officialUrl ?? launch?.applicationUrl ?? null;

  // One permission check per DISTINCT origin, not per frame.
  const permissionCache = new Map<string, boolean>();
  const isGranted = async (origin: string): Promise<boolean> => {
    const cached = permissionCache.get(origin);
    if (cached !== undefined) return cached;
    const pattern = patternForOrigin(origin)!;
    const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
    permissionCache.set(origin, granted);
    return granted;
  };

  /**
   * Does this origin belong to the workflow the user actually started?
   *
   * The SAME predicate the frame gate (Stage 3A) and the host-permission gate
   * use. Deliberately not a second allow-list: one policy, one place to audit,
   * one place a suffix-confusion bug could be fixed.
   */
  const trusted = (origin: string | null): boolean => {
    if (!origin || !workflowUrl) return false;
    let candidate: URL;
    try {
      candidate = new URL(origin);
    } catch {
      return false;
    }
    return originJoinsWorkflow(workflowUrl, candidate)
      || candidate.origin.toLowerCase() === safeOrigin(launch?.applicationUrl ?? "");
  };

  // ---- Source 1: Chrome's own enumeration ------------------------------- //
  // Real frame ids, real ping results, real probes — for every frame Chrome is
  // willing to report. Silently omits frames we hold no permission for, which
  // is exactly why it cannot be the only source.
  const enumerated = await enumerateFrames(tabId);
  const sandboxByOrigin = new Map(
    observed
      .filter((frame) => canonicalFrameOrigin(frame.origin))
      .map((frame) => [canonicalFrameOrigin(frame.origin)!, frame])
  );

  const confirmed: FrameDiscoveryRecord[] = [];
  for (const frame of enumerated.frames) {
    const origin = canonicalFrameOrigin(frame.url);
    const hostPermissionGranted = origin ? await isGranted(origin) : false;
    const contentScriptResponds = await pingFrame(tabId, frame.frameId);
    const probe = contentScriptResponds ? await probeFrameApplication(tabId, frame.frameId) : null;
    const parentObserved = origin ? sandboxByOrigin.get(origin) : undefined;
    confirmed.push({
      source: "chrome_confirmed",
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      origin,
      pathShape: redactedFramePath(frame.url),
      urlKind: frameUrlKind(frame.url),
      contentScriptResponds,
      hostPermissionGranted,
      applicationEvidence: Boolean(probe?.evidence),
      fieldCount: probe?.fieldCount ?? 0,
      sandboxTokens: Array.isArray(parentObserved?.sandboxTokens) ? parentObserved!.sandboxTokens : [],
      opaqueOrigin: Boolean(parentObserved?.opaqueOrigin),
      workflowTrusted: trusted(origin)
    });
  }

  // ---- Source 2: the top document's own markup -------------------------- //
  // `iframe[src]` is the PARENT's property and stays readable across origins,
  // so the employer frame — which we do hold a grant for — can name an ATS
  // origin Chrome refuses to report. Page-controlled data: re-canonicalized
  // here rather than trusted as parsed, and worth nothing until it passes the
  // workflow check above.
  const observedRecords: FrameDiscoveryRecord[] = [];
  for (const frame of observed) {
    const origin = canonicalFrameOrigin(frame.origin);
    if (!origin) continue;
    observedRecords.push({
      source: "observed_ungranted",
      // NEVER fabricated. A made-up id would be accepted by sendMessage
      // targeting and would let a hint impersonate a real frame.
      frameId: null,
      parentFrameId: null,
      origin,
      pathShape: typeof frame.pathShape === "string" ? frame.pathShape : null,
      urlKind: typeof frame.urlKind === "string" ? frame.urlKind : "other",
      // Observation proves nothing about what is running inside.
      contentScriptResponds: false,
      hostPermissionGranted: await isGranted(origin),
      applicationEvidence: false,
      fieldCount: Number.isFinite(frame.readableFieldCount) ? Number(frame.readableFieldCount) : 0,
      sandboxTokens: Array.isArray(frame.sandboxTokens) ? frame.sandboxTokens : [],
      opaqueOrigin: Boolean(frame.opaqueOrigin),
      workflowTrusted: trusted(origin)
    });
  }

  const frames = mergeFrameInventories(confirmed, observedRecords);
  const candidate = selectTrustedApplicationCandidate(frames);
  const outcome = frameDiscoveryOutcome(candidate);

  // Hand the finding to the side panel as soon as it is made.
  //
  // `chrome.permissions.request` cannot run in a content script or a worker, so
  // the in-page widget can only ever ASK the worker to record a need — the
  // panel is the one surface that can put the question to Chrome. Recording it
  // here rather than waiting for the widget click means the panel can offer the
  // grant directly, and the user is not left looking at an in-page prompt while
  // the panel says nothing. Only ever the ONE trusted origin, at frame scope.
  if (outcome === "APPLICATION_FRAME_PERMISSION_MISSING" && candidate?.origin) {
    await recordSiteAccess(tabId, siteAccessNeedFor(candidate.origin, false, "frame"));
  }

  log.info("application frame inspection", {
    frames: String(frames.length),
    observedOnly: String(frames.filter((frame) => frame.source === "observed_ungranted").length),
    untrusted: String(frames.filter((frame) => !frame.workflowTrusted).length),
    source: enumerated.source,
    complete: String(enumerated.complete),
    outcome,
    candidateOrigin: candidate?.origin ?? "none",
    candidateSource: candidate?.source ?? "none"
  });

  return {
    tabId,
    topOrigin: sender.tab?.url ? safeOrigin(sender.tab.url) : null,
    topPathShape: redactedFramePath(sender.tab?.url),
    frames,
    enumerationSource: enumerated.source,
    enumerationComplete: enumerated.complete,
    outcome,
    // Only a trusted, canonical https origin may be named to the user, asked
    // for, or reopened. Everything else yields null and the workflow fails
    // closed rather than guessing.
    candidateOrigin: candidate?.urlKind === "https" ? candidate.origin : null,
    candidatePattern: candidate?.urlKind === "https" ? patternForOrigin(candidate.origin) : null,
    candidateSource: candidate?.urlKind === "https" ? candidate.source : null
  };
}

/**
 * Ask for host permission covering ONE frame origin.
 *
 * Called from a user gesture ("Open application form" / "Reconnect"). Never
 * `<all_urls>`, never a broader pattern than the exact origin the user is
 * looking at, and the origin must belong to the active workflow — a page may
 * not talk the worker into granting access to somewhere unrelated.
 */
/**
 * A frame the workflow needs but Chrome does not grant.
 *
 * This used to call `chrome.permissions.request()` here. It cannot work: the
 * API requires a user gesture and a service worker has none, so the promise
 * either rejects or raises a prompt nothing is waiting on. The worker's job is
 * to decide WHICH origin is legitimate — the same workflow origin graph Stage
 * 3A uses — and record it. The side panel does the asking.
 */
async function requestFramePermission(
  sender: chrome.runtime.MessageSender,
  origin: string
): Promise<{ ok: boolean; reason: string; granted?: boolean }> {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false, reason: "NO_TAB" };

  // Canonicalized through the SAME function discovery used, so the origin a
  // grant is requested for is byte-identical to the one that was trusted. A
  // second parse here is a second chance to disagree.
  const canonical = canonicalFrameOrigin(origin);
  if (!canonical) return { ok: false, reason: "INVALID_ORIGIN" };
  let candidate: URL;
  try {
    candidate = new URL(canonical);
  } catch {
    return { ok: false, reason: "INVALID_ORIGIN" };
  }
  if (candidate.protocol !== "https:") return { ok: false, reason: "UNSAFE_SCHEME" };
  // The origin must be part of the workflow this tab is actually running.
  const launch = (await getPending(tabId)) ?? (await getActive());
  if (!launch) return { ok: false, reason: "NO_ACTIVE_WORKFLOW" };
  if (!originJoinsWorkflow(launch.officialUrl ?? launch.applicationUrl, candidate)
    && candidate.origin.toLowerCase() !== safeOrigin(launch.applicationUrl)) {
    return { ok: false, reason: "ORIGIN_NOT_IN_WORKFLOW" };
  }

  const need = await siteAccessFor(candidate.href, "frame");
  if (need.state === "site_access_granted") {
    // Already allowed — a newly permitted origin has no content script yet, so
    // inject into that exact frame rather than waiting for a navigation.
    await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] })
      .catch(() => undefined);
    return { ok: true, reason: "ALREADY_GRANTED", granted: true };
  }
  await recordSiteAccess(tabId, need);
  log.info("frame site access required", { tabId, origin: candidate.origin });
  return { ok: false, reason: "SITE_ACCESS_REQUIRED", granted: false };
}

/**
 * Codes where the SESSION is fine and only this tab's binding is missing. The
 * destination can recover by reconnecting; telling the user to start over would
 * be wrong.
 */
const RECOVERABLE_PACKAGE_CODES = new Set(["SESSION_UNAUTHORIZED", "TOKEN_CONSUMED", "SESSION_PACKAGE_FAILED"]);

/** Classify a session-package load failure precisely instead of the generic
 * "couldn't be loaded" — surfaced verbatim to the widget (dev-safe: a status
 * code and a stable machine code only, never a response body). */
function classifyPackageError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "SESSION_UNAUTHORIZED";
    if (err.status === 404) return "SESSION_NOT_FOUND";
    if (err.status === 410) return "HANDOFF_EXPIRED";
    return "SESSION_PACKAGE_FAILED";
  }
  if (String(err).includes("already used")) return "TOKEN_CONSUMED";
  return "SESSION_PACKAGE_FAILED";
}

/**
 * The pull half of the readiness handshake. It hands out the same session
 * package CONTENT_READY does, so it is gated by the same rule — previously a
 * bound tab made this unconditional for every frame in it.
 */
async function handleGetPending(sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void): Promise<void> {
  const context = describeSender(sender);
  if (!context) {
    sendResponse({ ok: true, matched: false, launch: null });
    return;
  }
  const tabId = context.tabId;
  let pending = await getPending(tabId);
  if (!pending) {
    const active = await getActive();
    if (active && Date.now() <= active.expiresAt && senderCanBindTab(context, active)) {
      pending = { ...active, targetTabId: tabId };
      await putPending(tabId, pending);
    }
  }
  if (!pending) {
    sendResponse({ ok: true, matched: false, launch: null, session: null });
    return;
  }
  const authorized = authorizeFrameForLaunch(context, pending);
  if (!authorized.ok) {
    log.info("frame refused", { tabId, frameId: context.frameId, reason: authorized.reason });
    sendResponse({ ok: true, matched: false, error: authorized.reason, launch: null, session: null });
    return;
  }
  const pkg = await getPackage(tabId);
  sendResponse({ ok: true, matched: true, launch: sanitize(pending), session: pkg?.session ?? null });
}

// --------------------------------------------------------------------------- //
// Canonical autofill trigger (manual retry / continue after navigation)
// --------------------------------------------------------------------------- //
async function startAutofillForTab(
  tabId: number | undefined,
  reason: AutofillReason
): Promise<{ ok: boolean; error?: string }> {
  const id = await resolveViewTab(tabId);
  if (id == null) return { ok: false, error: "NO_TAB" };
  const pending = await getPending(id);
  if (!pending) return { ok: false, error: "SESSION_PACKAGE_FAILED" };
  const ready = await ensureContentReady(id);
  if (!ready) {
    await applyFailure(id, "CONTENT_SCRIPT_NOT_INJECTED");
    return { ok: false, error: "CONTENT_SCRIPT_NOT_INJECTED" };
  }
  try {
    await ensurePackage(id, pending);
  } catch {
    await applyFailure(id, "SESSION_PACKAGE_FAILED");
    return { ok: false, error: "SESSION_PACKAGE_FAILED" };
  }
  await patchView(id, { running: true, failureCode: null, failureMessage: null });
  await sendToTab(id, { type: MSG.AUTOFILL_START, reason });
  return { ok: true };
}

/** Ping the content script; if silent, inject it and ping again with backoff. */
async function ensureContentReady(tabId: number): Promise<boolean> {
  // Checked first and every time. Without a grant there is no XpertApply code
  // on the page at all — a stronger position than a script that is present and
  // declines to act, and one Chrome enforces rather than the extension.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const access = await siteAccessFor(tab?.url ?? null);
  if (access.state !== "site_access_granted") {
    await recordSiteAccess(tabId, access);
    log.info("content script not injected", { reason: access.state });
    return false;
  }
  for (let attempt = 0; attempt < READY_MAX_ATTEMPTS; attempt += 1) {
    if (await pingContent(tabId)) return true;
    // Inject the compiled content script. The host permission this needs is
    // the OPTIONAL grant checked immediately above, not a static one — Stage 3C
    // removed install-time authority over employer origins. allFrames so an
    // application embedded in an iframe is reached too; Chrome injects only
    // into the frames whose origin is actually granted, which is what leaves an
    // ungranted ATS frame for discovery to find.
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    } catch (err) {
      log.warn("inject failed", { tabId, reason: String(err).slice(0, 40) });
    }
    if (await pingContent(tabId)) return true;
    await delay(Math.min(200 * 2 ** attempt, 2000));
  }
  return false;
}

function pingContent(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: MSG.PING_CONTENT }, (resp) => {
        if (lastError()) return resolve(false);
        resolve(Boolean(resp && (resp as { ok?: boolean }).ok));
      });
    } catch {
      resolve(false);
    }
  });
}

// --------------------------------------------------------------------------- //
// Package: exchange the single-use token ONCE, then cache per tab
// --------------------------------------------------------------------------- //
async function ensurePackage(tabId: number, pending: PendingLaunch): Promise<SessionPackage> {
  const cached = await getPackage(tabId);
  if (cached) return cached;
  const inFlight = packageLoads.get(tabId);
  if (inFlight) return inFlight;
  const load = (async () => {
    const again = await getPackage(tabId);
    if (again) return again;
    // Before minting anything: does another tab already hold a package for this
    // exact session? A destination tab that bound itself through the
    // getActive() path never inherited one, and the launch token has already
    // been spent by the listing tab — re-exchanging it returns 401 and surfaces
    // as a lost session. Inheriting the session-scoped package is both correct
    // and the only thing that keeps a cross-tab handoff alive.
    const inherited = await findPackageForSession(pending.sessionId);
    if (inherited) {
      await putPackage(tabId, inherited);
      log.info("inherited session package for destination tab", { reason: "session_scoped_reuse" });
      return inherited;
    }
    const { session_token } = await exchangeLaunchToken(pending.launchToken);
    const session = await fetchSessionData(session_token, pending.sessionId);
    const pkg: SessionPackage = { sessionToken: session_token, session, cachedAt: Date.now() };
    await putPackage(tabId, pkg);
    await updatePending(tabId, { status: "detecting", state: "detecting_ats" });
    return pkg;
  })();
  packageLoads.set(tabId, load);
  try { return await load; } finally { packageLoads.delete(tabId); }
}

async function fetchDocument(
  tabId: number | undefined,
  sessionId: number,
  kind: "resume" | "cover-letter"
): Promise<{ dataUrl: string; filename: string }> {
  const id = await resolveViewTab(tabId);
  const pkg = id != null ? await getPackage(id) : null;
  if (!pkg) throw new Error("SESSION_PACKAGE_FAILED");
  const base = await getApiBase();
  const res = await fetch(`${base}/application-sessions/${sessionId}/${kind}?fmt=pdf`, {
    headers: { Authorization: `Bearer ${pkg.sessionToken}` }
  });
  if (!res.ok) throw new Error(`DOCUMENT_DOWNLOAD_FAILED_${res.status}`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error("DOCUMENT_DOWNLOAD_FAILED_EMPTY");
  const mime = res.headers.get("content-type")?.split(";")[0] || "application/pdf";
  const disposition = res.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : plain || `${kind}.pdf`;
  return { dataUrl: `data:${mime};base64,${toBase64(buffer)}`, filename };
}

async function auditEvent(
  tabId: number | undefined,
  sessionId: number,
  actionType: string,
  fieldKey?: string,
  status?: string
): Promise<void> {
  const id = await resolveViewTab(tabId);
  const pkg = id != null ? await getPackage(id) : null;
  if (!pkg) return;
  await postEvent(pkg.sessionToken, sessionId, { action_type: actionType, field_key: fieldKey, status });
}

/** "Save for future applications" from the review widget — the extension's
 * only answer-vault write, always an explicit user confirmation. Never
 * falsely reports success: SESSION_PACKAGE_FAILED / the API's own error surfaces
 * back to the widget so it can show a real failure instead of a false save. */
async function handleSaveAnswer(
  tabId: number | undefined,
  message: {
    sessionId: number;
    canonicalKey: string;
    value: string;
    displayValue?: string;
    scope?: string;
    companyKey?: string;
  }
): Promise<void> {
  const id = await resolveViewTab(tabId);
  const pkg = id != null ? await getPackage(id) : null;
  if (!pkg) throw new Error("SESSION_PACKAGE_FAILED");
  await saveSessionAnswer(pkg.sessionToken, message.sessionId, message.canonicalKey, {
    value: message.value,
    display_value: message.displayValue,
    scope: message.scope,
    company_key: message.companyKey
  });
}

/**
 * Store one application-only answer.
 *
 * Reuses the SAME session package every other authenticated call uses, so
 * there is no second token and no second auth path to keep in step. The
 * canonical key and the boolean are all that travel; the server stamps the rest.
 */
async function handleSetApplicationOverride(
  tabId: number | undefined,
  message: { sessionId: number; canonicalKey: string; value: boolean }
): Promise<{ sourceLabel: string }> {
  // The same validator the widget and content script use, so this boundary
  // cannot be laxer than they are. `fieldKey` is a ledger key that means nothing
  // out here — the worker addresses a canonical QUESTION, never a control — so a
  // placeholder satisfies the shape without inventing a claim.
  const validation = validateOverrideRequest({
    action: "answer_for_this_application",
    fieldKey: "background",
    canonicalKey: message.canonicalKey,
    answerType: "boolean",
    value: message.value,
    sessionId: message.sessionId
  });
  if (!validation.ok) throw new OverrideRefused(validation.reason);

  const id = await resolveViewTab(tabId);
  const pkg = id != null ? await getPackage(id) : null;
  if (!pkg) throw new Error("SESSION_PACKAGE_FAILED");
  const result = await setApplicationOverride(
    pkg.sessionToken,
    validation.request.sessionId,
    validation.request.canonicalKey,
    // The one field that may cross. Not spread from the message.
    { value: validation.request.value }
  );
  // Low-cardinality only: which question, never the answer. `canonical_key` is
  // a registry name, not user data.
  log.info("application answer stored", { key: result.canonical_key });
  return { sourceLabel: result.source_label };
}

async function handleGetApplicationOverrides(
  tabId: number | undefined,
  sessionId: number
): Promise<string[]> {
  const id = await resolveViewTab(tabId);
  const pkg = id != null ? await getPackage(id) : null;
  if (!pkg) throw new Error("SESSION_PACKAGE_FAILED");
  const body = await fetchApplicationOverrides(pkg.sessionToken, sessionId);
  return body.overrides.map((entry) => entry.canonical_key);
}

// --------------------------------------------------------------------------- //
// Which deployment the user's profile lives in
// --------------------------------------------------------------------------- //
const WEB_RUNTIME_KEY = "jobpilotWebRuntimeV2";

/**
 * Record the environment CATEGORY of the XpertApply web app that is talking to us.
 *
 * Stored rather than derived on demand because by the time an employer page is
 * open, the XpertApply tab may be long gone. A category — never the origin — so
 * the value is safe to surface in diagnostics.
 */
async function rememberWebRuntime(
  origin: string,
  apiBase?: string,
  authenticatedUserId?: number | null
): Promise<void> {
  if (!isApprovedJobPilotOrigin(origin)) return;
  const environment = classifyEnvironment(origin);
  try {
    await chrome.storage.local.set({
      [WEB_RUNTIME_KEY]: {
        webEnvironment: environment,
        webApiBase: apiBase ? safeApiBase(apiBase) : null,
        webAuthenticatedUserId: typeof authenticatedUserId === "number"
          ? authenticatedUserId
          : null
      }
    });
  } catch {
    // Non-fatal: the check degrades to "unknown", which never blocks.
  }
}

async function launchWebRuntime(): Promise<{
  webEnvironment: ApiEnvironment | null;
  webApiBase: string | null;
  webAuthenticatedUserId: number | null;
}> {
  try {
    const stored = await chrome.storage.local.get(WEB_RUNTIME_KEY);
    const value = stored[WEB_RUNTIME_KEY] as Record<string, unknown> | undefined;
    return {
      webEnvironment: typeof value?.webEnvironment === "string"
        ? value.webEnvironment as ApiEnvironment
        : null,
      webApiBase: typeof value?.webApiBase === "string" ? value.webApiBase : null,
      webAuthenticatedUserId: typeof value?.webAuthenticatedUserId === "number"
        ? value.webAuthenticatedUserId
        : null
    };
  } catch {
    return { webEnvironment: null, webApiBase: null, webAuthenticatedUserId: null };
  }
}

/** A request this worker refused before it reached the network. */
class OverrideRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "OverrideRefused";
  }
}

/**
 * Turn a failure into a code the widget can explain.
 *
 * Never carries a response body, a URL, or the answer: the classification is
 * the whole message. 403 is distinguished from 401 because they mean different
 * things to the user (lost access vs. not this session's to answer), and 422
 * from both because it is a policy refusal, not an auth problem.
 */
function classifyOverrideError(err: unknown): string {
  if (err instanceof OverrideRefused) return "ANSWER_NOT_PERMITTED";
  if (err instanceof ApiError) {
    if (err.status === 401) return "SESSION_UNAUTHORIZED";
    if (err.status === 403) return "SESSION_FORBIDDEN";
    if (err.status === 404) return "SESSION_NOT_FOUND";
    if (err.status === 410) return "SESSION_EXPIRED";
    if (err.status === 422) return "ANSWER_NOT_PERMITTED";
    return "UNKNOWN";
  }
  const text = String(err);
  if (/abort|timeout/i.test(text)) return "TIMEOUT";
  if (/failed to fetch|network/i.test(text)) return "NETWORK_UNAVAILABLE";
  return "UNKNOWN";
}

async function handleConfirmName(
  tabId: number | undefined,
  message: {
    sessionId: number;
    firstName: string;
    lastName: string;
    middleName?: string;
    preferredFirstName?: string;
    preferredLastName?: string;
  }
): Promise<void> {
  const id = await resolveViewTab(tabId);
  const pkg = id != null ? await getPackage(id) : null;
  if (!pkg) throw new Error("SESSION_PACKAGE_FAILED");
  await confirmSessionName(pkg.sessionToken, message.sessionId, {
    firstName: message.firstName,
    lastName: message.lastName,
    middleName: message.middleName,
    preferredFirstName: message.preferredFirstName,
    preferredLastName: message.preferredLastName
  });
}

async function recordResult(
  tabId: number | undefined,
  sessionId: number,
  result: AutofillResult,
  progress: ProgressPayload
): Promise<void> {
  const id = await resolveViewTab(tabId);
  if (id != null) {
    await applyProgress(id, progress);
    await patchView(id, {
      running: false,
      state: result.status === "completed_with_review" ? "completed_with_review" : "completed"
    });
  }
  const pkg = id != null ? await getPackage(id) : null;
  if (pkg) await reportAutofillResult(pkg.sessionToken, sessionId, result).catch(() => undefined);
}

async function completeActive(sessionId: number): Promise<void> {
  // Find the package holding this session across tabs.
  const entry = await findPackageBySession(sessionId);
  if (!entry) throw new Error("No active session token");
  await completeSession(entry.sessionToken, sessionId);
}

/**
 * Sessions this worker has already confirmed.
 *
 * The server is the real idempotency boundary (uq_tracker_user_job), so this is
 * only a courtesy: an ATS success page that fires a mutation observer several
 * times should not produce several network calls for the same submission. It is
 * deliberately NOT the correctness mechanism — a service-worker restart clears
 * it, and the retry that follows is still safe.
 */
const CONFIRMED_SESSIONS = new Set<number>();

/**
 * Record a confirmed ATS submission. Reached only from
 * ``evaluateSubmissionEvidence`` returning ``confirmed: true``.
 *
 * The session token identifies the job and the owner server-side. A content
 * script on an employer page cannot name a different session than the one its
 * tab holds a package for, and a session id with no package here is refused
 * outright rather than guessed at.
 */
async function confirmSubmissionForSession(
  message: Extract<RuntimeMessage, { type: typeof MSG.SUBMISSION_CONFIRMED }>
): Promise<{ alreadyConfirmed: boolean }> {
  if (CONFIRMED_SESSIONS.has(message.sessionId)) {
    return { alreadyConfirmed: true };
  }
  const entry = await findPackageBySession(message.sessionId);
  if (!entry) throw new Error("SESSION_NOT_FOUND");

  const result = await confirmSubmission(entry.sessionToken, message.sessionId, {
    evidence_type: message.evidenceType,
    submission_timestamp: message.submissionTimestamp,
    submission_reference: message.submissionReference,
    ats: message.ats
  });
  // Only remember it once the server has actually accepted it — a failed call
  // must stay retryable.
  CONFIRMED_SESSIONS.add(message.sessionId);
  return { alreadyConfirmed: result.already_applied };
}

async function clearSession(tabId: number | undefined): Promise<void> {
  const id = await resolveViewTab(tabId);
  if (id == null) return;
  await sendToTab(id, { type: MSG.CLEAR_SESSION });
  await patchView(id, { running: false, filled: 0, skipped: 0, reviewRequired: 0 });
}

// --------------------------------------------------------------------------- //
// View-state updates
// --------------------------------------------------------------------------- //
async function applyProgress(tabId: number | undefined, p: ProgressPayload): Promise<void> {
  if (tabId == null) return;
  const durableStatus: PendingLaunch["status"] = p.state === "failed" ? "failed"
    : p.state === "completed_with_review" ? "review_required"
    : p.state === "completed" ? "ready"
    : p.state === "filling" ? "filling" : "detecting";
  await updatePending(tabId, { status: durableStatus, state: p.state });
  const resumeUploaded = p.documentsUploaded.includes("resume");
  const coverUploaded = p.documentsUploaded.includes("cover_letter");
  await patchView(tabId, {
    state: p.state,
    atsId: p.atsId,
    atsDisplayName: p.atsDisplayName,
    limited: p.limited,
    fieldsDiscovered: p.fieldsDiscovered,
    filled: p.filled,
    skipped: p.skipped,
    reviewRequired: p.reviewRequired,
    reachedFinalStep: p.reachedFinalStep,
    resumeStatus: resumeUploaded ? "uploaded" : p.reviewDocuments.includes("resume") ? "review" : "pending",
    coverStatus: coverUploaded ? "uploaded" : p.reviewDocuments.includes("cover_letter") ? "review" : "pending"
  });
  // Only the top frame owns the floating widget, but the authoritative fill may
  // run inside an embedded ATS iframe. Mirror the PII-free progress back to the
  // tab so the top-frame widget reflects the iframe's terminal state.
  await sendToTab(tabId, { type: MSG.AUTOFILL_PROGRESS, payload: p });
}

// Terminal handoff/session failures: retrying re-asks the background the same
// question and gets the same answer, so the widget/side panel must not offer
// a Retry that just repeats it — the user has to go back to XpertApply instead.
const TERMINAL_FAILURE_CODES = new Set([
  "HANDOFF_URL_MISMATCH", "WRONG_TAB", "HANDOFF_NOT_FOUND", "HANDOFF_EXPIRED",
  "HANDOFF_SCHEMA_OUTDATED", "TOKEN_CONSUMED", "SESSION_UNAUTHORIZED", "SESSION_NOT_FOUND"
]);

// --------------------------------------------------------------------------- //
// Frame registry
// --------------------------------------------------------------------------- //
/**
 * Sanitized per-frame probes, keyed by TRUSTED identity.
 *
 * The key is built from `sender.tab.id` and `sender.frameId`, which Chrome
 * supplies — never from anything in the message body, which a compromised page
 * could forge to impersonate another frame.
 *
 * Probes hold counts and scores only (see frames/probe.ts); no entered values,
 * tokens or full URLs ever reach this map.
 */
type RegisteredFrame = {
  tabId: number;
  frameId: number;
  isTopFrame: boolean;
  sanitizedUrl: string;
  rootConfident: boolean;
  applicationLabels: number;
  bestScore: number;
  at: number;
};

const frameRegistry = new Map<string, RegisteredFrame>();

const frameKey = (tabId: number, frameId: number): string => `${tabId}:${frameId}`;

export function registerFrameProbe(
  tabId: number,
  frameId: number,
  probe: { isTopFrame: boolean; sanitizedUrl: string; rootConfident: boolean; applicationLabelsFound: string[]; bestScore: number }
): void {
  frameRegistry.set(frameKey(tabId, frameId), {
    tabId,
    frameId,
    isTopFrame: probe.isTopFrame,
    sanitizedUrl: probe.sanitizedUrl,
    rootConfident: probe.rootConfident,
    applicationLabels: probe.applicationLabelsFound.length,
    bestScore: probe.bestScore,
    at: Date.now()
  });
}

/**
 * How long a frame probe may vouch for a page.
 *
 * Frame lifecycle is tracked by age rather than chrome.webNavigation: that API
 * would add a "read your browsing history" permission warning purely for a
 * bookkeeping nicety. A frame that still exists re-registers on every
 * CONTENT_READY, so a live application frame stays fresh; a frame that has
 * navigated away simply stops refreshing and expires.
 */
const FRAME_PROBE_TTL_MS = 60_000;

/** Frames in this tab (excluding `exceptFrameId`) that look like they hold a
 * real application. Used to veto a per-frame failure. */
function credibleApplicationFrames(tabId: number, exceptFrameId?: number): number[] {
  const out: number[] = [];
  const now = Date.now();
  for (const frame of frameRegistry.values()) {
    if (frame.tabId !== tabId) continue;
    if (exceptFrameId != null && frame.frameId === exceptFrameId) continue;
    if (now - frame.at > FRAME_PROBE_TTL_MS) continue;
    // Either a resolved root, or enough application labels that a rescan is
    // worthwhile (root scoring can fail mid-hydration).
    if (frame.rootConfident || frame.applicationLabels >= 2) out.push(frame.frameId);
  }
  return out;
}

/** Drop registrations for a tab (navigation, close, or session change) so a
 * stale frame can never vouch for a page that no longer exists. */
// --------------------------------------------------------------------------- //
// Fill lease — which frame in this tab is THE application
//
// A tab legitimately contains more than one application-shaped form: the real
// application, a same-origin vendor widget that happens to ask for a name and
// an e-mail, a second embedded ATS. Every frame resolved its own root
// independently and every frame that liked what it saw filled, so the user's
// profile and résumé went into forms they never applied to. Stage 3A stopped
// that at the ORIGIN boundary; this stops it inside the origins that remain.
//
// Only a frame that has already resolved a confident application root asks for
// a lease, which is what makes the ranking simple: the top document is the page
// the user was sent to, so if IT holds the application, no nested frame does.
// --------------------------------------------------------------------------- //

interface FillLease {
  frameId: number;
  at: number;
}

const fillLeases = new Map<number, FillLease>();

/**
 * How long to wait for the top frame's probe before ruling.
 *
 * The wait exists to avoid a spurious refusal while frame 0 is still reporting.
 * It is NOT a fallback: if the probe never arrives the answer is "we could not
 * establish which frame is the application", and that refuses. A timer expiring
 * is not evidence about a frame.
 */
const TOP_FRAME_PROBE_WAIT_MS = 2_000;

async function awaitTopFrameProbe(tabId: number): Promise<RegisteredFrame | null> {
  const deadline = Date.now() + TOP_FRAME_PROBE_WAIT_MS;
  for (;;) {
    const frame = frameRegistry.get(frameKey(tabId, 0));
    if (frame) return frame;
    if (Date.now() >= deadline) return null;
    await delay(100);
  }
}

/**
 * Nested frames in this tab that could legitimately BE the application.
 *
 * Mirrors selectApplicationFrame's rule — a resolved root outranks any amount
 * of raw control count — and additionally drops frames Stage 3A has already
 * excluded on origin. That filter is load-bearing in both directions: an
 * unauthorized frame must not be able to win the lease, and it must not be able
 * to create a tie that stops the real application from filling. Without it, any
 * page could disable autofill just by embedding an application-shaped
 * third-party iframe.
 */
function credibleNestedFrames(tabId: number, launch: PendingLaunch): RegisteredFrame[] {
  return [...frameRegistry.values()]
    .filter((frame) => frame.tabId === tabId && frame.frameId !== 0 && frame.rootConfident)
    .filter((frame) => {
      try {
        return originJoinsLaunchWorkflow(launch, new URL(frame.sanitizedUrl));
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.bestScore - a.bestScore);
}

export async function grantFillLease(
  sender: chrome.runtime.MessageSender,
  rootConfident: boolean
): Promise<{ granted: boolean; reason: string }> {
  const context = describeSender(sender);
  if (!context) return { granted: false, reason: "NO_SENDER_TAB" };

  // Re-check the Stage 3A gate here too: a lease must never be a second way
  // into a tab a frame is not authorized for.
  const pending = await getPending(context.tabId);
  if (!pending) return { granted: false, reason: "NO_ACTIVE_LAUNCH" };
  const authorized = authorizeFrameForLaunch(context, pending);
  if (!authorized.ok) return { granted: false, reason: authorized.reason };

  const held = fillLeases.get(context.tabId);
  if (held && held.frameId === context.frameId) {
    return { granted: true, reason: "ALREADY_HELD" };
  }

  // The top document is the page the user was sent to, and it only asks once it
  // has resolved an application root of its own. That is positive evidence, and
  // it outranks every nested frame.
  if (context.isTopFrame) {
    fillLeases.set(context.tabId, { frameId: context.frameId, at: Date.now() });
    log.info("fill lease granted", { tabId: context.tabId, frameId: context.frameId, reason: "top_frame" });
    return { granted: true, reason: "TOP_FRAME" };
  }

  // A nested frame needs POSITIVE evidence that the top frame is not the
  // application. Only frame 0's own probe can establish that.
  const top = await awaitTopFrameProbe(context.tabId);
  if (!top) {
    // Never heard from frame 0. We do not know whether the top document holds
    // the application, so we do not know that this frame is the one to fill.
    // Deliberately NOT terminal: the content script may retry, and a probe
    // arriving later can settle it.
    log.info("fill lease refused", {
      tabId: context.tabId, frameId: context.frameId, reason: "frame_selection_unresolved"
    });
    return { granted: false, reason: "FRAME_SELECTION_UNRESOLVED" };
  }
  if (top.rootConfident) {
    log.info("fill lease refused", {
      tabId: context.tabId, frameId: context.frameId, reason: "top_frame_owns_application"
    });
    return { granted: false, reason: "TOP_FRAME_OWNS_APPLICATION" };
  }
  if (held) {
    log.info("fill lease refused", {
      tabId: context.tabId, frameId: context.frameId, reason: "another_frame_holds_lease"
    });
    return { granted: false, reason: "ANOTHER_FRAME_HOLDS_APPLICATION" };
  }

  // Several nested frames can each hold something application-shaped — the real
  // application and a vendor widget that asks for a name and an e-mail. Fill
  // one only when the evidence names it: a single credible frame, or a strict
  // best by score. A tie is not a decision, so nobody fills.
  const credible = credibleNestedFrames(context.tabId, pending);
  if (credible.length > 1) {
    const [best, runnerUp] = credible;
    if (best.bestScore === runnerUp.bestScore || best.frameId !== context.frameId) {
      log.info("fill lease refused", {
        tabId: context.tabId, frameId: context.frameId, reason: "multiple_candidate_frames"
      });
      return { granted: false, reason: "FRAME_SELECTION_AMBIGUOUS" };
    }
  }
  if (credible.length === 0 && !rootConfident) {
    // Nothing anywhere reported a resolved application root, including this
    // frame. There is no positive selection to act on.
    return { granted: false, reason: "FRAME_SELECTION_UNRESOLVED" };
  }

  fillLeases.set(context.tabId, { frameId: context.frameId, at: Date.now() });
  log.info("fill lease granted", {
    tabId: context.tabId, frameId: context.frameId, reason: "embedded_application"
  });
  return { granted: true, reason: "EMBEDDED_APPLICATION" };
}

/**
 * The side panel asked Chrome and got an answer. Resume or stop.
 *
 * The worker re-CHECKS rather than trusting the panel's `granted` flag: the
 * panel is extension code, but a permission is a fact about Chrome's state, and
 * asking Chrome is both cheap and the only authority that matters.
 */
async function applySiteAccessResult(
  tabId: number | undefined,
  pattern: string,
  granted: boolean
): Promise<{ ok: boolean; state: string }> {
  const id = await resolveViewTab(tabId);
  if (id == null) return { ok: false, state: "no_workflow" };

  const reallyGranted = await chrome.permissions
    .contains({ origins: [pattern] })
    .catch(() => false);

  if (!reallyGranted) {
    // Declined. The workflow stops here rather than re-asking: a permission
    // prompt loop is its own kind of harm, and the user said no.
    await patchView(id, {
      siteAccess: granted ? "site_access_required" : "site_access_denied",
      failureCode: "SITE_ACCESS_DENIED",
      failureRecoverable: true
    });
    log.info("site access declined", { tabId: id });
    return { ok: false, state: "site_access_denied" };
  }

  await patchView(id, {
    siteAccess: "site_access_granted",
    failureCode: null,
    failureMessage: null
  });
  log.info("site access granted", { tabId: id });
  // Now that Chrome allows it, put the content script on the page.
  await ensureContentReady(id).catch(() => false);
  return { ok: true, state: "site_access_granted" };
}

/** Drop the lease when the tab navigates or closes, so the next page starts clean. */
export function clearFillLease(tabId: number): void {
  fillLeases.delete(tabId);
}

export function clearFrameRegistry(tabId: number, frameId?: number): void {
  if (frameId == null) clearFillLease(tabId);
  for (const [key, frame] of frameRegistry) {
    if (frame.tabId !== tabId) continue;
    if (frameId != null && frame.frameId !== frameId) continue;
    frameRegistry.delete(key);
  }
}

/** Sanitized snapshot for Copy diagnostics. */
export function frameRegistrySnapshot(tabId: number): RegisteredFrame[] {
  return Array.from(frameRegistry.values()).filter((f) => f.tabId === tabId);
}

/**
 * Failure codes that describe ONE FRAME's view of the page, not the tab's.
 *
 * The live cross-origin failure: the application sits in an iframe, so the top
 * frame's own document genuinely has no application and reports
 * NO_APPLICATION_FORM. Because that was treated as a tab-level verdict, the
 * widget showed "XpertApply couldn't identify the application form on this page"
 * while the iframe held the entire application.
 *
 * These codes may only become a tab failure once NO frame in the tab has a
 * credible application.
 */
const PER_FRAME_FAILURE_CODES = new Set([
  "FORM_NOT_RENDERED",
  "NO_APPLICATION_FORM",
  "APPLICATION_FORM_AMBIGUOUS"
]);

async function applyFailure(
  tabId: number | undefined,
  code: string,
  message?: string,
  frameId?: number
): Promise<void> {
  if (tabId == null) return;
  // A form-hosting page can have several frames; a frame with no fields of its
  // own (an ad, a tracker, a sibling iframe, or a carrier page whose
  // application is embedded) legitimately fails while another frame holds the
  // real application. Never let that per-frame signal regress an in-progress or
  // completed tab, and never let it speak for frames it cannot see.
  if (PER_FRAME_FAILURE_CODES.has(code)) {
    const current = await getView(tabId);
    if (current && ["filling", "completed", "completed_with_review"].includes(current.state)) return;

    const others = credibleApplicationFrames(tabId, frameId);
    if (others.length > 0) {
      log.info("ignoring per-frame failure; another frame holds the application", {
        tabId, frameId: frameId ?? -1, code, otherFrames: others
      });
      return;
    }
  }
  const recoverable = !TERMINAL_FAILURE_CODES.has(code);
  await updatePending(tabId, {
    status: "failed", state: "failed", failureCode: code,
    lastError: { code, message: message ?? code, recoverable }
  });
  await patchView(tabId, {
    running: false, state: "failed", failureCode: code, failureMessage: message ?? null, failureRecoverable: recoverable
  });
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //
/**
 * Non-top frames are trusted once the TAB is bound to a handoff (their own
 * URL rarely resembles the employer page URL — e.g. a Greenhouse iframe
 * embedded in a MongoDB careers page). Only the top frame is re-checked
 * against the handoff URL on every call, so a tab that has since navigated
 * away from the employer page stops auto-filling.
 */
/**
 * The single gate a frame must pass before it may hold the user's data.
 *
 * Returns null to allow, or a named refusal code. The frame rule itself lives
 * in security/senderTrust so the top-frame and nested-frame cases cannot drift
 * apart, and so it can be tested without a service worker.
 */
function validateLaunch(pending: PendingLaunch, sender: SenderContext): string | null {
  if (pending.protocolVersion !== PROTOCOL_VERSION) return "PROTOCOL_MISMATCH";
  if (pending.targetTabId != null && pending.targetTabId !== sender.tabId) return "WRONG_TAB";
  if (Date.now() > pending.expiresAt) return "HANDOFF_EXPIRED";
  const authorized = authorizeFrameForLaunch(sender, pending);
  return authorized.ok ? null : authorized.reason;
}

/** Never expose the launch token beyond the background. */
function sanitize(p: PendingLaunch): Omit<PendingLaunch, "launchToken"> {
  const { launchToken: _t, ...safe } = p;
  return safe;
}

async function resolveViewTab(tabId?: number): Promise<number | undefined> {
  if (tabId != null) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function sendToTab(tabId: number, message: object): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, () => {
        void lastError();
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return "";
  }
}

function safeMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : "Unknown extension error";
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
