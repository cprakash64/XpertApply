import { expect, test, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WidgetDriver } from "./widget-driver";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

const FIXTURE = `<!doctype html><title>Apply</title><main><h1>Apply for this job</h1>
  <form id="application">
    <label for="first">First name</label><input id="first" name="first_name" autocomplete="given-name" required>
    <label for="last">Last name</label><input id="last" name="last_name" autocomplete="family-name" required>
    <label for="email">Email</label><input id="email" name="email" autocomplete="email" required>
    <label for="country-native">Country</label><select id="country-native" autocomplete="country-name">
      <option value="">Select</option><option>Canada</option><option>United States</option></select>
    <span id="country-custom-label">Country</span>
    <div id="country-custom" class="select__control" role="combobox" aria-labelledby="country-custom-label"
         aria-expanded="false" aria-controls="country-menu" tabindex="0">
      <span class="select__placeholder">Select</span><span class="select__value"></span>
      <input class="select__input" autocomplete="country-name">
    </div>
    <fieldset><legend>How did you hear about us?</legend>
      <input id="source-referral" type="radio" name="source" value="referral"><label for="source-referral">Referral</label>
      <input id="source-board" type="radio" name="source" value="board"><label for="source-board">Job board</label>
    </fieldset>
    <button type="submit" id="submit">Submit application</button>
  </form></main>
  <script>
    window.__xa10Submit = 0;
    document.querySelector('#application').addEventListener('submit', event => { event.preventDefault(); window.__xa10Submit++; });
    const control = document.querySelector('#country-custom');
    const display = control.querySelector('.select__value');
    const placeholder = control.querySelector('.select__placeholder');
    let selected = '';
    let menu = null;
    function close(){ if(menu) menu.remove(); menu=null; control.setAttribute('aria-expanded','false'); }
    function commit(value){ selected=value; display.textContent=value; display.className='select__value select__singleValue'; placeholder.hidden=true; close(); control.dispatchEvent(new Event('change',{bubbles:true})); }
    function clear(){ selected=''; display.textContent=''; display.className='select__value'; placeholder.hidden=false; control.dispatchEvent(new Event('change',{bubbles:true})); }
    function open(){ if(menu) return; menu=document.createElement('div'); menu.id='country-menu'; menu.setAttribute('role','listbox');
      for(const value of ['Canada','United States']){ const option=document.createElement('div'); option.setAttribute('role','option'); option.textContent=value; option.addEventListener('click',()=>commit(value)); menu.append(option); }
      document.body.append(menu); control.setAttribute('aria-expanded','true'); }
    control.addEventListener('mousedown',open);
    control.addEventListener('keydown',event=>{ if(event.key==='ArrowDown') open(); if(event.key==='Escape') close(); if((event.key==='Backspace'||event.key==='Delete')&&selected) clear(); });
  </script>`;

test("XA-10: production MV3 Clear restores every choice control", async () => {
  test.setTimeout(60_000);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(FIXTURE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://localhost:${(server.address() as { port: number }).port}`;
  const applicationUrl = `${origin}/apply`;
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  try {
    const answers = [
      { canonical_key: "country", value: "United States", display_value: "United States", source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true },
      { canonical_key: "referral_source", value: "Job board", display_value: "Job board", source: "user_default", confidence: 1, sensitive: false, requires_review: false, verified: true }
    ];
    const session = {
      session_id: 910, ats_type: null, official_application_url: applicationUrl,
      job: { title: "Engineer", company: "XA-10 Fixture" },
      resume: { status: "ready", document_id: 1, download_url: null },
      cover_letter: { status: "ready", document_id: 2, download_url: null },
      profile: { first_name: "Test", last_name: "Candidate", email: "candidate@example.test", country: "United States" },
      answers, unresolved_questions: []
    };
    await context.route("**/application-sessions/token", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: "xa10-token", session }) }));
    await context.route("**/application-sessions/*/answers", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers, unresolved_questions: [], refreshed: false, profile_revision: "r" }) }));
    await context.route("**/application-sessions/*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    await worker.evaluate(async (url) => {
      const now = Date.now();
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "xa10-e2e", jobId: "910", applicationUrl: url, status: "prepared",
        handoffToken: "xa10-handoff", requestId: "xa10-request", sessionId: 910, launchToken: "xa10-launch",
        officialUrl: url, expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      }});
    }, applicationUrl);

    const page = await context.newPage();
    await page.goto(applicationUrl);
    await expect(page.locator("#country-native")).toHaveValue("United States", { timeout: 20_000 });
    await expect(page.locator("#source-board")).toBeChecked();
    await expect(page.locator("#country-custom .select__value")).toHaveText("United States");
    await page.waitForSelector("#jobpilot-assisted-apply", { state: "attached" });
    const widget = await WidgetDriver.attach(page);
    await widget.clearFilledFields();
    await expect.poll(() => widget.message()).toContain("Cleared");

    const result = await page.evaluate(() => ({
      native: (document.querySelector("#country-native") as HTMLSelectElement).value,
      radio: (document.querySelector("#source-board") as HTMLInputElement).checked,
      custom: document.querySelector("#country-custom .select__value")?.textContent ?? "",
      marked: document.querySelectorAll("[data-jobpilot-filled]").length,
      submitted: (window as any).__xa10Submit
    }));
    console.log(`XA10_MV3 ${JSON.stringify(result)}`);
    expect(result).toEqual({ native: "", radio: false, custom: "", marked: 0, submitted: 0 });
    await page.close();
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
