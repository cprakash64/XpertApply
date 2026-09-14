/**
 * Stage 2F — form interaction hardening.
 *
 * The product invariant these pin, in one sentence: a field counts as filled
 * only when the EMPLOYER'S control holds the value after the framework has
 * finished with it, and nothing XpertApply does may overwrite what the user put
 * there themselves.
 *
 * Deliberately NOT asserted: exact event counts. Browsers and frameworks differ
 * in how many times they fire input/change for one interaction, and pinning the
 * count tests the harness rather than the product. What is pinned is the thing
 * that matters — the framework accepted the value and kept it across a
 * re-render.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearJobPilotFields, fillField } from "../fields/fill";
import { discoverFields } from "../fields/discovery";
import { MAX_DROPDOWN_OPTIONS } from "../fields/controlBudget";
import { selectApprovedOption } from "../content/dropdownTransaction";
import { findWorkdayNextControl } from "../ats/workday";
import type { DiscoveredField } from "../types";

/** A field descriptor for a control discovery deliberately skips (disabled,
 * detached) or that has no discoverable label in the fixture. */
function comboboxField(id: string, options: string[], element?: HTMLElement): DiscoveredField {
  return {
    uid: id, frameId: "top", control: "combobox", inputType: "", name: "", id,
    autocomplete: "", placeholder: "", ariaLabel: "", label: id, labelSource: "aria_label",
    normalizedLabel: id, nearbyText: "", sectionHeading: "", required: false, disabled: false,
    visible: true, multiple: false, custom: true, existingValue: "", options,
    validationMessage: "", step: 0, element: element ?? document.getElementById(id)!
  } as DiscoveredField;
}

function fieldFor(selector: string): DiscoveredField {
  const element = document.querySelector<HTMLElement>(selector)!;
  const found = discoverFields(document.body).find((candidate) => candidate.element === element);
  if (!found) throw new Error(`not discovered: ${selector}`);
  return found;
}

beforeEach(() => {
  vi.restoreAllMocks();
  if (typeof PointerEvent === "undefined") vi.stubGlobal("PointerEvent", MouseEvent);
  document.body.innerHTML = "";
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

// --------------------------------------------------------------------------- //
// Native text-like inputs
// --------------------------------------------------------------------------- //
describe("native text inputs", () => {
  it.each([
    ["text", "Ada Lovelace"],
    ["email", "ada@example.com"],
    ["tel", "+14155550100"],
    ["url", "https://example.com/ada"]
  ])("fills input[type=%s] through the native setter", async (type, value) => {
    document.body.innerHTML = `<label for="f">Field</label><input id="f" type="${type}">`;
    const outcome = await fillField(fieldFor("#f"), value);
    expect(outcome.status).toBe("filled");
    expect((document.getElementById("f") as HTMLInputElement).value).toBe(value);
  });

  it("leaves input[type=search] alone — a site's own search box is not an application field", () => {
    document.body.innerHTML = `<label for="f">Search</label><input id="f" type="search">`;
    expect(discoverFields(document.body).some((field) => field.id === "f")).toBe(false);
  });

  it("goes around an instance-level setter a framework installed, not through it", async () => {
    document.body.innerHTML = `<label for="f">Field</label><input id="f" type="text">`;
    const input = document.getElementById("f") as HTMLInputElement;

    // React installs its own `value` setter ON THE INSTANCE and reads the real
    // value back through the PROTOTYPE. Code that assigns `el.value = x` hits
    // the instance setter, React's own state never moves, and the next render
    // paints the old value back — the classic "it types and then goes empty".
    const instanceSetter = vi.fn();
    const protoDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => protoDescriptor.get!.call(input),
      set: instanceSetter
    });
    let seenByFramework: string | null = null;
    input.addEventListener("input", () => { seenByFramework = protoDescriptor.get!.call(input) as string; });

    await fillField(fieldFor("#f"), "Ada");

    // The prototype setter carried the value, and the framework's own listener
    // saw it — the instance setter was deliberately bypassed.
    expect(protoDescriptor.get!.call(input)).toBe("Ada");
    expect(seenByFramework).toBe("Ada");
    expect(instanceSetter).not.toHaveBeenCalled();
  });

  it("reports review rather than filled when the site rewrites the value away", async () => {
    document.body.innerHTML = `<label for="p">Phone</label><input id="p" type="tel">`;
    const input = document.getElementById("p") as HTMLInputElement;
    // A mask that reformats on blur — the ledger must record what the control
    // ACTUALLY holds, never the value that was intended.
    input.addEventListener("blur", () => { input.value = "(415) 555-0100"; });
    const outcome = await fillField(fieldFor("#p"), "4155550100", {
      verify: (final) => final.replace(/\D/g, "") === "4155550100"
    });
    expect(outcome.status).toBe("filled");
    expect(input.value).toBe("(415) 555-0100");

    document.body.innerHTML = `<label for="q">Phone</label><input id="q" type="tel">`;
    const rejecting = document.getElementById("q") as HTMLInputElement;
    rejecting.addEventListener("blur", () => { rejecting.value = ""; });
    const refused = await fillField(fieldFor("#q"), "4155550100", { verify: (final) => final !== "" });
    expect(refused.status).toBe("review_required");
  });

  it("surfaces a control the site marked invalid instead of claiming it filled", async () => {
    document.body.innerHTML = `<label for="f">Field</label><input id="f" type="text">`;
    const input = document.getElementById("f") as HTMLInputElement;
    input.addEventListener("blur", () => input.setAttribute("aria-invalid", "true"));
    const outcome = await fillField(fieldFor("#f"), "nope");
    expect(outcome.status).toBe("review_required");
  });
});

// --------------------------------------------------------------------------- //
// Textarea + controlled components
// --------------------------------------------------------------------------- //
describe("textarea and framework-controlled inputs", () => {
  it("fills a textarea", async () => {
    document.body.innerHTML = `<label for="t">Why us</label><textarea id="t"></textarea>`;
    const outcome = await fillField(fieldFor("#t"), "Because.");
    expect(outcome.status).toBe("filled");
    expect((document.getElementById("t") as HTMLTextAreaElement).value).toBe("Because.");
  });

  it("keeps the value across a controlled re-render", async () => {
    document.body.innerHTML = `<label for="t">Why us</label><textarea id="t"></textarea>`;
    const area = document.getElementById("t") as HTMLTextAreaElement;
    // A controlled component: the framework owns the value and repaints it from
    // its own state on every render. If our write never reached that state, the
    // re-render wipes it — which is the failure this pins.
    let state = "";
    area.addEventListener("input", () => { state = area.value; });
    const render = () => { area.value = state; };

    await fillField(fieldFor("#t"), "Because.");
    render();
    expect(area.value).toBe("Because.");
    render();
    expect(area.value).toBe("Because.");
  });
});

// --------------------------------------------------------------------------- //
// Checkboxes — idempotent
// --------------------------------------------------------------------------- //
describe("checkbox interaction is idempotent", () => {
  it("does not click a checkbox that already holds the desired state", async () => {
    document.body.innerHTML = `<label for="c">Subscribe</label><input id="c" type="checkbox" checked>`;
    const box = document.getElementById("c") as HTMLInputElement;
    const clicks = vi.fn();
    box.addEventListener("click", clicks);

    const outcome = await fillField(fieldFor("#c"), "yes");
    expect(outcome.status).toBe("filled");
    expect(box.checked).toBe(true);
    // The decisive assertion: a blind click would have toggled it OFF.
    expect(clicks).not.toHaveBeenCalled();
  });

  it("clicks exactly once when the state must change", async () => {
    document.body.innerHTML = `<label for="c">Subscribe</label><input id="c" type="checkbox">`;
    const box = document.getElementById("c") as HTMLInputElement;
    const clicks = vi.fn();
    box.addEventListener("click", clicks);

    await fillField(fieldFor("#c"), "yes");
    expect(box.checked).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("leaves a checkbox alone when the answer is no and it is already clear", async () => {
    document.body.innerHTML = `<label for="c">Subscribe</label><input id="c" type="checkbox">`;
    const box = document.getElementById("c") as HTMLInputElement;
    const clicks = vi.fn();
    box.addEventListener("click", clicks);
    await fillField(fieldFor("#c"), "no");
    expect(box.checked).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------- //
// Radio groups
// --------------------------------------------------------------------------- //
describe("radio groups", () => {
  const GROUP = `
    <fieldset><legend>Are you authorized to work in the United States?</legend>
      <input id="r-no" type="radio" name="auth" value="no"><label for="r-no">No</label>
      <input id="r-yes" type="radio" name="auth" value="yes"><label for="r-yes">Yes</label>
    </fieldset>`;

  it("selects by meaning, not by position", async () => {
    // "No" is rendered FIRST. A positional or first-option rule picks it.
    document.body.innerHTML = GROUP;
    const outcome = await fillField(fieldFor("#r-no"), "Yes");
    expect(outcome.status).toBe("filled");
    expect((document.getElementById("r-yes") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("r-no") as HTMLInputElement).checked).toBe(false);
  });

  it("never leaves two members of one group checked", async () => {
    document.body.innerHTML = GROUP;
    await fillField(fieldFor("#r-no"), "Yes");
    const checked = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="auth"]'))
      .filter((radio) => radio.checked);
    expect(checked).toHaveLength(1);
  });

  it("refuses an option the group does not offer", async () => {
    document.body.innerHTML = GROUP;
    const outcome = await fillField(fieldFor("#r-no"), "Maybe");
    expect(outcome.status).toBe("review_required");
    expect(document.querySelectorAll<HTMLInputElement>('input[name="auth"]:checked')).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------- //
// Native select
// --------------------------------------------------------------------------- //
describe("native select", () => {
  it("matches an option deterministically and verifies the committed value", async () => {
    document.body.innerHTML = `<label for="s">Degree</label>
      <select id="s"><option value="">Select…</option><option>Bachelor's degree</option><option>Master's degree</option></select>`;
    const outcome = await fillField(fieldFor("#s"), "Master's degree");
    expect(outcome.status).toBe("filled");
    expect((document.getElementById("s") as HTMLSelectElement).selectedOptions[0].textContent).toBe("Master's degree");
  });

  it("never falls back to the first option when nothing matches", async () => {
    document.body.innerHTML = `<label for="s">Degree</label>
      <select id="s"><option value="">Select…</option><option>Bachelor's degree</option></select>`;
    const outcome = await fillField(fieldFor("#s"), "Doctorate");
    expect(outcome.status).toBe("review_required");
    expect((document.getElementById("s") as HTMLSelectElement).value).toBe("");
  });

  it("does not treat a placeholder as an answer", async () => {
    document.body.innerHTML = `<label for="s">Degree</label>
      <select id="s"><option value="" selected>Select…</option><option>Bachelor's degree</option></select>`;
    // The control reads as blank, so the fill proceeds rather than skipping.
    const outcome = await fillField(fieldFor("#s"), "Bachelor's degree");
    expect(outcome.status).toBe("filled");
  });
});

// --------------------------------------------------------------------------- //
// User state preservation
// --------------------------------------------------------------------------- //
describe("what the user typed is never silently overwritten", () => {
  it("skips a field that already holds a user value", async () => {
    document.body.innerHTML = `<label for="f">Name</label><input id="f" type="text" value="Ada Lovelace">`;
    const outcome = await fillField(fieldFor("#f"), "Someone Else");
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("user value present");
    expect((document.getElementById("f") as HTMLInputElement).value).toBe("Ada Lovelace");
  });

  it("skips an employer pre-filled select", async () => {
    document.body.innerHTML = `<label for="s">Country</label>
      <select id="s"><option value="us" selected>United States</option><option value="ca">Canada</option></select>`;
    const outcome = await fillField(fieldFor("#s"), "Canada");
    expect(outcome.status).toBe("skipped");
    expect((document.getElementById("s") as HTMLSelectElement).value).toBe("us");
  });

  it("refills only when the caller explicitly forces it", async () => {
    document.body.innerHTML = `<label for="f">Name</label><input id="f" type="text" value="Ada Lovelace">`;
    const outcome = await fillField(fieldFor("#f"), "Grace Hopper", { force: true });
    expect(outcome.status).toBe("filled");
    expect((document.getElementById("f") as HTMLInputElement).value).toBe("Grace Hopper");
  });
});

// --------------------------------------------------------------------------- //
// Clear (XA-10) after Stage 2F
// --------------------------------------------------------------------------- //
describe("Clear restores the original state", () => {
  it("restores a non-empty employer value rather than emptying the field", async () => {
    document.body.innerHTML = `<label for="f">Name</label><input id="f" type="text" value="Employer Default">`;
    await fillField(fieldFor("#f"), "XpertApply Value", { force: true });
    expect((document.getElementById("f") as HTMLInputElement).value).toBe("XpertApply Value");

    const result = await clearJobPilotFields(document.body);
    expect(result.failed).toBe(0);
    expect((document.getElementById("f") as HTMLInputElement).value).toBe("Employer Default");
  });

  it("keeps the FIRST snapshot across repeated forced fills", async () => {
    document.body.innerHTML = `<label for="f">Name</label><input id="f" type="text" value="Original">`;
    await fillField(fieldFor("#f"), "First", { force: true });
    await fillField(fieldFor("#f"), "Second", { force: true });
    await clearJobPilotFields(document.body);
    expect((document.getElementById("f") as HTMLInputElement).value).toBe("Original");
  });

  it("restores a checkbox, a select and a radio group", async () => {
    document.body.innerHTML = `
      <label for="c">Subscribe</label><input id="c" type="checkbox">
      <label for="s">Degree</label><select id="s"><option value="b" selected>Bachelor's</option><option value="m">Master's</option></select>
      <fieldset><legend>Authorized?</legend>
        <input id="r-yes" type="radio" name="auth" value="yes"><label for="r-yes">Yes</label>
        <input id="r-no" type="radio" name="auth" value="no" checked><label for="r-no">No</label>
      </fieldset>`;
    await fillField(fieldFor("#c"), "yes");
    await fillField(fieldFor("#s"), "Master's", { force: true });
    await fillField(fieldFor("#r-yes"), "Yes", { force: true });

    await clearJobPilotFields(document.body);

    expect((document.getElementById("c") as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById("s") as HTMLSelectElement).value).toBe("b");
    expect((document.getElementById("r-no") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("r-yes") as HTMLInputElement).checked).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// Stale / replaced controls
// --------------------------------------------------------------------------- //
describe("stale element protection", () => {
  it("refuses a control that is no longer connected to the document", async () => {
    document.body.innerHTML = `<div id="d" role="combobox" aria-haspopup="listbox" tabindex="0">Select</div>`;
    const field = comboboxField("d", ["Yes", "No"]);
    // The framework replaces the node between discovery and actuation.
    document.getElementById("d")!.remove();

    const result = await selectApprovedOption(field, "No", { typedAnswer: false });
    expect(result.ok).toBe(false);
    expect(["control_not_found", "control_replaced"]).toContain(result.reason);
  });

  it("refuses a disabled control rather than mutating it through a property", async () => {
    document.body.innerHTML = `<label for="s">Degree</label>
      <select id="s" disabled><option value="">Select…</option><option value="b">Bachelor's</option></select>`;
    const select = document.getElementById("s") as HTMLSelectElement;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 40, width: 200, height: 40, toJSON: () => ({}) }) as DOMRect
    );
    const result = await selectApprovedOption(comboboxField("s", ["Bachelor's"], select), "Bachelor's");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("control_disabled");
    // Untouched: a disabled control is the employer saying "not yet".
    expect(select.value).toBe("");
  });
});

// --------------------------------------------------------------------------- //
// Resource bounds
// --------------------------------------------------------------------------- //
describe("a hostile menu cannot cause unbounded work", () => {
  it("declares a bound well above any legitimate list and below an attack", () => {
    // A country picker is ~250 entries; a year list is smaller. The bound has
    // to clear those comfortably and still cap a page rendering tens of
    // thousands of options.
    expect(MAX_DROPDOWN_OPTIONS).toBeGreaterThan(250);
    expect(MAX_DROPDOWN_OPTIONS).toBeLessThanOrEqual(5_000);
  });

  it("processes at most the bound from one menu", async () => {
    const N = MAX_DROPDOWN_OPTIONS + 5_000;
    document.body.innerHTML = `<div id="d" role="combobox" aria-haspopup="listbox" tabindex="0">Select</div>`;
    const trigger = document.getElementById("d")!;
    trigger.addEventListener("click", () => {
      if (document.querySelector('[data-owner="d"]')) return;
      const menu = document.createElement("div");
      menu.setAttribute("role", "listbox");
      menu.dataset.owner = "d";
      menu.innerHTML = Array.from({ length: N }, (_, i) => `<div role="option">Option ${i}</div>`).join("");
      document.body.appendChild(menu);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 40, width: 200, height: 40, toJSON: () => ({}) }) as DOMRect
    );
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => trigger });

    const started = Date.now();
    const result = await selectApprovedOption(comboboxField("d", []), `Option ${MAX_DROPDOWN_OPTIONS + 4_000}`);
    const elapsed = Date.now() - started;

    // Exactly the ceiling was read, out of N rendered.
    expect(result.options).toHaveLength(MAX_DROPDOWN_OPTIONS);
    // An option past the ceiling is a bounded MISS, never an unbounded walk —
    // and never an approximation to some other option.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("option_not_found");
    expect(trigger.textContent).toBe("Select");
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);
});

// --------------------------------------------------------------------------- //
// Multi-step: intermediate navigation vs the employer's final submission
// --------------------------------------------------------------------------- //
describe("final-submit classification (XA-07)", () => {
  const mount = (labels: string[], review = false) => {
    document.body.innerHTML =
      (review ? `<h1>Review your application</h1>` : ``) +
      labels.map((label) => `<button type="button">${label}</button>`).join("");
    return { url: "https://acme.myworkdayjobs.com/apply", document };
  };

  it.each(["Next", "Continue", "Save and Continue"])("treats %s as intermediate navigation", (label) => {
    expect(findWorkdayNextControl(mount([label]))?.textContent).toBe(label);
  });

  it.each(["Submit", "Submit Application", "Finish Application", "Finish", "Review"])(
    "never offers %s as a control to actuate",
    (label) => {
      expect(findWorkdayNextControl(mount([label]))).toBeNull();
    }
  );

  it("stops offering navigation entirely once the review step is reached", () => {
    // The step before the employer's final submission is exactly where an
    // automatic advance must not happen.
    expect(findWorkdayNextControl(mount(["Continue", "Submit Application"], true))).toBeNull();
  });

  it("picks the intermediate control, never the submit, when both are present", () => {
    const found = findWorkdayNextControl(mount(["Submit Application", "Continue"]));
    expect(found?.textContent).toBe("Continue");
  });
});
