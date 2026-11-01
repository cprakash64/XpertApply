import { expect, test, type Page } from "@playwright/test";
import { startHarness } from "./cws-prepub-harness";

/**
 * Toolbar first-use disclosure. The e2e build exposes the exact function
 * chrome.action.onClicked calls (showToolbarOverlay) as __xaToolbarClick,
 * because Playwright cannot press Chrome's toolbar button.
 *
 * Before Continue: only the static disclosure may be injected. content.js (the
 * engine that reads forms and page text) is not injected, discovery has not run,
 * and XpertApply's API has received nothing.
 */
const SENT = { text: "XASENT-PAGETEXT-4c2a", value: "XASENT-FIELDVALUE-8e1b" };
const html = `<!doctype html><meta charset="utf-8"><title>Apply</title><main><h1>Apply for Engineer</h1><p>${SENT.text}</p>
<form id="application"><label>First name <input id="first" name="first_name" autocomplete="given-name" value="${SENT.value}"></label>
<label>Email <input id="email" name="email" type="email" autocomplete="email"></label>
<label>Phone <input id="phone" name="phone" type="tel" autocomplete="tel"></label>
<button id="final-submit" type="submit">Submit application</button></form></main>`;
const HOST = "#xpertapply-toolbar-disclosure-v1";

async function inDisclosure<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable"); await cdp.send("Runtime.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: HOST });
    if (!nodeId) throw new Error("disclosure host absent");
    const { node } = await cdp.send("DOM.describeNode", { nodeId, pierce: true });
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: node.shadowRoots![0].backendNodeId });
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId!, functionDeclaration: fn, arguments: args.map(value => ({ value })), returnByValue: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as T;
  } finally { await cdp.detach(); }
}
async function trustedClick(page: Page, selector: string) {
  const r = await inDisclosure<{ x: number; y: number }>(page, `function(s){const r=this.querySelector(s).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}`, selector);
  await page.mouse.click(r.x, r.y);
}

async function setup() {
  const h = await startHarness({ html, prepared: true });
  await h.useOwnedApi();
  await h.worker.evaluate(() => {
    const g = globalThis as any; g.__xaInjected = [];
    const real = chrome.scripting.executeScript.bind(chrome.scripting);
    (chrome.scripting as any).executeScript = (inj: any) => { g.__xaInjected.push(...(inj.files ?? [])); return real(inj); };
  });
  await h.hookWorkerFetch();
  const page = await h.ctx.newPage();
  await page.goto(h.url);
  await h.seedPrepared();
  const click = () => h.worker.evaluate(async (u) => {
    const tab = (await chrome.tabs.query({})).find(t => t.url === u)!;
    return (globalThis as any).__xaToolbarClick(tab);
  }, h.url);
  const injected = () => h.worker.evaluate(() => (globalThis as any).__xaInjected as string[]);
  const marker = () => h.worker.evaluate(async () => (await chrome.storage.local.get("toolbarDisclosureAcceptedVersion")).toolbarDisclosureAcceptedVersion);
  const view = () => h.worker.evaluate(async () => (await chrome.storage.session.get("viewStates")).viewStates ?? {});
  return { h, page, click, injected, marker, view };
}

test("before Continue the page is not read and XpertApply receives nothing; Cancel leaves nothing behind", async () => {
  test.setTimeout(90_000);
  const { h, page, click, injected, marker, view } = await setup();
  try {
    expect(await marker()).toBeUndefined();
    expect(await click()).toBe(true);
    await expect(page.locator(HOST)).toHaveCount(1);
    await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);
    const text = await inDisclosure<string>(page, `function(){return this.querySelector('[role=dialog]').innerText}`);
    expect(text).toMatch(/temporarily access this tab/);
    expect(text).toMatch(/does not fill or submit/);
    expect(text).toMatch(/leave this site or close the tab/);
    await page.waitForTimeout(4000);
    // The read-capable engine was never loaded; only the static bootstrap was.
    expect(await injected()).toEqual(["overlayBootstrap.js"]);
    // Nothing reached XpertApply: no token exchange, no session, no answers, no events.
    expect(await h.workerFetches()).toEqual([]);
    expect(h.apiLog).toEqual([]);
    expect(h.fx.requests).toEqual([]);
    // No discovery: the worker holds no field counts for this tab.
    expect(JSON.stringify(Object.values(await view()))).not.toMatch(/"fieldsDiscovered":[1-9]/);

    await trustedClick(page, "[data-cancel]");
    await expect(page.locator(HOST)).toHaveCount(0);
    await page.waitForTimeout(3000);
    expect(await marker()).toBeUndefined();
    expect(await injected()).toEqual(["overlayBootstrap.js"]);
    expect(await h.workerFetches()).toEqual([]);
    expect(h.fx.requests).toEqual([]);
    await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);
  } finally { await h.close(); }
});

test("a synthetic (untrusted) click on Continue does nothing; a real click persists the version, then discovery runs", async () => {
  test.setTimeout(90_000);
  const { h, page, click, injected, marker } = await setup();
  try {
    await click();
    await expect(page.locator(HOST)).toHaveCount(1);
    // Page-side attempt: dispatching on the host reaches nothing inside a closed root.
    await page.evaluate(() => document.getElementById("xpertapply-toolbar-disclosure-v1")!.click());
    await page.waitForTimeout(1000);
    expect(await marker()).toBeUndefined();
    expect(await injected()).toEqual(["overlayBootstrap.js"]);

    await trustedClick(page, "[data-continue]");
    await expect.poll(marker).toBe(1);
    await expect(page.locator(HOST)).toHaveCount(0);
    await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    expect(await injected()).toEqual(["overlayBootstrap.js", "content.js"]);
    // Discovery now runs, and the form was never mutated.
    await expect.poll(() => h.worker.evaluate(async () => JSON.stringify((await chrome.storage.session.get("viewStates")).viewStates ?? {})), { timeout: 15_000 })
      .toMatch(/"fieldsDiscovered":[1-9]/);
    expect(await page.inputValue("#email")).toBe("");
    expect(await page.inputValue("#first")).toBe(SENT.value);
    // Even now, nothing about the page itself was transmitted.
    const everything = JSON.stringify({ f: await h.workerFetches(), a: h.apiLog });
    expect(everything).not.toContain(SENT.text);
    expect(everything).not.toContain(SENT.value);
  } finally { await h.close(); }
});

test("after acceptance the toolbar goes straight to discovery; a newer disclosure version re-prompts", async () => {
  test.setTimeout(90_000);
  const { h, page, click, injected } = await setup();
  try {
    await h.worker.evaluate(async () => chrome.storage.local.set({ toolbarDisclosureAcceptedVersion: 1 }));
    await click();
    await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    await expect(page.locator(HOST)).toHaveCount(0);
    expect(await injected()).toEqual(["overlayBootstrap.js", "content.js"]);
    // A stale (older) acceptance is not an acceptance of the current wording.
    // (No reload: a prepared launch's own content-script path would inject content.js on load.)
    await page.evaluate(() => document.getElementById("xpertapply-assistant-overlay-v1")?.remove());
    await h.worker.evaluate(async () => { (globalThis as any).__xaInjected.length = 0; await chrome.storage.local.set({ toolbarDisclosureAcceptedVersion: 0 }); });
    await click();
    await expect(page.locator(HOST)).toHaveCount(1);
    expect(await injected()).toEqual(["overlayBootstrap.js"]);
  } finally { await h.close(); }
});
