/**
 * The live ServiceNow (SmartRecruiters) Experience and Education pickers.
 *
 * Reported behaviour: XpertApply types the stored value, the picker opens its
 * suggestion list, nothing is selected, and the field ends up EMPTY. The cause
 * was a hard order of operations — a suggestion list with no exact match ended
 * the attempt, and the adapter's `close()` (Escape + blur) then discarded the
 * typed text. Free text was only ever offered when the menu was completely
 * empty, which is not the shape these controls have.
 *
 * Three outcomes have to stay distinguishable:
 *   • the list carries the value's own head ("Machine Learning Engineer" for
 *     "Machine Learning Engineer, Contract") — select it, but only when it is
 *     unambiguous;
 *   • the control suggests without constraining — keep the exact stored value;
 *   • the control is a lookup that marks itself invalid — an honest failure,
 *     never a false success on a required field.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { discoverFields } from "../fields/discovery";
import { fillDropdown, nearestUniqueOption, onlySearchResultFor } from "../fields/dropdown";
import type { DropdownOption } from "../fields/dropdown";

const box = { x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 32, width: 240, height: 32, toJSON: () => ({}) } as DOMRect;

beforeEach(() => {
  document.body.innerHTML = "";
  HTMLElement.prototype.getBoundingClientRect = () => box;
  HTMLElement.prototype.scrollIntoView = () => undefined;
});

/**
 * A SmartRecruiters-shaped lookup: a text input that renders suggestions as the
 * user types. `constrains` decides whether it keeps free text or marks itself
 * invalid, which is the difference between Title/Company and Institution.
 */
function mountPicker(options: {
  label: string;
  suggestions: string[];
  constrains: boolean;
  autocomplete?: string;
}) {
  document.body.innerHTML = `
    <form>
      <label for="picker">${options.label}</label>
      <input id="picker" role="combobox" aria-expanded="false"
             aria-autocomplete="${options.autocomplete ?? "list"}" aria-controls="picker-list">
      <ul id="picker-list" role="listbox" hidden></ul>
    </form>`;
  const input = document.getElementById("picker") as HTMLInputElement;
  const list = document.getElementById("picker-list") as HTMLElement;

  const render = () => {
    const query = input.value.trim().toLowerCase();
    list.innerHTML = "";
    const shown = query
      ? options.suggestions.filter((item) => item.toLowerCase().startsWith(query.slice(0, 6)))
      : [];
    for (const label of shown) {
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      item.textContent = label;
      item.addEventListener("click", () => {
        // Choosing a record is what makes the value acceptable. Only `change`
        // is dispatched: `input` is the user's own typing, and re-entering the
        // typing handler here would put the control straight back to invalid.
        input.value = label;
        input.setAttribute("aria-invalid", "false");
        input.setAttribute("aria-expanded", "false");
        list.hidden = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      list.appendChild(item);
    }
    list.hidden = shown.length === 0;
    input.setAttribute("aria-expanded", String(!list.hidden));
  };

  input.addEventListener("input", () => {
    render();
    // A constraining lookup holds the typed text but refuses to accept it as a
    // value until a suggestion is chosen.
    if (options.constrains) input.setAttribute("aria-invalid", "true");
  });

  const field = discoverFields(document.querySelector("form")!).find((item) => item.id === "picker")!;
  return { field, input };
}

describe("searchable picker commits a value instead of going blank", () => {
  it("selects the unambiguous canonical option the stored title extends", async () => {
    const { field, input } = mountPicker({
      label: "Title",
      suggestions: ["Machine Learning Engineer"],
      constrains: true
    });
    const result = await fillDropdown(field, {
      values: ["Machine Learning Engineer, Contract"],
      searchValue: "Machine Learning Engineer"
    });
    expect(result.ok).toBe(true);
    expect(input.value).toBe("Machine Learning Engineer");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("keeps the exact stored value on a control that suggests without constraining", async () => {
    const { field, input } = mountPicker({
      label: "Company",
      suggestions: ["Veotrex Labs", "Veotrex Systems"],
      constrains: false,
      autocomplete: "both"
    });
    const result = await fillDropdown(field, { values: ["Veotrex"], searchValue: "Veotrex" });
    expect(result.ok).toBe(true);
    // Two suggestions extend "Veotrex", so neither may be chosen for the user —
    // the stored value itself is kept instead.
    expect(input.value).toBe("Veotrex");
  });

  it("reports a lookup that holds the text but marks itself invalid as a failure", async () => {
    const { field } = mountPicker({
      label: "Institution",
      // Nothing offered relates to the stored value, so neither a match nor the
      // narrowed match can apply and free text is the only route left.
      suggestions: ["Arizona Western College"],
      constrains: true,
      autocomplete: "both"
    });
    const result = await fillDropdown(field, {
      values: ["Arizona State University"],
      searchValue: "Arizona State University"
    });
    // The control is holding the text, but it is still `aria-invalid`. A
    // required field reported as filled here is the false success this guards.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("OPTION_NOT_AVAILABLE");
  });

  it("selects the one record a lookup returned for the school it was given", async () => {
    const { field, input } = mountPicker({
      label: "Institution",
      suggestions: ["Arizona State University"],
      constrains: true
    });
    const result = await fillDropdown(field, {
      values: ["Arizona State University"],
      searchValue: "Arizona State University"
    });
    expect(result.ok).toBe(true);
    expect(input.value).toBe("Arizona State University");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("never invents a choice between two equally plausible options", () => {
    const option = (label: string): DropdownOption => {
      const element = document.createElement("li");
      document.body.appendChild(element);
      return { id: label, label, normalizedLabel: label.toLowerCase(), element, disabled: false, selected: false };
    };
    // Two options extend the stored value: neither may be chosen for the user.
    expect(nearestUniqueOption([option("Veotrex Labs"), option("Veotrex Systems")], "Veotrex")).toBeNull();
    // One canonical head of a longer stored value is unambiguous.
    expect(nearestUniqueOption([option("Veotrex"), option("Acme Labs")], "Veotrex Inc")?.label).toBe("Veotrex");
    // A word boundary is required: "Veo" must never claim "Veotrex".
    expect(nearestUniqueOption([option("Veotrex")], "Veo")).toBeNull();
  });

  it("refuses a sole search result that is a different institution", () => {
    const option = (label: string): DropdownOption => {
      const element = document.createElement("li");
      document.body.appendChild(element);
      return { id: label, label, normalizedLabel: label.toLowerCase(), element, disabled: false, selected: false };
    };
    // Shares "Arizona" and nothing else. Committing it would put the wrong
    // school on the user's application.
    expect(onlySearchResultFor([option("Arizona Western College")], "Arizona State University")).toBeNull();
    // The same school named more fully is the same school.
    expect(onlySearchResultFor([option("Arizona State University Tempe")], "Arizona State University")?.label)
      .toBe("Arizona State University Tempe");
    // Two results is never a sole result.
    expect(onlySearchResultFor([option("Veotrex"), option("Veotrex Labs")], "Veotrex")).toBeNull();
  });
});
