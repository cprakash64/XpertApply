import { beforeEach, describe, expect, it } from "vitest";
import { fillRepeatableSections, GenericRepeatableSectionAdapter, structuredCandidateCounts } from "../application/repeatableSections";
import type { ApplicationSessionData } from "../types";

const box = { x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30, toJSON: () => ({}) } as DOMRect;
beforeEach(() => {
  document.body.innerHTML = "";
  HTMLElement.prototype.getBoundingClientRect = () => box;
  HTMLElement.prototype.scrollIntoView = () => undefined;
});

function session(profileData: Record<string, unknown>): ApplicationSessionData {
  return { sessionId: 66, atsType: "generic", officialUrl: "https://example.test/app", jobTitle: "Engineer", company: "Example", profileData, answers: [], unresolvedQuestions: [] };
}

function sectionFixture(heading: string, fields: { label: string; name: string; required?: boolean }[]): HTMLElement {
  const section = document.createElement("section");
  section.innerHTML = `<h2>${heading}</h2><button type="button">Add</button><div data-items></div>`;
  section.querySelector("button")!.addEventListener("click", () => {
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog");
    for (const spec of fields) {
      const label = document.createElement("label"); label.textContent = spec.label;
      const input = spec.name === "description" ? document.createElement("textarea") : document.createElement("input");
      input.name = spec.name; input.required = Boolean(spec.required); label.appendChild(input); dialog.appendChild(label);
    }
    const save = document.createElement("button"); save.type = "button"; save.textContent = "Save";
    save.addEventListener("click", () => {
      const article = document.createElement("article");
      article.textContent = Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")).map((item) => item.value).join(" ");
      section.querySelector("[data-items]")!.appendChild(article); dialog.remove();
    });
    dialog.appendChild(save); document.body.appendChild(dialog);
  });
  document.body.appendChild(section); return section;
}

describe("generic repeatable-section takeover", () => {
  it("adds and verifies a confirmed project through a portaled modal editor", async () => {
    sectionFixture("Project Experience", [{ label: "Project name", name: "name", required: true }, { label: "Description", name: "description" }]);
    const traces = await fillRepeatableSections(document, session({ projects: [{ name: "Compiler Lab", description: "Built a parser", verified: true }] }));
    expect(traces[0]).toMatchObject({ sectionKind: "project_experience", recordsAdded: 1, failureCode: "RECORD_ADDED_AND_VERIFIED" });
    expect(document.querySelector("article")?.textContent).toContain("Compiler Lab");
  });

  it("adds awards, languages, and professional links only from structured data", async () => {
    sectionFixture("Awards", [{ label: "Award name", name: "name", required: true }]);
    sectionFixture("Languages", [{ label: "Language", name: "language", required: true }, { label: "Proficiency level", name: "proficiency", required: true }]);
    sectionFixture("SNS", [{ label: "URL", name: "url", required: true }, { label: "Title", name: "title" }]);
    const traces = await fillRepeatableSections(document, session({
      awards: [{ name: "Research Award", verified: true }],
      languages: [{ language: "Spanish", proficiency: "professional", verified: true }],
      linkedin_url: "https://linkedin.com/in/example"
    }));
    expect(traces.map((item) => [item.sectionKind, item.recordsAdded])).toEqual([
      ["honors_awards", 1], ["language_skills", 1], ["sns", 1]
    ]);
  });

  it("skips a duplicate record idempotently after retry", async () => {
    const section = sectionFixture("Projects", [{ label: "Project name", name: "name", required: true }]);
    section.querySelector("[data-items]")!.innerHTML = "<article>Compiler Lab</article>";
    const adapter = new GenericRepeatableSectionAdapter();
    const traces = await fillRepeatableSections(document, session({ projects: [{ name: "Compiler Lab", verified: true }] }), adapter);
    expect(traces[0]).toMatchObject({ recordsAdded: 0, duplicatesSkipped: 1 });
    expect(traces[0].failureCode).toBe("DUPLICATE_ALREADY_PRESENT");
  });

  it("does not count an optional empty section as missing information", async () => {
    sectionFixture("Awards", [{ label: "Award name", name: "name", required: true }]);
    const [trace] = await fillRepeatableSections(document, session({ awards: [] }));
    expect(trace.required).toBe(false);
    expect(trace.failureCode).toBe("NO_CONFIRMED_PROFILE_RECORDS");
  });

  it("does not infer internship records from ordinary experience titles", async () => {
    sectionFixture("Internship Experience", [{ label: "Organization", name: "organization", required: true }]);
    const [trace] = await fillRepeatableSections(document, session({ experience: [{ company: "Example", title: "Engineer" }] }));
    expect(trace.candidateRecordCount).toBe(0);
    expect(trace.recordsAdded).toBe(0);
  });

  it("refuses to save an incomplete record when the editor's required field has no confirmed value", async () => {
    sectionFixture("Projects", [{ label: "Project name", name: "name", required: true }, { label: "Required URL", name: "url", required: true }]);
    const [trace] = await fillRepeatableSections(document, session({ projects: [{ name: "Compiler Lab", verified: true }] }));
    expect(trace.recordsAdded).toBe(0);
    expect(trace.failureCode).toBe("REQUIRED_RECORD_FIELD_MISSING");
  });

  it("reports a candidate with no Add control as a technical section outcome", async () => {
    document.body.innerHTML = "<section><h2>Projects</h2></section>";
    const [trace] = await fillRepeatableSections(document, session({ projects: [{ id: 41, name: "Compiler Lab" }] }));
    expect(trace).toMatchObject({ candidateRecordCount: 1, candidateRecordIds: ["project-41"], recordsAdded: 0 });
    expect(trace.failureCode).toBe("ADD_CONTROL_NOT_FOUND");
  });

  /**
   * The live ServiceNow (SmartRecruiters) Experience section: a blank entry
   * form is already on screen beside the "+ Add" button. Pressing Add there
   * appends a SECOND blank row and leaves the visible one empty — which is
   * exactly what the user saw.
   */
  function preRenderedEditor(heading: string, fields: { label: string; name: string; required?: boolean }[]): {
    section: HTMLElement;
    addClicks: () => number;
  } {
    let clicks = 0;
    const section = document.createElement("section");
    section.innerHTML = `<h2>${heading}</h2><button type="button">+ Add</button>`;
    section.querySelector("button")!.addEventListener("click", () => { clicks += 1; });
    const editor = document.createElement("div");
    for (const spec of fields) {
      const label = document.createElement("label");
      label.textContent = spec.label;
      // A Description box is a textarea on the live form; a single-line input
      // would silently strip the line breaks between bullet lines.
      const input = spec.name === "description"
        ? document.createElement("textarea")
        : document.createElement("input");
      input.name = spec.name;
      input.required = Boolean(spec.required);
      label.appendChild(input);
      editor.appendChild(label);
    }
    section.appendChild(editor);
    document.body.appendChild(section);
    return { section, addClicks: () => clicks };
  }

  it("fills the entry form the section already shows instead of adding a second blank row", async () => {
    const { section, addClicks } = preRenderedEditor("Experience", [
      { label: "Title", name: "title", required: true },
      { label: "Company", name: "company" },
      { label: "Office location", name: "location" }
    ]);
    const [trace] = await fillRepeatableSections(document, session({
      experience: [{ company: "Moveworks", title: "Software Engineer", location: "Mountain View" }]
    }));
    expect(addClicks()).toBe(0);
    expect(section.querySelector<HTMLInputElement>('input[name="title"]')!.value).toBe("Software Engineer");
    expect(section.querySelector<HTMLInputElement>('input[name="company"]')!.value).toBe("Moveworks");
    expect(trace).toMatchObject({ sectionKind: "work_experience", recordsAdded: 1 });
  });

  it("writes the Description from the user's own reviewed bullet lines", async () => {
    const { section } = preRenderedEditor("Experience", [
      { label: "Title", name: "title", required: true },
      { label: "Description", name: "description" }
    ]);
    await fillRepeatableSections(document, session({
      experience: [{
        company: "Moveworks",
        title: "Software Engineer",
        bullets: ["• Built the agentic evaluation harness", "Cut regression triage time by half"],
        technologies: ["Python"]
      }]
    }));
    expect(section.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!.value).toBe(
      "Built the agentic evaluation harness\nCut regression triage time by half"
    );
  });

  it("leaves the Description empty rather than writing prose nobody entered", async () => {
    const { section } = preRenderedEditor("Experience", [
      { label: "Title", name: "title", required: true },
      { label: "Description", name: "description" }
    ]);
    await fillRepeatableSections(document, session({
      experience: [{ company: "Moveworks", title: "Software Engineer" }]
    }));
    expect(section.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!.value).toBe("");
  });

  it("still presses Add when the section's form already holds an entry", async () => {
    const { section, addClicks } = preRenderedEditor("Education", [
      { label: "Institution", name: "school", required: true },
      { label: "Degree", name: "degree" }
    ]);
    section.querySelector<HTMLInputElement>('input[name="school"]')!.value = "Somewhere Else University";
    await fillRepeatableSections(document, session({
      education: [{ school: "Arizona State University", degree: "Master of Science" }]
    }));
    expect(addClicks()).toBe(1);
    // The entry the user already had is never overwritten.
    expect(section.querySelector<HTMLInputElement>('input[name="school"]')!.value).toBe("Somewhere Else University");
  });

  it("preserves redacted candidate counts through parsed extension state", () => {
    expect(structuredCandidateCounts(session({
      projects: [{ id: 41, name: "Compiler Lab" }],
      awards: [{ id: 9, name: "Research Award" }],
      languages: [{ language: "Spanish", proficiency: "professional" }],
      linkedin_url: "https://linkedin.com/in/example",
      portfolio_url: "https://portfolio.example.test"
    }))).toMatchObject({
      projects: 1, awards: 1, languages: 1, professionalLinks: 1,
      workSamples: 1, reviewedResumeExtraction: 0
    });
  });
});
