import { expect, test } from "@playwright/test";
import { overlayCdp } from "./overlay-cdp";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";
import { site } from "./employer-site";

/**
 * EXT-LIVE-05W. Real Chromium, the real e2e extension build (acme.wd5.myworkdayjobs.com pre-granted), the real worker and content
 * scripts, a real website-launch handshake. The employer is an OWNED Workday-shaped single-page fixture served under the real tenant
 * hostname. This proves the extension against our fixture, NOT against any live Workday tenant.
 */
const HOST = "acme.wd5.myworkdayjobs.com";
const BASE = "/en-US/Careers/job/Phoenix/Engineer_JR1";
const APPLY = `${BASE}/apply/applyManually`;
const URL_ = `https://${HOST}${APPLY}`;

const PAGE = (question: "none" | "source" | "legal") => `<!doctype html><meta charset="utf-8"><title>Apply - Acme Careers</title><div id="app"></div>
<script>
window.__emp={submits:0,next:0,steps:[]};
const steps=[
 {name:"My Information",req:["fn","ln","em","ph","city"],html:'<div><label for="fn">First Name *</label><input id="fn" data-automation-id="legalNameSection_firstName" required></div><div><label for="ln">Last Name *</label><input id="ln" data-automation-id="legalNameSection_lastName" required></div><div><label for="em">Email Address *</label><input id="em" type="email" data-automation-id="email" required></div><div><label for="ph">Phone Number *</label><input id="ph" type="tel" data-automation-id="phone-number" required></div><div><label for="city">City *</label><input id="city" data-automation-id="addressSection_city" required></div>'},
 {name:"My Experience",req:[],html:'<div><label for="jt0">Job Title</label><input id="jt0" data-automation-id="jobTitle"></div>'},
 ${question === "legal" ? `{name:"Application Questions",req:["auth"],html:'<div><label for="auth">Are you legally authorized to work in the country in which this job is located? *</label><input id="auth" required></div>'},` : question === "source" ? `{name:"Application Questions",req:["auth"],html:'<div><label for="auth">How did you hear about this job? *</label><input id="auth" required></div>'},` : ""}
 {name:"Review",req:[],html:'<h2>Review</h2><p>Please review.</p>'}
];
let i=0,err=0;
function render(){const s=steps[i],last=i===steps.length-1;
 document.getElementById('app').innerHTML='<div data-automation-id="progressBar"><ol>'+steps.map((x,k)=>'<li'+(k===i?' aria-current="step" data-automation-id="progressBarActiveStep"':'')+'>'+x.name+'</li>').join('')+'</ol></div><main data-automation-id="applicationPage"><h2>'+s.name+'</h2><form novalidate>'+s.html+'</form>'+(err?'<div data-automation-id="errorBanner" role="alert">Errors found</div>':'')+'<div data-automation-id="bottom-navigation-footer">'+(last?'<button type="button" data-automation-id="pageFooterSubmitButton" id="submit">Submit</button>':'<button type="button" data-automation-id="pageFooterNextButton" id="next">Save and Continue</button>')+'</div></main>';
 window.__emp.steps.push(s.name);
 document.getElementById('submit')?.addEventListener('click',()=>{window.__emp.submits++});
 document.getElementById('next')?.addEventListener('click',()=>{window.__emp.next++;const miss=s.req.filter(id=>!document.getElementById(id).value.trim());if(miss.length){err=miss.length;render();return}err=0;i++;history.pushState({},'',location.pathname+'?step='+i);render();});}
render();
</script>`;

const PROFILE = { first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "6025550199", city: "Phoenix" };
const keyFor = (t: string) => /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^e-?mail/i.test(t) ? "email" : /^phone/i.test(t) ? "phone" : /^city/i.test(t) ? "city" : null;

async function launch(s: Awaited<ReturnType<typeof site>>, id: number) {
  return launchFromWebsite({
    html: "<!doctype html><title>unused</title>", sessionId: id, atsType: "workday", officialUrl: URL_, launchArgs: s.args, profile: PROFILE,
    answers: [answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test"), answer("phone", "6025550199"), answer("city", "Phoenix")],
    keyFor, jobTitle: "Engineer", company: "Acme"
  });
}

const emp = (p: import("@playwright/test").Page) => p.evaluate(() => (window as unknown as { __emp: { submits: number; next: number; steps: string[] } }).__emp);

test("Complete application: fills My Information, advances once per step, pauses for the unanswered question, resumes after the person answers, stops at Review without submitting", async () => {
  test.setTimeout(180_000);
  const s = await site({ [APPLY]: () => ({ body: PAGE("source") }) }, [HOST]);
  const h = await launch(s, 7300);
  try {
    const { empPage } = await h.start();
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });
    const ov = overlayCdp(empPage);
    await expect.poll(() => empPage.inputValue("#city"), { timeout: 60_000 }).toBe("Phoenix");
    // Fill-this-page alone must not navigate.
    await empPage.waitForTimeout(1500);
    expect((await emp(empPage)).next).toBe(0);
    // One click.
    await expect.poll(() => ov.evaluateWidget((r) => (r.querySelector<HTMLElement>('[data-w="start"]')?.style.display ?? "none") !== "none"), { timeout: 60_000 }).toBe(true);
    await ov.evaluateWidget((r) => r.querySelector<HTMLButtonElement>('[data-w="start"]')!.click());
    await expect.poll(async () => (await emp(empPage)).steps.at(-1), { timeout: 90_000 }).toBe("Application Questions");
    // Paused on the unanswered question: nothing invented, no further Next.
    await empPage.waitForTimeout(3000);
    expect(await empPage.inputValue("#auth")).toBe("");
    const pausedNext = (await emp(empPage)).next;
    expect(pausedNext).toBe(2);
    expect(await ov.evaluateWidget((r) => r.querySelector('[data-w="status"]')?.textContent ?? "")).toMatch(/answer/i);
    // The person answers; the run continues by itself on their Resume/answer. Use Resume (explicit and always available).
    await empPage.fill("#auth", "Yes");
    await ov.evaluateWidget((r) => r.querySelector<HTMLButtonElement>('[data-w="resume"]')!.click());
    await expect.poll(async () => (await emp(empPage)).steps.at(-1), { timeout: 90_000 }).toBe("Review");
    await expect.poll(async () => (await emp(empPage)).steps.at(-1), { timeout: 5_000 }).toBe("Review");
    await empPage.waitForTimeout(3000);
    const final = await emp(empPage);
    expect(final.submits).toBe(0);
    expect(final.next).toBe(3);
    expect(await empPage.locator("#submit").count()).toBe(1);                                        // Submit left for the person
    expect(final.steps.filter((x) => x === "My Information").length).toBeLessThanOrEqual(2);        // no loops
    expect(h.ctx.pages().filter((p) => p.url().includes(HOST)).length).toBe(1);                     // no duplicate employer tabs
    expect(await empPage.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("without Complete application, filling never clicks Next", async () => {
  test.setTimeout(120_000);
  const s = await site({ [APPLY]: () => ({ body: PAGE("none") }) }, [HOST]);
  const h = await launch(s, 7301);
  try {
    const { empPage } = await h.start();
    await expect.poll(() => empPage.inputValue("#fn"), { timeout: 60_000 }).toBe("Riley");
    await empPage.waitForTimeout(4000);
    const state = await emp(empPage);
    expect(state.next).toBe(0);
    expect(state.submits).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});

test("a legal/eligibility answer typed straight into the employer form is NOT accepted as verified: the run stays paused for XpertApply review", async () => {
  test.setTimeout(150_000);
  const s = await site({ [APPLY]: () => ({ body: PAGE("legal") }) }, [HOST]);
  const h = await launch(s, 7302);
  try {
    const { empPage } = await h.start();
    const ov = overlayCdp(empPage);
    await expect.poll(() => empPage.inputValue("#city"), { timeout: 60_000 }).toBe("Phoenix");
    await expect.poll(() => ov.evaluateWidget((r) => (r.querySelector<HTMLElement>('[data-w="start"]')?.style.display ?? "none") !== "none"), { timeout: 60_000 }).toBe(true);
    await ov.evaluateWidget((r) => r.querySelector<HTMLButtonElement>('[data-w="start"]')!.click());
    await expect.poll(async () => (await emp(empPage)).steps.at(-1), { timeout: 90_000 }).toBe("Application Questions");
    expect(await empPage.inputValue("#auth")).toBe("");
    await empPage.fill("#auth", "Yes");
    await ov.evaluateWidget((r) => r.querySelector<HTMLButtonElement>('[data-w="resume"]')!.click());
    await empPage.waitForTimeout(12_000);
    const state = await emp(empPage);
    expect(state.steps.at(-1)).toBe("Application Questions");
    expect(state.next).toBe(2);
    expect(state.submits).toBe(0);
  } finally { await h.close().catch(() => undefined); s.close(); }
});
