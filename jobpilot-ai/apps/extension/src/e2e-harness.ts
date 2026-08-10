/**
 * Browser test harness. Bundled to `e2e/bundle/harness.js` and injected into a
 * real Chromium page by the Playwright specs, so the dropdown adapters are
 * exercised against genuine layout, real pointer/focus behaviour, real portals
 * and real component JS — the things jsdom cannot model.
 *
 * Test-only entry point: it is NOT part of the shipped extension bundle.
 */

import { discoverAll } from "./fields/discovery";
import { fillField } from "./fields/fill";
import { configureDropdownTiming, isBlankValue } from "./fields/dropdown/dom";
import { probeFrame, selectApplicationFrame } from "./frames/probe";
import { dropdownEventLog, fillDropdown, selectAdapter } from "./fields/dropdown";
import { buildLedger, valuePresent } from "./fields/ledger";
import { scan } from "./fields/runner";
import { createWidget } from "./content/widget";
import { questionLedger } from "./content/bootstrap";
import { findActivationCandidates, selectActivationControl } from "./ats/applicationSurface";
import { resolveApplyDestination, validateDestination } from "./ats/applyDestination";
import {
  activateApplyCta,
  classifyPage,
  ctaFingerprint,
  findSafeConsentDismissal,
  isCtaObstructed
} from "./ats/pageState";
import type { DiscoveredField } from "./types";
import { AtsLifecycleRun, waitForAtsParse } from "./content/atsLifecycle";
import { fillRepeatableSections } from "./application/repeatableSections";
import { verifyFinalLiveDom } from "./content/finalVerification";
import {
  actuateTikTokLegalField,
  discoverTikTokApplication
} from "./ats/tiktokApplication";
import { committedValueMatches } from "./content/dropdownTransaction";
import {
  frameVerdict,
  observeFrames,
  reopenableFrameUrl,
  selectApplicationFrame as selectObservedApplicationFrame
} from "./frames/frameInventory";
import {
  awaitApplicationReadiness,
  censusChildFrames,
  collectApplicationEvidence,
  hasApplicationEvidence,
  type ReadinessStage
} from "./content/applicationReadiness";
import { fieldRef } from "./content/questionBatch";
import type { QuestionExecutionTrace } from "./content/diagnostics";

let cache: DiscoveredField[] = [];

function discover(selector = "form"): DiscoveredField[] {
  const root = document.querySelector(selector) ?? document;
  cache = discoverAll(root).fields;
  return cache;
}

function find(idOrLabel: string): DiscoveredField | undefined {
  return (
    cache.find((f) => f.id === idOrLabel) ??
    cache.find((f) => (f.label || f.ariaLabel || "").toLowerCase().includes(idOrLabel.toLowerCase()))
  );
}

const harness = {
  configureDropdownTiming,
  discover: (selector?: string) =>
    discover(selector).map((f) => ({
      uid: f.uid,
      id: f.id,
      label: f.label || f.ariaLabel,
      control: f.control,
      required: f.required,
      multiple: f.multiple,
      options: f.options,
      adapter: selectAdapter(f)?.id ?? null
    })),

  /** Drive one dropdown exactly as automatic autofill does. */
  fill: async (idOrLabel: string, value: string | string[]) => {
    const field = find(idOrLabel);
    if (!field) return { error: "field-not-found" };
    const outcome = await fillField(field, value, { status: "verified", force: true });
    return { status: outcome.status, reason: outcome.reason, dropdown: outcome.dropdown };
  },

  /** Open a dropdown only to read its real options (no answer supplied).
   * This is the ONE legitimate opt-in for allowProbe: an explicit request to
   * enumerate options, never part of an autofill run. */
  probe: async (idOrLabel: string) => {
    const field = find(idOrLabel);
    if (!field) return { error: "field-not-found" };
    const result = await fillDropdown(field, { values: [], allowProbe: true });
    return { reason: result.reason, options: result.options };
  },

  /** What the control actually shows as selected, per the adapter. */
  selection: (idOrLabel: string) => {
    const field = find(idOrLabel);
    if (!field) return null;
    return selectAdapter(field)?.readSelection(field) ?? null;
  },

  /** Completeness: is this control genuinely non-blank? */
  hasValue: (idOrLabel: string) => {
    const field = find(idOrLabel);
    return field ? valuePresent(field) : null;
  },

  isBlankValue,
  events: () => dropdownEventLog(),

  /** Visual fixture for the assisted-apply panel. Keeps the production widget
   * itself under browser-level layout review without shipping preview code. */
  showWidgetPreview: () => {
    const attachShadow = Element.prototype.attachShadow;
    let previewRoot: ShadowRoot | null = null;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      previewRoot = attachShadow.call(this, { ...init, mode: "open" });
      return previewRoot;
    };
    const widget = createWidget({ retry: () => {}, clear: () => {}, complete: () => {} });
    Element.prototype.attachShadow = attachShadow;
    widget.update({
      stage: "review",
      filled: 20,
      total: 26,
      message: "5 items need your review (2 required)."
    });
    widget.showReview([
      {
        id: "school", kind: "field", category: "application",
        question: "Which school, college, or university did you attend?",
        required: false,
        reasonText: "Enter the institution name exactly as you want it shown on this application.",
        control: "text", reusable: true, defaultScope: "global"
      },
      {
        id: "degree", kind: "field", category: "required",
        question: "What type of degree did you earn?",
        required: true,
        reasonText: "Choose the closest degree level offered by the employer (for example, Master's Degree for a Master of Science).",
        options: ["Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctoral Degree"],
        control: "select", reusable: true, defaultScope: "global"
      },
      {
        id: "major", kind: "field", category: "application",
        question: "What was your major or field of study?",
        required: false,
        reasonText: "Enter the subject you studied, sometimes called your discipline or field of study.",
        control: "text", reusable: true, defaultScope: "global"
      }
    ], {
      onFill: async () => true,
      onSave: async () => true,
      onJumpToField: () => {}
    }, {
      discovered: 26, filled: 20, needsInformation: 3, needsConfirmation: 1,
      sensitive: 1, technical: 0, optionalSkipped: 1, requiredBlank: 2, pending: 5
    });
    (previewRoot as ShadowRoot | null)?.querySelector<HTMLButtonElement>(".review-toggle")?.click();
    return true;
  },

  // --- Application navigation (the production classifier, unmodified) ------ //
  /** What the content script decides this page is, with real layout applied. */
  classify: () => {
    const page = classifyPage(document);
    return {
      state: page.state,
      reason: page.reason,
      obstructed: page.obstructed,
      candidateName: page.candidate ? (page.candidate.element.textContent ?? "").trim() : null,
      candidateReason: page.candidate?.reason ?? null
    };
  },
  /** Every eligible control, for diagnosing selection between rivals. */
  candidates: () =>
    findActivationCandidates(document).map((candidate) => ({
      name: (candidate.element.textContent ?? "").trim(),
      reason: candidate.reason,
      score: candidate.score
    })),
  selected: () => {
    const candidate = selectActivationControl(document);
    return candidate ? { name: (candidate.element.textContent ?? "").trim(), reason: candidate.reason } : null;
  },
  /** Real hit-testing: is the chosen CTA actually covered by an overlay? */
  ctaObstructed: () => {
    const candidate = selectActivationControl(document);
    return candidate ? isCtaObstructed(candidate.element, document) : null;
  },
  consentDismissal: () => {
    const control = findSafeConsentDismissal(document);
    return control ? (control.textContent ?? "").trim() : null;
  },
  ctaFingerprint: () => {
    const candidate = selectActivationControl(document);
    return candidate ? ctaFingerprint(candidate.element, location.href) : null;
  },
  /** URL-first: what destination does the chosen CTA declare? */
  destination: () => {
    const candidate = selectActivationControl(document);
    if (!candidate) return { ok: false, reason: "NO_CANDIDATE" };
    return resolveApplyDestination(candidate.element, location.href);
  },
  validateDestination: (raw: string) => validateDestination(raw, location.href),

  /** Drive the production activation path, including dispatch strategy. */
  activate: async () => {
    const candidate = selectActivationControl(document);
    if (!candidate) return { ok: false, reason: "NO_CANDIDATE" };
    return activateApplyCta(candidate.element, document);
  },

  /** The authoritative question ledger, for reconciliation assertions. */
  ledger: () => ({
    counts: questionLedger.counts(),
    stage: questionLedger.stage(),
    entries: questionLedger.all().map((e) => ({ state: e.state, reason: e.reasonCode }))
  }),

  /** Real-browser ATS parse handoff: retain an old node only to prove it was
   * detached, then discover exclusively from the new DOM generation. */
  lifecycleHandoff: async (selector = "form") => {
    const root = document.querySelector(selector) ?? document;
    const oldControl = root.querySelector("input,select,textarea,[role=combobox]");
    const run = new AtsLifecycleRun(66, "e2e-build");
    run.transition("WAITING_FOR_ATS_PARSE", "resume_upload_committed");
    const parse = await waitForAtsParse(root, run.signal(), { quietWindowMs: 120, activityGraceMs: 80, maximumWaitMs: 2500 });
    if (parse.activityDetected) run.transition("ATS_PARSE_ACTIVITY_DETECTED", "mutation_observed", { relevantMutations: parse.relevantMutations });
    run.invalidatePreParse("parse_settled");
    run.transition("REDISCOVERING_POST_PARSE_DOM", "fresh_scan");
    const fields = discoverAll(document.querySelector(selector) ?? document).fields;
    return {
      parse,
      oldConnected: Boolean(oldControl?.isConnected),
      generation: run.domGeneration(),
      fields: fields.map((field) => field.label || field.ariaLabel || field.name),
      trace: run.trace().map((entry) => entry.state)
    };
  },

  fillRepeatable: async (profileData: Record<string, unknown>, selector = "form") => {
    const root = document.querySelector(selector) ?? document;
    return fillRepeatableSections(root, {
      sessionId: 66, atsType: "generic", officialUrl: location.href,
      jobTitle: "Engineer", company: "Example", profileData, answers: [], unresolvedQuestions: []
    });
  },

  finalVerify: (
    profileData: Record<string, unknown>,
    selector = "form",
    answers: { label: string; canonicalKey: string; typedAnswer: boolean; verified: boolean; actuatorReached: boolean }[] = [],
    repeatableSections: Awaited<ReturnType<typeof fillRepeatableSections>> = []
  ) => {
    const root = document.querySelector(selector) ?? document;
    const activeSession = {
      sessionId: 66, atsType: "generic", officialUrl: location.href,
      jobTitle: "Engineer", company: "Example", profileData, answers: [], unresolvedQuestions: []
    };
    const scanned = scan(root, activeSession);
    const mappingByUid = new Map(scanned.mappings.map((mapping) => [mapping.uid, mapping]));
    const ledger = buildLedger(scanned.fields, [], (field) => ({
      canonicalKey: mappingByUid.get(field.uid)?.canonicalKey ?? null,
      sensitive: false, reusable: false, fillSource: "fixture"
    }));
    const traces: QuestionExecutionTrace[] = answers.flatMap((answer) => {
      const field = scanned.fields.find((candidate) =>
        `${candidate.label} ${candidate.ariaLabel}`.toLowerCase().includes(answer.label.toLowerCase())
      );
      if (!field) return [];
      return [{
        fieldId: fieldRef(field), frameId: field.frameId, rawLabel: field.label,
        accessibleName: field.ariaLabel, sectionHeading: field.sectionHeading,
        fieldType: field.control, ariaRole: field.element?.getAttribute("role") ?? null,
        options: [...field.options], canonicalKey: answer.canonicalKey,
        resolutionMethod: "e2e_fixture", resolutionConfidence: 1,
        transform: answer.canonicalKey.includes("sponsorship") ? "boolean_or" : "none",
        requiredCanonicalKeys: [], answerSource: "saved_profile",
        sourceValues: answer.typedAnswer ? [true] : [false, false],
        typedAnswer: answer.typedAnswer, displayAnswer: answer.typedAnswer ? "Yes" : "No",
        profileRevision: "fixture", domGeneration: 1, actuator: "custom_choice",
        actuatorReached: answer.actuatorReached,
        transactionStates: ["DISCOVERED", "RESOLVER_REQUESTED", "SEMANTICALLY_RESOLVED", "QUEUED_FOR_ACTUATION"],
        attemptedValue: "[redacted]", displayedValueAfterFill: answer.verified ? "[present]" : "[empty]",
        backingValueAfterFill: answer.verified ? "[present]" : "[empty]",
        verified: answer.verified, failureCode: answer.verified ? null : "CONTROL_VALUE_DID_NOT_COMMIT"
      } satisfies QuestionExecutionTrace];
    });
    return verifyFinalLiveDom({
      root, session: activeSession, domGeneration: 1, lifecycleIsCurrent: true,
      ledger, questionEntries: [], questionTraces: traces, repeatableSections
    });
  },

  /**
   * Section B — destination readiness, run against a real hydrating page.
   *
   * Returns the terminal verdict plus the stages it passed through, so a spec
   * can prove the widget could never have stayed on "Detecting fields".
   */
  awaitDestinationReadiness: async (timeoutMs = 8000, quietMs = 150) => {
    const stages: ReadinessStage[] = [];
    const result = await awaitApplicationReadiness({
      timeoutMs,
      quietMs,
      onStage: (stage) => stages.push(stage)
    });
    return {
      stages,
      ready: result.ready,
      stage: result.stage,
      failureCode: result.failureCode,
      fieldCount: result.fieldCount,
      rootReplacements: result.rootReplacements,
      elapsedMs: result.elapsedMs,
      evidence: result.evidence,
      evidenceLocation: result.evidenceLocation,
      frames: result.frames
    };
  },
  /** Section B — the committed-value comparison, run against real markup. */
  committedValueMatches,
  /** Section A — what the parent can observe about a genuinely cross-origin
   * application frame, and what remedy that supports. */
  observeFrames: () => observeFrames(document),
  frameRemedy: () => {
    const frames = observeFrames(document);
    const candidate = selectObservedApplicationFrame(frames);
    return {
      frames,
      candidate,
      reopenUrl: reopenableFrameUrl(candidate, document),
      verdictWithoutPermission: frameVerdict({
        frame: candidate,
        contentScriptResponds: false,
        hostPermissionGranted: false,
        reportedFieldCount: null
      })
    };
  },
  applicationEvidence: () => {
    const evidence = collectApplicationEvidence(document);
    return { ...evidence, sufficient: hasApplicationEvidence(evidence), frames: censusChildFrames(document) };
  },

  tiktokDiscover: (url: string, selector = "form") => {
    const inventory = discoverTikTokApplication(url, document.querySelector(selector) ?? document);
    return {
      active: inventory.active,
      trace: inventory.trace,
      slots: inventory.slots.map((slot) => ({
        identity: slot.identity,
        canonicalKey: slot.canonicalKey,
        required: slot.field?.required ?? true,
        rowFound: slot.rowFound,
        triggerFound: slot.triggerFound,
        triggerId: slot.trigger?.id ?? null,
        failureCode: slot.failureCode
      }))
    };
  },

  tiktokActuate: async (
    url: string,
    identity: string,
    displayAnswer: string,
    typedAnswer: boolean,
    selector = "form"
  ) => actuateTikTokLegalField(
    url,
    identity,
    displayAnswer,
    typedAnswer,
    document.querySelector(selector) ?? document
  ),

  tiktokFinal: (url: string, selector = "form", traces: QuestionExecutionTrace[] = []) => {
    const root = document.querySelector(selector) ?? document;
    const activeSession = {
      sessionId: 66, atsType: "generic", officialUrl: url,
      jobTitle: "Engineer", company: "TikTok", profileData: {}, answers: [], unresolvedQuestions: []
    };
    const inventory = discoverTikTokApplication(url, root);
    const fields = inventory.slots.flatMap((slot) => slot.field ? [slot.field] : []);
    const ledger = buildLedger(fields, [], (field) => ({
      canonicalKey: inventory.slots.find((slot) => slot.identity === field.uid)?.canonicalKey ?? null,
      sensitive: false, reusable: true, fillSource: null
    }));
    return verifyFinalLiveDom({
      root, session: activeSession, domGeneration: 1, lifecycleIsCurrent: true,
      ledger, questionEntries: [], questionTraces: traces, repeatableSections: [], pageUrl: url
    });
  },

  /** Section B — per-frame application census, run inside a real frame. */
  probeFrame: () => probeFrame(document),
  /** Section B — rank probes across frames and pick the application frame. */
  selectApplicationFrame: (probes: Parameters<typeof selectApplicationFrame>[0]) =>
    selectApplicationFrame(probes)
};

(window as unknown as { JobPilotHarness: typeof harness }).JobPilotHarness = harness;
export type Harness = typeof harness;
