/**
 * Owned Workday-shaped fixtures (EXT-LIVE-05W). These imitate the structure Workday publicly exposes
 * (data-automation-id attributes, a progress bar, a footer with Next, a review page with Submit). They are
 * NOT captures of any employer's site and prove nothing about live tenants.
 */
export interface StepDef { name: string; body: string; required: string[] }
export interface FixtureConfig { id: string; description: string; steps: StepDef[] }

const field = (label: string, name: string, automation: string, opts: { type?: string; required?: boolean; noLabel?: boolean } = {}) =>
  `<div data-automation-id="formField-${automation}">${opts.noLabel ? "" : `<label for="${name}">${label}${opts.required ? " *" : ""}</label>`}<input id="${name}" name="${name}" type="${opts.type ?? "text"}" data-automation-id="${automation}" ${opts.required ? "required" : ""}></div>`;

const myInfo = (noLabel = false) => ({
  name: "My Information",
  body: [
    field("First Name", "fn", "legalNameSection_firstName", { required: true, noLabel }),
    field("Last Name", "ln", "legalNameSection_lastName", { required: true, noLabel }),
    field("Email Address", "em", "email", { type: "email", required: true, noLabel }),
    field("Phone Number", "ph", "phone-number", { type: "tel", required: true, noLabel }),
    field("City", "city", "addressSection_city", { required: true, noLabel })
  ].join(""),
  required: ["fn", "ln", "em", "ph", "city"]
});

const experience = (n: number): StepDef => ({
  name: "My Experience",
  body: Array.from({ length: n }, (_, i) => field(`Job Title ${i + 1}`, `jt${i}`, "jobTitle", { required: false }) + field(`Company ${i + 1}`, `co${i}`, "companyName", { required: false })).join(""),
  required: []
});

const questions = (conditional: boolean): StepDef => ({
  name: "Application Questions",
  body: `${field("Are you legally authorized to work in the country in which this job is located?", "auth", "q-auth", { required: true })}${conditional ? field("If you answered yes, describe your visa status", "visa", "q-visa", { required: false }) : ""}`,
  required: ["auth"]
});

const disclosures: StepDef = { name: "Voluntary Disclosures", body: `<label><input type="checkbox" id="ack" required> I have read and acknowledge the statement above *</label>`, required: ["ack"] };
const review: StepDef = { name: "Review", body: `<h2>Review</h2><p>Check everything.</p>`, required: [] };

export const CONFIGS: FixtureConfig[] = [
  { id: "A-classic-4step", description: "My Information, My Experience (1 job), Questions, Review", steps: [myInfo(), experience(1), questions(false), review] },
  { id: "B-with-disclosures", description: "adds Voluntary Disclosures before Review", steps: [myInfo(), experience(2), questions(false), disclosures, review] },
  { id: "C-automation-id-only", description: "labels absent; automation ids only", steps: [myInfo(true), experience(1), review] },
  { id: "D-conditional-questions", description: "extra conditional question", steps: [myInfo(), questions(true), review] },
  { id: "E-many-jobs", description: "three experience entries", steps: [myInfo(), experience(3), review] },
  { id: "F-single-step-plus-review", description: "minimal employer form", steps: [myInfo(), review] }
];

export interface Sim { clicks: { submit: number; next: number }; step: () => number; render: () => void; errors: () => number }

/** Renders the fixture into document.body and wires Next/Submit like a Workday SPA (re-render in place). */
export function mount(config: FixtureConfig): Sim {
  let index = 0;
  let errors = 0;
  const clicks = { submit: 0, next: 0 };
  const render = () => {
    const step = config.steps[index]!;
    const isReview = step.name === "Review";
    document.body.innerHTML = `
      <div data-automation-id="progressBar"><ol>${config.steps.map((s, i) => `<li ${i === index ? 'aria-current="step" data-automation-id="progressBarActiveStep"' : ""}>${s.name}</li>`).join("")}</ol></div>
      <main data-automation-id="applicationPage"><h2>${step.name}</h2><form novalidate>${step.body}</form>
      ${errors ? '<div data-automation-id="errorBanner" role="alert">Errors found on this page</div>' : ""}
      <div data-automation-id="bottom-navigation-footer">${isReview
        ? '<button type="button" data-automation-id="pageFooterSubmitButton">Submit</button>'
        : '<button type="button" data-automation-id="pageFooterBackButton">Back</button><button type="button" data-automation-id="pageFooterNextButton">Save and Continue</button>'}</div></main>`;
    document.querySelector('[data-automation-id="pageFooterSubmitButton"]')?.addEventListener("click", () => { clicks.submit++; });
    document.querySelector('[data-automation-id="pageFooterNextButton"]')?.addEventListener("click", () => {
      clicks.next++;
      const missing = step.required.filter((id) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        return el && (el.type === "checkbox" ? !el.checked : el.value.trim() === "");
      });
      if (missing.length) { errors = missing.length; render(); return; }
      errors = 0; index++; render();
    });
  };
  render();
  return { clicks, step: () => index, render, errors: () => errors };
}
