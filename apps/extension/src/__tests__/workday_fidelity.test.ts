// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { degreeLevel, norm, parseIsoParts, pickDegree, pickExact, readDate, sameDegree, setDate, type Opt } from "../ats/workdayControls";
import { fillEducation, fillWorkExperience, workdayResumeAlreadyAttached } from "../ats/workdaySections";
import { classifyWorkdayStep, workdayProgress } from "../ats/workdayStep";

const opts = (...labels: string[]): Opt[] => labels.map((label) => ({ label, el: document.createElement("div") }));

describe("option matching never guesses (EXT-LIVE-06)", () => {
  it("exact label only; duplicates are ambiguous", () => {
    expect(pickExact(opts("A", "B"), "b").kind).toBe("one");
    expect(pickExact(opts("A", "B"), "C").kind).toBe("none");
    expect(pickExact(opts("A", "A"), "A").kind).toBe("ambiguous");
  });
  it("a degree level selects only a GENERIC option", () => {
    expect(pickDegree(opts("High School Diploma", "Bachelor's Degree", "Master's Degree"), "Bachelor of Science").kind).toBe("one");
    expect(pickDegree(opts("Bachelor of Arts", "Master of Arts"), "Master of Science").kind).toBe("none");
    expect(pickDegree(opts("Bachelor's Degree", "Bachelor Degree"), "BS").kind).toBe("ambiguous");
    expect(pickDegree(opts("Bachelor's Degree"), "Underwater Basket Weaving").kind).toBe("none");
  });
  it("degree equivalence is by level", () => {
    expect(sameDegree("Master of Science", "Master's Degree")).toBe(true);
    expect(sameDegree("Master of Science", "Bachelor's Degree")).toBe(false);
    expect(degreeLevel("PhD")).toBe("doctor");
    expect(norm("Bachelor’s Degree")).toBe("bachelors degree");
  });
  it("ISO dates split without inventing parts", () => {
    expect(parseIsoParts("2021-03")).toEqual({ year: "2021", month: "03", day: undefined });
    expect(parseIsoParts("2021")).toEqual({ year: "2021", month: undefined, day: undefined });
    expect(parseIsoParts("")).toEqual({});
  });
});

function dateWidget(): HTMLElement {
  document.body.innerHTML = `<div id="w"><input data-automation-id="dateSectionMonth-input" role="spinbutton"><input data-automation-id="dateSectionYear-input" role="spinbutton"></div>`;
  const month = document.querySelector<HTMLInputElement>('[data-automation-id="dateSectionMonth-input"]')!;
  month.addEventListener("input", () => { if (Number(month.value) > 12) month.value = ""; }); // the employer rejects an impossible month
  return document.getElementById("w")!;
}

describe("date widget is verified from the rendered value", () => {
  it("accepts a valid month/year and reads them back", async () => {
    const w = dateWidget();
    expect((await setDate(w, { month: "3", year: "2021" })).ok).toBe(true);
    expect(readDate(w)).toMatchObject({ month: "03", year: "2021" });
  });
  it("reports a value the employer rejected instead of claiming success", async () => {
    const w = dateWidget();
    const r = await setDate(w, { month: "13", year: "2021" });
    expect(r).toEqual({ ok: false, reason: "DATE_MONTH_NOT_COMMITTED" });
  });
});

function workWidget(prefill: Array<{ title: string; company: string }>): { adds: () => number } {
  let adds = 0;
  const row = (i: number, t = "", c = "") => `<div role="group" data-automation-id="workExperience-${i + 1}"><h4>Work Experience ${i + 1}</h4>
    <input data-automation-id="jobTitle" value="${t}"><input data-automation-id="companyName" value="${c}"><input data-automation-id="location">
    <div data-automation-id="startDate"><input data-automation-id="dateSectionMonth-input" role="spinbutton"><input data-automation-id="dateSectionYear-input" role="spinbutton"></div></div>`;
  const rows = prefill.map((p, i) => row(i, p.title, p.company));
  const draw = () => {
    document.body.innerHTML = `<div data-automation-id="workExperienceSection"><h3>Work Experience</h3>${rows.join("")}<button data-automation-id="add-button">Add Another</button></div>`;
    document.querySelector('[data-automation-id="add-button"]')!.addEventListener("click", () => { adds++; rows.push(row(rows.length)); draw(); });
  };
  draw();
  return { adds: () => adds };
}

const JOBS = [
  { company: "Acme Robotics", title: "Senior Engineer", start_date: "2021-03", currently_working: true },
  { company: "Beta Systems", title: "Software Engineer", start_date: "2018-06", end_date: "2021-02" }
];

describe("Workday repeatable work experience", () => {
  beforeEach(() => { document.body.innerHTML = ""; });
  it("creates only the missing rows, matches by employer even when the title differs, preserves other rows and a rerun adds nothing", async () => {
    const w = workWidget([{ title: "Barista", company: "Zeta Cafe" }, { title: "Sr. Engineer", company: "Acme Robotics" }]);
    const first = await fillWorkExperience(document, { experience: JOBS });
    expect(first?.added).toBe(1);                       // only Beta Systems is new
    expect(first?.matched).toBe(1);                     // Acme matched by employer (title wording differs: kept)
    expect(first?.foreignRowsPreserved).toBe(1);        // Zeta Cafe untouched
    expect(first?.keptDifferent).toBeGreaterThanOrEqual(1);
    const titles = Array.from(document.querySelectorAll<HTMLInputElement>('[data-automation-id="jobTitle"]')).map((e) => e.value);
    expect(titles).toEqual(["Barista", "Sr. Engineer", "Software Engineer"]);
    const second = await fillWorkExperience(document, { experience: JOBS });
    expect(second?.added).toBe(0);
    expect(w.adds()).toBe(1);
    expect(document.querySelectorAll('[data-automation-id^="workExperience-"]').length).toBe(3);
  });
  it("is order-independent: reversed existing rows match the same saved records", async () => {
    const w = workWidget([{ title: "Software Engineer", company: "Beta Systems" }, { title: "Senior Engineer", company: "Acme Robotics" }]);
    const r = await fillWorkExperience(document, { experience: JOBS });
    expect(r?.added).toBe(0);
    expect(w.adds()).toBe(0);
    expect(r?.matched).toBe(2);
  });
  it("does nothing when there is no saved experience (nothing invented)", async () => {
    const w = workWidget([]);
    const r = await fillWorkExperience(document, { experience: [] });
    expect(r?.added).toBe(0);
    expect(w.adds()).toBe(0);
  });
});

describe("Workday education with no matching option", () => {
  it("reports the field and does not guess", async () => {
    document.body.innerHTML = `<div data-automation-id="educationSection"><h3>Education</h3>
      <div role="group" data-automation-id="education-1"><h4>Education 1</h4><input data-automation-id="school" value="State U">
      <button aria-haspopup="listbox" data-automation-id="degree">Select One</button></div></div>`;
    document.querySelector<HTMLElement>('[data-automation-id="degree"]')!.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", `<ul role="listbox"><li role="option" data-automation-id="promptOption">Master of Arts</li></ul>`);
    });
    const r = await fillEducation(document, { education: [{ school: "State U", degree: "Master of Science" }] });
    expect(r?.issues.map((i) => i.reason)).toEqual(["OPTION_NOT_AVAILABLE"]);
    expect(document.querySelector('[data-automation-id="degree"]')!.textContent).toBe("Select One");
  });
});

describe("résumé already on file", () => {
  it("is detected so it is never uploaded again", () => {
    document.body.innerHTML = `<div data-automation-id="resumeSection"><input type="file" id="f"><div data-automation-id="file-upload-successful">cv.pdf</div></div>`;
    expect(workdayResumeAlreadyAttached(document.getElementById("f")!)).toBe(true);
    document.body.innerHTML = `<div data-automation-id="resumeSection"><input type="file" id="f"></div>`;
    expect(workdayResumeAlreadyAttached(document.getElementById("f")!)).toBe(false);
  });
});

describe("step classification and progress", () => {
  it("a Submit on an ordinary step is ambiguous, not Review", () => {
    document.body.innerHTML = `<ol data-automation-id="progressBar"><li>My Information</li><li aria-current="step" data-automation-id="progressBarActiveStep">My Experience</li><li>Review</li></ol><button data-automation-id="pageFooterSubmitButton">Submit</button>`;
    expect(classifyWorkdayStep(document)).toBe("ambiguous_submit");
    document.body.innerHTML = `<ol data-automation-id="progressBar"><li>My Experience</li><li aria-current="step" data-automation-id="progressBarActiveStep">Review</li></ol><button data-automation-id="pageFooterSubmitButton">Submit</button>`;
    expect(classifyWorkdayStep(document)).toBe("review");
  });
  it("step counts come only from the employer's progress bar", () => {
    document.body.innerHTML = `<main>Step 1 of 9 marketing text</main>`;
    expect(workdayProgress(document)).toBeNull();
    document.body.innerHTML = `<ol data-automation-id="progressBar"><li>A</li><li aria-current="step">B</li><li>C</li></ol>`;
    expect(workdayProgress(document)).toMatchObject({ index: 2, total: 3, label: "B" });
  });
});
