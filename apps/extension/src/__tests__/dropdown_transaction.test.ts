import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  booleanPolarity,
  locateChoiceTrigger,
  selectApprovedOption
} from "../content/dropdownTransaction";
import type { DiscoveredField } from "../types";

const rect = { x: 20, y: 20, left: 20, top: 20, right: 220, bottom: 60, width: 200, height: 40, toJSON: () => ({}) } as DOMRect;

function visible(element: HTMLElement): void {
  element.getBoundingClientRect = () => rect;
  element.scrollIntoView = () => undefined;
}

function fieldFor(element: HTMLElement, label = "Will you now or in the future require visa sponsorship or a visa transfer?"): DiscoveredField {
  return {
    uid: "eligibility-1", frameId: "top", control: "combobox", inputType: "button",
    name: "", id: element.id, autocomplete: "", placeholder: "", ariaLabel: label,
    label, labelSource: "aria_label", normalizedLabel: label.toLowerCase(), nearbyText: "Eligibility",
    sectionHeading: "Eligibility", required: true, disabled: false, visible: true, multiple: false,
    custom: true, existingValue: "", options: [], validationMessage: "", step: 1, element
  };
}

function mountChoice(openOn: "click" | "pointer" | "keyboard", portal = true): { field: DiscoveredField; trigger: HTMLButtonElement } {
  const fieldset = document.createElement("fieldset");
  const wrapper = document.createElement("div");
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "eligibility-options");
  trigger.textContent = "Select";
  visible(fieldset); visible(wrapper); visible(trigger);
  wrapper.appendChild(trigger);
  fieldset.appendChild(wrapper);
  document.body.appendChild(fieldset);
  let pointerSeen = false;
  const open = () => {
    if (document.getElementById("eligibility-options")) return;
    trigger.setAttribute("aria-expanded", "true");
    const menu = document.createElement("div");
    menu.id = "eligibility-options";
    menu.setAttribute("role", "listbox");
    visible(menu);
    for (const [label, value] of [["Yes", "true"], ["No", "false"]]) {
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.setAttribute("data-value", value);
      option.textContent = label;
      visible(option);
      option.addEventListener("click", () => {
        trigger.textContent = label;
        trigger.setAttribute("aria-expanded", "false");
        menu.remove();
      });
      menu.appendChild(option);
    }
    (portal ? document.body : wrapper).appendChild(menu);
  };
  trigger.addEventListener("pointerdown", () => { pointerSeen = true; });
  trigger.addEventListener("click", () => {
    if (openOn === "click" || (openOn === "pointer" && pointerSeen)) open();
  });
  trigger.addEventListener("keydown", (event) => {
    if (openOn === "keyboard" && ["Enter", " ", "ArrowDown"].includes(event.key)) open();
  });
  return { field: fieldFor(wrapper), trigger };
}

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
  if (!(globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent) {
    (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent = MouseEvent as typeof PointerEvent;
  }
});

afterEach(() => { document.body.innerHTML = ""; });

describe("custom dropdown backing-value polarity", () => {
  it.each(["Yes", "y", "true", "1", "Authorized", "I require sponsorship"])(
    "recognizes affirmative value %s",
    (value) => expect(booleanPolarity(value)).toBe("affirmative")
  );

  it.each(["No", "n", "false", "0", "Not authorized", "I do not require sponsorship"])(
    "recognizes negative value %s",
    (value) => expect(booleanPolarity(value)).toBe("negative")
  );

  it.each(["Maybe", "Other", "Authorized with restrictions", "Sponsorship unknown"])(
    "refuses ambiguous value %s",
    (value) => expect(booleanPolarity(value)).toBe("unknown")
  );
});

describe("eligibility choice-control transaction", () => {
  it("reacquires the actual interactive trigger inside a discovered wrapper", () => {
    const { field, trigger } = mountChoice("click");
    expect(locateChoiceTrigger(field)).toBe(trigger);
  });

  it("rejects a default-submit button as a dropdown trigger", () => {
    const form = document.createElement("form");
    const wrapper = document.createElement("div");
    const unsafe = document.createElement("button");
    unsafe.setAttribute("aria-haspopup", "listbox");
    visible(form); visible(wrapper); visible(unsafe);
    wrapper.appendChild(unsafe); form.appendChild(wrapper); document.body.appendChild(form);
    expect(unsafe.type).toBe("submit");
    expect(locateChoiceTrigger(fieldFor(wrapper))).toBeNull();
  });

  it.each(["click", "pointer", "keyboard"] as const)("opens by %s and verifies typed false", async (strategy) => {
    const { field } = mountChoice(strategy);
    const result = await selectApprovedOption(field, "No", {
      canonicalKey: "sponsorship_required_now_or_future", typedAnswer: false
    });
    expect(result.ok).toBe(true);
    expect(result.states).toEqual(expect.arrayContaining([
      "QUEUED_FOR_ACTUATION", "CONTROL_LOCATED", "CONTROL_OPENED", "OPTIONS_DISCOVERED",
      "OPTION_MATCHED", "OPTION_SELECTED", "COMMIT_OBSERVED", "VERIFIED", "FILLED"
    ]));
  }, 6000);

  it("discovers an aria-controls listbox portaled under body", async () => {
    const { field } = mountChoice("click", true);
    const result = await selectApprovedOption(field, "Yes", {
      canonicalKey: "work_authorization_us", typedAnswer: true
    });
    expect(result.ok).toBe(true);
    expect(result.listboxFound).toBe(true);
    expect(result.options).toEqual(["Yes", "No"]);
  });

  it("discovers a dynamically inserted body-level listbox", async () => {
    const { field, trigger } = mountChoice("keyboard");
    let scheduled = false;
    trigger.addEventListener("click", () => {
      if (scheduled) return;
      scheduled = true;
      window.setTimeout(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })), 20);
    });
    const result = await selectApprovedOption(field, "No", { typedAnswer: false });
    expect(result.ok).toBe(true);
    expect(result.states).toContain("CONTROL_OPENED");
  });

  it("reacquires a React-replaced trigger after selection", async () => {
    const { field, trigger } = mountChoice("click");
    const wrapper = field.element!;
    let current = field;
    trigger.addEventListener("click", () => {
      const menu = document.getElementById("eligibility-options");
      menu?.querySelectorAll('[role="option"]').forEach((option) => {
        option.addEventListener("click", () => {
          const replacement = trigger.cloneNode(true) as HTMLButtonElement;
          replacement.textContent = option.textContent;
          replacement.setAttribute("aria-expanded", "false");
          visible(replacement);
          trigger.replaceWith(replacement);
          current = fieldFor(wrapper);
        }, { once: true });
      });
    }, { once: true });
    const result = await selectApprovedOption(field, "Yes", { typedAnswer: true }, { reacquire: () => current });
    expect(result.ok).toBe(true);
    expect(result.verificationSource).toBe("display");
  });

  it("classifies React value reversion as a commit failure", async () => {
    const { field, trigger } = mountChoice("click");
    trigger.addEventListener("click", () => {
      document.getElementById("eligibility-options")?.querySelectorAll('[role="option"]').forEach((option) => {
        option.addEventListener("click", () => { window.setTimeout(() => { trigger.textContent = "Select"; }, 0); });
      });
    }, { once: true });
    const result = await selectApprovedOption(field, "No", { typedAnswer: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("selected_value_not_persisted");
  });

  /**
   * The two live shapes that made a plainly visible Yes/No dropdown unfillable.
   *
   * Neither is exotic: between them they describe how most component libraries
   * ship a select. The first opens on the press and treats the following click
   * as "close again", so an uninterrupted press-plus-click left the menu shut.
   * The second declares no ARIA roles at all, so every role-based lookup found
   * nothing and reported a menu that was on screen as never opened.
   */
  function mountBareWidget(options: { toggleOnMouseDown: boolean; roles: boolean }): DiscoveredField {
    const wrapper = document.createElement("div");
    const trigger = document.createElement("div");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.textContent = "Please select";
    visible(wrapper); visible(trigger);
    wrapper.appendChild(trigger);
    document.body.appendChild(wrapper);

    const popup = document.createElement("div");
    popup.className = "app-select-dropdown";
    popup.style.position = "absolute";
    const list = document.createElement("ul");
    visible(popup); visible(list);
    if (options.roles) {
      popup.setAttribute("role", "listbox");
    }
    for (const label of ["Yes", "No"]) {
      const item = document.createElement("li");
      item.textContent = label;
      if (options.roles) item.setAttribute("role", "option");
      visible(item);
      item.addEventListener("click", () => {
        trigger.textContent = label;
        popup.remove();
      });
      list.appendChild(item);
    }
    popup.appendChild(list);

    if (options.toggleOnMouseDown) {
      // The press opens it and the release-click dismisses it again. Sending
      // both in one uninterrupted sequence therefore leaves it shut.
      trigger.addEventListener("mousedown", () => {
        if (!popup.isConnected) document.body.appendChild(popup);
      });
      trigger.addEventListener("click", () => popup.remove());
    } else {
      trigger.addEventListener("click", () => {
        if (popup.isConnected) popup.remove();
        else document.body.appendChild(popup);
      });
    }
    return fieldFor(wrapper);
  }

  it("opens a widget that toggles on mousedown and closes on the click after it", async () => {
    const field = mountBareWidget({ toggleOnMouseDown: true, roles: true });
    const result = await selectApprovedOption(field, "No", { typedAnswer: false });
    expect(result.ok).toBe(true);
    expect(result.openStrategy).toBe("mouse");
    expect(document.querySelector("div[aria-haspopup]")!.textContent).toBe("No");
  });

  it("selects from a portaled menu that declares no ARIA roles", async () => {
    const field = mountBareWidget({ toggleOnMouseDown: false, roles: false });
    const result = await selectApprovedOption(field, "Yes", { typedAnswer: true });
    expect(result.ok).toBe(true);
    expect(result.matchedOption).toBe("[present]");
    expect(document.querySelector("div[aria-haspopup]")!.textContent).toBe("Yes");
  });

  it("never adopts a role-less list that is not drawn against the trigger", async () => {
    const field = mountBareWidget({ toggleOnMouseDown: false, roles: false });
    // A page-level overlay elsewhere on screen, offering the same words.
    const overlay = document.createElement("ul");
    overlay.className = "site-nav-dropdown";
    overlay.style.position = "fixed";
    overlay.getBoundingClientRect = () => ({
      x: 900, y: 700, left: 900, top: 700, right: 1100, bottom: 760,
      width: 200, height: 60, toJSON: () => ({})
    }) as DOMRect;
    let clicked = false;
    for (const label of ["Yes", "No"]) {
      const item = document.createElement("li");
      item.textContent = label;
      visible(item);
      item.addEventListener("click", () => { clicked = true; });
      overlay.appendChild(item);
    }
    document.body.appendChild(overlay);
    // Remove the control's own menu so only the distant list could be found.
    document.querySelector(".app-select-dropdown")?.remove();
    const trigger = document.querySelector<HTMLElement>("div[aria-haspopup]")!;
    trigger.replaceWith(trigger.cloneNode(true));

    const result = await selectApprovedOption(field, "Yes", { typedAnswer: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("menu_not_opened");
    expect(clicked).toBe(false);
  });

  it("drives the discovered element itself when nothing inside refines it", () => {
    const trigger = document.createElement("div");
    trigger.setAttribute("aria-haspopup", "listbox");
    visible(trigger);
    document.body.appendChild(trigger);
    expect(locateChoiceTrigger(fieldFor(trigger))).toBe(trigger);

    // A readonly text box IS the control on several component libraries.
    const readonly = document.createElement("input");
    readonly.readOnly = true;
    visible(readonly);
    document.body.appendChild(readonly);
    expect(locateChoiceTrigger(fieldFor(readonly))).toBe(readonly);
  });

  it("still refuses to guess between two plausible triggers", () => {
    const wrapper = document.createElement("div");
    const first = document.createElement("button");
    const second = document.createElement("button");
    first.type = "button"; second.type = "button";
    visible(wrapper); visible(first); visible(second);
    wrapper.append(first, second);
    document.body.appendChild(wrapper);
    expect(locateChoiceTrigger(fieldFor(wrapper))).toBeNull();
  });

  it("verifies native visible No with machine value false", async () => {
    const select = document.createElement("select");
    select.innerHTML = '<option value="">Select</option><option value="true">Yes</option><option value="false">No</option>';
    visible(select);
    document.body.appendChild(select);
    const result = await selectApprovedOption({ ...fieldFor(select), control: "select", custom: false }, "No", { typedAnswer: false });
    expect(result.ok).toBe(true);
    expect(result.displayed).toBe("No");
    expect(result.backing).toBe("false");
  });
});
