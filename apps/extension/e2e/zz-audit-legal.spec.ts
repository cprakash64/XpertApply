/* AUDIT ARTIFACT — temporary. Fixture D: adversarial employment-eligibility semantics. */
import { test, stubApi, seedHandoff } from "./zz-audit-harness";

test.setTimeout(240_000);

// Profile truth: authorized to work = YES; requires sponsorship (now or future) = NO.
const QUESTIONS: [string, string][] = [
  ["q1", "Are you legally authorized to work in the United States?"],
  ["q2", "Will you now or in the future require sponsorship for employment visa status?"],
  ["q3", "Do you require sponsorship to work in the United States?"],
  ["q4", "Are you able to work without sponsorship?"],
  ["q5", "Are you currently sponsored by an employer?"],
  ["q6", "Do you NOT require sponsorship now or in the future?"],
  ["q7", "Are you unauthorized to work in the United States?"],
  ["q8", "Will you require visa transfer or sponsorship in the future?"],
  ["q9", "Are you legally authorised to work in the UK?"],
  ["q10", "Do you have the right to work in Canada without sponsorship?"],
  ["q11", "Would you require the company to commence an immigration case (i.e., H-1B, TN)?"],
  ["q12", "Are you at least 18 years of age?"],
  ["q13", "I certify that the information provided is true and complete."],
  ["q14", "Have you ever been convicted of a felony?"],
  ["q15", "What is your gender?"],
  ["q16", "Please select your race/ethnicity"],
  ["q17", "Are you a protected veteran?"],
  ["q18", "Do you have a disability?"]
];

const OPTIONS: Record<string, string[]> = {
  q13: ["I agree"],
  q15: ["Male", "Female", "Non-binary", "Decline to self identify"],
  q16: ["Asian", "White", "Black or African American", "Hispanic or Latino", "Decline to self identify"],
  q17: ["I identify as one or more of the classifications of a protected veteran", "I am not a protected veteran", "I don't wish to answer"],
  q18: ["Yes, I have a disability", "No, I do not have a disability", "I do not want to answer"]
};

const body = QUESTIONS.map(([id, text]) => {
  const opts = OPTIONS[id] ?? ["Yes", "No"];
  const radios = opts.map((o, i) =>
    `<label><input type="radio" name="${id}" id="${id}_${i}" value="${o}" required> ${o}</label>`).join(" ");
  return `<fieldset id="fs_${id}"><legend>${text}</legend>${radios}</fieldset>`;
}).join("\n");

const PAGE = `<!doctype html><meta charset="utf-8"><title>AuditCo — Application</title>
<h1>Apply for Staff Engineer</h1><h2>Personal information</h2>
<form id="application-form" action="/submit" method="post">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" name="phone" required>
  <label for="resume">Resume/CV</label><input type="file" id="resume" name="resume">
  ${body}
  <button type="submit" id="final-submit">Submit application</button>
</form>`;

test("AUDIT-5 legal / sensitive question semantics", async ({ context, worker, origin, routes }) => {
  routes.set("/legal", PAGE);
  const applicationUrl = `${origin}/legal`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  await page.waitForTimeout(45_000);

  const answers = await page.evaluate((ids: string[]) => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const checked = document.querySelector<HTMLInputElement>(`input[name="${id}"]:checked`);
      out[id] = checked ? checked.value : "(blank)";
    }
    return out;
  }, QUESTIONS.map(([id]) => id));

  const lines = QUESTIONS.map(([id, text]) => `${id.padEnd(4)} | ${answers[id].padEnd(60)} | ${text}`);
  console.log("AUDIT-5 LEGAL ANSWERS\n" + lines.join("\n"));
  await page.close();
});
