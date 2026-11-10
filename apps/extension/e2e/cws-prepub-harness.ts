import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { OwnedPackageFixture } from "./owned-package-fixture";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";
import path from "node:path";

export const DIST = process.env.XA_E2E_DIST ?? path.resolve("dist-e2e-granted");

export type Unresolved = Record<string, unknown>[];

/** A deterministic employer page plus an owned loopback XpertApply API. Every
 * request the API sees is recorded with its full body for sentinel scanning. */
export async function startHarness(opts: { html: string; unresolved?: Unresolved; prepared: boolean; initScript?: () => void }) {
  const fx = await new OwnedPackageFixture(opts.html).start();
  const url = `${fx.origin}/apply`;
  const session = { session_id: 55, ats_type: null, official_application_url: url, job: { title: "Engineer", company: "Acme" }, resume: { status: "ready", document_id: null, download_url: null }, cover_letter: { status: "not_requested", document_id: null, download_url: null }, profile: {}, answers: [], unresolved_questions: [] };
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  const apiLog: { method: string; path: string; body: string | null }[] = [];
  const logged = (h: (r: any) => unknown) => (r: any) => {
    apiLog.push({ method: r.request().method(), path: new URL(r.request().url()).pathname, body: r.request().postData() });
    return h(r);
  };
  await fx.route("**/application-sessions/token", logged(r => r.fulfill(json({ session_token: fx.sessionToken, session }))));
  await fx.route("**/application-sessions/55", logged(r => r.fulfill(json(session))));
  await fx.route("**/application-sessions/55/answers", logged(r => r.fulfill(json({ answers: [], unresolved_questions: opts.unresolved ?? [], refreshed: false }))));
  await fx.route("**/application-sessions/55/answers/override", logged(r => r.fulfill(json({ overrides: [] }))));
  await fx.route("**/application-sessions/55/resolve-questions", logged(r => {
    const body = JSON.parse(r.request().postData() ?? "{}");
    const key = (text: string) => (/first name/i.test(text) ? "first_name" : /last name/i.test(text) ? "last_name" : null);
    const results = (body.questions ?? []).map((q: any) => ({ field_ref: q.field_ref, status: "missing", canonical_key: key(String(q.question ?? "")), answer_type: null, selected_option_ref: null, safe_source: "none", confidence: 0, reason_code: "answer_missing", typed_answer: null, display_answer: null, source_values: [] }));
    return r.fulfill(json({ request_schema_version: 3, answer_contract_version: 3, registry_version: "x", results }));
  }));
  await fx.route("**/application-sessions/55/profile/name", logged(r => r.fulfill(json({ ok: true }))));
  for (const e of ["events", "autofill-results", "complete"]) await fx.route(`**/application-sessions/55/${e}`, logged(r => r.fulfill(json({}))));
  const ctx: BrowserContext = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  if (opts.initScript) await ctx.addInitScript(opts.initScript);
  const worker: Worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  return {
    fx, ctx, worker, url, apiLog,
    async close() { await ctx.close(); await fx.close().catch(() => undefined); },
    /** Point the worker at the owned API, as a logged-in launch would. */
    async useOwnedApi() { await worker.evaluate(async b => chrome.storage.local.set({ apiBase: b }), fx.origin); },
    async seedPrepared() {
      // Synchronise with the worker: the page's own load events (tabs.onUpdated "complete") must have been HANDLED before a handoff exists,
      // otherwise under load the worker processes them afterwards, finds the seeded handoff and (by design) injects the engine for a
      // matching prepared launch, which these tests assert has not happened yet. Observed: tab complete, then one settled worker turn.
      await worker.evaluate(async u => {
        for (let i = 0; i < 100; i += 1) {
          const tab = (await chrome.tabs.query({})).find(t => t.url === u);
          if (tab?.status === "complete") break;
          await new Promise(r => setTimeout(r, 50));
        }
        await new Promise(r => setTimeout(r, 750));
      }, url);
      await worker.evaluate(async u => {
        const now = Date.now();
        await chrome.storage.session.set({ activeAssistedApplyHandoffV1: { version: 1, applicationId: "m2", jobId: "1", applicationUrl: u, status: "prepared", handoffToken: "h", requestId: "m2", sessionId: 55, launchToken: "l", officialUrl: u, expectedOrigin: new URL(u).origin, createdAt: now, expiresAt: now + 900000, state: "waiting_for_content_script", protocolVersion: 3, atsType: null } });
      }, url);
    },
    /** Record every fetch() the worker issues (url, method, body) from now on. */
    async hookWorkerFetch() {
      await worker.evaluate(() => {
        const g = globalThis as any;
        if (g.__xaFetchLog) return;
        g.__xaFetchLog = [];
        const real = g.fetch.bind(g);
        g.fetch = (input: any, init?: any) => {
          const u = typeof input === "string" ? input : input?.url ?? String(input);
          g.__xaFetchLog.push({ url: u, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : init?.body ? "[non-string body]" : null });
          return real(input, init);
        };
      });
    },
    workerFetches(): Promise<{ url: string; method: string; body: string | null }[]> {
      return worker.evaluate(() => (globalThis as any).__xaFetchLog ?? []);
    },
    async toolbarClick(page: Page) { return CanonicalOverlayDriver.openFromToolbar(page, worker); }
  };
}
