import { expect, test, chromium, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { OwnedPackageFixture } from "./owned-package-fixture";
import { overlayCdp } from "./overlay-cdp";

/**
 * XA-P1: website -> extension -> employer form, with no toolbar click.
 *
 * The web side below is the DEPLOYED site's protocol, copied from the production
 * /jobs chunk (presence = JOBPILOT_PING -> JOBPILOT_PONG, then JOBPILOT_STAGE_LAUNCH
 * and JOBPILOT_START_ASSISTED_APPLY with the same payload). Before the fix the
 * 0.3.0 extension answered none of the presence half, so the site kept showing
 * "Install extension" and never launched.
 *
 * The employer page mirrors the structure of a job-boards.greenhouse.io form
 * (labelled React-style inputs, react-select country combobox, file input, a
 * custom question). Hostname-specific Greenhouse detection is covered in unit tests;
 * this proves the cross-component flow on a granted origin.
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

/** Verbatim shape of the deployed site's presence check (production /jobs chunk). */
const deployedPresence = `new Promise(t=>{let r=!1,a=e=>{r||(r=!0,window.removeEventListener("message",s),t(e))},
 s=e=>{let t=e.data;e.source===window&&t?.source==="jobpilot-extension"&&"JOBPILOT_PONG"===t.type&&a(t.info??{installed:!0,version:"0.0.0",protocolVersion:0,capabilities:[]})};
 window.addEventListener("message",s),window.postMessage({source:"jobpilot-web",type:"JOBPILOT_PING",apiBase:"https://evil.example"},window.location.origin),window.setTimeout(()=>a(null),800)})`;

const answer = (canonical_key: string, value: string) => ({ canonical_key, value, display_value: value, source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true });

async function webServer() {
  const html = `<!doctype html><meta charset="utf-8"><title>XpertApply web fixture</title><main>web fixture</main>`;
  for (const port of [3000, 3001]) {
    const server = createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(html); });
    const ok = await new Promise<boolean>(res => { server.once("error", () => res(false)); server.listen(port, "127.0.0.1", () => res(true)); });
    if (ok) return { server, origin: `http://localhost:${port}` };
  }
  throw new Error("web fixture needs localhost:3000 or 3001");
}

test("website launch hands off to the extension, opens the employer form, auto-activates and fills; submit stays manual", async () => {
  test.setTimeout(180_000);
  const employer = await new OwnedPackageFixture(employerHtml).start();
  const web = await webServer();
  const applicationUrl = `${employer.origin}/jobs/4004`;
  const session = { session_id: 4004, ats_type: "greenhouse", official_application_url: applicationUrl, job: { title: "Software Engineer", company: "Acme" },
    resume: { status: "ready", document_id: null, download_url: null }, cover_letter: { status: "not_requested", document_id: null, download_url: null },
    profile: { first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "+16025550199" } };
  const json = (b: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  const apiLog: string[] = [];
  const tap = (h: (r: any) => unknown) => (r: any) => { apiLog.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`); return h(r); };
  await employer.route("**/application-sessions/token", tap(r => r.fulfill(json({ session_token: employer.sessionToken, session }))));
  await employer.route("**/application-sessions/4004", tap(r => r.fulfill(json(session))));
  await employer.route("**/application-sessions/4004/answers", tap(r => r.fulfill(json({ answers: [answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test"), answer("phone", "+16025550199")], unresolved_questions: [{ canonical_key: "custom_motivation", reason: "answer_on_employer_page" }], refreshed: false, profile_revision: "r" }))));
  await employer.route("**/application-sessions/4004/answers/override", tap(r => r.fulfill(json({ overrides: [] }))));
  await employer.route("**/application-sessions/4004/resolve-questions", tap(r => {
    const body = JSON.parse(r.request().postData() ?? "{}");
    const key = (t: string) => /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^email/i.test(t) ? "email" : /^phone/i.test(t) ? "phone" : null;
    const results = (body.questions ?? []).map((q: any) => {
      const k = key(String(q.question ?? ""));
      const v = ({ first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "+16025550199" } as Record<string, string>)[k ?? ""];
      return k && v ? { field_ref: q.field_ref, status: "resolved", canonical_key: k, answer_type: "text", selected_option_ref: null, safe_source: "saved_profile", confidence: 1, reason_code: "exact", typed_answer: v, display_answer: v, source_values: [v], sensitivity: null }
        : { field_ref: q.field_ref, status: "missing", canonical_key: null, answer_type: null, selected_option_ref: null, safe_source: "none", confidence: 0, reason_code: "answer_missing", typed_answer: null, display_answer: null, source_values: [] };
    });
    return r.fulfill(json({ request_schema_version: 3, answer_contract_version: 3, registry_version: "x", results }));
  }));
  for (const e of ["events", "autofill-results", "complete"]) await employer.route(`**/application-sessions/4004/${e}`, tap(r => r.fulfill(json({}))));
  const dist = process.env.XA_E2E_DIST!;
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  try {
    const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
    await worker.evaluate(async b => chrome.storage.local.set({ apiBase: b }), employer.origin);
    const site = await ctx.newPage();
    await site.goto(web.origin);

    // 1. Presence, exactly as the deployed site asks.
    const info = await site.evaluate(deployedPresence) as { installed: boolean; version: string; protocolVersion: number } | null;
    expect(info, "deployed presence check must find the installed extension").toMatchObject({ installed: true, version: "0.3.0", protocolVersion: 3 });
    expect(info!.protocolVersion).toBeGreaterThanOrEqual(3); // the site's "outdated" threshold
    // The page-chosen apiBase in that ping must not have been adopted.
    expect(await worker.evaluate(async () => (await chrome.storage.local.get("apiBase")).apiBase)).toBe(employer.origin);

    // 2. Stage, then start, with the deployed payload shape.
    const payload = { requestId: "p1-req", launchToken: "synthetic-launch", sessionId: 4004, jobId: 4004, officialUrl: applicationUrl, atsType: "greenhouse", webApiBase: employer.origin, webAuthenticatedUserId: 1 };
    await site.evaluate(p => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: p }, location.origin), payload);
    const [empPage, ack] = await Promise.all([
      ctx.waitForEvent("page", { timeout: 30_000 }),
      site.evaluate(p => new Promise<any>(resolve => {
        const on = (e: MessageEvent) => { if (e.source === window && e.data?.source === "jobpilot-extension" && e.data.type === "JOBPILOT_START_ASSISTED_APPLY_RESULT") { window.removeEventListener("message", on); resolve(e.data.result); } };
        window.addEventListener("message", on);
        window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: p }, location.origin);
      }), payload)
    ]);
    expect(ack).toMatchObject({ ok: true });
    await empPage.waitForURL(applicationUrl);

    // 3. No toolbar click anywhere: the assistant comes up by itself.
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    const ov = overlayCdp(empPage);
    // 4. Fields are detected (not stuck at 0) and the verified profile values are filled.
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 40_000 }).toBeGreaterThanOrEqual(5);
    await expect.poll(() => empPage.inputValue("#first_name"), { timeout: 40_000 }).toBe("Riley");
    expect(await empPage.inputValue("#last_name")).toBe("Candidate");
    expect(await empPage.inputValue("#email")).toBe("riley@example.test");
    expect(await empPage.inputValue("#phone")).toBe("+16025550199");
    // Nothing invented for the question the profile cannot answer.
    expect(await empPage.inputValue("#question_1")).toBe("");
    // 5. The extension never submits.
    expect(await empPage.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
    // The employer page's text never went to the API.
    expect(JSON.stringify(apiLog)).not.toContain(SENT);

    // 6. Reload: still exactly one assistant, no duplicate session.
    const tokens = apiLog.filter(l => l === "POST /application-sessions/token").length;
    await empPage.reload();
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    await empPage.waitForTimeout(2000);
    await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    expect(apiLog.filter(l => l === "POST /application-sessions/token").length).toBeLessThanOrEqual(tokens + 1);

    // 7. A hostile employer page cannot drive the bridge or learn presence.
    const before = await worker.evaluate(async () => (await chrome.storage.session.get("activeAssistedApplyHandoffV1")).activeAssistedApplyHandoffV1?.sessionId);
    const hostile = await empPage.evaluate(async (p) => {
      const out = { pong: false, started: false };
      window.addEventListener("message", e => { if (e.data?.source === "jobpilot-extension") { if (e.data.type === "JOBPILOT_PONG") out.pong = true; if (e.data.type === "JOBPILOT_START_ASSISTED_APPLY_RESULT") out.started = true; } });
      window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_PING" }, location.origin);
      window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: { ...p, sessionId: 9999, requestId: "evil" } }, location.origin);
      window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: { ...p, sessionId: 9999, requestId: "evil2" } }, location.origin);
      await new Promise(r => setTimeout(r, 1500));
      return out;
    }, payload);
    expect(hostile).toEqual({ pong: false, started: false });
    expect(await worker.evaluate(async () => (await chrome.storage.session.get("activeAssistedApplyHandoffV1")).activeAssistedApplyHandoffV1?.sessionId)).toBe(before);
    // Exactly one employer tab; the hostile messages opened nothing (the other page is Chrome's initial about:blank).
    expect(ctx.pages().filter(x => x.url().startsWith(employer.origin)).length).toBe(1);
    expect(ctx.pages().filter(x => !/^(about:blank|http:\/\/localhost:(3000|3001)\/|http:\/\/localhost:\d+\/jobs\/4004)/.test(x.url())).length).toBe(0);
  } finally {
    await ctx.close(); web.server.close(); await employer.close().catch(() => undefined);
  }
});
