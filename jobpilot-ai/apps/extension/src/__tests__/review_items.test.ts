import { describe, expect, it, vi } from "vitest";
import {
  buildAuthoritativeReviewItems,
  focusReviewTarget,
  reviewItemsMatchCounts
} from "../content/reviewItems";
import { REVIEW_ACTIONS } from "../content/reviewActions";
import { QuestionLedger, computeQuestionCounts, type QuestionState } from "../content/questionLedger";

/**
 * Review items exist to describe the SAME fields the summary counts. These
 * assert that correspondence, and that nothing internal reaches the user.
 */

function entry(fieldKey: string, state: QuestionState, extra: Record<string, unknown> = {}) {
  return {
    fieldKey,
    controlType: "combobox",
    state,
    previousState: null,
    reasonCode: "seed",
    required: false,
    canonicalCategory: null,
    sensitivity: null,
    retryCount: 0,
    lastTransitionAt: 0,
    applicationOverride: false,
    deferred: false,
    ...extra
  };
}

describe("review items derive from the ledger", () => {
  it("creates one item per reviewable field and none for settled ones", () => {
    const items = buildAuthoritativeReviewItems([
      entry("a", "answer_missing"),
      entry("b", "filled_verified"),
      entry("c", "requires_confirmation"),
      entry("d", "selecting"),
      entry("e", "optional_skipped")
    ]);
    expect(items.map((i) => i.fieldKey).sort()).toEqual(["a", "c"]);
  });

  it("names the specific legal question when it is known", () => {
    const items = buildAuthoritativeReviewItems([
      entry("a", "answer_missing", { canonicalCategory: "work_authorization_us", sensitivity: "legal" }),
      entry("b", "answer_missing", { canonicalCategory: "sponsorship_required_now" }),
      entry("c", "answer_missing", { canonicalCategory: "sponsorship_required_future" }),
      entry("d", "answer_missing", { canonicalCategory: "source_where_heard_about_job" })
    ]);
    const titles = items.map((i) => i.title);
    expect(titles).toContain("Work authorization answer needed");
    expect(titles).toContain("Current sponsorship answer needed");
    expect(titles).toContain("Future sponsorship answer needed");
    expect(titles).toContain("Job-source answer needed");
  });

  it("falls back to safe wording for an unrecognised question", () => {
    const items = buildAuthoritativeReviewItems([
      entry("a", "answer_missing", { canonicalCategory: "some_internal_key_v2" })
    ]);
    expect(items[0].title).toBe("This question needs your answer");
    // The key itself must never surface.
    expect(JSON.stringify(items[0].title + items[0].explanation)).not.toContain("some_internal_key_v2");
  });

  it("maps each state to its own category and title", () => {
    const cases: [QuestionState, string, string][] = [
      ["answer_missing", "needs_information", "needs your answer"],
      ["requires_confirmation", "needs_confirmation", "needs confirmation"],
      ["requires_user_gesture", "needs_user_gesture", "Open this question"],
      ["interaction_failed", "technical", "could not keep this selection"],
      ["sensitive_manual", "manual_legal", "privacy terms"],
      ["unsupported", "manual_review", "needs your review"]
    ];
    for (const [state, category, fragment] of cases) {
      const [item] = buildAuthoritativeReviewItems([entry("a", state)]);
      expect(item.category, state).toBe(category);
      expect(item.title.toLowerCase(), state).toContain(fragment.toLowerCase());
    }
  });

  it("only ever offers actions that are wired end to end", () => {
    // The list previously advertised "confirm this answer" and "retry this
    // field", which nothing implemented. Every action an item names must be one
    // of the three the widget can actually perform.
    const states: QuestionState[] = [
      "answer_missing", "requires_confirmation", "requires_user_gesture",
      "interaction_failed", "sensitive_manual", "unsupported"
    ];
    for (const state of states) {
      const [item] = buildAuthoritativeReviewItems([
        entry("a", state, { canonicalCategory: "work_authorization_us" })
      ]);
      for (const action of item.actions) {
        expect(REVIEW_ACTIONS, `${state} -> ${action}`).toContain(action);
      }
    }
  });

  it("offers an application-only answer only where one can be stored", () => {
    const actionsFor = (state: QuestionState, canonicalCategory: string | null) =>
      buildAuthoritativeReviewItems([entry("a", state, { canonicalCategory })])[0].actions;

    // A recognised, answerable boolean the user has not answered.
    expect(actionsFor("answer_missing", "work_authorization_us"))
      .toContain("answer_for_this_application");
    // Recognised, but not a question an override may carry.
    expect(actionsFor("answer_missing", "source_where_heard_about_job"))
      .not.toContain("answer_for_this_application");
    // Unrecognised wording: no canonical key, so nothing to answer.
    expect(actionsFor("answer_missing", null)).not.toContain("answer_for_this_application");
    // Revealing the control always works, so it is always offered.
    expect(actionsFor("answer_missing", null)).toContain("focus_control");
  });

  it("never offers to answer a consent question", () => {
    const [item] = buildAuthoritativeReviewItems([entry("a", "sensitive_manual")]);
    expect(item.actions).toEqual(["focus_control"]);
    expect(item.actions).not.toContain("answer_for_this_application");
  });

  it("puts required items first", () => {
    const items = buildAuthoritativeReviewItems([
      entry("optional", "answer_missing", { required: false }),
      entry("required", "answer_missing", { required: true })
    ]);
    expect(items[0].fieldKey).toBe("required");
  });

  it("exposes no answer values or internal enums to the user", () => {
    const items = buildAuthoritativeReviewItems([
      entry("a", "answer_missing", { canonicalCategory: "work_authorization_us", sensitivity: "legal" })
    ]);
    const userFacing = items[0].title + items[0].explanation;
    expect(userFacing).not.toContain("work_authorization_us");
    expect(userFacing).not.toContain("explicit_profile");
    expect(userFacing).not.toMatch(/\bYes\b|\bNo\b/);
  });
});

describe("review items and counts reconcile", () => {
  it("has exactly one item per field the user must act on", () => {
    const ledger = new QuestionLedger();
    const states: QuestionState[] = [
      "answer_missing", "requires_confirmation", "requires_user_gesture",
      "interaction_failed", "sensitive_manual", "unsupported"
    ];
    states.forEach((state, index) => {
      ledger.record({ fieldKey: `f${index}`, state: "discovered", reasonCode: "x" });
      ledger.record({ fieldKey: `f${index}`, state, reasonCode: "x" });
    });
    // Plus fields needing nothing.
    ledger.record({ fieldKey: "done", state: "discovered", reasonCode: "x" });
    ledger.record({ fieldKey: "done", state: "canonicalizing", reasonCode: "x" });
    ledger.record({ fieldKey: "done", state: "answer_resolved", reasonCode: "x" });
    ledger.record({ fieldKey: "done", state: "selecting", reasonCode: "x" });
    ledger.record({ fieldKey: "done", state: "filled_verified", reasonCode: "x" });

    const items = buildAuthoritativeReviewItems(ledger.all());
    expect(reviewItemsMatchCounts(items, ledger.counts())).toBe(true);
  });

  it("reports no items when nothing needs attention", () => {
    const counts = computeQuestionCounts([entry("a", "filled_verified")]);
    expect(reviewItemsMatchCounts(buildAuthoritativeReviewItems([entry("a", "filled_verified")]), counts)).toBe(true);
  });
});

describe("focus targets", () => {
  it("re-resolves the control rather than using a stale node", () => {
    const element = document.createElement("select");
    document.body.appendChild(element);
    const resolve = vi.fn(() => element);
    element.scrollIntoView = vi.fn();

    const outcome = focusReviewTarget("a", resolve);
    expect(resolve).toHaveBeenCalledWith("a");
    expect(outcome.ok).toBe(true);
    element.remove();
  });

  it("fails safely when the control is gone", () => {
    expect(focusReviewTarget("a", () => null)).toEqual({ ok: false, reason: "control_not_found" });
  });

  it("fails safely for a detached node", () => {
    const orphan = document.createElement("select");
    expect(focusReviewTarget("a", () => orphan).ok).toBe(false);
  });

  it("refuses to focus a password or submit control", () => {
    const password = document.createElement("input");
    password.type = "password";
    document.body.appendChild(password);
    expect(focusReviewTarget("a", () => password).reason).toBe("control_not_focusable");

    const submit = document.createElement("button");
    submit.type = "submit";
    document.body.appendChild(submit);
    expect(focusReviewTarget("b", () => submit).reason).toBe("control_not_focusable");

    password.remove();
    submit.remove();
  });

  it("does not change a checkbox it reveals", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.appendChild(checkbox);
    checkbox.scrollIntoView = vi.fn();

    focusReviewTarget("a", () => checkbox);
    // Revealed, never toggled — this is how consent stays the user's choice.
    expect(checkbox.checked).toBe(false);
    expect(document.activeElement).not.toBe(checkbox);
    checkbox.remove();
  });
});
