/**
 * XA-P1 Greenhouse regression: the form shape the user reported (name, email,
 * phone, country combobox, resume upload, a custom question) on the real
 * job-boards.greenhouse.io host. The assistant showed "ATS: Detecting…" and zero
 * fields there because it was never connected to a launch; this pins what the
 * engine itself must do once it is: recognise Greenhouse, find the controls,
 * fill only verified profile values, invent nothing, and never submit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { detectAdapter } from "../ats/registry";
import { runAutofill } from "../content/autofill";
import { discoverAll } from "../fields/discovery";
import { pickApplicationForm } from "../ats/base";
import type { ApplicationSessionData, SessionAnswer } from "../types";

const URL_ = "https://job-boards.greenhouse.io/acme/jobs/4004";
const FORM = `<main><h1>Apply for this job</h1>
<form id="application-form" novalidate>
<div class="field"><label for="first_name">First Name<span aria-hidden="true">*</span></label><input id="first_name" name="first_name" type="text" aria-required="true"></div>
<div class="field"><label for="last_name">Last Name<span aria-hidden="true">*</span></label><input id="last_name" name="last_name" type="text" aria-required="true"></div>
<div class="field"><label for="email">Email<span aria-hidden="true">*</span></label><input id="email" name="email" type="email" aria-required="true"></div>
<div class="field"><label for="phone">Phone<span aria-hidden="true">*</span></label><input id="phone" name="phone" type="tel" aria-required="true"></div>
<div class="field"><label for="resume">Resume/CV<span aria-hidden="true">*</span></label><input id="resume" name="resume" type="file"></div>
<div class="field"><label for="question_1">Why do you want to work at Acme?<span aria-hidden="true">*</span></label><textarea id="question_1" name="question_1"></textarea></div>
<button id="submit_app" type="submit">Submit application</button></form></main>`;

const answer = (canonical_key: string, value: string): SessionAnswer => ({
  canonical_key, value, display_value: value, source: "profile", confidence: 0.97, sensitive: false, requires_review: false, verified: true
});
const session = (): ApplicationSessionData => ({
  sessionId: 4004, atsType: "greenhouse", officialUrl: URL_, jobTitle: "Software Engineer", company: "Acme",
  unresolvedQuestions: [{ canonical_key: "custom_motivation", reason: "answer_on_employer_page" }],
  answers: [answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test"), answer("phone", "+16025550199")]
});

afterEach(() => { document.body.innerHTML = ""; });

describe("Greenhouse launch regression", () => {
  it("recognises the host and finds the controls instead of stopping at zero", () => {
    document.body.innerHTML = FORM;
    const outcome = detectAdapter({ url: URL_, document });
    expect(outcome?.adapter.id).toBe("greenhouse");
    expect(outcome?.limited).toBe(false);
    const { fields } = discoverAll(pickApplicationForm(document));
    const labels = fields.map((f) => f.label.replace(/\*/g, "").trim());
    expect(fields.length).toBeGreaterThanOrEqual(6);
    for (const expected of ["First Name", "Last Name", "Email", "Phone", "Why do you want to work at Acme?"]) {
      expect(labels).toContain(expected);
    }
  });

  it("fills only verified profile values, leaves the rest for review, and never submits", async () => {
    document.body.innerHTML = FORM;
    let submits = 0;
    let clicks = 0;
    document.getElementById("application-form")!.addEventListener("submit", (e) => { e.preventDefault(); submits++; });
    document.addEventListener("click", (e) => { if ((e.target as Element).closest("#submit_app")) clicks++; }, true);
    const outcome = detectAdapter({ url: URL_, document })!;
    const { ledger, counts } = await runAutofill(session(), outcome, { fetchDocument: async () => new File(["x"], "resume.pdf", { type: "application/pdf" }) }, 0);

    expect((document.getElementById("first_name") as HTMLInputElement).value).toBe("Riley");
    expect((document.getElementById("last_name") as HTMLInputElement).value).toBe("Candidate");
    expect((document.getElementById("email") as HTMLInputElement).value).toBe("riley@example.test");
    expect((document.getElementById("phone") as HTMLInputElement).value).toBe("+16025550199");
    // Nothing is invented for a question the profile cannot answer.
    expect((document.getElementById("question_1") as HTMLTextAreaElement).value).toBe("");
    const motivation = ledger.find((e) => /why do you want/i.test(e.label))!;
    expect(motivation.verified).toBe(false);
    expect(counts.discovered).toBe(ledger.length);
    expect(counts.filled).toBeGreaterThanOrEqual(4);
    expect({ submits, clicks }).toEqual({ submits: 0, clicks: 0 });
  });
});
