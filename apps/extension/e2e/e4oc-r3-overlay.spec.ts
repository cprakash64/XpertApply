import { expect, test, chromium, type Page } from "@playwright/test";
import { OwnedPackageFixture } from "./owned-package-fixture";
import { containSyntheticNetwork } from "./network-containment";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const DIST = process.env.XA_E2E_DIST ?? path.resolve("dist-e2e-granted");
const IDLE_MS = 60_000;


const fixture = `<!doctype html><meta charset="utf-8"><title>SmartRecruiters-shaped application</title>
<style>main{min-height:1800px}label{display:block}</style><main><h1>Apply for Software Engineer</h1><form id="application">
<label>First name <input id="first" name="first_name" autocomplete="given-name"></label>
<label>Last name <input id="last" name="last_name" autocomplete="family-name"></label>
<label>Email <input id="email" name="email" type="email" autocomplete="email"></label>
<label>Phone <input id="phone" name="phone" type="tel" autocomplete="tel"></label>
<label>City <input id="city" name="city" autocomplete="address-level2"></label>
<label>LinkedIn profile <input id="linkedin" name="linkedin_url" type="url"></label>
<label>Country <select id="country" name="country"><option value="">Choose</option><option>United States</option><option>Canada</option></select></label>
<fieldset><legend>Are you authorized to work in the United States?</legend><label><input id="authorized" type="radio" name="authorized" value="Yes"> Yes</label><label><input type="radio" name="authorized" value="No"> No</label></fieldset>
<label><input id="privacy" type="checkbox" name="privacy"> I agree to the candidate privacy policy</label>
<label>Why do you want to join us? <textarea id="motivation" name="motivation"></textarea></label>
<button id="final-submit" type="submit">Submit application</button>
</form></main><script>
window.__acceptance={submits:0,inputs:0,changes:0};
document.addEventListener('input',()=>window.__acceptance.inputs++,true);
document.addEventListener('change',()=>window.__acceptance.changes++,true);
document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.__acceptance.submits++});
</script>`;

const answer = (canonical_key: string, value: string) => ({
  canonical_key, value, display_value: value, source: "profile", confidence: 1,
  sensitive: false, requires_review: false, verified: true
});

async function formValues(page: Page) {
  return page.evaluate(() => Object.fromEntries(
    Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea"))
      .map((el) => [el.id || `${el.name}:${el.getAttribute("value")}`, el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.checked : el.value])
  ));
}

test("E4O-C-R3 first-party Web bridge replies to replayable correlated presence pings", async () => {
  test.setTimeout(45_000);
  const PROFILE = fs.mkdtempSync(path.join(tmpdir(), "xpertapply-overlay-"));
  // This bridge spec owns the supported first-party fixture, not a manual Web process.
  // Binding failure is explicit; never reuse or kill an unrelated listener or use3001.
  const server = createServer((_req,res) => {
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    res.end("<!doctype html><title>XpertApply bridge fixture</title><main>First-party bridge fixture</main>");
  });
  const employerFixture = await new OwnedPackageFixture(fixture).start();
  const applicationUrl = employerFixture.origin + "/apply";
  const session = {session_id:3001,ats_type:null,official_application_url:applicationUrl,job:{title:"Synthetic Engineer",company:"Synthetic Employer"},resume:{status:"ready",document_id:null,download_url:null},cover_letter:{status:"not_requested",document_id:null,download_url:null},profile:{},answers:[],unresolved_questions:[]};
  await employerFixture.route("**/application-sessions/token",r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({session_token:employerFixture.sessionToken,session})}));
  await employerFixture.route("**/application-sessions/3001",r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(session)}));
  await employerFixture.route("**/application-sessions/3001/answers",r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({answers:[],unresolved_questions:[],refreshed:false})}));
  for(const endpoint of ["answers/override","resolve-questions","events","autofill-results"])await employerFixture.route("**/application-sessions/3001/"+endpoint,r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(endpoint==="answers/override"?{overrides:[]}:endpoint==="resolve-questions"?{request_schema_version:3,answer_contract_version:3,registry_version:"fixture",results:[]}:{})}));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    await new Promise<void>((resolve,reject) => {
      server.once("error",error => reject(new Error(`First-party fixture must own localhost:3000: ${error.message}`)));
      server.listen(3000,"127.0.0.1",resolve);
    });
    const ready = await fetch("http://127.0.0.1:3000");
    if(!ready.ok) throw new Error("Owned first-party fixture readiness failed");
    context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium", headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow", viewport: { width: 1280, height: 900 }
  });
    const network = await containSyntheticNetwork(context);
    const page = await context.newPage();
    await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
    const ping = () => page.evaluate(() => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = window.setTimeout(() => reject(new Error("presence timeout")), 3_000);
      const onMessage = (event: MessageEvent) => {
        const data = event.data as any;
        if (event.source !== window || event.origin !== location.origin || data?.source !== "jobpilot-extension"
          || data?.type !== "XPERTAPPLY_EXTENSION_PRESENCE_READY" || data?.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener("message", onMessage); resolve(data.info);
      };
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "jobpilot-web", type: "XPERTAPPLY_EXTENSION_PRESENCE_PING", requestId }, location.origin);
    }));
    const first = await ping();
    const second = await ping();
    expect(first).toMatchObject({ installed: true, protocolVersion: 3 });
    expect(second).toEqual(first);
    await page.reload({ waitUntil: "domcontentloaded" });
    const afterReload = await ping();
    expect(afterReload).toEqual(first);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await worker.evaluate(async base=>chrome.storage.local.set({apiBase:base}),employerFixture.origin);
    await page.evaluate(({url,base})=>window.postMessage({source:"jobpilot-web",type:"JOBPILOT_STAGE_LAUNCH",payload:{requestId:"presence-prepared",launchToken:"synthetic-presence-launch",sessionId:3001,jobId:3001,officialUrl:url,atsType:null,webApiBase:base,webAuthenticatedUserId:3001}},location.origin),{url:applicationUrl,base:employerFixture.origin});
    await expect.poll(()=>worker.evaluate(async()=>(await chrome.storage.session.get("activeAssistedApplyHandoffV1")).activeAssistedApplyHandoffV1?.sessionId)).toBe(3001);
    const employer = await context.newPage();await employer.goto(applicationUrl);
    await expect.poll(()=>worker.evaluate(async url=>{const tab=(await chrome.tabs.query({url}))[0];if(!tab?.id)return false;return !!(await chrome.storage.session.get("sessionPackages")).sessionPackages?.[String(tab.id)];},applicationUrl)).toBe(true);
    await expect(employer.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);
    const overlay = await CanonicalOverlayDriver.openFromToolbar(employer,worker);
    expect(await overlay.hostCount()).toBe(1);
    await expect(employer.locator("#privacy")).not.toBeChecked();
    expect(await employer.evaluate(()=>(window as any).__acceptance.submits)).toBe(0);
    network.assertContained();



  } finally {
    await context?.close();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    server.closeAllConnections();
    if(server.listening) await new Promise<void>(resolve => server.close(()=>resolve()));
    await employerFixture.close();
  }
});

test("E4O-C-R3 canonical toolbar overlay discovers then explicitly fills the real DOM", async () => {
  // The qualification deliberately includes a full 60-second idle interval,
  // a physical worker stop, and browser viewport/zoom matrices.
  test.setTimeout(360_000);
  const PROFILE = fs.mkdtempSync(path.join(tmpdir(), "xpertapply-overlay-"));
  const apiFixture = await new OwnedPackageFixture(fixture).start();
  const applicationUrl = apiFixture.origin + "/apply";
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium", headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow", viewport: { width: 1280, height: 900 }
  });
  const network = await containSyntheticNetwork(context);

  try {
    const sessionBody = {
      session_id: 3003, ats_type: "smartrecruiters", official_application_url: applicationUrl,
      job: { title: "Software Engineer", company: "Synthetic Employer", location: "Phoenix, Arizona" },
      resume: { status: "ready", document_id: null, download_url: null },
      cover_letter: { status: "not_requested", document_id: null, download_url: null },
      profile: { first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "+16025550199", location: "Phoenix, Arizona, United States", linkedin_url: "https://www.linkedin.com/in/riley-candidate" }
    };
    const answers = [
      answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test"),
      answer("phone", "+16025550199"), answer("city", "Phoenix"), answer("location", "Phoenix, Arizona, United States"),
      answer("linkedin_url", "https://www.linkedin.com/in/riley-candidate"), answer("country", "United States"),
      answer("work_authorization_us", "Yes"), answer("privacy_policy_acknowledgement", "Yes")
    ];
    await apiFixture.route("**/application-sessions/token", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: apiFixture.sessionToken, session: sessionBody }) }));
    await apiFixture.route("**/application-sessions/3003/answers", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers, unresolved_questions: [{ canonical_key: "custom_motivation", reason: "answer_on_employer_page" }], refreshed: false, profile_revision: "r3" }) }));
    await apiFixture.route("**/application-sessions/3003", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) }));

    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    await worker.evaluate(async base => chrome.storage.local.set({apiBase:base}), apiFixture.origin);
    for (const endpoint of ["answers/override", "resolve-questions", "events", "autofill-results"]) {
      await apiFixture.route("**/application-sessions/3003/" + endpoint, route => route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(endpoint === "answers/override" ? {overrides:[]} : endpoint === "resolve-questions" ? {request_schema_version:3,answer_contract_version:3,registry_version:"fixture",results:[]} : {})}));
    }

    const extensionId = new URL(worker.url()).host;
    const swErrors: string[] = [];
    worker.on("console", (message) => { if (message.type() === "error") swErrors.push(message.text().slice(0, 300)); });
    const page = await context.newPage();
    let idleNetworkRequests = 0;
    let measuringIdle = false;
    context.on("request", () => { if (measuringIdle) idleNetworkRequests += 1; });
    await page.goto(applicationUrl);

    await page.evaluate(() => {
      (window as any).__e4odFormMutations = 0;
      new MutationObserver((records) => { (window as any).__e4odFormMutations += records.length; })
        .observe(document.querySelector("form")!, { subtree: true, attributes: true, childList: true, characterData: true });
    });
    const before = await formValues(page);
    const tabId = await worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url: `${new URL(url).origin}/*` });
      return tabs[0]?.id;
    }, applicationUrl);
    expect(tabId).toBeTruthy();

    // Observe the extension isolated world, which survives worker termination.
    // These hooks are test-only and never enter shipping bundles.
    const installMetrics = () => worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, func: () => {
        const world = globalThis as any;
        const metrics = world.__e4odQualification = {
          messages: {} as Record<string, number>, events: 0, documentQueries: 0,
          notifications: new Set<Function>(), lifecycle: new Map<string, Set<Function>>(), timers: new Set<number>()
        };
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        (chrome.runtime as any).sendMessage = (...args: any[]) => {
          const type = args[0]?.type;
          if (typeof type === "string") metrics.messages[type] = (metrics.messages[type] ?? 0) + 1;
          return (send as any)(...args);
        };
        const add = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
        const remove = chrome.runtime.onMessage.removeListener.bind(chrome.runtime.onMessage);
        chrome.runtime.onMessage.addListener = (listener) => {
          if (listener.toString().includes(".OVERLAY_VIEW_CHANGED")) metrics.notifications.add(listener);
          add(listener);
        };
        chrome.runtime.onMessage.removeListener = (listener) => { metrics.notifications.delete(listener); remove(listener); };
        add((message) => { if (message?.type === "XPERTAPPLY_OVERLAY_VIEW_CHANGED") metrics.events += 1; });
        const addEvent = EventTarget.prototype.addEventListener;
        const removeEvent = EventTarget.prototype.removeEventListener;
        EventTarget.prototype.addEventListener = function(type, callback, options) {
          if ((this === window || this === document) && typeof callback === "function"
            && ["focus", "pageshow", "visibilitychange"].includes(type)
            && ["recover", "onVisibilityChange"].includes(callback.name)) {
            if (!metrics.lifecycle.has(type)) metrics.lifecycle.set(type, new Set());
            metrics.lifecycle.get(type)!.add(callback);
          }
          return addEvent.call(this, type, callback, options);
        };
        EventTarget.prototype.removeEventListener = function(type, callback, options) {
          if (typeof callback === "function") metrics.lifecycle.get(type)?.delete(callback);
          return removeEvent.call(this, type, callback, options);
        };
        const interval = window.setInterval.bind(window);
        const clear = window.clearInterval.bind(window);
        window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
          const timer = interval(handler, timeout, ...args);
          if (timeout === 1000) metrics.timers.add(timer);
          return timer;
        }) as typeof window.setInterval;
        window.clearInterval = (timer) => { if (timer != null) metrics.timers.delete(timer as number); clear(timer); };
        const queryOne = document.querySelector.bind(document);
        document.querySelector = ((selector: string) => { metrics.documentQueries += 1; return queryOne(selector); }) as typeof document.querySelector;
        const elementQuery = Element.prototype.querySelectorAll;
        Element.prototype.querySelectorAll = (function(this: Element, selector: string) {
          if (this.getRootNode() === document) metrics.documentQueries += 1;
          return elementQuery.call(this, selector);
        }) as typeof Element.prototype.querySelectorAll;
        const query = document.querySelectorAll.bind(document);
        document.querySelectorAll = ((selector: string) => { metrics.documentQueries += 1; return query(selector); }) as typeof document.querySelectorAll;
      }});
    }, tabId);
    await installMetrics();
    const metricsFor = async () => worker.evaluate(async (id) => {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, func: () => {
        const m = (globalThis as any).__e4odQualification;
        return m ? { messages: { ...m.messages }, events: m.events, documentQueries: m.documentQueries,
          notificationListeners: m.notifications.size, lifecycleListeners: Array.from(m.lifecycle.values() as Iterable<Set<Function>>).reduce((sum, callbacks) => sum + callbacks.size, 0), periodicViewTimers: m.timers.size } : null;
      }});
      return result.result;
    }, tabId);

    await worker.evaluate(() => {
      const state = globalThis as typeof globalThis & { __e4odMessages?: { context: number; view: number } };
      state.__e4odMessages = { context: 0, view: 0 };
      chrome.runtime.onMessage.addListener((message) => {
        if (!state.__e4odMessages) return;
        if (message?.type === "XPERTAPPLY_OVERLAY_GET_CONTEXT") state.__e4odMessages.context += 1;
        if (message?.type === "XPERTAPPLY_OVERLAY_GET_VIEW") state.__e4odMessages.view += 1;
      });
    });
    await worker.evaluate(async ([id, url]) => {
      const now = Date.now();
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "e4oc-r3", jobId: "3003", applicationUrl: url, status: "prepared",
        handoffToken: "sanitized-handoff", requestId: "e4oc-r3", sessionId: 3003, launchToken: "sanitized-launch",
        officialUrl: url, expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: "smartrecruiters"
      }});
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["overlayBootstrap.js"] });
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["content.js"] });
      await chrome.tabs.sendMessage(id!, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 });
    }, [tabId, applicationUrl] as const);





    await page.waitForFunction(() => {
      const root = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.shadowRoot;
      return root && Number(root.getElementById("discovered")?.textContent) > 0 && root.getElementById("ats")?.textContent !== "Detecting…";
    }, undefined, { timeout: 20_000 });

    const hostCount = await page.locator("#xpertapply-assistant-overlay-v1").count();
    expect(hostCount).toBe(1);
    const afterOpen = await formValues(page);
    expect(afterOpen).toEqual(before);
    const beforeFillMutationCount = await page.evaluate(() => (window as any).__e4odFormMutations);
    expect(beforeFillMutationCount).toBe(0);

    const overlay = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!;
      const root = host.shadowRoot!;
      const panel = root.querySelector<HTMLElement>("[data-overlay-panel]")!;
      const style = getComputedStyle(panel);
      return { text: root.textContent ?? "", discovered: Number(root.getElementById("discovered")?.textContent), ats: root.getElementById("ats")?.textContent, right: style.right, bottom: style.bottom, top: style.top, borderRadius: style.borderRadius, backdropFilter: style.backdropFilter, boxShadow: style.boxShadow, background: style.backgroundColor };
    });
    expect(overlay.discovered).toBeGreaterThan(0);
    expect(overlay.ats).not.toBe("Detecting…");
    expect(overlay.right).toBe("18px"); expect(overlay.bottom).toBe("18px");
    // Chromium reports the used top coordinate for a bottom-anchored fixed
    // element; the authored CSS gate above is covered by the focused unit test.
    expect(Number.parseFloat(overlay.top)).toBeGreaterThan(0);
    expect(overlay.borderRadius).toBe("24px"); expect(overlay.backdropFilter).toContain("blur");
    expect(overlay.text).not.toMatch(/Diagnostics|overlayBuild|builtAt|protocol|tabId|documentId|contentReady|packageLoaded|lastFailure|HANDOFF_NOT_FOUND|OVERLAY_DOCUMENT_STALE|Install extension/i);



    await worker.evaluate(() => {
      const state = globalThis as typeof globalThis & { __e4odMessages?: { context: number; view: number } };
      if (state.__e4odMessages) state.__e4odMessages = { context: 0, view: 0 };
    });
    const idleMetricsBefore = await metricsFor();
    const idleFormBefore = await formValues(page);
    const idleMutationBefore = await page.evaluate(() => (window as any).__e4odFormMutations);
    measuringIdle = true;
    await page.waitForTimeout(IDLE_MS);
    measuringIdle = false;
    const idleMessages = await worker.evaluate(() => {
      const state = globalThis as typeof globalThis & { __e4odMessages?: { context: number; view: number } };
      return state.__e4odMessages ?? { context: -1, view: -1 };
    });
    const idleMetricsAfter = await metricsFor();
    expect(await formValues(page)).toEqual(idleFormBefore);
    const idleFormMutationCount = await page.evaluate(() => (window as any).__e4odFormMutations) - idleMutationBefore;
    expect(idleFormMutationCount).toBe(0);
    const idleDiscoveryQueries = idleMetricsAfter!.documentQueries - idleMetricsBefore!.documentQueries;
    expect(idleDiscoveryQueries).toBe(0);
    expect(idleMessages).toEqual({ context: 0, view: 0 });
    expect(idleNetworkRequests).toBe(0);


    {
      await worker.evaluate(async (id) => {
        const emittedAt = Date.now();
        const stored = await chrome.storage.session.get("viewStates");
        const views = (stored.viewStates ?? {}) as Record<string, Record<string, unknown>>;
        views[String(id)] = { ...views[String(id)], jobTitle: `Event latency marker ${emittedAt}`, updatedAt: emittedAt };
        await chrome.storage.session.set({ viewStates: views });
        return emittedAt;
      }, tabId);
      await page.waitForFunction(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.shadowRoot?.getElementById("job")?.textContent?.includes("Event latency marker"));
    }




    {

      const internals = await context.newPage();
      await internals.goto("chrome://serviceworker-internals");
      const registration = internals.locator(".serviceworker-registration").filter({ hasText: extensionId });
      await expect(registration).toHaveCount(1);
      await registration.getByRole("button", { name: "Stop" }).click();
      await expect.poll(async () => (await registration.innerText()).toLowerCase()).toContain("stopped");
      await internals.close();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(async () => {
        const candidate = context.serviceWorkers().find((item) => item.url().includes("background.js"));
        if (!candidate) return false;
        return candidate.evaluate(() => true).catch(() => false);
      }, { timeout: 15_000 }).toBe(true);
      worker = context.serviceWorkers().find((item) => item.url().includes("background.js"))!;
      // The R3 startup broadcast independently re-registers the surviving
      // content frame and emits bounded authoritative view transitions. Wait
      // for those messages to settle before measuring a separate duplicate
      // focus pair; otherwise startup invalidations pollute that measurement.
      let previousRecoveryCounts = "";
      let stableRecoverySamples = 0;
      await expect.poll(async () => {
        const metrics = await metricsFor();
        const current = JSON.stringify(metrics?.messages);
        stableRecoverySamples = current === previousRecoveryCounts ? stableRecoverySamples + 1 : 0;
        previousRecoveryCounts = current;
        return stableRecoverySamples;
      }, { intervals: [100], timeout: 5_000 }).toBeGreaterThanOrEqual(3);
      await worker.evaluate(() => {
        const state = globalThis as typeof globalThis & { __e4odRecovery?: { context: number; view: number } };
        state.__e4odRecovery = { context: 0, view: 0 };
        chrome.runtime.onMessage.addListener((message) => {
          if (!state.__e4odRecovery) return;
          if (message?.type === "XPERTAPPLY_OVERLAY_GET_CONTEXT") state.__e4odRecovery.context += 1;
          if (message?.type === "XPERTAPPLY_OVERLAY_GET_VIEW") state.__e4odRecovery.view += 1;
        });
      });
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("focus"));
      });
      const readRecoveryMessages = () => worker.evaluate(() => {
        const state = globalThis as typeof globalThis & { __e4odRecovery?: { context: number; view: number } };
        return state.__e4odRecovery ?? { context: -1, view: -1 };
      });
      await expect.poll(readRecoveryMessages, { timeout: 5_000 }).toEqual({ context: 1, view: 1 });
      // Handler entry counts precede asynchronous responses and rendering.
      await expect(page.locator("#fill")).toBeEnabled();
      const postRestart = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1");
        const root = host?.shadowRoot;
        return { hostCount: document.querySelectorAll("#xpertapply-assistant-overlay-v1").length,
          state: host?.dataset.overlayState, discovered: Number(root?.getElementById("discovered")?.textContent),
          fillDisabled: (root?.getElementById("fill") as HTMLButtonElement | null)?.disabled };
      });
      expect(postRestart).toMatchObject({ hostCount: 1, state: "open", discovered: 10, fillDisabled: false });
      const restartMetricsAfter = await metricsFor();
      expect.soft(restartMetricsAfter!.notificationListeners).toBe(1);
      expect(restartMetricsAfter!.periodicViewTimers).toBe(0);

    }

    await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.getElementById("fill") as HTMLButtonElement).click());

    await page.waitForFunction(() => document.querySelector<HTMLInputElement>("#first")?.value === "Riley");
    const afterFill = await formValues(page);
    expect(afterFill).toMatchObject({ first: "Riley", last: "Candidate", email: "riley@example.test", phone: "+16025550199", city: "Phoenix", linkedin: "https://www.linkedin.com/in/riley-candidate", country: "United States", authorized: true, privacy: false, motivation: "" });
    expect(await page.evaluate(() => (window as any).__acceptance.submits)).toBe(0);

    await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector("[data-overlay-minimize]") as HTMLButtonElement).click());
    expect(await page.evaluate(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.dataset.overlayState)).toBe("minimized");
    await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector("[data-overlay-restore]") as HTMLButtonElement).click());
    expect(await page.evaluate(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.dataset.overlayState)).toBe("open");
    await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector("[data-overlay-close]") as HTMLButtonElement).click());
    expect(await page.locator("#xpertapply-assistant-overlay-v1").count()).toBe(0);

    // Explicit action reopens the same document; passive workflow updates do not.
    await worker.evaluate(async (id) => { await chrome.tabs.sendMessage(id!, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 }); }, tabId);
    expect(await page.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);

    for (const width of [340, 375, 400, 420]) {
      await page.setViewportSize({ width, height: 720 });
      const bounds = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector<HTMLElement>("[data-overlay-panel]")!;
        const box = panel.getBoundingClientRect();
        return { left: box.left, right: box.right, viewport: innerWidth, bodyOverflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.viewport); expect(bounds.bodyOverflow).toBe(false);
    }

    for (const height of [500, 600, 700, 900]) {
      await page.setViewportSize({ width: 1280, height });
      const result = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!;
        const panel = root.querySelector<HTMLElement>("[data-overlay-panel]")!;
        const body = root.querySelector<HTMLElement>(".body")!;
        const box = panel.getBoundingClientRect();
        return { top: box.top, bottomGap: innerHeight - box.bottom, panelHeight: box.height,
          headerVisible: Boolean(root.querySelector(".header")), closeVisible: Boolean(root.querySelector("[data-overlay-close]")),
          minimizeVisible: Boolean(root.querySelector("[data-overlay-minimize]")), bodyScrolls: body.scrollHeight > body.clientHeight,
          pageScrollable: document.documentElement.scrollHeight >= document.documentElement.clientHeight };
      });
      expect(result.top).toBeGreaterThanOrEqual(0);
      expect(result.bottomGap).toBeGreaterThanOrEqual(0);
      expect(result.closeVisible).toBe(true); expect(result.minimizeVisible).toBe(true);
      expect(result.bottomGap).toBe(18);
      const fill = page.locator("#xpertapply-assistant-overlay-v1").locator("#fill");
      await fill.scrollIntoViewIfNeeded();
      await expect(fill).toBeInViewport();
      await expect(page.locator("[data-overlay-close]")).toBeInViewport();
      await expect(page.locator("[data-overlay-minimize]")).toBeInViewport();
      await page.evaluate(() => window.scrollTo(0, 100));
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      await page.evaluate(() => window.scrollTo(0, 0));


    }


    for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
      await worker.evaluate(async ([id, factor]) => chrome.tabs.setZoom(id!, factor), [tabId, zoom] as const);
      await page.waitForTimeout(150);
      const result = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!;
        const panel = root.querySelector<HTMLElement>("[data-overlay-panel]")!;
        const box = panel.getBoundingClientRect();
        return { left: box.left, right: box.right, viewport: innerWidth,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          closeVisible: Boolean(root.querySelector("[data-overlay-close]")), minimizeVisible: Boolean(root.querySelector("[data-overlay-minimize]")),
          fillVisible: Boolean(root.getElementById("fill")) };
      });
      expect(result.left).toBeGreaterThanOrEqual(0); expect(result.right).toBeLessThanOrEqual(result.viewport);
      expect(result.horizontalOverflow).toBe(false); expect(result.closeVisible).toBe(true); expect(result.minimizeVisible).toBe(true);
      expect(await worker.evaluate(async (id) => chrome.tabs.getZoom(id!), tabId)).toBeCloseTo(zoom);
      const fill = page.locator("#fill");
      await fill.scrollIntoViewIfNeeded();
      await expect(fill).toBeInViewport();
      await page.locator("[data-overlay-minimize]").click();
      await expect(page.locator("[data-overlay-restore]")).toBeInViewport();
      await page.locator("[data-overlay-restore]").click();
      await page.locator("[data-overlay-close]").click();
      await worker.evaluate(async (id) => chrome.tabs.sendMessage(id!, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 }), tabId);

    }


    await worker.evaluate(async (id) => chrome.tabs.setZoom(id!, 1), tabId);

    for (const mode of ["forced-colors", "reduced-motion"]) {
      await page.emulateMedia(mode === "forced-colors" ? { forcedColors: "active" } : { forcedColors: "none", reducedMotion: "reduce" });
      await page.locator("[data-overlay-minimize]").focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-overlay-restore]")).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-overlay-close]")).toBeInViewport();

    }
    await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    await page.locator("#first").focus();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("first");

    await page.reload();
    const reloadHostCount = await page.locator("#xpertapply-assistant-overlay-v1").count();
    // Preserve this failure while allowing independent gates to finish.
    expect.soft(reloadHostCount, "reload must not auto-open").toBe(0);
    // Registration can precede presentation creation. Wait for this new
    // document's workflow facade, without relying on the old tab view state.
    await expect.poll(() => worker.evaluate(async (id) => {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, func: () => {
        const world = globalThis as typeof globalThis & { __xpertapplyOverlayWorkflowSurfacesV1__?: WeakMap<Document, HTMLElement> };
        return world.__xpertapplyOverlayWorkflowSurfacesV1__?.has(document) ?? false;
      }});
      return result.result;
    }, tabId)).toBe(true);
    expect(await page.locator("#xpertapply-assistant-overlay-v1").count(), "passive workflow startup must not open after reload").toBe(0);
    await installMetrics();
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["overlayBootstrap.js"] });
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["content.js"] });
      await chrome.tabs.sendMessage(id!, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 });
    }, tabId);
    expect(await page.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);

    const pageBPromise = context.waitForEvent("page");
    const windowB = await worker.evaluate(async (url) => chrome.windows.create({ url: `${url}?window=b`, type: "normal", focused: false }), applicationUrl);
    const pageB = await pageBPromise;
    await pageB.waitForLoadState("domcontentloaded");
    const tabB = windowB.tabs?.[0]?.id;
    expect(tabB).toBeTruthy();
    const windowAuthority = await worker.evaluate(async ([a, b]) => {
      const [tabA, tabB] = await Promise.all([chrome.tabs.get(a!), chrome.tabs.get(b!)]);
      const [windowA, windowB] = await Promise.all([chrome.windows.get(tabA.windowId), chrome.windows.get(tabB.windowId)]);
      return { a: { id: windowA.id, type: windowA.type }, b: { id: windowB.id, type: windowB.type } };
    }, [tabId, tabB] as const);
    expect(windowAuthority.a.type).toBe("normal"); expect(windowAuthority.b.type).toBe("normal");
    expect(windowAuthority.a.id).not.toBe(windowAuthority.b.id);
    await worker.evaluate(async ([id, url]) => {
      const now = Date.now();
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: { version: 1, applicationId: "e4oc-r3-b", jobId: "3003", applicationUrl: url, status: "prepared", handoffToken: "sanitized-handoff-b", requestId: "e4oc-r3-b", sessionId: 3003, launchToken: "sanitized-launch-b", officialUrl: url, expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900_000, state: "waiting_for_content_script", protocolVersion: 3, atsType: "smartrecruiters" }});
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["overlayBootstrap.js"] });
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["content.js"] });
      await chrome.tabs.sendMessage(id!, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 });
    }, [tabB, applicationUrl] as const);
    expect(await pageB.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);

    await worker.evaluate(() => {
      const state = globalThis as typeof globalThis & { __e4odWindowMessages?: Record<string, number> };
      state.__e4odWindowMessages = {};
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message?.type !== "XPERTAPPLY_OVERLAY_GET_VIEW" || sender.tab?.id == null || !state.__e4odWindowMessages) return;
        const key = String(sender.tab.id);
        state.__e4odWindowMessages[key] = (state.__e4odWindowMessages[key] ?? 0) + 1;
      });
    });
    const jobsBeforeCrossWindow = await Promise.all([page, pageB].map((target) => target.evaluate(() =>
      document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.shadowRoot?.getElementById("job")?.textContent ?? ""
    )));
    await pageB.waitForTimeout(300);
    await worker.evaluate(() => {
      const state = globalThis as typeof globalThis & { __e4odWindowMessages?: Record<string, number> };
      state.__e4odWindowMessages = {};
    });
    await worker.evaluate(async ([id, marker]) => {
      const stored = await chrome.storage.session.get("viewStates");
      const views = (stored.viewStates ?? {}) as Record<string, Record<string, unknown>>;
      views[String(id)] = { ...views[String(id)], jobTitle: marker, updatedAt: Date.now() };
      await chrome.storage.session.set({ viewStates: views });
    }, [tabId, "Window A authority marker"] as const);
    await page.waitForTimeout(500);
    const windowADiagnostic = await page.evaluate(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.shadowRoot?.getElementById("job")?.textContent ?? "");
    const afterAInvalidation = await worker.evaluate(() => (globalThis as typeof globalThis & { __e4odWindowMessages?: Record<string, number> }).__e4odWindowMessages ?? {});

    expect(windowADiagnostic).toContain("Window A authority marker");
    expect(await pageB.evaluate(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.shadowRoot?.getElementById("job")?.textContent ?? "")).toBe(jobsBeforeCrossWindow[1]);
    expect(afterAInvalidation[String(tabB)] ?? 0).toBe(0);

    await worker.evaluate(async ([id, marker]) => {
      const stored = await chrome.storage.session.get("viewStates");
      const views = (stored.viewStates ?? {}) as Record<string, Record<string, unknown>>;
      views[String(id)] = { ...views[String(id)], jobTitle: marker, updatedAt: Date.now() };
      await chrome.storage.session.set({ viewStates: views });
    }, [tabB, "Window B authority marker"] as const);
    await pageB.waitForFunction(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.shadowRoot?.getElementById("job")?.textContent?.includes("Window B authority marker"));
    expect(await page.evaluate(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.shadowRoot?.getElementById("job")?.textContent)).toContain("Window A authority marker");
    const afterBInvalidation = await worker.evaluate(() => (globalThis as typeof globalThis & { __e4odWindowMessages?: Record<string, number> }).__e4odWindowMessages ?? {});
    expect(afterBInvalidation[String(tabId)] ?? 0).toBe(afterAInvalidation[String(tabId)] ?? 0);
    await worker.evaluate(async ([a, b]) => {
      const tabs = await chrome.tabs.get(a!);
      await chrome.windows.update(tabs.windowId, { focused: true });
      const other = await chrome.tabs.get(b!);
      await chrome.windows.update(other.windowId, { focused: true });
    }, [tabId, tabB] as const);
    await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector("[data-overlay-minimize]") as HTMLButtonElement).click());
    expect(await pageB.evaluate(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.dataset.overlayState)).toBe("open");
    await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector("[data-overlay-close]") as HTMLButtonElement).click());
    expect(await pageB.evaluate(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.dataset.overlayState)).toBe("open");
    await worker.evaluate(async (id) => { await chrome.tabs.sendMessage(id!, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 }); }, tabId);
    await pageB.close();

    const structuralSamples: unknown[] = [];
    for (let cycle = 0; cycle < 20; cycle += 1) {
      await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector("[data-overlay-minimize]") as HTMLButtonElement).click());
      await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector("[data-overlay-restore]") as HTMLButtonElement).click());
      await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector("[data-overlay-close]") as HTMLButtonElement).click());
      await worker.evaluate(async (id) => { await chrome.tabs.sendMessage(id!, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 }); }, tabId);
      const sample = await metricsFor();
      structuralSamples.push(sample);
      expect(sample!.notificationListeners).toBe(1);
      expect(sample!.lifecycleListeners).toBe(3);
      expect(sample!.periodicViewTimers).toBe(0);
    }
      // Samples are collected below after the complete lifecycle series.
    expect(await page.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);
    const structuralMetrics = await metricsFor();
    expect(structuralMetrics!.notificationListeners).toBe(1);
    expect(structuralMetrics!.lifecycleListeners).toBe(3);
    expect(structuralMetrics!.periodicViewTimers).toBe(0);

    // Session-unavailable restart edge: remove every authoritative workflow
    // record, physically stop the worker again, then recover the existing UI.
    // The stale actionable view must be replaced by the safe toolbar view.
    await worker.evaluate(async () => chrome.storage.session.remove([
      "activeAssistedApplyHandoffV1", "pendingLaunches", "sessionPackages", "viewStates"
    ]));
    const invalidInternals = await context.newPage();
    await invalidInternals.goto("chrome://serviceworker-internals");
    const invalidRegistration = invalidInternals.locator(".serviceworker-registration").filter({ hasText: extensionId });
    await invalidRegistration.getByRole("button", { name: "Stop" }).click();
    await expect.poll(async () => (await invalidRegistration.innerText()).toLowerCase()).toContain("stopped");
    await invalidInternals.close();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => {
      const root = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.shadowRoot;
      return (root?.getElementById("fill") as HTMLButtonElement | null)?.disabled === true;
    });
    const invalidSessionRecovery = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1");
      const root = host?.shadowRoot;
      return { hostCount: document.querySelectorAll("#xpertapply-assistant-overlay-v1").length,
        state: host?.dataset.overlayState, fillDisabled: (root?.getElementById("fill") as HTMLButtonElement | null)?.disabled,
        stage: root?.getElementById("stage")?.textContent };
    });
    expect(invalidSessionRecovery).toMatchObject({ hostCount: 1, state: "open", fillDisabled: true });



    expect(swErrors).toEqual([]);
    network.assertContained();
  } finally {
    await context.close();
    await apiFixture.close();
    fs.rmSync(PROFILE, { recursive: true, force: true });
  }
});
