/**
 * XA-P2 · Lever (jobs.lever.co) regression suite.
 *
 * Real observation: 17 fields discovered, 2 filled, 15 "review"; email, phone, location and
 * company blank although the profile held them; sponsorship, pronouns and EEO unanswered.
 * The fixture reproduces Lever's markup (see lever_form.fixture.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { detectAdapter } from "../ats/registry";
import { runAutofill } from "../content/autofill";
import { discoverAll } from "../fields/discovery";
import { classifyField } from "../fields/mapping";
import { pickApplicationForm } from "../ats/base";
import type { ApplicationSessionData, SessionAnswer } from "../types";
import { LEVER_FORM, LEVER_URL } from "./lever_form.fixture";

const a = (k: string, v: string, extra: Partial<SessionAnswer> = {}): SessionAnswer => ({
  canonical_key: k, value: v, display_value: v, source: "profile", confidence: 0.97, sensitive: false,
  requires_review: false, verified: true, ...extra
});
const BASICS = (): SessionAnswer[] => [
  a("full_name", "Riley Candidate"), a("first_name", "Riley"), a("last_name", "Candidate"),
  a("email", "riley@example.test"), a("phone", "+16025550199"), a("city", "Phoenix"),
  a("current_company", "Acme Robotics"), a("linkedin_url", "https://www.linkedin.com/in/riley"),
  a("github_url", "https://github.com/riley")
];
const session = (answers: SessionAnswer[]): ApplicationSessionData => ({
  sessionId: 1, atsType: "lever", officialUrl: LEVER_URL, jobTitle: "ML Training Optimization", company: "Zoox",
  jobLocation: "Foster City, CA", unresolvedQuestions: [], answers
});
const file = () => new File(["%PDF-1.4"], "resume.pdf", { type: "application/pdf" });
async function run(answers: SessionAnswer[], prepare?: () => void) {
  document.body.innerHTML = LEVER_FORM;
  prepare?.();
  const outcome = detectAdapter({ url: LEVER_URL, document })!;
  const out = await runAutofill(session(answers), outcome, { fetchDocument: async () => file() }, 0);
  return out;
}
const input = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
const checkedRadio = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;
const entry = (ledger: { label: string }[], text: string) => ledger.find((e) => e.label.toLowerCase().includes(text.toLowerCase()))! as any;

afterEach(() => { document.body.innerHTML = ""; });

describe("Lever: logical questions", () => {
  it("counts a checkbox set as one question and labels radio groups with the question, not 'Yes'", () => {
    document.body.innerHTML = LEVER_FORM;
    const { fields } = discoverAll(pickApplicationForm(document));
    // 20 DOM controls, 4 of them one pronouns question => 17 logical questions (the number the user saw).
    expect(fields.length).toBe(17);
    const pronouns = fields.filter((f) => /pronouns/i.test(f.label));
    expect(pronouns).toHaveLength(1);
    expect(pronouns[0].options).toEqual(["She/her", "He/him", "They/them", "Prefer not to say"]);
    const radios = fields.filter((f) => f.control === "radio");
    expect(radios.map((f) => f.label.replace(/✱/g, "").trim())).toEqual([
      "Will you now or in the future require sponsorship for employment visa status?",
      "Are you legally authorized to work in the United States?"
    ]);
  });
});

describe("Lever: basic profile fields", () => {
  it("fills and VERIFIES name, email, phone, company and links; location is typed but flagged", async () => {
    const { ledger, counts } = await run(BASICS());
    expect(input("name").value).toBe("Riley Candidate");
    expect(input("email").value).toBe("riley@example.test");
    expect(input("phone").value).toBe("+16025550199");
    expect(input("org").value).toBe("Acme Robotics");
    expect(input("urls[LinkedIn]").value).toBe("https://www.linkedin.com/in/riley");
    for (const label of ["Full name", "Email", "Phone", "Current company", "LinkedIn", "GitHub"]) {
      expect(entry(ledger, label).status, label).toBe("filled_verified");
    }
    // The location typeahead needs the user to pick a suggestion: filled, but never "verified".
    expect(input("location").value).toBe("Phoenix");
    expect(entry(ledger, "Current location").status).toBe("filled_needs_review");
    expect(counts.filled).toBeGreaterThanOrEqual(7);
  });

  it("does not invent an email or phone the profile lacks; the required blanks stay counted", async () => {
    const { ledger, counts } = await run(BASICS().filter((x) => x.canonical_key !== "email" && x.canonical_key !== "phone"));
    expect(input("email").value).toBe("");
    expect(input("phone").value).toBe("");
    expect(entry(ledger, "Email").status).toBe("missing_information");
    expect(entry(ledger, "Phone").status).toBe("missing_information");
    expect(counts.requiredBlank).toBeGreaterThanOrEqual(2);
  });

  it("never overwrites what the user typed, and a second Fill changes nothing", async () => {
    let events = 0;
    const first = await run(BASICS(), () => {
      const email = input("email");
      email.value = "typed-by-user@example.test";
      document.addEventListener("input", () => { events += 1; }, true);
    });
    expect(input("email").value).toBe("typed-by-user@example.test");
    const snapshot = () => JSON.stringify(Array.from(document.querySelectorAll<HTMLInputElement>("input,textarea,select")).map((e) => [e.name, e.value, e.checked]));
    const before = snapshot();
    const eventsAfterFirst = events;
    const outcome = detectAdapter({ url: LEVER_URL, document })!;
    const second = await runAutofill(session(BASICS()), outcome, { fetchDocument: async () => file() }, 0);
    expect(snapshot()).toBe(before);
    expect(events).toBe(eventsAfterFirst);
    expect(second.counts.filled).toBe(first.counts.filled);
  });

  it("leaves 'How did you hear about this job?' empty rather than typing a placeholder token", async () => {
    await run(BASICS());
    expect(input("cards[ddd][field0]").value).toBe("");
    expect(document.body.innerHTML).not.toContain("__jobpilot");
  });
});

describe("Lever: sponsorship and work authorization", () => {
  const now = (v: string) => a("sponsorship_required_now", v);
  const future = (v: string) => a("sponsorship_required_future", v);
  const auth = (v: string) => a("work_authorization_us", v);
  const combined = "cards[bbb][field0]";
  const authName = "cards[ccc][field0]";

  it("answers the combined 'now or in the future' question only when BOTH halves are verified", async () => {
    await run([...BASICS(), now("No"), future("No")]);
    expect(checkedRadio(combined)).toBe("No");
  });

  it("answers Yes when either half is Yes", async () => {
    await run([...BASICS(), now("No"), future("Yes")]);
    expect(checkedRadio(combined)).toBe("Yes");
  });

  it("does NOT answer it from one half, from work authorization, or from an unverified half", async () => {
    for (const answers of [[now("No")], [future("No")], [auth("Yes")], [now("No"), future("No", )].map((x) => ({ ...x, verified: x.canonical_key === "sponsorship_required_now" ? true : false }))]) {
      await run([...BASICS(), ...answers]);
      expect(checkedRadio(combined)).toBeNull();
      document.body.innerHTML = "";
    }
  });

  it("keeps work authorization separate from sponsorship", async () => {
    await run([...BASICS(), auth("Yes")]);
    expect(checkedRadio(authName)).toBe("Yes");
    expect(checkedRadio(combined)).toBeNull();
  });

  it("tells now, future, combined, citizenship and export-control wording apart", () => {
    const key = (question: string) => {
      document.body.innerHTML = `<form><label>${question}<input type="text" name="q"></label></form>`;
      return classifyField(discoverAll(document).fields[0]).canonicalKey;
    };
    expect(key("Will you require employer sponsorship now?")).toBe("sponsorship_required_now");
    expect(key("Will you require employer sponsorship at any point in the future?")).toBe("sponsorship_required_future");
    expect(key("Will you now or in the future require sponsorship for employment visa status?")).toBe("sponsorship_required_now_or_future");
    expect(key("Are you currently legally authorized to work in the United States?")).toBe("work_authorization_us");
    for (const unknown of [
      "Are you a U.S. citizen?",
      "Are you a U.S. permanent resident?",
      "What citizenship or residency status do you hold for export-control purposes?"
    ]) expect(key(unknown), unknown).toBe("unknown");
  });
});

describe("Lever: voluntary and sensitive questions", () => {
  it("does not fill gender, race or veteran status from answers that lack the user's opt-in marking", async () => {
    const { ledger } = await run([...BASICS(), a("gender", "Female"), a("race", "Asian"), a("veteran_status", "I am not a protected veteran")]);
    for (const select of ["eeo[gender]", "eeo[race]", "eeo[veteran]"]) expect(input(select).value, select).toBe("");
    for (const label of ["Gender", "Race", "Veteran"]) expect(entry(ledger, label).status).toBe("needs_confirmation");
  });

  // What the backend emits for a user who opted in to storing self-identification (source "profile_eeo").
  const consented = (key: string, value: string) => a(key, value, { source: "profile_eeo", sensitive: true, confidence: 1 });

  it("fills a self-identification answer ONLY when the user opted in AND the employer offers that exact option", async () => {
    const { ledger } = await run([...BASICS(), consented("gender", "Female"), consented("veteran_status", "I am not a protected veteran")]);
    expect(input("eeo[gender]").value).toBe("Female");
    expect(input("eeo[veteran]").value).toBe("I am not a protected veteran");
    expect(entry(ledger, "Gender").status).toBe("filled_verified");
    // Never saved, never asked, never filled: left for the user.
    expect(input("eeo[race]").value).toBe("");
  });

  it("leaves a consented answer for review when the employer has no matching option", async () => {
    const { ledger } = await run([...BASICS(), consented("race", "Two or More Races"), consented("gender", "Non-binary")]);
    expect(input("eeo[race]").value).toBe("");
    expect(input("eeo[gender]").value).toBe("");
    expect(entry(ledger, "Race").status).toBe("needs_confirmation");
    expect(entry(ledger, "Gender").status).toBe("needs_confirmation");
  });

  it("chooses 'Decline to self-identify' only when that is the user's own stored answer", async () => {
    await run([...BASICS(), consented("race", "Decline to self-identify")]);
    expect(input("eeo[race]").value).toBe("Decline to self-identify");
    document.body.innerHTML = "";
    await run([...BASICS()]);
    expect(input("eeo[race]").value).toBe("");
  });

  it("a revoked opt-in (the backend stops emitting the answer) leaves the question for the user", async () => {
    await run([...BASICS(), consented("gender", "Female")]);
    expect(input("eeo[gender]").value).toBe("Female");
    document.body.innerHTML = "";
    await run([...BASICS()]);
    expect(input("eeo[gender]").value).toBe("");
  });

  it("never picks 'Decline to self-identify' for a category that is merely unset", async () => {
    await run(BASICS());
    for (const select of ["eeo[gender]", "eeo[race]", "eeo[veteran]"]) expect(input(select).value).toBe("");
  });

  it("does not infer pronouns from gender, and ticks only an exact saved option", async () => {
    await run([...BASICS(), a("gender", "Female")]);
    expect(document.querySelectorAll('input[name="pronouns"]:checked')).toHaveLength(0);
    document.body.innerHTML = "";
    await run([...BASICS(), a("pronouns", "They/them")]);
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[name="pronouns"]:checked')).map((c) => c.value)).toEqual(["They/them"]);
    document.body.innerHTML = "";
    const { ledger } = await run([...BASICS(), a("pronouns", "Zir/zir")]);
    expect(document.querySelectorAll('input[name="pronouns"]:checked')).toHaveLength(0);
    expect(entry(ledger, "Pronouns").status).not.toBe("filled_verified");
  });
});

describe("Lever: no submission", () => {
  it("never clicks or submits the application", async () => {
    document.body.innerHTML = LEVER_FORM;
    let submits = 0; let clicks = 0;
    document.getElementById("application-form")!.addEventListener("submit", (e) => { e.preventDefault(); submits += 1; });
    document.addEventListener("click", (e) => { if ((e.target as Element).closest(".template-btn-submit")) clicks += 1; }, true);
    const outcome = detectAdapter({ url: LEVER_URL, document })!;
    await runAutofill(session(BASICS()), outcome, { fetchDocument: async () => file() }, 0);
    expect({ submits, clicks }).toEqual({ submits: 0, clicks: 0 });
  });
});
