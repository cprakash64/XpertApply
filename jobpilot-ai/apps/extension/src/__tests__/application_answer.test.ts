/**
 * "Answer for this application", end to end below the network.
 *
 * The property under test throughout is honesty: a rendered button does
 * something, an answer is never inferred, a stored answer is never reported as a
 * filled field until the employer's page actually shows it, and deferring a
 * required question does not quietly resolve it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApplicationAnswerHandlers,
  targetFieldKeysFor
} from "../content/applicationAnswer";
import { QuestionLedger, absorbScalarLedger, type QuestionState } from "../content/questionLedger";
import {
  APPLICATION_SOURCE_LABEL,
  buildAuthoritativeReviewItems,
  buildConfirmedReviewItems
} from "../content/reviewItems";
import {
  FORBIDDEN_REQUEST_FIELDS,
  overrideFailureMessage,
  overrideRequestBody,
  validateOverrideRequest,
  type OverrideRequest
} from "../content/reviewActions";
import {
  createWidget,
  type AnswerOutcome,
  type ReviewActionHandlers
} from "../content/widget";

const SESSION_ID = 55;
const AUTH_KEY = "work_authorization_us";

function request(overrides: Partial<OverrideRequest> = {}): OverrideRequest {
  return {
    action: "answer_for_this_application",
    fieldKey: "f_top_jp-1",
    canonicalKey: AUTH_KEY,
    answerType: "boolean",
    value: true,
    sessionId: SESSION_ID,
    ...overrides
  };
}

/** A ledger holding one question in a given state. */
function ledgerWith(
  fieldKey: string,
  state: QuestionState,
  extra: {
    required?: boolean;
    canonicalCategory?: string | null;
    sensitivity?: string | null;
  } = {}
): QuestionLedger {
  const ledger = new QuestionLedger();
  ledger.record({
    fieldKey,
    state,
    reasonCode: "seed",
    controlType: "combobox",
    required: extra.required ?? true,
    canonicalCategory: extra.canonicalCategory ?? AUTH_KEY,
    sensitivity: extra.sensitivity ?? "legal"
  });
  return ledger;
}

function harnessFor(
  ledger: QuestionLedger,
  options: {
    store?: (key: string, value: boolean) => Promise<{ ok: boolean; error?: string }>;
    reresolve?: (keys: string[]) => Promise<Map<string, QuestionState>>;
    sessionId?: number | null;
  } = {}
) {
  const stored: { key: string; value: boolean }[] = [];
  const reresolved: string[][] = [];
  const audits: { action_type: string; field_key: string; status: string }[] = [];
  let renders = 0;

  const handlers = createApplicationAnswerHandlers({
    ledger,
    sessionId: () => (options.sessionId === undefined ? SESSION_ID : options.sessionId),
    storeOverride: async (key, value) => {
      stored.push({ key, value });
      return options.store ? options.store(key, value) : { ok: true };
    },
    reresolve: async (keys) => {
      reresolved.push(keys);
      return options.reresolve ? options.reresolve(keys) : new Map();
    },
    audit: (event) => audits.push(event),
    onLedgerChanged: () => {
      renders += 1;
    }
  });

  return { handlers, stored, reresolved, audits, renderCount: () => renders };
}

/** A reresolve that reports one field's outcome. */
function outcome(fieldKey: string, state: QuestionState) {
  return async () => new Map([[fieldKey, state]]);
}

// --------------------------------------------------------------------------- //
// 1-3, 7. The request contract
// --------------------------------------------------------------------------- //
describe("the override request carries only the user's choice", () => {
  it("accepts an explicit boolean for an answerable question", () => {
    const validated = validateOverrideRequest(request({ value: false }));
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.request.value).toBe(false);
  });

  it.each(FORBIDDEN_REQUEST_FIELDS)("refuses a request carrying %s", (field) => {
    const validated = validateOverrideRequest({ ...request(), [field]: "anything" });
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.reason).toBe("provenance_not_accepted");
  });

  it("refuses provenance even when the value looks harmless", () => {
    // `verified: false` is as much a policy violation as `verified: true`: the
    // browser has no standing to state either.
    const validated = validateOverrideRequest({ ...request(), verified: false });
    expect(validated.ok).toBe(false);
  });

  it("refuses anything that is not a real boolean", () => {
    for (const value of ["yes", "true", 1, 0, null, undefined, {}]) {
      const validated = validateOverrideRequest({ ...request(), value });
      expect(validated.ok, JSON.stringify(value)).toBe(false);
      if (!validated.ok) expect(validated.reason).toBe("explicit_choice_required");
    }
  });

  it("refuses a canonical key that may not be answered this way", () => {
    for (const key of ["privacy_consent", "salary_expectation", "source_where_heard_about_job", ""]) {
      expect(validateOverrideRequest(request({ canonicalKey: key })).ok, key).toBe(false);
    }
  });

  it("serializes exactly one field", () => {
    const body = overrideRequestBody(request({ value: false }));
    expect(body).toEqual({ value: false });
    expect(Object.keys(body)).toEqual(["value"]);
  });

  it("strips unrecognised properties instead of forwarding them", () => {
    const validated = validateOverrideRequest({ ...request(), locale: "en-US" });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(Object.keys(validated.request).sort()).toEqual([
        "action", "answerType", "canonicalKey", "fieldKey", "sessionId", "value"
      ]);
    }
  });
});

// --------------------------------------------------------------------------- //
// 5, 6, 8, 9, 10, 14, 15, 16, 17. Answering
// --------------------------------------------------------------------------- //
describe("answering for this application", () => {
  it("sends true for Yes and false for No", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    const h = harnessFor(ledger, { reresolve: outcome("f_top_jp-1", "filled_verified") });
    await h.handlers.answerForThisApplication(request({ value: true }));
    await h.handlers.answerForThisApplication(request({ value: false }));
    expect(h.stored).toEqual([
      { key: AUTH_KEY, value: true },
      { key: AUTH_KEY, value: false }
    ]);
  });

  it("becomes filled_verified only when the employer control verified", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    const h = harnessFor(ledger, { reresolve: outcome("f_top_jp-1", "filled_verified") });
    const result = await h.handlers.answerForThisApplication(request());
    expect(result.ok).toBe(true);
    expect(result.sourceLabel).toBe(APPLICATION_SOURCE_LABEL);
  });

  it("reports a refused selection truthfully rather than as a fill", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    const h = harnessFor(ledger, { reresolve: outcome("f_top_jp-1", "interaction_failed") });
    const result = await h.handlers.answerForThisApplication(request());

    // Stored, so the answer is preserved — but NOT ok, because the page does
    // not show it. Claiming success here is the exact failure mode this guards.
    expect(result.stored).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SELECTION_FAILED");
    expect(result.sourceLabel).toBeUndefined();
  });

  it("reports a control that vanished as not found, not as filled", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    const h = harnessFor(ledger, { reresolve: async () => new Map() });
    const result = await h.handlers.answerForThisApplication(request());
    expect(result).toMatchObject({ ok: false, stored: true, code: "CONTROL_NOT_FOUND" });
  });

  it.each([
    ["SESSION_UNAUTHORIZED"],
    ["SESSION_FORBIDDEN"],
    ["SESSION_NOT_FOUND"],
    ["SESSION_EXPIRED"],
    ["ANSWER_NOT_PERMITTED"],
    ["TIMEOUT"],
    ["NETWORK_UNAVAILABLE"]
  ])("keeps the item reviewable after %s and re-resolves nothing", async (code) => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    const h = harnessFor(ledger, { store: async () => ({ ok: false, error: code }) });
    const result = await h.handlers.answerForThisApplication(request());

    expect(result).toMatchObject({ ok: false, stored: false, code });
    // No employer control was touched, so nothing about the page changed.
    expect(h.reresolved).toEqual([]);
    expect(ledger.get("f_top_jp-1")!.state).toBe("answer_missing");
    // And the user is told something they can act on.
    expect(overrideFailureMessage(code)).not.toBe(code);
    expect(overrideFailureMessage(code).length).toBeGreaterThan(20);
  });

  it("never claims the reusable profile as the source", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    const h = harnessFor(ledger, { reresolve: outcome("f_top_jp-1", "filled_verified") });
    const result = await h.handlers.answerForThisApplication(request());
    expect(result.sourceLabel).toBe("Confirmed for this application");
    expect(result.sourceLabel).not.toMatch(/profile|saved|future|always/i);
  });

  it("refuses when the widget names a session the content script is not bound to", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    const h = harnessFor(ledger, { sessionId: 999 });
    const result = await h.handlers.answerForThisApplication(request());
    expect(result).toMatchObject({ ok: false, stored: false, code: "SESSION_NOT_FOUND" });
    expect(h.stored).toEqual([]);
  });

  it("audits the question but never the answer", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    const h = harnessFor(ledger, { reresolve: outcome("f_top_jp-1", "filled_verified") });
    await h.handlers.answerForThisApplication(request({ value: true }));
    expect(h.audits).toEqual([
      {
        action_type: "application_answer_override",
        field_key: AUTH_KEY,
        status: "confirmed_for_application"
      }
    ]);
    expect(JSON.stringify(h.audits)).not.toMatch(/\btrue\b|\bYes\b/);
  });
});

// --------------------------------------------------------------------------- //
// 11, 12, 13. Targeted re-resolution
// --------------------------------------------------------------------------- //
describe("only the affected fields are re-resolved", () => {
  function mixedLedger(): QuestionLedger {
    const ledger = new QuestionLedger();
    const add = (fieldKey: string, key: string, state: QuestionState) =>
      ledger.record({
        fieldKey, state, reasonCode: "seed", controlType: "combobox",
        required: true, canonicalCategory: key, sensitivity: "legal"
      });
    add("f_top_auth", "work_authorization_us", "answer_missing");
    add("f_top_now", "sponsorship_required_now", "answer_missing");
    add("f_top_future", "sponsorship_required_future", "answer_missing");
    add("f_top_combined", "sponsorship_required_now_or_future", "answer_missing");
    // Already correct, and must stay untouched.
    ledger.record({
      fieldKey: "f_top_source", state: "filled_verified", reasonCode: "verified",
      controlType: "native_select", required: false,
      canonicalCategory: "source_where_heard_about_job", sensitivity: null
    });
    return ledger;
  }

  it("targets only the answered question when nothing depends on it", () => {
    expect(targetFieldKeysFor(mixedLedger(), "work_authorization_us")).toEqual(["f_top_auth"]);
  });

  it("targets the combined sponsorship question when a component is answered", () => {
    expect(targetFieldKeysFor(mixedLedger(), "sponsorship_required_now").sort())
      .toEqual(["f_top_combined", "f_top_now"]);
    expect(targetFieldKeysFor(mixedLedger(), "sponsorship_required_future").sort())
      .toEqual(["f_top_combined", "f_top_future"]);
  });

  it("does not decompose a direct combined answer into its components", () => {
    // The reverse dependency does not hold: answering the combined question says
    // nothing about either component, so neither control is re-driven.
    expect(targetFieldKeysFor(mixedLedger(), "sponsorship_required_now_or_future"))
      .toEqual(["f_top_combined"]);
  });

  it("never targets an unrelated verified field", () => {
    for (const key of [
      "work_authorization_us", "sponsorship_required_now",
      "sponsorship_required_future", "sponsorship_required_now_or_future"
    ]) {
      expect(targetFieldKeysFor(mixedLedger(), key)).not.toContain("f_top_source");
    }
  });

  it("asks for the dependent key when a component is answered", async () => {
    const ledger = mixedLedger();
    const h = harnessFor(ledger, { reresolve: outcome("f_top_now", "filled_verified") });
    await h.handlers.answerForThisApplication(
      request({ fieldKey: "f_top_now", canonicalKey: "sponsorship_required_now" })
    );
    expect(h.reresolved).toEqual([
      ["sponsorship_required_now", "sponsorship_required_now_or_future"]
    ]);
  });

  it("updates the existing ledger entry rather than adding a second one", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    const before = ledger.size;
    ledger.record({ fieldKey: "f_top_jp-1", state: "selecting", reasonCode: "applying" });
    ledger.record({ fieldKey: "f_top_jp-1", state: "filled_verified", reasonCode: "verified" });
    expect(ledger.size).toBe(before);
    expect(ledger.get("f_top_jp-1")!.state).toBe("filled_verified");
  });
});

// --------------------------------------------------------------------------- //
// 18, 19, 20, 21. Leaving unresolved
// --------------------------------------------------------------------------- //
describe("leaving a question unresolved", () => {
  it("does not count a deferred required field as filled", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing", { required: true });
    const h = harnessFor(ledger);
    const result = await h.handlers.leaveUnresolved("f_top_jp-1");

    expect(result).toEqual({ ok: true, stillVisible: true });
    const entry = ledger.get("f_top_jp-1")!;
    expect(entry.state).toBe("answer_missing");
    expect(entry.deferred).toBe(true);
    expect(ledger.counts().filled_and_verified).toBe(0);
    // Still a required blank, so "Mark application complete" stays blocked.
    expect(ledger.counts().needs_information).toBe(1);
  });

  it("keeps a deferred required item in the review list", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing", { required: true });
    await harnessFor(ledger).handlers.leaveUnresolved("f_top_jp-1");

    const [item] = buildAuthoritativeReviewItems(ledger.all());
    expect(item).toBeDefined();
    expect(item.deferred).toBe(true);
    expect(item.required).toBe(true);
    // Nothing claims it is answered, and it still offers a way back to it.
    expect(item.sourceLabel).toBeNull();
    expect(item.actions).toContain("focus_control");
  });

  it("lets an optional question become optional_skipped on the same entry", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing", { required: false });
    const size = ledger.size;
    const result = await harnessFor(ledger).handlers.leaveUnresolved("f_top_jp-1");

    expect(result).toEqual({ ok: true, stillVisible: false });
    expect(ledger.get("f_top_jp-1")!.state).toBe("optional_skipped");
    expect(ledger.size).toBe(size);
    expect(ledger.counts().optional_skipped).toBe(1);
    // Skipped is not filled.
    expect(ledger.counts().filled_and_verified).toBe(0);
  });

  it("does not convert a required field to optional_skipped", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing", { required: true });
    await harnessFor(ledger).handlers.leaveUnresolved("f_top_jp-1");
    expect(ledger.get("f_top_jp-1")!.state).not.toBe("optional_skipped");
    expect(ledger.counts().optional_skipped).toBe(0);
  });

  it("refuses to skip a consent question", async () => {
    const ledger = ledgerWith("f_top_consent", "sensitive_manual", {
      canonicalCategory: null,
      sensitivity: "consent"
    });
    const h = harnessFor(ledger);
    expect(await h.handlers.leaveUnresolved("f_top_consent")).toEqual({
      ok: false,
      stillVisible: true
    });
    expect(ledger.get("f_top_consent")!.state).toBe("sensitive_manual");
    expect(ledger.get("f_top_consent")!.deferred).toBe(false);
    expect(h.audits).toEqual([]);
  });

  it("refuses to answer a consent question for the user", async () => {
    const ledger = ledgerWith("f_top_consent", "sensitive_manual", {
      canonicalCategory: AUTH_KEY,
      sensitivity: "consent"
    });
    const h = harnessFor(ledger);
    const result = await h.handlers.answerForThisApplication(
      request({ fieldKey: "f_top_consent" })
    );
    expect(result).toMatchObject({ ok: false, stored: false, code: "ANSWER_NOT_PERMITTED" });
    expect(h.stored).toEqual([]);
  });

  it("offers no answer action on a consent item at all", () => {
    const ledger = ledgerWith("f_top_consent", "sensitive_manual", {
      canonicalCategory: null,
      sensitivity: "consent"
    });
    const [item] = buildAuthoritativeReviewItems(ledger.all());
    expect(item.actions).toEqual(["focus_control"]);
    expect(item.answerType).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Lifecycle: nothing about the answer lives in the extension
// --------------------------------------------------------------------------- //
/**
 * Why this is an invariant rather than a lifecycle test.
 *
 * "The answer survives a service-worker restart" is only true if the extension
 * never treats its own memory as the record. These assert that directly: the
 * handler has exactly one way to learn an answer (the server, via `reresolve`)
 * and one way to record one (the server, via `storeOverride`). It keeps no value.
 */
describe("the extension holds no copy of the answer", () => {
  it("never reads the value it sent back out of its own state", async () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    // The employer control is not re-resolved (server says nothing), so if the
    // handler were keeping the value it would have to report success from memory.
    const h = harnessFor(ledger, { reresolve: async () => new Map() });
    const result = await h.handlers.answerForThisApplication(request({ value: true }));

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONTROL_NOT_FOUND");

    // The ledger entry has no field in which an answer could be kept. Asserted
    // over the key set rather than the serialization, so a future field named
    // `value` or `answer` fails this test rather than slipping past it.
    expect(Object.keys(ledger.get("f_top_jp-1")!).sort()).toEqual([
      "applicationOverride", "canonicalCategory", "controlType", "deferred",
      "fieldKey", "lastTransitionAt", "previousState", "reasonCode", "required",
      "retryCount", "sensitivity", "state"
    ]);
  });

  it("re-derives provenance from the server's answer, not from having asked", () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    // A fresh content script that has just been injected: the ledger says nothing
    // about an override until a resolution reports one.
    expect(buildAuthoritativeReviewItems(ledger.all())[0].sourceLabel).toBeNull();

    // Recovery marks the entry from the session, not from local memory of a click.
    ledger.record({
      fieldKey: "f_top_jp-1",
      state: "answer_missing",
      reasonCode: "recovered",
      applicationOverride: true
    });
    expect(ledger.get("f_top_jp-1")!.applicationOverride).toBe(true);
    // Still not claimed as filled: recovery says the answer exists, not that the
    // employer's control shows it.
    expect(buildAuthoritativeReviewItems(ledger.all())[0].sourceLabel).toBeNull();

    ledger.record({ fieldKey: "f_top_jp-1", state: "selecting", reasonCode: "applying" });
    ledger.record({ fieldKey: "f_top_jp-1", state: "filled_verified", reasonCode: "verified" });
    expect(buildConfirmedReviewItems(ledger.all())[0].sourceLabel)
      .toBe(APPLICATION_SOURCE_LABEL);
  });

  it("keeps the resolver's canonical key when a later scalar pass disagrees", () => {
    // The regression this guards: the scalar field mapper reads the COMBINED
    // "will you now or in the future require sponsorship" question as the future
    // component. Letting that guess overwrite the resolver's key silently broke
    // the dependency refresh, because affected fields are found BY canonical key.
    const ledger = new QuestionLedger();
    ledger.record({
      fieldKey: "f_top_jp-5",
      state: "answer_missing",
      reasonCode: "component_missing",
      canonicalCategory: "sponsorship_required_now_or_future",
      controlType: "native_select",
      required: true
    });
    absorbScalarLedger(ledger, [
      {
        uid: "jp-5",
        frameId: "top",
        status: "missing_information",
        canonicalKey: "sponsorship_required_future"
      }
    ]);
    expect(ledger.get("f_top_jp-5")!.canonicalCategory)
      .toBe("sponsorship_required_now_or_future");
    expect(targetFieldKeysFor(ledger, "sponsorship_required_now")).toEqual(["f_top_jp-5"]);
  });

  it("does not erase a canonical key when the scalar pass has no opinion", () => {
    const ledger = ledgerWith("f_top_jp-1", "answer_missing");
    absorbScalarLedger(ledger, [
      { uid: "jp-1", frameId: "top", status: "missing_information", canonicalKey: null }
    ]);
    expect(ledger.get("f_top_jp-1")!.canonicalCategory).toBe(AUTH_KEY);
  });
});

// --------------------------------------------------------------------------- //
// 1, 2, 3, 4, 8, 22. The widget
// --------------------------------------------------------------------------- //
let capturedRoot: ShadowRoot | null = null;
let originalAttachShadow: typeof Element.prototype.attachShadow;

beforeEach(() => {
  originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = originalAttachShadow.call(this, { ...init, mode: "open" });
    capturedRoot = root;
    return root;
  };
});

afterEach(() => {
  Element.prototype.attachShadow = originalAttachShadow;
  document.getElementById("jobpilot-assisted-apply")?.remove();
  capturedRoot = null;
  document.body.innerHTML = "";
});

function mountReview(
  items: Parameters<ReturnType<typeof createWidget>["showActions"]>[0],
  handlers: Partial<ReviewActionHandlers> = {}
) {
  const widget = createWidget({ retry: () => {}, clear: () => {}, complete: () => {} });
  const answered: OverrideRequest[] = [];
  const deferred: string[] = [];
  const focused: string[] = [];
  const full: ReviewActionHandlers = {
    sessionId: () => SESSION_ID,
    onFocusControl: (key) => focused.push(key),
    onAnswerForThisApplication: async (req) => {
      answered.push(req);
      return { ok: true, stored: true, sourceLabel: APPLICATION_SOURCE_LABEL };
    },
    onLeaveUnresolved: async (key) => {
      deferred.push(key);
      return { ok: true, stillVisible: true };
    },
    ...handlers
  };
  widget.showActions(items, full);
  return { widget, root: capturedRoot!, answered, deferred, focused };
}

function actionItems(state: QuestionState = "answer_missing", canonicalKey = AUTH_KEY) {
  const ledger = ledgerWith("f_top_jp-1", state, { canonicalCategory: canonicalKey });
  return buildAuthoritativeReviewItems(ledger.all());
}

describe("the review widget renders real actions", () => {
  it("renders a working button for every action an item declares", () => {
    const items = actionItems();
    const { root } = mountReview(items);
    const card = root.querySelector('[data-action-item="f_top_jp-1"]')!;
    const buttons = card.querySelectorAll("button");
    // One button per declared action, and no orphan text.
    expect(buttons.length).toBe(items[0].actions.length);
    for (const button of buttons) {
      expect(button.textContent!.trim().length).toBeGreaterThan(0);
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("shows the answer button for a missing answer", () => {
    const { root } = mountReview(actionItems());
    expect(root.querySelector('[data-act="answer"]')!.textContent)
      .toBe("Answer for this application");
    expect(root.querySelector('[data-act="jump"]')).not.toBeNull();
    expect(root.querySelector('[data-act="defer"]')).not.toBeNull();
  });

  it("preselects nothing and defaults to nothing", () => {
    const { root } = mountReview(actionItems());
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();

    const block = root.querySelector('[data-choice-block="f_top_jp-1"]')!;
    expect(block.querySelector('[data-choice="yes"]')).not.toBeNull();
    expect(block.querySelector('[data-choice="no"]')).not.toBeNull();
    expect(block.querySelector('[data-choice="cancel"]')).not.toBeNull();
    // No control holds a value at all, so there is nothing to default. In
    // particular there is no checked radio and no selected option.
    expect(block.querySelector("input:checked")).toBeNull();
    expect(block.querySelector("[selected]")).toBeNull();
    expect(block.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(block.querySelector("input,select,textarea")).toBeNull();
  });

  it("says the answer is for this application only", () => {
    const { root } = mountReview(actionItems());
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    const text = root.querySelector('[data-choice-block="f_top_jp-1"]')!.textContent!;
    expect(text).toContain("Use this answer only for this application.");
  });

  it("explains that the combined answer leaves the saved components alone", () => {
    const { root } = mountReview(
      actionItems("answer_missing", "sponsorship_required_now_or_future")
    );
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    const text = root.querySelector('[data-choice-block="f_top_jp-1"]')!.textContent!;
    expect(text).toContain("Use this answer only for this application.");
    expect(text).toContain("does not update your saved current or future sponsorship answers");
  });

  it("sends nothing when the user cancels", async () => {
    const { root, answered } = mountReview(actionItems());
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-choice="cancel"]')!.click();
    await Promise.resolve();

    expect(answered).toEqual([]);
    expect(root.querySelector('[data-choice-block="f_top_jp-1"]')).toBeNull();
    // The item is still there, still answerable.
    expect(root.querySelector('[data-act="answer"]')).not.toBeNull();
  });

  it("sends true for Yes and false for No, with no provenance", async () => {
    for (const [choice, expected] of [["yes", true], ["no", false]] as const) {
      const { root, answered } = mountReview(actionItems());
      root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
      root.querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`)!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(answered).toHaveLength(1);
      expect(answered[0].value).toBe(expected);
      expect(answered[0].canonicalKey).toBe(AUTH_KEY);
      expect(answered[0].sessionId).toBe(SESSION_ID);
      for (const field of FORBIDDEN_REQUEST_FIELDS) {
        expect(answered[0], field).not.toHaveProperty(field);
      }
      document.getElementById("jobpilot-assisted-apply")?.remove();
    }
  });

  it("bounds a duplicate click to one request", async () => {
    let release: (value: AnswerOutcome) => void = () => {};
    const { root, answered } = mountReview(actionItems(), {
      onAnswerForThisApplication: async (req) => {
        answeredSpy.push(req);
        return new Promise<AnswerOutcome>((resolve) => {
          release = resolve;
        });
      }
    });
    const answeredSpy: OverrideRequest[] = [];
    void answered;

    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    const yes = root.querySelector<HTMLButtonElement>('[data-choice="yes"]')!;
    yes.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Every button on the card is disabled while the request is in flight, so a
    // second click cannot start a second one.
    const card = root.querySelector('[data-action-item="f_top_jp-1"]')!;
    for (const button of card.querySelectorAll("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    card.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answeredSpy).toHaveLength(1);

    release({ ok: true, stored: true, sourceLabel: APPLICATION_SOURCE_LABEL });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("shows the application-only source once the page really shows the answer", async () => {
    const { root } = mountReview(actionItems());
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-choice="yes"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const card = root.querySelector('[data-action-item="f_top_jp-1"]')!;
    expect(card.querySelector("[data-source]")!.textContent).toBe("Confirmed for this application");
    expect(card.textContent).not.toMatch(/saved for future|all applications|your profile/i);
  });

  it("keeps the item and explains itself when the answer could not be applied", async () => {
    const { root } = mountReview(actionItems(), {
      onAnswerForThisApplication: async () => ({
        ok: false,
        stored: true,
        code: "SELECTION_FAILED"
      })
    });
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-choice="yes"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const card = root.querySelector('[data-action-item="f_top_jp-1"]')!;
    // Still reviewable, still reachable, and it does not claim to be filled.
    expect(card).not.toBeNull();
    expect(card.querySelector('[data-act="jump"]')).not.toBeNull();
    expect(card.querySelector("[data-source]")).toBeNull();
    const status = card.querySelector("[data-status]")!;
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent).toBe(overrideFailureMessage("SELECTION_FAILED"));
    // The buttons work again — a failure is not a dead end.
    expect(card.querySelector<HTMLButtonElement>('[data-act="answer"]')!.disabled).toBe(false);
  });

  it("never renders a Retry it cannot perform", async () => {
    const { root } = mountReview(actionItems(), {
      onAnswerForThisApplication: async () => ({ ok: false, stored: true, code: "SELECTION_FAILED" })
    });
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-choice="yes"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const card = root.querySelector('[data-action-item="f_top_jp-1"]')!;
    for (const button of card.querySelectorAll("button")) {
      // Anything offered is one of the three wired actions.
      expect(["answer", "jump", "defer"]).toContain(button.getAttribute("data-act"));
    }
  });

  it("hands Leave unresolved to its handler and stays visible for a required field", async () => {
    const { root, deferred } = mountReview(actionItems());
    root.querySelector<HTMLButtonElement>('[data-act="defer"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deferred).toEqual(["f_top_jp-1"]);
    const card = root.querySelector('[data-action-item="f_top_jp-1"]')!;
    expect(card.querySelector("[data-status]")!.textContent)
      .toContain("stays in the final review");
    // A way back to the question survives.
    expect(card.querySelector('[data-act="jump"]')).not.toBeNull();
  });

  it("reveals the control without changing it", () => {
    const { root, focused } = mountReview(actionItems());
    root.querySelector<HTMLButtonElement>('[data-act="jump"]')!.click();
    expect(focused).toEqual(["f_top_jp-1"]);
  });
});

// --------------------------------------------------------------------------- //
// 22. Submit is never a target
// --------------------------------------------------------------------------- //
describe("the widget cannot reach Submit", () => {
  it("renders only type=button controls", () => {
    const { root } = mountReview(actionItems());
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    for (const button of root.querySelectorAll("button")) {
      // A submit-type button inside a form would submit it. None exists.
      expect((button as HTMLButtonElement).type).toBe("button");
    }
    expect(root.querySelector('[type="submit"]')).toBeNull();
  });

  it("does not let Enter or Space escape to the employer's document", () => {
    const employerForm = document.createElement("form");
    const submit = document.createElement("button");
    submit.type = "submit";
    employerForm.appendChild(submit);
    document.body.appendChild(employerForm);
    const submitted = vi.fn((event: Event) => event.preventDefault());
    employerForm.addEventListener("submit", submitted);
    const documentKeys = vi.fn();
    document.addEventListener("keydown", documentKeys);

    const { root } = mountReview(actionItems());
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    for (const key of ["Enter", " "]) {
      root.querySelector<HTMLButtonElement>('[data-choice="yes"]')!.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, composed: true })
      );
    }

    // The keypress never reaches the page, so it can never reach a default
    // submit control.
    expect(documentKeys).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
    document.removeEventListener("keydown", documentKeys);
  });

  it("targets a canonical question, never a page control", async () => {
    const { root, answered } = mountReview(actionItems());
    root.querySelector<HTMLButtonElement>('[data-act="answer"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-choice="yes"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Nothing in the request addresses the DOM: no selector, no submit, no URL.
    const serialized = JSON.stringify(answered[0]);
    expect(serialized).not.toMatch(/submit|selector|querySelector|http/i);
  });
});
