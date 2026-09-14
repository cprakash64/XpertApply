/**
 * The B-03 adversarial matrix, as one runnable checklist.
 *
 * Cases A/B/C/F/G are also covered in `b03_consequential_answer.test.ts` at the
 * gate and the actuator. They are restated here so the whole matrix can be read
 * and run in one place, together with the three cases that had no direct
 * coverage before the checkpoint review:
 *
 *   D  negative phrasing — the question asks the opposite
 *   E  the option generation changes before the commit
 *   H  the user answers the control while the resolver request is in flight
 *
 * H was a real gap. The profile fill path refuses to overwrite a user value,
 * and the run coordinator discards a superseded run, but the RESOLVER path had
 * neither protection: a response computed before the user acted is stale with
 * respect to THEM, not to the DOM, so neither re-discovery nor the option-set
 * staleness check noticed. It overwrote the user's own consequential answer and
 * reported it verified.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkConsequentialOption } from "../fields/consequentialAnswer";
import { checkSemanticCompatibility, detectPolarity } from "../fields/answerSemantics";
import { buildQuestionBatch, matchResults, resolutionIsStale } from "../content/questionBatch";
import { ResolutionRunCoordinator } from "../content/resolutionRun";
import { selectApprovedOption } from "../content/dropdownTransaction";
import { discoverFields } from "../fields/discovery";
import type { DiscoveredField, SessionAnswer } from "../types";

const YES_NO = ["Yes", "No"];
const US = { jobLocation: "San Francisco, CA" };

function stored(key: string, value: string, extra: Partial<SessionAnswer> = {}): SessionAnswer {
  return {
    canonical_key: key, value, display_value: value, source: "profile",
    confidence: 1, sensitive: false, requires_review: false, verified: true, ...extra
  };
}

function comboField(id: string, options: string[]): DiscoveredField {
  return {
    uid: id, frameId: "top", control: "combobox", inputType: "", name: "", id,
    autocomplete: "", placeholder: "", ariaLabel: "", label: id, labelSource: "aria_label",
    normalizedLabel: id, nearbyText: "", sectionHeading: "", required: true, disabled: false,
    visible: true, multiple: false, custom: true, existingValue: "", options,
    validationMessage: "", step: 0, element: document.getElementById(id)!
  } as DiscoveredField;
}

function mountCombobox(id: string, labels: string[]): void {
  document.body.innerHTML += `<div id="${id}" role="combobox" aria-haspopup="listbox" tabindex="0">Select…</div>`;
  const trigger = document.getElementById(id)!;
  trigger.addEventListener("click", () => {
    if (document.querySelector(`[data-owner="${id}"]`)) return;
    const menu = document.createElement("div");
    menu.setAttribute("role", "listbox");
    menu.dataset.owner = id;
    for (const label of labels) {
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = label;
      option.addEventListener("click", () => {
        document.getElementById(id)!.textContent = label;
        menu.remove();
      });
      menu.appendChild(option);
    }
    document.body.appendChild(menu);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  if (typeof PointerEvent === "undefined") vi.stubGlobal("PointerEvent", MouseEvent);
  document.body.innerHTML = "";
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 40, width: 200, height: 40, toJSON: () => ({}) }) as DOMRect
  );
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true, value: () => document.activeElement
  });
});

// --------------------------------------------------------------------------- //
describe("CASE A · sponsorship NO, provider says Yes at confidence 1.0", () => {
  it("refuses at the gate", () => {
    expect(checkConsequentialOption({
      canonicalKey: "sponsorship_required_future", typedAnswer: false, approvedLabel: "Yes",
      offeredLabels: YES_NO, safeSource: "saved_profile",
      storedAnswer: stored("sponsorship_required_future", "No")
    })).toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_CONTRADICTS_ANSWER" });
  });

  it("mutates nothing at the actuator", async () => {
    mountCombobox("sponsor", YES_NO);
    const result = await selectApprovedOption(comboField("sponsor", YES_NO), "Yes", { typedAnswer: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("option_contradicts_answer");
    expect(document.getElementById("sponsor")!.textContent).toBe("Select…");
  });
});

describe("CASE B · sponsorship NO, provider says No", () => {
  it("is allowed and commits a verified selection", async () => {
    expect(checkConsequentialOption({
      canonicalKey: "sponsorship_required_future", typedAnswer: false, approvedLabel: "No",
      offeredLabels: YES_NO, safeSource: "saved_profile",
      storedAnswer: stored("sponsorship_required_future", "No")
    })).toEqual({ ok: true });

    mountCombobox("sponsor", YES_NO);
    const result = await selectApprovedOption(comboField("sponsor", YES_NO), "No", { typedAnswer: false });
    expect(result.ok).toBe(true);
    expect(document.getElementById("sponsor")!.textContent).toBe("No");
  });
});

describe("CASE C · authorization YES, provider says No at confidence 1.0", () => {
  it("refuses at the gate and mutates nothing", async () => {
    expect(checkConsequentialOption({
      canonicalKey: "work_authorization_us", typedAnswer: true, approvedLabel: "No",
      offeredLabels: YES_NO, safeSource: "saved_profile",
      storedAnswer: stored("work_authorization_us", "Yes")
    })).toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_CONTRADICTS_ANSWER" });

    mountCombobox("auth", YES_NO);
    const result = await selectApprovedOption(comboField("auth", YES_NO), "No", { typedAnswer: true });
    expect(result.ok).toBe(false);
    expect(document.getElementById("auth")!.textContent).toBe("Select…");
  });
});

// --------------------------------------------------------------------------- //
describe("CASE D · negative phrasing is never answered with the positive mapping", () => {
  it.each([
    "Are you NOT authorized to work in the United States?",
    "Are you not legally authorized to work in the US?"
  ])("refuses %s", (question) => {
    expect(detectPolarity("work_authorization_us", question)).toBe("negative");
    expect(checkSemanticCompatibility("work_authorization_us", question, US))
      .toEqual({ ok: false, reason: "POLARITY_INCOMPATIBLE" });
  });

  it("still answers the same question asked straight", () => {
    const question = "Are you legally authorized to work in the United States?";
    expect(detectPolarity("work_authorization_us", question)).toBe("affirmative");
    expect(checkSemanticCompatibility("work_authorization_us", question, US)).toEqual({ ok: true });
  });

  it("refuses the negated sponsorship wording too", () => {
    const question = "I do not now, nor in the future, will require sponsorship to work in the United States.";
    expect(checkSemanticCompatibility("sponsorship_required_future", question, US))
      .toEqual({ ok: false, reason: "POLARITY_INCOMPATIBLE" });
  });

  it("refuses wording it does not recognise rather than assuming", () => {
    // Includes every language the templates do not cover. Not understanding the
    // question is not permission to answer it.
    expect(checkSemanticCompatibility("work_authorization_us", "¿Tiene permiso de trabajo?", US))
      .toEqual({ ok: false, reason: "POLARITY_UNKNOWN" });
  });
});

// --------------------------------------------------------------------------- //
describe("CASE E · the option generation changes before the commit", () => {
  function prepared(options: string[]) {
    document.body.innerHTML = `<form id="f"><label for="q">Will you require sponsorship?</label>` +
      `<select id="q" name="q" required><option value="">Select…</option>` +
      options.map((o) => `<option>${o}</option>`).join("") + `</select></form>`;
    const fields = discoverFields(document.querySelector("#f")!);
    return { entry: buildQuestionBatch(fields)[0], fields };
  }

  it("rejects an answer computed against a different option set", () => {
    const { entry } = prepared(["A", "B", "C"]);
    // The page re-renders: B is gone, D has appeared.
    const { fields: live } = prepared(["A", "C", "D"]);
    expect(resolutionIsStale(entry, live[0])).toBe(true);
  });

  it("accepts an unchanged option set", () => {
    const { entry } = prepared(["A", "B", "C"]);
    const { fields: live } = prepared(["A", "B", "C"]);
    expect(resolutionIsStale(entry, live[0])).toBe(false);
  });

  it("refuses the stale option at the gate as well", () => {
    // Generation G1 offered B; G2 does not.
    expect(checkConsequentialOption({
      canonicalKey: "criminal_history", typedAnswer: null, approvedLabel: "B",
      offeredLabels: ["A", "C", "D"], safeSource: "saved_profile"
    })).toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_NOT_OFFERED" });
  });

  it("discards a superseded run's late response entirely", () => {
    const runs = new ResolutionRunCoordinator();
    const slow = runs.begin("build", 1_000);
    const current = runs.begin("build", 1_001);
    expect(runs.accepts(slow.id)).toBe(false);
    expect(runs.accepts(current.id)).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
describe("CASE F · duplicate normalized labels", () => {
  it("fails closed at the gate rather than taking the first", () => {
    expect(checkConsequentialOption({
      canonicalKey: "sponsorship_required_future", typedAnswer: false, approvedLabel: "No",
      offeredLabels: ["Yes", "No", " no "], safeSource: "saved_profile"
    })).toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_AMBIGUOUS" });
  });

  it("fails closed at the actuator rather than taking the first", async () => {
    mountCombobox("dupe", ["No", "No"]);
    const result = await selectApprovedOption(comboField("dupe", ["No", "No"]), "No", { typedAnswer: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ambiguous_option");
    expect(document.getElementById("dupe")!.textContent).toBe("Select…");
  });
});

describe("CASE G · an option reference this field never offered", () => {
  /**
   * The fail-closed point for an unknown reference is UPSTREAM of the actuator.
   * A reference is only ever resolved through the question's own `labelByRef`,
   * so one the field never issued yields no label at all and the control is
   * never driven. The provider cannot manufacture a selector or a label.
   */
  function resolveRef(ref: string | null) {
    document.body.innerHTML = `<form id="f"><label for="q">Will you require sponsorship?</label>` +
      `<select id="q" name="q" required><option value="">Select…</option><option>Yes</option><option>No</option></select></form>`;
    const entry = buildQuestionBatch(discoverFields(document.querySelector("#f")!))[0];
    return matchResults([entry], [{
      field_ref: entry.question.field_ref, status: "resolved", canonical_key: "sponsorship_required_future",
      answer_type: "boolean", selected_option_ref: ref, safe_source: "saved_profile", confidence: 1,
      sensitivity: "legal", reason_code: "exact_option", typed_answer: false, display_answer: "No"
    }])[0];
  }

  it("yields no approved label for a reference this field never issued", () => {
    expect(resolveRef("f_top_somewhere_else_o0").approvedLabel).toBeNull();
    expect(resolveRef("totally-made-up").approvedLabel).toBeNull();
  });

  it("drops a result naming a field that was never asked about", () => {
    document.body.innerHTML = `<form id="f"><label for="q">Will you require sponsorship?</label>` +
      `<select id="q" name="q" required><option value="">Select…</option><option>No</option></select></form>`;
    const entry = buildQuestionBatch(discoverFields(document.querySelector("#f")!))[0];
    expect(matchResults([entry], [{
      field_ref: "f_top_not_this_one", status: "resolved", canonical_key: "sponsorship_required_future",
      answer_type: "boolean", selected_option_ref: "f_top_not_this_one_o0", safe_source: "saved_profile",
      confidence: 1, sensitivity: "legal", reason_code: "exact_option", typed_answer: false, display_answer: "No"
    }])).toHaveLength(0);
  });

  it("fails closed at the gate for a label outside the offered set", () => {
    expect(checkConsequentialOption({
      canonicalKey: "sponsorship_required_future", typedAnswer: false, approvedLabel: "Nope",
      offeredLabels: YES_NO, safeSource: "saved_profile"
    })).toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_NOT_OFFERED" });
  });

  it("never lets an unrecognised label reach a CONTRADICTING option", async () => {
    // The actuator's remaining path for a label it cannot match is the
    // deterministic canonical boolean — not the provider's text. It may reach
    // the option that MEANS the canonical answer; it may never reach the other
    // one. This is the property that matters: nothing the provider writes can
    // steer the selection.
    mountCombobox("sponsor", YES_NO);
    const result = await selectApprovedOption(comboField("sponsor", YES_NO), "Nope", { typedAnswer: false });
    expect(document.getElementById("sponsor")!.textContent).not.toBe("Yes");
    if (result.ok) expect(document.getElementById("sponsor")!.textContent).toBe("No");
  });
});

// --------------------------------------------------------------------------- //
describe("CASE H · the user answers while the resolver request is in flight", () => {
  it("does not overwrite the user's choice on a native select", async () => {
    document.body.innerHTML =
      `<select id="s"><option value="">Select…</option><option value="y">Yes</option><option value="n">No</option></select>`;
    const select = document.getElementById("s") as HTMLSelectElement;
    select.value = "y"; // the user picked Yes by hand, mid-flight
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => select });

    const result = await selectApprovedOption(comboField("s", YES_NO), "No", { typedAnswer: false });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("user_value_present");
    // THE assertion: their answer still stands.
    expect(select.value).toBe("y");
  });

  it("does not overwrite the user's choice on a custom combobox", async () => {
    mountCombobox("sponsor", YES_NO);
    document.getElementById("sponsor")!.textContent = "Yes"; // chosen by hand

    const result = await selectApprovedOption(comboField("sponsor", YES_NO), "No", { typedAnswer: false });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("user_value_present");
    expect(document.getElementById("sponsor")!.textContent).toBe("Yes");
  });

  it("does not overwrite a value the employer pre-filled", async () => {
    document.body.innerHTML =
      `<select id="s"><option value="y" selected>Yes</option><option value="n">No</option></select>`;
    const select = document.getElementById("s") as HTMLSelectElement;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => select });
    const result = await selectApprovedOption(comboField("s", YES_NO), "No", { typedAnswer: false });
    expect(result.reason).toBe("user_value_present");
    expect(select.value).toBe("y");
  });

  it("still fills a blank or placeholder control", async () => {
    document.body.innerHTML =
      `<select id="s"><option value="" selected>Select…</option><option value="n">No</option></select>`;
    const select = document.getElementById("s") as HTMLSelectElement;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => select });
    const result = await selectApprovedOption(comboField("s", ["No"]), "No", { typedAnswer: false });
    expect(result.ok).toBe(true);
    expect(select.value).toBe("n");
  });

  it("may still update a value XpertApply itself wrote", async () => {
    // A targeted re-resolution — the user answers a question for this
    // application and the affected controls refresh — must keep working.
    document.body.innerHTML =
      `<select id="s"><option value="">Select…</option><option value="y">Yes</option><option value="n">No</option></select>`;
    const select = document.getElementById("s") as HTMLSelectElement;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => select });

    const first = await selectApprovedOption(comboField("s", YES_NO), "No", { typedAnswer: false });
    expect(first.ok).toBe(true);
    expect(select.value).toBe("n");

    const refreshed = await selectApprovedOption(comboField("s", YES_NO), "Yes", { typedAnswer: true });
    expect(refreshed.ok).toBe(true);
    expect(select.value).toBe("y");
  });

  it.each(["None", "N/A", "Prefer not to say"])(
    "treats %s as the real answer it is, not as a placeholder",
    async (chosen) => {
      // "None" answers "how many years of management experience" and "prior
      // convictions". A blank test loose enough to swallow it would let an
      // automatic resolution overwrite a real, consequential answer.
      document.body.innerHTML =
        `<select id="s"><option value="">Select…</option><option value="x">${chosen}</option><option value="n">No</option></select>`;
      const select = document.getElementById("s") as HTMLSelectElement;
      select.value = "x";
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => select });

      const result = await selectApprovedOption(comboField("s", [chosen, "No"]), "No", { typedAnswer: false });

      expect(result.reason).toBe("user_value_present");
      expect(select.value).toBe("x");
    }
  );

  it.each(["Select…", "Choose an option", "Please select", "--", "None selected", "No selection"])(
    "still fills a control showing the placeholder %s",
    async (placeholder) => {
      document.body.innerHTML =
        `<select id="s"><option value="p" selected>${placeholder}</option><option value="n">No</option></select>`;
      const select = document.getElementById("s") as HTMLSelectElement;
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => select });
      const result = await selectApprovedOption(comboField("s", ["No"]), "No", { typedAnswer: false });
      expect(result.ok).toBe(true);
      expect(select.value).toBe("n");
    }
  );

  it("an already-correct control still verifies rather than reporting a conflict", async () => {
    document.body.innerHTML =
      `<select id="s"><option value="">Select…</option><option value="n" selected>No</option></select>`;
    const select = document.getElementById("s") as HTMLSelectElement;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => select });
    const result = await selectApprovedOption(comboField("s", ["No"]), "No", { typedAnswer: false });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("verified");
  });
});
