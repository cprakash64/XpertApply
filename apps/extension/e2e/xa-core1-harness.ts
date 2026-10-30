import { chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { createServer as createHttps, type Server as HttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LEVER_FORM } from "../src/__tests__/lever_form.fixture";
import { answer } from "./cws-p1-launch-harness";

/**
 * XA-CORE1 harness: an independent application opened directly on an employer origin.
 *
 * Employer hostnames (including a custom careers domain) are served from loopback through the repo's
 * allowed host-resolver MAP rule and a local TLS server; they are granted in the e2e build exactly as
 * Chrome records a user's grant. The XpertApply backend is an owned loopback mock that enforces the
 * contract the real one does: an EXTENSION access token opens a direct draft and returns a token scoped
 * to that one session; a session token reaches only its own session; nothing accepts a page-supplied id.
 *
 * What cannot be automated is Chrome's own consent window (permission prompt, launchWebAuthFlow). The
 * sign-in state is seeded in the same storage key the worker writes after a successful connect, so
 * everything the extension does with a credential, and everything after it, is real.
 */
export const HOSTS = ["careers.withwaymo.com", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "acme.wd5.myworkdayjobs.com"];
export const UNGRANTED_HOST = "careers.ungranted.test";
export const LEVER_UUID = "11111111-2222-3333-4444-555555555555";

export const PROFILES: Record<number, Record<string, string>> = {
  7: { first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "+16025550199", linkedin_url: "https://www.linkedin.com/in/riley-candidate", portfolio_url: "https://riley.example.test", full_name: "Riley Candidate", current_company: "Acme Robotics" },
  9: { first_name: "Jordan", last_name: "Other", email: "jordan@example.test", phone: "+14805550123", linkedin_url: "https://www.linkedin.com/in/jordan-other", portfolio_url: "https://jordan.example.test", full_name: "Jordan Other", current_company: "Other Co" }
};

const track = `<script>window.__emp={submits:0,clicks:0};
document.addEventListener('click',e=>{const t=e.target&&e.target.closest&&e.target.closest('button[type=submit],.template-btn-submit');if(t)window.__emp.clicks++},true);
document.addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++},true);</script>`;

const simpleForm = (title: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><main><h1>${title}</h1><form id="application-form">
<label for="first_name">First Name</label><input id="first_name" name="first_name">
<label for="last_name">Last Name</label><input id="last_name" name="last_name">
<label for="email">Email</label><input id="email" name="email" type="email">
<label for="phone">Phone</label><input id="phone" name="phone" type="tel">
<label for="resume">Resume/CV</label><input id="resume" name="resume" type="file">
<button type="submit">Submit application</button></form></main>${track}`;

/** A sanitized custom-careers application (the Waymo shape): description first, the form appears after
 * "Apply Now" without a navigation, the way a React careers site renders it. */
const waymoApplication = `<!doctype html><meta charset="utf-8"><title>Machine Learning Engineer - Careers</title>
<main id="app"><h1>Machine Learning Engineer</h1><p>Build the driver. Job description text, benefits and locations.</p>
<button id="apply-now" type="button">Apply Now</button><div id="slot"></div></main>
<script>
document.getElementById('apply-now').addEventListener('click',()=>{setTimeout(()=>{document.getElementById('slot').innerHTML=\`
<form id="application-form" novalidate><h2>Apply for this job</h2>
<div><label for="first_name">First name *</label><input id="first_name" name="first_name" autocomplete="given-name" required></div>
<div><label for="last_name">Last name *</label><input id="last_name" name="last_name" autocomplete="family-name" required></div>
<div><label for="email">Email *</label><input id="email" name="email" type="email" autocomplete="email" required></div>
<div><label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel"></div>
<div><label for="resume">Resume *</label><input id="resume" name="resume" type="file" required></div>
<div><label for="cover">Cover letter</label><input id="cover" name="cover_letter" type="file"></div>
<div><label for="linkedin">LinkedIn Profile</label><input id="linkedin" name="linkedin"></div>
<div><label for="website">Website</label><input id="website" name="website"></div>
<div><label for="auth">Are you legally authorized to work in the United States? *</label><select id="auth" name="auth"><option value="">Select</option><option>Yes</option><option>No</option></select></div>
<div><label for="spons">Will you now or in the future require visa sponsorship? *</label><select id="spons" name="spons"><option value="">Select</option><option>Yes</option><option>No</option></select></div>
<div><label for="why">Why do you want to work here?</label><textarea id="why" name="why"></textarea></div>
<fieldset><legend>Voluntary self-identification</legend><label for="gender">Gender</label><select id="gender" name="gender"><option value="">Select</option><option>Female</option><option>Male</option><option>Decline to self-identify</option></select></fieldset>
<button type="submit">Submit application</button></form>\`},600)});
</script>${track}`;


/** A realistic Ashby application: 35 controls, long labels, required markers, a scrolling inner container, and host CSS that is
 * deliberately hostile to anything it does not own (inheritable text styles, generic element rules). */
export const ASHBY_RICH = (() => {
  const long = (n: number) => `Please describe in as much detail as you can how your experience relates to requirement number ${n} of this role, including tools and outcomes`;
  const q = (id: string, label: string, kind: "text" | "area" | "select" | "radio" | "check", required = true) => {
    const mark = required ? ' <span style="color:#c00">*</span>' : "";
    if (kind === "text") return `<div class="ashby-application-form-field-entry"><label for="${id}">${label}${mark}</label><input id="${id}" name="${id}" type="text"${required ? " required" : ""}></div>`;
    if (kind === "area") return `<div class="ashby-application-form-field-entry"><label for="${id}">${label}${mark}</label><textarea id="${id}" name="${id}"${required ? " required" : ""}></textarea></div>`;
    if (kind === "select") return `<div class="ashby-application-form-field-entry"><label for="${id}">${label}${mark}</label><select id="${id}" name="${id}"><option value="">Select…</option><option>Yes</option><option>No</option><option>Prefer not to say</option></select></div>`;
    if (kind === "radio") return `<fieldset class="ashby-application-form-field-entry"><legend>${label}${mark}</legend><label><input type="radio" name="${id}" value="yes"> Yes</label><label><input type="radio" name="${id}" value="no"> No</label></fieldset>`;
    return `<div class="ashby-application-form-field-entry"><label><input type="checkbox" id="${id}" name="${id}"> ${label}${mark}</label></div>`;
  };
  const inner = [1, 2, 3, 4, 5, 6].map(n => q(`scroll_${n}`, `Scrolling section question ${n}: ${long(n)}`, n % 2 ? "text" : "area")).join("");
  const many = Array.from({ length: 20 }, (_, i) => q(`extra_${i + 1}`, i % 5 === 0 ? long(i + 1) : `Question ${i + 1} about your background and preferences`, (["text", "area", "select", "radio", "check"] as const)[i % 5], i % 3 !== 0)).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plaid - Senior Software Engineer, Platform and Reliability - Application</title>
<style>
 /* Host styles an employer site really has: they must not reach the assistant, and nothing of ours may reach them. */
 body{margin:0;font:16px/1.7 Georgia,serif;letter-spacing:.04em;text-transform:none;color:#222;text-align:justify;background:#fff}
 div,section,fieldset,label,span,p,h1,h2,button,input,select,textarea{position:relative}
 h1,h2{font-size:34px;text-transform:uppercase;letter-spacing:.2em;margin:24px}
 button{padding:20px 40px;font-size:22px;background:#e11;color:#fff}
 label{display:block;margin:6px 0 2px;font-weight:700}
 input[type=text],textarea,select{display:block;width:100%;max-width:520px;padding:10px;font-size:16px}
 form{max-width:760px;margin:0 auto;padding:24px}
 .ashby-application-form-field-entry,fieldset{margin:14px 0;border:0;padding:0}
 #scroller{max-height:260px;overflow:auto;border:1px solid #bbb;padding:10px}
</style></head><body>
<main class="ashby-application-form-container"><h1>Senior Software Engineer, Platform and Reliability</h1>
<form id="application-form" novalidate>
${q("_systemfield_name", "Name", "text")}${q("_systemfield_email", "Email", "text")}
<div class="ashby-application-form-field-entry"><label for="_systemfield_phone">Phone <span style="color:#c00">*</span></label><input id="_systemfield_phone" name="phone" type="tel"></div>
${q("location", "Current location (city and country)", "text")}${q("linkedin", "LinkedIn profile", "text", false)}${q("website", "Personal website", "text", false)}
<div class="ashby-application-form-field-entry"><label for="_systemfield_resume">Resume <span style="color:#c00">*</span></label><input id="_systemfield_resume" name="resume" type="file"></div>
<div id="scroller">${inner}</div>
${many}
<button type="submit">Submit application</button></form></main>
<script>window.__emp={submits:0,clicks:0};document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('button[type=submit]'))window.__emp.clicks++},true);document.addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++},true);</script>
</body></html>`;
})();


/**
 * XA-EXT-GREENHOUSE-04: a Greenhouse job-board application of the shape the user reported (React Select comboboxes, a required
 * marker on every label, a voluntary self-identification section, a sticky header, an inner scrolling section, host CSS that
 * restyles every element). Sanitized: no real employer text, no real person. `?prefill=1` starts with values Chrome's own autofill or
 * the employer could already have put in.
 */
export const GREENHOUSE_RICH = (prefill: boolean) => {
  const select = (id: string, label: string, options: string[], required = true) => `<div class="select__container"><label id="${id}-label" class="label select__label" for="${id}">${label}${required ? ' <span class="req">*</span>' : ""}</label>
<div class="select-shell"><div class="select__control" data-for="${id}"><div class="select__value-container"><div class="select__placeholder">Select...</div><div class="select__input-container"><input id="${id}" class="select__input" type="text" role="combobox" aria-expanded="false" aria-haspopup="true" aria-autocomplete="list" autocomplete="off" data-options="${options.join("|")}"></div></div><div class="select__indicators"><span class="select__dropdown-indicator">▾</span></div></div></div></div>`;
  const text = (id: string, label: string, value = "", required = true, type = "text") => `<div class="text-input-wrapper"><label for="${id}" class="label">${label}${required ? ' <span class="req">*</span>' : ""}</label><input id="${id}" name="${id}" type="${type}" class="input" value="${value}"></div>`;
  const yn = ["Yes", "No"];
  const eeo = [
    select("gender", "Gender", ["Male", "Female", "Non-binary", "Decline to self-identify"], false),
    select("hispanic_ethnicity", "Are you Hispanic/Latino?", ["Yes", "No", "Decline to self-identify"], false),
    select("veteran_status", "Veteran Status", ["I am not a protected veteran", "I identify as one or more of the classifications of protected veteran", "I don't wish to answer"], false),
    select("disability_status", "Disability Status", ["Yes, I have a disability, or have had one in the past", "No, I do not have a disability and have not had one in the past", "I do not want to answer"], false)
  ].join("");
  const scrolling = [1, 2, 3].map(n => text(`inner_${n}`, `Scrolling section question ${n}: describe your experience with the systems named in requirement ${n} of this role`, "", n === 1)).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Job Application for Senior Machine Learning Engineer, Ads ML Efficiency</title>
<style>
 body{margin:0;font:16px/1.6 "Helvetica Neue",Arial,sans-serif;color:#1d1d1f;letter-spacing:.02em;background:#fff}
 header.top{position:sticky;top:0;z-index:50;height:56px;display:flex;align-items:center;gap:16px;padding:0 24px;background:#fff;border-bottom:1px solid #ddd}
 header.top a{color:#06c}
 main{max-width:720px;margin:0 auto;padding:24px}
 div,section,fieldset,label,span,p,h1,h2,button,input,select,textarea{position:relative}
 label.label{display:block;margin:18px 0 6px;font-weight:600;font-size:14px}
 .req{color:#c00}
 input.input,textarea{display:block;width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #888;border-radius:4px}
 .select__control{display:flex;align-items:center;min-height:44px;border:1px solid #888;border-radius:4px;background:#fff;cursor:pointer}
 .select__value-container{flex:1;padding:0 10px;display:flex;align-items:center}
 .select__placeholder{color:#777;position:absolute}
 .select__input{border:0;outline:0;width:2px;min-width:2px;padding:0;background:transparent;opacity:1}
 .select__single-value{color:#111}
 .select__indicators{padding:0 10px;color:#555}
 .select__menu{position:absolute;left:0;right:0;top:100%;z-index:40;margin-top:4px;background:#fff;border:1px solid #888;border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.2)}
 .select__option{padding:10px 12px;cursor:pointer}
 .select__option:hover{background:#eef}
 .select-shell{position:relative}
 #inner{max-height:230px;overflow:auto;border:1px solid #bbb;padding:12px;margin:18px 0}
 .section-title{font-size:20px;margin:32px 0 4px}
 .submit{margin-top:32px;padding:14px 28px;font-size:18px;background:#1a4;color:#fff;border:0;border-radius:6px}
</style></head><body>
<header class="top"><strong>Acme Ads</strong><a href="#">Back to jobs</a><a href="#">Benefits</a></header>
<main><h1>Senior Machine Learning Engineer, Ads ML Efficiency</h1>
<form id="application-form" novalidate>
${text("first_name", "First Name")}${text("last_name", "Last Name", prefill ? "ChromeFilled" : "")}${text("email", "Email", "", true, "email")}
${text("phone", "Phone", "", true, "tel")}
<div class="text-input-wrapper"><label for="resume" class="label">Resume/CV <span class="req">*</span></label><input id="resume" name="resume" type="file"></div>
<div class="text-input-wrapper"><label for="cover_letter" class="label">Cover Letter</label><input id="cover_letter" name="cover_letter" type="file"></div>
${text("linkedin", "LinkedIn Profile", "", false)}${text("website", "Website", "", false)}
${select("work_auth", "Are you legally authorized to work in the United States?", yn)}
${select("sponsorship", "Will you now or in the future require sponsorship for employment visa status?", yn)}
${select("relocate", "Are you willing to relocate for this role?", yn)}
<div id="inner">${scrolling}</div>
${text("why", "Why are you interested in this role?", "", true)}
<h2 class="section-title">Voluntary Self-Identification</h2>
<p>This information is optional and kept separate from your application.</p>
${eeo}
<button class="submit" type="submit">Submit application</button></form></main>
<script>
window.__emp={submits:0,clicks:0};
document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('button[type=submit]'))window.__emp.clicks++},true);
document.addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++},true);
// A minimal React-Select: the menu is rendered into the control's own shell when it opens, and removed when it closes.
function closeMenus(){document.querySelectorAll('.select__menu').forEach(m=>m.remove());document.querySelectorAll('.select__input').forEach(i=>i.setAttribute('aria-expanded','false'))}
function openMenu(control){
  closeMenus();
  const input=control.querySelector('input');
  const menu=document.createElement('div');menu.className='select__menu';
  const list=document.createElement('div');list.className='select__menu-list';list.setAttribute('role','listbox');list.id=input.id+'-listbox';
  input.dataset.options.split('|').forEach((label,i)=>{const o=document.createElement('div');o.className='select__option';o.setAttribute('role','option');o.id=input.id+'-option-'+i;o.textContent=label;
    o.addEventListener('mousedown',ev=>{ev.preventDefault();pick(control,label)});list.appendChild(o)});
  menu.appendChild(list);control.parentElement.appendChild(menu);input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls',list.id);
}
function pick(control,label){
  const vc=control.querySelector('.select__value-container');const old=vc.querySelector('.select__single-value');if(old)old.remove();
  const ph=vc.querySelector('.select__placeholder');if(ph)ph.style.display='none';
  const v=document.createElement('div');v.className='select__single-value';v.textContent=label;vc.prepend(v);
  const input=control.querySelector('input');input.value='';input.dataset.selected=label;closeMenus();
}
document.querySelectorAll('.select__control').forEach(control=>{
  control.addEventListener('mousedown',e=>{e.preventDefault();control.querySelector('input').focus();if(control.parentElement.querySelector('.select__menu'))closeMenus();else openMenu(control)});
  const input=control.querySelector('input');
  input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='Enter'){if(!control.parentElement.querySelector('.select__menu'))openMenu(control)}if(e.key==='Escape')closeMenus()});
});
document.addEventListener('mousedown',e=>{if(!e.target.closest('.select-shell'))closeMenus()});
window.__selected=()=>Object.fromEntries([...document.querySelectorAll('.select__input')].map(i=>[i.id,i.dataset.selected||'']));
</script></body></html>`;
};

const newsletter = `<!doctype html><meta charset="utf-8"><title>Newsletter</title><main><h1>Stay in touch</h1><form><label for="e">Email</label><input id="e" type="email"><button type="submit">Subscribe</button></form></main>`;
const login = `<!doctype html><meta charset="utf-8"><title>Sign in</title><main><h1>Sign in</h1><form><label for="e">Email</label><input id="e" type="email"><label for="p">Password</label><input id="p" type="password"><button type="submit">Sign in</button></form></main>`;
const search = `<!doctype html><meta charset="utf-8"><title>Search jobs</title><main><h1>Search</h1><form role="search"><label for="q">Search jobs</label><input id="q" type="search"><button type="submit">Search</button></form></main>`;
const listing = (t: string) => `<!doctype html><title>${t}</title><main><h1>${t}</h1><p>Open roles</p><a href="#">Software Engineer</a></main>`;

export function employerPage(host: string, url: string): string {
  const parsed = new URL(url, "https://x");
  const p = parsed.pathname;
  if (host === "jobs.ashbyhq.com" && p.endsWith("/application") && parsed.searchParams.get("rich")) return ASHBY_RICH;
  if (p === "/newsletter") return newsletter;
  if (p === "/login") return login;
  if (p === "/search") return search;
  if (host === "careers.withwaymo.com" || host === UNGRANTED_HOST) return /^\/jobs\/[\w-]+(\/apply)?$/.test(p) ? waymoApplication : listing("Waymo careers");
  if (host === "job-boards.greenhouse.io" && /\/jobs\/\d+/.test(p) && parsed.searchParams.get("rich")) return GREENHOUSE_RICH(parsed.searchParams.get("prefill") === "1");
  if (host === "job-boards.greenhouse.io") return /\/jobs\/\d+/.test(p) ? simpleForm("Apply - Greenhouse-shaped") : listing("Acme jobs");
  if (host === "jobs.lever.co") return p.endsWith("/apply") ? `<!doctype html><meta charset="utf-8"><title>Lever-shaped</title>${LEVER_FORM}${track}` : listing("Zoox - job description");
  if (host === "jobs.ashbyhq.com") return p.endsWith("/application") ? simpleForm("Application - Ashby-shaped") : listing("Acme at Ashby");
  return /\/apply$/.test(p) ? simpleForm("Apply - Workday-shaped") : listing("Workday careers");
}

export async function employerTls(extraMaps: string[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "xa-core1-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "1", "-subj", "/CN=employer.test"], { stdio: "ignore" });
  const requests: string[] = [];
  const server: HttpsServer = createHttps({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (rq, rs) => {
    const host = String(rq.headers.host ?? "").split(":")[0];
    requests.push(`${host}${rq.url}`);
    rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    rs.end(employerPage(host, rq.url ?? "/"));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const mapped = [...HOSTS, UNGRANTED_HOST];
  return { server, port, requests, args: [`--host-resolver-rules=${[...mapped.map(h => `MAP ${h} 127.0.0.1:${port}`), ...extraMaps].join(",")}`, "--ignore-certificate-errors"] };
}

const labelKey = (t: string) => /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^full name/i.test(t) ? "full_name"
  : /^e-?mail/i.test(t) ? "email" : /^phone/i.test(t) ? "phone" : /linkedin/i.test(t) ? "linkedin_url" : /^website/i.test(t) ? "portfolio_url"
  : /current company/i.test(t) ? "current_company" : null;

export type ApiLogEntry = { method: string; path: string; auth: string };

/** The owned XpertApply backend. Access tokens are `acc-<userId>`; session tokens `sess-<userId>-<sessionId>`. */
export async function startDirectApi() {
  const log: ApiLogEntry[] = [];
  const sessions = new Map<number, { userId: number; url: string }>();
  let nextId = 7000;
  const state = { revoked: false, refreshes: 0, failDirect: false, failSessions: false, directStatus: 500, sessionStatus: 401 };
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const server: HttpServer = createHttp(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = String(req.headers.authorization ?? "");
    log.push({ method: req.method ?? "GET", path: url.pathname, auth });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {};
    const access = /^Bearer acc-(\d+)$/.exec(auth);
    const sess = /^Bearer sess-(\d+)-(\d+)$/.exec(auth);
    const rawSession = (id: number) => {
      const s = sessions.get(id)!;
      return { session_id: id, authenticated_user_id: s.userId, ats_type: null, official_application_url: s.url, job: { title: "Job application", company: new URL(s.url).hostname },
        resume: { status: "ready", document_id: null, download_url: null }, cover_letter: { status: "not_requested", document_id: null, download_url: null }, profile: PROFILES[s.userId] };
    };
    if (url.pathname === "/extension/direct-sessions" && req.method === "POST") {
      if (!access || state.revoked) return json(res, 401, { detail: "Invalid token" });
      if (state.failDirect) return json(res, state.directStatus, { detail: "preparation failed" });
      const userId = Number(access[1]);
      const u = new URL(String(body.url));
      if (u.search || u.hash) return json(res, 400, { detail: "query must not be sent" });
      let id = [...sessions].find(([, s]) => s.userId === userId && s.url === body.url)?.[0];
      if (!id) { id = nextId++; sessions.set(id, { userId, url: body.url }); }
      return json(res, 201, { ...rawSession(id), session_token: `sess-${userId}-${id}` });
    }
    if (url.pathname === "/extension/auth/token" && req.method === "POST") {
      state.refreshes++;
      if (state.revoked) return json(res, 401, { detail: "Invalid refresh token" });
      const uid = Number(String(body.refresh_token).replace("ref-", ""));
      return json(res, 200, { access_token: `acc-${uid}`, refresh_token: `ref-${uid}`, expires_in: 1800, user: { id: uid, email: PROFILES[uid].email } });
    }
    const m = /^\/application-sessions\/(\d+)(\/.*)?$/.exec(url.pathname);
    if (m) {
      const id = Number(m[1]);
      if (state.failSessions) return json(res, state.sessionStatus, { detail: "session revoked" });
      const owner = sessions.get(id);
      if (!owner || !sess || Number(sess[2]) !== id || Number(sess[1]) !== owner.userId) return json(res, 403, { detail: "Token not valid for this session" });
      const rest = m[2] ?? "";
      if (rest === "") return json(res, 200, rawSession(id));
      const profile = PROFILES[owner.userId];
      if (rest === "/answers") return json(res, 200, { answers: Object.entries(profile).map(([k, v]) => answer(k, v)), unresolved_questions: [], refreshed: false, profile_revision: "r" });
      if (rest === "/answers/override") return json(res, 200, { overrides: [] });
      if (rest === "/resolve-questions") {
        const results = (body.questions ?? []).map((q: any) => {
          const k = labelKey(String(q.question ?? "")); const v = k ? profile[k] : undefined;
          return k && v ? { field_ref: q.field_ref, status: "resolved", canonical_key: k, answer_type: "text", selected_option_ref: null, safe_source: "saved_profile", confidence: 1, reason_code: "exact", typed_answer: v, display_answer: v, source_values: [v], sensitivity: null }
            : { field_ref: q.field_ref, status: "missing", canonical_key: null, answer_type: null, selected_option_ref: null, safe_source: "none", confidence: 0, reason_code: "answer_missing", typed_answer: null, display_answer: null, source_values: [] };
        });
        return json(res, 200, { request_schema_version: 3, answer_contract_version: 3, registry_version: "x", results });
      }
      return json(res, 200, {});
    }
    return json(res, 404, { detail: "unconfigured" });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://localhost:${(server.address() as { port: number }).port}`;
  return { server, origin, log, sessions, state, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

export async function launchSignedIn(opts: { api: Awaited<ReturnType<typeof startDirectApi>>; tls: Awaited<ReturnType<typeof employerTls>>; userId?: number | null; profileDir?: string }) {
  const dist = process.env.XA_E2E_DIST!;
  const ctx: BrowserContext = await chromium.launchPersistentContext(opts.profileDir ?? "", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...opts.tls.args] });
  const worker: Worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const signIn = (userId: number) => worker.evaluate(async ([uid, email]) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("xpertapply-extension-auth", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put({ v: 1, accessToken: `acc-${uid}`, refreshToken: `ref-${uid}`, expiresAt: Date.now() + 1_800_000, userId: uid, email }, "xaExtensionAuthV1");
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, [userId, PROFILES[userId].email] as const);
  await worker.evaluate(async api => chrome.storage.local.set({ apiBase: api }), opts.api.origin);
  if (opts.userId !== null) await signIn(opts.userId ?? 7);
  // Registered scripts mirror the grants; wait until every employer origin has one.
  await expect.poll(async () => (await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id))).filter((id: string) => id.startsWith("xa-site-")).length, { timeout: 30_000 }).toBe(HOSTS.length);
  return { ctx, worker, signIn, async close() { await ctx.close().catch(() => undefined); } };
}

export const directDrafts = (api: { log: ApiLogEntry[] }) => api.log.filter(l => l.method === "POST" && l.path === "/extension/direct-sessions");
export const overlayCount = (p: Page) => p.locator("#xpertapply-assistant-overlay-v1").count();
export const submitsUntouched = (p: Page) => p.evaluate(() => (window as any).__emp);

/** XA-EXT-DIRECT-ENTRY-02: `https://api-staging.xpertapply.com` served from loopback. A TLS front that forwards every request to the
 * owned mock API, so the STAGING build (which accepts only that exact API origin) can be exercised in a real browser. */
export async function stagingApiFront(api: { origin: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "xa-stg-api-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "1", "-subj", "/CN=api-staging.test"], { stdio: "ignore" });
  const seen: string[] = [];
  const server: HttpsServer = createHttps({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, async (rq, rs) => {
    seen.push(`${rq.method} ${rq.url}`);
    const chunks: Buffer[] = [];
    for await (const chunk of rq) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const upstream = await fetch(`${api.origin}${rq.url}`, { method: rq.method, headers: { authorization: String(rq.headers.authorization ?? ""), "content-type": String(rq.headers["content-type"] ?? "application/json") }, body });
    rs.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
    rs.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, seen, close: () => server.close() };
}
