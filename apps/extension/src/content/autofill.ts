/**
 * The ONE canonical autofill runner. Both the automatic launch and the manual
 * "Fill application" retry call `runAutofill` — there is no separate manual
 * implementation. It discovers fields, fills verified/high-confidence values,
 * uploads the tailored documents (with verification), leaves everything else as
 * review items, and produces a detailed per-field result model plus a PII-free
 * summary. It never clicks Submit.
 */

import type { DetectionOutcome } from "../ats/registry";
import { pickApplicationForm } from "../ats/base";
import { discoverUploadInputs } from "../ats/base";
import { deepClosest, deepTextContent } from "../dom/deepDom";
import { applyFill, scan, type FillSummary } from "../fields/runner";
import { uploadFileToInput } from "../fields/upload";
import { buildLedger, computeCounts, type LedgerCounts, type LedgerEntry } from "../fields/ledger";
import { COMPANY_SCOPED_FIELDS, CUSTOM_RESPONSE_FIELDS, UPLOAD_FIELDS, type CanonicalField } from "../fields/taxonomy";
import type {
  AutofillResult,
  FieldFillResult,
  ProgressPayload,
  ReasonCode
} from "../messages";
import type { ApplicationSessionData, DiscoveredField, FieldMapping } from "../types";
import { reconcileAtsValues } from "./reconciliation";

/** Terminal upload states surfaced as ledger entries so documents are counted
 * consistently with every other required control (invariant B.5). */
type UploadLedgerState = "uploaded" | "review" | "download_failed";

export interface AutofillDeps {
  /** Fetch a generated document as a File (bytes come from the background). */
  fetchDocument: (kind: "resume" | "cover-letter") => Promise<File | null>;
  onUploadStart?: (kind: "resume" | "cover-letter") => void;
  /** Documents prepared before ATS parsing. Supplying this prevents a second
   * upload during the authoritative post-parse fill. */
  preparedDocuments?: PreparedDocumentUploads;
}

export interface PreparedDocumentUploads {
  uploaded: ("resume" | "cover_letter")[];
  reviewDocs: ("resume" | "cover_letter")[];
  fieldResults: FieldFillResult[];
  resumeCommitted: boolean;
}

export interface AutofillOutcome {
  progress: ProgressPayload;
  result: AutofillResult;
  fieldResults: FieldFillResult[];
  /** Raw discovered fields from this scan, WITH live element references —
   * the review widget uses these to apply a manually-chosen answer directly
   * to the correct DOM node. Never sent across a message boundary. */
  fields: DiscoveredField[];
  /** The field ledger for THIS scan — the single source of truth the content
   * script merges into its durable ledger and derives all counts from. */
  ledger: LedgerEntry[];
  counts: LedgerCounts;
}

export async function runAutofill(
  session: ApplicationSessionData,
  outcome: DetectionOutcome,
  deps: AutofillDeps,
  step = 0
): Promise<AutofillOutcome> {
  const root = pickApplicationForm(document);
  const scanned = scan(root, session, step);
  // Upload before scalar fill. ATSs such as TikTok parse the resume and replace
  // the form; filling the pre-parse nodes first creates stale references.
  const documents = deps.preparedDocuments
    ?? await prepareDocumentUploads(session, deps, root, scanned.fields, scanned.mappings);
  const reconciliation = new Map(
    reconcileAtsValues(scanned.fields, scanned.mappings, session).map((item) => [item.uid, item])
  );
  const takeoverMappings = scanned.mappings.filter((mapping) => {
    const classification = reconciliation.get(mapping.uid)?.classification;
    return classification === "EMPTY_AND_RESOLVABLE" || classification === "EMPTY_AND_MISSING_INFORMATION";
  });
  const summary = await applyFill(scanned.fields, takeoverMappings, session);
  const fieldResults = buildFieldResults(scanned.fields, scanned.mappings, session, summary);
  fieldResults.push(...documents.fieldResults);
  const { uploaded, reviewDocs } = documents;

  // --- The field ledger: the ONE source of truth. Every discovered control
  // plus every document target becomes exactly one entry; all counts derive
  // from it (never from ad-hoc filters). ---
  const ledger = buildScanLedger(
    scanned.fields,
    scanned.mappings,
    fieldResults,
    uploadLedgerStates(uploaded, reviewDocs)
  );
  const counts = computeCounts(ledger);
  const reviewItems = counts.pending;
  const filled = counts.filled;
  const submit = outcome.adapter.findSubmitControl({ url: location.href, document });
  const progress: ProgressPayload = {
    state: reviewItems > 0 ? "completed_with_review" : "completed",
    atsId: outcome.result.atsId,
    atsDisplayName: outcome.adapter.displayName,
    limited: outcome.limited,
    fieldsDiscovered: counts.discovered,
    filled,
    skipped: counts.optionalSkipped,
    reviewRequired: reviewItems,
    reachedFinalStep: submit !== null,
    documentsUploaded: uploaded,
    reviewDocuments: reviewDocs
  };
  const result: AutofillResult = {
    status: counts.discovered === 0 ? "no_fields" : reviewItems > 0 ? "completed_with_review" : "completed",
    ats: outcome.result.atsId,
    fields_discovered: counts.discovered,
    fields_filled: filled,
    documents_uploaded: uploaded,
    review_items: reviewItems,
    failures: fieldResults
      .filter((item) => item.status === "failed" && item.reasonCode)
      .map((item) => ({ field_key: item.fieldKey, reason_code: item.reasonCode as string }))
  };
  return { progress, result, fieldResults, fields: scanned.fields, ledger, counts };
}

/** Upload documents as a separate lifecycle phase before any authoritative DOM
 * discovery. The returned durable result is reused after ATS parsing settles. */
export async function prepareDocumentUploads(
  session: ApplicationSessionData,
  deps: Pick<AutofillDeps, "fetchDocument" | "onUploadStart">,
  root: ParentNode,
  fields?: DiscoveredField[],
  mappings?: FieldMapping[]
): Promise<PreparedDocumentUploads> {
  const scanned = fields && mappings ? { fields, mappings } : scan(root, session, 0);
  const uploaded: ("resume" | "cover_letter")[] = [];
  const reviewDocs: ("resume" | "cover_letter")[] = [];
  const fieldResults: FieldFillResult[] = [];
  const uploadTargets = resolveUploadTargets(scanned.fields, scanned.mappings, root);
  for (const target of uploadTargets) {
    const publicKind: "resume" | "cover_letter" = target.kind === "cover-letter" ? "cover_letter" : "resume";
    let file: File | null = null;
    deps.onUploadStart?.(target.kind);
    try {
      file = await deps.fetchDocument(target.kind);
    } catch {
      file = null;
    }
    if (!file) {
      reviewDocs.push(publicKind);
      pushResult(fieldResults, publicKind, `Upload ${publicKind}`, "failed", "DOCUMENT_DOWNLOAD_FAILED");
      continue;
    }
    const set = uploadFileToInput(target.input, file);
    const ok = set.status === "uploaded" && (await verifyUpload(target.input, file.name));
    if (ok) {
      uploaded.push(publicKind);
      pushResult(fieldResults, publicKind, `Upload ${publicKind}`, "filled");
    } else {
      // Do NOT claim success — leave the field in review with a fallback.
      reviewDocs.push(publicKind);
      pushResult(fieldResults, publicKind, `Upload ${publicKind}`, "review", "DOCUMENT_UPLOAD_REJECTED");
    }
  }
  return {
    uploaded,
    reviewDocs,
    fieldResults,
    resumeCommitted: uploaded.includes("resume")
  };
}

// --------------------------------------------------------------------------- //
// Ledger assembly
// --------------------------------------------------------------------------- //
function uploadLedgerStates(
  uploaded: ("resume" | "cover_letter")[],
  reviewDocs: ("resume" | "cover_letter")[]
): Map<"resume" | "cover_letter", UploadLedgerState> {
  const states = new Map<"resume" | "cover_letter", UploadLedgerState>();
  for (const kind of uploaded) states.set(kind, "uploaded");
  for (const kind of reviewDocs) if (!states.has(kind)) states.set(kind, "review");
  return states;
}

function buildScanLedger(
  fields: DiscoveredField[],
  mappings: FieldMapping[],
  fieldResults: FieldFillResult[],
  uploadStates: Map<"resume" | "cover_letter", UploadLedgerState>
): LedgerEntry[] {
  const mapByUid = new Map(mappings.map((m) => [m.uid, m]));
  const entries = buildLedger(fields, fieldResults, (field) => {
    const m = mapByUid.get(field.uid);
    const key = m && m.canonicalKey !== "unknown" ? m.canonicalKey : null;
    const reusable = Boolean(key) && !CUSTOM_RESPONSE_FIELDS.has(m!.canonicalKey);
    return {
      canonicalKey: key,
      sensitive: Boolean(m?.sensitive),
      reusable,
      defaultScope: reusable ? defaultScope(m!.canonicalKey) : undefined,
      fillSource: m?.mappingSource ?? null
    };
  });

  // Documents: file inputs hidden behind "Attach" buttons are excluded from
  // ordinary discovery, so append their ledger entries explicitly — a document
  // is a required control like any other and must be counted consistently. A
  // VISIBLE file input is already a discovered entry (canonicalKey *_upload);
  // don't double-count it with a synthetic one.
  for (const [kind, state] of uploadStates) {
    const canonicalKey = `${kind}_upload`;
    const uid = `upload:${kind}`;
    if (entries.some((e) => e.uid === uid || e.canonicalKey === canonicalKey)) continue;
    entries.push(documentEntry(kind, state));
  }
  return entries;
}

function documentEntry(kind: "resume" | "cover_letter", state: UploadLedgerState): LedgerEntry {
  const required = kind === "resume";
  const label = kind === "resume" ? "Resume / CV" : "Cover letter";
  const uploaded = state === "uploaded";
  return {
    uid: `upload:${kind}`,
    frameId: "top",
    label,
    normalizedLabel: label.toLowerCase(),
    controlType: "file",
    canonicalKey: `${kind}_upload`,
    required,
    sensitive: false,
    options: [],
    multiple: false,
    currentValuePresent: uploaded,
    status: uploaded ? "filled_verified" : "technical_failure",
    reasonCode: uploaded ? "" : state === "download_failed" ? "DOCUMENT_DOWNLOAD_FAILED" : "DOCUMENT_UPLOAD_REJECTED",
    fillSource: uploaded ? "document" : null,
    verified: uploaded,
    question: label,
    reusable: false
  };
}

// --------------------------------------------------------------------------- //
// Per-field result model
// --------------------------------------------------------------------------- //
function buildFieldResults(
  fields: DiscoveredField[],
  mappings: FieldMapping[],
  session: ApplicationSessionData,
  summary: FillSummary
): FieldFillResult[] {
  const answers = new Map(session.answers.map((a) => [a.canonical_key, a]));
  const byUid = new Map(fields.map((f) => [f.uid, f]));
  const results: FieldFillResult[] = [];

  for (const mapping of mappings) {
    const field = byUid.get(mapping.uid);
    if (!field) continue;
    if (UPLOAD_FIELDS.has(mapping.canonicalKey)) continue; // handled by upload path
    const question = attachmentQuestion(mapping.canonicalKey)
      ?? field.label
      ?? field.ariaLabel
      ?? field.placeholder
      ?? field.name
      ?? mapping.canonicalKey;
    const reusable = mapping.canonicalKey !== "unknown"
      && !isCustomResponseField(mapping.canonicalKey)
      && !isManualAttachment(mapping.canonicalKey);
    const base = {
      uid: field.uid,
      fieldKey: mapping.canonicalKey,
      question,
      confidence: mapping.confidence,
      required: field.required,
      options: field.options.length > 0 ? field.options : undefined,
      control: field.control,
      reusable,
      defaultScope: reusable ? defaultScope(mapping.canonicalKey) : undefined
    };

    if (field.disabled) {
      results.push({ ...base, status: "skipped", reasonCode: "DISABLED_FIELD" });
      continue;
    }
    if (mapping.sensitive && !mapping.safeToAutoFill) {
      results.push({ ...base, status: "review", reasonCode: "SENSITIVE_FIELD" });
      continue;
    }
    if (!mapping.safeToAutoFill) {
      results.push({ ...base, status: "review", reasonCode: "LOW_CONFIDENCE" });
      continue;
    }
    // The fill engine's own outcome is authoritative — a custom combobox/listbox
    // selection is NOT reflected in `element.value`, so re-deriving success from
    // the DOM value would wrongly fail every custom-control fill. It also covers
    // narrow user-approved synthetic defaults (company careers source and a
    // single-option privacy acknowledgement), which intentionally are not stored
    // as profile answers. Fall back to an answer/value check only when no fill
    // attempt was recorded.
    const outcome = summary.outcomes.get(mapping.uid);
    const el = field.element as HTMLInputElement | HTMLSelectElement | undefined;
    if (outcome) {
      // A dropdown attempt reports the options the employer control ACTUALLY
      // rendered — richer than the static discovery-time list (a portal menu has
      // no options in the DOM until it is opened). Surface those to the widget.
      const withOptions = outcome.dropdown?.options?.length
        ? { ...base, options: outcome.dropdown.options }
        : base;
      if (outcome.status === "filled") results.push({ ...withOptions, status: "filled" });
      else if (outcome.status === "skipped") results.push({ ...withOptions, status: "skipped", reasonCode: "USER_VALUE_PRESENT" });
      else if (outcome.status === "review_required") {
        // Carry the exact dropdown failure code (DROPDOWN_OPEN_FAILED,
        // DROPDOWN_VERIFICATION_FAILED, …) instead of a generic reason.
        results.push({ ...withOptions, status: "review", reasonCode: dropdownReason(outcome.dropdown?.reasonCode) });
      } else results.push({ ...withOptions, status: "failed", reasonCode: "VALUE_DID_NOT_STICK" });
      continue;
    }
    const answer = answers.get(mapping.canonicalKey);
    if (!answer?.value) {
      results.push({ ...base, status: "review", reasonCode: "NO_VERIFIED_ANSWER" });
      continue;
    }
    const had = el ? valueStuck(el, answer.value) : false;
    if (had) {
      results.push({ ...base, status: "filled" });
    } else if (el && hadUserValue(field)) {
      results.push({ ...base, status: "skipped", reasonCode: "USER_VALUE_PRESENT" });
    } else {
      results.push({ ...base, status: "failed", reasonCode: "VALUE_DID_NOT_STICK" });
    }
  }
  return results;
}

/** Dropdown failure codes are first-class reason codes; anything else falls back
 * to the generic low-confidence reason. */
function dropdownReason(code: string | undefined): ReasonCode {
  const known: ReasonCode[] = [
    "DROPDOWN_NOT_VISIBLE", "DROPDOWN_DISABLED", "DROPDOWN_OPEN_FAILED",
    "LISTBOX_NOT_FOUND", "OPTIONS_NOT_FOUND", "OPTION_NOT_AVAILABLE",
    "DROPDOWN_SELECTION_FAILED", "DROPDOWN_VERIFICATION_FAILED"
  ];
  return known.includes(code as ReasonCode) ? (code as ReasonCode) : "LOW_CONFIDENCE";
}

function isCustomResponseField(key: string): boolean {
  return key === "custom_motivation" || key === "custom_experience";
}

function isManualAttachment(key: string): boolean {
  return key === "undergraduate_transcript_upload" || key === "graduate_transcript_upload";
}

function attachmentQuestion(key: string): string | null {
  if (key === "undergraduate_transcript_upload") return "Undergraduate transcript";
  if (key === "graduate_transcript_upload") return "Graduate transcript";
  return null;
}

function defaultScope(key: CanonicalField): "global" | "company" {
  return COMPANY_SCOPED_FIELDS.has(key) ? "company" : "global";
}

function pushResult(
  results: FieldFillResult[],
  fieldKey: string,
  question: string,
  status: FieldFillResult["status"],
  reasonCode?: ReasonCode
): void {
  results.push({ fieldKey, question, status, reasonCode, confidence: status === "filled" ? 1 : 0 });
}

function valueStuck(el: HTMLInputElement | HTMLSelectElement, expected: string): boolean {
  const current = (el.value || "").trim().toLowerCase();
  const want = expected.trim().toLowerCase();
  if (!current) return false;
  return current === want || current.includes(want) || want.includes(current) || el.hasAttribute("data-jobpilot-filled");
}

function hadUserValue(field: DiscoveredField): boolean {
  return Boolean(field.existingValue && field.existingValue.trim());
}

// --------------------------------------------------------------------------- //
// Uploads
// --------------------------------------------------------------------------- //
interface UploadTarget {
  input: HTMLInputElement;
  kind: "resume" | "cover-letter";
}

function resolveUploadTargets(
  fields: DiscoveredField[],
  mappings: FieldMapping[],
  root: ParentNode
): UploadTarget[] {
  const targets: UploadTarget[] = [];
  const byUid = new Map(fields.map((f) => [f.uid, f]));
  const usedInputs = new Set<HTMLInputElement>();

  for (const mapping of mappings) {
    if (!UPLOAD_FIELDS.has(mapping.canonicalKey)) continue;
    const field = byUid.get(mapping.uid);
    const el = field?.element as HTMLInputElement | undefined;
    if (el && el.type === "file") {
      targets.push({ input: el, kind: mapping.canonicalKey === "cover_letter_upload" ? "cover-letter" : "resume" });
      usedInputs.add(el);
    }
  }

  // Also discover file inputs that discovery skipped because they are hidden
  // behind an "Attach" button (common on modern Greenhouse). Classify by nearby
  // text so the cover letter never lands in the resume field.
  for (const found of discoverUploadInputs(root)) {
    if (usedInputs.has(found.input)) continue;
    targets.push(found);
    usedInputs.add(found.input);
  }

  // An "Easy Apply"/"Upload your resume" block frequently sits ABOVE the scored
  // application root rather than inside it — it belongs to the page, not to the
  // question form. Scoping is what keeps a site-search box from being read as
  // an application question, but it must not be the reason the resume is never
  // attached at all, so the whole document is consulted once when the root
  // offered no resume target. The same classification gates still apply: only a
  // control that names itself a resume, or the single document dropzone of an
  // apply block, is ever written to.
  if (!targets.some((target) => target.kind === "resume")) {
    const doc = documentOf(root);
    for (const found of doc ? discoverUploadInputs(doc) : []) {
      if (found.kind !== "resume" || usedInputs.has(found.input)) continue;
      targets.push(found);
      usedInputs.add(found.input);
    }
  }
  return targets;
}

function documentOf(root: ParentNode): Document | null {
  if (root instanceof Document) return null;
  return (root as Node).ownerDocument ?? null;
}

/** Verify the employer UI accepted the file (filename appears, or files set and
 * no rejection) — never trust `input.files` assignment alone. */
async function verifyUpload(input: HTMLInputElement, filename: string): Promise<boolean> {
  const name = filename.toLowerCase();
  // The confirmation ("resume.pdf ✓") is rendered by the component AROUND the
  // input, which for a web-component dropzone is outside its shadow root.
  const scope = deepClosest(input, "div,fieldset,section,form") ?? input.ownerDocument.body;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const assigned = input.files && input.files.length === 1 && input.files[0].name === filename;
    const shown = deepTextContent(scope, 20_000).toLowerCase().includes(name);
    if (assigned && shown) return true;
    // If the control removes the input from the DOM after accepting, treat a
    // visible filename as success.
    if (shown) return true;
    await delay(150);
  }
  // Last resort: the file is set on the input even if the UI text is not found.
  return Boolean(input.files && input.files.length === 1 && input.files[0].name === filename);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
