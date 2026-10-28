/* STAGE 3B-R1 VERIFICATION ARTIFACT — temporary. Not production code.
 * Local fixtures only. No form is submitted. */
import { test, stubApi, seedHandoff } from "./zz-audit-harness";

test.setTimeout(300_000);

// Profile truth: authorized in the US; does NOT require sponsorship.
// Posting location (from the stubbed session): "San Francisco, CA".
const CASES: [string, string, string][] = [
  // id, question, expected ("" = must remain blank)
  ["r_us",        "Are you legally authorized to work in the United States?", "Yes"],
  ["r_silent",    "Work Authorization", "Yes"],
  ["r_deferred",  "Are you legally authorized to work in the country where the job is located?", "Yes"],
  ["r_spon_aff",  "Will you now or in the future require sponsorship for employment visa status in the United States?", "No"],
  // known foreign jurisdiction
  ["r_uk",        "Are you legally authorised to work in the UK?", ""],
  ["r_de",        "Are you legally authorized to work in Germany?", ""],
  // PREVIOUSLY UNLISTED foreign jurisdiction — the Stage 3B gap
  ["r_uy",        "Are you legally authorized to work in Uruguay?", ""],
  ["r_vn",        "Are you legally authorized to work in Vietnam?", ""],
  // unknown jurisdiction: question silent AND nothing to establish it
  ["r_multi",     "Are you authorized to work in the United States or Canada?", ""],
  // negative sponsorship wording
  ["r_neg",       "I do not now, nor in the future, will require sponsorship to work in the United States.", ""],
  ["r_neg2",      "Do you NOT require sponsorship now or in the future to work in the United States?", ""],
  // semantically unclear / unrecognised wording
  ["r_lang",      "¿Está usted autorizado para trabajar en Uruguay?", ""],
  ["r_lang2",     "Benötigen Sie Visum-Sponsoring?", ""],
  ["r_trunc",     "Visa sponsorship:", ""],
  // attestation + demographics unchanged from 3B
  ["r_certify",   "I certify that the information provided is true and complete.", ""],
  ["r_gender",    "What is your gender?", ""]
];

const OPTIONS: Record<string, string[]> = {
  r_certify: ["I agree"],
  r_gender: ["Male", "Female", "Non-binary", "Decline to self identify"]
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>AuditCo — Application</title>
<h1>Apply for Staff Engineer</h1><h2>Personal information</h2>
<form id="application-form" action="/submit" method="post">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required value="TYPED-BY-USER">
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  ${CASES.map(([id, text]) => {
    const opts = OPTIONS[id] ?? ["Yes", "No"];
    return `<label for="${id}">${text}</label><select id="${id}" name="${id}" required>` +
      `<option value="">Select…</option>${opts.map((o) => `<option>${o}</option>`).join("")}</select>`;
  }).join("\n")}
  <button type="submit" id="final-submit">Submit application</button>
</form>`;

test("STAGE3B-R1 positive-evidence autofill against the shipped build", async ({ context, worker, origin, routes }) => {
  routes.set("/r1", PAGE);
  const applicationUrl = `${origin}/r1`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  await page.waitForTimeout(50_000);

  const actual = await page.evaluate((ids: string[]) => {
    const out: Record<string, string> = {};
    for (const id of ids) out[id] = (document.getElementById(id) as HTMLSelectElement).value;
    out.__pretyped = (document.getElementById("last_name") as HTMLInputElement).value;
    out.__first = (document.getElementById("first_name") as HTMLInputElement).value;
    out.__submitted = String((window as unknown as { __submitted?: boolean }).__submitted ?? false);
    return out;
  }, CASES.map(([id]) => id));

  let failures = 0;
  for (const [id, question, expected] of CASES) {
    const got = actual[id] ?? "";
    const ok = expected === "" ? got === "" : got.startsWith(expected);
    if (!ok) failures++;
    console.log(`R1 ${ok ? "PASS" : "FAIL"} ${id.padEnd(11)} expected=${(expected || "(blank)").padEnd(8)} actual=${(got || "(blank)").padEnd(10)} | ${question.slice(0, 72)}`);
  }
  console.log(`R1 PRETYPED_PRESERVED=${actual.__pretyped === "TYPED-BY-USER"} (${actual.__pretyped})`);
  console.log(`R1 ORDINARY_FIELD_FILLED=${actual.__first !== ""} (${actual.__first})`);
  console.log(`R1 SUBMITTED=${actual.__submitted}`);
  console.log(`R1 TOTAL_FAILURES=${failures}`);
  await page.close().catch(() => undefined);
});
