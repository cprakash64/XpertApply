/**
 * The authoritative record of what happened to every application question.
 *
 * One entry per field, keyed by the same opaque `field_ref` the resolver uses,
 * so retry, a React remount, or a content-script reinjection all UPDATE an
 * entry rather than adding another. That single-entry rule is what makes the
 * widget's totals reconcilable — the previous counters were maintained
 * independently and could disagree with each other ("Filled 0 of 0" beside
 * "Discovered 11 / Filled 1").
 *
 * Entries hold enums, counts and timestamps only: never an answer, never the
 * question text, never anything identifying.
 */

export type QuestionState =
  | "discovered"
  | "enumerating_options"
  | "canonicalizing"
  | "canonicalized"
  | "answer_resolved"
  | "answer_missing"
  | "requires_confirmation"
  | "requires_user_gesture"
  | "selecting"
  | "filled_verified"
  | "interaction_failed"
  | "sensitive_manual"
  | "optional_skipped"
  | "unsupported";

export interface QuestionEntry {
  fieldKey: string;
  controlType: string;
  state: QuestionState;
  previousState: QuestionState | null;
  reasonCode: string;
  required: boolean;
  canonicalCategory: string | null;
  sensitivity: string | null;
  retryCount: number;
  lastTransitionAt: number;
  /** The answer applied here came from the user answering THIS application, not
   * from their reusable profile. Drives the provenance line the user reads, and
   * is why that line must never say "saved to your profile". */
  applicationOverride: boolean;
  /** The user explicitly chose to leave this one for themselves. A required
   * field stays in the review list either way — deferring is not resolving. */
  deferred: boolean;
}

export interface QuestionCounts {
  discovered: number;
  filled_and_verified: number;
  needs_information: number;
  needs_confirmation: number;
  needs_user_gesture: number;
  technical_issues: number;
  legal_manual_actions: number;
  optional_skipped: number;
  unsupported: number;
}

/**
 * Which states may follow which.
 *
 * The point is not bureaucracy — it is that a late or duplicated event must
 * never walk a field backwards. A `filled_verified` field that receives a
 * stale "discovered" event stays filled, because the employer page still shows
 * the value; only a genuine re-selection attempt may move it on.
 */
const ALLOWED: Record<QuestionState, QuestionState[]> = {
  discovered: [
    "enumerating_options",
    "canonicalizing",
    "unsupported",
    "optional_skipped",
    "sensitive_manual"
  ],
  enumerating_options: [
    "canonicalizing",
    "requires_user_gesture",
    "interaction_failed",
    "unsupported"
  ],
  canonicalizing: [
    "canonicalized",
    "answer_resolved",
    "answer_missing",
    "requires_confirmation",
    "sensitive_manual",
    "unsupported"
  ],
  canonicalized: ["answer_resolved", "answer_missing", "requires_confirmation", "unsupported"],
  answer_resolved: ["selecting", "interaction_failed"],
  selecting: ["filled_verified", "interaction_failed"],
  // Terminal-ish: a field the user must act on. It leaves only when the user
  // does act, which re-enters the pipeline at enumeration or canonicalization —
  // or when the user explicitly defers an OPTIONAL one, which is the only way
  // `optional_skipped` may be reached from a state that was awaiting them.
  answer_missing: [
    "canonicalizing",
    "enumerating_options",
    "answer_resolved",
    "selecting",
    "optional_skipped"
  ],
  requires_confirmation: ["canonicalizing", "answer_resolved", "selecting", "optional_skipped"],
  requires_user_gesture: [
    "enumerating_options",
    "canonicalizing",
    // Semantic resolution can succeed even though the preflight option probe
    // needed a trusted click. The actuator still runs and owns the final
    // filled/technical classification.
    "answer_resolved",
    "selecting",
    "interaction_failed",
    "optional_skipped"
  ],
  interaction_failed: [
    "selecting",
    "enumerating_options",
    "canonicalizing",
    "answer_resolved",
    "optional_skipped"
  ],
  // A verified fill is only revisited when the value is actually gone, or when
  // the user gives a NEW answer for this application and it is re-applied.
  // A lower-authority unresolved descriptor may not erase a verified primary
  // result. If the page later clears the DOM value, verification reports an
  // interaction failure; semantic "missing" is not evidence of that.
  filled_verified: ["selecting"],
  // Consent is never skipped on the user's behalf, so no path to
  // `optional_skipped` exists from here at all.
  sensitive_manual: ["canonicalizing"],
  optional_skipped: ["canonicalizing"],
  unsupported: ["canonicalizing", "enumerating_options", "optional_skipped"]
};

export function canTransition(from: QuestionState, to: QuestionState): boolean {
  if (from === to) return true;
  return (ALLOWED[from] ?? []).includes(to);
}

export interface TransitionInput {
  fieldKey: string;
  state: QuestionState;
  reasonCode: string;
  controlType?: string;
  required?: boolean;
  canonicalCategory?: string | null;
  sensitivity?: string | null;
  /** Set when the applied answer came from an application-scoped override. Only
   * ever raised — a later automatic pass cannot un-say what the user answered
   * for this application. */
  applicationOverride?: boolean;
  deferred?: boolean;
}

export interface FinalVerificationInput extends TransitionInput {
  state: "filled_verified" | "interaction_failed" | "sensitive_manual";
}

export class QuestionLedger {
  private entries = new Map<string, QuestionEntry>();

  /** Record or advance one field. Returns the entry as it now stands. */
  record(input: TransitionInput, now = Date.now()): QuestionEntry {
    const existing = this.entries.get(input.fieldKey);

    if (!existing) {
      const entry: QuestionEntry = {
        fieldKey: input.fieldKey,
        controlType: input.controlType ?? "unknown",
        state: input.state,
        previousState: null,
        reasonCode: input.reasonCode,
        required: Boolean(input.required),
        canonicalCategory: input.canonicalCategory ?? null,
        sensitivity: input.sensitivity ?? null,
        retryCount: 0,
        lastTransitionAt: now,
        applicationOverride: Boolean(input.applicationOverride),
        deferred: Boolean(input.deferred)
      };
      this.entries.set(input.fieldKey, entry);
      return entry;
    }

    // An out-of-order or duplicated event leaves the entry exactly as it was.
    if (!canTransition(existing.state, input.state)) return existing;

    if (existing.state !== input.state) {
      existing.previousState = existing.state;
      existing.state = input.state;
      existing.lastTransitionAt = now;
    }
    // Re-entering `selecting` after a failure is a genuine retry.
    if (input.state === "selecting" && existing.previousState === "interaction_failed") {
      existing.retryCount += 1;
    }
    existing.reasonCode = input.reasonCode;
    if (input.controlType) existing.controlType = input.controlType;
    // A recognised question does not become unrecognised. A later batch that
    // failed to match the wording — a re-render that truncates the label, a
    // control whose question moved out of view — must not erase a key an earlier
    // registry match established. Losing it is not cosmetic: the targeted
    // refresh finds a question and its dependents BY canonical key, and the
    // review item's answer action exists only while the key does.
    if (input.canonicalCategory !== undefined) {
      if (input.canonicalCategory !== null || existing.canonicalCategory === null) {
        existing.canonicalCategory = input.canonicalCategory;
      }
    }
    if (input.sensitivity !== undefined) existing.sensitivity = input.sensitivity;
    if (input.required !== undefined) existing.required = input.required;
    // Sticky: once an answer for THIS application has been applied here, a
    // later automatic pass over the same field must not relabel its provenance
    // as the reusable profile. Only an explicit `false` clears it.
    if (input.applicationOverride === true) existing.applicationOverride = true;
    else if (input.applicationOverride === false) existing.applicationOverride = false;
    if (input.deferred !== undefined) existing.deferred = input.deferred;
    return existing;
  }

  /**
   * Apply the current-DOM verdict immediately before REVIEW_READY.
   *
   * Normal transitions reject out-of-order events, but final verification has
   * stronger evidence than historical events: a control that was once verified
   * and is blank now must become technical, while an optional placeholder may
   * not overwrite a live verified result. This is the sole intentional escape
   * hatch from the ordinary transition graph.
   */
  recordFinalVerification(input: FinalVerificationInput, now = Date.now()): QuestionEntry {
    const existing = this.entries.get(input.fieldKey);
    if (!existing) return this.record(input, now);
    if (existing.state !== input.state) {
      existing.previousState = existing.state;
      existing.state = input.state;
      existing.lastTransitionAt = now;
    }
    existing.reasonCode = input.reasonCode;
    existing.required = Boolean(input.required);
    if (input.controlType) existing.controlType = input.controlType;
    if (input.canonicalCategory !== undefined && input.canonicalCategory !== null) {
      existing.canonicalCategory = input.canonicalCategory;
    }
    if (input.sensitivity !== undefined) existing.sensitivity = input.sensitivity;
    return existing;
  }

  get(fieldKey: string): QuestionEntry | undefined {
    return this.entries.get(fieldKey);
  }

  all(): QuestionEntry[] {
    return Array.from(this.entries.values());
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  counts(): QuestionCounts {
    return computeQuestionCounts(this.all());
  }

  stage(): WidgetStageName {
    return deriveStage(this.all());
  }
}

/**
 * Every state maps to exactly ONE summary bucket.
 *
 * Keeping this a total function over the state union is what guarantees the
 * buckets sum to `discovered`: a new state cannot be added without deciding
 * where it counts.
 */
function bucketOf(state: QuestionState): keyof Omit<QuestionCounts, "discovered"> | "in_progress" {
  switch (state) {
    case "filled_verified":
      return "filled_and_verified";
    case "answer_missing":
      return "needs_information";
    case "requires_confirmation":
      return "needs_confirmation";
    case "requires_user_gesture":
      return "needs_user_gesture";
    case "interaction_failed":
      return "technical_issues";
    case "sensitive_manual":
      return "legal_manual_actions";
    case "optional_skipped":
      return "optional_skipped";
    case "unsupported":
      return "unsupported";
    default:
      // discovered / enumerating / canonicalizing / canonicalized /
      // answer_resolved / selecting — still moving, not yet an outcome.
      return "in_progress";
  }
}

export function computeQuestionCounts(entries: QuestionEntry[]): QuestionCounts {
  const counts: QuestionCounts = {
    discovered: entries.length,
    filled_and_verified: 0,
    needs_information: 0,
    needs_confirmation: 0,
    needs_user_gesture: 0,
    technical_issues: 0,
    legal_manual_actions: 0,
    optional_skipped: 0,
    unsupported: 0
  };
  for (const entry of entries) {
    const bucket = bucketOf(entry.state);
    if (bucket !== "in_progress") counts[bucket] += 1;
  }
  return counts;
}

/** How many fields are still mid-flight (discovered but not yet an outcome). */
export function inProgressCount(entries: QuestionEntry[]): number {
  return entries.filter((entry) => bucketOf(entry.state) === "in_progress").length;
}

/**
 * The invariants that make the totals trustworthy. Checked in tests and cheap
 * enough to assert at runtime.
 */
export function questionCountsReconcile(entries: QuestionEntry[]): boolean {
  const counts = computeQuestionCounts(entries);
  const bucketed =
    counts.filled_and_verified +
    counts.needs_information +
    counts.needs_confirmation +
    counts.needs_user_gesture +
    counts.technical_issues +
    counts.legal_manual_actions +
    counts.optional_skipped +
    counts.unsupported +
    inProgressCount(entries);
  if (bucketed !== counts.discovered) return false;
  if (counts.filled_and_verified > counts.discovered) return false;
  return counts.discovered === entries.length;
}

export type WidgetStageName =
  | "understanding_questions"
  | "reading_options"
  | "matching_answers"
  | "filling"
  | "waiting_for_you"
  | "ready_for_review";

export const STAGE_LABEL: Record<WidgetStageName, string> = {
  understanding_questions: "Understanding questions",
  reading_options: "Reading available options",
  matching_answers: "Matching your saved answers",
  filling: "Filling verified answers",
  waiting_for_you: "Waiting for your input",
  ready_for_review: "Ready for final review"
};

/**
 * Which stage the run is in, derived purely from the ledger.
 *
 * Ordered by what is actually happening right now, so the label can never
 * claim "Detecting fields" after discovery finished.
 */
export function deriveStage(entries: QuestionEntry[]): WidgetStageName {
  if (entries.length === 0) return "understanding_questions";
  const states = new Set(entries.map((entry) => entry.state));

  if (states.has("enumerating_options")) return "reading_options";
  if (states.has("selecting")) return "filling";
  if (states.has("canonicalizing") || states.has("discovered")) return "matching_answers";
  if (states.has("answer_resolved")) return "filling";

  const needsUser =
    states.has("answer_missing") ||
    states.has("requires_confirmation") ||
    states.has("requires_user_gesture") ||
    states.has("sensitive_manual") ||
    states.has("interaction_failed");
  return needsUser ? "waiting_for_you" : "ready_for_review";
}


// --------------------------------------------------------------------------- //
// Scalar-fill adaptation
// --------------------------------------------------------------------------- //
/**
 * Ordinary autofill (names, email, phone, free text) runs through its own
 * per-field ledger in `fields/ledger.ts`. That ledger stays — it owns the
 * review list and per-field fill detail — but its COUNTS must not reach the
 * widget independently, because two summaries maintained side by side is
 * exactly how "Filled 0 of 0" ended up next to "Discovered 11 / Filled 1".
 *
 * This maps a scalar fill status onto the authoritative state so both kinds of
 * field are counted once, in one place.
 */
export function stateFromScalarStatus(status: string): QuestionState {
  switch (status) {
    case "filled_verified":
    case "user_entered":
      return "filled_verified";
    // Filled, but the value still needs the user's eye: not a verified fill.
    case "filled_needs_review":
      return "requires_confirmation";
    case "missing_information":
      return "answer_missing";
    case "needs_confirmation":
      return "requires_confirmation";
    case "technical_failure":
      return "interaction_failed";
    case "intentionally_skipped_optional":
      return "optional_skipped";
    case "unsupported_control":
      return "unsupported";
    case "not_applicable":
      return "optional_skipped";
    default:
      return "unsupported";
  }
}

export interface ScalarLedgerLike {
  uid: string;
  frameId?: string;
  status: string;
  controlType?: string;
  required?: boolean;
  sensitive?: boolean;
  canonicalKey?: string | null;
}

/**
 * Fold scalar-fill entries into the authoritative ledger.
 *
 * Keyed the same way the resolver keys questions (`f_<frame>_<uid>`), so a
 * control that went through BOTH paths — resolved as a question and then
 * touched by the scalar filler — updates one entry rather than being counted
 * twice. Transition rules still apply, so a verified fill cannot be walked
 * backwards by a later scalar pass.
 */
export function absorbScalarLedger(
  ledger: QuestionLedger,
  entries: ScalarLedgerLike[],
  now = Date.now()
): void {
  for (const entry of entries) {
    const fieldKey = `f_${entry.frameId ?? "top"}_${entry.uid}`;

    // Once the question resolver has reached a terminal state, it is
    // authoritative for that control. The scalar scanner can describe the same
    // custom combobox differently (notably as optional because `required` lives
    // on its wrapper), but that must not erase a required legal question or
    // replace `answer_missing` with a heuristic interaction failure.
    const existing = ledger.get(fieldKey);
    if (existing && ![
      "discovered",
      "enumerating_options",
      "canonicalizing",
      "answer_resolved",
      "selecting"
    ].includes(existing.state)) continue;

    ledger.record(
      {
        fieldKey,
        state: entry.sensitive
          ? "sensitive_manual"
          : stateFromScalarStatus(entry.status),
        reasonCode: entry.status,
        controlType: entry.controlType ?? "text",
        required: Boolean(entry.required),
        // The QUESTION resolver's canonicalization WINS, and is never
        // overwritten here. It is a deterministic registry match made
        // server-side; the scalar mapper is heuristic label matching, and on a
        // page asking all three sponsorship questions it reads the combined
        // "will you NOW OR IN THE FUTURE require sponsorship" as the future
        // component. Letting that guess through silently stopped the combined
        // question from being re-resolved when a component was answered, because
        // the targeted refresh finds dependent fields BY canonical key.
        //
        // `undefined` rather than `null` for the same reason: no opinion must
        // not read as "this control has no canonical question".
        canonicalCategory: existing?.canonicalCategory ?? entry.canonicalKey ?? undefined,
        sensitivity: entry.sensitive ? "sensitive" : undefined
      },
      now
    );
  }
}
