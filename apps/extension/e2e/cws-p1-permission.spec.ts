import { expect, test, chromium } from "@playwright/test";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Failure B: a launch to an employer origin Chrome has NOT granted.
 *
 * 0.3.0 left no way to ask. XA-P1 fixed that by opening the assistant window, which then sat
 * next to the in-page assistant once access was granted (two interfaces). Now the worker uses
 * chrome.permissions.addHostAccessRequest, Chrome's own per-tab access prompt: no gesture, no
 * XpertApply window. The employer page is not read, scripted or marked ready until Chrome
 * grants access, and permissions.onAdded resumes the workflow.
 *
 * Chrome's native Allow/Deny prompt cannot be driven by automation, so granting
 * itself is NOT exercised here; the post-grant flow is covered in cws-p1-launch-flow.
 */
const HOST = "employer-gh.test";
const employerHtml = `<!doctype html><title>Employer</title><form id="f"><label for="first_name">First Name</label><input id="first_name" autocomplete="given-name"></form>`;

test("launch to an ungranted origin asks Chrome for that origin, opens no XpertApply window and reads nothing", async () => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(path.join(tmpdir(), "xa-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "1", "-subj", `/CN=${HOST}`], { stdio: "ignore" });
  const hits: string[] = [];
  const employer = createHttps({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (rq, rs) => { hits.push(rq.url ?? ""); rs.writeHead(200, { "Content-Type": "text/html" }); rs.end(employerHtml); });
  await new Promise<void>(r => employer.listen(0, "127.0.0.1", r));
  const port = (employer.address() as { port: number }).port;
  const applicationUrl = `https://${HOST}:${port}/jobs/1`;
  const api: string[] = [];
  const apiServer = createHttp((rq, rs) => { api.push(`${rq.method} ${rq.url}`); rs.writeHead(200, { "Content-Type": "application/json" }); rs.end("{}"); });
  await new Promise<void>(r => apiServer.listen(0, "127.0.0.1", r));
  const web = createHttp((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end("<!doctype html><title>web</title>"); });
  const webPort = await new Promise<number>(res => { web.once("error", () => { web.listen(3001, "127.0.0.1", () => res(3001)); }); web.listen(3000, "127.0.0.1", () => res(3000)); });
  const dist = process.env.XA_E2E_DIST!;
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${port}`, "--ignore-certificate-errors"]
  });
  try {
    const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
    expect(await worker.evaluate(async o => chrome.permissions.contains({ origins: [o] }), `https://${HOST}/*`)).toBe(false);
    const site = await ctx.newPage();
    await site.goto(`http://localhost:${webPort}/`);
    const payload = { requestId: "perm-req", launchToken: "synthetic", sessionId: 5005, jobId: 5005, officialUrl: applicationUrl, atsType: "greenhouse", webApiBase: `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`, webAuthenticatedUserId: 1 };
    // Record what the worker asks Chrome for, passing the call through.
    const hasApi = await worker.evaluate(() => {
      const g = globalThis as any; g.__hostAccess = [];
      const perms = chrome.permissions as any;
      if (typeof perms.addHostAccessRequest !== "function") return false;
      const real = perms.addHostAccessRequest.bind(perms);
      perms.addHostAccessRequest = (req: unknown) => { g.__hostAccess.push(req); return real(req); };
      return true;
    });
    // The pinned Chromium (>= 133) must offer Chrome's host-access request; without it the test would prove nothing.
    expect(hasApi, "chrome.permissions.addHostAccessRequest must exist in the pinned Chromium").toBe(true);
    const windowsBefore = await worker.evaluate(async () => (await chrome.windows.getAll()).length);
    const ack = await site.evaluate(p => new Promise<any>(resolve => {
      const on = (e: MessageEvent) => { if (e.source === window && e.data?.source === "jobpilot-extension" && e.data.type === "JOBPILOT_START_ASSISTED_APPLY_RESULT") { window.removeEventListener("message", on); resolve(e.data.result); } };
      window.addEventListener("message", on);
      window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: p }, location.origin);
    }), payload);
    expect(ack).toMatchObject({ ok: true });
    const employerTab = await worker.evaluate(async u => (await chrome.tabs.query({})).find(t => (t.url || t.pendingUrl || "").startsWith(u))?.id ?? null, `https://${HOST}`);
    expect(employerTab).not.toBeNull();

    // Chrome is asked, with ITS access prompt for exactly this origin. XpertApply opens no window or page of its own.
    {
      await expect.poll(() => worker.evaluate(() => (globalThis as any).__hostAccess), { timeout: 20_000 })
        .toEqual([{ tabId: employerTab, pattern: `https://${HOST}/*` }]);
    }
    await new Promise(r => setTimeout(r, 1500));
    expect(await worker.evaluate(async () => (await chrome.windows.getAll()).length)).toBe(windowsBefore);
    expect(ctx.pages().filter(p => p.url().startsWith("chrome-extension://") && !p.url().includes("/access.html?welcome=1"))).toEqual([]);

    // No grant => no script in the employer page, and nothing about it went to the API.
    const view = await worker.evaluate(async id => ((await chrome.storage.session.get("viewStates")).viewStates ?? {})[String(id)], employerTab);
    expect(view.siteAccess).toBe("site_access_required");
    expect(view.fieldsDiscovered).toBe(0);
    const employerPage = ctx.pages().find(p => p.url().startsWith(`https://${HOST}`));
    if (employerPage) {
      await expect(employerPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);
      expect(await employerPage.inputValue("#first_name")).toBe("");
    }
    expect(api.filter(l => !l.startsWith("OPTIONS"))).toEqual([]);
    expect(await worker.evaluate(async o => chrome.permissions.contains({ origins: [o] }), `https://${HOST}/*`)).toBe(false);
  } finally {
    await ctx.close(); employer.close(); apiServer.close(); web.close();
  }
});
