import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createServer } from "node:http";
import { OwnedPackageFixture } from "./owned-package-fixture";

/** Verbatim shape of the deployed site's presence check (production /jobs chunk). */
export const deployedPresence = `new Promise(t=>{let r=!1,a=e=>{r||(r=!0,window.removeEventListener("message",s),t(e))},
 s=e=>{let t=e.data;e.source===window&&t?.source==="jobpilot-extension"&&"JOBPILOT_PONG"===t.type&&a(t.info??{installed:!0,version:"0.0.0",protocolVersion:0,capabilities:[]})};
 window.addEventListener("message",s),window.postMessage({source:"jobpilot-web",type:"JOBPILOT_PING",apiBase:"https://evil.example"},window.location.origin),window.setTimeout(()=>a(null),800)})`;

export const answer = (canonical_key: string, value: string) => ({ canonical_key, value, display_value: value, source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true });

export async function webServer() {
  const html = `<!doctype html><meta charset="utf-8"><title>XpertApply web fixture</title><main>web fixture</main>`;
  for (const port of [3000, 3001]) {
    const server = createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(html); });
    const ok = await new Promise<boolean>(res => { server.once("error", () => res(false)); server.listen(port, "127.0.0.1", () => res(true)); });
    if (ok) return { server, origin: `http://localhost:${port}` };
  }
  throw new Error("web fixture needs localhost:3000 or 3001");
}

export type LaunchOptions = {
  html: string;
  sessionId: number;
  atsType: string;
  profile: Record<string, unknown>;
  answers: ReturnType<typeof answer>[];
  /** Map a rendered question label to a canonical key for the owned resolver. */
  keyFor: (label: string) => string | null;
  /** Launch to this URL instead of the owned fixture's (it must be served by the spec, e.g. a mapped https ATS host). */
  officialUrl?: string;
  /** Extra Chromium switches (host-resolver MAP rules, certificate flags). */
  launchArgs?: string[];
  profileDir?: string;
  /** Load this extension build instead of the shared granted bundle. It must be registered in extension-build-authority for the calling spec. */
  extensionPath?: string;
  /** Shown as the job in the assistant (default "Software Engineer" at "Acme"). */
  jobTitle?: string;
  company?: string;
  /** Job location the employer posting states; legal US-only questions need a known jurisdiction (default: unknown). */
  location?: string;
  /** Drafts the owned backend returns for open-ended questions (default: none). */
  drafts?: (questions: any[]) => unknown[];
};

/** The deployed website's protocol, driven against a real unpacked extension. */
export async function launchFromWebsite(opts: LaunchOptions) {
  const employer = await new OwnedPackageFixture(opts.html).start();
  const web = await webServer();
  const applicationUrl = opts.officialUrl ?? `${employer.origin}/jobs/${opts.sessionId}`;
  const sid = opts.sessionId;
  const json = (b: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  const apiLog: string[] = [];
  const tap = (h: (r: any) => unknown) => (r: any) => { apiLog.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`); return h(r); };
  // The token exchange is answered per launch token so several website launches can share one owned backend.
  const sessionsByLaunchToken = new Map<string, unknown>();
  await employer.route("**/application-sessions/token", tap(r => {
    const body = JSON.parse(r.request().postData() ?? "{}");
    const found = sessionsByLaunchToken.get(String(body.launch_token));
    return found ? r.fulfill(json({ session_token: employer.sessionToken, session: found })) : r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "unknown_launch_token" }) });
  }));
  const addJob = async (job: { sessionId: number; atsType: string; officialUrl: string; jobTitle?: string; company?: string; location?: string; profile: Record<string, unknown>; answers: ReturnType<typeof answer>[]; keyFor: (label: string) => string | null; launchToken: string; drafts?: (questions: any[]) => unknown[] }) => {
    const sid = job.sessionId;
    const session = { session_id: sid, ats_type: job.atsType, official_application_url: job.officialUrl, job: { title: job.jobTitle ?? "Software Engineer", company: job.company ?? "Acme", ...(job.location ? { location: job.location } : {}) },
      resume: { status: "ready", document_id: null, download_url: null }, cover_letter: { status: "not_requested", document_id: null, download_url: null }, profile: job.profile };
    sessionsByLaunchToken.set(job.launchToken, session);
    await employer.route(`**/application-sessions/${sid}`, tap(r => r.fulfill(json(session))));
    await employer.route(`**/application-sessions/${sid}/answers`, tap(r => r.fulfill(json({ answers: job.answers, unresolved_questions: [], refreshed: false, profile_revision: "r" }))));
    await employer.route(`**/application-sessions/${sid}/answers/override`, tap(r => r.fulfill(json({ overrides: [] }))));
    await employer.route(`**/application-sessions/${sid}/resolve-questions`, tap(r => {
      const body = JSON.parse(r.request().postData() ?? "{}");
      const values = new Map(job.answers.map(x => [x.canonical_key, x.value]));
      const results = (body.questions ?? []).map((q: any) => {
        const k = job.keyFor(String(q.question ?? ""));
        const v = k ? values.get(k) : undefined;
        // A saved Yes/No legal answer for a question that offers options is returned the way the backend does: a boolean with the
        // matching option reference. Specs that never ask such a question are unaffected.
        if (k === "work_authorization_us" && v && Array.isArray(q.options) && q.options.length > 0) {
          const option = q.options.find((o: any) => String(o.label).toLowerCase() === v.toLowerCase());
          if (option) return { field_ref: q.field_ref, status: "resolved", canonical_key: k, answer_type: "boolean", selected_option_ref: option.option_ref, safe_source: "saved_profile", confidence: 1, reason_code: "exact_option", typed_answer: v.toLowerCase() === "yes", display_answer: v, source_values: [v.toLowerCase() === "yes"], sensitivity: "legal" };
        }
        return k && v ? { field_ref: q.field_ref, status: "resolved", canonical_key: k, answer_type: "text", selected_option_ref: null, safe_source: "saved_profile", confidence: 1, reason_code: "exact", typed_answer: v, display_answer: v, source_values: [v], sensitivity: null }
          : { field_ref: q.field_ref, status: "missing", canonical_key: null, answer_type: null, selected_option_ref: null, safe_source: "none", confidence: 0, reason_code: "answer_missing", typed_answer: null, display_answer: null, source_values: [] };
      });
      return r.fulfill(json({ request_schema_version: 3, answer_contract_version: 3, registry_version: "x", results }));
    }));
    for (const e of ["events", "autofill-results", "complete"]) await employer.route(`**/application-sessions/${sid}/${e}`, tap(r => r.fulfill(json({}))));
    // Open-ended drafting: no drafts unless the spec supplies them (the backend's own tests cover how drafts are produced).
    await employer.route(`**/application-sessions/${sid}/draft-answers`, tap(r => {
      const body = JSON.parse(r.request().postData() ?? "{}");
      return r.fulfill(json({ drafts: job.drafts ? job.drafts(body.questions ?? []) : [], drafted: 0 }));
    }));
  };
  await addJob({ sessionId: sid, atsType: opts.atsType, officialUrl: applicationUrl, jobTitle: opts.jobTitle, company: opts.company, location: opts.location, profile: opts.profile, answers: opts.answers, keyFor: opts.keyFor, launchToken: "synthetic-launch", drafts: opts.drafts });
  const dist = opts.extensionPath ?? process.env.XA_E2E_DIST!;
  const ctx: BrowserContext = await chromium.launchPersistentContext(opts.profileDir ?? "", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...(opts.launchArgs ?? [])] });
  const worker: Worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  await worker.evaluate(async b => chrome.storage.local.set({ apiBase: b }), employer.origin);
  const site: Page = await ctx.newPage();
  await site.goto(web.origin);
  const payload = { requestId: `req-${sid}`, launchToken: "synthetic-launch", sessionId: sid, jobId: sid, officialUrl: applicationUrl, atsType: opts.atsType, webApiBase: employer.origin, webAuthenticatedUserId: 1 };
  return {
    employer, web, ctx, worker, site, apiLog, applicationUrl, payload, addJob,
    presence: () => site.evaluate(deployedPresence) as Promise<{ installed: boolean; version: string; protocolVersion: number } | null>,
    async start(): Promise<{ empPage: Page; ack: any }> {
      await site.evaluate(p => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: p }, location.origin), payload);
      const [empPage, ack] = await Promise.all([
        ctx.waitForEvent("page", { timeout: 30_000 }),
        site.evaluate(p => new Promise<any>(resolve => {
          const on = (e: MessageEvent) => { if (e.source === window && e.data?.source === "jobpilot-extension" && e.data.type === "JOBPILOT_START_ASSISTED_APPLY_RESULT") { window.removeEventListener("message", on); resolve(e.data.result); } };
          window.addEventListener("message", on);
          window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: p }, location.origin);
        }), payload)
      ]);
      await empPage.waitForURL(applicationUrl);
      return { empPage, ack };
    },
    async close() { await ctx.close(); web.server.close(); await employer.close().catch(() => undefined); }
  };
}
