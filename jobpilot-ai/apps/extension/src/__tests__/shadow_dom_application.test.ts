/**
 * The live ServiceNow failure, as a test.
 *
 * ServiceNow's "I'm interested" leads to SmartRecruiters "Easy Apply"
 * (`jobs.smartrecruiters.com/oneclick-ui/...`). Every applicant control there is
 * a Lit web component whose real `<input>` lives in an OPEN shadow root, and the
 * page also embeds ONE `about:blank` iframe belonging to the LinkedIn
 * `@linkedin/xdoor-sdk` tracker.
 *
 * Before this fixture existed:
 *   • `document.querySelectorAll("input,…")` returned 0 controls;
 *   • the form-root resolver scored every candidate `no_fields`;
 *   • readiness saw no application evidence, timed out, noticed the tracking
 *     iframe was unreadable, and reported APPLICATION_FRAME_UNAVAILABLE —
 *     surfaced to the user as "XpertApply could not reach the embedded
 *     application form", a cross-origin frame problem that did not exist.
 *
 * The DOM below is the real page's structure, reduced to the parts that decide
 * each of those verdicts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { discoverFields } from "../fields/discovery";
import { fillField } from "../fields/fill";
import { resolveApplicationRoot } from "../ats/formRoot";
import {
  censusChildFrames,
  collectApplicationEvidence,
  hasApplicationEvidence
} from "../content/applicationReadiness";
import { probeFrame } from "../frames/probe";
import {
  deepClosest,
  deepContains,
  deepQueryAll,
  deepTextContent,
  openShadowHostCount,
  scopedQuery
} from "../dom/deepDom";

/** One `spl-*` form field: host in the light DOM, real control in the shadow. */
function splField(options: {
  tag: string;
  id: string;
  label: string;
  type?: string;
  autocomplete?: string;
  required?: boolean;
  control?: "input" | "textarea";
}): HTMLElement {
  const host = document.createElement(options.tag);
  host.id = options.id;
  host.setAttribute("label", options.label);
  if (options.required) host.setAttribute("required", "");
  const shadow = host.attachShadow({ mode: "open" });

  const label = document.createElement("label");
  label.setAttribute("for", options.id);
  label.textContent = `${options.label}${options.required ? "*" : ""}`;
  shadow.appendChild(label);

  const control = document.createElement(options.control ?? "input");
  control.id = options.id;
  if (options.control !== "textarea") control.setAttribute("type", options.type ?? "text");
  if (options.autocomplete) control.setAttribute("autocomplete", options.autocomplete);
  if (options.required) control.setAttribute("aria-required", "true");
  shadow.appendChild(control);
  return host;
}

/** The SmartRecruiters City field: a component nested TWO shadow roots deep. */
function splAutocomplete(id: string, label: string): HTMLElement {
  const host = document.createElement("spl-autocomplete");
  host.setAttribute("label", label);
  host.setAttribute("required", "");
  const shadow = host.attachShadow({ mode: "open" });
  // The OUTER component owns the question: the inner field carries neither a
  // `label` attribute nor a `<label>` element of its own.
  const inner = splField({ tag: "spl-input", id, label, required: true });
  inner.removeAttribute("label");
  inner.shadowRoot!.querySelector("label")!.remove();
  shadow.appendChild(inner);
  const innerInput = inner.shadowRoot!.querySelector("input")!;
  innerInput.setAttribute("role", "combobox");
  innerInput.setAttribute("aria-controls", `menu-${id}`);
  const menu = document.createElement("div");
  menu.id = `menu-${id}`;
  menu.setAttribute("role", "listbox");
  inner.shadowRoot!.appendChild(menu);
  return host;
}

function buildEasyApplyPage(): void {
  document.body.innerHTML = `
    <oc-app-root>
      <main>
        <oc-oneclick-form>
          <h2>Easy Apply</h2>
          <oc-personal-information>
            <div id="personal"></div>
          </oc-personal-information>
        </oc-oneclick-form>
      </main>
    </oc-app-root>
    <iframe src="about:blank" id="xdoor-sdk"></iframe>
  `;
  const personal = document.getElementById("personal")!;
  personal.append(
    splField({ tag: "spl-input", id: "first-name-input", label: "First name", autocomplete: "given-name", required: true }),
    splField({ tag: "spl-input", id: "last-name-input", label: "Last name", autocomplete: "family-name", required: true }),
    splField({ tag: "spl-input", id: "email-input", label: "Email", type: "email", autocomplete: "email", required: true }),
    splField({ tag: "spl-input", id: "confirm-email-input", label: "Confirm your email", type: "email", autocomplete: "email", required: true }),
    splAutocomplete("city-input", "City"),
    splField({ tag: "spl-input", id: "phone-input", label: "Phone number", type: "tel", required: true }),
    splField({ tag: "spl-textarea", id: "message-input", label: "Message to the Hiring Team", control: "textarea" })
  );

  // The resume dropzone: a hidden file input inside its own shadow root.
  const dropzone = document.createElement("spl-dropzone");
  const dropShadow = dropzone.attachShadow({ mode: "open" });
  const file = document.createElement("input");
  file.type = "file";
  file.id = "file-input";
  const dropLabel = document.createElement("label");
  dropLabel.setAttribute("for", "file-input");
  dropLabel.textContent = "Resume";
  dropShadow.append(dropLabel, file);
  document.querySelector("oc-oneclick-form")!.appendChild(dropzone);
}

beforeEach(() => {
  buildEasyApplyPage();
});

describe("deep DOM primitives", () => {
  it("finds controls the light-DOM query cannot see", () => {
    expect(document.querySelectorAll("input,textarea,select")).toHaveLength(0);
    expect(deepQueryAll(document, "input,textarea").length).toBeGreaterThanOrEqual(8);
  });

  it("resolves a label whose id is scoped to the control's own shadow root", () => {
    const input = deepQueryAll<HTMLInputElement>(document, "#first-name-input")
      .find((el) => el.tagName === "INPUT")!;
    expect(scopedQuery(input, 'label[for="first-name-input"]')?.textContent).toBe("First name*");
  });

  it("treats a shadow descendant as contained by its light-DOM ancestor", () => {
    const main = document.querySelector("main")!;
    const input = deepQueryAll<HTMLInputElement>(document, "input[autocomplete=email]")[0];
    expect(main.contains(input)).toBe(false);
    expect(deepContains(main, input)).toBe(true);
    expect(deepClosest(input, "main")).toBe(main);
  });

  it("reads text that textContent skips", () => {
    expect(document.body.textContent).not.toMatch(/First name/);
    expect(deepTextContent(document.body)).toMatch(/First name/);
  });

  it("counts nested open shadow hosts", () => {
    // spl-autocomplete nests spl-input, so the walk must go more than one level.
    expect(openShadowHostCount(document)).toBeGreaterThanOrEqual(9);
  });
});

describe("discovery on a web-component application", () => {
  it("discovers every applicant control across shadow boundaries", () => {
    const fields = discoverFields(document);
    const labels = fields.map((field) => field.normalizedLabel);
    expect(labels).toContain("first name");
    expect(labels).toContain("last name");
    expect(labels).toContain("email");
    expect(labels).toContain("confirm your email");
    expect(labels).toContain("phone number");
  });

  it("labels a field from its component host when no label element applies", () => {
    // The City component owns the question; its inner spl-input does not.
    const city = discoverFields(document).find((field) => field.normalizedLabel === "city");
    expect(city).toBeDefined();
    expect(city!.labelSource).toBe("host_label_attribute");
  });

  it("does not surface a combobox's own popup listbox as a field", () => {
    const fields = discoverFields(document);
    expect(fields.filter((field) => field.control === "listbox")).toHaveLength(0);
  });

  it("marks shadow-DOM controls required from their aria-required attribute", () => {
    const first = discoverFields(document).find((field) => field.normalizedLabel === "first name");
    expect(first?.required).toBe(true);
  });

  /**
   * A `<button>` with no `type` attribute reports `type === "submit"`, so the
   * submit-exclusion rule used to drop every bare button — including dropdown
   * triggers, which the aria-haspopup exemption right below it was written to
   * keep. That made the exemption dead code for exactly the controls it named.
   */
  it("discovers a bare <button aria-haspopup=listbox> dropdown trigger", () => {
    const host = document.createElement("spl-select");
    const shadow = host.attachShadow({ mode: "open" });
    const trigger = document.createElement("button");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-label", "Country code");
    shadow.appendChild(trigger);
    document.getElementById("personal")!.appendChild(host);

    const found = discoverFields(document).find((field) => field.ariaLabel === "Country code");
    expect(found).toBeDefined();
    expect(found!.control).toBe("combobox");
  });

  it("still excludes a real submit button", () => {
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Next";
    document.getElementById("personal")!.appendChild(submit);
    expect(discoverFields(document).some((field) => field.label === "Next")).toBe(false);
  });
});

describe("filling a control inside an open shadow root", () => {
  /**
   * An event dispatched inside a shadow root does NOT cross the boundary unless
   * it is `composed`. Without that, SmartRecruiters' `spl-input` never learns
   * that its inner input changed: the field looks filled and the component (and
   * therefore the submitted application) still holds the old value.
   */
  it("notifies the web component that owns the control", async () => {
    const field = discoverFields(document).find((f) => f.normalizedLabel === "first name")!;
    const host = document.getElementById("first-name-input")!;
    const seen: string[] = [];
    for (const type of ["input", "change"]) {
      host.addEventListener(type, () => seen.push(type));
    }

    const outcome = await fillField(field, "Ada", { status: "verified", force: true });

    expect(outcome.status).toBe("filled");
    expect((field.element as HTMLInputElement).value).toBe("Ada");
    expect(seen).toContain("input");
    expect(seen).toContain("change");
  });
});

describe("application root resolution", () => {
  it("resolves a root for a form built entirely from web components", () => {
    const root = resolveApplicationRoot(document);
    expect(root.confident).toBe(true);
    expect(root.candidates[0].fieldCount).toBeGreaterThan(0);
  });
});

describe("readiness evidence", () => {
  it("sees name, email and phone evidence through the shadow boundary", () => {
    const evidence = collectApplicationEvidence(document);
    expect(evidence.nameFields).toBe(true);
    expect(evidence.emailFields).toBe(true);
    expect(evidence.phoneField).toBe(true);
    expect(evidence.resumeUpload).toBe(true);
    expect(hasApplicationEvidence(evidence)).toBe(true);
  });

  it("never blames an about:blank tracking iframe for an unreadable application", () => {
    const frames = censusChildFrames(document);
    expect(frames).toHaveLength(1);
    // jsdom cannot navigate the frame, so it reports the same "unreadable" shape
    // the live LinkedIn xdoor frame does — and must still not be a suspect.
    expect(frames[0].plausibleApplicationHost).toBe(false);
  });

  it("treats a real https child frame as a possible application host", () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("src", "https://boards.greenhouse.io/embed/job_app?token=1");
    document.body.appendChild(frame);
    const census = censusChildFrames(document);
    expect(census.find((f) => f.frameIndex === 1)?.plausibleApplicationHost).toBe(true);
  });

  it("resolves a relative frame src instead of discarding it", () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("src", "/careers/apply/embed");
    document.body.appendChild(frame);
    const census = censusChildFrames(document);
    expect(census.find((f) => f.frameIndex === 1)?.plausibleApplicationHost).toBe(true);
  });
});

describe("frame probe", () => {
  it("reports application labels that only exist inside web components", () => {
    const probe = probeFrame(document);
    expect(probe.applicationLabelsFound).toContain("first_name");
    expect(probe.applicationLabelsFound).toContain("email");
    expect(probe.visibleInputs).toBeGreaterThan(0);
    expect(probe.rootConfident).toBe(true);
  });
});
