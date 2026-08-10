/**
 * A web-component application, in a real browser.
 *
 * Every shape below was measured on the live SmartRecruiters "Easy Apply" form
 * that ServiceNow's "I'm interested" leads to, and each one broke autofill in a
 * different way:
 *
 *  1. `spl-autocomplete[City]` keeps its `role="listbox"` menu in ITS shadow
 *     root while the `<input aria-controls="menu-…">` lives one root deeper, so
 *     resolving the id in the input's own root (or the document) found nothing.
 *  2. That menu's options are `<spl-select-option value="US_AZ_CITY_phoenix">`
 *     with NO `role="option"`, so a menu full of live suggestions read as empty.
 *  3. `spl-autocomplete[Title]` never opens a menu at all: it is
 *     `aria-autocomplete="both"`, i.e. the typed text IS the value. Treating it
 *     as list-constrained left every Experience row blank.
 *  4. The date field renders a `Current year` number spinner beside the value
 *     input — typing a year into it scrolls a calendar and stores nothing.
 *  5. Section titles are `<spl-typography-title>`, and Add/Save are
 *     `<spl-button aria-label="…">` whose inner <button> has no name.
 *
 * jsdom cannot show any of this: it has no layout, and these controls only
 * behave under real pointer/focus handling.
 */
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");

const PROFILE = {
  location: "Phoenix, Arizona, United States",
  experience: [
    {
      company: "Moveworks",
      title: "Software Engineer",
      location: "Mountain View, California, United States",
      start_date: "2022-03",
      end_date: "2024-08",
      currently_working: false,
      description: "Built agentic evaluation harnesses."
    }
  ],
  education: [
    {
      school: "Arizona State University",
      degree: "Master of Science",
      major: "Computer Science",
      start_date: "2020-08",
      end_date: "2022-05",
      gpa: "3.9"
    }
  ]
};

async function renderApplication(page: Page): Promise<void> {
  await page.setContent(`<main id="app"></main>`);
  await page.evaluate(() => {
    /** `spl-input`: the real control inside an open shadow root. */
    class SplInput extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: "open" });
        const id = this.getAttribute("input-id") ?? `in-${Math.random().toString(36).slice(2)}`;
        const label = document.createElement("label");
        label.setAttribute("for", id);
        label.textContent = this.getAttribute("label") ?? "";
        const input = document.createElement("input");
        input.id = id;
        input.type = this.getAttribute("input-type") ?? "text";
        if (this.hasAttribute("required")) input.setAttribute("aria-required", "true");
        for (const name of ["role", "aria-autocomplete", "aria-controls", "aria-label"]) {
          const value = this.getAttribute(name);
          if (value) input.setAttribute(name, value);
        }
        // The component mirrors the control's value onto itself — this is the
        // committed state that verification reads.
        input.addEventListener("input", () => this.setAttribute("value", input.value));
        input.addEventListener("change", () => this.setAttribute("value", input.value));
        root.append(label, input);
      }
    }
    customElements.define("spl-input", SplInput);

    class SplTextarea extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: "open" });
        const id = this.getAttribute("input-id") ?? "ta";
        const label = document.createElement("label");
        label.setAttribute("for", id);
        label.textContent = this.getAttribute("label") ?? "";
        const area = document.createElement("textarea");
        area.id = id;
        area.addEventListener("input", () => this.setAttribute("value", area.value));
        root.append(label, area);
      }
    }
    customElements.define("spl-textarea", SplTextarea);

    /**
     * `spl-autocomplete`: the menu lives HERE, the input lives one root deeper.
     * `mode="list"` renders remote suggestions after 3 characters and commits
     * only on選択; `mode="both"` never opens a menu and keeps the typed text.
     */
    class SplAutocomplete extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: "open" });
        const label = this.getAttribute("label") ?? "";
        const mode = this.getAttribute("mode") ?? "both";
        const id = `ac-${label.toLowerCase().replace(/\W+/g, "-")}`;
        const menuId = `menu-${id}`;

        const inner = document.createElement("spl-input");
        inner.setAttribute("label", label);
        inner.setAttribute("input-id", id);
        inner.setAttribute("role", "combobox");
        inner.setAttribute("aria-autocomplete", mode);
        inner.setAttribute("aria-controls", menuId);
        if (this.hasAttribute("required")) inner.setAttribute("required", "");

        const menu = document.createElement("div");
        menu.id = menuId;
        menu.setAttribute("role", "listbox");
        menu.style.display = "none";
        root.append(inner, menu);

        const suggestions = JSON.parse(this.getAttribute("suggestions") ?? "[]") as string[];
        const input = inner.shadowRoot!.querySelector("input")!;
        input.addEventListener("input", () => {
          this.setAttribute("value", mode === "both" ? input.value : this.getAttribute("value") ?? "");
          if (mode !== "list") return;
          const query = input.value.trim().toLowerCase();
          menu.innerHTML = "";
          if (query.length < 3) {
            menu.style.display = "none";
            input.setAttribute("aria-expanded", "false");
            return;
          }
          const hits = suggestions.filter((item) => item.toLowerCase().includes(query));
          for (const item of hits) {
            // No role="option" — exactly like the live control.
            const option = document.createElement("spl-select-option");
            option.setAttribute("value", item.replace(/\\W+/g, "_"));
            option.textContent = item;
            option.addEventListener("click", () => {
              input.value = item;
              this.setAttribute("value", item);
              menu.style.display = "none";
              input.setAttribute("aria-expanded", "false");
              input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            });
            menu.appendChild(option);
          }
          menu.style.display = hits.length > 0 ? "block" : "none";
          input.setAttribute("aria-expanded", hits.length > 0 ? "true" : "false");
        });
      }
    }
    customElements.define("spl-autocomplete", SplAutocomplete);

    /** A date field plus the calendar's own year spinner. */
    class SplDateField extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: "open" });
        const label = this.getAttribute("label") ?? "";
        const value = document.createElement("input");
        value.type = "text";
        value.placeholder = "Pick a date";
        value.setAttribute("aria-label", label);
        if (this.hasAttribute("required")) value.setAttribute("aria-required", "true");
        value.addEventListener("input", () => this.setAttribute("value", value.value));
        const spinner = document.createElement("input");
        spinner.type = "number";
        spinner.setAttribute("aria-label", "Current year");
        root.append(value, spinner);
      }
    }
    customElements.define("spl-date-field", SplDateField);

    class SplTitle extends HTMLElement {}
    customElements.define("spl-typography-title", SplTitle);

    /** The name is on the HOST; the inner button has none. */
    class SplButton extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.appendChild(document.createElement("slot"));
        button.addEventListener("click", () => this.dispatchEvent(new CustomEvent("spl-click")));
        root.appendChild(button);
      }
    }
    customElements.define("spl-button", SplButton);

    const app = document.getElementById("app")!;

    // --- Personal information: the City autocomplete ------------------------
    const personal = document.createElement("div");
    personal.innerHTML = `<spl-typography-title data-test="section-title">Personal information</spl-typography-title>`;
    const city = document.createElement("spl-autocomplete");
    city.setAttribute("label", "City");
    city.setAttribute("mode", "list");
    city.setAttribute("required", "");
    city.setAttribute("suggestions", JSON.stringify([
      "Phoenix, AZ, US", "Phoenix, OR, US", "Phoenix, NY, US", "Phoenix, IL, US", "Phoenixville, PA, US"
    ]));
    personal.appendChild(city);
    app.appendChild(personal);

    // --- Experience / Education: inline editors behind an Add button --------
    const section = (heading: string, addLabel: string, saveLabel: string, build: () => HTMLElement) => {
      const wrapper = document.createElement("div");
      const title = document.createElement("spl-typography-title");
      title.setAttribute("data-test", "section-title");
      title.textContent = heading;
      const add = document.createElement("spl-button");
      add.setAttribute("aria-label", addLabel);
      add.textContent = "Add";
      const body = document.createElement("div");
      wrapper.append(title, add, body);
      add.addEventListener("spl-click", () => {
        if (body.querySelector(".entry")) return;
        const entry = build();
        entry.classList.add("entry");
        const save = document.createElement("spl-button");
        save.setAttribute("aria-label", saveLabel);
        save.textContent = "Save";
        entry.appendChild(save);
        body.appendChild(entry);
      });
      app.appendChild(wrapper);
    };

    const autocomplete = (label: string, mode: string, required = false) => {
      const el = document.createElement("spl-autocomplete");
      el.setAttribute("label", label);
      el.setAttribute("mode", mode);
      if (required) el.setAttribute("required", "");
      return el;
    };

    section("Experience", "Add experience entry", "Save experience entry", () => {
      const entry = document.createElement("div");
      const description = document.createElement("spl-textarea");
      description.setAttribute("label", "Description");
      description.setAttribute("input-id", "exp-description");
      const from = document.createElement("spl-date-field");
      from.setAttribute("label", "From");
      from.setAttribute("required", "");
      const to = document.createElement("spl-date-field");
      to.setAttribute("label", "To");
      to.setAttribute("required", "");
      entry.append(
        description,
        autocomplete("Title", "both", true),
        autocomplete("Company", "both"),
        autocomplete("Office location", "both"),
        from,
        to
      );
      return entry;
    });

    section("Education", "Add education entry", "Save education entry", () => {
      const entry = document.createElement("div");
      const major = document.createElement("spl-input");
      major.setAttribute("label", "Major");
      major.setAttribute("input-id", "edu-major");
      const degree = document.createElement("spl-input");
      degree.setAttribute("label", "Degree");
      degree.setAttribute("input-id", "edu-degree");
      entry.append(autocomplete("Institution", "both", true), major, degree, autocomplete("School location", "both"));
      return entry;
    });
  });
  await page.addScriptTag({ path: HARNESS });
}

/** The committed value of a component, read from its host. */
async function committed(page: Page, label: string): Promise<string> {
  return page.evaluate((wanted) => {
    const hosts = Array.from(document.querySelectorAll<HTMLElement>("spl-autocomplete,spl-input,spl-textarea,spl-date-field"));
    const host = hosts.find((element) => element.getAttribute("label") === wanted);
    return host?.getAttribute("value") ?? "";
  }, label);
}

test("a required list-constrained autocomplete is filled from its own suggestions", async ({ page }) => {
  await renderApplication(page);
  await page.evaluate(() => (window as any).JobPilotHarness.discover("#app"));

  const result = await page.evaluate(() =>
    (window as any).JobPilotHarness.fill("City", "Phoenix, Arizona, United States"));

  expect(result.status).toBe("filled");
  // Four "Phoenix, …" suggestions exist; only the Arizona one may be chosen.
  expect(await committed(page, "City")).toBe("Phoenix, AZ, US");
});

test("a free-text autocomplete that never opens a menu still accepts its value", async ({ page }) => {
  await renderApplication(page);
  await page.evaluate(() => {
    const add = document.querySelector<HTMLElement>('spl-button[aria-label="Add experience entry"]')!;
    add.shadowRoot!.querySelector("button")!.click();
  });
  await page.evaluate(() => (window as any).JobPilotHarness.discover("#app"));

  const result = await page.evaluate(() => (window as any).JobPilotHarness.fill("Title", "Software Engineer"));
  expect(result.status).toBe("filled");
  expect(await committed(page, "Title")).toBe("Software Engineer");
});

test("Experience and Education are expanded and populated from the profile", async ({ page }) => {
  await renderApplication(page);

  const traces = await page.evaluate(
    (profile) => (window as any).JobPilotHarness.fillRepeatable(profile, "#app"),
    PROFILE
  );

  const experience = traces.find((trace: any) => trace.sectionKind === "work_experience");
  const education = traces.find((trace: any) => trace.sectionKind === "education");
  expect(experience, JSON.stringify(traces)).toBeTruthy();
  expect(experience.recordsAdded, JSON.stringify(experience)).toBe(1);
  expect(education.recordsAdded, JSON.stringify(education)).toBe(1);

  expect(await committed(page, "Title")).toBe("Software Engineer");
  expect(await committed(page, "Company")).toBe("Moveworks");
  expect(await committed(page, "Office location")).toBe("Mountain View, California, United States");
  expect(await committed(page, "Description")).toBe("Built agentic evaluation harnesses.");
  expect(await committed(page, "From")).toBe("2022-03");
  expect(await committed(page, "To")).toBe("2024-08");

  expect(await committed(page, "Institution")).toBe("Arizona State University");
  expect(await committed(page, "Major")).toBe("Computer Science");
  expect(await committed(page, "Degree")).toBe("Master of Science");
});

test("the date picker's own year spinner is never typed into", async ({ page }) => {
  await renderApplication(page);
  await page.evaluate((profile) => (window as any).JobPilotHarness.fillRepeatable(profile, "#app"), PROFILE);

  const spinners = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("spl-date-field"))
      .map((host) => host.shadowRoot!.querySelector<HTMLInputElement>('input[aria-label="Current year"]')!.value));
  expect(spinners.every((value) => value === "")).toBe(true);
});

test("a school-location field never receives the institution name", async ({ page }) => {
  await renderApplication(page);
  await page.evaluate((profile) => (window as any).JobPilotHarness.fillRepeatable(profile, "#app"), PROFILE);
  // "School location" contains the word "school"; it is a place, not the school.
  expect(await committed(page, "School location")).toBe("");
});
