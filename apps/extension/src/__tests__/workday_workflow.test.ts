import { beforeEach, describe, expect, it } from "vitest";

import { classifyWorkdayStep, findWorkdaySafeNext, workdayValidationErrors, USER_BOUNDARY_KINDS } from "../ats/workdayStep";
import { runFill } from "../fields/runner";
import * as wf from "../application/workflowEngine";
import type { ApplicationSessionData } from "../types";
import { CONFIGS, mount, type FixtureConfig } from "./helpers/workdayFixture";

const ans = (canonical_key: string, value: string) => ({ canonical_key, value, display_value: value, source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true });
const DATA = { fn: "Riley", ln: "Candidate", em: "riley@example.test", ph: "6025550199", city: "Phoenix" };

function session(): ApplicationSessionData {
  return {
    sessionId: 7, authenticatedUserId: 11, atsType: "workday", officialUrl: "https://acme.wd5.myworkdayjobs.com/en-US/x/job/1/apply", jobTitle: "Engineer", company: "Acme",
    answers: [ans("first_name", DATA.fn), ans("last_name", DATA.ln), ans("email", DATA.em), ans("phone", DATA.ph), ans("phone_national", DATA.ph), ans("city", DATA.city)],
    unresolvedQuestions: []
  };
}

const ident = (now = 1000, account = "11") => ({ now, origin: "https://acme.wd5.myworkdayjobs.com", applicationKey: "7", accountKey: account, tabKey: "5", jobKey: "workday:job-1" });
const requiredEmpty = (): number => Array.from(document.querySelectorAll<HTMLInputElement>("input[required]")).filter((i) => (i.type === "checkbox" ? !i.checked : i.value.trim() === "")).length;
const signature = (): string => `${document.querySelector("h2")?.textContent}|${document.querySelectorAll("input").length}`;

/** Drives the real fill + the real engine over a fixture. The unresolved count is read from the live DOM, not from fill claims. */
async function run(config: FixtureConfig, opts: { userHelp?: () => void; maxTurns?: number } = {}) {
  const sim = mount(config);
  let r = wf.startRun("application", ident(), "run-test");
  const trace: string[] = [];
  let t = 1000;
  for (let turn = 0; turn < (opts.maxTurns ?? 30); turn++) {
    t += 100;
    const kind = classifyWorkdayStep(document);
    const form = document.querySelector("form") ?? document;
    if (kind !== "review") await runFill(form, session());
    const d = wf.decide(r, {
      ...ident(t), signature: signature(), stepKind: kind, isReview: kind === "review",
      boundary: USER_BOUNDARY_KINDS.has(kind) ? kind : null, unresolved: requiredEmpty(), technicalIssues: 0, consentActions: 0,
      validationErrors: workdayValidationErrors(document), hasSafeNext: Boolean(findWorkdaySafeNext(document)), fillVerified: true
    });
    r = d.run;
    trace.push(`${kind}:${d.action.kind}${d.action.kind === "wait" ? `(${d.action.reason})` : ""}`);
    if (d.action.kind === "advance") findWorkdaySafeNext(document)!.click();
    else if (d.action.kind === "wait" && opts.userHelp) { opts.userHelp(); r = wf.resume(r); r = { ...r, state: "DETECTING", reason: null }; opts.userHelp = undefined; }
    else if (d.action.kind !== "none") break;
  }
  return { sim, run: r, trace };
}

describe("Workday fixtures: step recognition", () => {
  beforeEach(() => { document.body.innerHTML = ""; });
  it("classifies every step of every configuration, never guessing", () => {
    const seen: Record<string, string[]> = {};
    for (const config of CONFIGS) {
      const sim = mount(config);
      seen[config.id] = [];
      for (let i = 0; i < config.steps.length; i++) {
        seen[config.id]!.push(classifyWorkdayStep(document));
        if (i < config.steps.length - 1) {
          document.querySelectorAll("input[required]").forEach((e) => { const el = e as HTMLInputElement; if (el.type === "checkbox") el.checked = true; else el.value = "x"; });
          (document.querySelector('[data-automation-id="pageFooterNextButton"]') as HTMLElement).click();
          expect(sim.errors()).toBe(0);
        }
      }
    }
    expect(seen["A-classic-4step"]).toEqual(["my_information", "my_experience", "application_questions", "review"]);
    expect(seen["B-with-disclosures"]).toEqual(["my_information", "my_experience", "application_questions", "voluntary_disclosures", "review"]);
    expect(seen["F-single-step-plus-review"]).toEqual(["my_information", "review"]);
  });

  it("treats sign-in, account creation, verification and CAPTCHA as user boundaries with no Next control", () => {
    const pages: [string, string][] = [
      ["sign_in", '<h2>Sign In</h2><input type="email"><input type="password"><button data-automation-id="signInSubmitButton">Sign In</button><button>Continue</button>'],
      ["create_account", '<h2>Create Account</h2><input type="email"><input type="password"><input type="password"><button data-automation-id="createAccountSubmitButton">Create Account</button>'],
      ["verification", '<h2>Verify your email</h2><input autocomplete="one-time-code"><button>Continue</button>'],
      ["verification", '<h2>My Information</h2><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe><button>Next</button>'],
      ["start_choice", "<button>Autofill with Resume</button><button>Apply Manually</button>"]
    ];
    for (const [kind, html] of pages) {
      document.body.innerHTML = html;
      expect(classifyWorkdayStep(document)).toBe(kind);
      expect(findWorkdaySafeNext(document)).toBeNull();
      expect(USER_BOUNDARY_KINDS.has(kind as never)).toBe(true);
    }
  });
});

describe("Workday fixtures: continuous workflow (local fixtures, not live employers)", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("A/D/E/F: reaches the review boundary with correct values and never submits", async () => {
    for (const id of ["A-classic-4step", "E-many-jobs", "F-single-step-plus-review"]) {
      const config = CONFIGS.find((c) => c.id === id)!;
      // A has a required work-authorization question nobody has answered: it must pause, not invent.
      const needsAnswer = config.steps.some((s) => s.required.includes("auth"));
      const result = await run(config, needsAnswer ? {} : {});
      if (needsAnswer) {
        expect(result.run.state).toBe("WAITING_FOR_USER");
        expect(result.run.reason).toBe("1_needs_answer");
        expect((document.getElementById("auth") as HTMLInputElement).value).toBe("");
      } else {
        expect(result.run.state).toBe("REVIEW_READY");
        expect(document.querySelector('[data-automation-id="pageFooterSubmitButton"]')).not.toBeNull();
      }
      expect(result.sim.clicks.submit).toBe(0);
    }
  });

  it("J/K: a missing answer pauses; once the person answers, the run continues to review", async () => {
    const config = CONFIGS.find((c) => c.id === "A-classic-4step")!;
    const result = await run(config, { userHelp: () => { (document.getElementById("auth") as HTMLInputElement).value = "Yes"; } });
    expect(result.trace.some((t) => t.includes("wait(1_needs_answer)"))).toBe(true);
    expect(result.run.state).toBe("REVIEW_READY");
    expect(result.sim.clicks.submit).toBe(0);
    expect((document.querySelector("h2") as HTMLElement).textContent).toBe("Review");
  });

  it("B: voluntary disclosures stop the run for the person and are never ticked", async () => {
    const config = CONFIGS.find((c) => c.id === "B-with-disclosures")!;
    const result = await run(config, { userHelp: () => { (document.getElementById("auth") as HTMLInputElement).value = "Yes"; } });
    // After the authorization answer the run reaches disclosures and waits there.
    expect(result.run.state).toBe("WAITING_FOR_USER");
    expect(result.run.reason).toBe("voluntary_disclosures");
    expect((document.getElementById("ack") as HTMLInputElement).checked).toBe(false);
    expect(result.sim.clicks.submit).toBe(0);
  });

  it("C: fields with no visible label are filled from Workday automation ids, with verified values", async () => {
    const config = CONFIGS.find((c) => c.id === "C-automation-id-only")!;
    mount(config);
    await runFill(document.querySelector("form")!, session());
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    expect([value("fn"), value("ln"), value("em"), value("city")]).toEqual([DATA.fn, DATA.ln, DATA.em, DATA.city]);
  });

  it("O: a value the person typed is never overwritten", async () => {
    mount(CONFIGS[0]!);
    (document.getElementById("city") as HTMLInputElement).value = "Tempe";
    await runFill(document.querySelector("form")!, session());
    expect((document.getElementById("city") as HTMLInputElement).value).toBe("Tempe");
  });

  it("validation errors after Next pause the run instead of looping", async () => {
    mount(CONFIGS[5]!);
    let r = wf.startRun("application", ident(), "run-v");
    const obs = (t: number, errors: number, sig: string) => ({ ...ident(t), signature: sig, stepKind: "my_information", isReview: false, boundary: null, unresolved: 0, technicalIssues: 0, consentActions: 0, validationErrors: errors, hasSafeNext: true, fillVerified: true });
    let d = wf.decide(r, obs(1100, 0, "s1")); expect(d.action.kind).toBe("advance"); r = d.run;
    d = wf.decide(r, obs(1200, 1, "s1")); expect(d.action.kind).toBe("none"); r = d.run;       // same page still: wait, no second click
    d = wf.decide(r, obs(1200 + wf.LIMITS.maxAdvanceWaitMs + 1, 1, "s1"));
    expect(d.action).toEqual({ kind: "wait", reason: "validation_errors_after_next" });
  });
});

describe("workflow engine safety", () => {
  const obs = (over: Partial<wf.Observation> = {}): wf.Observation => ({ ...ident(2000), signature: "s", stepKind: "my_information", isReview: false, boundary: null, unresolved: 0, technicalIssues: 0, consentActions: 0, validationErrors: 0, hasSafeNext: true, fillVerified: true, ...over });

  it("never advances twice from the same step signature (no duplicate Next, no loops)", () => {
    let r = wf.startRun("application", ident(), "r1");
    const first = wf.decide(r, obs()); expect(first.action.kind).toBe("advance"); r = first.run;
    // The page changed and then returned to the same signature: that is a loop and ends the run.
    r = wf.decide(r, obs({ signature: "t", hasSafeNext: false })).run;
    const again = wf.decide({ ...r, state: "DETECTING" }, obs({ signature: "s" }));
    expect(again.action).toEqual({ kind: "fail", reason: "navigation_loop" });
  });

  it("a page-mode run never advances", () => {
    const r = wf.startRun("page", ident(), "r2");
    expect(wf.decide(r, obs()).action.kind).not.toBe("advance");
  });

  it("review is terminal and offers no further action", () => {
    const r = wf.startRun("application", ident(), "r3");
    const d = wf.decide(r, obs({ isReview: true, stepKind: "review" }));
    expect(d.action.kind).toBe("review_ready");
    expect(wf.decide(d.run, obs()).action.kind).toBe("none");
  });

  it("unresolved answers, consent, technical issues and errors each pause with a reason", () => {
    const r = wf.startRun("application", ident(), "r4");
    expect(wf.decide(r, obs({ unresolved: 2 })).action).toEqual({ kind: "wait", reason: "2_needs_answer" });
    expect(wf.decide(r, obs({ consentActions: 1 })).action).toEqual({ kind: "wait", reason: "consent_needs_you" });
    expect(wf.decide(r, obs({ technicalIssues: 1 })).action).toEqual({ kind: "wait", reason: "technical_issue" });
    expect(wf.decide(r, obs({ validationErrors: 1 })).action).toEqual({ kind: "wait", reason: "validation_errors" });
    expect(wf.decide(r, obs({ hasSafeNext: false })).action).toEqual({ kind: "wait", reason: "no_safe_next_control" });
    expect(wf.decide(r, obs({ boundary: "sign_in" })).action).toEqual({ kind: "wait", reason: "sign_in" });
  });

  it("is bounded by steps, advances and time; pause and cancel are honoured", () => {
    let r = wf.startRun("application", ident(), "r5");
    expect(wf.decide(r, obs({ now: 1000 + wf.LIMITS.maxMs + 1 })).action).toEqual({ kind: "fail", reason: "run_timed_out" });
    r = { ...r, stepsSeen: wf.LIMITS.maxSteps };
    expect(wf.decide(r, obs({ signature: "new" })).action).toEqual({ kind: "fail", reason: "too_many_steps" });
    const p = wf.pause(wf.startRun("application", ident(), "r6"), 1500);
    expect(wf.decide(p, obs()).action).toEqual({ kind: "wait", reason: "paused_by_user" });
    expect(wf.decide(wf.cancel(wf.startRun("application", ident(), "r7")), obs()).action.kind).toBe("none");
  });

  it("P: a run never survives a change of origin, application or account", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    wf.saveRun(s, wf.startRun("application", ident(), "r8"));
    expect(wf.loadRun(s, ident(1500, "99"))).toBeNull();            // different account
    wf.saveRun(s, wf.startRun("application", ident(), "r8"));
    expect(wf.loadRun(s, { ...ident(1500), applicationKey: "8" })).toBeNull();
    wf.saveRun(s, wf.startRun("application", ident(), "r8"));
    expect(wf.loadRun(s, { ...ident(1500), origin: "https://other.myworkdayjobs.com" })).toBeNull();
    wf.saveRun(s, wf.startRun("application", ident(), "r8"));
    expect(wf.loadRun(s, ident(1500))?.runId).toBe("r8");           // M: same tab, same identity resumes after reload
  });

  it("S: persisted state holds no field values or personal data", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    wf.saveRun(s, wf.startRun("application", ident(), "r9"));
    const raw = [...store.values()].join("");
    for (const secret of Object.values(DATA)) expect(raw).not.toContain(secret);
  });
});

describe("EXT-LIVE-08 a run belongs to one tab", () => {
  it("a run restored in a different tab (Duplicate Tab copies sessionStorage) is discarded and an unknown tab never validates", () => {
    const run = wf.startRun("application", ident());
    expect(wf.isRunValidFor(run, ident())).toBe(true);
    expect(wf.isRunValidFor(run, { ...ident(), tabKey: "6" })).toBe(false);
    expect(wf.isRunValidFor(run, { ...ident(), tabKey: "" })).toBe(false);
    expect(wf.isRunValidFor(run, { ...ident(), jobKey: "workday:job-2" })).toBe(false);   // the tab moved to another posting
  });
});
