/* STAGE 3B-R1 VERIFICATION ARTIFACT — temporary. Not production code.
 *
 * §11: prove the client answer-integrity gate is authoritative on the
 * RESOLVE_QUESTIONS path too. The mock resolver reads the batch the extension
 * sent and answers a question the client must refuse — a German work-authorization
 * question — naming a real option the page offers. Before R1 this path wrote
 * straight to the DOM. No form is submitted. */
import { test, stubApi, seedHandoff } from "./zz-audit-harness";
import { expect } from "@playwright/test";

test.setTimeout(300_000);

const PAGE = `<!doctype html><meta charset="utf-8"><title>AuditCo</title>
<h1>Apply for Staff Engineer</h1><h2>Personal information</h2>
<form id="application-form" action="/submit" method="post">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="q_de">Are you legally authorized to work in Germany?</label>
  <select id="q_de" name="q_de" required>
    <option value="">Select…</option><option>Yes</option><option>No</option></select>
  <label for="q_neg">I do not now, nor in the future, will require sponsorship to work in the United States.</label>
  <select id="q_neg" name="q_neg" required>
    <option value="">Select…</option><option>Yes</option><option>No</option></select>
  <button type="submit" id="final-submit">Submit application</button>
</form>`;

test("STAGE3B-R1 an unsafe resolver answer cannot reach the DOM", async ({ context, worker, origin, routes }) => {
  routes.set("/resolver", PAGE);
  const applicationUrl = `${origin}/resolver`;
  await stubApi(context, applicationUrl);

  let asked = 0;
  let answered = 0;
  // Override the harness stub: answer whatever the client asked about.
  await context.route("**/application-sessions/*/resolve-questions", async (route) => {
    const body = route.request().postDataJSON() as { questions?: Array<{
      field_ref: string; question: string; options: Array<{ option_ref: string; label: string }>;
    }> };
    const questions = body?.questions ?? [];
    asked += questions.length;
    const results = questions
      .filter((q) => /Germany|do not now/i.test(q.question || ""))
      .map((q) => {
        // Name a real option this page offers — exactly what a compromised or
        // simply wrong resolver would return.
        const target = /Germany/i.test(q.question)
          ? q.options.find((o) => /^Yes/i.test(o.label))
          : q.options.find((o) => /^No/i.test(o.label));
        if (!target) return null;
        answered += 1;
        return {
          field_ref: q.field_ref,
          status: "resolved",
          canonical_key: /Germany/i.test(q.question) ? "work_authorization_us" : "sponsorship_required_future",
          answer_type: "boolean",
          selected_option_ref: target.option_ref,
          safe_source: "profile",
          confidence: 1,
          sensitivity: null,
          reason_code: "resolved",
          typed_answer: true,
          display_answer: target.label,
          source_values: [true]
        };
      })
      .filter(Boolean);
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        request_schema_version: 3, registry_version: "r1-test",
        answer_contract_version: 1, results
      })
    });
  });

  await seedHandoff(worker, applicationUrl);
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => { const t = m.text(); if (t.includes("[XpertApply]")) logs.push(t.slice(0, 150)); });
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  await page.waitForTimeout(50_000);

  const state = await page.evaluate(() => ({
    de: (document.getElementById("q_de") as HTMLSelectElement).value,
    neg: (document.getElementById("q_neg") as HTMLSelectElement).value,
    first: (document.getElementById("first_name") as HTMLInputElement).value,
    submitted: String((window as unknown as { __submitted?: boolean }).__submitted ?? false)
  }));

  console.log(`RESOLVER asked=${asked} unsafeAnswersReturned=${answered}`);
  console.log("RESOLVER DOM " + JSON.stringify(state));
  console.log("RESOLVER GATE_FIRED=" + logs.filter((l) => l.includes("refused by the client gate")).length);
  console.log("RESOLVER RELEVANT_LOGS\n" + logs.filter((l) => /resolver|question|gate|eligibility|apply\.stage/i.test(l)).join("\n"));

  // The resolver did answer, and the DOM did not take it.
  expect(state.de).toBe("");
  expect(state.neg).toBe("");
  // The gate is targeted, not a blanket refusal: ordinary fields still filled.
  expect(state.first).toBe("Aisha");
  expect(state.submitted).toBe("false");
  await page.close().catch(() => undefined);
});
