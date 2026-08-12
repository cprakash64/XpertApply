import { describe, expect, it } from "vitest";
import {
  QuestionLedger,
  canTransition,
  computeQuestionCounts,
  deriveStage,
  questionCountsReconcile,
  absorbScalarLedger,
  stateFromScalarStatus,
  type QuestionState
} from "../content/questionLedger";

/**
 * The ledger exists to make the widget's totals trustworthy. The defect it
 * replaces was independent counters that could show "Filled 0 of 0" beside
 * "Discovered 11 / Filled 1", so most of these assert reconciliation rather
 * than individual numbers.
 */

/** Walk each field to its target state along a LEGAL path. */
function ledgerWith(states: QuestionState[]): QuestionLedger {
  const ledger = new QuestionLedger();
  states.forEach((state, index) => {
    const key = `f${index}`;
    const step = (next: QuestionState) => ledger.record({ fieldKey: key, state: next, reasonCode: "seed" });

    step("discovered");
    if (state === "discovered") return;

    // Some outcomes are reachable straight from discovery (a field skipped as
    // optional, or recognised as manual/unsupported before canonicalization).
    if (canTransition("discovered", state)) {
      step(state);
      return;
    }

    if (state === "enumerating_options" || state === "requires_user_gesture") {
      step("enumerating_options");
      if (state === "requires_user_gesture") step("requires_user_gesture");
      return;
    }

    step("canonicalizing");
    if (state === "canonicalizing") return;

    if (["answer_resolved", "selecting", "filled_verified", "interaction_failed"].includes(state)) {
      step("answer_resolved");
      if (state === "answer_resolved") return;
      step("selecting");
      if (state === "selecting") return;
      step(state);
      return;
    }

    step(state);
  });
  return ledger;
}

describe("one entry per field", () => {
  it("keeps a single entry no matter how often a field is recorded", () => {
    const ledger = new QuestionLedger();
    for (let i = 0; i < 10; i++) {
      ledger.record({ fieldKey: "same", state: "discovered", reasonCode: "rescan" });
    }
    expect(ledger.size).toBe(1);
    expect(ledger.counts().discovered).toBe(1);
  });

  it("updates rather than duplicates across a remount-style rescan", () => {
    const ledger = new QuestionLedger();
    ledger.record({ fieldKey: "a", state: "discovered", reasonCode: "first" });
    ledger.record({ fieldKey: "a", state: "canonicalizing", reasonCode: "second" });
    ledger.record({ fieldKey: "a", state: "answer_missing", reasonCode: "third" });
    expect(ledger.size).toBe(1);
    expect(ledger.get("a")?.state).toBe("answer_missing");
    expect(ledger.get("a")?.previousState).toBe("canonicalizing");
  });

  it("counts a retry without adding an entry", () => {
    const ledger = new QuestionLedger();
    ledger.record({ fieldKey: "a", state: "discovered", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "canonicalizing", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "answer_resolved", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "selecting", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "interaction_failed", reasonCode: "boom" });
    ledger.record({ fieldKey: "a", state: "selecting", reasonCode: "retry" });
    expect(ledger.size).toBe(1);
    expect(ledger.get("a")?.retryCount).toBe(1);
  });
});

describe("state transitions", () => {
  it("allows the happy path", () => {
    const path: QuestionState[] = [
      "discovered", "enumerating_options", "canonicalizing", "answer_resolved", "selecting", "filled_verified"
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("does not walk a verified field backwards", () => {
    expect(canTransition("filled_verified", "discovered")).toBe(false);
    expect(canTransition("filled_verified", "canonicalizing")).toBe(false);
    // It may be re-selected, but a later unresolved descriptor cannot erase it.
    expect(canTransition("filled_verified", "selecting")).toBe(true);
    expect(canTransition("filled_verified", "answer_missing")).toBe(false);
  });

  it("ignores an out-of-order event instead of corrupting the entry", () => {
    const ledger = new QuestionLedger();
    ledger.record({ fieldKey: "a", state: "discovered", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "canonicalizing", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "answer_resolved", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "selecting", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "filled_verified", reasonCode: "ok" });

    // A late duplicate from an earlier pass.
    ledger.record({ fieldKey: "a", state: "discovered", reasonCode: "stale" });
    expect(ledger.get("a")?.state).toBe("filled_verified");
  });

  it("treats a repeated identical event as a no-op", () => {
    const ledger = new QuestionLedger();
    ledger.record({ fieldKey: "a", state: "answer_missing", reasonCode: "x" });
    const first = ledger.get("a")?.lastTransitionAt;
    ledger.record({ fieldKey: "a", state: "answer_missing", reasonCode: "x" });
    expect(ledger.get("a")?.lastTransitionAt).toBe(first);
    expect(ledger.size).toBe(1);
  });

  it("lets a user-gesture field re-enter the pipeline", () => {
    expect(canTransition("requires_user_gesture", "enumerating_options")).toBe(true);
    expect(canTransition("requires_user_gesture", "canonicalizing")).toBe(true);
    expect(canTransition("requires_user_gesture", "answer_resolved")).toBe(true);
    expect(canTransition("requires_user_gesture", "selecting")).toBe(true);
  });
});

describe("counters", () => {
  it("puts every state in exactly one bucket and reconciles", () => {
    const every: QuestionState[] = [
      "discovered", "enumerating_options", "canonicalizing", "canonicalized",
      "answer_resolved", "answer_missing", "requires_confirmation", "requires_user_gesture",
      "selecting", "filled_verified", "interaction_failed", "sensitive_manual",
      "optional_skipped", "unsupported"
    ];
    const ledger = ledgerWith(every);
    expect(questionCountsReconcile(ledger.all())).toBe(true);
    expect(ledger.counts().discovered).toBe(every.length);
  });

  it("counts filled only for filled_verified", () => {
    const ledger = ledgerWith(["filled_verified", "selecting", "answer_resolved", "interaction_failed"]);
    expect(ledger.counts().filled_and_verified).toBe(1);
  });

  it("never reports more filled than discovered", () => {
    const ledger = ledgerWith(["filled_verified", "filled_verified", "answer_missing"]);
    const counts = ledger.counts();
    expect(counts.filled_and_verified).toBeLessThanOrEqual(counts.discovered);
  });

  it("keeps missing information and technical failure separate", () => {
    const ledger = ledgerWith(["answer_missing", "interaction_failed"]);
    const counts = ledger.counts();
    expect(counts.needs_information).toBe(1);
    expect(counts.technical_issues).toBe(1);
  });

  it("does not count a still-moving field as an outcome", () => {
    const ledger = ledgerWith(["selecting", "canonicalizing"]);
    const counts = ledger.counts();
    expect(counts.discovered).toBe(2);
    expect(counts.filled_and_verified).toBe(0);
    expect(counts.needs_information).toBe(0);
    expect(questionCountsReconcile(ledger.all())).toBe(true);
  });

  it("makes the previous contradictory summary impossible", () => {
    // The old defect: discovered 11, filled 1, yet "Filled 0 of 0".
    const ledger = ledgerWith([
      "filled_verified", ...Array<QuestionState>(10).fill("answer_missing")
    ]);
    const counts = ledger.counts();
    expect(counts.discovered).toBe(11);
    expect(counts.filled_and_verified).toBe(1);
    // The widget total IS the ledger total; there is no second source.
    expect(questionCountsReconcile(ledger.all())).toBe(true);
  });

  it("reconciles an empty ledger", () => {
    expect(questionCountsReconcile([])).toBe(true);
    expect(computeQuestionCounts([]).discovered).toBe(0);
  });
});

describe("stages", () => {
  it("reads options while enumeration is active", () => {
    expect(deriveStage(ledgerWith(["enumerating_options", "answer_missing"]).all())).toBe("reading_options");
  });

  it("fills while a selection is in flight", () => {
    expect(deriveStage(ledgerWith(["selecting"]).all())).toBe("filling");
  });

  it("waits for the user when unresolved work remains", () => {
    for (const state of ["answer_missing", "requires_confirmation", "requires_user_gesture", "sensitive_manual", "interaction_failed"] as QuestionState[]) {
      expect(deriveStage(ledgerWith([state]).all()), state).toBe("waiting_for_you");
    }
  });

  it("is ready for review only when everything safe is done", () => {
    expect(deriveStage(ledgerWith(["filled_verified", "optional_skipped"]).all())).toBe("ready_for_review");
  });

  it("never claims to be detecting fields after discovery", () => {
    const stages = [
      deriveStage(ledgerWith(["filled_verified"]).all()),
      deriveStage(ledgerWith(["answer_missing"]).all()),
      deriveStage(ledgerWith(["enumerating_options"]).all())
    ];
    for (const stage of stages) expect(stage).not.toBe("understanding_questions");
  });
});

describe("privacy", () => {
  it("stores no answer or question text", () => {
    const ledger = new QuestionLedger();
    ledger.record({
      fieldKey: "a", state: "filled_verified", reasonCode: "verified",
      controlType: "combobox", canonicalCategory: "work_authorization_us", sensitivity: "legal"
    });
    const serialized = JSON.stringify(ledger.all());
    expect(serialized).not.toContain("Yes");
    expect(serialized).not.toContain("authorized to work");
    expect(Object.keys(ledger.get("a")!)).not.toContain("value");
  });
});

describe("one global ledger across both autofill paths", () => {
  it("counts scalar and question fields together, once each", () => {
    const ledger = new QuestionLedger();
    // A resolved legal dropdown…
    ledger.record({ fieldKey: "f_top_q1", state: "discovered", reasonCode: "x" });
    ledger.record({ fieldKey: "f_top_q1", state: "canonicalizing", reasonCode: "x" });
    ledger.record({ fieldKey: "f_top_q1", state: "answer_resolved", reasonCode: "x" });
    ledger.record({ fieldKey: "f_top_q1", state: "selecting", reasonCode: "x" });
    ledger.record({ fieldKey: "f_top_q1", state: "filled_verified", reasonCode: "verified" });

    // …plus ordinary scalar fields from the other path.
    absorbScalarLedger(ledger, [
      { uid: "s1", frameId: "top", status: "filled_verified", required: true },
      { uid: "s2", frameId: "top", status: "missing_information", required: true },
      { uid: "s3", frameId: "top", status: "technical_failure" },
      { uid: "s4", frameId: "top", status: "intentionally_skipped_optional" },
      { uid: "s5", frameId: "top", status: "unsupported_control" },
      { uid: "s6", frameId: "top", status: "filled_verified", sensitive: true }
    ]);

    const counts = ledger.counts();
    expect(counts.discovered).toBe(7);
    expect(counts.filled_and_verified).toBe(2);
    expect(counts.needs_information).toBe(1);
    expect(counts.technical_issues).toBe(1);
    expect(counts.optional_skipped).toBe(1);
    expect(counts.unsupported).toBe(1);
    expect(counts.legal_manual_actions).toBe(1);
    expect(questionCountsReconcile(ledger.all())).toBe(true);
  });

  it("does not double-count a control seen by both paths", () => {
    const ledger = new QuestionLedger();
    ledger.record({ fieldKey: "f_top_a", state: "discovered", reasonCode: "question" });
    ledger.record({ fieldKey: "f_top_a", state: "canonicalizing", reasonCode: "question" });
    ledger.record({ fieldKey: "f_top_a", state: "answer_missing", reasonCode: "missing" });
    // The scalar filler then touches the very same control.
    absorbScalarLedger(ledger, [{ uid: "a", frameId: "top", status: "missing_information" }]);
    expect(ledger.size).toBe(1);
    expect(ledger.counts().discovered).toBe(1);
  });

  it("does not let a later scalar pass undo a verified fill", () => {
    const ledger = new QuestionLedger();
    ledger.record({ fieldKey: "f_top_a", state: "discovered", reasonCode: "x" });
    ledger.record({ fieldKey: "f_top_a", state: "canonicalizing", reasonCode: "x" });
    ledger.record({ fieldKey: "f_top_a", state: "answer_resolved", reasonCode: "x" });
    ledger.record({ fieldKey: "f_top_a", state: "selecting", reasonCode: "x" });
    ledger.record({ fieldKey: "f_top_a", state: "filled_verified", reasonCode: "verified" });
    absorbScalarLedger(ledger, [{ uid: "a", frameId: "top", status: "missing_information" }]);
    expect(ledger.get("f_top_a")?.state).toBe("filled_verified");
  });

  it("does not let an optional scalar description erase a required missing question", () => {
    const ledger = new QuestionLedger();
    ledger.record({ fieldKey: "f_top_a", state: "discovered", reasonCode: "question", required: true });
    ledger.record({ fieldKey: "f_top_a", state: "canonicalizing", reasonCode: "question", required: true });
    ledger.record({
      fieldKey: "f_top_a",
      state: "answer_missing",
      reasonCode: "answer_missing",
      required: true,
      canonicalCategory: "work_authorization_us"
    });
    absorbScalarLedger(ledger, [{
      uid: "a",
      frameId: "top",
      status: "intentionally_skipped_optional",
      required: false
    }]);
    expect(ledger.get("f_top_a")).toMatchObject({
      state: "answer_missing",
      required: true,
      canonicalCategory: "work_authorization_us"
    });
  });

  it("lets final live-DOM verification override an obsolete optional placeholder", () => {
    const ledger = new QuestionLedger();
    ledger.record({ fieldKey: "f_top_a", state: "optional_skipped", reasonCode: "old", required: false });
    ledger.recordFinalVerification({
      fieldKey: "f_top_a",
      state: "interaction_failed",
      reasonCode: "REQUIRED_CONTROL_UNVERIFIED",
      required: true,
      canonicalCategory: "work_authorization_us"
    });
    expect(ledger.get("f_top_a")).toMatchObject({
      state: "interaction_failed",
      required: true,
      canonicalCategory: "work_authorization_us"
    });
  });

  it("maps every scalar status to a real state", () => {
    const statuses = [
      "filled_verified", "filled_needs_review", "missing_information", "needs_confirmation",
      "intentionally_skipped_optional", "unsupported_control", "technical_failure",
      "user_entered", "not_applicable"
    ];
    for (const status of statuses) {
      expect(typeof stateFromScalarStatus(status), status).toBe("string");
    }
    // A partially-filled value is NOT a verified fill.
    expect(stateFromScalarStatus("filled_needs_review")).toBe("requires_confirmation");
    expect(stateFromScalarStatus("user_entered")).toBe("filled_verified");
  });

  it("reconciles a realistic mixed page", () => {
    const ledger = new QuestionLedger();
    for (const key of ["q1", "q2"]) {
      ledger.record({ fieldKey: `f_top_${key}`, state: "discovered", reasonCode: "x" });
      ledger.record({ fieldKey: `f_top_${key}`, state: "canonicalizing", reasonCode: "x" });
    }
    ledger.record({ fieldKey: "f_top_q1", state: "answer_missing", reasonCode: "missing" });
    ledger.record({ fieldKey: "f_top_q2", state: "sensitive_manual", reasonCode: "consent" });
    absorbScalarLedger(ledger, [
      { uid: "n1", frameId: "top", status: "filled_verified" },
      { uid: "n2", frameId: "top", status: "filled_verified" },
      { uid: "n3", frameId: "top", status: "technical_failure" }
    ]);
    const counts = ledger.counts();
    expect(counts.discovered).toBe(5);
    expect(counts.filled_and_verified).toBe(2);
    expect(counts.filled_and_verified).toBeLessThanOrEqual(counts.discovered);
    expect(questionCountsReconcile(ledger.all())).toBe(true);
  });
});
