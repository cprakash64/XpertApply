/* STAGE 3B VERIFICATION ARTIFACT — temporary. Not production code.
 * Reproduces the XA-02/03/04 questions from the original audit against the
 * REAL compiled extension in a real browser. No form is submitted. */
import { test, stubApi, seedHandoff } from "./zz-audit-harness";

test.setTimeout(240_000);

// Profile truth: authorized in the US; does NOT require sponsorship.
const QUESTIONS: [string, string, string][] = [
  // id, question, expected ("" = must stay blank)
  ["q_us_auth",    "Are you legally authorized to work in the United States?", "Yes"],
  ["q_us_nospon",  "Are you legally authorized to work in the United States without sponsorship?", "Yes"],
  ["q_spon_fut",   "Will you now or in the future require sponsorship for employment visa status?", "No"],
  ["q_deferred",   "Are you legally authorized to work in the country where the job is located?", "Yes"],
  // XA-04 — negated wording must NOT inherit the affirmative answer
  ["q_neg_stmt",   "I do not now, nor in the future, will require sponsorship to work in the United States.", ""],
  ["q_neg_ask",    "Do you NOT require sponsorship now or in the future?", ""],
  // XA-03 — a US answer must not answer another country's question
  ["q_uk",         "Are you legally authorised to work in the UK?", ""],
  ["q_de",         "Are you legally authorized to work in Germany?", ""],
  ["q_ca",         "Do you have the right to work in Canada without sponsorship?", ""],
  ["q_au",         "Do you now, or will you in the future, require immigration sponsorship to work in Australia?", ""],
  // XA-02 — attestations are the user's own act
  ["q_certify",    "I certify that the information provided is true and complete.", ""],
  ["q_ack",        "I acknowledge that any false statement may result in dismissal.", ""],
  // Sensitive — never invented, never "decline"
  ["q_gender",     "What is your gender?", ""],
  ["q_veteran",    "Are you a protected veteran?", ""]
];

const OPTIONS: Record<string, string[]> = {
  q_certify: ["I agree"],
  q_ack: ["I acknowledge"],
  q_gender: ["Male", "Female", "Non-binary", "Decline to self identify"],
  q_veteran: ["I am a protected veteran", "I am not a protected veteran", "I don't wish to answer"]
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>AuditCo — Application</title>
<h1>Apply for Staff Engineer</h1><h2>Personal information</h2>
<form id="application-form" action="/submit" method="post">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  ${QUESTIONS.map(([id, text]) => {
    const opts = OPTIONS[id] ?? ["Yes", "No"];
    return `<label for="${id}">${text}</label><select id="${id}" name="${id}" required>` +
      `<option value="">Select…</option>${opts.map((o) => `<option>${o}</option>`).join("")}</select>`;
  }).join("\n")}
  <button type="submit" id="final-submit">Submit application</button>
</form>`;

test("STAGE3B answer integrity against the shipped build", async ({ context, worker, origin, routes }) => {
  routes.set("/answers", PAGE);
  const applicationUrl = `${origin}/answers`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  await page.waitForTimeout(45_000);

  const actual = await page.evaluate((ids: string[]) => {
    const out: Record<string, string> = {};
    for (const id of ids) out[id] = (document.getElementById(id) as HTMLSelectElement).value;
    out.__submitted = String((window as unknown as { __submitted?: boolean }).__submitted ?? false);
    return out;
  }, QUESTIONS.map(([id]) => id));

  let failures = 0;
  for (const [id, question, expected] of QUESTIONS) {
    const got = actual[id] ?? "";
    const ok = expected === "" ? got === "" : got.startsWith(expected);
    if (!ok) failures++;
    console.log(`STAGE3B ${ok ? "PASS" : "FAIL"} ${id.padEnd(12)} expected=${(expected || "(blank)").padEnd(8)} actual=${(got || "(blank)").slice(0, 40).padEnd(40)} | ${question}`);
  }
  console.log(`STAGE3B SUBMITTED=${actual.__submitted}`);
  console.log(`STAGE3B TOTAL_FAILURES=${failures}`);
  await page.close().catch(() => undefined);
});
