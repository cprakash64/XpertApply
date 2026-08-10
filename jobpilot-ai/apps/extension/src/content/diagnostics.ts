/**
 * Development-only "Copy diagnostics": a sanitized snapshot of the field ledger
 * so an unsupported application page can be debugged WITHOUT screenshots and,
 * critically, without leaking any personal data.
 *
 * Included: page origin/path (no query/token), detected ATS, field labels,
 * control types, canonical keys, required flags, option labels, statuses,
 * reason codes, frame ids, and the derived counts.
 *
 * NEVER included: entered values, the user's name/email/phone, resume contents,
 * tokens, or any saved profile answer. `fillSource` is coarse (e.g. "profile"),
 * never a value.
 */

import { dropdownEventLog } from "../fields/dropdown";
import { RESOLVER_VERSION, type FormRootResult } from "../ats/formRoot";
import type { LedgerCounts, LedgerEntry } from "../fields/ledger";
import type { FrameProbe } from "../frames/probe";

/** Sanitized handoff evidence: enums and booleans only — never tokens, URLs
 * with queries, addresses, answers or document contents. */
export interface HandoffDiagnostics {
  handoffVersion: string;
  navigationVersion: string;
  sessionPresent: boolean;
  matched: boolean;
  reconnectAttempted: boolean;
  reconnectReason: string;
  originCategory: string;
  applicationLaunch?: Record<string, unknown> | null;
}

export interface DiagnosticsInput {
  handoff?: HandoffDiagnostics;
  url: string;
  atsId: string | null;
  ledger: LedgerEntry[];
  counts: LedgerCounts | null;
  /** The scored application-root resolution for this page (section A/I). */
  formRoot?: FormRootResult | null;
  /** Per-field label provenance: uid -> which wrapper rule produced the label. */
  labelSources?: Record<string, string>;
  extensionVersion?: string;
  /** This frame's sanitized application census (counts/scores only). */
  frameProbe?: FrameProbe | null;
  /** Build identity, so a stale loaded extension is immediately obvious. */
  build?: { version: string; builtAt: string; buildId: string };
  /** Per-context build ids and environment categories from the runtime
   * handshake. Categories, never hostnames. */
  runtime?: Record<string, string> | null;
  /** Registry + answer-contract versions as reported by the BACKEND, so a
   * resolver older than this client is visible rather than mysterious. */
  resolverContract?: {
    requestSchemaVersion: number;
    registryVersion: string;
    answerContractVersion: number;
  } | null;
  /** Account/session boundary only; no email or profile fields. */
  authenticatedUserId?: number | null;
  /** The authoritative ledger's own stage, totals and per-question reason
   * codes. Enums and counts only — no question text, no answer. */
  authoritative?: {
    stage: string;
    counts: Record<string, number>;
    reasons: { state: string; reason: string; canonical: string | null; required: boolean }[];
  } | null;
  /** Four-stage, per-question execution records. Values are presence markers,
   * never profile/legal answers or submitted backing values. */
  questionTraces?: QuestionExecutionTrace[];
  /** Redacted ATS resume-parse lifecycle; counts/enums only. */
  atsLifecycle?: unknown[];
  reconciliation?: { classification: string; canonicalKey: string | null; provenance: string }[];
  repeatableSections?: {
    sectionKind: string; required: boolean; policy: string; existingItemCount: number;
    candidateRecordCount: number; recordsAdded: number; duplicatesSkipped: number;
    incompleteSkipped: number; candidateRecordIds?: string[]; failureCode: string | null;
  }[];
  structuredCandidateCounts?: Record<string, unknown>;
  finalVerification?: Record<string, unknown> | null;
  /** TikTok legal adapter evidence; structural summaries and booleans only. */
  tiktokAdapter?: Record<string, unknown> | null;
  /** Where the "I'm interested" handoff actually stopped on the destination:
   * stage, honest failure code, per-frame field counts, elapsed time. Origins
   * and counts only — never a destination URL with its query string. */
  destinationReadiness?: Record<string, unknown> | null;
  /** Per-frame reachability for an embedded application: frame ids, url kinds,
   * sandbox tokens, host-permission state and field counts. Origins and
   * redacted path shapes only — never a query string or a token. */
  frameInspection?: Record<string, unknown> | null;
}

export interface QuestionExecutionTrace {
  fieldId: string;
  frameId: string;
  rawLabel: string;
  associatedLabelText?: string;
  accessibleName: string;
  ariaLabel?: string | null;
  ariaLabelledbyIds?: string[];
  ariaLabelledbyText?: string;
  sectionHeading: string;
  fieldType: string;
  ariaRole: string | null;
  controlTag?: string;
  fieldName?: string;
  fieldDomId?: string;
  placeholder?: string;
  ariaExpanded?: string | null;
  ariaControls?: string | null;
  required?: boolean;
  disabled?: boolean;
  nearbyText?: string;
  descriptorFingerprint?: string;
  options: string[];
  discoveredBackingValues?: string[];
  canonicalKey: string | null;
  resolutionMethod: string;
  resolutionConfidence: number;
  transform: string;
  requiredCanonicalKeys: string[];
  answerSource: string;
  sensitivity?: string | null;
  sourceValues?: (boolean | null)[];
  typedAnswer?: boolean | null;
  displayAnswer?: string | null;
  reviewStatus?: string;
  profileRevision: string | null;
  requestEndpoint?: string;
  requestSchemaVersion?: number;
  answerContractVersion?: number;
  extensionBuildId?: string;
  runId?: string;
  runCreatedAt?: string;
  applicationSessionId?: number;
  domGeneration?: number;
  actuator: string | null;
  actuatorReached?: boolean;
  transactionState?: string;
  transactionStates?: string[];
  actualTrigger?: string | null;
  openStrategy?: string | null;
  listboxFound?: boolean;
  discoveredLiveOptions?: string[];
  matchedOption?: "[present]" | null;
  verificationSource?: string | null;
  attemptedValue: "[redacted]" | null;
  displayedValueAfterFill: "[present]" | "[empty]" | null;
  backingValueAfterFill: "[present]" | "[empty]" | null;
  verified: boolean;
  failureCode: string | null;
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    page: safeUrl(input.url),
    detectedAts: input.atsId,
    extensionVersion: input.extensionVersion ?? null,
    resolverVersion: input.formRoot?.resolverVersion ?? RESOLVER_VERSION,
    // Build identity — the first thing to check when the live page disagrees
    // with the test suite, because a stale unpacked extension explains it.
    build: input.build ?? null,
    runtime: input.runtime ?? null,
    resolverContract: input.resolverContract ?? null,
    authenticatedUserId: input.authenticatedUserId ?? null,
    atsLifecycle: input.atsLifecycle ?? [],
    reconciliation: input.reconciliation ?? [],
    repeatableSections: input.repeatableSections ?? [],
    structuredCandidateCounts: input.structuredCandidateCounts ?? null,
    finalVerification: input.finalVerification ?? null,
    tiktokAdapter: input.tiktokAdapter ?? null,
    destinationReadiness: input.destinationReadiness ?? null,
    frameInspection: input.frameInspection ?? null,
    authoritative: input.authoritative ?? null,
    questionTraces: input.questionTraces ?? [],
    // How this page resolved (or failed to resolve) its application workflow.
    // Enums and booleans only — safe to paste into a bug report.
    handoff: input.handoff ?? null,
    // This frame's census: what controls exist, whether a root resolved, and
    // WHY. A bare "could not identify form" is never enough to act on.
    frame: input.frameProbe
      ? {
          isTopFrame: input.frameProbe.isTopFrame,
          url: input.frameProbe.sanitizedUrl,
          readyState: input.frameProbe.readyState,
          controls: {
            forms: input.frameProbe.formCount,
            inputs: input.frameProbe.visibleInputs,
            textareas: input.frameProbe.visibleTextareas,
            selects: input.frameProbe.nativeSelects,
            ariaHaspopupButtons: input.frameProbe.ariaHaspopupButtons,
            roleComboboxes: input.frameProbe.roleComboboxes,
            required: input.frameProbe.requiredControls,
            fileInputs: input.frameProbe.fileInputs
          },
          openShadowRoots: input.frameProbe.openShadowRoots,
          applicationLabelsFound: input.frameProbe.applicationLabelsFound,
          candidateCount: input.frameProbe.candidateCount,
          bestScore: input.frameProbe.bestScore
        }
      : null,
    // Which container was chosen as the application form, why, and what was
    // rejected — the fastest way to diagnose a mis-scoped page.
    applicationRoot: input.formRoot
      ? {
          selected: input.formRoot.candidates.find((c) => !c.excluded)?.fingerprint ?? null,
          confident: input.formRoot.confident,
          reason: input.formRoot.reason ?? null,
          rootKind: input.formRoot.rootKind ?? null,
          // Plain-language verdict: which candidate won or why none did.
          explanation: input.formRoot.explanation ?? null,
          candidates: input.formRoot.candidates.map((c) => ({
            fingerprint: c.fingerprint,
            score: c.score,
            signals: c.signals,
            excluded: c.excluded ?? null,
            fieldCount: c.fieldCount,
            requiredCount: c.requiredCount
          }))
        }
      : null,
    counts: input.counts,
    fields: input.ledger.map((e) => ({
      uid: e.uid,
      frameId: e.frameId,
      label: e.label, // a QUESTION label, never an answer
      normalizedLabel: e.normalizedLabel,
      // Which wrapper rule produced this question text (label_for, legend, …).
      labelSource: input.labelSources?.[e.uid] ?? null,
      controlType: e.controlType,
      canonicalKey: e.canonicalKey,
      required: e.required,
      sensitive: e.sensitive,
      multiple: e.multiple,
      optionLabels: e.options,
      status: e.status,
      reasonCode: e.reasonCode || null,
      fillSource: e.fillSource,
      verified: e.verified
    })),
    // Per-dropdown event trail: FIELD_DISCOVERED → DROPDOWN_ADAPTER_SELECTED →
    // DROPDOWN_OPEN_ATTEMPT → DROPDOWN_OPENED → OPTIONS_DISCOVERED (count only)
    // → ANSWER_SOURCE → OPTION_MATCHED → OPTION_CLICKED → SELECTION_VERIFIED, or
    // the exact failure code. Contains no answer values.
    dropdowns: dropdownEventLog()
  };
  return JSON.stringify(snapshot, null, 2);
}

/** Origin + pathname only — strips query string, fragment, and any token. */
function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}
