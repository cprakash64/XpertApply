/* AUDIT ARTIFACT — temporary. Fixture D: adversarial employment-eligibility semantics. */
import { test, stubApi, seedHandoff } from "./zz-audit-harness";

test.setTimeout(240_000);

// Profile truth: authorized to work = YES; requires sponsorship (now or future) = NO.
const QUESTIONS: [string, string][] = [
  ["r1", "Are you legally authorized to work in the United States without sponsorship?"],
  ["r2", "I do not now, nor in the future, will require sponsorship to work in the United States."],
  ["r3", "Do you have the legal right to work in the United Kingdom?"],
  ["r4", "Are you legally authorized to work in Germany?"],
  ["r5", "Are you legally eligible to work in India?"],
  ["r6", "Do you now, or will you in the future, require immigration sponsorship to work in Australia?"],
  ["r7", "Are you authorized to work in the country where this role is located?"],
  ["r8", "Will you require sponsorship now or at any point in the future? (Answer No if you will not)"],
  ["r9", "Do you confirm you do not require work sponsorship?"],
  ["r10", "Please confirm you have read and accept our candidate privacy notice."],
  ["r11", "I acknowledge that any false statement may result in dismissal."],
  ["r12", "I consent to a background check being performed."],
  ["r13", "By checking this box I electronically sign this application."],
  ["r14", "Do you agree to our terms and conditions?"]
];

const OPTIONS: Record<string, string[]> = {
  r10: ["I accept"],
  r11: ["I acknowledge"],
  r12: ["I consent"],
  r13: ["I agree"],
  r14: ["Yes"]
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
  routes.set("/legal2", PAGE);
  const applicationUrl = `${origin}/legal2`;
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
  console.log("AUDIT-6 LEGAL ANSWERS ROUND 2\n" + lines.join("\n"));
  await page.close();
});
