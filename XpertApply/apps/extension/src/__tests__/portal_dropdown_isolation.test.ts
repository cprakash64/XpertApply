/**
 * Two portaled dropdowns on one page must never share a menu.
 *
 * The live TikTok failure: the Work Authorization section renders two custom
 * dropdowns whose menus are portaled to the same place. After the first
 * (authorization) selection, a menu node was still mounted, and the second
 * (sponsorship) transaction could adopt it — reading the FIRST question's
 * options and clicking inside the FIRST question's menu. The sponsorship answer
 * stayed blank, and the user saw "XpertApply could not keep this selection".
 *
 * `openCustomControl` already refused to adopt a pre-existing menu. What undid
 * that was `fillCustomSelect` re-querying with `findMenu(afterOpen)` and NO
 * exclusion set, so the menu the open step had deliberately rejected could win
 * on geometry a moment later.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectApprovedOption } from "../content/dropdownTransaction";
import type { DiscoveredField } from "../types";

function installGeometry(): void {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.id === "sponsorship" ? 200 : 10;
    return {
      x: 10, y: top, top, left: 10, right: 210, bottom: top + 40,
      width: 200, height: 40, toJSON: () => ({})
    } as DOMRect;
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => document.activeElement
  });
}

function field(id: string): DiscoveredField {
  const element = document.getElementById(id)!;
  return {
    uid: id, frameId: "top", control: "combobox", inputType: "", name: "", id,
    autocomplete: "", placeholder: "", ariaLabel: "", label: id, labelSource: "aria_label",
    normalizedLabel: id, nearbyText: "", sectionHeading: "", required: true, disabled: false,
    visible: true, multiple: false, custom: true, existingValue: "", options: [],
    validationMessage: "", step: 0, element
  };
}

/**
 * A menu that is portaled to <body> and — like the live one — does NOT close on
 * Escape or on a stray body click. It only closes when one of ITS options is
 * chosen. That stickiness is the whole point: it is what leaves a foreign menu
 * on screen while the next control is driven.
 */
function stickyPortal(id: string, labels: string[]): { menu: () => HTMLElement | null } {
  const trigger = document.getElementById(id)!;
  let menu: HTMLElement | null = null;
  trigger.addEventListener("click", () => {
    if (menu?.isConnected) return;
    menu = document.createElement("div");
    menu.setAttribute("role", "listbox");
    menu.dataset.owner = id;
    for (const label of labels) {
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = label;
      option.addEventListener("click", () => {
        document.getElementById(id)!.textContent = label;
        menu?.remove();
      });
      menu.appendChild(option);
    }
    document.body.appendChild(menu);
  });
  return { menu: () => menu };
}

beforeEach(() => {
  vi.restoreAllMocks();
  if (typeof PointerEvent === "undefined") vi.stubGlobal("PointerEvent", MouseEvent);
  document.body.innerHTML = `
    <div id="authorization" role="combobox" aria-haspopup="listbox" tabindex="0">Select</div>
    <div id="sponsorship" role="combobox" aria-haspopup="listbox" tabindex="0">Select</div>
  `;
  installGeometry();
});

describe("a second dropdown never borrows the first one's menu", () => {
  it("refuses a stale menu instead of selecting inside the wrong question", async () => {
    stickyPortal("authorization", ["Yes", "No"]);
    // Sponsorship's own trigger is inert: nothing it does opens a menu. The ONLY
    // menu on screen will be authorization's.
    const stale = document.createElement("div");
    stale.setAttribute("role", "listbox");
    stale.dataset.owner = "authorization";
    for (const label of ["Yes", "No"]) {
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = label;
      option.addEventListener("click", () => {
        document.getElementById("authorization")!.textContent = label;
      });
      stale.appendChild(option);
    }
    document.body.appendChild(stale);

    const result = await selectApprovedOption(field("sponsorship"), "No", { typedAnswer: false });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("menu_not_opened");
    // The decisive assertion: the first question's answer is untouched.
    expect(document.getElementById("authorization")!.textContent).toBe("Select");
    expect(document.getElementById("sponsorship")!.textContent).toBe("Select");
  });

  it("still drives its own menu when one opens, with a foreign menu on screen", async () => {
    stickyPortal("sponsorship", ["Yes", "No"]);
    const foreign = document.createElement("div");
    foreign.setAttribute("role", "listbox");
    foreign.dataset.owner = "authorization";
    const wrong = document.createElement("div");
    wrong.setAttribute("role", "option");
    wrong.textContent = "No";
    wrong.addEventListener("click", () => {
      document.getElementById("authorization")!.textContent = "No";
    });
    foreign.appendChild(wrong);
    document.body.appendChild(foreign);

    const result = await selectApprovedOption(field("sponsorship"), "No", { typedAnswer: false });

    expect(result).toMatchObject({ ok: true, reason: "verified" });
    expect(document.getElementById("sponsorship")!.textContent).toBe("No");
    expect(document.getElementById("authorization")!.textContent).toBe("Select");
  });

  it("reads options from its own menu only, never from every menu on the page", async () => {
    stickyPortal("sponsorship", ["Yes", "No"]);
    // A second menu offering a conflicting "No" would make the match ambiguous
    // if option collection ever swept the document again.
    const foreign = document.createElement("div");
    foreign.setAttribute("role", "listbox");
    for (const label of ["Yes", "No"]) {
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = label;
      foreign.appendChild(option);
    }
    document.body.appendChild(foreign);

    const result = await selectApprovedOption(field("sponsorship"), "No", { typedAnswer: false });
    expect(result.reason).not.toBe("ambiguous_option");
    expect(result.ok).toBe(true);
  });
});

describe("a widget that ships no ARIA roles on its menu", () => {
  /**
   * A design system is free to render a working Yes/No menu with no
   * `role="listbox"` and no `role="option"` anywhere on it — TikTok's careers
   * pages build their dropdowns from plain `dropdown-trigger` divs. Requiring
   * the roles meant the menu was never found and the selection was reported as
   * impossible on a control the user can operate by hand.
   *
   * The trigger's own `aria-controls` is the attribution here: the control
   * states which element is its popup, which is stronger evidence than a role.
   */
  it("uses the menu the trigger says it controls, and its children as options", async () => {
    document.body.innerHTML = `
      <div id="sponsorship" aria-haspopup="listbox" aria-controls="sponsorship-menu" tabindex="0">Select</div>
      <div id="sponsorship-menu" style="display:none">
        <div class="row">Yes</div>
        <div class="row">No</div>
      </div>
    `;
    installGeometry();
    const trigger = document.getElementById("sponsorship")!;
    const menu = document.getElementById("sponsorship-menu")!;
    trigger.addEventListener("click", () => { menu.style.display = "block"; });
    for (const row of Array.from(menu.querySelectorAll<HTMLElement>(".row"))) {
      row.addEventListener("click", () => {
        trigger.textContent = row.textContent;
        menu.style.display = "none";
      });
    }

    const result = await selectApprovedOption(field("sponsorship"), "No", { typedAnswer: false });

    expect(result).toMatchObject({ ok: true, reason: "verified" });
    expect(trigger.textContent).toBe("No");
    expect(result.options).toEqual(["Yes", "No"]);
  });

  it("still refuses when the owned menu offers no matching option", async () => {
    document.body.innerHTML = `
      <div id="sponsorship" aria-haspopup="listbox" aria-controls="sponsorship-menu" tabindex="0">Select</div>
      <div id="sponsorship-menu" style="display:none"><div class="row">Maybe</div></div>
    `;
    installGeometry();
    const trigger = document.getElementById("sponsorship")!;
    const menu = document.getElementById("sponsorship-menu")!;
    trigger.addEventListener("click", () => { menu.style.display = "block"; });

    const result = await selectApprovedOption(field("sponsorship"), "No", { typedAnswer: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("option_not_found");
    expect(trigger.textContent).toBe("Select");
  });
});

describe("a control whose menu renders inside its own subtree", () => {
  /**
   * `displayedValue` walks the trigger's text. With the menu open inside it,
   * that text is "Select Yes No" — which CONTAINS the approved label, so the
   * idempotence check concluded the control was already answered and returned
   * `verified` without ever clicking an option. The assisted "Select No for
   * sponsorship" action is exactly this path: it opens the menu first.
   */
  it("selects instead of reporting a false 'already verified'", async () => {
    document.body.innerHTML = `
      <div id="inline" role="combobox" aria-haspopup="listbox" aria-expanded="true" tabindex="0">
        <span class="value">Select</span>
        <div role="listbox">
          <div role="option">Yes</div>
          <div role="option">No</div>
        </div>
      </div>
    `;
    installGeometry();
    const trigger = document.getElementById("inline")!;
    for (const option of Array.from(trigger.querySelectorAll('[role="option"]'))) {
      option.addEventListener("click", () => {
        trigger.querySelector(".value")!.textContent = option.textContent;
        trigger.querySelector('[role="listbox"]')!.remove();
      });
    }

    const result = await selectApprovedOption(
      field("inline"), "No", { typedAnswer: false }, { callerOpened: true }
    );

    expect(result).toMatchObject({ ok: true, reason: "verified" });
    expect(trigger.querySelector(".value")!.textContent).toBe("No");
    expect(result.states).toContain("OPTION_SELECTED");
  });
});
