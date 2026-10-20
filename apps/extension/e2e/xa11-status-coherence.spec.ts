import { expect, test, chromium } from "@playwright/test";
import { OwnedPackageFixture } from "./owned-package-fixture";
import { containSyntheticNetwork } from "./network-containment";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";
import { overlayCdp } from "./overlay-cdp";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

const FIXTURE = `<!doctype html><title>Apply</title><main><h1>Apply for this job</h1>
  <form id="application">
    <label for="first_name">First name</label><input id="first_name" name="first_name" required>
    <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <button type="submit" id="submit">Submit application</button>
  </form></main>
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

test("XA-11: widget confirmation total matches controls marked for review", async () => {
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

    const pageState = await page.evaluate(() => ({
      review: document.querySelectorAll('[data-jobpilot-status="review"]').length,
      verified: document.querySelectorAll('[data-jobpilot-status="verified"]').length,
      privateMarkers: Array.from(document.querySelectorAll("*")).flatMap((element) =>
        Array.from(element.attributes)
          .filter((attribute) => attribute.name.startsWith("data-jobpilot-"))
          .map((attribute) => attribute.name)
      ),
      styles: ["first_name", "last_name", "email"].map((id) => {
        const element = document.getElementById(id)!;
        const computed = getComputedStyle(element);
        return {
          id,
          inlineOutline: (element as HTMLElement).style.outline,
          inlineOutlineOffset: (element as HTMLElement).style.outlineOffset,
          computedOutline: computed.outline,
          computedOutlineColor: computed.outlineColor,
          computedOutlineStyle: computed.outlineStyle,
          computedOutlineWidth: computed.outlineWidth
        };
      }),
      observer: (window as any).__xa14ReviewMutations,
      widgetHostReadable: document.getElementById("xpertapply-assistant-overlay-v1")?.id ?? null,
      pageWindowInstanceVisible: Object.prototype.hasOwnProperty.call(window, "__jobpilotContentInstance"),
      fieldExpandos: ["first_name", "last_name", "email"].flatMap((id) =>
        Object.keys(document.getElementById(id)!).filter((key) => /jobpilot|xpertapply/i.test(key))
      ),
      submitClicks: (window as any).__xa11SubmitClicks,
      submitted: (window as any).__xa11Submit
    }));
    const summary = await widget.summary();
    const cdp = await context.newCDPSession(page);
    const accessibility = await cdp.send("Accessibility.getFullAXTree");
    const accessibleNames = accessibility.nodes
      .map((node) => node.name?.value)
      .filter((value): value is string => typeof value === "string");
    const authoritative = await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === url)!;
      const {viewStates} = await chrome.storage.session.get("viewStates");
      return viewStates[String(tab.id)];
    }, page.url());
    expect([summary.discovered,summary.filled,summary.review]).toEqual([authoritative.fieldsDiscovered,authoritative.filled,authoritative.reviewRequired]);
    const confirmation = summary.review;


    expect(pageState.submitted).toBe(0);
    expect(pageState.submitClicks).toBe(0);
    expect(pageState).toMatchObject({
      review: 0,
      verified: 0,
      privateMarkers: [],
      pageWindowInstanceVisible: false,
      fieldExpandos: []
    });
    expect(pageState.styles.map((style) => style.inlineOutline)).toEqual(["", "", ""]);
    expect(pageState.styles.map((style) => style.inlineOutlineOffset)).toEqual(["", "", ""]);
    expect(pageState.observer.style).toBe(0);
    expect(accessibleNames.filter((name) => name === "XpertApply field status: Needs review")).toHaveLength(2);
    expect(accessibleNames.filter((name) => name === "XpertApply field status: Verified")).toHaveLength(1);
    expect(summary.filled).toBe(1);
    expect(summary.discovered).toBe(3);
    expect(confirmation).toBe(authoritative.reviewRequired);
    expect(confirmation).toBe(accessibleNames.filter(name => name === "XpertApply field status: Needs review").length);
    expect(confirmation).toBe(2);
    let completions=0;
    await fixture.route("**/application-sessions/911/complete",route=>{completions++;return route.fulfill({status:200,contentType:"application/json",body:"{}"})});
    await expect.poll(()=>overlayCdp(page).isDisabled("#complete")).toBe(true);
    const tabId=authoritative.tabId;
    const stores=()=>worker.evaluate(async id=>{const s=await chrome.storage.session.get(["viewStates","sessionPackages","pendingLaunches"]);return {view:s.viewStates?.[String(id)]??null,packagePresent:!!s.sessionPackages?.[String(id)],pendingPresent:!!s.pendingLaunches?.[String(id)]};},tabId);
    const before=await stores();
    const response=await worker.evaluate(async id=>(await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},func:async()=>chrome.runtime.sendMessage({type:"XPERTAPPLY_OVERLAY_COMPLETE_SESSION",sessionId:911,requiredReviewRemaining:0})}))[0].result,tabId);
    expect(response).toMatchObject({ok:false,error:"REQUIRED_REVIEW_REMAINING"});expect(completions).toBe(0);expect(await stores()).toEqual(before);
    await widget.openReview();
    const cards=await widget.probe<{id:string,title:string}[]>(`function(){return Array.from(this.querySelectorAll('[data-item]')).map(el=>({id:el.getAttribute('data-item'),title:el.querySelector('.q')?.textContent||''}))}`);
    for(const [label,value] of [["First name","Test"],["Last name","Candidate"]]){
      const card=cards.find(c=>c.title.includes(label));expect(card).toBeTruthy();
      expect(await widget.probe<boolean>(`function(id,value){const c=this.querySelector('[data-item="'+id+'"]');const i=c?.querySelector('input[type=text]');if(!i)return false;i.value=value;const save=c.querySelector('input[type=checkbox]');if(save)save.checked=false;const b=Array.from(c.querySelectorAll('button')).find(b=>/Save and fill|Use this answer/.test(b.textContent));if(!b)return false;b.click();return true}`,card!.id,value)).toBe(true);
    }
    await expect.poll(async()=> (await stores()).view?.requiredReviewRemaining).toBe(0);await expect.poll(()=>overlayCdp(page).isEnabled("#complete")).toBe(true);expect(completions).toBe(0);
    expect(await page.evaluate(()=>(window as any).__xa11Submit)).toBe(0);expect(await page.evaluate(()=>(window as any).__xa11SubmitClicks)).toBe(0);
    network.assertContained();
    expect(authoritative.state).toBe("completed_with_review");
    expect(authoritative.requiredReviewRemaining).toBe(2);
    await page.close();
  } finally {
    await context.close();
    await fixture.close();
  }
});
