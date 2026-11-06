import { expect, test } from "@playwright/test";
import { overlayCdp } from "./overlay-cdp";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";
import { LEVER_FORM } from "../src/__tests__/lever_form.fixture";

/**
 * XA-P1/P2: website -> extension -> employer form, with no toolbar click.
 *
 * The web side is the DEPLOYED site's protocol, copied from the production /jobs chunk
 * (presence = JOBPILOT_PING -> JOBPILOT_PONG, then JOBPILOT_STAGE_LAUNCH and
 * JOBPILOT_START_ASSISTED_APPLY). The employer pages mirror job-boards.greenhouse.io and
 * jobs.lever.co markup. Hostname-specific adapter behaviour is covered in unit tests; this proves
 * the cross-component flow on a granted origin.
 */
const SENT = "XASENT-PAGE-9f2c";
const employerHtml = `<!doctype html><meta charset="utf-8"><title>Software Engineer - Acme (Greenhouse-shaped)</title>
<style>main{max-width:640px;margin:20px auto;font:14px system-ui}label{display:block;margin-top:10px}</style>
<main><h1>Apply for this job</h1><p>${SENT}</p>
<form id="application-form" autocomplete="on" novalidate>
<div class="field"><label for="first_name">First Name<span aria-hidden="true">*</span></label><input id="first_name" name="first_name" type="text" aria-required="true" autocomplete="given-name"></div>
<div class="field"><label for="last_name">Last Name<span aria-hidden="true">*</span></label><input id="last_name" name="last_name" type="text" aria-required="true" autocomplete="family-name"></div>
<div class="field"><label for="email">Email<span aria-hidden="true">*</span></label><input id="email" name="email" type="email" aria-required="true" autocomplete="email"></div>
<div class="field"><label for="country">Country</label><div class="select__control"><input id="country" role="combobox" aria-expanded="false" aria-autocomplete="list" class="select__input" type="text" autocomplete="off"></div></div>
<div class="field"><label for="phone">Phone<span aria-hidden="true">*</span></label><input id="phone" name="phone" type="tel" aria-required="true" autocomplete="tel"></div>
<div class="field"><label for="resume">Resume/CV<span aria-hidden="true">*</span></label><input id="resume" name="resume" type="file"></div>
<div class="field"><label for="question_1">Why do you want to work at Acme?<span aria-hidden="true">*</span></label><textarea id="question_1" name="question_1"></textarea></div>
<button id="submit_app" type="submit">Submit application</button></form></main>
<script>
window.__emp={submits:0,clicks:0};
document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('#submit_app'))window.__emp.clicks++},true);
document.getElementById('application-form').addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++});
</script>`;


const labelKey = (t: string) => /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^full name/i.test(t) ? "full_name"
  : /^e-?mail/i.test(t) ? "email" : /^phone/i.test(t) ? "phone" : /current company/i.test(t) ? "current_company" : null;

test("Greenhouse: website launch -> single in-page assistant -> verified fields filled; submit stays manual", async () => {
  test.setTimeout(180_000);
  const h = await launchFromWebsite({
    html: employerHtml, sessionId: 4004, atsType: "greenhouse",
    profile: { first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "+16025550199" },
    answers: [answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test"), answer("phone", "+16025550199")],
    keyFor: labelKey
  });
  try {
    const info = await h.presence();
    expect(info, "deployed presence check must find the installed extension").toMatchObject({ installed: true, version: "0.3.1", protocolVersion: 3 });
    expect(await h.worker.evaluate(async () => (await chrome.storage.local.get("apiBase")).apiBase)).toBe(h.employer.origin);

    const { empPage, ack } = await h.start();
    expect(ack).toMatchObject({ ok: true });
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    const ov = overlayCdp(empPage);
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 40_000 }).toBeGreaterThanOrEqual(5);
    await expect.poll(() => empPage.inputValue("#first_name"), { timeout: 40_000 }).toBe("Riley");
    expect(await empPage.inputValue("#last_name")).toBe("Candidate");
    expect(await empPage.inputValue("#email")).toBe("riley@example.test");
    expect(await empPage.inputValue("#phone")).toBe("+16025550199");
    expect(await empPage.inputValue("#question_1")).toBe("");
    expect(await empPage.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
    expect(JSON.stringify(h.apiLog)).not.toContain(SENT);

    // Exactly one XpertApply interface: no extension window or extension page was opened, only the in-page assistant.
    expect(await h.worker.evaluate(async () => (await chrome.windows.getAll({ populate: true })).flatMap(w => (w.tabs ?? []).map(t => t.url ?? "")).filter(u => u.startsWith("chrome-extension://") && !u.includes("/access.html?welcome=1")))).toEqual([]);

    const tokens = h.apiLog.filter(l => l === "POST /application-sessions/token").length;
    await empPage.reload();
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    await empPage.waitForTimeout(2000);
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    expect(h.apiLog.filter(l => l === "POST /application-sessions/token").length).toBeLessThanOrEqual(tokens + 1);

    const before = await h.worker.evaluate(async () => (await chrome.storage.session.get("activeAssistedApplyHandoffV1")).activeAssistedApplyHandoffV1?.sessionId);
    const hostile = await empPage.evaluate(async (p) => {
      const out = { pong: false, started: false };
      window.addEventListener("message", e => { if (e.data?.source === "jobpilot-extension") { if (e.data.type === "JOBPILOT_PONG") out.pong = true; if (e.data.type === "JOBPILOT_START_ASSISTED_APPLY_RESULT") out.started = true; } });
      window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_PING" }, location.origin);
      window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: { ...p, sessionId: 9999, requestId: "evil" } }, location.origin);
      window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: { ...p, sessionId: 9999, requestId: "evil2" } }, location.origin);
      await new Promise(r => setTimeout(r, 1500));
      return out;
    }, h.payload);
    expect(hostile).toEqual({ pong: false, started: false });
    expect(await h.worker.evaluate(async () => (await chrome.storage.session.get("activeAssistedApplyHandoffV1")).activeAssistedApplyHandoffV1?.sessionId)).toBe(before);
    expect(h.ctx.pages().filter(x => x.url().startsWith(h.employer.origin)).length).toBe(1);
  } finally { await h.close(); }
});

test("Lever: website launch -> single assistant -> email, phone, name, company filled; 17 logical questions; sensitive left alone", async () => {
  test.setTimeout(180_000);
  const h = await launchFromWebsite({
    html: `<!doctype html><meta charset="utf-8"><title>Zoox - Lever-shaped</title>${LEVER_FORM}
<script>window.__emp={submits:0,clicks:0};document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('.template-btn-submit'))window.__emp.clicks++},true);
document.getElementById('application-form').addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++});</script>`,
    sessionId: 4005, atsType: "lever",
    profile: { first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "+16025550199" },
    answers: [answer("full_name", "Riley Candidate"), answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test"), answer("phone", "+16025550199"),
      answer("current_company", "Acme Robotics"), answer("gender", "Female"), answer("race", "Asian"), answer("veteran_status", "I am not a protected veteran")],
    keyFor: labelKey
  });
  try {
    expect(await h.presence()).toMatchObject({ installed: true, protocolVersion: 3 });
    const { empPage, ack } = await h.start();
    expect(ack).toMatchObject({ ok: true });
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    const ov = overlayCdp(empPage);
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 40_000 }).toBe(17);
    await expect.poll(() => empPage.inputValue('[name="email"]'), { timeout: 40_000 }).toBe("riley@example.test");
    expect(await empPage.inputValue('[name="name"]')).toBe("Riley Candidate");
    expect(await empPage.inputValue('[name="phone"]')).toBe("+16025550199");
    expect(await empPage.inputValue('[name="org"]')).toBe("Acme Robotics");
    // Voluntary self-identification is never filled from a saved value without the user's own choice.
    for (const name of ["eeo[gender]", "eeo[race]", "eeo[veteran]"]) expect(await empPage.inputValue(`[name="${name}"]`)).toBe("");
    expect(await empPage.locator('input[name="pronouns"]:checked').count()).toBe(0);
    expect(await empPage.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
    expect(await h.worker.evaluate(async () => (await chrome.windows.getAll({ populate: true })).flatMap(w => (w.tabs ?? []).map(t => t.url ?? "")).filter(u => u.startsWith("chrome-extension://") && !u.includes("/access.html?welcome=1")))).toEqual([]);
  } finally { await h.close(); }
});
