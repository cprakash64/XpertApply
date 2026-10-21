import { expect, test, type Request } from "@playwright/test";
import { startHarness } from "./cws-prepub-harness";
import fs from "node:fs";

/**
 * Toolbar-only network capture. Opens the assistant exactly as the toolbar
 * path does, requests NOTHING else (no fill, no resume, no tailoring, no
 * submit), observes for a bounded window and records every outbound request
 * the extension makes, three ways: the worker's fetch() (hooked), the owned
 * XpertApply API server's own log, and the browser's request events. Every
 * captured byte is scanned for sentinels planted in the page's URL, title,
 * text, labels, field values and typed content.
 */
const S = { title: "XASENT-TITLE-7f3a", text: "XASENT-TEXT-9c1d", label: "XASENT-LABEL-2b8e", value: "XASENT-VALUE-5d40", typed: "XASENT-TYPED-1e6f", query: "XASENT-QUERY-3a9b" };
const SENTINELS = Object.values(S);
const OBSERVE_MS = 8_000;

const html = (rich: boolean) => `<!doctype html><meta charset="utf-8"><title>${S.title}</title>
<main><h1>Apply for Engineer</h1><p>${S.text} We are hiring.</p><form id="application">
<label>${S.label} First name <input id="first" name="first_name" autocomplete="given-name" value="${S.value}"></label>
<label>Email <input id="email" name="email" type="email" autocomplete="email"></label>
<label>Phone <input id="phone" name="phone" type="tel" autocomplete="tel"></label>
${rich ? `<label>City <input id="city" name="city"></label><label>LinkedIn <input id="li" name="linkedin" type="url"></label>
<label>Why us? <textarea id="why" name="why"></textarea></label><label>Resume <input id="resume" type="file"></label>
<fieldset><legend>Authorized to work?</legend><label><input type="radio" name="a" value="Yes"> Yes</label><label><input type="radio" name="a" value="No"> No</label></fieldset>` : ""}
<button id="final-submit" type="submit">Submit application</button></form></main>`;

type Scenario = { name: string; prepared: boolean; rich: boolean; typed: boolean };
const SCENARIOS: Scenario[] = [
  { name: "A logged out (no launch, default API base)", prepared: false, rich: false, typed: false },
  { name: "B logged in (prepared launch + session package)", prepared: true, rich: false, typed: false },
  { name: "C application form with typed user content (prepared)", prepared: true, rich: true, typed: true }
];
const results: unknown[] = [];

for (const sc of SCENARIOS) {
  test(`toolbar-only network capture: ${sc.name}`, async () => {
    test.setTimeout(120_000);
    const h = await startHarness({ html: html(sc.rich), prepared: sc.prepared });
    const browserRequests: { url: string; type: string; fromWorker: boolean }[] = [];
    const failed: string[] = [];
    h.ctx.on("request", (r: Request) => browserRequests.push({ url: r.url(), type: r.resourceType(), fromWorker: r.serviceWorker() != null }));
    h.ctx.on("requestfailed", (r: Request) => failed.push(r.url()));
    try {
      if (sc.prepared) await h.useOwnedApi();
      await h.hookWorkerFetch();
      const page = await h.ctx.newPage();
      await page.goto(`${h.url}?q=${S.query}`);
      if (sc.prepared) await h.seedPrepared();
      if (sc.typed) await page.locator("#city").pressSequentially(S.typed);
      await page.waitForTimeout(500);
      // ---- clear network log, then the toolbar path ----
      const mark = browserRequests.length;
      h.apiLog.length = 0;
      const apiMark = h.fx.requests.length;
      await h.worker.evaluate(() => { (globalThis as any).__xaFetchLog.length = 0; });
      const overlay = await h.toolbarClick(page);
      expect(await overlay.hostCount()).toBe(1);
      await page.waitForTimeout(OBSERVE_MS);

      const workerFetches = await h.workerFetches();
      const apiServer = h.fx.requests.slice(apiMark);
      const after = browserRequests.slice(mark);
      const classify = (u: string) => {
        const url = new URL(u);
        if (url.protocol === "chrome-extension:") return "extension-internal";
        if (url.origin === new URL(h.url).origin) return h.apiLog.some(a => a.path === url.pathname) || url.pathname.startsWith("/application-sessions/") ? "xpertapply-api(owned)" : "page-owned";
        if (/(^|\.)xpertapply\.com$/.test(url.hostname)) return "xpertapply-api(production host)";
        return "third-party";
      };
      const everything = JSON.stringify({ workerFetches, api: h.apiLog, after });
      const leaked = SENTINELS.filter(s => everything.includes(s));
      const record = {
        scenario: sc.name,
        workerFetches: workerFetches.map(f => ({ ...f, body: f.body ? `[${f.body.length} bytes]` : null, class: classify(f.url) })),
        apiServerRequests: h.apiLog.map(a => ({ method: a.method, path: a.path, bodyBytes: a.body?.length ?? 0 })),
        apiServerRequestCount: apiServer.length,
        browserRequests: after.map(r => ({ ...r, class: classify(r.url) })),
        failedRequests: failed,
        sentinelsFoundInAnyOutboundData: leaked
      };
      results.push(record);
      console.log("NETCAPTURE " + JSON.stringify(record));
      fs.mkdirSync("test-results", { recursive: true });
      fs.writeFileSync(`test-results/cws-netcapture-${sc.name.slice(0, 1)}.json`, JSON.stringify(record, null, 2));
      expect(leaked, "page URL/title/text/labels/values/typed content must not leave the device on toolbar open").toEqual([]);
    } finally { await h.close(); }
  });
}
