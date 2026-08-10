/**
 * Content script with two roles depending on where it runs:
 *
 * 1. JobPilot web origin: a detection handshake (PING/PONG) and — critically —
 *    a CAPTURE-PHASE click listener on the JobPilot Apply button that forwards a
 *    LAUNCH_REQUEST to the background *synchronously within the real click*, so
 *    the background can open the side panel while the user gesture is still
 *    valid. The launch payload is staged into this isolated content world (never
 *    left in the DOM); only the request id lives on the button.
 *
 * 2. Employer/ATS page: announces readiness (CONTENT_READY), pulls the pending
 *    launch + session for THIS exact tab from the background, and runs the one
 *    canonical autofill runner automatically. It also answers a manual retry
 *    (AUTOFILL_START) with the same runner. It locates the submit control only
 *    to warn; it never clicks it.
 */

import { detectAdapter, type DetectionOutcome } from "../ats/registry";
import {
  actuateTikTokLegalField,
  discoverTikTokApplication,
  mergeTikTokLegalFields,
  TikTokApplicationAdapter,
  tikTokFailureCode,
  type TikTokAdapterTrace
} from "../ats/tiktokApplication";
import { clearJobPilotFields, fillField } from "../fields/fill";
import { EXTENSION_CAPABILITIES, getApiBase, isApprovedJobPilotOrigin } from "../config";
import { log } from "../logger";
import {
  MSG,
  PAGE_SOURCE_EXT,
  PROTOCOL_VERSION,
  parsePageMessage,
  parseRuntimeMessage,
  type AutofillReason,
  type ExtensionInfo,
  type LaunchPayload,
  type PageMessage,
  type ProgressPayload
} from "../messages";
import type { ApplicationSessionData, DiscoveredField } from "../types";
import {
  computeCounts,
  mergeLedger,
  type LedgerCounts,
  type LedgerEntry
} from "../fields/ledger";
import { prepareDocumentUploads, runAutofill, type PreparedDocumentUploads } from "./autofill";
import { buildDiagnostics, type QuestionExecutionTrace } from "./diagnostics";
import { buildReviewModel } from "./review";
import {
  buildAuthoritativeReviewItems,
  buildConfirmedReviewItems,
  focusReviewTarget,
  type AuthoritativeReviewItem
} from "./reviewItems";
import { createApplicationAnswerHandlers } from "./applicationAnswer";
import { startTeachMode, type LearnScope, type LearnedAnswer } from "./teach";
import { resolveApplicationForm } from "../ats/base";
import type { FormRootResult } from "../ats/formRoot";
import { probeFrame } from "../frames/probe";
import { deepQueryAll, scopedElementById } from "../dom/deepDom";
import { accessibleName, findActivationCandidates, selectActivationControl } from "../ats/applicationSurface";
import { resolveApplyDestination } from "../ats/applyDestination";
import {
  activateApplyCta,
  classifyPage,
  ctaFingerprint,
  findSafeConsentDismissal,
  isCtaObstructed,
  isEmployerAuthPage
} from "../ats/pageState";
import { BUILD_INFO } from "../buildInfo";
import {
  classifyEnvironment,
  safeApiBase,
  evaluateHandshake,
  handshakeSummary,
  type ApiEnvironment,
  type HandshakeVerdict,
  type RuntimeHandshake,
  type RuntimeIdentity
} from "../runtimeIdentity";
import {
  createWidget,
  type ReviewActionHandlers,
  type ReviewHandlers,
  type ReviewItem,
  type TransactionPanelItem,
  type WidgetStage
} from "./widget";
import { claimContentInstance, makeContentInstanceId } from "./instance";
import { ResolutionRunCoordinator, type EligibilityRun } from "./resolutionRun";
import { fillStructuredRepeaters } from "../fields/repeaters";
import { discoverFields } from "../fields/discovery";
import { scan } from "../fields/runner";
import { AtsLifecycleRun, domMetrics, waitForAtsParse } from "./atsLifecycle";
import {
  awaitApplicationReadiness,
  collectApplicationEvidence,
  hasApplicationEvidence,
  type ReadinessResult
} from "./applicationReadiness";
import {
  frameVerdict,
  observeFrames,
  reopenableFrameUrl,
  selectApplicationFrame
} from "../frames/frameInventory";
import { reconcileAtsValues, type ReconciledField } from "./reconciliation";
import {
  fillRepeatableSections,
  structuredCandidateCounts,
  type SectionTrace
} from "../application/repeatableSections";
import {
  verifyFinalLiveDom,
  type FinalControlVerification,
  type FinalVerificationResult
} from "./finalVerification";
import {
  buildQuestionBatch,
  fieldRef,
  matchResults,
  needsEnumeration,
  resolutionIsStale,
  type PreparedQuestion,
  type ResolutionResult
} from "./questionBatch";
import { enumerateOptions, selectApprovedOption, type TransactionResult } from "./dropdownTransaction";
import {
  QuestionLedger,
  STAGE_LABEL,
  absorbScalarLedger,
  type QuestionState,
  type WidgetStageName
} from "./questionLedger";

// Declarative injection and the background's readiness fallback can both run.
// The newest instance owns the frame; older current-build instances check this
// predicate and become inert. Crucially, we DO NOT skip when an old boolean
// guard is present: that is the frozen state left by an extension reload.
const isCurrentInstance = claimContentInstance(
  window as unknown as Record<string, unknown>,
  makeContentInstanceId(BUILD_INFO.buildId)
);

if (isApprovedJobPilotOrigin(location.origin)) {
  // Never let ATS-only code (DOM scanning, adapters) reach the web-origin role
  // even indirectly.
  try {
    initWebOrigin();
    log.debug("bridge loaded");
  } catch (err) {
    log.error("bridge init failed", { reason: String(err).slice(0, 60) });
  }
} else {
  void initAtsPage();
}

// --------------------------------------------------------------------------- //
// 1. JobPilot web origin: validated, acknowledged bridge
// --------------------------------------------------------------------------- //
function initWebOrigin(): void {
  const info: ExtensionInfo = {
    installed: true,
    version: chrome.runtime.getManifest?.().version ?? "0.0.0",
    protocolVersion: PROTOCOL_VERSION,
    capabilities: EXTENSION_CAPABILITIES
  };
  // Register the listener FIRST, synchronously, before anything async — the
  // web page may send WEB_PING immediately after its own readiness listener
  // goes up, and there must be no window where a ping could arrive unheard.
  window.addEventListener("message", async (event: MessageEvent) => {
    if (!isCurrentInstance()) return;
    if (event.source !== window) return;
    if (!isApprovedJobPilotOrigin(event.origin)) return;
    const data = parsePageMessage(event.data);
    if (!data) return;
    if (data.type === MSG.PING) {
      log.debug("web ping received");
      const ack = (await sendRuntime({
        type: MSG.HANDSHAKE,
        origin: event.origin,
        apiBase: data.apiBase,
        protocolVersion: PROTOCOL_VERSION
      })) as
        | { ok?: boolean; protocolVersion?: number }
        | undefined;
      // PONG whenever the background is actually reachable — regardless of
      // whether ITS protocol version matches this (possibly stale, if the
      // extension was reloaded while this tab stayed open) content script's
      // compiled-in PROTOCOL_VERSION. The web app already compares
      // info.protocolVersion itself to decide "outdated" vs. current; what
      // must never happen is silently dropping the reply and collapsing
      // "installed but outdated/stale" into "not installed at all".
      // `ack === undefined` means chrome.runtime.sendMessage itself failed
      // (extension context invalidated — content script truly orphaned by a
      // reload) and there is genuinely no bridge to report; stay silent so
      // the web app's timeout-driven "reload the page" messaging is accurate.
      if (ack !== undefined) {
        window.postMessage({ source: PAGE_SOURCE_EXT, type: MSG.PONG, info } satisfies PageMessage, location.origin);
        log.debug("extension ready sent");
      } else {
        // Expected briefly during an unpacked-extension reload. The background
        // now revives this page automatically; logging at warn made Chrome list
        // a normal lifecycle transition as an extension error.
        log.debug("background temporarily unavailable; waiting for bridge revival");
      }
    } else if (data.type === MSG.STAGE_LAUNCH) {
      if (validLaunch(data.payload)) void sendRuntime({ type: MSG.STAGE_LAUNCH, payload: data.payload });
    } else if (data.type === MSG.START_ASSISTED_APPLY) {
      log.debug("start assisted apply forwarded");
      const result = (validLaunch(data.payload)
        ? await sendRuntime({ type: MSG.LAUNCH_REQUEST, payload: data.payload })
        : { ok: false, code: "INVALID_HANDOFF", message: "The prepared application handoff is invalid." }) as { ok: boolean; applicationId?: string; tabId?: number; code?: string; message?: string };
      log.debug("background acknowledgement received", { status: result.ok ? "ok" : "failed" });
      window.postMessage({ source: PAGE_SOURCE_EXT, type: MSG.START_ASSISTED_APPLY_RESULT, requestId: data.payload.requestId, result } satisfies PageMessage, location.origin);
    }
  });
}

function validLaunch(payload: LaunchPayload): boolean {
  if (!payload || !payload.requestId || !payload.launchToken || !Number.isInteger(payload.sessionId) || !Number.isInteger(payload.jobId)) return false;
  try { const u = new URL(payload.officialUrl); return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)); }
  catch { return false; }
}

// --------------------------------------------------------------------------- //
// 2. Employer/ATS page: readiness pull + canonical autofill
//
// host_permissions now cover every https(s) origin (employer/ATS forms live on
// domains we cannot enumerate up front), so this script is declaratively
// injected into every page. What keeps it dormant everywhere except a
// user-initiated JobPilot handoff is this gate: it NEVER scans the DOM,
// inserts the widget, or observes mutations until the background confirms
// this exact tab/frame matches an active, unexpired handoff. An unmatched
// frame registers only the (inert) message listener and exits immediately.
// --------------------------------------------------------------------------- //
const isTopFrame = window.top === window;

/** Sanitized evidence about THIS frame, sent with CONTENT_READY so the
 * background can rank frames. Best-effort: a probe failure must never block the
 * readiness handshake. */
function buildFrameProbe() {
  try {
    const p = probeFrame(document);
    return {
      isTopFrame: p.isTopFrame,
      sanitizedUrl: p.sanitizedUrl,
      rootConfident: p.rootConfident,
      applicationLabelsFound: p.applicationLabelsFound,
      bestScore: p.bestScore
    };
  } catch {
    return undefined;
  }
}
let session: ApplicationSessionData | null = null;
let outcome: DetectionOutcome | null = null;
let running = false;
let started = false;
let matched = false;
// Once a launch reaches a terminal ready/review/failure state, DOM changes
// (including the user's own answers) must not silently start autofill again.
// Only the explicit Retry action clears this latch.
let automaticRunSettled = false;
// Live element refs from the most recent scan, keyed by DiscoveredField.uid —
// how the review widget applies a manually-chosen answer to the right node.
let lastFields: Map<string, DiscoveredField> = new Map();
let widget: ReturnType<typeof createWidget> | null = null;
let lastScanSignature = "";
/** The URL this content-script instance started on. A "form did not render"
 * verdict is only meaningful once we have moved away from it. */
const entryUrl = location.href;
/** Bumped whenever the application-navigation strategy changes, so a live log
 * line identifies the algorithm and not just the git revision. */
const NAVIGATION_IMPL_VERSION = "url-first-v2";
/** Bumped when the destination session-handoff contract changes. */
const HANDOFF_IMPL_VERSION = "session-scoped-package-v1";
/** One automatic reconnect per content-script instance; the button drives the
 * rest, so a failing workflow can never become a request loop. */
let reconnectAttempted = false;
let reconnectInFlight = false;

/**
 * Ask the background to re-establish this tab's workflow binding.
 *
 * Sends only the page origin and a build marker — never a user id, job id,
 * session status, or any token. The worker derives the tab, the session and the
 * job itself and decides whether this origin may join the workflow.
 */
async function requestReconnect(): Promise<boolean> {
  if (reconnectInFlight) return false;
  reconnectInFlight = true;
  try {
    const result = (await sendRuntime({
      type: MSG.RECONNECT_APPLICATION_WORKFLOW,
      origin: location.origin,
      handoffVersion: HANDOFF_IMPL_VERSION
    })) as { ok?: boolean; reason?: string; session?: ApplicationSessionData } | undefined;

    log.info("workflow reconnect", { reason: result?.reason ?? "unknown", ok: String(Boolean(result?.ok)) });
    lastReconnectReason = result?.reason ?? "unknown";

    if (result?.ok && result.session) {
      if (session?.sessionId !== result.session.sessionId) preparedDocuments = null;
      session = result.session;
      matched = true;
      automaticRunSettled = false;
      rootRecoveryAttempted = false;
      if (isTopFrame) {
        widget = ensureWidget();
        widget.update({ stage: "detecting", message: "Reconnected. Checking the application…" });
      }
      outcome = detectAdapter({ url: location.href, document });
      started = true;
      void discoverAndFill("continue_after_navigation");
      observeMutations();
      return true;
    }

    if (isTopFrame) {
      widget = ensureWidget();
      const expired = result?.reason === "session_expired" || result?.reason === "session_terminal";
      const outside = result?.reason === "origin_not_allowed";
      widget.update({
        stage: "failed",
        message: expired
          ? "This application session expired. Reopen it from EZJobFind."
          : outside
            ? "This page is outside the active application workflow."
            : "We lost the application connection. Reconnect to continue.",
        recoverable: !expired && !outside,
        offerReconnect: !expired && !outside
      });
    }
    return false;
  } finally {
    reconnectInFlight = false;
  }
}

/** Last reconnect outcome, for sanitized diagnostics only. */
let lastReconnectReason = "not_attempted";
// The DURABLE field ledger, merged across every (re)scan. This — not any
// per-scan filter — is the single source of truth for counts and the review
// list, so a late partial SPA re-render can never drop an already-discovered
// required control and falsely report "All caught up".
let ledger: LedgerEntry[] = [];
let ledgerCounts: LedgerCounts | null = null;
/** The scored application-form root for this page (section A). */
let formRoot: FormRootResult | null = null;
let stopTeaching: (() => void) | null = null;

const FAILURE_MESSAGE: Record<string, string> = {
  HANDOFF_NOT_FOUND: "No prepared application is waiting for this tab. Start from EZJobFind.",
  HANDOFF_URL_MISMATCH: "This page doesn't match the prepared application. Open it from EZJobFind.",
  HANDOFF_EXPIRED: "This launch expired. Reopen the application from EZJobFind.",
  HANDOFF_SCHEMA_OUTDATED: "The extension was updated. Reload this page to continue.",
  TOKEN_CONSUMED: "This launch was already used. Reopen the application from EZJobFind.",
  // A 401 from the session package has TWO very different causes, and
  // collapsing them is what made a healthy session look expired: either the
  // handoff genuinely expired, or the single-use launch token was already
  // spent because the binding moved to another tab. The second is recoverable
  // and must not tell the user to start over.
  SESSION_UNAUTHORIZED: "We lost the application connection. Reconnect to EZJobFind to continue.",
  SESSION_NOT_FOUND: "This application session expired. Reopen it from EZJobFind.",
  SESSION_PACKAGE_FAILED: "Your prepared application couldn't be loaded. Reopen from EZJobFind."
};

// Mirrors background.ts's TERMINAL_FAILURE_CODES — retrying these re-asks the
// same question and gets the same answer, so the widget must not offer a
// Retry action that just repeats a permanently expired/invalid handoff.
const TERMINAL_FAILURE_CODES = new Set([
  "HANDOFF_URL_MISMATCH", "HANDOFF_NOT_FOUND", "HANDOFF_EXPIRED",
  "HANDOFF_SCHEMA_OUTDATED", "SESSION_NOT_FOUND"
]);

async function initAtsPage(): Promise<void> {
  // Cheap and always safe to register: answers liveness pings and gives an
  // unmatched frame a second chance if the tab becomes bound to a handoff
  // shortly after this frame's own (negative) initial check — e.g. an
  // employer-embedded iframe whose content script races the top frame's.
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    if (!isCurrentInstance()) return false;
    const message = parseRuntimeMessage(raw);
    if (!message) {
      sendResponse({ ok: false, error: "UNKNOWN_MESSAGE" });
      return false;
    }
    if (message.type === MSG.PING_CONTENT) {
      sendResponse({ ok: true, url: location.href });
      return false;
    }
    if (message.type === MSG.PROBE_FRAME_APPLICATION) {
      // Answered by EVERY frame, matched or not: this is the diagnostic that
      // tells the top frame whether a nested application frame is reachable at
      // all. Counts and one boolean — never a label, never a value.
      const evidence = collectApplicationEvidence(document);
      sendResponse({
        ok: true,
        evidence: hasApplicationEvidence(evidence),
        fieldCount: evidence.applicantControlCount
      });
      return false;
    }
    if (message.type === MSG.AUTOFILL_START) {
      if (message.reason === "manual_retry") { automaticRunSettled = false; rootRecoveryAttempted = false; }
      void (matched ? fill(message.reason) : checkHandoffAndStart(message.reason)).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === MSG.AUTOFILL_PROGRESS) {
      // The application may live in a cross-origin iframe while only the top
      // frame owns the JobPilot widget. The background mirrors the iframe's
      // sanitized progress here so the top widget does not remain stuck on
      // "Opening the application…" after filling and uploads have completed.
      if (isTopFrame) mirrorFrameProgress(message.payload);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === MSG.CLEAR_SESSION) {
      if (matched) clearJobPilotFields(document);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  await checkHandoffAndStart("automatic_launch");
}

function mirrorFrameProgress(progress: ProgressPayload): void {
  if (!matched) return;
  // A frame that has its own authoritative ledger does NOT take its stage or
  // its totals from another frame's progress payload. That payload is a separate
  // counter system, and letting it write here is a third writer competing with
  // the ledger — the same class of bug as the raw DOM count. Mirroring stays for
  // frames that have no ledger of their own, which is what it is for.
  if (questionLedger.size > 0) return;
  const stage = progress.state === "completed"
    ? "ready"
    : progress.state === "completed_with_review"
      ? "review"
      : progress.state === "failed"
        ? "failed"
        : progress.state === "filling"
          ? "filling"
          : "detecting";
  const pending = progress.reviewRequired;
  widget = ensureWidget();
  widget.update({
    stage,
    filled: progress.filled,
    total: progress.fieldsDiscovered,
    message: stage === "ready"
      ? "Every required field is filled. Review everything before you submit."
      : stage === "review"
        ? `${pending} item${pending === 1 ? "" : "s"} need your review.`
        : stage === "failed"
          ? "Autofill failed. Retry or continue manually."
          : stage === "filling"
            ? "Filling verified fields…"
            : "Detecting fields…"
  });
}

/** Best-effort top-level URL; throws for a cross-origin iframe (expected —
 * the background already knows the top URL via chrome.tabs, it doesn't need
 * this frame to report it). */
function topFrameUrl(): string | null {
  if (isTopFrame) return location.href;
  try {
    return window.top?.location.href ?? null;
  } catch {
    return null;
  }
}

async function checkHandoffAndStart(reason: AutofillReason): Promise<void> {
  if (!isCurrentInstance()) return;
  const resp = (await sendRuntime({
    type: MSG.CONTENT_READY,
    probe: buildFrameProbe(),
    url: location.href,
    title: document.title,
    protocolVersion: PROTOCOL_VERSION,
    isTopFrame,
    topUrl: topFrameUrl(),
    detectedAts: null
  })) as
    | { ok: boolean; matched?: boolean; error?: string; recoverable?: boolean; session?: ApplicationSessionData | null }
    | undefined;

  if (!resp?.matched) {
    // Dormant is right for an unrelated page. But HANDOFF_URL_MISMATCH on the
    // TOP frame is different: it means an active workflow exists and this tab
    // simply is not on the URL it started from — the normal listing -> login
    // hop, where the employer's login lives on a different host. Handoff
    // matching requires an exact hostname, so it cannot approve that on its
    // own. Ask the worker instead, which applies the explicit workflow origin
    // graph (same registrable domain, or an allow-listed ATS host).
    if (isTopFrame && resp?.error === "HANDOFF_URL_MISMATCH" && !reconnectAttempted) {
      reconnectAttempted = true;
      log.info("destination session resolution", { stage: "workflow_lookup", reason: "handoff_url_mismatch_retry" });
      await requestReconnect();
    }
    return;
  }
  matched = true;

  if (!resp.session) {
    // The tab IS bound to a handoff, but the session package could not be
    // loaded. Two very different causes hide here: a genuinely expired session,
    // and a binding this tab simply never inherited (the common cross-tab case,
    // where the single-use launch token was already spent by the listing tab).
    // The second is recoverable, so try ONCE to reconnect before reporting it.
    const recoverable = resp.recoverable ?? !TERMINAL_FAILURE_CODES.has(resp.error ?? "");
    if (recoverable && !reconnectAttempted) {
      reconnectAttempted = true;
      if (isTopFrame) {
        widget = ensureWidget();
        widget.update({ stage: "detecting", message: "Reconnecting to EZJobFind…", reconnecting: true });
      }
      const reconnected = await requestReconnect();
      if (reconnected) return;
    }
    if (isTopFrame) {
      widget = ensureWidget();
      widget.update({
        stage: "failed",
        message: FAILURE_MESSAGE[resp.error ?? ""] ?? `Could not load your prepared application (${resp.error ?? "unknown error"}).`,
        recoverable,
        // Reconnect — not "Retry autofill" — is the right action when there is
        // no session to fill from.
        offerReconnect: recoverable
      });
    }
    return;
  }

  // Matched AND session ready: this frame is authorized to scan and fill.
  //
  // Stamp the build identity into the very first log line of a real run. A
  // stale unpacked extension (Chrome keeps the OLD content script in any tab
  // that was already open when you reloaded it) is the single most common
  // reason a live page disagrees with a green test suite, and this makes that
  // checkable from DevTools in one glance instead of being guessed at.
  log.info("content script active", {
    build: BUILD_INFO.buildId,
    version: BUILD_INFO.version,
    nav: NAVIGATION_IMPL_VERSION,
    handoff: HANDOFF_IMPL_VERSION
  });
  if (session?.sessionId !== resp.session.sessionId) preparedDocuments = null;
  session = resp.session;
  outcome = detectAdapter({ url: location.href, document });
  if (isTopFrame) {
    widget = ensureWidget();
    widget.update({ stage: "detecting", message: "Waiting for the application form…" });
  }
  started = true;
  void discoverAndFill(reason);
  observeMutations();
}

function ensureWidget(): ReturnType<typeof createWidget> {
  return (
    widget ??
    createWidget({
      retry: () => {
        automaticRunSettled = false;
        rootRecoveryAttempted = false;
        // Retrying FIELD DISCOVERY with no session just fails again. When the
        // workflow binding is what is missing, the correct action is reconnect.
        if (matched && !session) {
          void requestReconnect();
          return;
        }
        void (matched && session ? fill("manual_retry") : checkHandoffAndStart("manual_retry"));
      },
      rescan: () => {
        automaticRunSettled = false;
        rootRecoveryAttempted = false;
        void (matched && session ? fill("manual_retry") : checkHandoffAndStart("manual_retry"));
      },
      clear: () => { if (matched) clearJobPilotFields(document); },
      openApplication: () => { void manuallyOpenApplication(); },
      reconnect: () => {
        widget?.update({ stage: "detecting", message: "Reconnecting to EZJobFind…", reconnecting: true, offerReconnect: true });
        void requestReconnect();
      },
      complete: () => { if (session) void sendRuntime({ type: MSG.COMPLETE_SESSION, sessionId: session.sessionId }); },
      diagnostics: copyDiagnostics,
      captureControl: captureCurrentEligibilityControls,
      teach: (enabled) => { if (enabled) beginTeaching(); else { stopTeaching?.(); stopTeaching = null; } }
    })
  );
}

/**
 * How long the destination application gets to hydrate before we give up.
 *
 * Bounded on purpose. The old code did the opposite of both failure modes at
 * once: it polled a page that was never going to change ("attempt 11"), and it
 * concluded from ONE pre-hydration scan that a destination application had zero
 * fields — which is what left the live widget on "Detecting fields / 0 of 0"
 * beside a fully rendered form.
 */
const APPLICATION_READINESS_TIMEOUT_MS = 20_000;

/** Sanitized destination-readiness evidence for Copy diagnostics. */
let lastDestinationReadiness: Record<string, unknown> | null = null;
/** One readiness wait at a time; mutations must not stack 20-second waits. */
let readinessInFlight = false;
/** One hand-back from `fill` to the readiness path per run, so an unresolvable
 * root cannot bounce between the two forever. Cleared by Retry/Rescan/Reconnect. */
let rootRecoveryAttempted = false;

async function discoverAndFill(reason: AutofillReason): Promise<void> {
  if (!isCurrentInstance() || !session) return;

  // Ask what kind of page this is BEFORE waiting for controls. Waiting is only
  // the right answer for one of the possible answers.
  const page = classifyPage(document);

  if (page.state === "employer_auth_required") {
    await handleEmployerAuth();
    return;
  }

  if (page.state === "apply_cta_detected") {
    // A listing page with a safe Apply control: advance instead of waiting.
    const activation = await activateApplicationSurfaceOnce();
    // "already_activated" means this exact CTA was clicked before and the page
    // still is not an application. Returning there is what froze the widget on
    // "Detecting fields" forever; fall through to bounded readiness instead.
    //
    // "not_top_frame" must fall through too. Only the top frame may activate a
    // CTA, but an EMBEDDED application frame routinely also contains
    // apply-shaped controls ("Apply With LinkedIn", "Apply With Indeed" on the
    // SmartRecruiters form), so classifying on them and then returning left the
    // one frame that actually held the application doing nothing at all — while
    // the top frame timed out and reported a tab-level failure.
    if (activation !== "already_activated" && activation !== "not_top_frame") return;
  }

  // The application may already be here — the common case on a destination that
  // finished hydrating before the content script announced readiness. Discover
  // immediately rather than paying the settling window for nothing.
  outcome = detectAdapter({ url: location.href, document });
  if (page.state === "application_form_ready" || hasApplicationEvidence(collectApplicationEvidence(document))) {
    log.debug("application evidence present at entry", { ats: outcome?.result.atsId ?? null });
    await fill(reason);
    return;
  }

  if (readinessInFlight) return;
  readinessInFlight = true;
  let readiness: ReadinessResult;
  try {
    widget?.update({ stage: "detecting", message: "Waiting for the application form…" });
    readiness = await awaitApplicationReadiness({
      timeoutMs: APPLICATION_READINESS_TIMEOUT_MS,
      onStage: (stage, detail) => {
        log.debug("destination readiness", { stage, elapsedMs: detail.elapsedMs, fields: detail.fieldCount });
        // Periodic honest progress. The stage NAME changes, so the panel can
        // never look frozen while the wait is still legitimately running.
        widget?.update({
          stage: "detecting",
          stageLabel: stage === "APPLICATION_ROOT_FOUND" ? "Application found" : "Waiting for the application",
          total: detail.fieldCount,
          message: stage === "APPLICATION_ROOT_FOUND"
            ? "The application form is ready. Discovering fields…"
            : "Waiting for the employer's application form to finish loading…"
        });
      }
    });
  } finally {
    readinessInFlight = false;
  }
  recordDestinationReadiness(readiness);
  if (!isCurrentInstance() || !session) return;

  if (readiness.ready) {
    if (readiness.evidenceLocation === "frame" && isTopFrame) {
      // The application is in an embedded frame, which runs its own content
      // script instance and owns discovery there. The top frame must report
      // progress, never a tab-level failure — and never a bare "0 of 0".
      log.info("application lives in a child frame", { frames: readiness.frames.length });
      widget?.update({
        stage: "detecting",
        stageLabel: "Application in embedded form",
        total: readiness.fieldCount,
        message: "The application is inside an embedded form. EZJobFind is filling it there…"
      });
      return;
    }
    // A fresh look at the CURRENT dom. Nothing observed before hydration —
    // adapter, root, or element reference — survives into the run.
    outcome = detectAdapter({ url: location.href, document });
    await fill(reason);
    return;
  }

  // A frame with no form of its own (a same-tab sibling iframe unrelated to
  // the application, or a top frame whose form actually lives in a nested
  // iframe) legitimately times out here. Only the top frame — which owns the
  // widget — reports this as a tab-level failure, and even then only after
  // confirming no other frame in the tab has already succeeded (the
  // background also refuses to regress an in-progress/completed tab).
  if (!isTopFrame) return;
  const view = (await sendRuntime({ type: MSG.GET_VIEW_STATE })) as { ok: boolean; view?: { state?: string } | null } | undefined;
  if (view?.view && ["filling", "completed", "completed_with_review"].includes(view.view.state ?? "")) return;
  reportDestinationFailure(readiness, page.obstructed);
}

/**
 * The honest terminal state for a destination that never became discoverable.
 *
 * Deliberately does NOT latch `automaticRunSettled`. The bounded wait has
 * already expired, so the user gets a named failure and a Retry — but a very
 * late hydration arriving at second 25 should still be picked up by the
 * mutation observer rather than ignored because a timer fired first.
 */
function reportDestinationFailure(readiness: ReadinessResult, obstructed: boolean): void {
  const code = readiness.failureCode ?? "APPLICATION_DISCOVERY_TIMEOUT";
  // An inaccessible frame is never reported from `contentDocument` alone. That
  // one fact only proves the frame is cross-origin, and it produced a message
  // the user could do nothing with. Establish WHICH cause it is first.
  if (code === "APPLICATION_FRAME_UNAVAILABLE" && isTopFrame) {
    void reportFrameRemedy();
    return;
  }

  const stillOnEntryUrl = location.href.split("#")[0] === entryUrl.split("#")[0];
  const canOpen = stillOnEntryUrl && selectActivationControl(document) !== null;

  const message = obstructed
    ? "A cookie or consent banner is covering this page. Dismiss it, then choose Retry."
    : code === "FIELD_DISCOVERY_RETURNED_ZERO"
      ? "The application form loaded but EZJobFind found no fields it can fill. Choose Rescan application."
      : canOpen
        ? "Click once to open the application form. EZJobFind will continue automatically."
        : stillOnEntryUrl
          ? "This looks like a job listing rather than an application form. Open the employer's apply link, then choose Retry."
          : "The application page opened, but its form did not finish loading in time. Choose Retry.";

  log.info("destination discovery terminal", {
    code,
    stage: readiness.stage,
    fields: readiness.fieldCount,
    frames: readiness.frames.length,
    // Names the web-component case explicitly: a page with many open shadow
    // hosts and zero discovered fields is a traversal problem, not a hydration
    // one, and the two used to be indistinguishable in the logs.
    openShadowHosts: readiness.openShadowHosts,
    elapsedMs: readiness.elapsedMs
  });
  widget = ensureWidget();
  widget.update({ stage: "failed", message, recoverable: true, offerOpenApplication: canOpen });
  void sendRuntime({
    type: MSG.AUTOFILL_FAILED,
    reasonCode: obstructed
      ? "CONSENT_OVERLAY_BLOCKING"
      : canOpen
        ? "NAVIGATION_NEEDS_USER_GESTURE"
        : code
  });
}

/**
 * The remedy this tab can actually offer for an embedded application.
 *
 * Set when frame inspection identifies one, and consumed by the existing
 * "Open application form" button — which already runs inside a real user
 * gesture, and is therefore a valid context for `chrome.permissions.request`.
 */
let pendingFrameRemedy:
  | { kind: "request_permission"; origin: string }
  | { kind: "reopen_as_tab"; url: string }
  | null = null;

/** Sanitized frame inspection for Copy diagnostics. */
let lastFrameInspection: Record<string, unknown> | null = null;

/**
 * Diagnose an embedded application and offer the one remedy that fits.
 *
 * Three genuinely different situations, three different actions:
 *
 *   • missing host permission   -> ask for that ONE origin, on the user's click
 *   • sandboxed to an opaque origin, or no content script we can reach
 *                               -> reopen the frame's own URL as a normal tab
 *   • no URL to open at all     -> say so plainly; there is nothing to click
 */
async function reportFrameRemedy(): Promise<void> {
  const observed = observeFrames(document);
  const inspection = (await sendRuntime({
    type: MSG.INSPECT_APPLICATION_FRAMES,
    observed: observed.map((frame) => ({
      frameIndex: frame.frameIndex,
      origin: frame.origin,
      pathShape: frame.pathShape,
      urlKind: frame.urlKind,
      srcObservable: frame.srcObservable,
      sandboxTokens: frame.sandboxTokens,
      sandboxed: frame.sandboxed,
      opaqueOrigin: frame.opaqueOrigin,
      sameOriginReadable: frame.sameOriginReadable,
      readableFieldCount: frame.readableFieldCount
    }))
  })) as
    | { ok?: boolean; outcome?: string; reopenOrigin?: string | null; frames?: unknown[]; enumerationSource?: string; enumerationComplete?: boolean }
    | undefined;

  const candidate = selectApplicationFrame(observed);
  const reopenUrl = reopenableFrameUrl(candidate, document);
  const outcome = inspection?.outcome
    ?? frameVerdict({
      frame: candidate,
      contentScriptResponds: false,
      hostPermissionGranted: false,
      reportedFieldCount: null
    });

  lastFrameInspection = {
    outcome,
    enumerationSource: inspection?.enumerationSource ?? "unavailable",
    enumerationComplete: inspection?.enumerationComplete ?? false,
    frames: inspection?.frames ?? [],
    parentObserved: observed,
    reopenAvailable: Boolean(reopenUrl)
  };
  log.info("application frame remedy", {
    outcome,
    source: String(inspection?.enumerationSource ?? "unavailable"),
    reopenAvailable: String(Boolean(reopenUrl))
  });

  // Prefer asking for the exact origin: it keeps the user in one tab and one
  // session. Reopening is the fallback that works even when no grant can help.
  const permissionOrigin = outcome === "APPLICATION_FRAME_PERMISSION_MISSING"
    ? inspection?.reopenOrigin ?? candidate?.origin ?? null
    : null;

  pendingFrameRemedy = permissionOrigin
    ? { kind: "request_permission", origin: permissionOrigin }
    : reopenUrl
      ? { kind: "reopen_as_tab", url: reopenUrl }
      : null;

  const message = permissionOrigin
    ? `The application is in an embedded form from ${new URL(permissionOrigin).hostname}. Choose Open application form to let EZJobFind fill it there.`
    : reopenUrl
      ? `The application is in an embedded form EZJobFind can't reach. Choose Open application form to reopen it from ${new URL(reopenUrl).hostname} as its own tab.`
      : outcome === "APPLICATION_FRAME_SANDBOXED_OPAQUE"
        ? "The application is in a restricted embedded frame with no address EZJobFind can open. Fill it manually — your saved answers stay available in this panel."
        : "EZJobFind could not reach the embedded application form. Fill it manually — your saved answers stay available in this panel.";

  widget = ensureWidget();
  widget.update({
    stage: "failed",
    message,
    recoverable: true,
    offerOpenApplication: pendingFrameRemedy !== null
  });
  void sendRuntime({ type: MSG.AUTOFILL_FAILED, reasonCode: outcome });
}

/**
 * Act on the frame remedy, inside the user's own click.
 *
 * `chrome.permissions.request` REQUIRES a user gesture, which is exactly what
 * the "Open application form" button provides. A granted origin is followed by
 * a fresh discovery pass; a denial falls back to reopening the frame as a tab
 * rather than leaving the user where they started.
 */
async function applyFrameRemedy(): Promise<boolean> {
  const remedy = pendingFrameRemedy;
  if (!remedy) return false;

  if (remedy.kind === "request_permission") {
    widget?.update({ stage: "detecting", message: "Waiting for permission to read the embedded form…" });
    const result = (await sendRuntime({
      type: MSG.REQUEST_FRAME_PERMISSION,
      origin: remedy.origin
    })) as { ok?: boolean; reason?: string; granted?: boolean } | undefined;
    log.info("frame permission outcome", { reason: result?.reason ?? "unknown" });
    if (result?.ok) {
      pendingFrameRemedy = null;
      rootRecoveryAttempted = false;
      automaticRunSettled = false;
      widget?.update({ stage: "detecting", message: "Permission granted. Reading the embedded application…" });
      await discoverAndFill("manual_retry");
      return true;
    }
    // Denied, or the origin is not part of this workflow. Reopening still works.
    const fallback = reopenableFrameUrl(selectApplicationFrame(observeFrames(document)), document);
    if (!fallback) {
      widget?.update({
        stage: "failed",
        message: "Without permission for the embedded form, EZJobFind can't fill it here. Fill it manually, or reopen the application from EZJobFind.",
        recoverable: true
      });
      return true;
    }
    pendingFrameRemedy = { kind: "reopen_as_tab", url: fallback };
  }

  const target = pendingFrameRemedy;
  if (target?.kind !== "reopen_as_tab") return false;
  // Reuse the validated-destination path: it binds the session, carries the
  // package to the new tab, and refuses anything that is not https.
  widget?.update({ stage: "opening", message: "Opening the application in its own tab…" });
  const navigated = (await sendRuntime({
    type: MSG.ACTIVATE_APPLICATION_DESTINATION,
    sessionId: session?.sessionId ?? -1,
    url: target.url,
    newTab: true,
    source: "embedded_application_frame"
  })) as { ok?: boolean; error?: string } | undefined;

  if (navigated?.ok) {
    pendingFrameRemedy = null;
    log.info("embedded application reopened as a tab");
    widget?.update({
      stage: "opening",
      message: "The application opened in a new tab. EZJobFind continues there."
    });
    return true;
  }
  log.warn("embedded application reopen refused", { reason: navigated?.error ?? "unknown" });
  widget?.update({
    stage: "failed",
    message: "EZJobFind could not reopen the embedded application. Fill it manually — your saved answers stay available in this panel.",
    recoverable: true
  });
  return true;
}

/**
 * Sanitized readiness evidence for Copy diagnostics.
 *
 * Origins and counts only — never a full destination URL (it can carry an
 * application id or an email in a query string), never field values.
 */
function recordDestinationReadiness(readiness: ReadinessResult): void {
  lastDestinationReadiness = {
    destinationHostname: location.hostname,
    destinationOrigin: location.origin,
    ready: readiness.ready,
    stage: readiness.stage,
    failureCode: readiness.failureCode,
    evidenceLocation: readiness.evidenceLocation,
    elapsedMs: readiness.elapsedMs,
    rootReplacements: readiness.rootReplacements,
    fieldCount: readiness.fieldCount,
    openShadowHosts: readiness.openShadowHosts,
    applicationEvidence: readiness.evidence,
    framesInspected: readiness.frames.map((frame) => ({
      frameIndex: frame.frameIndex,
      origin: frame.origin,
      accessible: frame.accessible,
      plausibleApplicationHost: frame.plausibleApplicationHost,
      fieldCount: frame.applicantControlCount
    }))
  };
}


// --------------------------------------------------------------------------- //
// Employer authentication (workstream 3)
// --------------------------------------------------------------------------- //
/** Set while the employer is asking the user to sign in. Autofill is paused —
 * never cancelled — so the prepared application survives the detour. */
let authPaused = false;
let authWatcher: ReturnType<typeof setInterval> | null = null;

/**
 * Pause on an employer login screen and wait for the user to authenticate.
 *
 * What deliberately does NOT happen here:
 *   • no password is ever typed. JobPilot has no employer credential and the
 *     user's JobPilot password is not one — it is never read, sent, or stored;
 *   • no account is created;
 *   • no CAPTCHA, MFA, passkey, SSO or email verification is touched.
 *
 * The user's email MAY be prefilled, and only into a field that is clearly a
 * login identifier. That is the same profile autofill they already consented
 * to, and it saves the most tedious step of the detour.
 */
async function handleEmployerAuth(): Promise<void> {
  if (authPaused) return;
  authPaused = true;

  const prefilled = prefillLoginEmail();
  log.info("employer authentication required", { emailPrefilled: prefilled });

  widget = ensureWidget();
  widget.update({
    stage: "detecting",
    message:
      "Sign in to continue. Use your existing employer account or create one — EZJobFind will resume once the application form opens."
  });
  void sendRuntime({
    type: MSG.EMPLOYER_AUTH_REQUIRED,
    sessionId: session?.sessionId ?? 0,
    emailPrefilled: prefilled
  });

  // Poll for the page ceasing to be a login screen. Bounded and cheap: a
  // classification read, not a full document scan, and it stops as soon as the
  // application appears.
  const deadline = Date.now() + 10 * 60_000;
  authWatcher = setInterval(() => {
    if (!isCurrentInstance() || Date.now() > deadline) {
      stopAuthWatch();
      return;
    }
    const page = classifyPage(document);
    if (page.state === "employer_auth_required") return;
    stopAuthWatch();
    authPaused = false;
    log.info("employer authentication finished; resuming", { state: page.state });
    void discoverAndFill("continue_after_navigation");
  }, 1500);
}

function stopAuthWatch(): void {
  if (authWatcher !== null) {
    clearInterval(authWatcher);
    authWatcher = null;
  }
}

/**
 * Fill the user's email into an employer login identifier field.
 *
 * Email only, and only when the field is unambiguously a login identifier and
 * is currently empty. Returns whether anything was filled.
 */
function prefillLoginEmail(): boolean {
  const email = typeof session?.profileData?.email === "string" ? session.profileData.email : "";
  if (!email) return false;

  const field = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="email"],input[type="text"],input:not([type])')
  ).find((input) => {
    if (input.value.trim()) return false;
    if (input.offsetParent === null && input.getClientRects().length === 0) return false;
    if (input.type === "email") return true;
    const hint = `${input.name} ${input.id} ${input.getAttribute("autocomplete") ?? ""} ${input.getAttribute("aria-label") ?? ""} ${input.placeholder}`.toLowerCase();
    return /\bemail\b|\busername\b|\blogin\b|\buser[_-]?id\b/.test(hint);
  });
  if (!field) return false;

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, email);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

// A listing page is no longer reported from a single immediate scan. That is
// exactly what made a destination application whose form had not hydrated yet
// latch "this looks like a job listing" (and disarm the mutation observer) while
// the real form arrived a moment later. The verdict now comes from
// reportDestinationFailure, after the bounded readiness wait has expired.

// --------------------------------------------------------------------------- //
// Application-surface activation (section A)
// --------------------------------------------------------------------------- //
/** CTA fingerprints already activated, so a repeated mutation, a re-entered
 * discovery loop, or a return to the same page can never re-click the same
 * control. Keyed on (url, role, accessible name) — see ctaFingerprint. */
const activatedFingerprints = new Set<string>();
let lastApplicationLaunchTrace: Record<string, unknown> | null = null;

function sanitizedOriginPath(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value, location.href);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Reveal the application when the page hides it behind a tab/CTA.
 *
 * Only the top frame does this, and only once. The control is chosen by
 * ats/applicationSurface.ts, which excludes anything that could submit,
 * authenticate or transmit data. Revealing the form is inside what the user
 * asked for when they chose "Open and autofill application"; committing it is
 * not, and never happens here.
 */
/**
 * What the activation attempt did, so the caller can decide what happens next.
 *
 * `already_activated` in particular used to be an unannounced early return: the
 * widget stayed on whatever stage it happened to be showing, which on a
 * destination page meant "Detecting fields" with no timeout and no failure.
 */
type SurfaceActivation = "not_top_frame" | "no_candidate" | "already_activated" | "handed_off" | "reported_failure";

async function activateApplicationSurfaceOnce(): Promise<SurfaceActivation> {
  if (!isTopFrame) return "not_top_frame";

  const candidate = selectActivationControl(document);
  if (!candidate) {
    const candidates = findActivationCandidates(document);
    lastApplicationLaunchTrace = {
      ctaCandidates: candidates.map((item) => ({
        normalizedText: accessibleName(item.element).toLowerCase().replace(/\s+/g, " ").trim(),
        confidence: item.score,
        href: sanitizedOriginPath(item.element.getAttribute("href")),
        target: item.element.getAttribute("target")
      })),
      selectedCta: null,
      finalLaunchStatus: candidates.length ? "APPLICATION_CTA_AMBIGUOUS" : "APPLICATION_CTA_NOT_FOUND",
      failureCode: candidates.length ? "APPLICATION_CTA_AMBIGUOUS" : "APPLICATION_CTA_NOT_FOUND"
    };
    log.debug("no safe application-surface control on this page");
    void sendRuntime({ type: MSG.AUTOFILL_FAILED, reasonCode: "FORM_NOT_RENDERED" });
    return "no_candidate";
  }

  const destination = resolveApplyDestination(candidate.element, location.href);
  const normalizedCtaText = accessibleName(candidate.element).toLowerCase().replace(/\s+/g, " ").trim();
  const target = candidate.element.getAttribute("target");
  const prepared = (await sendRuntime({
    type: MSG.PREPARE_APPLICATION_LAUNCH,
    sessionId: session?.sessionId ?? -1,
    sourceUrl: location.href,
    normalizedCtaText,
    confidence: candidate.score,
    href: destination.ok ? destination.destination.url : null,
    target,
    expectedDestinationOrigin: destination.ok ? new URL(destination.destination.url).origin : null,
    jobFingerprint: shortHash(`${session?.company ?? ""}|${session?.jobTitle ?? ""}|${session?.officialUrl ?? location.href}`)
  })) as { ok?: boolean; launchId?: string; error?: string } | undefined;
  lastApplicationLaunchTrace = {
    ctaCandidates: findActivationCandidates(document).map((item) => ({
      normalizedText: accessibleName(item.element).toLowerCase().replace(/\s+/g, " ").trim(),
      confidence: item.score,
      href: sanitizedOriginPath(item.element.getAttribute("href")),
      target: item.element.getAttribute("target")
    })),
    selectedCta: normalizedCtaText,
    confidence: candidate.score,
    href: destination.ok ? sanitizedOriginPath(destination.destination.url) : null,
    target,
    clickStrategy: destination.ok ? "background_navigation" : "synthetic_then_user_gesture",
    pendingLaunchCreated: Boolean(prepared?.ok),
    launchId: prepared?.launchId ?? null,
    finalLaunchStatus: prepared?.ok ? "PENDING_NAVIGATION" : "INTERNAL_HANDOFF_FAILURE",
    failureCode: prepared?.ok ? null : prepared?.error ?? "INTERNAL_HANDOFF_FAILURE"
  };
  if (!prepared?.ok) {
    automaticRunSettled = true;
    widget = ensureWidget();
    widget.update({
      stage: "failed",
      message: "EZJobFind could not preserve the application session before opening the employer form. Reconnect, then try again.",
      recoverable: true,
      offerReconnect: true
    });
    void sendRuntime({ type: MSG.AUTOFILL_FAILED, reasonCode: "INTERNAL_HANDOFF_FAILURE" });
    return "reported_failure";
  }

  // Idempotency is keyed on the CTA itself, not just the page: one automatic
  // activation per (url, control). A client-side route change to the real
  // application is a different page and may legitimately need its own.
  const fingerprint = ctaFingerprint(candidate.element, location.href);
  if (activatedFingerprints.has(fingerprint)) {
    log.debug("cta already activated for this page");
    return "already_activated";
  }
  activatedFingerprints.add(fingerprint);
  pendingManualCta = candidate.element;

  log.info(`activating application surface (${candidate.reason})`);
  widget = ensureWidget();
  widget.update({ stage: "opening", message: "Opening the application\u2026" });

  const before = navigationSnapshot();
  candidate.element.scrollIntoView({ block: "center", behavior: "auto" });
  // Give the scroll a frame to settle so hit-testing reflects the final layout.
  await delay(50);

  // Only interact with a consent banner when it is ACTUALLY covering the
  // control. A cookie bar pinned to the bottom of the page usually does not
  // cover an Apply button in the job description, and touching a consent UI
  // that is not in the way is an interaction the user did not ask for.
  if (isCtaObstructed(candidate.element, document)) {
    const dismissed = dismissConsentOverlay();
    log.info("cta obstructed by an overlay", { dismissed });
    if (!dismissed) {
      widget.update({
        stage: "failed",
        message:
          "A cookie or consent banner is covering the apply button, and it only offers options EZJobFind won\u2019t choose for you. Dismiss it, then choose Open application form.",
        recoverable: true,
        offerOpenApplication: true
      });
      void sendRuntime({ type: MSG.AUTOFILL_FAILED, reasonCode: "CONSENT_OVERLAY_BLOCKING" });
      return "reported_failure";
    }
    await delay(150);
    candidate.element.scrollIntoView({ block: "center", behavior: "auto" });
    await delay(50);
  }

  // --- Strategy 1: navigate to the destination the markup already declares. --
  //
  // This is the ONLY reliable strategy. A script-dispatched click carries
  // isTrusted:false, and a site is free to ignore it — which is precisely how
  // activation could be "delivered" perfectly and still do nothing. When the
  // CTA is an anchor (or sits in one, or names a URL, or submits a safe GET
  // form) we read that URL and let the service worker navigate. No trusted
  // gesture is needed.
  if (destination.ok) {
    log.info("apply destination resolved", {
      source: destination.destination.source,
      newTab: String(destination.destination.opensNewTab)
    });
    widget.update({ stage: "opening", message: "Opening the application form\u2026" });
    const navigated = (await sendRuntime({
      type: MSG.ACTIVATE_APPLICATION_DESTINATION,
      sessionId: session?.sessionId ?? -1,
      url: destination.destination.url,
      newTab: destination.destination.opensNewTab,
      source: destination.destination.source
    })) as { ok?: boolean; error?: string } | undefined;

    if (navigated?.ok) {
      if (lastApplicationLaunchTrace) lastApplicationLaunchTrace.finalLaunchStatus = "DESTINATION_DETECTED";
      // The service worker owns the tab from here; this document is either
      // being replaced or has handed off to a new tab.
      log.info("apply destination navigation accepted");
      return "handed_off";
    }
    log.warn("apply destination navigation refused", { reason: navigated?.error ?? "unknown" });
    // Fall through: a refused navigation is not a reason to give up silently.
  } else {
    log.debug("no safe apply destination", { reason: destination.reason });
  }

  // --- Strategy 2: synthetic activation, treated as UNPROVEN. ---------------
  //
  // Kept because it genuinely works on pages that do not gate on isTrusted,
  // and it costs one dispatch. It is never trusted on its own: only an
  // observed transition counts as success.
  const outcome = activateApplyCta(candidate.element, document);
  log.info("cta activation dispatched", { method: outcome.method, ok: String(outcome.ok) });
  if (!outcome.ok) {
    offerUserGestureActivation();
    return "reported_failure";
  }

  const transition = await waitForTransition(before);
  if (lastApplicationLaunchTrace) {
    lastApplicationLaunchTrace.navigationOutcome = transition;
    lastApplicationLaunchTrace.finalLaunchStatus = transition === "none" ? "APPLICATION_NAVIGATION_NOT_OBSERVED" : "DESTINATION_DETECTED";
    lastApplicationLaunchTrace.failureCode = transition === "none" ? "APPLICATION_NAVIGATION_NOT_OBSERVED" : null;
  }
  log.info("post-activation transition", { transition });

  if (transition === "none") {
    // --- Strategy 3: ask for one real click. -------------------------------
    // We cannot manufacture trusted input, and pretending otherwise is what
    // produced a misleading "form did not render" on a page that never
    // navigated at all.
    offerUserGestureActivation();
    return "reported_failure";
  }

  // Something changed: re-classify from scratch on the resulting page.
  await discoverAndFill("continue_after_navigation");
  return "handed_off";
}

/** The already-validated control, kept so the manual fallback activates the
 * SAME control the automatic path chose rather than re-deciding. */
let pendingManualCta: HTMLElement | null = null;

/**
 * The honest end state when no destination could be extracted and synthetic
 * activation did nothing: ask for one real click.
 *
 * This must never be phrased as an application-form timeout — we are still on
 * the listing URL and no form could possibly have rendered yet.
 */
function offerUserGestureActivation(): void {
  automaticRunSettled = true;
  widget = ensureWidget();
  widget.update({
    stage: "failed",
    message: "Click once to open the application form. EZJobFind will continue automatically.",
    recoverable: true,
    offerOpenApplication: true
  });
  void sendRuntime({ type: MSG.AUTOFILL_FAILED, reasonCode: "NAVIGATION_NEEDS_USER_GESTURE" });
}

/** The manual "Open application form" action. Runs inside a real user gesture,
 * which is exactly what some employer pages require. */
async function manuallyOpenApplication(): Promise<void> {
  // This handler runs inside a REAL user gesture, which is the only context
  // chrome.permissions.request accepts. An embedded-application remedy takes
  // priority: there is no CTA to click in that case, and returning early is
  // what left the button doing nothing at all.
  if (pendingFrameRemedy && await applyFrameRemedy()) return;
  const element = pendingManualCta ?? selectActivationControl(document)?.element ?? null;
  if (!element) return;
  automaticRunSettled = false;
  widget?.update({ stage: "opening", message: "Opening the application\u2026" });
  const before = navigationSnapshot();
  element.scrollIntoView({ block: "center", behavior: "auto" });
  await delay(50);
  // A genuine user gesture is already in progress here, so the plain click is
  // trusted by pages that reject synthetic ones.
  try {
    element.click();
  } catch {
    activateApplyCta(element, document);
  }
  const transition = await waitForTransition(before);
  if (transition === "none") {
    widget?.update({
      stage: "failed",
      message: "That didn\u2019t open the application. Continue on the employer\u2019s page and EZJobFind will resume when the form appears.",
      recoverable: true,
      offerOpenApplication: true
    });
    return;
  }
  await discoverAndFill("continue_after_navigation");
}

/**
 * Dismiss a consent overlay WITHOUT consenting.
 *
 * Only a reject/decline/close control is ever used. When the banner offers
 * nothing but consent, this returns false and the caller asks the user — it
 * never clicks "Accept all" to get the application moving.
 */
function dismissConsentOverlay(): boolean {
  const control = findSafeConsentDismissal(document);
  if (!control) return false;
  activateApplyCta(control, document);
  return true;
}

/** What the page looked like immediately before activation. */
function navigationSnapshot(): { url: string; controls: number; hasAppRoot: boolean } {
  return {
    url: location.href,
    controls: document.querySelectorAll("input:not([type=hidden]),textarea,select,[contenteditable=true]").length,
    hasAppRoot: resolveApplicationForm(document).confident
  };
}

export type TransitionKind =
  | "url_change"
  | "iframe_inserted"
  | "application_root"
  | "controls_appeared"
  | "employer_auth"
  | "none";

/**
 * Wait for evidence that the activation actually did something.
 *
 * Covers same-tab navigation, SPA route changes, lazily-inserted application
 * iframes, newly revealed in-document controls, and a redirect to an employer
 * login page. A new tab or popup is handled by the background (which owns tab
 * events); this frame simply reports `none` and the manual fallback appears,
 * so the user is never left staring at a silent page.
 */
async function waitForTransition(
  before: { url: string; controls: number; hasAppRoot: boolean },
  timeoutMs = 12_000
): Promise<TransitionKind> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isCurrentInstance()) return "none";

    if (location.href !== before.url) return "url_change";
    if (document.querySelector("iframe#grnhse_iframe,iframe[src*='greenhouse.io'],iframe[src*='lever.co'],iframe[src*='ashbyhq.com']")) {
      return "iframe_inserted";
    }
    if (isEmployerAuthPage(document)) return "employer_auth";
    if (!before.hasAppRoot && resolveApplicationForm(document).confident) return "application_root";

    const controls = document.querySelectorAll("input:not([type=hidden]),textarea,select,[contenteditable=true]").length;
    // A meaningful jump, not one stray field appearing.
    if (controls >= before.controls + 3) return "controls_appeared";

    await delay(250);
  }
  return "none";
}

async function fill(reason: AutofillReason): Promise<void> {
  if (!isCurrentInstance() || !session || running) return;
  if (automaticRunSettled && reason !== "manual_retry") return;
  if (!outcome) outcome = detectAdapter({ url: location.href, document });
  if (!outcome) {
    void sendRuntime({ type: MSG.AUTOFILL_FAILED, reasonCode: "ADAPTER_NOT_DETECTED" });
    return;
  }
  // Before anything touches the employer's page: is this even a coherent
  // runtime? A content script talking to a worker from a different build, or
  // pointed at a different backend than the profile was saved in, produces
  // exactly the symptoms of a logic bug — questions sitting empty for no
  // visible reason. Refusing here is the difference between a confusing failure
  // and an actionable one.
  const handshake = await verifyRuntime();
  if (!handshake.ok) {
    running = false;
    automaticRunSettled = true;
    widget?.update({
      stage: "failed",
      message: handshake.message,
      // Neither condition is fixed by retrying in this tab.
      recoverable: false
    });
    void sendRuntime({ type: MSG.AUTOFILL_FAILED, reasonCode: handshake.reasonCode });
    return;
  }

  running = true;
  started = true;
  const lifecycle = new AtsLifecycleRun(session.sessionId, BUILD_INFO.buildId);
  activeAtsLifecycle = lifecycle;
  lifecycle.transition("INITIALIZING", reason);

  // Scope EVERYTHING to the scored application-form root. Without a confident
  // root we refuse to scan: a global scan is what turned a site-search box into
  // an "application question".
  formRoot = resolveApplicationForm(document);
  if (!formRoot.confident) {
    running = false;
    const ambiguous = formRoot.reason === "APPLICATION_FORM_AMBIGUOUS";

    // An unresolved root is EXPECTED state while the application has not been
    // revealed yet (the live Airbnb page ships "Role overview" selected and no
    // Greenhouse iframe at all). Logging it at warn made Chrome's extension
    // error page show "[JobPilot] application root unresolved [object Object]"
    // during entirely normal probing.
    log.debug(`application root unresolved (${formRoot.reason ?? "unknown"}), ${formRoot.candidates.length} candidate(s)`);

    // Ambiguity is a real dead end — two different forms, nothing safe to pick.
    if (ambiguous) {
      widget?.update({
        stage: "failed",
        message:
          "EZJobFind found more than one possible application form on this page and won't guess. Use Copy diagnostics to report it."
      });
      void sendRuntime({ type: MSG.AUTOFILL_FAILED, reasonCode: "APPLICATION_FORM_AMBIGUOUS" });
      return;
    }

    // Otherwise the application may simply not be on screen yet. Try to reveal
    // it, then let the run coordinator decide — a single frame may no longer
    // publish a terminal "no application" verdict for the whole tab.
    const activation = await activateApplicationSurfaceOnce();
    // Nothing (new) to click and no resolvable root. Returning here left the
    // widget on "Detecting fields" with no timeout — the live symptom. Hand
    // back to the bounded readiness path exactly once, so a form that is still
    // hydrating gets its chance and a form that never arrives gets a name.
    if ((activation === "no_candidate" || activation === "already_activated") && !rootRecoveryAttempted) {
      rootRecoveryAttempted = true;
      await discoverAndFill(reason);
    }
    return;
  }

  const initialRoot = formRoot.root as ParentNode;
  lifecycle.transition("DISCOVERING_INITIAL_PAGE", "application_root_resolved", domMetrics(initialRoot));
  lifecycle.transition("PREPARING_DOCUMENTS", preparedDocuments ? "reuse_committed_document" : "prepare_document_upload", domMetrics(initialRoot));

  if (!preparedDocuments && reason !== "manual_retry") {
    lifecycle.transition("UPLOADING_RESUME", "document_target_discovery", domMetrics(initialRoot));
    preparedDocuments = await prepareDocumentUploads(session, {
      fetchDocument,
      onUploadStart: (kind) => widget?.update({
        stage: "uploading",
        stageLabel: kind === "resume" ? "Uploading resume" : "Uploading cover letter",
        message: `Uploading ${kind === "resume" ? "resume" : "cover letter"} before ATS takeover…`,
        ...authoritativeTotals()
      })
    }, initialRoot);
  }

  if (preparedDocuments?.resumeCommitted) {
    lifecycle.transition("WAITING_FOR_ATS_PARSE", "resume_upload_committed", domMetrics(initialRoot));
    widget?.update({
      stage: "detecting",
      stageLabel: "Waiting for ATS resume parsing",
      message: "The resume is uploaded. Waiting for the employer form to finish updating…",
      lifecyclePhase: "WAITING_FOR_ATS_PARSE"
    });
    const parse = await waitForAtsParse(initialRoot, lifecycle.signal());
    if (parse.activityDetected) {
      lifecycle.transition("ATS_PARSE_ACTIVITY_DETECTED", "relevant_application_mutations", {
        scalarFields: parse.fieldCountAfter,
        repeatableSections: parse.sectionCountAfter,
        populatedFields: parse.populatedAfter,
        relevantMutations: parse.relevantMutations
      });
    }
    lifecycle.transition(
      parse.settled ? "ATS_PARSE_SETTLING" : "ATS_PARSE_TIMEOUT",
      parse.reason,
      {
        scalarFields: parse.fieldCountAfter,
        repeatableSections: parse.sectionCountAfter,
        populatedFields: parse.populatedAfter,
        relevantMutations: parse.relevantMutations
      }
    );
  }

  // Whether this is a post-upload continuation or a manual Rescan/Retry, the
  // current DOM becomes a new generation and all old element references die.
  lifecycle.invalidatePreParse(reason === "manual_retry" ? "manual_retry_current_dom" : "ats_parse_boundary");
  const resolutionRun = beginResolutionRun();
  ledger = [];
  ledgerCounts = computeCounts(ledger);
  lastFields.clear();
  formRoot = resolveApplicationForm(document);
  if (!formRoot.confident) {
    lifecycle.transition("POST_PARSE_REDISCOVERY_FAILED", formRoot.reason ?? "application_root_missing");
    running = false;
    automaticRunSettled = true;
    widget?.update({ stage: "failed", message: "The employer form changed, but EZJobFind could not safely reacquire it. Use Rescan application." });
    return;
  }
  const currentRoot = formRoot.root as ParentNode;
  const postParseToken = lifecycle.token();
  const currentMetrics = domMetrics(currentRoot);
  lifecycle.transition("REDISCOVERING_POST_PARSE_DOM", "fresh_dom_generation", currentMetrics);
  widget?.update({
    stage: "detecting",
    stageLabel: "Post-parse rediscovery",
    message: `Reading the current employer form after resume parsing (DOM generation ${lifecycle.domGeneration()})…`,
    lifecyclePhase: "POST_PARSE_REDISCOVERED"
  });
  const currentScan = scan(currentRoot, session, currentStep());
  lifecycle.transition("RECONCILING_ATS_VALUES", "compare_ats_values_with_profile", currentMetrics);
  lastReconciliation = reconcileAtsValues(currentScan.fields, currentScan.mappings, session);
  log.info("ats reconciliation", {
    runId: lifecycle.runId,
    generation: lifecycle.domGeneration(),
    atsPopulated: lastReconciliation.filter((item) => item.classification.startsWith("ATS_POPULATED")).length,
    conflicts: lastReconciliation.filter((item) => item.classification === "ATS_POPULATED_CONFLICT").length,
    emptyResolvable: lastReconciliation.filter((item) => item.classification === "EMPTY_AND_RESOLVABLE").length
  });
  log.info("eligibility run started", {
    runId: resolutionRun.id,
    lifecycleRunId: lifecycle.runId,
    domGeneration: lifecycle.domGeneration(),
    sessionId: session.sessionId,
    profileRevision: session.profileRevision ?? "unknown",
    buildId: BUILD_INFO.buildId
  });

  // Employment and education are collections, not scalar answers. Expand and
  // fill those rows first so the generic scanner sees the final DOM shape and
  // cannot overwrite every repeated row with the current employer/school.
  const repeaterResults = await fillStructuredRepeaters(currentRoot, session).catch((error) => {
    // A third-party form can replace a section while it is being expanded.
    // Keep the scalar fill usable and make the structured failure diagnosable
    // instead of leaving the content runner permanently stuck in `running`.
    log.warn("structured profile sections failed", {
      error: error instanceof Error ? error.name : "unknown"
    });
    return [];
  });
  if (repeaterResults.length) {
    log.info("structured profile sections processed", {
      sections: repeaterResults.length,
      requested: repeaterResults.reduce((sum, item) => sum + item.recordsRequested, 0),
      found: repeaterResults.reduce((sum, item) => sum + item.recordsFound, 0),
      filled: repeaterResults.reduce((sum, item) => sum + item.fieldsFilled, 0),
      failures: repeaterResults.reduce((sum, item) => sum + item.failures.length, 0)
    });
  }

  // Resolve employer questions against the user's saved answers BEFORE the
  // generic scalar fill: a legal question must be answered from the vault or
  // left alone, never filled by label-matching heuristics.
  lifecycle.transition("FILLING_SCALAR_FIELDS", "canonical_resolver_and_scalar_takeover", domMetrics(currentRoot));
  await resolveAndFillQuestions(currentRoot, resolutionRun.id);

  // Rescan is a DOM-only recovery operation. Supplying an explicit empty
  // document result prevents runAutofill from falling back to its legacy
  // upload path when this tab has no cached upload receipt (for example after
  // a content-script reload). A user-requested rescan must never upload the
  // same resume a second time.
  const documentsForRun: PreparedDocumentUploads = preparedDocuments ?? {
    uploaded: [],
    reviewDocs: [],
    fieldResults: [],
    resumeCommitted: false
  };

  // No raw DOM count here. This used to publish
  // `querySelectorAll(...).length` with a hardcoded `filled: 0`, which is a
  // SECOND set of totals maintained beside the ledger's — and the two could
  // disagree ("Filled 0 of 0" beside "Discovered 11 / Filled 1"). The ledger is
  // the only thing that counts anything now.
  widget?.update({
    stage: "filling",
    stageLabel: STAGE_LABEL.filling,
    message: "Filling verified answers…",
    lifecyclePhase: "FILLING_SCALAR_FIELDS",
    atsPopulated: lastReconciliation.filter((item) => item.classification.startsWith("ATS_POPULATED")).length,
    ...authoritativeTotals()
  });
  try {
    const res = await runAutofill(session, outcome, {
      fetchDocument,
      preparedDocuments: documentsForRun,
      onUploadStart: (kind) => widget?.update({
        stage: "uploading",
        message: `Uploading ${kind === "resume" ? "resume" : "cover letter"}…`,
        ...authoritativeTotals()
      })
    }, currentStep());
    if (!isCurrentInstance() || !lifecycle.accepts(postParseToken)) return;
    lifecycle.transition("FILLING_REPEATABLE_SECTIONS", "structured_section_takeover", domMetrics(currentRoot));
    lastSectionTraces = await fillRepeatableSections(currentRoot, session).catch(() => []);
    if (!lifecycle.accepts(postParseToken)) return;
    lifecycle.transition(
      lastSectionTraces.some((item) =>
        item.candidateRecordCount > 0
        && !["RECORD_ADDED_AND_VERIFIED", "DUPLICATE_ALREADY_PRESENT", "SECTION_POLICY_REVIEW_ONLY"].includes(item.failureCode ?? "")
      )
        ? "REPEATER_FILL_PARTIAL"
        : "VERIFYING_APPLICATION",
      "section_fill_completed",
      {
        repeatableSections: lastSectionTraces.length,
        optionalSkipped: lastSectionTraces.filter((item) => item.failureCode === "NO_CONFIRMED_PROFILE_RECORDS").length,
        unsupported: lastSectionTraces.filter((item) => item.failureCode === "SECTION_POLICY_REVIEW_ONLY").length
      }
    );
    lastScanSignature = scanSignature();
    // Merge (never replace) so a partial rescan can't drop earlier fields.
    for (const f of res.fields) lastFields.set(f.uid, f);
    ledger = mergeLedger(ledger, res.ledger);
    ledgerCounts = computeCounts(ledger);
    // Fold the scalar-fill outcomes into the ONE authoritative ledger. From
    // here on, `ledgerCounts` drives the review list and the per-field detail
    // only — every number the user sees comes from `questionLedger`.
    absorbScalarLedger(questionLedger, ledger);
    lifecycle.transition("FILLING_COMPLETE", "all_fill_phases_terminal", {
      scalarFields: res.counts.discovered,
      repeatableSections: lastSectionTraces.length,
      populatedFields: res.counts.filled
    });

    // The ledger is historical evidence, never the completion authority. A
    // fresh root resolution and field inventory happens NOW, after every fill
    // and repeater render, so a blank required live control cannot be omitted
    // from REVIEW_READY merely because an earlier descriptor disappeared.
    lifecycle.transition("FINAL_LIVE_DOM_RESCAN", "reacquire_current_application_root");
    const finalRoot = resolveApplicationForm(document);
    if (!finalRoot.confident) {
      lifecycle.transition("TECHNICAL_REVIEW_REQUIRED", "FINAL_APPLICATION_ROOT_NOT_FOUND");
      automaticRunSettled = true;
      widget?.update({
        stage: "review",
        stageLabel: "Autofill incomplete",
        message: "EZJobFind could not verify the current application form. Rescan the application before submitting.",
        lifecyclePhase: "TECHNICAL_REVIEW_REQUIRED",
        finalTechnicalIssues: 1
      });
      return;
    }
    lifecycle.transition("REQUIRED_CONTROL_VALIDATION", "fresh_required_inventory");
    lastFinalVerification = verifyFinalLiveDom({
      root: finalRoot.root as ParentNode,
      session,
      domGeneration: lifecycle.domGeneration(),
      lifecycleIsCurrent: lifecycle.accepts(postParseToken),
      ledger,
      questionEntries: questionLedger.all(),
      questionTraces: Array.from(questionExecutionTraces.values()),
      repeatableSections: lastSectionTraces,
      step: currentStep(),
      pageUrl: location.href
    });
    lastTikTokAdapterTrace = lastFinalVerification.tiktokAdapterTrace;
    ledger = lastFinalVerification.ledger;
    ledgerCounts = lastFinalVerification.counts;
    for (const control of lastFinalVerification.controls) recordFinalControl(control);
    lifecycle.transition("REPEATER_VALIDATION", "repeatable_candidate_outcomes_checked", {
      repeatableSections: lastSectionTraces.length,
      optionalSkipped: lastSectionTraces.filter((item) => item.failureCode === "NO_CONFIRMED_PROFILE_RECORDS").length,
      unsupported: lastSectionTraces.filter((item) => item.candidateRecordCount > 0 && item.recordsAdded === 0).length
    });
    lifecycle.transition("CONSENT_VALIDATION", "manual_consent_separated", {
      unresolved: lastFinalVerification.manualConsentActions
    });
    publishTransactionPanel();

    void sendRuntime({
      type: MSG.AUTOFILL_RESULT,
      sessionId: session.sessionId,
      result: {
        ...res.result,
        status: lastFinalVerification.canEnterReviewReady ? "completed" : "completed_with_review",
        fields_discovered: ledgerCounts.discovered,
        fields_filled: ledgerCounts.filled,
        review_items: ledgerCounts.pending + lastFinalVerification.technicalIssues
      },
      progress: {
        ...res.progress,
        state: lastFinalVerification.canEnterReviewReady ? "completed" : "completed_with_review",
        fieldsDiscovered: ledgerCounts.discovered,
        filled: ledgerCounts.filled,
        reviewRequired: ledgerCounts.pending + lastFinalVerification.technicalIssues
      }
    });
    if (
      lastFinalVerification.canEnterReviewReady
      && lastFinalVerification.manualConsentActions === 0
      && await advanceWorkdayWhenSafe()
    ) {
      // Workday replaces the page inside the same SPA. The mutation observer
      // will detect the next step and run the same verified fill pipeline.
      widget?.update({
        stage: "filling",
        ...authoritativeTotals(),
        message: "Current page complete. Moving to the next application step…"
      });
      return;
    } else {
      automaticRunSettled = true;
      const atReview = Boolean(outcome.adapter.isReviewPage?.({ url: location.href, document }));
      const ready = lastFinalVerification.canEnterReviewReady;
      const tiktokActive = lastTikTokAdapterTrace?.adapterActivated === true;
      assertReadyStateConsistent(ledgerCounts, ready, lastFinalVerification);
      const consentMessage = lastFinalVerification.manualConsentActions > 0
        ? `${lastFinalVerification.manualConsentActions} ${tiktokActive ? "privacy consent" : "consent"} action${lastFinalVerification.manualConsentActions === 1 ? "" : "s"} remain${lastFinalVerification.manualConsentActions === 1 ? "s" : ""}.`
        : "";
      widget?.update({
        stage: ready ? "ready" : "review",
        stageLabel: ready ? "Ready for review" : "Autofill incomplete",
        ...authoritativeTotals(),
        message: ready
          ? consentMessage
            ? `Autofill complete. ${consentMessage}`
            : atReview
              ? "Live verification passed. Review the application before submitting."
              : "All required live controls are verified. Review everything before submitting."
          : tiktokActive
            ? `${lastFinalVerification.requiredRemaining} required eligibility field${lastFinalVerification.requiredRemaining === 1 ? "" : "s"} remain. ${lastFinalVerification.technicalIssues} technical issue${lastFinalVerification.technicalIssues === 1 ? "" : "s"}. ${consentMessage}`.trim()
            : `Autofill is incomplete. ${lastFinalVerification.requiredRemaining} required field${lastFinalVerification.requiredRemaining === 1 ? "" : "s"} remain; ${lastFinalVerification.technicalIssues} technical issue${lastFinalVerification.technicalIssues === 1 ? "" : "s"}. ${consentMessage}`.trim(),
        lifecyclePhase: ready ? "REVIEW_READY" : "TECHNICAL_REVIEW_REQUIRED",
        atsPopulated: lastReconciliation.filter((item) => item.classification.startsWith("ATS_POPULATED")).length,
        jobpilotFilled: res.counts.filled,
        sectionRecordsAdded: lastSectionTraces.reduce((sum, item) => sum + item.recordsAdded, 0),
        optionalSectionsSkipped: lastSectionTraces.filter((item) => item.failureCode === "NO_CONFIRMED_PROFILE_RECORDS").length,
        requiredFieldsVerified: lastFinalVerification.requiredVerified,
        requiredFieldsRemaining: lastFinalVerification.requiredRemaining,
        manualConsentActions: lastFinalVerification.manualConsentActions,
        finalTechnicalIssues: lastFinalVerification.technicalIssues
      });
    }
    if (isTopFrame) {
      // Detail and totals come from ONE snapshot. The legacy scalar review
      // model still supplies per-field affordances (real option labels, the
      // save-for-future scope), but it no longer decides WHICH fields need
      // attention or HOW MANY there are — the authoritative ledger does.
      const partition = partitionReview(buildReviewItems(ledger, session));
      widget?.showReview(partition.scalarItems, reviewHandlers, authoritativeReviewCounts());
      // Rendered as real action cards, not as inert text: every action they
      // name is handled by `reviewActionHandlers`.
      widget?.showActions(
        partition.actionItems,
        reviewActionHandlers,
        buildConfirmedReviewItems(questionLedger.all())
      );
    }
    lifecycle.transition(
      lastFinalVerification.canEnterReviewReady ? "REVIEW_READY" : "TECHNICAL_REVIEW_REQUIRED",
      lastFinalVerification.canEnterReviewReady ? "final_live_dom_verified" : "final_live_dom_blocked",
      {
        scalarFields: lastFinalVerification.controls.length,
        repeatableSections: lastSectionTraces.length,
        populatedFields: lastFinalVerification.requiredVerified,
        unresolved: lastFinalVerification.requiredRemaining,
        optionalSkipped: lastSectionTraces.filter((item) => item.failureCode === "NO_CONFIRMED_PROFILE_RECORDS").length,
        unsupported: lastFinalVerification.technicalIssues
      }
    );
    void sendRuntime({
      type: MSG.AUDIT_EVENT,
      sessionId: session.sessionId,
      action_type: "field_filled",
      status: `${res.result.fields_filled} filled`
    });
    log.info("autofill done", {
      ats: res.progress.atsId,
      reasonCode: reason,
      count: res.result.fields_filled
    });
  } catch (err) {
    automaticRunSettled = true;
    widget?.update({ stage: "failed", message: "Autofill failed. Retry or continue manually." });
    void sendRuntime({ type: MSG.AUTOFILL_FAILED, reasonCode: "VALUE_DID_NOT_STICK", message: String(err).slice(0, 80) });
  } finally {
    running = false;
  }
}

/**
 * Ask the backend which options to select, then select and verify them.
 *
 * Results the backend did not mark `resolved` are recorded for review, never
 * approximated here. A resolved result is applied only after re-checking that
 * the control still offers the same options it was resolved against.
 */
/** The one authoritative record of what happened to each question. Every
 * widget count is derived from it, so no two summaries can disagree. */
export const questionLedger = new QuestionLedger();
const questionExecutionTraces = new Map<string, QuestionExecutionTrace>();
const resolutionRuns = new ResolutionRunCoordinator();
let activeResolutionRun: EligibilityRun | null = null;
let activeAtsLifecycle: AtsLifecycleRun | null = null;
let preparedDocuments: PreparedDocumentUploads | null = null;
let lastReconciliation: ReconciledField[] = [];
let lastSectionTraces: SectionTrace[] = [];
let lastFinalVerification: FinalVerificationResult | null = null;
let lastTikTokAdapterTrace: TikTokAdapterTrace | null = null;

/** Generic discovery remains the default. On the exact supported TikTok
 * application path, the legal-only adapter replaces any ambiguous generic
 * descriptors with two fixed, post-render identities. */
function discoverQuestionFields(root: ParentNode): DiscoveredField[] {
  const inventory = discoverTikTokApplication(location.href, root, currentStep());
  if (inventory.trace.urlMatch || inventory.trace.workAuthorizationSectionFound) lastTikTokAdapterTrace = inventory.trace;
  return mergeTikTokLegalFields(discoverFields(root), inventory);
}

function beginResolutionRun(): { id: string; createdAt: string } {
  const run = resolutionRuns.begin(BUILD_INFO.buildId);
  activeResolutionRun = run;
  // Retry is a new observation of the page. Old unresolved items and option
  // probes must not survive and overwrite the new resolver result.
  questionLedger.clear();
  questionExecutionTraces.clear();
  lastFinalVerification = null;
  lastTikTokAdapterTrace = null;
  enumeratedOptions.clear();
  enumerationAttempted.clear();
  return run;
}

function isActiveResolutionRun(runId: string): boolean {
  return resolutionRuns.accepts(runId);
}

function stableTransactionFailure(reason: string): string | null {
  const codes: Record<string, string> = {
    control_not_found: "CONTROL_NOT_FOUND",
    control_replaced: "CONTROL_NOT_FOUND",
    control_disabled: "CONTROL_NOT_INTERACTABLE",
    control_covered: "CONTROL_NOT_INTERACTABLE",
    menu_not_opened: "LISTBOX_NOT_OPENED",
    option_container_missing: "OPTION_NOT_FOUND",
    option_not_found: "OPTION_NOT_FOUND",
    ambiguous_option: "OPTION_POLARITY_AMBIGUOUS",
    interaction_failed: "CONTROL_VALUE_DID_NOT_COMMIT",
    selected_value_not_persisted: "CONTROL_VALUE_DID_NOT_COMMIT",
    backing_value_mismatch: "CONTROL_VALUE_VERIFICATION_FAILED",
    validation_failed: "CONTROL_VALUE_VERIFICATION_FAILED",
    stale_resolution: "CANONICAL_RESOLUTION_CONFLICT",
    timeout: "CONTROL_VALUE_VERIFICATION_FAILED"
  };
  return reason === "verified" ? null : codes[reason] ?? "CONTROL_VALUE_VERIFICATION_FAILED";
}

export function isKnownAnswer(value: unknown): boolean {
  return value !== null && value !== undefined;
}

// --------------------------------------------------------------------------- //
// Runtime identity: is the browser running the build that was tested?
// --------------------------------------------------------------------------- //
/** The last handshake, kept for diagnostics. Categories and build ids only. */
let lastHandshake: RuntimeHandshake | null = null;
let lastHandshakeVerdict: HandshakeVerdict | null = null;
/** What the BACKEND reported about its own contract, from the last resolution. */
let lastResolverContract: {
  requestSchemaVersion: number;
  registryVersion: string;
  answerContractVersion: number;
} | null = null;

function descriptorTrace(field: DiscoveredField): Partial<QuestionExecutionTrace> {
  const element = field.element;
  if (!element) return {};
  const labelledbyIds = (element.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .filter((id) => id.length > 0);
  const labelledbyText = labelledbyIds
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const labelledControl = element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement;
  const associatedLabelText = labelledControl
    ? Array.from(element.labels ?? [])
        .map((label) => (label.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" | ")
    : "";
  const backingValues = element instanceof HTMLSelectElement
    ? Array.from(element.options).map((option) => option.value)
    : [];
  const fingerprintInput = [
    field.frameId, field.label, field.ariaLabel, field.sectionHeading,
    element.tagName, element.getAttribute("role") ?? "", field.name, field.id,
    field.placeholder, labelledbyIds.join(" ")
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < fingerprintInput.length; index += 1) {
    hash ^= fingerprintInput.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    associatedLabelText,
    ariaLabel: element.getAttribute("aria-label"),
    ariaLabelledbyIds: labelledbyIds,
    ariaLabelledbyText: labelledbyText,
    controlTag: element.tagName.toLowerCase(),
    fieldName: field.name,
    fieldDomId: field.id,
    placeholder: field.placeholder,
    ariaExpanded: element.getAttribute("aria-expanded"),
    ariaControls: element.getAttribute("aria-controls"),
    required: field.required,
    disabled: field.disabled,
    nearbyText: field.nearbyText,
    descriptorFingerprint: `d_${(hash >>> 0).toString(16).padStart(8, "0")}`,
    discoveredBackingValues: backingValues
  };
}

/** Reconcile the final live-control verdict into the question model and trace. */
function recordFinalControl(control: FinalControlVerification): void {
  const prior = questionLedger.get(control.fieldKey);
  const preserveMissingAnswer = !control.knownAnswerAvailable
    && (prior?.state === "answer_missing" || prior?.state === "requires_confirmation");
  const state = control.consent
    ? "sensitive_manual"
    : control.verified
      ? "filled_verified"
      : preserveMissingAnswer
        ? null
      : control.required
        ? "interaction_failed"
        : null;
  if (state) {
    questionLedger.recordFinalVerification({
      fieldKey: control.fieldKey,
      state,
      reasonCode: control.consent ? "CONSENT_REQUIRES_USER" : control.failureCode ?? "FINAL_LIVE_DOM_VERIFIED",
      controlType: control.controlType,
      required: control.required,
      canonicalCategory: control.canonicalKey,
      sensitivity: control.consent ? "consent" : undefined
    });
  } else if (preserveMissingAnswer && prior) {
    questionLedger.record({
      fieldKey: control.fieldKey,
      state: prior.state,
      reasonCode: prior.reasonCode,
      controlType: control.controlType,
      required: control.required,
      canonicalCategory: control.canonicalKey,
      sensitivity: prior.sensitivity
    });
  }

  const existing = questionExecutionTraces.get(control.fieldKey);
  const trace: QuestionExecutionTrace = existing ?? {
    fieldId: control.fieldKey,
    frameId: "top",
    rawLabel: control.label,
    accessibleName: control.accessibleName,
    sectionHeading: control.sectionHeading,
    fieldType: control.controlType,
    ariaRole: null,
    options: [...control.options],
    canonicalKey: control.canonicalKey,
    resolutionMethod: "final_live_dom_inventory",
    resolutionConfidence: 0,
    transform: "none",
    requiredCanonicalKeys: [],
    answerSource: "none",
    profileRevision: session?.profileRevision ?? null,
    actuator: null,
    attemptedValue: null,
    displayedValueAfterFill: null,
    backingValueAfterFill: null,
    verified: false,
    failureCode: null
  };
  trace.rawLabel = control.label;
  trace.accessibleName = control.accessibleName;
  trace.sectionHeading = control.sectionHeading;
  trace.canonicalKey = control.canonicalKey;
  trace.required = control.required;
  trace.descriptorFingerprint = control.fingerprint;
  trace.domGeneration = control.domGeneration;
  trace.actuatorReached = control.actuatorReached;
  trace.transactionState = control.consent
    ? "MANUAL_CONSENT"
    : control.verified
      ? "FILLED"
      : preserveMissingAnswer
        ? "ANSWER_MISSING"
      : "TECHNICAL_REVIEW_REQUIRED";
  trace.displayedValueAfterFill = control.displayValuePresent ? "[present]" : "[empty]";
  trace.backingValueAfterFill = control.backingValuePresent ? "[present]" : "[empty]";
  trace.verified = control.verified;
  trace.failureCode = control.consent || preserveMissingAnswer ? null : control.failureCode;
  trace.reviewStatus = control.consent
    ? "manual"
    : control.verified
      ? "filled"
      : preserveMissingAnswer
        ? prior?.state ?? "missing"
        : "technical_issue";
  trace.sensitivity = control.consent ? "consent" : trace.sensitivity ?? null;
  questionExecutionTraces.set(control.fieldKey, trace);
}

/**
 * One named stage in the request path, logged safely.
 *
 * The point is to make "where did this actually fail?" answerable from a live
 * page without a debugger. Every payload is counts, enums and canonical keys —
 * never question text, never an option label, never an answer, never a token.
 * A field is identified by its opaque ledger key, which is a per-run WeakMap
 * counter and carries no page content.
 */
export type RequestStage =
  | "question_discovered"
  | "options_enumerated"
  | "batch_created"
  | "resolver_requested"
  | "resolver_succeeded"
  | "resolver_rejected"
  | "canonical_key_resolved"
  | "answer_missing"
  | "answer_stale"
  | "option_ref_returned"
  | "option_selected"
  | "displayed_value_verified"
  | "backing_value_verified"
  | "interaction_failed";

function emitStage(stage: RequestStage, detail: Record<string, string | number | boolean> = {}): void {
  log.info(`apply.stage.${stage}`, detail);
}

/**
 * Ask the service worker who it is, and compare.
 *
 * The widget is created by this content script from this same bundle, so it
 * reports this build by construction — it is included because "the panel is
 * stale" is a common (and here, checkable) suspicion.
 */
async function verifyRuntime(): Promise<{ ok: boolean; message: string; reasonCode: string }> {
  const self: RuntimeIdentity = {
    buildId: BUILD_INFO.buildId,
    version: BUILD_INFO.version,
    environment: classifyEnvironment(await contentApiBase()),
    apiBase: safeApiBase(await contentApiBase())
  };

  const response = (await sendRuntime({ type: MSG.RUNTIME_IDENTITY })) as
    | {
        ok?: boolean;
        identity?: RuntimeIdentity;
        sidePanelIdentity?: RuntimeIdentity | null;
        webEnvironment?: ApiEnvironment | null;
        webApiBase?: string | null;
        webAuthenticatedUserId?: number | null;
      }
    | undefined;

  const handshake: RuntimeHandshake = {
    contentScript: self,
    // A worker that did not answer is not assumed to match.
    serviceWorker: response?.ok && response.identity ? response.identity : null,
    widget: self,
    sidePanel: response?.sidePanelIdentity ?? null,
    webEnvironment: response?.webEnvironment ?? null,
    webApiBase: response?.webApiBase ?? null,
    webAuthenticatedUserId: response?.webAuthenticatedUserId ?? null,
    extensionAuthenticatedUserId: session?.authenticatedUserId ?? null
  };
  const verdict = evaluateHandshake(handshake);
  lastHandshake = handshake;
  lastHandshakeVerdict = verdict;

  // Build ids and environment CATEGORIES only — never the backend hostname.
  log.info("runtime handshake", handshakeSummary(handshake, verdict));
  return {
    ok: verdict.ok,
    message: verdict.message,
    reasonCode:
      verdict.reason === "build_mismatch"
        ? "RUNTIME_MISMATCH"
        : verdict.reason === "environment_mismatch"
          ? "API_BASE_MISMATCH"
          : verdict.reason === "account_mismatch"
            ? "AUTHENTICATED_USER_MISMATCH"
          : verdict.reason === "worker_unreachable"
            ? "RUNTIME_WORKER_UNREACHABLE"
            : "RUNTIME_OK"
  };
}

/** The content script's own view of the API base, for its environment category. */
async function contentApiBase(): Promise<string> {
  try {
    return await getApiBase();
  } catch {
    return "";
  }
}

async function resolveAndFillQuestions(root: ParentNode, runId: string): Promise<void> {
  if (!session) return;
  // Which questions the user already answered for THIS application, read from
  // the session rather than remembered: this content script may have been
  // injected long after the user answered.
  await recoverApplicationOverrides();

  const fields = discoverQuestionFields(root);

  // A custom dropdown that builds its menu on open reports no options while
  // closed, so it would never reach the backend at all. Read those first —
  // open, capture, close — without ever choosing anything.
  const enumerated = await enumerateClosedControls(fields);

  const prepared = buildQuestionBatch(fields, "en-US", enumerated);
  emitStage("question_discovered", { controls: fields.length, questions: prepared.length });
  if (prepared.length === 0) return;
  emitStage("batch_created", { questions: prepared.length });

  await resolveAndApply(root, prepared, runId);
  markRecoveredOverrides();
  publishStage();
}

/**
 * Ask the backend about a prepared batch, then apply and verify what it approves.
 *
 * Shared by the whole-page run and the targeted refresh that follows a user's
 * application-only answer, so a re-resolution cannot take a shortcut the
 * automatic path does not: same option validation, same staleness check, same
 * verification, same ledger transitions.
 */
async function resolveAndApply(
  root: ParentNode,
  prepared: PreparedQuestion[],
  runId = activeResolutionRun?.id ?? "no-active-run"
): Promise<{ ok: boolean; error?: string; outcomes: Map<string, QuestionState> }> {
  const outcomes = new Map<string, QuestionState>();
  if (!session || prepared.length === 0) return { ok: false, error: "nothing_to_resolve", outcomes };

  emitStage("resolver_requested", { count: prepared.length });
  const response = (await sendRuntime({
    type: MSG.RESOLVE_QUESTIONS,
    sessionId: session.sessionId,
    questions: prepared.map((entry) => entry.question)
  })) as {
    ok?: boolean;
    results?: ResolutionResult[];
    error?: string;
    registry_version?: string;
    answer_contract_version?: number;
    request_schema_version?: number;
  } | undefined;

  if (!response?.ok || !response.results) {
    emitStage("resolver_rejected", { reason: response?.error ?? "no_response" });
    log.info("question resolution unavailable", { reason: response?.error ?? "no_response" });
    return { ok: false, error: response?.error ?? "no_response", outcomes };
  }

  // The request may finish after Retry started a newer run. Late results are
  // ignored wholesale; they may not repaint a resolved field as missing.
  if (!isActiveResolutionRun(runId)) {
    log.info("stale eligibility response ignored", { runId });
    return { ok: false, error: "STALE_RUN_IGNORED", outcomes };
  }

  if (response.request_schema_version !== 3 || response.answer_contract_version !== 3) {
    const code = response.request_schema_version !== 3
      ? "REQUEST_SCHEMA_MISMATCH"
      : "ANSWER_CONTRACT_MISMATCH";
    for (const entry of prepared) {
      questionLedger.record({
        fieldKey: entry.question.field_ref,
        state: "interaction_failed",
        reasonCode: code,
        controlType: entry.question.control_type,
        required: entry.question.required
      });
    }
    widget?.update({
      stage: "failed",
      message: "EZJobFind's extension and answer service use different contracts. Reload the current local build.",
      recoverable: false,
      ...authoritativeTotals()
    });
    return { ok: false, error: code, outcomes };
  }

  // What the SERVER says it is. A resolver older than this client shows up here
  // rather than as a set of inexplicably unanswered questions.
  if (typeof response.registry_version === "string") {
    lastResolverContract = {
      requestSchemaVersion: response.request_schema_version ?? 2,
      registryVersion: response.registry_version,
      answerContractVersion: response.answer_contract_version ?? 0
    };
  }
  emitStage("resolver_succeeded", {
    returned: response.results.length,
    registry: lastResolverContract?.registryVersion ?? "unknown"
  });

  log.info("questions resolved", {
    asked: prepared.length,
    returned: response.results.length
  });

  for (const { prepared: entry, result, approvedLabel } of matchResults(prepared, response.results)) {
    // Contract v3 can resolve a boolean before a closed custom control exposes
    // its options. Use the backend's canonical display answer only when the
    // typed value is explicitly boolean; ``false`` is intentionally valid.
    const labelToApply = approvedLabel;
    const common = {
      fieldKey: result.field_ref,
      controlType: entry.question.control_type,
      required: entry.question.required,
      canonicalCategory: result.canonical_key,
      sensitivity: result.sensitivity,
      // Provenance comes from the SERVER's answer, never from what the widget
      // asked for: `application_override` is the server saying it used the
      // answer the user gave for this one application.
      applicationOverride: result.safe_source === "application_override"
    };
    const traceBase: QuestionExecutionTrace = {
      fieldId: result.field_ref,
      frameId: entry.field.frameId,
      rawLabel: entry.field.label,
      accessibleName: entry.field.ariaLabel,
      sectionHeading: entry.field.sectionHeading,
      fieldType: entry.question.control_type,
      ariaRole: entry.question.aria_role,
      options: entry.question.options.map((option) => option.label),
      ...descriptorTrace(entry.field),
      canonicalKey: result.canonical_key,
      resolutionMethod: result.resolution_method ?? "unknown",
      resolutionConfidence: result.confidence,
      transform: result.transform ?? "none",
      requiredCanonicalKeys: result.required_canonical_keys ?? [],
      answerSource: result.safe_source,
      sensitivity: result.sensitivity,
      sourceValues: result.source_values ?? [],
      typedAnswer: typeof result.typed_answer === "boolean" ? result.typed_answer : null,
      displayAnswer: result.display_answer ?? null,
      reviewStatus: result.status,
      profileRevision: session.profileRevision ?? null,
      requestEndpoint: `/application-sessions/${session.sessionId}/resolve-questions`,
      requestSchemaVersion: response.request_schema_version ?? 2,
      answerContractVersion: response.answer_contract_version ?? 0,
      extensionBuildId: BUILD_INFO.buildId,
      runId,
      runCreatedAt: activeResolutionRun?.createdAt,
      applicationSessionId: session.sessionId,
      domGeneration: activeAtsLifecycle?.domGeneration() ?? 0,
      actuator: entry.question.control_type === "native_select" ? "native_select" : "aria_listbox",
      actuatorReached: false,
      attemptedValue: labelToApply ? "[redacted]" : null,
      displayedValueAfterFill: null,
      backingValueAfterFill: null,
      verified: false,
      failureCode: null
    };

    if (result.canonical_key) {
      emitStage("canonical_key_resolved", {
        field: result.field_ref,
        canonical: result.canonical_key,
        status: result.status
      });
    }

    if (result.status === "resolved" && isKnownAnswer(result.typed_answer) && !labelToApply) {
      questionLedger.record({ ...common, state: "answer_resolved", reasonCode: result.reason_code });
      questionLedger.record({ ...common, state: "interaction_failed", reasonCode: "INTERNAL_HANDOFF_FAILURE" });
      questionExecutionTraces.set(result.field_ref, {
        ...traceBase,
        transactionState: "SEMANTICALLY_RESOLVED",
        transactionStates: ["DISCOVERED", "RESOLVER_REQUESTED", "SEMANTICALLY_RESOLVED"],
        failureCode: "INTERNAL_HANDOFF_FAILURE"
      });
      outcomes.set(result.field_ref, "interaction_failed");
      continue;
    }

    if (result.status !== "resolved" || !labelToApply) {
      // missing / stale / requires_confirmation / ambiguous / manual all land
      // here. Each is the user's to resolve; none is guessed.
      const state = stateForUnresolved(result.status);
      emitStage(result.status === "stale" ? "answer_stale" : "answer_missing", {
        field: result.field_ref,
        canonical: result.canonical_key ?? "none",
        status: result.status,
        reason: result.reason_code,
        // Distinguishes "the server had no answer" from "the server answered
        // but named an option this page does not offer".
        optionRefReturned: Boolean(result.selected_option_ref)
      });
      questionLedger.record({ ...common, state, reasonCode: result.reason_code });
      questionExecutionTraces.set(result.field_ref, {
        ...traceBase,
        failureCode: result.reason_code === "canonical_resolution_conflict"
          ? "CANONICAL_RESOLUTION_CONFLICT"
          : null
      });
      outcomes.set(result.field_ref, state);
      continue;
    }

    emitStage("option_ref_returned", {
      field: result.field_ref,
      canonical: result.canonical_key ?? "none",
      source: result.safe_source
    });
    questionLedger.record({ ...common, state: "answer_resolved", reasonCode: result.reason_code });
    questionLedger.record({ ...common, state: "selecting", reasonCode: "applying" });
    publishStage();

    const outcome = await applyResolvedAnswer(root, entry, labelToApply, {
      canonicalKey: result.canonical_key,
      typedAnswer: typeof result.typed_answer === "boolean" ? result.typed_answer : null
    });
    if (!isActiveResolutionRun(runId)) continue;
    emitStage(
      outcome.status === "filled_verified" ? "displayed_value_verified" : "interaction_failed",
      {
        field: result.field_ref,
        canonical: result.canonical_key ?? "none",
        reason: outcome.reason
      }
    );
    // Same fieldKey, so this UPDATES the entry the question started on rather
    // than adding a second one for the same control.
    questionLedger.record({ ...common, state: outcome.status, reasonCode: outcome.reason });
    questionExecutionTraces.set(result.field_ref, {
      ...traceBase,
      actuatorReached: true,
      transactionState: outcome.transaction?.states.at(-1) ?? "QUEUED_FOR_ACTUATION",
      transactionStates: outcome.transaction?.states ?? ["DISCOVERED", "RESOLVER_REQUESTED", "SEMANTICALLY_RESOLVED", "QUEUED_FOR_ACTUATION"],
      actualTrigger: outcome.transaction?.trigger ?? null,
      openStrategy: outcome.transaction?.openStrategy ?? null,
      listboxFound: outcome.transaction?.listboxFound ?? false,
      discoveredLiveOptions: outcome.transaction?.options ?? [],
      matchedOption: outcome.transaction?.matchedOption === "[present]" ? "[present]" : null,
      verificationSource: outcome.transaction?.verificationSource ?? null,
      displayedValueAfterFill: outcome.displayed === undefined
        ? null
        : outcome.displayed.trim() ? "[present]" : "[empty]",
      backingValueAfterFill: outcome.backing === undefined
        ? null
        : outcome.backing.trim() ? "[present]" : "[empty]",
      verified: outcome.status === "filled_verified",
      failureCode: entry.field.uid.startsWith("tiktok:")
        ? outcome.reason === "verified" ? null : tikTokFailureCode(outcome.reason)
        : stableTransactionFailure(outcome.reason)
    });
    outcomes.set(result.field_ref, outcome.status);
  }
  return { ok: true, outcomes };
}

/**
 * Re-resolve ONLY the controls mapped to the given canonical questions.
 *
 * This is what makes an application-only answer cheap and safe. A full autofill
 * re-run would re-touch every control on the page, including ones already
 * verified — and re-driving a dropdown that is already correct is how a
 * controlled React select gets a chance to reject the value it accepted.
 */
async function reresolveCanonicalKeys(
  keys: string[]
): Promise<Map<string, QuestionState>> {
  const wanted = new Set(keys);
  const targetFieldKeys = new Set(
    questionLedger
      .all()
      .filter((entry) => entry.canonicalCategory && wanted.has(entry.canonicalCategory))
      .map((entry) => entry.fieldKey)
  );
  if (targetFieldKeys.size === 0) return new Map();

  const root = (formRoot?.root ?? document) as ParentNode;
  // Every other control — including every `filled_verified` one — is simply not
  // in this list, so it is never re-enumerated and never re-driven.
  const affected = discoverQuestionFields(root).filter((field) => targetFieldKeys.has(fieldRef(field)));
  if (affected.length === 0) return new Map();

  const enumerated = await enumerateClosedControls(affected);
  const prepared = buildQuestionBatch(affected, "en-US", enumerated);
  if (prepared.length === 0) return new Map();

  log.info("targeted question refresh", { fields: prepared.length });
  const { outcomes } = await resolveAndApply(root, prepared, activeResolutionRun?.id);
  publishStage();
  return outcomes;
}

// --------------------------------------------------------------------------- //
// Application-only answers
// --------------------------------------------------------------------------- //
/** Canonical keys the user has answered for THIS application, as reported by
 * the session. Never a substitute for the server's decision — only used to keep
 * what the user READS accurate when a refresh cannot run. */
const recoveredOverrideKeys = new Set<string>();
let overridesRecovered = false;

async function recoverApplicationOverrides(): Promise<void> {
  if (!session || overridesRecovered) return;
  overridesRecovered = true;
  const response = (await sendRuntime({
    type: MSG.GET_APPLICATION_OVERRIDES,
    sessionId: session.sessionId
  })) as { ok?: boolean; overrides?: string[]; error?: string } | undefined;

  if (!response?.ok || !Array.isArray(response.overrides)) {
    // A failure here is not fatal: resolution still consults the session's
    // overrides server-side. Only the provenance WORDING degrades.
    log.debug("application answers not recovered", { reason: response?.error ?? "no_response" });
    overridesRecovered = false;
    return;
  }
  for (const key of response.overrides) recoveredOverrideKeys.add(key);
  // Count only. Which questions were answered is registry vocabulary; what the
  // answers were never leaves the server.
  log.info("application answers recovered", { count: recoveredOverrideKeys.size });
}

/**
 * Re-attach "answered for this application" to what the ledger already knows.
 *
 * Without this, a content script reinjected after the user answered would
 * describe their answer as absent — or worse, as coming from their saved
 * profile — for any field the refresh could not reach.
 */
function markRecoveredOverrides(): void {
  if (recoveredOverrideKeys.size === 0) return;
  for (const entry of questionLedger.all()) {
    if (!entry.canonicalCategory || !recoveredOverrideKeys.has(entry.canonicalCategory)) continue;
    questionLedger.record({
      fieldKey: entry.fieldKey,
      state: entry.state,
      reasonCode: entry.reasonCode,
      applicationOverride: true
    });
  }
}

/** Map a backend resolution status onto its ledger state. */
function stateForUnresolved(status: string): QuestionState {
  switch (status) {
    case "missing":
      return "answer_missing";
    case "stale":
    case "requires_confirmation":
      return "requires_confirmation";
    case "manual":
      return "sensitive_manual";
    default:
      // ambiguous / unsupported: recognised, but not safely answerable.
      return "unsupported";
  }
}

/** The authoritative review list, in the shape the widget renders. */
export function authoritativeReviewItems(): AuthoritativeReviewItem[] {
  return buildAuthoritativeReviewItems(questionLedger.all()).map((item) => {
    if (!item.fieldKey.includes("tiktok:work_authorization:")) return item;
    const trace = questionExecutionTraces.get(item.fieldKey);
    if (
      typeof trace?.typedAnswer !== "boolean"
      || !["interaction_failed", "requires_user_gesture"].includes(item.state)
    ) return item;
    return {
      ...item,
      actions: ["apply_approved_answer", "focus_control", "leave_unresolved"],
      assistedAnswer: trace.typedAnswer ? "Yes" : "No",
      assistedQuestionLabel: trace.canonicalKey === "work_authorization_us"
        ? "work authorization"
        : "sponsorship"
    };
  });
}

/**
 * Counts in the widget's existing shape, computed from the authoritative
 * ledger. This is what stops the summary from describing a different set of
 * fields than the list beneath it.
 */
function authoritativeReviewCounts(): LedgerCounts {
  const counts = questionLedger.counts();
  const pending =
    counts.needs_information +
    counts.needs_confirmation +
    counts.needs_user_gesture +
    counts.technical_issues +
    counts.legal_manual_actions +
    counts.unsupported;
  return {
    discovered: counts.discovered,
    filled: counts.filled_and_verified,
    needsInformation: counts.needs_information,
    needsConfirmation: counts.needs_confirmation,
    sensitive: counts.legal_manual_actions,
    technical: counts.technical_issues,
    optionalSkipped: counts.optional_skipped,
    requiredBlank: questionLedger
      .all()
      .filter((entry) => entry.required && entry.state === "answer_missing").length,
    pending
  };
}

/**
 * Split the review list between the two models that describe it.
 *
 * They overlap: a control folded in from the scalar fill has an entry in both,
 * and rendering both would show the same question twice with different
 * affordances. Which one wins is a question of who can actually help.
 *
 * A recognised legal question wins as an ACTION card, because that is the only
 * card that can store an application-only answer and re-resolve the control —
 * a free-text box would just be the user typing "Yes" into a dropdown. Consent
 * likewise, because the only correct affordance there is "take me to it".
 *
 * Everything else — a school name, a degree, a graduation year — keeps its
 * scalar card, which has the real discovered options and the save-for-future
 * choice.
 *
 * Previously the authoritative items were flattened into scalar items with a
 * free-text box, which is how the review list came to name "Answer for this
 * application" with nothing behind it.
 */
function partitionReview(scalarItems: ReviewItem[]): {
  scalarItems: ReviewItem[];
  actionItems: AuthoritativeReviewItem[];
} {
  const authoritative = authoritativeReviewItems();
  const ownedByAction = new Set<string>();
  for (const item of authoritative) {
    // Answerable for this application, or a consent question. Both are cases the
    // scalar editor would handle worse, not better.
    if (item.answerType !== null || item.category === "manual_legal") {
      ownedByAction.add(uidOfFieldKey(item.fieldKey));
    }
  }

  const keptScalar = scalarItems.filter((item) => !ownedByAction.has(item.id));
  const pendingScalarIds = new Set(
    keptScalar.filter((item) => !item.resolved).map((item) => item.id)
  );
  const keptActions = authoritative.filter((item) => {
    const uid = uidOfFieldKey(item.fieldKey);
    return ownedByAction.has(uid) || !pendingScalarIds.has(uid);
  });
  return { scalarItems: keptScalar, actionItems: keptActions };
}

/** `f_<frameId>_<uid>` -> `<uid>`. Neither part contains an underscore. */
function uidOfFieldKey(fieldKey: string): string {
  const match = /^f_[^_]*_(.+)$/.exec(fieldKey);
  return match ? match[1] : fieldKey;
}

/** Push the authoritative list and its counts into the widget. Called after
 * every action so what the user sees is never one step behind the ledger. */
function refreshAuthoritativeReview(): void {
  if (!isTopFrame) return;
  const partition = partitionReview(session ? buildReviewItems(ledger, session) : []);
  widget?.showActions(
    partition.actionItems,
    reviewActionHandlers,
    buildConfirmedReviewItems(questionLedger.all())
  );
  widget?.refreshCounts(authoritativeReviewCounts());
}

/**
 * The three review actions, wired.
 *
 * Each one is validated where it arrives, not only where it was built: this
 * object is called by the widget, and the widget is code the employer's page
 * cannot reach — but the same request also crosses into the service worker,
 * which is reachable from anywhere in the extension.
 */
const applicationAnswers = createApplicationAnswerHandlers({
  ledger: questionLedger,
  sessionId: () => session?.sessionId ?? null,

  async storeOverride(canonicalKey, value) {
    const response = (await sendRuntime({
      type: MSG.SET_APPLICATION_OVERRIDE,
      sessionId: session?.sessionId ?? -1,
      canonicalKey,
      // The user's explicit choice, and nothing else. Provenance is the
      // server's to stamp.
      value
    })) as { ok?: boolean; error?: string } | undefined;
    if (!response?.ok) {
      // The code only. Never the answer, the question, or the session.
      log.info("application answer not stored", { reason: response?.error ?? "no_response" });
      return { ok: false, error: response?.error ?? "UNKNOWN" };
    }
    return { ok: true };
  },

  reresolve: (keys) => reresolveCanonicalKeys(keys),

  audit(event) {
    if (!session) return;
    void sendRuntime({ type: MSG.AUDIT_EVENT, sessionId: session.sessionId, ...event });
  },

  onLedgerChanged: () => refreshAuthoritativeReview(),

  markRecovered(canonicalKey) {
    recoveredOverrideKeys.add(canonicalKey);
    markRecoveredOverrides();
  }
});

const reviewActionHandlers: ReviewActionHandlers = {
  sessionId: () => session?.sessionId ?? null,
  onFocusControl(fieldKey) {
    reviewHandlers.onJumpToField(fieldKey);
  },
  onAnswerForThisApplication: (request) => applicationAnswers.answerForThisApplication(request),
  onApplyApprovedAnswer: (fieldKey) => applyTikTokAssistedAnswer(fieldKey),
  onLeaveUnresolved: (fieldKey) => applicationAnswers.leaveUnresolved(fieldKey)
};

async function applyTikTokAssistedAnswer(fieldKey: string) {
  const trace = questionExecutionTraces.get(fieldKey);
  if (!session || typeof trace?.typedAnswer !== "boolean" || !trace.displayAnswer) {
    return { ok: false, stored: false, code: "ASSISTED_ACTION_UNAVAILABLE" };
  }
  const identity = fieldKey.replace(/^f_[^_]*_/, "");
  if (!identity.startsWith("tiktok:work_authorization:")) {
    return { ok: false, stored: false, code: "ASSISTED_ACTION_UNAVAILABLE" };
  }
  const root = (formRoot?.root ?? document) as ParentNode;
  const transaction = await actuateTikTokLegalField(
    location.href,
    identity,
    trace.displayAnswer,
    trace.typedAnswer,
    root,
    true
  );
  const slot = discoverTikTokApplication(location.href, root).slots.find((item) => item.identity === identity);
  const committed = slot ? TikTokApplicationAdapter.verify(slot, trace.typedAnswer) : null;
  const verified = transaction.ok || Boolean(committed?.verified);
  const failureCode = verified ? null : tikTokFailureCode(transaction.reason);
  trace.actuatorReached = true;
  trace.transactionStates = transaction.states;
  trace.transactionState = transaction.states.at(-1) ?? "QUEUED_FOR_ACTUATION";
  trace.actualTrigger = transaction.trigger ?? null;
  trace.openStrategy = transaction.openStrategy ?? null;
  trace.listboxFound = Boolean(transaction.listboxFound);
  trace.discoveredLiveOptions = transaction.options ?? [];
  trace.matchedOption = transaction.matchedOption === "[present]" ? "[present]" : null;
  trace.verificationSource = committed?.verificationSource ?? transaction.verificationSource ?? null;
  trace.displayedValueAfterFill = committed?.displayPresent || transaction.displayed ? "[present]" : "[empty]";
  trace.backingValueAfterFill = committed?.backingPresent || transaction.backing ? "[present]" : "[empty]";
  trace.verified = verified;
  trace.failureCode = failureCode;
  trace.reviewStatus = verified ? "filled" : "technical_issue";
  questionLedger.recordFinalVerification({
    fieldKey,
    state: verified ? "filled_verified" : "interaction_failed",
    reasonCode: failureCode ?? "FINAL_LIVE_DOM_VERIFIED",
    controlType: "combobox",
    required: true,
    canonicalCategory: trace.canonicalKey
  });

  const finalRoot = resolveApplicationForm(document);
  if (finalRoot.confident && activeAtsLifecycle) {
    lastFinalVerification = verifyFinalLiveDom({
      root: finalRoot.root as ParentNode,
      session,
      domGeneration: activeAtsLifecycle.domGeneration(),
      lifecycleIsCurrent: true,
      ledger,
      questionEntries: questionLedger.all(),
      questionTraces: Array.from(questionExecutionTraces.values()),
      repeatableSections: lastSectionTraces,
      step: currentStep(),
      pageUrl: location.href
    });
    lastTikTokAdapterTrace = lastFinalVerification.tiktokAdapterTrace;
    ledger = lastFinalVerification.ledger;
    ledgerCounts = lastFinalVerification.counts;
    for (const control of lastFinalVerification.controls) recordFinalControl(control);
    widget?.update({
      stage: lastFinalVerification.canEnterReviewReady ? "ready" : "review",
      stageLabel: lastFinalVerification.canEnterReviewReady ? "Ready for review" : "Autofill incomplete",
      message: lastFinalVerification.canEnterReviewReady
        ? `Autofill complete. ${lastFinalVerification.manualConsentActions} privacy consent action${lastFinalVerification.manualConsentActions === 1 ? "" : "s"} remain${lastFinalVerification.manualConsentActions === 1 ? "s" : ""}.`
        : `${lastFinalVerification.requiredRemaining} required eligibility field${lastFinalVerification.requiredRemaining === 1 ? "" : "s"} remain.`,
      requiredFieldsVerified: lastFinalVerification.requiredVerified,
      requiredFieldsRemaining: lastFinalVerification.requiredRemaining,
      manualConsentActions: lastFinalVerification.manualConsentActions,
      finalTechnicalIssues: lastFinalVerification.technicalIssues
    });
  }
  refreshAuthoritativeReview();
  publishTransactionPanel();
  return {
    ok: verified,
    stored: false,
    code: failureCode ?? undefined,
    sourceLabel: verified ? "Confirmed saved answer" : undefined
  };
}

/**
 * The ONLY source of the numbers the widget shows.
 *
 * Both the question-resolution path and the scalar-fill path feed
 * `questionLedger`, so these totals cannot disagree with each other the way
 * two independently maintained counters did.
 */
function authoritativeTotals(): { filled: number; total: number } {
  const counts = questionLedger.counts();
  return { filled: counts.filled_and_verified, total: counts.discovered };
}

/** Push the ledger-derived stage and counts into the widget. */
/**
 * The ledger's stage, mapped onto the widget's coarse presentation enum.
 *
 * The enum drives styling only. The words the user reads come from the ledger's
 * own stage name, which is why the header can no longer say "Detecting fields"
 * while the ledger is matching answers.
 */
function widgetStageFor(stage: WidgetStageName): WidgetStage {
  switch (stage) {
    case "understanding_questions":
    case "reading_options":
    case "matching_answers":
      return "detecting";
    case "filling":
      return "filling";
    case "waiting_for_you":
      return "review";
    case "ready_for_review":
      return "ready";
  }
}

function publishStage(): void {
  if (!isTopFrame) return;
  const stage = questionLedger.stage();
  const counts = questionLedger.counts();
  widget?.update({
    stage: widgetStageFor(stage),
    // Header and body both name the SAME ledger stage.
    stageLabel: STAGE_LABEL[stage],
    message:
      counts.discovered === 0
        ? "Reading the questions on this page…"
        : `${STAGE_LABEL[stage]} — ${counts.discovered} question${counts.discovered === 1 ? "" : "s"} found so far.`,
    ...authoritativeTotals()
  });
  publishTransactionPanel();
}

function publishTransactionPanel(): void {
  const items: TransactionPanelItem[] = Array.from(questionExecutionTraces.values()).map((trace) => ({
    category: trace.sensitivity === "consent" ? "consent" : "eligibility",
    fieldLabel: trace.rawLabel || trace.accessibleName || "Eligibility question",
    fingerprint: trace.descriptorFingerprint ?? null,
    domGeneration: trace.domGeneration ?? null,
    canonicalKey: trace.canonicalKey,
    typedAnswer: trace.typedAnswer ?? null,
    displayAnswer: trace.displayAnswer ?? null,
    answerSource: trace.answerSource,
    state: trace.transactionState ?? (trace.verified ? "FILLED" : "DISCOVERED"),
    actuator: trace.actuator,
    trigger: trace.actualTrigger ?? null,
    listboxFound: Boolean(trace.listboxFound),
    optionsDiscovered: trace.discoveredLiveOptions?.length ?? trace.options.length,
    matchedOption: trace.matchedOption === "[present]",
    displayedResult: trace.displayedValueAfterFill,
    backingResult: trace.backingValueAfterFill,
    finalStatus: trace.verified ? "filled" : trace.reviewStatus ?? "technical_issue",
    failureCode: trace.failureCode
  }));
  if (lastTikTokAdapterTrace) {
    items.unshift({
      category: "eligibility" as const,
      fieldLabel: "TikTok adapter health",
      fingerprint: null,
      domGeneration: lastTikTokAdapterTrace.domGeneration,
      canonicalKey: null,
      typedAnswer: null,
      displayAnswer: null,
      answerSource: "adapter_health",
      state: lastTikTokAdapterTrace.adapterActivated ? "ACTIVATED" : "NOT_ACTIVATED",
      actuator: "tiktok_application",
      trigger: null,
      listboxFound: false,
      optionsDiscovered: 0,
      matchedOption: false,
      displayedResult: null,
      backingResult: null,
      finalStatus: lastTikTokAdapterTrace.finalVerificationUsedTikTokAdapter ? "final_verification_used_adapter" : "not_finally_verified",
      failureCode: lastTikTokAdapterTrace.adapterActivated ? null : lastTikTokAdapterTrace.activationReason,
      details: [
        `url=${lastTikTokAdapterTrace.currentUrl}`,
        `reason=${lastTikTokAdapterTrace.activationReason}`,
        `application=${lastTikTokAdapterTrace.applicationPageFound} section=${lastTikTokAdapterTrace.workAuthorizationSectionFound}`,
        `authorization question=${lastTikTokAdapterTrace.authorizationQuestionFound} trigger=${lastTikTokAdapterTrace.authorizationTriggerFound} inserted=${lastTikTokAdapterTrace.authorizationInventoryInserted} actuator=${lastTikTokAdapterTrace.authorizationActuatorReached}`,
        `sponsorship question=${lastTikTokAdapterTrace.sponsorshipQuestionFound} trigger=${lastTikTokAdapterTrace.sponsorshipTriggerFound} inserted=${lastTikTokAdapterTrace.sponsorshipInventoryInserted} actuator=${lastTikTokAdapterTrace.sponsorshipActuatorReached}`
      ]
    });
  }
  widget?.showTransactions(items);
}

/** field_ref -> the option set read by opening the control. */
const enumeratedOptions = new Map<string, string[]>();
/** One enumeration attempt per control per run; a page that ignores synthetic
 * input must not be poked repeatedly. */
const enumerationAttempted = new Set<string>();

async function enumerateClosedControls(
  fields: DiscoveredField[]
): Promise<Map<string, string[]>> {
  const pending = needsEnumeration(fields);
  if (pending.length === 0) return enumeratedOptions;

  for (const field of pending) {
    const ref = fieldRef(field);
    if (enumeratedOptions.has(ref)) continue;
    if (enumerationAttempted.has(ref)) continue;
    enumerationAttempted.add(ref);

    questionLedger.record({
      fieldKey: ref,
      state: "enumerating_options",
      reasonCode: "menu_closed",
      controlType: "combobox",
      required: Boolean(field.required)
    });
    publishStage();
    const result = await enumerateOptions(field);
    log.info("option enumeration", { reason: result.reason, count: result.options.length });

    emitStage("options_enumerated", {
      field: ref,
      ok: result.ok,
      count: result.options.length,
      reason: result.reason
    });
    if (result.ok) {
      enumeratedOptions.set(ref, result.options);
      questionLedger.record({
        fieldKey: ref,
        state: "canonicalizing",
        reasonCode: "enumerated",
        controlType: "combobox",
        required: Boolean(field.required)
      });
    } else {
      // `genuine_user_gesture_required` is the honest case: the page refuses
      // synthetic opens, so the user's own click is needed. Everything else is
      // a technical failure. Neither is retried in this run.
      questionLedger.record({
        fieldKey: ref,
        state:
          result.reason === "genuine_user_gesture_required"
            ? "requires_user_gesture"
            : "interaction_failed",
        reasonCode: result.reason,
        controlType: "combobox",
        required: Boolean(field.required)
      });
    }
  }
  return enumeratedOptions;
}

async function applyResolvedAnswer(
  root: ParentNode,
  entry: PreparedQuestion,
  approvedLabel: string,
  answer: { canonicalKey: string | null; typedAnswer: boolean | null }
): Promise<{ status: QuestionState; reason: string; displayed?: string; backing?: string; transaction?: TransactionResult }> {
  // Re-discover: the page may have re-rendered between asking and acting, and
  // an answer computed against a different option set must not be applied.
  const live = discoverQuestionFields(root).find(
    (candidate) => candidate.uid === entry.field.uid && candidate.frameId === entry.field.frameId
  );
  if (!live) return {
    status: "interaction_failed" as const,
    reason: "control_not_found",
    transaction: {
      ok: false,
      reason: "control_not_found",
      states: ["DISCOVERED", "RESOLVER_REQUESTED", "SEMANTICALLY_RESOLVED", "QUEUED_FOR_ACTUATION"],
      adapter: "custom_choice"
    }
  };
  if (resolutionIsStale(entry, live)) {
    return {
      status: "interaction_failed" as const,
      reason: "stale_resolution",
      transaction: {
        ok: false,
        reason: "stale_resolution",
        states: ["DISCOVERED", "RESOLVER_REQUESTED", "SEMANTICALLY_RESOLVED", "QUEUED_FOR_ACTUATION", "CONTROL_LOCATED"],
        adapter: live.element instanceof HTMLSelectElement ? "native_select" : "custom_choice"
      }
    };
  }

  const reacquire = (): DiscoveredField | null => {
    const candidates = discoverQuestionFields(root);
    const exact = candidates.find((candidate) =>
      candidate.uid === entry.field.uid && candidate.frameId === entry.field.frameId
    );
    if (exact) return exact;
    // React replacement gets a new WeakMap uid. Reacquire only when the stable
    // descriptor is unique; ambiguity is safer as CONTROL_NOT_FOUND.
    const descriptorMatches = candidates.filter((candidate) =>
      candidate.frameId === entry.field.frameId
      && candidate.normalizedLabel === entry.field.normalizedLabel
      && candidate.control === entry.field.control
      && candidate.name === entry.field.name
    );
    return descriptorMatches.length === 1 ? descriptorMatches[0] : null;
  };
  const result = live.uid.startsWith("tiktok:")
    ? await actuateTikTokLegalField(
        location.href,
        live.uid,
        approvedLabel,
        Boolean(answer.typedAnswer),
        root
      )
    : await selectApprovedOption(live, approvedLabel, answer, { reacquire });
  return result.ok
    ? { status: "filled_verified" as const, reason: "verified", displayed: result.displayed, backing: result.backing, transaction: result }
    : { status: "interaction_failed" as const, reason: result.reason, displayed: result.displayed, backing: result.backing, transaction: result };
}

// A repeated DOM mutation must never click the same navigation control twice.
// The signature contains no entered values or other PII.
const workdayNavigationKeys = new Set<string>();

async function advanceWorkdayWhenSafe(): Promise<boolean> {
  if (!outcome || !ledgerCounts || outcome.result.atsId !== "workday") return false;
  const context = { url: location.href, document };
  if (outcome.adapter.isReviewPage?.(context)) return false;
  // No navigation while anything on this or an earlier page remains unresolved.
  if (ledgerCounts.pending > 0 || ledgerCounts.requiredBlank > 0 || ledgerCounts.technical > 0) return false;
  const next = outcome.adapter.findNextControl?.(context);
  if (!next) return false;
  const label = (next.textContent || (next as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const key = `${scanSignature()}|${label}`;
  if (workdayNavigationKeys.has(key)) return false;
  workdayNavigationKeys.add(key);
  lastScanSignature = scanSignature();
  next.scrollIntoView({ block: "center" });
  next.click();
  await delay(250);
  return true;
}

// --------------------------------------------------------------------------- //
// Review widget: unresolved-question list, live fill + save-for-future.
// --------------------------------------------------------------------------- //
/** Build the review list from the DURABLE ledger (pure logic lives in review.ts),
 * refreshing the uid -> key/scope maps the save flow depends on. */
function buildReviewItems(entries: LedgerEntry[], activeSession: ApplicationSessionData): ReviewItem[] {
  const model = buildReviewModel(entries, activeSession);
  lastCanonicalKeyByUid.clear();
  lastScopeByUid.clear();
  for (const [uid, key] of model.keyByUid) lastCanonicalKeyByUid.set(uid, key);
  for (const [uid, scope] of model.scopeByUid) lastScopeByUid.set(uid, scope);
  return model.items;
}

const reviewHandlers: ReviewHandlers = {
  async onFill(id, value) {
    if (id === "name_confirm") {
      // first|middle|last|preferredFirst|preferredLast
      const [given, middleRaw, family, prefFirstRaw, prefLastRaw] = (Array.isArray(value) ? value.join("|") : value).split("|");
      if (!given || !family || !session) return false;
      const middle = (middleRaw || "").trim();
      const resp = (await sendRuntime({
        type: MSG.CONFIRM_NAME,
        sessionId: session.sessionId,
        firstName: given,
        middleName: middle,
        lastName: family,
        preferredFirstName: (prefFirstRaw || "").trim(),
        preferredLastName: (prefLastRaw || "").trim()
      })) as { ok?: boolean } | undefined;
      if (!resp?.ok) return false;
      // A blank preferred field is treated as "no distinct preferred name" — the
      // legal name is used, per the common "enter your legal name" instruction.
      const prefFirst = (prefFirstRaw || "").trim() || given;
      const prefLast = (prefLastRaw || "").trim() || family;
      const valueForKey: Partial<Record<string, string>> = {
        first_name: given,
        last_name: family,
        // Only a TRUE full-name field gets every part — never a last-name field.
        full_name: [given, middle, family].filter(Boolean).join(" "),
        preferred_first_name: prefFirst,
        preferred_last_name: prefLast,
        preferred_name: prefFirst
      };
      if (middle) valueForKey.middle_name = middle;
      // Apply immediately to whichever discovered fields the field mapper already
      // classified — the same classification used for automatic fill, no separate
      // DOM-guessing heuristic here.
      const nameFills: Promise<unknown>[] = [];
      const resolved = new Set<string>();
      for (const [uid, canonicalKey] of lastCanonicalKeyByUid) {
        const field = lastFields.get(uid);
        const v = valueForKey[canonicalKey];
        if (!field || v === undefined) continue;
        nameFills.push(fillField(field, v, { status: "verified", force: true }));
        resolved.add(uid);
      }
      await Promise.all(nameFills);
      for (const uid of resolved) markLedgerResolved(uid, "user");
      refreshLedgerCounts();
      return true;
    }
    const field = lastFields.get(id);
    if (!field) return false;
    const canonicalKey = lastCanonicalKeyByUid.get(id);
    let valueToFill: string | string[] = value;
    let searchValue: string | undefined;
    if (canonicalKey === "city" && typeof value === "string") {
      const savedLocation = session?.profileData?.location;
      if (
        typeof savedLocation === "string"
        && savedLocation.includes(",")
        && savedLocation.toLowerCase().startsWith(`${value.trim().toLowerCase()},`)
      ) {
        valueToFill = savedLocation;
      }
      searchValue = value.trim();
    } else if (canonicalKey === "phone_country" && typeof value === "string") {
      searchValue = value.replace(/\s*\(\s*\+\d{1,4}\s*\)\s*$/, "").trim();
    }
    // The user's own choice goes through the SAME dropdown adapter as automatic
    // fill — open, select, and verify against the real DOM. There is no
    // simplified widget path, so "it worked in the widget" always means the
    // employer control actually changed. The widget steps aside first so its
    // Shadow-DOM overlay can never intercept an option click (section L).
    const outcome = await fillField(field, valueToFill, {
      status: "verified",
      force: true,
      answerSource: "user_confirmed_saved",
      dropdownSearchValue: searchValue,
      dropdownMatchMode: canonicalKey === "education_end_year"
        ? "graduation_year"
        : canonicalKey === "education_gpa"
          ? "gpa"
          : undefined,
      beforeInteract: () => widget?.setInteractionMode(true),
      afterInteract: () => widget?.setInteractionMode(false)
    });
    const ok = outcome.status === "filled";
    if (ok) {
      markLedgerResolved(id, "user");
      refreshLedgerCounts();
    }
    return ok;
  },
  async onSave(id, value, displayValue) {
    if (!session) return false;
    // The field's canonical key travels via the id -> fieldResults lookup at
    // render time isn't available here, so the widget always calls onFill
    // first; find the canonical key from the currently-known field mapping.
    const canonicalKey = lastCanonicalKeyByUid.get(id);
    if (!canonicalKey) return false;
    const scope = lastScopeByUid.get(id) ?? "global";
    const resp = (await sendRuntime({
      type: MSG.SAVE_ANSWER,
      sessionId: session.sessionId,
      canonicalKey,
      value,
      displayValue,
      scope
    })) as { ok?: boolean } | undefined;
    return Boolean(resp?.ok);
  },
  onJumpToField(id) {
    // Re-resolve from the DOM rather than trusting a node captured when the
    // list was rendered: a React remount in between would leave that node
    // detached, and the user would click "jump" and see nothing move.
    const outcome = focusReviewTarget(id, (fieldKey) => {
      const direct = lastFields.get(fieldKey)?.element;
      if (direct?.isConnected) return direct;
      const live = discoverFields(formRoot?.root ?? document).find(
        (candidate) => `f_${candidate.frameId}_${candidate.uid}` === fieldKey || candidate.uid === fieldKey
      );
      return live?.element ?? null;
    });
    if (!outcome.ok) log.debug("jump to field failed", { reason: outcome.reason });
  }
};

// uid -> canonical key / default scope, refreshed each time review items are
// built, so onSave (which only receives the uid) knows what it's saving.
const lastCanonicalKeyByUid = new Map<string, string>();
const lastScopeByUid = new Map<string, "global" | "company">();

/** Mark a ledger entry resolved after the user answered it in the widget, so
 * counts + the "Mark complete" gate reflect the new state immediately without
 * waiting for the next rescan. */
function markLedgerResolved(uid: string, fillSource: string): void {
  const entry = ledger.find((e) => e.uid === uid);
  if (!entry) return;
  entry.status = "user_entered";
  entry.verified = true;
  entry.currentValuePresent = true;
  entry.fillSource = fillSource;
}

function refreshLedgerCounts(): void {
  ledgerCounts = computeCounts(ledger);
  widget?.refreshCounts(ledgerCounts);
}

/**
 * Turn on "Teach JobPilot": observe the user completing THIS application inside
 * the verified form root, and offer to remember each answer. Nothing is ever
 * persisted without the user picking a scope in the widget.
 */
function beginTeaching(): void {
  const root = formRoot?.root;
  if (!root || !widget) return;
  stopTeaching?.();
  stopTeaching = startTeachMode({
    root,
    fields: () => lastFields,
    ats: outcome?.result.atsId ?? null,
    employer: session?.company ?? null,
    canonicalKeyFor: (uid) => ledger.find((e) => e.uid === uid)?.canonicalKey ?? null,
    sensitiveFor: (uid) => Boolean(ledger.find((e) => e.uid === uid)?.sensitive),
    onRescanNeeded: () => { /* conditional fields are picked up by the observer */ },
    onLearned: (answer) => offerToRemember(answer)
  });
  log.info("teach mode enabled", { fields: lastFields.size });
}

function offerToRemember(answer: LearnedAnswer): void {
  widget?.askToRemember({
    id: answer.uid,
    question: answer.question || "This question",
    // A sensitive answer is never echoed back in the UI.
    chosenSummary: answer.sensitive ? "(your sensitive answer)" : answer.chosen.join(", "),
    employer: answer.employer,
    sensitive: answer.sensitive,
    proposedScope: answer.proposedScope,
    scopeConfident: answer.scopeConfident,
    onDecision: (scope) => void persistLearned(answer, scope)
  });
}

async function persistLearned(answer: LearnedAnswer, scope: LearnScope): Promise<void> {
  // "none" and "application" never leave the page: an application-only answer is
  // already typed into the form and has no reuse value.
  if (scope === "none" || scope === "application" || !session) return;
  await sendRuntime({
    type: MSG.SAVE_ANSWER,
    sessionId: session.sessionId,
    canonicalKey: answer.canonicalKey ?? answer.fingerprint,
    value: answer.chosen.join("|"),
    displayValue: answer.chosen.join(", "),
    scope: scope === "sensitive" ? "sensitive" : scope,
    companyKey: scope === "company" ? (answer.employer ?? "") : undefined
  });
  log.info("learned answer saved", { scope });
}

/** Development assertion (section C): a page with visible required blanks can
 * NEVER be reported ready. Logged loudly rather than thrown, so a bug surfaces
 * without breaking the user's application. */
function assertReadyStateConsistent(
  counts: LedgerCounts,
  readyForReview: boolean,
  finalVerification: FinalVerificationResult | null = null
): void {
  if (
    readyForReview
    && (counts.requiredBlank > 0 || !finalVerification?.canEnterReviewReady)
  ) {
    log.error("INVARIANT VIOLATED: ready reported with required blanks", {
      requiredBlank: counts.requiredBlank,
      discovered: counts.discovered,
      finalRescanCompleted: Boolean(finalVerification?.completed),
      requiredRemaining: finalVerification?.requiredRemaining ?? -1
    });
  }
}

/** Copy sanitized diagnostics to the clipboard (dev aid). Structure + labels
 * only — NEVER entered values, name, email, phone, resume text, or tokens. */
function copyDiagnostics(): void {
  const labelSources: Record<string, string> = {};
  for (const [uid, field] of lastFields) labelSources[uid] = field.labelSource;
  const text = buildDiagnostics({
    url: location.href,
    atsId: outcome?.result.atsId ?? null,
    ledger,
    counts: ledgerCounts,
    formRoot,
    labelSources,
    extensionVersion: chrome.runtime.getManifest?.().version,
    // Re-probe at copy time so the census reflects the page as it is NOW,
    // not as it was when the content script first loaded.
    frameProbe: (() => { try { return probeFrame(document); } catch { return null; } })(),
    build: { version: BUILD_INFO.version, builtAt: BUILD_INFO.builtAt, buildId: BUILD_INFO.buildId },
    // The first question to answer when a live page disagrees with a green test
    // suite: is every context the same build, and the same backend? Build ids
    // and environment CATEGORIES only — never a hostname or a token.
    runtime: lastHandshake
      ? handshakeSummary(lastHandshake, lastHandshakeVerdict ?? { ok: true, reason: "ok", message: "" })
      : null,
    // Registry + answer-contract versions the BACKEND reported, so a resolver
    // older than this client is visible.
    resolverContract: lastResolverContract,
    authenticatedUserId: session?.authenticatedUserId ?? null,
    atsLifecycle: activeAtsLifecycle?.trace() ?? [],
    reconciliation: lastReconciliation.map((item) => ({
      classification: item.classification,
      canonicalKey: item.canonicalKey,
      provenance: item.provenance
    })),
    repeatableSections: lastSectionTraces.map((item) => ({ ...item })),
    structuredCandidateCounts: {
      // Server-produced at session creation/refresh from structured database
      // records. Null on an older session snapshot makes that boundary visible.
      databaseProfileAtSessionCreation:
        session?.profileData?.structured_candidate_counts ?? null,
      apiSessionSnapshot:
        session?.profileData?.structured_candidate_counts ?? null,
      parsedExtensionState: session ? structuredCandidateCounts(session) : null,
      repeatableCandidateSelection: lastSectionTraces.reduce<Record<string, number>>(
        (counts, item) => {
          counts[item.sectionKind] = item.candidateRecordCount;
          return counts;
        },
        {}
      )
    },
    finalVerification: lastFinalVerification
      ? {
          completed: lastFinalVerification.completed,
          canEnterReviewReady: lastFinalVerification.canEnterReviewReady,
          requiredLiveControlCount: lastFinalVerification.requiredLiveControlCount,
          requiredVerified: lastFinalVerification.requiredVerified,
          requiredRemaining: lastFinalVerification.requiredRemaining,
          manualConsentActions: lastFinalVerification.manualConsentActions,
          technicalIssues: lastFinalVerification.technicalIssues,
          repeatableCandidatesTerminal: lastFinalVerification.repeatableCandidatesTerminal,
          applicationValidationErrors: lastFinalVerification.applicationValidationErrors,
          everyRequiredLiveControlHasLedgerEntry:
            lastFinalVerification.everyRequiredLiveControlHasLedgerEntry,
          everyKnownAnswerReachedTerminalState:
            lastFinalVerification.everyKnownAnswerReachedTerminalState,
          noStaleGenerationResults: lastFinalVerification.noStaleGenerationResults,
          controls: lastFinalVerification.controls.map((control) => ({
            fieldKey: control.fieldKey,
            fingerprint: control.fingerprint,
            domGeneration: control.domGeneration,
            canonicalKey: control.canonicalKey,
            controlType: control.controlType,
            required: control.required,
            requiredEvidence: control.requiredEvidence,
            consent: control.consent,
            ledgerEntryCount: control.ledgerEntryCount,
            questionLedgerPresent: control.questionLedgerPresent,
            resolverIncluded: control.resolverIncluded,
            actuatorQueued: control.actuatorQueued,
            actuatorReached: control.actuatorReached,
            knownAnswerAvailable: control.knownAnswerAvailable,
            verified: control.verified,
            failureCode: control.failureCode
          }))
        }
      : null,
    tiktokAdapter: lastTikTokAdapterTrace
      ? {
          ...lastTikTokAdapterTrace,
          transactions: Array.from(questionExecutionTraces.values())
            .filter((trace) => trace.fieldId.includes("tiktok:work_authorization:"))
            .map((trace) => ({
              fieldIdentity: trace.fieldId.replace(/^f_[^_]*_/, ""),
              canonicalKey: trace.canonicalKey,
              typedAnswer: trace.typedAnswer,
              displayAnswer: trace.displayAnswer,
              actuatorReached: Boolean(trace.actuatorReached),
              openStrategy: trace.openStrategy ?? null,
              listboxDiscovered: Boolean(trace.listboxFound),
              optionLabelsDiscovered: trace.discoveredLiveOptions ?? [],
              matchedOption: trace.matchedOption === "[present]",
              verificationSource: trace.verificationSource ?? null,
              finalDisplayedValue: trace.displayedValueAfterFill,
              finalBackingValue: trace.backingValueAfterFill,
              finalStatus: trace.verified ? "filled" : trace.reviewStatus ?? "technical_issue",
              failureCode: trace.failureCode
            }))
        }
      : null,
    // Where the destination handoff actually stopped. Origins, counts and
    // enums only — never a destination URL with its query string.
    destinationReadiness: lastDestinationReadiness,
    // Per-frame reachability: frame ids, url shapes, sandbox tokens, host
    // permission state and field counts. Origins only, never query strings.
    frameInspection: lastFrameInspection,
    // The authoritative ledger's own view: one stage, one set of totals, and the
    // low-cardinality reason code per question.
    authoritative: {
      stage: questionLedger.stage(),
      counts: { ...questionLedger.counts() },
      reasons: questionLedger.all().map((entry) => ({
        state: entry.state,
        reason: entry.reasonCode,
        canonical: entry.canonicalCategory,
        required: entry.required
      }))
    },
    questionTraces: Array.from(questionExecutionTraces.values()),
    // Sanitized handoff evidence: enums and booleans only, so the user can
    // paste a diagnosis without leaking tokens, addresses or answers.
    handoff: {
      handoffVersion: HANDOFF_IMPL_VERSION,
      navigationVersion: NAVIGATION_IMPL_VERSION,
      sessionPresent: session !== null,
      matched,
      reconnectAttempted,
      reconnectReason: lastReconnectReason,
      originCategory: location.origin === new URL(entryUrl).origin ? "entry_origin" : "navigated_origin",
      applicationLaunch: lastApplicationLaunchTrace
    }
  });
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable — the button is a best-effort dev aid */
  }
  log.info("diagnostics copied", { fields: ledger.length });
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function redactedStructure(node: HTMLElement, depth = 0): unknown {
  if (depth > 3) return { truncated: true };
  const classes = Array.from(node.classList).map((name) => `class_${shortHash(name)}`);
  return {
    tag: node.tagName.toLowerCase(),
    role: node.getAttribute("role"),
    classes,
    ariaExpanded: node.getAttribute("aria-expanded"),
    ariaControls: node.getAttribute("aria-controls"),
    ariaOwns: node.getAttribute("aria-owns"),
    ariaHaspopup: node.getAttribute("aria-haspopup"),
    tabindex: node.getAttribute("tabindex"),
    contenteditable: node.getAttribute("contenteditable"),
    children: Array.from(node.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .slice(0, 20)
      .map((child) => redactedStructure(child, depth + 1))
  };
}

/** Capture the real closed/open eligibility DOM without copying unrelated form data. */
function captureCurrentEligibilityControls(): void {
  const root = (formRoot?.root ?? document) as ParentNode;
  const eligibility = discoverFields(root).filter((field) => {
    const trace = questionExecutionTraces.get(fieldRef(field));
    return trace?.canonicalKey === "work_authorization_us"
      || trace?.canonicalKey === "sponsorship_required_now_or_future"
      || /authori[sz]ed to work|visa sponsorship|visa transfer/i.test(
        `${field.label} ${field.ariaLabel} ${field.sectionHeading}`
      );
  });
  // Menus are collected WITHOUT requiring an ARIA role.
  //
  // A capture whose only job is to explain "why was the open menu not usable?"
  // must not use the same assumption that failed. A widget can render a live
  // Yes/No menu with no `role="listbox"` anywhere on it, and the previous query
  // reported "portaledListboxes: []" — i.e. exactly nothing — on a screen that
  // visibly had one open.
  const visible = (node: HTMLElement): boolean => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && (box.width > 0 || box.height > 0);
  };
  const roleMenus = deepQueryAll<HTMLElement>(document, '[role="listbox"],[role="menu"]').filter(visible);
  // Anything a discovered control explicitly says it controls, role or not.
  const ownedMenus = eligibility.flatMap((field) => {
    const element = field.element;
    if (!element) return [];
    const ids = [element.getAttribute("aria-controls"), element.getAttribute("aria-owns")]
      .flatMap((value) => (value ?? "").split(/\s+/))
      .filter(Boolean);
    return ids
      .map((id) => scopedElementById(element, id))
      .filter((node): node is HTMLElement => Boolean(node) && visible(node!));
  });
  const listboxes = Array.from(new Set([...roleMenus, ...ownedMenus]));
  const controls = eligibility.map((field) => {
    const element = field.element!;
    const rect = element.getBoundingClientRect();
    const trace = questionExecutionTraces.get(fieldRef(field)) ?? null;
    const labelledbyIds = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const hidden = (element.closest("fieldset,[data-jobpilot-control]") ?? element.parentElement)
      ?.querySelectorAll<HTMLInputElement>('input[type="hidden"]') ?? [];
    return {
      fieldFingerprint: descriptorTrace(field).descriptorFingerprint,
      frameId: field.frameId,
      questionText: field.label,
      visibleLabel: field.label,
      accessibleName: field.ariaLabel,
      associatedLabel: descriptorTrace(field).associatedLabelText ?? "",
      ariaLabel: element.getAttribute("aria-label"),
      ariaLabelledbyIds: labelledbyIds,
      ariaLabelledbyText: labelledbyIds.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\s+/g, " ").trim(),
      nearbySectionHeading: field.sectionHeading,
      element: {
        tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), id: element.id,
        name: field.name, classes: Array.from(element.classList).map((name) => `class_${shortHash(name)}`)
      },
      parentControlSubtree: redactedStructure(element.parentElement ?? element),
      boundingRectangle: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      disabled: field.disabled,
      readOnly: "readOnly" in element ? Boolean((element as HTMLInputElement).readOnly) : false,
      ariaExpanded: element.getAttribute("aria-expanded"),
      ariaControls: element.getAttribute("aria-controls"),
      ariaHaspopup: element.getAttribute("aria-haspopup"),
      tabindex: element.getAttribute("tabindex"),
      contenteditable: element.getAttribute("contenteditable"),
      displayedText: displayedValueForCapture(element),
      backingValue: field.existingValue ? "[present]" : "[empty]",
      hiddenInputRelations: Array.from(hidden).map((input) => ({ name: input.name, id: input.id, value: input.value ? "[present]" : "[empty]" })),
      reactControlledIndicators: {
        reactRootAncestor: Boolean(element.closest("[data-reactroot]")),
        valueTracker: Object.prototype.hasOwnProperty.call(element, "_valueTracker")
      },
      currentlyRenderedOptions: field.options,
      shadowRootPresent: Boolean(element.shadowRoot),
      frameOwnership: window.top === window ? "top" : "iframe",
      descriptorSentToApi: buildQuestionBatch([field], "en-US", enumeratedOptions)[0]?.question ?? null,
      redactedApiResponse: trace,
      reviewItem: questionLedger.get(fieldRef(field)) ?? null,
      actuatorInvoked: Boolean(trace?.actuatorReached)
    };
  });
  const snapshot = {
    generatedAt: new Date().toISOString(),
    page: { origin: location.origin, path: location.pathname },
    run: activeResolutionRun,
    applicationSessionId: session?.sessionId ?? null,
    profileRevision: session?.profileRevision ?? null,
    controls,
    portaledListboxes: listboxes.map((node) => {
      const declared = Array.from(node.querySelectorAll<HTMLElement>('[role="option"],[role="menuitem"],li,[data-option]'));
      // When the menu declares no options either, report its own children —
      // that is what the selection code now treats as the option list, so the
      // capture and the behaviour describe the same thing.
      const children = Array.from(node.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement && (child.textContent ?? "").trim().length > 0);
      const source = declared.length > 0 ? declared : children;
      return {
        id: node.id,
        role: node.getAttribute("role"),
        optionSource: declared.length > 0 ? "declared_option_role" : "menu_children",
        structure: redactedStructure(node),
        options: source
          .map((option) => (option.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
      };
    })
  };
  try { void navigator.clipboard?.writeText(JSON.stringify(snapshot, null, 2)); } catch { /* best effort */ }
  log.info("eligibility control capture copied", { controls: controls.length, listboxes: listboxes.length });
}

function displayedValueForCapture(element: HTMLElement): string {
  if (element instanceof HTMLSelectElement) return element.selectedOptions[0]?.textContent?.trim() ?? "";
  if (element instanceof HTMLInputElement) return element.value ? "[present]" : "[empty]";
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

async function fetchDocument(kind: "resume" | "cover-letter"): Promise<File | null> {
  if (!session) return null;
  const resp = (await sendRuntime({ type: MSG.REQUEST_DOCUMENT, sessionId: session.sessionId, kind })) as
    | { ok: boolean; dataUrl?: string; filename?: string }
    | undefined;
  if (!resp?.ok || !resp.dataUrl) return null;
  const res = await fetch(resp.dataUrl);
  const blob = await res.blob();
  return new File([blob], resp.filename ?? `${kind}.pdf`, { type: blob.type || "application/pdf" });
}

// --------------------------------------------------------------------------- //
// Multi-step / SPA: re-scan on debounced DOM changes without duplicating fills.
// --------------------------------------------------------------------------- //
let debounce: ReturnType<typeof setTimeout> | null = null;
function observeMutations(): void {
  // A Workday application can legitimately take several minutes across its
  // account, profile, experience, disclosures, and review pages.
  const stopAt = Date.now() + 5 * 60_000;
  const observer = new MutationObserver(() => {
    if (!isCurrentInstance()) { observer.disconnect(); return; }
    if (Date.now() > stopAt) { observer.disconnect(); return; }
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      // Continue filling any newly rendered fields. The fill engine skips fields
      // already filled or edited by the user, so this never duplicates values.
      if (session && !running && started && !automaticRunSettled && scanSignature() !== lastScanSignature) {
        void discoverAndFill("continue_after_navigation");
      }
      else emitProgressOnly();
    }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 5 * 60_000);
}

function emitProgressOnly(): void {
  if (!isCurrentInstance() || !outcome) return;
  const submit = outcome.adapter.findSubmitControl({ url: location.href, document });
  const progress: ProgressPayload = {
    state: session ? "detecting_ats" : "waiting_for_content_script",
    atsId: outcome.result.atsId,
    atsDisplayName: outcome.adapter.displayName,
    limited: outcome.limited,
    fieldsDiscovered: 0,
    filled: 0,
    skipped: 0,
    reviewRequired: 0,
    reachedFinalStep: submit !== null,
    documentsUploaded: [],
    reviewDocuments: []
  };
  void sendRuntime({ type: MSG.AUTOFILL_PROGRESS, payload: progress });
}

function currentStep(): number {
  const text = document.body.textContent || "";
  const match = text.match(/step\s+(\d+)\s+of\s+\d+/i);
  return match ? Number(match[1]) : 0;
}

function sendRuntime(message: object): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
function scanSignature(): string {
  const controls = document.querySelectorAll("input:not([type=hidden]),textarea,select,[contenteditable=true]");
  const step = document.querySelector('[aria-current="step"], [data-automation-id*="progressBarActive" i]')?.textContent || "";
  const heading = Array.from(document.querySelectorAll("h1,h2,[role=heading]"))
    .map((item) => (item.textContent || "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("|");
  const identities = Array.from(controls)
    .slice(0, 40)
    .map((item) => [item.getAttribute("name"), item.id, item.getAttribute("aria-label")].filter(Boolean).join(":"))
    .join("|");
  return `${location.href.split("#")[0]}|${controls.length}|${step.trim()}|${heading}|${identities}`;
}
