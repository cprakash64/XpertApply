import { requiredEvidence, type RequiredEvidence } from "../fields/discovery";
import { computeCounts, valuePresent, type LedgerCounts, type LedgerEntry } from "../fields/ledger";
import { scan } from "../fields/runner";
import type { ApplicationSessionData, DiscoveredField } from "../types";
import type { SectionTrace } from "../application/repeatableSections";
import {
  discoverTikTokApplication,
  mergeTikTokLegalFields,
  verifyTikTokCommitted,
  type TikTokAdapterTrace,
  type TikTokLegalSlot
} from "../ats/tiktokApplication";
import { fieldFingerprint } from "./fieldIdentity";
import { fieldRef } from "./questionBatch";
import type { QuestionEntry } from "./questionLedger";
import type { QuestionExecutionTrace } from "./diagnostics";

export type FinalFailureCode =
  | "REQUIRED_FIELD_MISSING_FROM_LEDGER"
  | "FIELD_DROPPED_DURING_MERGE"
  | "INTERNAL_HANDOFF_FAILURE"
  | "REQUIRED_CONTROL_UNVERIFIED"
  | "CONTROL_VALUE_VERIFICATION_FAILED"
  | "REQUIRED_CONTROL_UNSUPPORTED"
  | "APPLICATION_VALIDATION_ERROR";

export interface FinalControlVerification {
  uid: string;
  fieldKey: string;
  fingerprint: string;
  domGeneration: number;
  canonicalKey: string | null;
  label: string;
  accessibleName: string;
  sectionHeading: string;
  options: string[];
  controlType: string;
  required: boolean;
  requiredEvidence: RequiredEvidence[];
  consent: boolean;
  displayValuePresent: boolean;
  backingValuePresent: boolean;
  ledgerEntryCount: number;
  questionLedgerPresent: boolean;
  resolverIncluded: boolean;
  actuatorQueued: boolean;
  actuatorReached: boolean;
  knownAnswerAvailable: boolean;
  verified: boolean;
  failureCode: FinalFailureCode | string | null;
}

export interface FinalVerificationResult {
  completed: true;
  controls: FinalControlVerification[];
  ledger: LedgerEntry[];
  counts: LedgerCounts;
  requiredLiveControlCount: number;
  requiredVerified: number;
  requiredRemaining: number;
  manualConsentActions: number;
  technicalIssues: number;
  repeatableCandidatesTerminal: boolean;
  applicationValidationErrors: number;
  everyRequiredLiveControlHasLedgerEntry: boolean;
  everyKnownAnswerReachedTerminalState: boolean;
  noStaleGenerationResults: boolean;
  lifecycleIsCurrent: boolean;
  canEnterReviewReady: boolean;
  tiktokAdapterTrace: TikTokAdapterTrace;
}

export interface FinalVerificationInput {
  root: ParentNode;
  session: ApplicationSessionData;
  domGeneration: number;
  lifecycleIsCurrent: boolean;
  ledger: LedgerEntry[];
  questionEntries: QuestionEntry[];
  questionTraces: QuestionExecutionTrace[];
  repeatableSections: SectionTrace[];
  step?: number;
  pageUrl?: string;
}

const LEGAL_KEYS = new Set([
  "work_authorization_us",
  "sponsorship_required_now",
  "sponsorship_required_future",
  "sponsorship_required_now_or_future"
]);

/**
 * The ledger is evidence, not authority. This function takes a completely fresh
 * inventory of the current application root and proves every required live
 * control against its committed DOM state immediately before REVIEW_READY.
 */
export function verifyFinalLiveDom(input: FinalVerificationInput): FinalVerificationResult {
  const current = scan(input.root, input.session, input.step ?? 0);
  const tiktok = discoverTikTokApplication(
    input.pageUrl ?? input.session.officialUrl,
    input.root,
    input.step ?? 0
  );
  current.fields = mergeTikTokLegalFields(current.fields, tiktok);
  const tiktokByUid = new Map(
    tiktok.slots.filter((slot) => slot.field).map((slot) => [slot.identity, slot])
  );
  const mappingByUid = new Map(current.mappings.map((mapping) => [mapping.uid, mapping]));
  const questionByKey = new Map(input.questionEntries.map((entry) => [entry.fieldKey, entry]));
  const traceByKey = new Map(input.questionTraces.map((trace) => [trace.fieldId, trace]));
  const liveUids = new Set(current.fields.map((field) => field.uid));
  const currentLedger: LedgerEntry[] = input.ledger.filter((entry) =>
    entry.uid.startsWith("upload:") || liveUids.has(entry.uid)
  );
  const controls: FinalControlVerification[] = [];

  for (const field of current.fields) {
    const key = fieldRef(field);
    const question = questionByKey.get(key);
    const trace = traceByKey.get(key);
    const mapping = mappingByUid.get(field.uid);
    const tiktokSlot = tiktokByUid.get(field.uid);
    const canonicalKey = tiktokSlot?.canonicalKey
      ?? question?.canonicalCategory ?? trace?.canonicalKey ?? mapping?.canonicalKey ?? null;
    const evidence = requiredEvidenceForField(field, canonicalKey);
    if (tiktokSlot) evidence.push("tiktok_application_adapter");
    const consent = isConsent(field, canonicalKey, question?.sensitivity ?? trace?.answerSource ?? null);
    const required = evidence.length > 0;
    const tiktokCommitted = tiktokSlot
      ? verifyTikTokCommitted(tiktokSlot, trace?.typedAnswer)
      : null;
    const display = tiktokCommitted
      ? tiktokCommitted.displayPresent || tiktokCommitted.verificationSource === "backing"
      : valuePresent(field);
    const backing = tiktokCommitted
      ? tiktokCommitted.backingPresent || tiktokCommitted.verificationSource === "display"
      : committedBackingPresent(field, display);
    const applicationError = required && hasApplicationValidationError(field);
    const matches = currentLedger.filter((entry) => entry.uid === field.uid && entry.frameId === field.frameId);
    const prior = matches[0];
    const resolverIncluded = Boolean(trace || question);
    const actuatorQueued = Boolean(trace?.transactionStates?.includes("QUEUED_FOR_ACTUATION"));
    const actuatorReached = Boolean(trace?.actuatorReached);
    const knownAnswerAvailable = trace?.typedAnswer !== null && trace?.typedAnswer !== undefined;
    const legal = Boolean(canonicalKey && LEGAL_KEYS.has(canonicalKey));
    const liveVerified = tiktokCommitted
      ? tiktokCommitted.verified && !applicationError
      : display && backing && !applicationError;
    /**
     * A legal control normally needs OUR transaction to have verified it — a
     * value that merely happens to be present is not evidence that the approved
     * answer was applied.
     *
     * But when the adapter re-reads the LIVE control and finds exactly the
     * approved answer (`verifyTikTokCommitted` compares against the typed
     * answer, and contradicting display or backing values fail it) on a control
     * we did actuate, that IS the same proof arriving one step later. Without
     * this, the live TikTok symptom was a work-authorization dropdown plainly
     * showing "Yes" while the panel kept listing it as an unresolved required
     * field, because the transaction's own optimistic verification had failed
     * before React finished committing.
     */
    const legalProvenLive = Boolean(tiktokCommitted?.verified && trace?.actuatorReached);
    const verified = !consent && liveVerified && (!legal || Boolean(trace?.verified) || legalProvenLive);
    // A verified control must never also carry a failure code: a stale
    // `trace.failureCode` from an earlier attempt kept counting as a technical
    // issue (and blocked REVIEW_READY) beside a control that now holds the
    // right answer.
    const failureCode = verified ? null : tiktokSlot?.failureCode ?? finalFailure({
      required,
      consent,
      display,
      backing,
      applicationError,
      ledgerEntryCount: matches.length,
      resolverIncluded,
      legal,
      knownAnswerAvailable,
      trace
    });

    controls.push({
      uid: field.uid,
      fieldKey: key,
      fingerprint: fieldFingerprint(field, {
        applicationSessionId: input.session.sessionId,
        domGeneration: input.domGeneration
      }, input.root),
      domGeneration: input.domGeneration,
      canonicalKey,
      label: field.label,
      accessibleName: field.ariaLabel,
      sectionHeading: field.sectionHeading,
      options: [...field.options],
      controlType: field.control,
      required,
      requiredEvidence: evidence,
      consent,
      displayValuePresent: display,
      backingValuePresent: backing,
      ledgerEntryCount: matches.length,
      questionLedgerPresent: Boolean(question),
      resolverIncluded,
      actuatorQueued,
      actuatorReached,
      knownAnswerAvailable,
      verified,
      failureCode
    });

    const finalEntry = finalLedgerEntry(
      field, prior, canonicalKey, required, consent, verified, failureCode, knownAnswerAvailable
    );
    replaceLedgerEntry(currentLedger, finalEntry);
  }

  // On a supported TikTok application, each legal identity exists in the final
  // inventory even if React exposed the question section without a discoverable
  // row/control. Omission is a technical result, never an optional skip.
  //
  // The second clause is the invariant guard: a slot that DID produce a field
  // but whose identity is nonetheless absent from the inventory means the merge
  // or a later dedup dropped it. That is a bug, and it is reported as one —
  // never as "required remaining = 0".
  const inventoried = new Set(controls.map((control) => control.uid));
  const missingSlots = tiktok.active
    ? tiktok.slots.filter((item) => !item.field || !inventoried.has(item.identity))
    : [];
  for (const slot of missingSlots) {
    const key = `f_top_${slot.identity}`;
    const failureCode = slot.field
      ? "TIKTOK_FIELD_NOT_INSERTED_IN_INVENTORY"
      : slot.failureCode ?? "TIKTOK_LEGAL_CONTROL_NOT_FOUND";
    controls.push({
      uid: slot.identity,
      fieldKey: key,
      fingerprint: `${slot.identity}:g${input.domGeneration}`,
      domGeneration: input.domGeneration,
      canonicalKey: slot.canonicalKey,
      label: slot.kind === "authorization" ? "Work authorization" : "Sponsorship now or in the future",
      accessibleName: "",
      sectionHeading: "Work Authorization",
      options: [],
      controlType: "combobox",
      required: true,
      requiredEvidence: ["tiktok_application_adapter"],
      consent: false,
      displayValuePresent: false,
      backingValuePresent: false,
      ledgerEntryCount: 0,
      questionLedgerPresent: questionByKey.has(key),
      resolverIncluded: traceByKey.has(key),
      actuatorQueued: false,
      actuatorReached: false,
      knownAnswerAvailable: false,
      verified: false,
      failureCode
    });
    replaceLedgerEntry(currentLedger, missingTikTokLedger(slot, failureCode));
  }

  const counts = computeCounts(currentLedger);
  const requiredControls = controls.filter((control) => control.required && !control.consent);
  const requiredVerified = requiredControls.filter((control) => control.verified).length;
  const manualConsentActions = controls.filter((control) => control.consent && !control.displayValuePresent).length;
  const applicationValidationErrors = controls.filter((control) =>
    control.failureCode === "APPLICATION_VALIDATION_ERROR"
  ).length;
  const everyRequiredLiveControlHasLedgerEntry = requiredControls.every((control) =>
    control.ledgerEntryCount === 1 || control.failureCode === "REQUIRED_FIELD_MISSING_FROM_LEDGER"
  );
  const everyKnownAnswerReachedTerminalState = controls.every((control) => {
    const trace = traceByKey.get(control.fieldKey);
    if (trace?.typedAnswer === null || trace?.typedAnswer === undefined) return true;
    return trace.verified || Boolean(control.failureCode);
  });
  const noStaleGenerationResults = input.questionTraces.every((trace) =>
    trace.domGeneration === undefined || trace.domGeneration === input.domGeneration
  );
  const repeatableCandidatesTerminal = repeatersAreTerminal(input.repeatableSections);
  const requiredRemaining = requiredControls.length - requiredVerified;
  const technicalIssues = controls.filter((control) => Boolean(control.failureCode)).length
    + input.repeatableSections.filter((section) => sectionCandidateFailed(section)).length;
  const canEnterReviewReady =
    input.lifecycleIsCurrent
    && requiredControls.length > 0
    && everyRequiredLiveControlHasLedgerEntry
    && requiredRemaining === 0
    && everyKnownAnswerReachedTerminalState
    && technicalIssues === 0
    && repeatableCandidatesTerminal
    && noStaleGenerationResults
    && applicationValidationErrors === 0;

  return {
    completed: true,
    controls,
    ledger: currentLedger,
    counts,
    requiredLiveControlCount: requiredControls.length,
    requiredVerified,
    requiredRemaining,
    manualConsentActions,
    technicalIssues,
    repeatableCandidatesTerminal,
    applicationValidationErrors,
    everyRequiredLiveControlHasLedgerEntry,
    everyKnownAnswerReachedTerminalState,
    noStaleGenerationResults,
    lifecycleIsCurrent: input.lifecycleIsCurrent,
    canEnterReviewReady,
    tiktokAdapterTrace: {
      ...tiktok.trace,
      authorizationInventoryInserted: controls.some((control) => control.uid === "tiktok:work_authorization:authorization"),
      sponsorshipInventoryInserted: controls.some((control) => control.uid === "tiktok:work_authorization:sponsorship_now_or_future"),
      authorizationActuatorReached: controls.some((control) => control.uid === "tiktok:work_authorization:authorization" && control.actuatorReached),
      sponsorshipActuatorReached: controls.some((control) => control.uid === "tiktok:work_authorization:sponsorship_now_or_future" && control.actuatorReached),
      finalVerificationUsedTikTokAdapter: tiktok.active,
      finalVerificationUsedAdapter: tiktok.active
    }
  };
}

function missingTikTokLedger(slot: TikTokLegalSlot, failureCode: string): LedgerEntry {
  const label = slot.kind === "authorization" ? "Work authorization" : "Sponsorship now or in the future";
  return {
    uid: slot.identity,
    frameId: "top",
    label,
    normalizedLabel: label.toLowerCase(),
    controlType: "combobox",
    canonicalKey: slot.canonicalKey,
    required: true,
    sensitive: false,
    options: [],
    multiple: false,
    currentValuePresent: false,
    status: "technical_failure",
    reasonCode: failureCode,
    fillSource: null,
    verified: false,
    question: label,
    reusable: true
  };
}

function requiredEvidenceForField(field: DiscoveredField, canonicalKey: string | null): RequiredEvidence[] {
  const evidence = new Set(requiredEvidence(field.element ?? document.createElement("div"), field));
  if (canonicalKey && LEGAL_KEYS.has(canonicalKey)) evidence.add("known_eligibility_question");
  return Array.from(evidence);
}

function isConsent(field: DiscoveredField, canonicalKey: string | null, sensitivity: string | null): boolean {
  const text = `${field.label} ${field.ariaLabel} ${field.nearbyText} ${canonicalKey ?? ""}`;
  return sensitivity === "consent"
    || canonicalKey === "privacy_policy_acknowledgement"
    || (field.control === "checkbox" && /privacy|terms|consent|acknowledge|agree/i.test(text));
}

function committedBackingPresent(field: DiscoveredField, displayed: boolean): boolean {
  const element = field.element;
  if (!element?.isConnected) return false;
  if (element instanceof HTMLSelectElement) return Boolean(element.value && !/^select/i.test(element.value));
  if (element instanceof HTMLInputElement) {
    if (element.type === "radio") {
      const name = element.name;
      return name
        ? Boolean(element.ownerDocument.querySelector(`input[type="radio"][name="${cssEscape(name)}"]:checked`))
        : element.checked;
    }
    if (element.type === "checkbox") return element.checked;
    if (field.control !== "combobox" && field.control !== "listbox") return Boolean(element.value.trim());
  }
  if (field.control === "combobox" || field.control === "listbox") {
    const scope = element.closest("fieldset,[role=group],[data-field],[class*='field']") ?? element.parentElement ?? element;
    const hidden = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="hidden"]'));
    if (hidden.length > 0) return hidden.some((input) => input.value.trim() !== "");
    return displayed && Boolean(
      element.getAttribute("aria-activedescendant")
      || element.querySelector('[aria-selected="true"],[class*="singleValue"],[class*="single-value"],[class*="multiValue"]')
    );
  }
  return displayed;
}

function hasApplicationValidationError(field: DiscoveredField): boolean {
  const element = field.element as HTMLInputElement | undefined;
  if (!element) return true;
  if (element.getAttribute("aria-invalid") === "true") return true;
  if (field.validationMessage.trim()) return true;
  return Boolean(element.validity && !element.validity.valid && element.willValidate);
}

function finalFailure(input: {
  required: boolean;
  consent: boolean;
  display: boolean;
  backing: boolean;
  applicationError: boolean;
  ledgerEntryCount: number;
  resolverIncluded: boolean;
  legal: boolean;
  knownAnswerAvailable: boolean;
  trace: QuestionExecutionTrace | undefined;
}): FinalFailureCode | string | null {
  if (!input.required || input.consent) return null;
  if (input.ledgerEntryCount === 0) {
    return input.trace ? "FIELD_DROPPED_DURING_MERGE" : "REQUIRED_FIELD_MISSING_FROM_LEDGER";
  }
  if (input.ledgerEntryCount !== 1) return "FIELD_DROPPED_DURING_MERGE";
  if (input.legal && !input.resolverIncluded) return "REQUIRED_FIELD_MISSING_FROM_LEDGER";
  if (input.trace?.typedAnswer !== null && input.trace?.typedAnswer !== undefined && !input.trace.actuatorReached) {
    return "INTERNAL_HANDOFF_FAILURE";
  }
  if (input.applicationError) return "APPLICATION_VALIDATION_ERROR";
  if (input.display && !input.backing) return "CONTROL_VALUE_VERIFICATION_FAILED";
  if (input.trace?.failureCode) return input.trace.failureCode;
  if (input.legal && input.resolverIncluded && !input.knownAnswerAvailable) return null;
  if (!input.display || !input.backing) return "REQUIRED_CONTROL_UNVERIFIED";
  if (input.legal && !input.trace?.verified) return "REQUIRED_CONTROL_UNVERIFIED";
  return null;
}

function finalLedgerEntry(
  field: DiscoveredField,
  prior: LedgerEntry | undefined,
  canonicalKey: string | null,
  required: boolean,
  consent: boolean,
  verified: boolean,
  failureCode: string | null,
  knownAnswerAvailable: boolean
): LedgerEntry {
  const status = consent && !valuePresent(field)
    ? "needs_confirmation"
    : verified
      ? "filled_verified"
      : required
        ? failureCode || knownAnswerAvailable
          ? "technical_failure"
          : "missing_information"
        : prior?.status ?? "intentionally_skipped_optional";
  return {
    uid: field.uid,
    frameId: field.frameId,
    label: field.label || field.ariaLabel || field.placeholder || field.name || "Application question",
    normalizedLabel: field.normalizedLabel,
    controlType: field.control,
    canonicalKey,
    required,
    sensitive: consent || prior?.sensitive === true,
    options: field.options,
    multiple: field.multiple,
    currentValuePresent: valuePresent(field),
    status,
    reasonCode: consent && !valuePresent(field) ? "CONSENT_REQUIRES_USER" : failureCode ?? prior?.reasonCode ?? "",
    fillSource: verified ? prior?.fillSource ?? "live_dom" : null,
    verified,
    question: field.label || field.ariaLabel || prior?.question || "Application question",
    reusable: prior?.reusable ?? false,
    defaultScope: prior?.defaultScope
  };
}

function replaceLedgerEntry(entries: LedgerEntry[], next: LedgerEntry): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].uid === next.uid && entries[index].frameId === next.frameId) entries.splice(index, 1);
  }
  entries.push(next);
}

function repeatersAreTerminal(sections: SectionTrace[]): boolean {
  return sections.every((section) => {
    if (section.candidateRecordCount === 0) return section.failureCode === "NO_CONFIRMED_PROFILE_RECORDS";
    return Boolean(section.failureCode) || section.recordsAdded + section.duplicatesSkipped >= section.candidateRecordCount;
  });
}

function sectionCandidateFailed(section: SectionTrace): boolean {
  if (section.candidateRecordCount === 0) return false;
  return !new Set(["RECORD_ADDED_AND_VERIFIED", "DUPLICATE_ALREADY_PRESENT", "SECTION_POLICY_REVIEW_ONLY"])
    .has(section.failureCode ?? "");
}

function cssEscape(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}
