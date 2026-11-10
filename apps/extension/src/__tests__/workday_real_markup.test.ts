// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { selectActivationControl } from "../ats/applicationSurface";
import { classifyWorkdayStep, findWorkdaySafeNext, workdayProgress } from "../ats/workdayStep";

/**
 * Markup observed on a REAL public Workday tenant (read-only visit, 2026-11-09; nothing clicked, nobody signed in). Sanitised to
 * the structure only: element names, data-automation-id values, link kinds. No tenant text, job data or personal data.
 */
const JOB_POSTING = `<header><button data-automation-id="utilityButtonSignIn">Sign In</button></header>
  <main><a data-automation-id="adventureButton" href="/en-US/Site/job/Loc/Title_JR1/apply">Apply</a></main>`;
const START_PAGE = `<header><button data-automation-id="utilityButtonSignIn">Sign In</button></header>
  <main data-automation-id="applyAdventurePage"><h2>Start Your Application</h2>
  <a data-automation-id="autofillWithResume" href="/x/autofillWithResume">Autofill with Resume</a>
  <a data-automation-id="applyManually" href="/x/applyManually">Apply Manually</a>
  <a data-automation-id="useMyLastApplication" href="/x/useMyLastApplication">Use My Last Application</a>
  <a data-automation-id="applyWithLinkedIn" href="/x/linkedin">Apply with LinkedIn</a></main>`;

const PROGRESS = (n: number) => `<ol data-automation-id="progressBar">${[1, 2, 3, 4, 5, 6].map((i) => `<li data-automation-id="${i === n ? "progressBarActiveStep" : "progressBarInactiveStep"}"><div></div><label aria-live="polite">${i === n ? "current step " : "step "}${i} of 6</label></li>`).join("")}</ol>`;
const SIGN_IN = `${PROGRESS(1)}<main data-automation-id="applyFlowPage"><h2>Sign In</h2><div data-automation-id="signInContent">
  <button data-automation-id="GoogleSignInButton">Sign in with Google</button><button data-automation-id="LinkedInSignInButton">Sign in with LinkedIn</button>
  <button data-automation-id="SignInWithEmailButton">Sign in with email</button></div></main>`;

describe("real Workday markup: sign-in landing and an unnamed progress bar", () => {
  it("the sign-in landing page (no password field yet) is a sign-in boundary and offers no safe Next", () => {
    document.body.innerHTML = SIGN_IN;
    expect(classifyWorkdayStep(document)).toBe("sign_in");
    expect(findWorkdaySafeNext(document)).toBeNull();
  });
  it("step counts come from the employer's own unnamed progress bar, never invented", () => {
    document.body.innerHTML = SIGN_IN;
    expect(workdayProgress(document)).toMatchObject({ index: 1, total: 6 });
  });
  it("a Submit on an ordinary step named only by its heading is ambiguous, on a Review heading it is Review", () => {
    document.body.innerHTML = `${PROGRESS(3)}<h2>My Experience</h2><button data-automation-id="pageFooterSubmitButton">Submit</button>`;
    expect(classifyWorkdayStep(document)).toBe("ambiguous_submit");
    document.body.innerHTML = `${PROGRESS(6)}<h2>Review</h2><button data-automation-id="pageFooterSubmitButton">Submit</button>`;
    expect(classifyWorkdayStep(document)).toBe("review");
  });
});

describe("real Workday markup: Apply and the start-choice page are ANCHORS, not buttons", () => {
  it("the posting page is a job description", () => {
    document.body.innerHTML = JOB_POSTING;
    expect(classifyWorkdayStep(document)).toBe("job_description");
  });
  it("the start-choice page is a user boundary", () => {
    document.body.innerHTML = START_PAGE;
    expect(classifyWorkdayStep(document)).toBe("start_choice");
    expect(findWorkdaySafeNext(document)).toBeNull();
  });
  it("no start-choice link is ever picked as an automatic activation target", () => {
    document.body.innerHTML = START_PAGE;
    const picked = selectActivationControl(document);
    expect(picked?.element.getAttribute("data-automation-id") ?? null).toBeNull();
  });
});
