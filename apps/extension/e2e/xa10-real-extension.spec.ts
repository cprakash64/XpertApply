import { expect, test, chromium } from "@playwright/test";
import { OwnedPackageFixture } from "./owned-package-fixture";
import { containSyntheticNetwork } from "./network-containment";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

const FIXTURE = `<!doctype html><title>Apply</title><main><h1>Apply for this job</h1>
  <form id="application">
    <label for="prior">Existing value</label><input id="prior" name="unmapped_existing" value="KEEP-ME">
    <label for="first">First name</label><input id="first" name="first_name" autocomplete="given-name" required class="employer-control" style="outline:3px dotted rgb(12,34,56);border:4px solid purple;box-shadow:1px 2px 3px black;background:linen">
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
    <label><input id="privacy" type="checkbox" checked> I agree to the candidate privacy policy</label>
    <button type="submit" id="submit">Submit application</button>
  </form></main>
  <script>
    window.__xa10Submit = 0;
    window.__xa10SubmitClicks = 0;
    window.__xa10Events = {input:0,change:0};
    document.querySelector("#submit").addEventListener("click",()=>window.__xa10SubmitClicks++);
    document.querySelector("#application").addEventListener("input",()=>window.__xa10Events.input++);
    document.querySelector("#application").addEventListener("change",()=>window.__xa10Events.change++);
    window.__xa10EmployerStyle = document.querySelector('#first').getAttribute('style');
    window.__xa14Mutations = [];
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type !== 'attributes') continue;
        const name = record.attributeName || '';
        if (name.startsWith('data-jobpilot-') || name.startsWith('data-xpertapply-')) {
          window.__xa14Mutations.push(name);
        }
      }
    }).observe(document.documentElement, { subtree: true, attributes: true });
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
  const fixture = await new OwnedPackageFixture(FIXTURE).start();
  const origin = fixture.origin;
  const applicationUrl = `${origin}/apply`;
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  const network = await containSyntheticNetwork(context);
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
    await fixture.route("**/application-sessions/token", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: fixture.sessionToken, session }) }));
    await fixture.route("**/application-sessions/*/answers", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers, unresolved_questions: [], refreshed: false, profile_revision: "r" }) }));
    await fixture.route("**/application-sessions/910", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));

    for (const endpoint of ["answers/override", "resolve-questions", "events", "autofill-results"]) await fixture.route(`**/application-sessions/910/${endpoint}`, route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(endpoint==="answers/override"?{overrides:[]}:endpoint==="resolve-questions"?{request_schema_version:3,answer_contract_version:3,registry_version:"fixture",results:[]}:{})}));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await context.newPage();
    await page.goto(applicationUrl);
    const choices = () => page.evaluate(() => ({
      native: (document.querySelector("#country-native") as HTMLSelectElement).value,
      radios: ["source-referral", "source-board"].map(id => (document.getElementById(id) as HTMLInputElement).checked),
      checkbox: (document.querySelector("#privacy") as HTMLInputElement).checked,
      custom: document.querySelector("#country-custom .select__value")!.textContent,
      customInput: (document.querySelector("#country-custom input") as HTMLInputElement).value
    }));
    const snapshot = () => page.locator("#application").evaluate(form => ({
      controls: Array.from(form.querySelectorAll("input,select,textarea")).map(el=>({id:el.id,value:(el as HTMLInputElement).value,checked:el instanceof HTMLInputElement?el.checked:null,style:el.getAttribute("style"),classes:el.className})),
      custom: { text:form.querySelector("#country-custom .select__value")!.textContent,classes:form.querySelector("#country-custom .select__value")!.className,expanded:form.querySelector("#country-custom")!.getAttribute("aria-expanded"),placeholderHidden:(form.querySelector(".select__placeholder") as HTMLElement).hidden }
    }));
    const originalState = await snapshot();
    const originalChoices = await choices();
    await worker.evaluate(async (url) => {
      await chrome.storage.local.set({apiBase:new URL(url).origin,r13bSyntheticAccountMarker:"preserve-this-account"});
      const now = Date.now();
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "xa10-e2e", jobId: "910", applicationUrl: url, status: "prepared",
        handoffToken: "xa10-handoff", requestId: "xa10-request", sessionId: 910, launchToken: "xa10-launch",
        officialUrl: url, expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      }});
    }, applicationUrl);

    const overlay = await CanonicalOverlayDriver.openFromToolbar(page, worker);
    await expect.poll(() => overlay.status()).toBe("Reading the form…");
    expect(await choices()).toEqual(originalChoices);
    expect(await snapshot()).toEqual(originalState);
    expect(await page.evaluate(()=>(window as any).__xa10Events)).toEqual({input:0,change:0});
    await overlay.fill();
    await expect(page.locator("#country-native")).toHaveValue("United States", { timeout: 20_000 });
    await expect(page.locator("#source-board")).toBeChecked();
    await expect(page.locator("#country-custom .select__value")).toHaveText("United States");
    await expect(page.locator("#privacy")).toBeChecked();
    expect(await page.evaluate(() => Array.from(document.querySelectorAll("*")).flatMap((element) =>
      Array.from(element.attributes)
        .filter((attribute) => attribute.name.startsWith("data-jobpilot-") || attribute.name.startsWith("data-xpertapply-"))
        .map((attribute) => attribute.name)
    ))).toEqual([]);
    expect(await page.evaluate(() => (window as any).__xa14Mutations)).toEqual([]);
    await expect(page.locator("#prior")).toHaveValue("KEEP-ME");
    expect(await page.locator("#first").getAttribute("style")).toBe(await page.evaluate(() => (window as any).__xa10EmployerStyle));
    await expect.poll(() => overlay.status()).toMatch(/^Filled/);
    expect(await page.evaluate(() => (window as any).__xa10Events.change)).toBeGreaterThan(0);
    await overlay.clear();
    await expect.poll(choices).toEqual(originalChoices);
    await expect.poll(snapshot).toEqual(originalState);
    const workerView=await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(t=>t.url===url)!;return (await chrome.storage.session.get("viewStates")).viewStates[String(tab.id)];},page.url());
    await expect.poll(async()=>{const v=await overlay.summary();return [v.discovered,v.filled,v.review,v.skipped];}).toEqual([workerView.fieldsDiscovered,workerView.filled,workerView.reviewRequired,workerView.skipped]);
    expect(await worker.evaluate(async()=> (await chrome.storage.local.get("r13bSyntheticAccountMarker")).r13bSyntheticAccountMarker)).toBe("preserve-this-account");
    network.assertContained();

    const result = await page.evaluate(() => ({
      native: (document.querySelector("#country-native") as HTMLSelectElement).value,
      radio: (document.querySelector("#source-board") as HTMLInputElement).checked,
      custom: document.querySelector("#country-custom .select__value")?.textContent ?? "",
      prior: (document.querySelector("#prior") as HTMLInputElement).value,
      employerStylePreserved: document.querySelector("#first")?.getAttribute("style") === (window as any).__xa10EmployerStyle,
      marked: document.querySelectorAll("[data-jobpilot-filled]").length,
      privateMarkers: Array.from(document.querySelectorAll("*")).flatMap((element) =>
        Array.from(element.attributes).filter((attribute) =>
          attribute.name.startsWith("data-jobpilot-") || attribute.name.startsWith("data-xpertapply-")
        )).length,
      observedPrivateMarkers: (window as any).__xa14Mutations.length,
      submitClicks: (window as any).__xa10SubmitClicks,
      submitted: (window as any).__xa10Submit
    }));

    expect(result).toEqual({ native: "", radio: false, custom: "", prior: "KEEP-ME", employerStylePreserved: true, marked: 0, privateMarkers: 0, observedPrivateMarkers: 0, submitClicks: 0, submitted: 0 });
    await page.close();
  } finally {
    await context.close();
    await fixture.close();
  }
});
