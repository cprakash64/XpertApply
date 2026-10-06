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
    <label for="first_name">First name</label><input id="first_name" name="first_name" required>
    <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <button type="submit" id="submit">Submit application</button>
  </form><label><input id="privacy" type="checkbox" disabled>I agree to privacy policy</label></main>
  <script>
    window.__xa11Submit = 0;
      window.__xa11SubmitClicks = 0;
      document.querySelector("button[type=submit]").addEventListener("click",()=>window.__xa11SubmitClicks++);
    window.__xa14ReviewMutations = { attributes: [], style: 0, widgetAdds: 0, nativeInput: 0, nativeChange: 0 };
    document.addEventListener('input', () => window.__xa14ReviewMutations.nativeInput++, true);
    document.addEventListener('change', () => window.__xa14ReviewMutations.nativeChange++, true);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const name = record.attributeName || '';
          window.__xa14ReviewMutations.attributes.push({
            id: record.target.id || '',
            name,
            value: record.target.getAttribute(name)
          });
          if (name === 'style') window.__xa14ReviewMutations.style++;
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.id === 'xpertapply-assistant-overlay-v1' || node.querySelector?.('#xpertapply-assistant-overlay-v1')) {
            window.__xa14ReviewMutations.widgetAdds++;
          }
        }
      }
    }).observe(document.documentElement, { subtree: true, attributes: true, childList: true });
    document.querySelector('#application').addEventListener('submit', event => {
      event.preventDefault();
      window.__xa11Submit++;
    });
  </script>`;

for (const resolveReview of [false, true]) {
test(`required-review guard: ${resolveReview ? "explicit review resolution and manual completion" : "unresolved review preserves employer form"}`, async () => {
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
      { canonical_key: "first_name", value: "Test", display_value: "Test", source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true },
      { canonical_key: "last_name", value: "Candidate", display_value: "Candidate", source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true },
      { canonical_key: "email", value: "candidate@example.test", display_value: "candidate@example.test", source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true }
    ];
    const session = {
      session_id: 911,
      ats_type: null,
      official_application_url: applicationUrl,
      job: { title: "Engineer", company: "XA-11 Fixture" },
      resume: { status: "ready", document_id: 1, download_url: null },
      cover_letter: { status: "ready", document_id: 2, download_url: null },
      profile: {
        first_name: "Test",
        last_name: "Candidate",
        email: "candidate@example.test"
      },
      answers,
      unresolved_questions: []
    };
    await fixture.route("**/application-sessions/token", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session_token: fixture.sessionToken, session })
    }));
    await fixture.route("**/application-sessions/*/answers", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ answers, unresolved_questions: [], refreshed: false, profile_revision: "r" })
    }));
    await fixture.route("**/application-sessions/911", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session)
    }));

    for (const endpoint of ["answers/override", "resolve-questions", "events", "autofill-results"]) {
      await fixture.route(`**/application-sessions/911/${endpoint}`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(endpoint === "answers/override" ? { overrides: [] } : endpoint === "resolve-questions" ? { request_schema_version: 3, answer_contract_version: 3, registry_version: "fixture", results: [] } : {}) }));
    }
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await context.newPage();
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto(applicationUrl);
    await worker.evaluate(async (url) => {
      await chrome.storage.local.set({apiBase:new URL(url).origin});
      const now = Date.now();
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: {
        version: 1,
        applicationId: "xa11-e2e",
        jobId: "911",
        applicationUrl: url,
        status: "prepared",
        handoffToken: "xa11-handoff",
        requestId: "xa11-request",
        sessionId: 911,
        launchToken: "xa11-launch",
        officialUrl: url,
        expectedOrigin: new URL(url).origin,
        createdAt: now,
        expiresAt: now + 900_000,
        state: "waiting_for_content_script",
        protocolVersion: 3,
        atsType: null
      }});
    }, applicationUrl);

    const widget = await CanonicalOverlayDriver.openFromToolbar(page, worker);
    await expect.poll(() => widget.status()).toBe("Reading the form…");
    await widget.fill();
    await expect(page.locator("#email")).toHaveValue("candidate@example.test", { timeout: 20_000 });
    await expect.poll(() => widget.status()).toBe("Filled — some items need your review");

    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t=>t.url===url)!.id!, page.url());
    const stored = () => worker.evaluate(async id => { const state=await chrome.storage.session.get(["viewStates","sessionPackages","pendingLaunches"]); const v=state.viewStates?.[String(id)]; return {view:v ? {state:v.state,discovered:v.fieldsDiscovered,filled:v.filled,review:v.reviewRequired,required:v.requiredReviewRemaining}:null, packagePresent:!!state.sessionPackages?.[String(id)],pendingPresent:!!state.pendingLaunches?.[String(id)]};},tabId);
    await expect.poll(async()=> (await stored()).view?.required).toBe(2);
    const before=await stored();
    expect(before).toMatchObject({view:{state:"completed_with_review",discovered:3,filled:1,review:2,required:2},packagePresent:true,pendingPresent:true});
    expect(await widget.summary()).toMatchObject({discovered:3,filled:1,review:2});
    const complete=page.locator("#xpertapply-assistant-overlay-v1 #complete");
    await expect(complete).toBeDisabled();
    let completionRequests=0;
    await fixture.route("**/application-sessions/911/complete", route=>{completionRequests++;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})})});
    const send = (sessionId: number) => worker.evaluate(async ({id,sessionId}) => (await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},func:async sessionId => chrome.runtime.sendMessage({type:"XPERTAPPLY_OVERLAY_COMPLETE_SESSION",sessionId,requiredReviewRemaining:0,reviewRequired:0}),args:[sessionId]}))[0].result, {id:tabId,sessionId});
    expect(await send(912)).toMatchObject({ok:false,error:"OVERLAY_SESSION_AUTHORITY_MISMATCH"});
    expect(await send(911)).toMatchObject({ok:false,error:"REQUIRED_REVIEW_REMAINING"});
    expect(completionRequests).toBe(0);expect(await stored()).toEqual(before);
    const registered = await worker.evaluate(async id => (await chrome.scripting.executeScript({ target:{tabId:id,frameIds:[0]},func:async()=>chrome.runtime.sendMessage({type:"XPERTAPPLY_OVERLAY_GET_VIEW"}) }))[0].result,tabId);
    expect(registered).toMatchObject({ok:true,view:{requiredReviewRemaining:2}});
    await expect(page.locator("#privacy")).not.toBeChecked();
    const formBefore = await page.locator("#application").evaluate(form => ({ values:Array.from(form.querySelectorAll("input")).map(el=>({id:el.id,value:el.value,checked:el.checked})),html:form.innerHTML }));
    const safety = () => page.evaluate(()=>({clicks:(window as any).__xa11SubmitClicks,submits:(window as any).__xa11Submit}));
    expect(await safety()).toEqual({clicks:0,submits:0});
    network.assertContained();

    if (resolveReview) {
      // Existing explicit review answer UI drives and verifies the actual field.
      await widget.openReview();
      const cards = await widget.probe<{id:string,title:string}[]>(`function(){return Array.from(this.querySelectorAll('[data-item]')).map(el=>({id:el.getAttribute('data-item'),title:el.querySelector('.q')?.textContent||''}))}`);

      for (const [label,value] of [["First name","Test"],["Last name","Candidate"]]) {
        const card=cards.find(card=>card.title.toLowerCase().includes(label.toLowerCase()));expect(card).toBeTruthy();
        expect(await widget.probe<boolean>(`function(id,value){const card=this.querySelector('[data-item="'+id+'"]');const input=card?.querySelector('input[type=text]');const save=card?.querySelector('input[type=checkbox]');if(!input)return false;input.value=value;if(save)save.checked=false;const button=Array.from(card.querySelectorAll('button')).find(b=>/Save and fill|Use this answer/.test(b.textContent));if(!button)return false;button.click();return true}`,card!.id,value)).toBe(true);
        await expect(page.locator(label === "First name" ? "#first_name" : "#last_name")).toHaveValue(value);
      }
      await expect.poll(async()=> (await stored()).view?.required).toBe(0);
      const resolved=await stored();
      const summary=await widget.summary();expect([summary.discovered,summary.filled,summary.review]).toEqual([resolved.view!.discovered,resolved.view!.filled,resolved.view!.review]);
      await expect(complete).toBeEnabled();
      let dialogs=0;page.once("dialog",dialog=>{dialogs++;expect(dialog.message()).toContain("Confirm you submitted");return dialog.dismiss()});await complete.click();
      expect(dialogs).toBe(1);expect(completionRequests).toBe(0);expect((await stored()).packagePresent).toBe(true);
      page.once("dialog",dialog=>{dialogs++;return dialog.accept()});await complete.click();
      await expect.poll(async()=> (await stored()).packagePresent).toBe(false);
      expect(completionRequests).toBe(1);expect(dialogs).toBe(2);
      expect(await stored()).toEqual({view:null,packagePresent:false,pendingPresent:false});
      expect(await safety()).toEqual({clicks:0,submits:0});await expect(page.locator("#privacy")).not.toBeChecked();network.assertContained();

    } else {
      expect(await page.locator("#application").evaluate(form => ({ values:Array.from(form.querySelectorAll("input")).map(el=>({id:el.id,value:el.value,checked:el.checked})),html:form.innerHTML }))).toEqual(formBefore);
    }

    await page.close();
  } finally {
    await context.close();
    await fixture.close();
  }
});
}
