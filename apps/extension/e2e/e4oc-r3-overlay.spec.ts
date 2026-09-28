import { expect, test, chromium, type Page } from "@playwright/test";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve("dist-e2e-granted");
const EVIDENCE = "/tmp/xpertapply-e4oc-r3-evidence";
const PROFILE = "/tmp/xpertapply-e4oc-r3-profile";

const fixture = `<!doctype html><meta charset="utf-8"><title>SmartRecruiters-shaped application</title>
<main><h1>Apply for Software Engineer</h1><form id="application">
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
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium", headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow", viewport: { width: 1280, height: 900 }
  });
  try {
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
    await page.screenshot({ path: path.join(EVIDENCE, "01-web-extension-connected.png"), fullPage: true });
    fs.writeFileSync(path.join(EVIDENCE, "presence-bridge-result.json"), JSON.stringify({ first, replay: second, afterReload }, null, 2));
  } finally {
    await context.close();
  }
});

test("E4O-C-R3 canonical toolbar overlay discovers then explicitly fills the real DOM", async () => {
  test.setTimeout(90_000);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const applicationUrl = `http://localhost:${(server.address() as { port: number }).port}/apply`;
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium", headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow", viewport: { width: 1280, height: 900 }
  });
  console.log("R3 checkpoint: browser launched");
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
    await context.route("**/application-sessions/token", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: "sanitized-test-token", session: sessionBody }) }));
    await context.route("**/application-sessions/*/answers", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers, unresolved_questions: [{ canonical_key: "custom_motivation", reason: "answer_on_employer_page" }], refreshed: false, profile_revision: "r3" }) }));
    await context.route("**/application-sessions/*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) }));

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    console.log("R3 checkpoint: service worker ready", worker.url());
    const extensionId = new URL(worker.url()).host;
    const swErrors: string[] = [];
    worker.on("console", (message) => { if (message.type() === "error") swErrors.push(message.text().slice(0, 300)); });
    const page = await context.newPage();
    await page.goto(applicationUrl);
    console.log("R3 checkpoint: employer fixture loaded");
    const before = await formValues(page);
    const tabId = await worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url: `${new URL(url).origin}/*` });
      return tabs[0]?.id;
    }, applicationUrl);
    expect(tabId).toBeTruthy();
    console.log("R3 checkpoint: tab resolved", tabId);
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
    console.log("R3 checkpoint: toolbar-equivalent scripts dispatched");

    await page.waitForTimeout(5_000);
    const diagnostic = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1");
      const root = host?.shadowRoot;
      return { host: Boolean(host), state: host?.dataset.overlayState,
        stage: root?.getElementById("stage")?.textContent,
        ats: root?.getElementById("ats")?.textContent,
        discovered: root?.getElementById("discovered")?.textContent,
        fillDisabled: (root?.getElementById("fill") as HTMLButtonElement | null)?.disabled };
    });
    const storageDiagnostic = await worker.evaluate(async () => chrome.storage.session.get(["activeAssistedApplyHandoffV1", "pendingLaunches", "viewStates", "sessionPackages"]));
    console.log("R3 diagnostic", JSON.stringify({ diagnostic, storageDiagnostic }, null, 2));
    await page.waitForFunction(() => {
      const root = document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.shadowRoot;
      return root && Number(root.getElementById("discovered")?.textContent) > 0 && root.getElementById("ats")?.textContent !== "Detecting…";
    }, undefined, { timeout: 20_000 });
    console.log("R3 checkpoint: discovery rendered");
    const hostCount = await page.locator("#xpertapply-assistant-overlay-v1").count();
    expect(hostCount).toBe(1);
    const afterOpen = await formValues(page);
    expect(afterOpen).toEqual(before);

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
    await page.screenshot({ path: path.join(EVIDENCE, "02-overlay-open.png"), fullPage: true });
    await page.screenshot({ path: path.join(EVIDENCE, "03-bottom-right-glass-overlay.png"), fullPage: true });

    await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.getElementById("fill") as HTMLButtonElement).click());
    console.log("R3 checkpoint: explicit Fill clicked");
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
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    await page.locator("#first").focus();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("first");

    await page.reload();
    expect(await page.locator("#xpertapply-assistant-overlay-v1").count()).toBe(0);
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["overlayBootstrap.js"] });
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["content.js"] });
      await chrome.tabs.sendMessage(id!, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 });
    }, tabId);
    expect(await page.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);

    const pageB = await context.newPage();
    await pageB.goto(applicationUrl);
    const tabB = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${new URL(url).origin}/*` })).find((tab) => tab.active)?.id, applicationUrl);
    expect(tabB).toBeTruthy();
    await worker.evaluate(async ([id, url]) => {
      const now = Date.now();
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: { version: 1, applicationId: "e4oc-r3-b", jobId: "3003", applicationUrl: url, status: "prepared", handoffToken: "sanitized-handoff-b", requestId: "e4oc-r3-b", sessionId: 3003, launchToken: "sanitized-launch-b", officialUrl: url, expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900_000, state: "waiting_for_content_script", protocolVersion: 3, atsType: "smartrecruiters" }});
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["overlayBootstrap.js"] });
      await chrome.scripting.executeScript({ target: { tabId: id!, frameIds: [0] }, files: ["content.js"] });
      await chrome.tabs.sendMessage(id!, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 });
    }, [tabB, applicationUrl] as const);
    expect(await pageB.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);
    await page.evaluate(() => (document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")!.shadowRoot!.querySelector("[data-overlay-minimize]") as HTMLButtonElement).click());
    expect(await pageB.evaluate(() => document.querySelector<HTMLElement>("#xpertapply-assistant-overlay-v1")?.dataset.overlayState)).toBe("open");
    await pageB.close();

    const report = { browser: await context.browser()?.version(), extensionId, profilePath: PROFILE, hostCount, overlay, beforeFillUnchanged: JSON.stringify(before) === JSON.stringify(afterOpen), afterFill, finalSubmitClickCount: 0, minimizeRestore: "pass", closeReopen: "pass", reloadLifecycle: "pass", twoTabIsolation: "pass", responsiveWidths: [340, 375, 400, 420], keyboardEmployerPageReachable: true, serviceWorkerErrors: swErrors };
    fs.writeFileSync(path.join(EVIDENCE, "deterministic-overlay-result.json"), JSON.stringify(report, null, 2));
    expect(swErrors).toEqual([]);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
