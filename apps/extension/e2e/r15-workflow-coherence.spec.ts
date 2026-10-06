import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";

const DIST = process.env.XA_E2E_DIST ?? path.resolve("dist-e2e-granted");

test("R15 trusted child progress survives physical worker restart and stays idle", async ({}, testInfo) => {
  // Same existing recovery-case deadline; the required idle window alone is 60s.
  test.setTimeout(240_000);
  const controls = `<h1>Apply for Software Engineer</h1><form><label>First name<input id="first" name="first_name" autocomplete="given-name"></label><label>Email<input id="email" name="email" type="email" autocomplete="email"></label><label>Why join?<textarea id="manual" name="motivation"></textarea></label><label><input id="privacy" name="privacy" type="checkbox">I agree to the privacy policy</label><button id="submit" type="submit">Submit application</button></form><script>window.audit={submitClicks:0,submits:0};document.addEventListener('click',e=>{if(e.target.id==='submit')audit.submitClicks++});document.addEventListener('submit',e=>{e.preventDefault();audit.submits++});</script>`;
  let apiSession: Record<string, unknown> | null = null;
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/application-sessions/")) {
      res.setHeader("Content-Type", "application/json");
      const body = url.endsWith("/token") ? { session_token: "synthetic", session: apiSession }
        : url.endsWith("/answers") ? { answers: [
          { canonical_key: "first_name", value: "Riley", display_value: "Riley", source: "profile", confidence: 1, sensitive: false, verified: true, requires_review: false },
          { canonical_key: "email", value: "riley@example.test", display_value: "riley@example.test", source: "profile", confidence: 1, sensitive: false, verified: true, requires_review: false }
        ], unresolved_questions: [], refreshed: false }
        : url.endsWith("/resolve-questions") ? { request_schema_version: 3, answer_contract_version: 3, registry_version: "fixture", results: [] }
        : url.endsWith("/answers/override") ? { overrides: [] }
        : url === "/application-sessions/3003" ? apiSession : {};
      res.end(JSON.stringify(body)); return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(url === "/apply/child" ? controls : '<h1>Employer application</h1><iframe src="/apply/child"></iframe>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://localhost:${(server.address() as { port: number }).port}`;
  const profile = fs.mkdtempSync(path.join(tmpdir(), "xpertapply-r15-child-"));
  const launchedAt = performance.now();
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] });
  try {
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const session = { session_id: 3003, ats_type: "smartrecruiters", official_application_url: `${origin}/apply`, job: { title: "Software Engineer", company: "Synthetic Employer" }, profile: { first_name: "Riley", email: "riley@example.test" }, resume: { status: "not_requested" }, cover_letter: { status: "not_requested" } };
    apiSession = session;
    await context.route("**/application-sessions/token", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: "synthetic", session }) }));
    await context.route("**/application-sessions/*/answers", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers: ["first_name", "email"].map(key => ({ canonical_key: key, value: session.profile[key as keyof typeof session.profile], display_value: session.profile[key as keyof typeof session.profile], source: "profile", confidence: 1, sensitive: false, verified: true, requires_review: false })), unresolved_questions: [], refreshed: false }) }));
    await context.route("**/application-sessions/*/resolve-questions", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ request_schema_version: 3, answer_contract_version: 3, registry_version: "fixture", results: [] }) }));
    await context.route("**/application-sessions/3003", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
    // Observe the existing handshake callback directly. A scripting read can
    // remain pending after both callbacks finish, so it cannot bound readiness.
    const readyFrames = new Map<import("@playwright/test").Frame, { url: string; at: number; sentAt: number; received: number }>();
    let readinessChanged = () => {};
    let matched1: number | null = null;
    let matched2: number | null = null;
    await context.exposeBinding("__r15ContentReady", ({ frame }, result: { matched: boolean; url: string; at: number; sentAt: number }) => {
      if (result.matched && result.url === frame.url()) readyFrames.set(frame, { url: result.url, at: result.at, sentAt: result.sentAt, received: performance.now() - launchedAt });
      else readyFrames.delete(frame);
      if (readyFrames.size === 1) matched1 ??= performance.now() - launchedAt;
      if (readyFrames.size === 2) matched2 ??= performance.now() - launchedAt;
      readinessChanged();
    });
    await context.addInitScript(() => {
      document.addEventListener("r15-content-ready", event => {
        const result = JSON.parse((event as CustomEvent<string>).detail);
        void (globalThis as any).__r15ContentReady(result);
      });
    });
    const page = await context.newPage();
    page.on("framenavigated", frame => { readyFrames.delete(frame); });
    await page.goto(`${origin}/apply`);
    await expect.poll(() => page.frames().some(f => f.url() === `${origin}/apply/child`)).toBe(true);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)!.id!, page.url());
    await worker.evaluate(async id => { await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: () => {
      const world = globalThis as any; const m = world.__r15Metrics = { context: 0, view: 0, queries: 0, mutations: 0, timers: new Set<number>(), progress: null as { discovered: number; filled: number; review: number; state: string } | null, lastReady: null as { matched: boolean; error: string | null } | null };
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      (chrome.runtime as any).sendMessage = (message: any, callback: any) => {
        if (message.type === "XPERTAPPLY_OVERLAY_GET_CONTEXT") m.context++;
        if (message.type === "XPERTAPPLY_OVERLAY_GET_VIEW") m.view++;
        if (message.type === "JOBPILOT_AUTOFILL_RESULT") { const p = message.progress; m.progress = { discovered: p.fieldsDiscovered, filled: p.filled, review: p.reviewRequired, state: p.state }; }
        const readySentAt = message.type === "JOBPILOT_CONTENT_READY" ? performance.timeOrigin + performance.now() : null;
        return send(message, (response: any) => { void chrome.runtime.lastError; if (message.type === "JOBPILOT_CONTENT_READY") {
          m.lastReady={matched:Boolean(response?.matched),error:response?.error??null};
          document.dispatchEvent(new CustomEvent("r15-content-ready", { detail: JSON.stringify({ matched: m.lastReady.matched, url: location.href, at: performance.timeOrigin + performance.now(), sentAt: readySentAt }) }));
        } if (typeof callback === "function") callback(response); });
      };
      const query = document.querySelector.bind(document), queries = document.querySelectorAll.bind(document), elementQueries = Element.prototype.querySelectorAll;
      document.querySelector = ((selector: string) => { m.queries++; return query(selector); }) as typeof document.querySelector;
      document.querySelectorAll = ((selector: string) => { m.queries++; return queries(selector); }) as typeof document.querySelectorAll;
      Element.prototype.querySelectorAll = (function(this: Element, selector: string) { if (this.getRootNode() === document) m.queries++; return elementQueries.call(this, selector); }) as typeof Element.prototype.querySelectorAll;
      const interval = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
      window.setInterval = ((fn: TimerHandler, ms?: number, ...args: any[]) => { const id = interval(fn, ms, ...args); m.timers.add(id); return id; }) as typeof window.setInterval;
      window.clearInterval = id => { if (typeof id === "number") m.timers.delete(id); clear(id); };
      const form = document.querySelector("form"); if (form) new MutationObserver(records => { m.mutations += records.length; }).observe(form, { childList: true, subtree: true, attributes: true, characterData: true });
    } }); }, tabId);
    await worker.evaluate(async url => { await chrome.storage.local.set({apiBase:new URL(url).origin}); const now = Date.now(); await chrome.storage.session.set({ activeAssistedApplyHandoffV1: { version: 1, applicationId: "r15", jobId: "3003", applicationUrl: url, status: "prepared", handoffToken: "synthetic", requestId: "r15", sessionId: 3003, launchToken: "synthetic", officialUrl: url, expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900000, state: "waiting_for_content_script", protocolVersion: 3, atsType: "smartrecruiters" } }); }, page.url());
    // Native toolbar grants/bootstrap are identical to the shared driver, with
    // allFrames only to qualify the selected trusted application child.
    await worker.evaluate(async id => { await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ["overlayBootstrap.js"] }); await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ["content.js"] }); await chrome.tabs.sendMessage(id, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 }); }, tabId);
    const driver = await CanonicalOverlayDriver.attach(page);
    // Match the qualified all-frame fixture: both current documents must finish
    // the normal CONTENT_READY handshake before requesting their fill lease.
    const expectedFrames = [page.mainFrame(), page.frames().find(frame => frame.url() === `${origin}/apply/child`)!];
    expect(expectedFrames[1]).toBeDefined();
    const readinessStarted = performance.now();
    const matchedFrames = () => expectedFrames.filter(frame => readyFrames.get(frame)?.url === frame.url());
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`CONTENT_READY expected 2 current frames, received ${matchedFrames().length} within 5000ms`)), 5000);
      readinessChanged = () => { if (matchedFrames().length === 2) { clearTimeout(deadline); resolve(); } };
      readinessChanged();
    });
    expect(matchedFrames()).toEqual(expectedFrames);
    testInfo.annotations.push({ type: "r15-readiness", description: JSON.stringify({ top: readyFrames.get(expectedFrames[0])!, child: readyFrames.get(expectedFrames[1])!, matched1, matched2, assertionStarted: readinessStarted - launchedAt, assertionFinished: performance.now() - launchedAt, completed: performance.now() - readinessStarted }) });
    await expect(page.locator("#xpertapply-assistant-overlay-v1 #fill")).toBeEnabled(); await driver.fill();
    const child = page.frames().find(f => f.url() === `${origin}/apply/child`)!;
    await expect(child.locator("#first")).toHaveValue("Riley"); await expect(child.locator("#email")).toHaveValue("riley@example.test");
    await expect(child.locator("#manual")).toHaveValue(""); await expect(child.locator("#privacy")).not.toBeChecked();
    const view = () => worker.evaluate(async id => { const { viewStates } = await chrome.storage.session.get("viewStates"); const v = viewStates[String(id)]; return { discovered: v.fieldsDiscovered, filled: v.filled, review: v.reviewRequired, state: v.state }; }, tabId);
    const metrics = () => worker.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: () => { const m = (globalThis as any).__r15Metrics; return { context: m.context, view: m.view, queries: m.queries, mutations: m.mutations, timers: m.timers.size, progress: m.progress, host: document.getElementById("xpertapply-assistant-overlay-v1") ? 1 : 0 }; } })).map(r => ({ frameId: r.frameId, documentId: r.documentId, ...r.result! })), tabId);
    await expect.poll(async () => (await view()).filled).toBeGreaterThan(0);
    await expect.poll(() => driver.status()).toMatch(/^Filled/);
    const before = await view(); const frameBefore = await metrics();
    expect(frameBefore.filter(f => f.host === 1).map(f => f.frameId)).toEqual([0]);
    expect(frameBefore.find(f => f.progress)?.progress).toEqual(before);
    await expect.poll(async () => { const v = await driver.summary(); return [v.discovered, v.filled, v.review]; }).toEqual([before.discovered, before.filled, before.review]);
    const oldEpoch = await worker.evaluate(() => { (globalThis as any).__r15OldWorker = true; return performance.timeOrigin; });
    const cdp = await context.browser()!.newBrowserCDPSession(); const internals = await context.newPage(); await internals.goto("chrome://serviceworker-internals");
    const registration = internals.locator(".serviceworker-registration").filter({ hasText: new URL(worker.url()).host }); await expect(registration).toHaveCount(1); await registration.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(async () => (await cdp.send("Target.getTargets")).targetInfos.filter((t: { type: string; url: string }) => t.type === "service_worker" && t.url === worker.url()).length).toBe(0); await internals.close();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(async () => { const fresh = context.serviceWorkers().find(w => w.url() === worker.url()); return fresh?.evaluate(epoch => performance.timeOrigin > epoch && !(globalThis as any).__r15OldWorker, oldEpoch).catch(() => false) ?? false; }).toBe(true);
    worker = context.serviceWorkers().find(w => w.url().includes("background.js"))!;
    await expect.poll(view).toEqual(before); await expect.poll(() => driver.status()).toMatch(/^Filled/);
    const after = await metrics(); expect(after.map(f => [f.frameId, f.documentId, f.host])).toEqual(frameBefore.map(f => [f.frameId, f.documentId, f.host]));
    await cdp.detach();
    let last = "", stable = 0; await expect.poll(async () => { const signature = JSON.stringify(await metrics()); stable = signature === last ? stable + 1 : 0; last = signature; return stable; }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
    const idleBefore = await metrics(); let requests = 0; const count = () => { requests++; }; context.on("request", count);
    await page.waitForTimeout(60_000); context.off("request", count);
    const idleAfter = await metrics(); const deltas = idleAfter.map(f => { const old = idleBefore.find(b => b.documentId === f.documentId)!; return { frameId: f.frameId, context: f.context - old.context, view: f.view - old.view, queries: f.queries - old.queries, mutations: f.mutations - old.mutations, timers: f.timers }; });
    expect(requests).toBe(0); for (const delta of deltas) expect(delta).toMatchObject({ context: 0, view: 0, queries: 0, mutations: 0, timers: 0 });
    expect(await child.evaluate(() => (window as any).audit)).toEqual({ submitClicks: 0, submits: 0 }); await expect(child.locator("#privacy")).not.toBeChecked();
  } finally { await context.close(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(profile, { recursive: true, force: true }); }
});
