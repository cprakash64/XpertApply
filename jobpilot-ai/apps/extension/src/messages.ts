/**
 * Single source of truth for every message exchanged between the web page, the
 * XpertApply-origin content script, the employer-page content script, the
 * background service worker, and the side panel.
 *
 * There are two transports:
 *   • window.postMessage — page ⇆ XpertApply-origin content script (detection +
 *     staging the launch payload; a token is staged into the isolated content
 *     world and never left in the DOM).
 *   • chrome.runtime messaging — content/side panel ⇆ background.
 *
 * No raw message-type strings are duplicated elsewhere: everything imports the
 * `MSG` constants and the typed unions below, and `parseRuntimeMessage` /
 * `parsePageMessage` validate at runtime and reject unknown messages.
 */

import type { ApplicationSessionData } from "./types";

/** Bumped when the web⇆extension contract changes incompatibly. */
export const PROTOCOL_VERSION = 3;

// --------------------------------------------------------------------------- //
// Canonical launch state machine
// --------------------------------------------------------------------------- //
export type LaunchState =
  | "idle"
  | "preparing"
  | "package_ready"
  | "opening_tab"
  | "waiting_for_tab"
  | "waiting_for_content_script"
  | "fetching_package"
  | "detecting_ats"
  | "discovering_fields"
  | "filling"
  | "completed"
  | "completed_with_review"
  | "failed";

/** Why an autofill run was started — both paths call one canonical runner. */
export type AutofillReason = "automatic_launch" | "manual_retry" | "continue_after_navigation";

// --------------------------------------------------------------------------- //
// Field-level result model (Phase 12)
// --------------------------------------------------------------------------- //
export type FieldFillStatus =
  | "filled"
  | "already_filled"
  | "skipped"
  | "review"
  | "not_found"
  | "failed";

export type ReasonCode =
  | "NO_VERIFIED_ANSWER"
  | "LOW_CONFIDENCE"
  | "USER_VALUE_PRESENT"
  | "UNSUPPORTED_CONTROL"
  | "HIDDEN_FIELD"
  | "DISABLED_FIELD"
  | "SENSITIVE_FIELD"
  | "DOCUMENT_DOWNLOAD_FAILED"
  | "DOCUMENT_UPLOAD_REJECTED"
  | "VALUE_DID_NOT_STICK"
  | "ADAPTER_NOT_DETECTED"
  | "TOKEN_CONSUMED"
  // Diagnostics for the broad-domain handoff-gated injection model. Never carry
  // PII — these are structural/permission states only.
  | "HOST_PERMISSION_MISSING"
  | "CONTENT_SCRIPT_NOT_INJECTED"
  | "HANDOFF_URL_MISMATCH"
  | "NO_MATCHING_FRAME"
  | "FORM_NOT_RENDERED"
  | "NO_FIELDS_DISCOVERED"
  | "FILE_UPLOAD_FAILED"
  // Dropdown adapter outcomes (exact, per section N).
  | "DROPDOWN_NOT_VISIBLE"
  | "DROPDOWN_DISABLED"
  | "DROPDOWN_OPEN_FAILED"
  | "LISTBOX_NOT_FOUND"
  | "OPTIONS_NOT_FOUND"
  | "OPTION_NOT_AVAILABLE"
  | "DROPDOWN_SELECTION_FAILED"
  | "DROPDOWN_VERIFICATION_FAILED"
  // Handshake + handoff-lifecycle diagnostics (web bridge, stale storage).
  | "BRIDGE_NOT_READY"
  | "PROTOCOL_VERSION_MISMATCH"
  | "BACKGROUND_UNAVAILABLE"
  | "HANDOFF_NOT_FOUND"
  | "HANDOFF_EXPIRED"
  | "HANDOFF_SCHEMA_OUTDATED"
  | "SESSION_UNAUTHORIZED"
  | "SESSION_NOT_FOUND"
  | "SESSION_PACKAGE_FAILED";

export interface FieldFillResult {
  /** DiscoveredField.uid for this scan — lets the review widget look the live
   * element back up to apply a manual answer immediately. Absent for
   * synthetic entries (e.g. document uploads) that have no single field. */
  uid?: string;
  fieldKey: string;
  question: string;
  status: FieldFillStatus;
  reasonCode?: ReasonCode;
  confidence: number;
  /** Required vs optional, for the review widget's grouping/badges. */
  required?: boolean;
  /** Discovered option labels (select/radio/combobox) for the review widget
   * to offer as a picker instead of free text — never guessed, only what the
   * ATS page actually renders. */
  options?: string[];
  control?: string;
  /** Whether this canonical key is reusable across future applications (and
   * whether it defaults to "company" scope) — drives the widget's "Save for
   * future applications" option. Absent for unmapped/custom questions. */
  reusable?: boolean;
  defaultScope?: "global" | "company";
}

/** Safe, PII-free summary reported back to XpertApply. Counts + codes only. */
export type AutofillResult = {
  status: "completed" | "completed_with_review" | "partial" | "no_fields" | "failed" | "cancelled";
  ats: string | null;
  fields_discovered: number;
  fields_filled: number;
  documents_uploaded: ("resume" | "cover_letter")[];
  review_items: number;
  failures: { field_key: string; reason_code: string }[];
};

// --------------------------------------------------------------------------- //
// PendingLaunch — the prepared session bound to one exact employer tab
// --------------------------------------------------------------------------- //
export interface PendingLaunch {
  version: 1;
  applicationId: string;
  jobId: string;
  applicationUrl: string;
  status: "prepared" | "opening" | "detecting" | "filling" | "review_required" | "ready" | "failed";
  handoffToken: string;
  requestId: string;
  sessionId: number;
  launchToken: string;
  officialUrl: string;
  expectedOrigin: string;
  createdAt: number;
  expiresAt: number;
  targetTabId?: number;
  state: LaunchState;
  protocolVersion: number;
  atsType: string | null;
  /** Last actionable failure reason for the side panel (safe code, not PII). */
  failureCode?: ReasonCode | string;
  lastError?: { code: string; message: string; recoverable: boolean };
}

/** The launch payload the web app hands over (staged, then requested on click). */
export type LaunchPayload = {
  requestId: string;
  launchToken: string;
  sessionId: number;
  jobId: number;
  officialUrl: string;
  atsType: string | null;
  webApiBase?: string;
  webAuthenticatedUserId?: number | null;
};

/** State the side panel renders — persisted in chrome.storage.session per tab. */
export interface LaunchViewState {
  tabId: number;
  requestId: string;
  sessionId: number | null;
  state: LaunchState;
  company: string | null;
  jobTitle: string | null;
  atsId: string | null;
  atsDisplayName: string | null;
  limited: boolean;
  fieldsDiscovered: number;
  filled: number;
  skipped: number;
  reviewRequired: number;
  resumeStatus: "pending" | "uploaded" | "review" | "unavailable" | "—";
  coverStatus: "pending" | "uploaded" | "review" | "unavailable" | "—";
  reachedFinalStep: boolean;
  contentReady: boolean;
  packageLoaded: boolean;
  running: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  /** false for a terminal failure (expired/consumed handoff, URL mismatch) —
   * the UI must not offer a Retry that will just repeat the same failure. */
  failureRecoverable: boolean | null;
  updatedAt: number;
}

// --------------------------------------------------------------------------- //
// Message-type constants (never inline a raw string anywhere else)
//
// The `JOBPILOT_` prefix is the WIRE FORMAT, not branding, and is frozen. These
// strings are matched literally by the web app (apps/web/lib/autoApply.ts) and
// by every already-installed copy of this extension. Because the two update on
// completely independent schedules — a deploy versus Chrome's own update cycle
// — a rename does not switch both sides over at once: it makes them stop
// recognising each other, and assisted apply quietly stops working for anyone
// running the older half. Rebranding these buys nothing a user can see.
// --------------------------------------------------------------------------- //
export const MSG = {
  // page ⇆ XpertApply-origin content script (postMessage)
  PING: "JOBPILOT_PING",
  PONG: "JOBPILOT_PONG",
  STAGE_LAUNCH: "JOBPILOT_STAGE_LAUNCH",
  START_ASSISTED_APPLY: "JOBPILOT_START_ASSISTED_APPLY",
  START_ASSISTED_APPLY_RESULT: "JOBPILOT_START_ASSISTED_APPLY_RESULT",
  HANDSHAKE: "JOBPILOT_HANDSHAKE",
  // XpertApply-origin content script → background (runtime)
  LAUNCH_REQUEST: "JOBPILOT_LAUNCH_REQUEST",
  LAUNCH_ACCEPTED: "JOBPILOT_LAUNCH_ACCEPTED",
  LAUNCH_FAILED: "JOBPILOT_LAUNCH_FAILED",
  // employer content script ⇆ background (runtime)
  CONTENT_READY: "JOBPILOT_CONTENT_READY",
  GET_PENDING_LAUNCH: "JOBPILOT_GET_PENDING_LAUNCH",
  PING_CONTENT: "JOBPILOT_PING_CONTENT",
  PONG_CONTENT: "JOBPILOT_PONG_CONTENT",
  AUTOFILL_START: "JOBPILOT_AUTOFILL_START",
  AUTOFILL_PROGRESS: "JOBPILOT_AUTOFILL_PROGRESS",
  AUTOFILL_RESULT: "JOBPILOT_AUTOFILL_RESULT",
  AUTOFILL_FAILED: "JOBPILOT_AUTOFILL_FAILED",
  REQUEST_DOCUMENT: "JOBPILOT_REQUEST_DOCUMENT",
  AUDIT_EVENT: "JOBPILOT_AUDIT_EVENT",
  // side panel → background (runtime)
  START_AUTOFILL: "JOBPILOT_START_AUTOFILL",
  CLEAR_SESSION: "JOBPILOT_CLEAR_SESSION",
  COMPLETE_SESSION: "JOBPILOT_COMPLETE_SESSION",
  /** Content script asks the service worker to navigate to a validated
   * application destination. The content script never touches chrome.tabs. */
  ACTIVATE_APPLICATION_DESTINATION: "JOBPILOT_ACTIVATE_APPLICATION_DESTINATION",
  /** Persist the application launch before any CTA interaction. This covers
   * script-driven, same-tab, popup and user-assisted clicks whose destination
   * is not available in the DOM ahead of time. */
  PREPARE_APPLICATION_LAUNCH: "JOBPILOT_PREPARE_APPLICATION_LAUNCH",
  /** Destination page lost its binding and asks the worker to re-establish it.
   * Carries only safe browser context; the worker derives tab, session and job. */
  RECONNECT_APPLICATION_WORKFLOW: "JOBPILOT_RECONNECT_APPLICATION_WORKFLOW",
  /** Content script asks the worker to resolve a batch of employer questions.
   * The worker holds the session token; the page never sees it. */
  RESOLVE_QUESTIONS: "JOBPILOT_RESOLVE_QUESTIONS",
  /** Which build the service worker is, and which backend it would talk to.
   * Asked BEFORE autofill: a content script talking to a worker from a
   * different build is the most common reason a live page disagrees with a
   * green test suite, and it must stop the run rather than produce nonsense. */
  RUNTIME_IDENTITY: "JOBPILOT_RUNTIME_IDENTITY",
  GET_VIEW_STATE: "JOBPILOT_GET_VIEW_STATE",
  // review widget → background → API (runtime)
  SAVE_ANSWER: "JOBPILOT_SAVE_ANSWER",
  /** The user answered one question for THIS application only. Carries the
   * canonical key and the boolean they picked — never provenance, which the
   * server derives from the authenticated session. */
  SET_APPLICATION_OVERRIDE: "JOBPILOT_SET_APPLICATION_OVERRIDE",
  /** Recover which questions were already answered for this application, so a
   * reinjected content script does not depend on in-memory state. */
  GET_APPLICATION_OVERRIDES: "JOBPILOT_GET_APPLICATION_OVERRIDES",
  CONFIRM_NAME: "JOBPILOT_CONFIRM_NAME",
  // employer content script → background → API (runtime). Sent ONLY when the
  // ATS itself confirmed the submission; see ats/submissionEvidence.ts.
  SUBMISSION_CONFIRMED: "JOBPILOT_SUBMISSION_CONFIRMED",
  /** The extension could not prove the submission — the web app must ask. */
  MANUAL_CONFIRMATION_REQUIRED: "JOBPILOT_MANUAL_CONFIRMATION_REQUIRED",
  /** The employer is asking the user to sign in. Autofill pauses; the
   * application session stays valid across the detour. */
  EMPLOYER_AUTH_REQUIRED: "JOBPILOT_EMPLOYER_AUTH_REQUIRED",
  /** The application is in an iframe this frame cannot read. Ask the worker
   * for the REAL frame picture: frame ids, url shapes, content-script
   * reachability and host-permission state. Replaces a bare "not allowed". */
  INSPECT_APPLICATION_FRAMES: "JOBPILOT_INSPECT_APPLICATION_FRAMES",
  /** Ask, inside a user gesture, for host permission covering one exact frame
   * origin. Never `<all_urls>`, never a wildcard the user did not see. */
  REQUEST_FRAME_PERMISSION: "JOBPILOT_REQUEST_FRAME_PERMISSION",
  /** Sent BY the worker INTO one frame (by frameId) to ask what it can see.
   * Answered by every content-script instance, top or nested. */
  PROBE_FRAME_APPLICATION: "JOBPILOT_PROBE_FRAME_APPLICATION",
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

// --------------------------------------------------------------------------- //
// Runtime (chrome.runtime) message union
// --------------------------------------------------------------------------- //
export type ProgressPayload = {
  tabId?: number;
  state: LaunchState;
  atsId: string | null;
  atsDisplayName: string | null;
  limited: boolean;
  fieldsDiscovered: number;
  filled: number;
  skipped: number;
  reviewRequired: number;
  reachedFinalStep: boolean;
  documentsUploaded: ("resume" | "cover_letter")[];
  reviewDocuments: ("resume" | "cover_letter")[];
};

export type RuntimeMessage =
  | { type: typeof MSG.LAUNCH_REQUEST; payload: LaunchPayload }
  | { type: typeof MSG.HANDSHAKE; origin: string; apiBase?: string; protocolVersion: number }
  | { type: typeof MSG.STAGE_LAUNCH; payload: LaunchPayload }
  | {
      type: typeof MSG.CONTENT_READY;
      url: string;
      title: string;
      protocolVersion: number;
      isTopFrame: boolean;
      topUrl: string | null;
      detectedAts: string | null;
      /** Sanitized per-frame application evidence (counts/scores only — see
       * frames/probe.ts). Lets the background rank frames against each other
       * instead of letting the top frame speak for the whole tab. */
      probe?: {
        isTopFrame: boolean;
        sanitizedUrl: string;
        rootConfident: boolean;
        applicationLabelsFound: string[];
        bestScore: number;
      };
    }
  | { type: typeof MSG.GET_PENDING_LAUNCH; url: string }
  | { type: typeof MSG.PING_CONTENT }
  | { type: typeof MSG.PONG_CONTENT; url: string }
  | { type: typeof MSG.AUTOFILL_START; reason: AutofillReason }
  | { type: typeof MSG.AUTOFILL_PROGRESS; payload: ProgressPayload }
  | { type: typeof MSG.AUTOFILL_RESULT; sessionId: number; result: AutofillResult; progress: ProgressPayload }
  | { type: typeof MSG.AUTOFILL_FAILED; reasonCode: ReasonCode | string; message?: string }
  | { type: typeof MSG.REQUEST_DOCUMENT; sessionId: number; kind: "resume" | "cover-letter" }
  | { type: typeof MSG.AUDIT_EVENT; sessionId: number; action_type: string; field_key?: string; status?: string }
  | { type: typeof MSG.START_AUTOFILL; tabId?: number; reason: AutofillReason }
  | { type: typeof MSG.CLEAR_SESSION; tabId?: number }
  | { type: typeof MSG.COMPLETE_SESSION; sessionId: number }
  | {
      type: typeof MSG.RESOLVE_QUESTIONS;
      sessionId: number;
      questions: unknown[];
    }
  | {
      type: typeof MSG.RECONNECT_APPLICATION_WORKFLOW;
      /** Current page origin, so the worker can validate the transition. The
       * worker derives tab id from the sender; the page never supplies it. */
      origin: string;
      /** Build/handoff version, for diagnosing a stale content script. */
      handoffVersion: string;
    }
  | {
      type: typeof MSG.PREPARE_APPLICATION_LAUNCH;
      sessionId: number;
      sourceUrl: string;
      normalizedCtaText: string;
      confidence: number;
      href: string | null;
      target: string | null;
      expectedDestinationOrigin: string | null;
      jobFingerprint: string;
    }
  | {
      type: typeof MSG.ACTIVATE_APPLICATION_DESTINATION;
      sessionId: number;
      /** Absolute https URL, already validated by ats/applyDestination. */
      url: string;
      /** The markup asked for a new tab (target="_blank"). */
      newTab: boolean;
      /** Where the URL came from, for the audit trail. */
      source: string;
    }
  | { type: typeof MSG.GET_VIEW_STATE; tabId?: number }
  | {
      type: typeof MSG.SAVE_ANSWER;
      sessionId: number;
      canonicalKey: string;
      value: string;
      displayValue?: string;
      scope?: "global" | "company" | "application" | "sensitive";
      companyKey?: string;
    }
  | {
      /**
       * An answer for one application. The payload is exhaustively listed here
       * on purpose: adding a provenance field would require editing this type,
       * and `validateOverrideRequest` rejects one at runtime regardless.
       */
      type: typeof MSG.SET_APPLICATION_OVERRIDE;
      sessionId: number;
      /** A canonical key the resolver returned; validated against the
       * answerable set on both sides of this message. */
      canonicalKey: string;
      /** The explicit choice. Never optional, never a string. */
      value: boolean;
    }
  | {
      type: typeof MSG.GET_APPLICATION_OVERRIDES;
      sessionId: number;
    }
  | {
      /** No payload: the worker answers about ITSELF. A content script that
       * could describe the worker would defeat the point of asking. */
      type: typeof MSG.RUNTIME_IDENTITY;
    }
  | {
      type: typeof MSG.CONFIRM_NAME;
      sessionId: number;
      firstName: string;
      lastName: string;
      middleName?: string;
      preferredFirstName?: string;
      preferredLastName?: string;
    }
  | {
      type: typeof MSG.SUBMISSION_CONFIRMED;
      sessionId: number;
      /** Closed vocabulary — the server re-validates it and rejects anything else. */
      evidenceType: "success_page" | "success_response" | "success_message";
      submissionTimestamp: string;
      submissionReference: string | null;
      ats: string | null;
    }
  | {
      type: typeof MSG.MANUAL_CONFIRMATION_REQUIRED;
      sessionId: number;
      /** Machine reason code from evaluateSubmissionEvidence. Never free text. */
      reason: string;
    }
  | {
      type: typeof MSG.EMPLOYER_AUTH_REQUIRED;
      sessionId: number;
      /** Whether the user's email was prefilled. NEVER the email itself, and
       * never anything resembling a credential. */
      emailPrefilled: boolean;
    }
  | {
      type: typeof MSG.INSPECT_APPLICATION_FRAMES;
      /** Parent-observable evidence about this document's iframes. Origins,
       * redacted path shapes, sandbox tokens and counts only. */
      observed: ObservedFramePayload[];
    }
  | {
      type: typeof MSG.REQUEST_FRAME_PERMISSION;
      /** One exact origin. The worker re-derives the pattern and refuses
       * anything broader than `<origin>/*`. */
      origin: string;
    }
  | { type: typeof MSG.PROBE_FRAME_APPLICATION };

/** Mirrors frames/frameInventory.ts ObservedFrame; declared here so the message
 * contract does not depend on the DOM-side module. */
export type ObservedFramePayload = {
  frameIndex: number;
  origin: string | null;
  pathShape: string | null;
  urlKind: string;
  srcObservable: boolean;
  sandboxTokens: string[];
  sandboxed: boolean;
  opaqueOrigin: boolean;
  sameOriginReadable: boolean;
  readableFieldCount: number;
};

const RUNTIME_TYPES = new Set<string>([
  MSG.LAUNCH_REQUEST, MSG.HANDSHAKE, MSG.STAGE_LAUNCH, MSG.CONTENT_READY, MSG.GET_PENDING_LAUNCH, MSG.PING_CONTENT, MSG.PONG_CONTENT,
  MSG.AUTOFILL_START, MSG.AUTOFILL_PROGRESS, MSG.AUTOFILL_RESULT, MSG.AUTOFILL_FAILED,
  MSG.REQUEST_DOCUMENT, MSG.AUDIT_EVENT, MSG.START_AUTOFILL, MSG.CLEAR_SESSION,
  MSG.COMPLETE_SESSION, MSG.PREPARE_APPLICATION_LAUNCH, MSG.ACTIVATE_APPLICATION_DESTINATION, MSG.RECONNECT_APPLICATION_WORKFLOW, MSG.RESOLVE_QUESTIONS, MSG.GET_VIEW_STATE, MSG.SAVE_ANSWER, MSG.CONFIRM_NAME,
  MSG.SET_APPLICATION_OVERRIDE, MSG.GET_APPLICATION_OVERRIDES, MSG.RUNTIME_IDENTITY,
  MSG.SUBMISSION_CONFIRMED, MSG.MANUAL_CONFIRMATION_REQUIRED, MSG.EMPLOYER_AUTH_REQUIRED,
  MSG.INSPECT_APPLICATION_FRAMES, MSG.REQUEST_FRAME_PERMISSION, MSG.PROBE_FRAME_APPLICATION
]);

/** Validate an inbound runtime message; returns null for anything unknown. */
export function parseRuntimeMessage(raw: unknown): RuntimeMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string" || !RUNTIME_TYPES.has(type)) return null;
  return raw as RuntimeMessage;
}

// --------------------------------------------------------------------------- //
// Page (window.postMessage) message union
// --------------------------------------------------------------------------- //
export const PAGE_SOURCE_WEB = "jobpilot-web";
export const PAGE_SOURCE_EXT = "jobpilot-extension";

export type Capability = "fill" | "upload" | "results" | "ashby" | "greenhouse" | "lever" | "workday" | "generic";

export type ExtensionInfo = {
  installed: true;
  version: string;
  protocolVersion: number;
  capabilities: Capability[];
};

export type PageMessage =
  | { source: typeof PAGE_SOURCE_WEB; type: typeof MSG.PING; apiBase?: string }
  | { source: typeof PAGE_SOURCE_WEB; type: typeof MSG.STAGE_LAUNCH; payload: LaunchPayload }
  | { source: typeof PAGE_SOURCE_WEB; type: typeof MSG.START_ASSISTED_APPLY; payload: LaunchPayload }
  | { source: typeof PAGE_SOURCE_EXT; type: typeof MSG.START_ASSISTED_APPLY_RESULT; requestId: string; result: { ok: boolean; applicationId?: string; tabId?: number; code?: string; message?: string } }
  | { source: typeof PAGE_SOURCE_EXT; type: typeof MSG.PONG; info: ExtensionInfo };

export function parsePageMessage(raw: unknown): PageMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as { source?: unknown; type?: unknown };
  if (data.source !== PAGE_SOURCE_WEB && data.source !== PAGE_SOURCE_EXT) return null;
  if (data.type !== MSG.PING && data.type !== MSG.STAGE_LAUNCH && data.type !== MSG.START_ASSISTED_APPLY && data.type !== MSG.START_ASSISTED_APPLY_RESULT && data.type !== MSG.PONG) return null;
  return raw as PageMessage;
}

// Re-exported so existing imports of the session type keep working.
export type { ApplicationSessionData };
