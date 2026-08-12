/**
 * Experience, Education and the resume attachment on a web-component application.
 *
 * The reported gaps on the live SmartRecruiters "Easy Apply" form (ServiceNow's
 * destination), each of which had a different cause:
 *
 *   • Experience and Education were never expanded or filled — the section
 *     vocabulary knew "Project Experience" and "Honors and Awards" but not the
 *     two sections almost every application has;
 *   • the tailored resume was never attached — the real `<input type="file">`
 *     lives inside `spl-dropzone`'s shadow root, and the page has TWO of them:
 *     one that parses a resume to prefill the form, one that attaches it;
 *   • the Add and Save controls are `<spl-button aria-label="…">` components
 *     whose inner `<button>` has no accessible name of its own.
 *
 * The DOM below reproduces each of those shapes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifySectionHeading, findAddControl, findSections } from "../application/sectionControls";
import {
  GenericRepeatableSectionAdapter,
  fillRepeatableSections,
  searchQueryFor
} from "../application/repeatableSections";
import { discoverUploadInputs } from "../ats/base";
import { prepareDocumentUploads } from "../content/autofill";
import { searchQueries } from "../fields/dropdown/index";
import type { ApplicationSessionData } from "../types";

/** A `spl-input`-shaped field: host in the light DOM, real control in shadow. */
function splField(tag: string, id: string, label: string, control: "input" | "textarea" = "input"): HTMLElement {
  const host = document.createElement(tag);
  host.setAttribute("label", label);
  const shadow = host.attachShadow({ mode: "open" });
  const element = document.createElement(control);
  element.id = id;
  if (control === "input") element.setAttribute("type", "text");
  const labelEl = document.createElement("label");
  labelEl.setAttribute("for", id);
  labelEl.textContent = label;
  shadow.append(labelEl, element);
  return host;
}

/** A `spl-button`: the name is on the HOST, the click target is inside. */
function splButton(ariaLabel: string, text: string): HTMLElement {
  const host = document.createElement("spl-button");
  host.setAttribute("aria-label", ariaLabel);
  const shadow = host.attachShadow({ mode: "open" });
  const button = document.createElement("button");
  button.appendChild(document.createElement("slot"));
  shadow.appendChild(button);
  const span = document.createElement("span");
  span.textContent = text;
  host.appendChild(span);
  return host;
}

/** A `spl-dropzone`: file input inside the shadow root. */
function splDropzone(dataTest: string): HTMLElement {
  const host = document.createElement("spl-dropzone");
  host.setAttribute("data-test", dataTest);
  const shadow = host.attachShadow({ mode: "open" });
  const input = document.createElement("input");
  input.type = "file";
  input.id = "file-input";
  shadow.appendChild(input);
  return host;
}

const session = {
  sessionId: 1,
  atsType: "generic",
  officialUrl: "https://jobs.smartrecruiters.com/x",
  jobTitle: "Engineer",
  company: "ServiceNow",
  answers: [],
  unresolvedQuestions: [],
  profileData: {
    experience: [
      {
        company: "Moveworks",
        title: "Software Engineer",
        location: "Mountain View, California, United States",
        start_date: "2022-03",
        end_date: "2024-08",
        currently_working: false
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
  }
} as unknown as ApplicationSessionData;

function buildPage(): void {
  document.body.innerHTML = `
    <main>
      <div id="easy-apply"><h2>Easy Apply</h2><p>Choose an option to autocomplete your application.</p></div>
      <div id="experience-section"><h2>Experience</h2><div id="experience-body"></div></div>
      <div id="education-section"><h2>Education</h2><div id="education-body"></div></div>
      <div id="resume-section"><h2>Resume</h2><div id="resume-body"></div></div>
    </main>
  `;
  document.getElementById("easy-apply")!.appendChild(splDropzone("apply-with-resume-container"));
  document.getElementById("resume-body")!.appendChild(splDropzone("resume-upload"));

  attachEditor("experience-body", "Add experience entry", "Save experience entry", [
    ["spl-input", "exp-title", "Title"],
    ["spl-input", "exp-company", "Company"],
    ["spl-input", "exp-location", "Office location"],
    ["spl-date-field", "exp-from", "From"],
    ["spl-date-field", "exp-to", "To"]
  ]);
  attachEditor("education-body", "Add education entry", "Save education entry", [
    ["spl-input", "edu-school", "School"],
    ["spl-input", "edu-degree", "Degree"],
    ["spl-input", "edu-major", "Major"],
    ["spl-input", "edu-gpa", "GPA"]
  ]);
}

/** Add reveals the fields inline (no dialog), exactly like the live form. */
function attachEditor(
  bodyId: string,
  addLabel: string,
  saveLabel: string,
  fields: [string, string, string][]
): void {
  const body = document.getElementById(bodyId)!;
  const add = splButton(addLabel, "Add");
  body.appendChild(add);
  add.shadowRoot!.querySelector("button")!.addEventListener("click", () => {
    if (body.querySelector(".entry")) return;
    const entry = document.createElement("div");
    entry.className = "entry";
    for (const [tag, id, label] of fields) {
      entry.appendChild(splField(tag, id, label, "input"));
    }
    // A date picker also renders its calendar's own year spinner.
    const spinner = document.createElement("input");
    spinner.type = "number";
    spinner.setAttribute("aria-label", "Current year");
    entry.appendChild(spinner);
    entry.appendChild(splButton(saveLabel, "Save"));
    body.appendChild(entry);
  });
}

/** The value a control holds, wherever it lives. */
function valueOf(id: string): string {
  for (const host of Array.from(document.querySelectorAll("*"))) {
    const found = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.getElementById(id);
    if (found) return (found as HTMLInputElement).value;
  }
  return "";
}

beforeEach(() => {
  vi.restoreAllMocks();
  buildPage();
});

describe("section vocabulary", () => {
  it("recognises the two sections almost every application has", () => {
    expect(classifySectionHeading("Experience")).toBe("work_experience");
    expect(classifySectionHeading("Work Experience")).toBe("work_experience");
    expect(classifySectionHeading("Employment History")).toBe("work_experience");
    expect(classifySectionHeading("Education")).toBe("education");
    expect(classifySectionHeading("Academic Background")).toBe("education");
  });

  it("never confuses a more specific experience section for the general one", () => {
    expect(classifySectionHeading("Project Experience")).toBe("project_experience");
    expect(classifySectionHeading("Internship Experience")).toBe("internship_experience");
    // Not a section at all — an anchored heading match must not fire on prose.
    expect(classifySectionHeading("Experience with distributed systems")).toBeNull();
  });

  it("finds sections whose heading and controls are web components", () => {
    const sections = findSections(document).map((match) => match.section);
    expect(sections).toContain("work_experience");
    expect(sections).toContain("education");
  });

  it("resolves an Add control whose name lives on the component host", () => {
    const experience = findSections(document).find((match) => match.section === "work_experience")!;
    const add = findAddControl(experience);
    expect(add).not.toBeNull();
    // The innermost real control is chosen, not the wrapper — a host and its
    // own implementation button would otherwise read as two candidates and the
    // resolver refuses to guess between candidates.
    expect(add!.tagName).toBe("BUTTON");
  });
});

describe("filling Experience and Education from the profile", () => {
  it("expands each section and fills it from confirmed profile records", async () => {
    const traces = await fillRepeatableSections(document, session);
    const experience = traces.find((trace) => trace.sectionKind === "work_experience")!;
    const education = traces.find((trace) => trace.sectionKind === "education")!;

    expect(experience.candidateRecordCount).toBe(1);
    expect(experience.recordsAdded).toBe(1);
    expect(experience.failureCode).toBe("RECORD_ADDED_AND_VERIFIED");
    expect(valueOf("exp-title")).toBe("Software Engineer");
    expect(valueOf("exp-company")).toBe("Moveworks");
    expect(valueOf("exp-location")).toBe("Mountain View, California, United States");

    expect(education.recordsAdded).toBe(1);
    expect(valueOf("edu-school")).toBe("Arizona State University");
    expect(valueOf("edu-degree")).toBe("Master of Science");
    expect(valueOf("edu-major")).toBe("Computer Science");
    expect(valueOf("edu-gpa")).toBe("3.9");
  });

  it("puts the start and end dates in their own fields", async () => {
    await fillRepeatableSections(document, session);
    expect(valueOf("exp-from")).toBe("2022-03");
    expect(valueOf("exp-to")).toBe("2024-08");
  });

  it("never types into a date picker's own year spinner", async () => {
    await fillRepeatableSections(document, session);
    const spinner = document.querySelector<HTMLInputElement>('input[aria-label="Current year"]')!;
    expect(spinner.value).toBe("");
  });

  it("reports nothing to do rather than inventing records", async () => {
    const empty = { ...session, profileData: { experience: [], education: [] } } as ApplicationSessionData;
    const traces = await fillRepeatableSections(document, empty);
    for (const trace of traces) {
      expect(trace.recordsAdded).toBe(0);
      expect(trace.failureCode).toBe("NO_CONFIRMED_PROFILE_RECORDS");
    }
  });

  it("treats an inline editor with no Save control as already committed", async () => {
    // Remove the Save buttons; the fields themselves are then the entry.
    document.getElementById("experience-body")!.appendChild(document.createElement("div"));
    const adapter = new GenericRepeatableSectionAdapter();
    const inline = document.createElement("div");
    expect(await adapter.save(inline)).toBe(true);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    expect(await adapter.save(dialog)).toBe(false);
  });
});

describe("resume attachment", () => {
  it("finds the file input inside a web-component dropzone", () => {
    const targets = discoverUploadInputs(document);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((target) => target.input.type === "file")).toBe(true);
  });

  it("prefers the attachment dropzone over the parse-my-resume one", () => {
    const targets = discoverUploadInputs(document);
    const chosen = targets.find((target) => target.kind === "resume")!;
    const host = chosen.input.getRootNode() as ShadowRoot;
    expect((host.host as HTMLElement).getAttribute("data-test")).toBe("resume-upload");
    // The import control must not be offered as a second upload target: it
    // re-parses the document and overwrites answers already given.
    expect(targets.filter((target) => target.kind === "resume")).toHaveLength(1);
  });

  it("falls back to the import dropzone when it is the only one", () => {
    document.getElementById("resume-body")!.innerHTML = "";
    const targets = discoverUploadInputs(document);
    expect(targets).toHaveLength(1);
    const host = targets[0].input.getRootNode() as ShadowRoot;
    expect((host.host as HTMLElement).getAttribute("data-test")).toBe("apply-with-resume-container");
  });
});

/**
 * The live ServiceNow/SmartRecruiters "Easy Apply" block, which is the only
 * upload control on that page and never uses the word "resume".
 *
 * Its absence is the whole failure chain the user saw: no upload target → no
 * document reached the ATS → nothing was parsed → Experience and Education
 * stayed empty and the panel reported "ATS populated 0".
 */
function easyApplyPage(options: { accept?: string; heading?: string; caption?: string } = {}): HTMLInputElement {
  document.body.innerHTML = `
    <form>
      <section id="easy-apply">
        <h2>${options.heading ?? "Easy Apply"}</h2>
        <p>${options.caption ?? "Choose an option to autocomplete your application. You can still fill your profile manually."}</p>
        <div id="dropzone"><span>Choose a file or drop it here</span><span>10MB size limit</span></div>
      </section>
      <section><h2>Personal information</h2></section>
    </form>
  `;
  const input = document.createElement("input");
  input.type = "file";
  if (options.accept !== undefined) input.setAttribute("accept", options.accept);
  document.getElementById("dropzone")!.appendChild(input);
  return input;
}

describe("document dropzone that never says resume", () => {
  it("uses the Easy Apply dropzone when it is the only upload control", () => {
    const input = easyApplyPage({ accept: ".pdf,.doc,.docx" });
    expect(discoverUploadInputs(document)).toEqual([{ input, kind: "resume" }]);
  });

  it("still recognises it when the control declares no accept list", () => {
    const input = easyApplyPage();
    expect(discoverUploadInputs(document)).toEqual([{ input, kind: "resume" }]);
  });

  it("never treats an image dropzone as a resume field", () => {
    easyApplyPage({ accept: "image/png,image/jpeg", heading: "Profile photo", caption: "Choose a file or drop it here." });
    expect(discoverUploadInputs(document)).toEqual([]);
  });

  it("refuses a file control whose block says nothing about files at all", () => {
    document.body.innerHTML = `
      <form><section><h2>References</h2><p>Add anyone we may contact.</p><div id="slot"></div></section></form>
    `;
    const bare = document.createElement("input");
    bare.type = "file";
    bare.setAttribute("accept", ".pdf");
    document.getElementById("slot")!.appendChild(bare);
    expect(discoverUploadInputs(document)).toEqual([]);
  });

  it("attaches to a document-only dropzone in an unnamed Attachments block", () => {
    // No resume field anywhere and one document dropzone: attaching there is
    // the correct outcome, not a guess between two possibilities.
    const input = easyApplyPage({
      accept: ".pdf",
      heading: "Attachments",
      caption: "Anything else you would like to share."
    });
    expect(discoverUploadInputs(document)).toEqual([{ input, kind: "resume" }]);
  });

  it("prefers a named resume field and never adds the unnamed one beside it", () => {
    easyApplyPage({ accept: ".pdf,.doc,.docx" });
    const named = document.createElement("input");
    named.type = "file";
    named.setAttribute("aria-label", "Resume");
    document.querySelector("form")!.appendChild(named);
    expect(discoverUploadInputs(document)).toEqual([{ input: named, kind: "resume" }]);
  });

  it("reaches an Easy Apply block that sits outside the scored question root", async () => {
    easyApplyPage({ accept: ".pdf,.doc,.docx" });
    // The scored application root is the question form, which the Easy Apply
    // block sits above. Scoping must not be the reason nothing is attached.
    const questions = document.createElement("div");
    questions.id = "questions";
    questions.innerHTML = '<label>First name<input name="first_name"></label>';
    document.querySelector("form")!.appendChild(questions);

    const attempted: string[] = [];
    const prepared = await prepareDocumentUploads(
      { sessionId: 1, atsType: "generic", officialUrl: "https://jobs.example.test/x", answers: [], unresolvedQuestions: [] } as unknown as ApplicationSessionData,
      {
        fetchDocument: async (kind) => { attempted.push(kind); return null; },
        onUploadStart: () => undefined
      },
      questions
    );

    expect(attempted).toEqual(["resume"]);
    expect(prepared.reviewDocs).toEqual(["resume"]);
  });

  it("refuses to guess between two unnamed document dropzones", () => {
    easyApplyPage({ accept: ".pdf,.doc,.docx" });
    const second = document.getElementById("dropzone")!.cloneNode(true) as HTMLElement;
    second.id = "dropzone-2";
    document.getElementById("easy-apply")!.appendChild(second);
    expect(discoverUploadInputs(document)).toEqual([]);
  });
});

describe("searchable location controls", () => {
  it("falls back to the leading token so a remote picker returns results", () => {
    expect(searchQueries(undefined, "Phoenix, Arizona, United States")).toEqual([
      "Phoenix, Arizona, United States",
      "Phoenix"
    ]);
  });

  it("keeps an explicit caller query first", () => {
    expect(searchQueries("Phoenix", "Phoenix, Arizona")[0]).toBe("Phoenix");
  });

  it("does not shorten a value that has no leading token", () => {
    expect(searchQueries(undefined, "Berlin")).toEqual(["Berlin"]);
  });

  it("uses the same rule for section fields", () => {
    expect(searchQueryFor("Mountain View, California, United States")).toBe("Mountain View");
    expect(searchQueryFor("Moveworks")).toBe("Moveworks");
  });
});
