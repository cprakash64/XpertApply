import { expect, test, chromium } from "@playwright/test";
import { OwnedPackageFixture } from "./owned-package-fixture";
import { containSyntheticNetwork } from "./network-containment";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist-e2e-granted");

const FIXTURE = `<!doctype html><title>Apply</title><main><h1>Apply for this job</h1>
  <form id="application">
    <label for="first_name">First name</label><input id="first_name" name="first_name" required>
    <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <label><input id="privacy" type="checkbox"> I agree to the candidate privacy policy</label>
    <button type="submit" id="submit">Submit application</button>
  </form><button id="outside" type="button" onclick="window.__outsideClicks=(window.__outsideClicks||0)+1">Employer page control</button><div style="height:1800px">Employer page scroll area</div></main>
  <script>
    window.__xa11Submit = 0;
    window.__xa16SubmitClicks=0;
    document.querySelector("#submit").addEventListener("click",()=>window.__xa16SubmitClicks++);
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

test("XA-16/XA-19: production MV3 semantics and constrained viewport acceptance", async () => {
  test.setTimeout(180_000);
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

    for (const endpoint of ["answers/override", "resolve-questions", "events", "autofill-results"]) await fixture.route(`**/application-sessions/911/${endpoint}`,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(endpoint==="answers/override"?{overrides:[]}:endpoint==="resolve-questions"?{request_schema_version:3,answer_contract_version:3,registry_version:"fixture",results:[]}:{})}));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await context.newPage();
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

    let widget = await CanonicalOverlayDriver.openFromToolbar(page, worker);
    await expect.poll(() => widget.status()).toBe("Reading the form…");
    await widget.fill();
    await expect(page.locator("#email")).toHaveValue("candidate@example.test", {timeout:20_000});
    await expect.poll(() => widget.status()).toBe("Filled — some items need your review");
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id!,applicationUrl);
    const state = () => worker.evaluate(async id => {const s=await chrome.storage.session.get(["viewStates","sessionPackages","pendingLaunches"]);return {view:s.viewStates?.[String(id)]??null,packagePresent:!!s.sessionPackages?.[String(id)],pendingPresent:!!s.pendingLaunches?.[String(id)]};},tabId);
    await expect.poll(async()=>(await state()).view?.requiredReviewRemaining).toBe(2);
    const completeBefore=page.locator("#xpertapply-assistant-overlay-v1 #complete");await expect(completeBefore).toBeDisabled();
    let completionRequests=0;
    await fixture.route("**/application-sessions/911/complete",route=>{completionRequests++;return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({detail:"Synthetic completion rejection"})})});
    const before=await state();
    const bypass=await worker.evaluate(async id=>(await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},func:async()=>chrome.runtime.sendMessage({type:"XPERTAPPLY_OVERLAY_COMPLETE_SESSION",sessionId:911})}))[0].result,tabId);
    expect(bypass).toMatchObject({ok:false,error:"REQUIRED_REVIEW_REMAINING"});expect(completionRequests).toBe(0);expect(await state()).toEqual(before);
    await page.locator("#outside").click();expect(await page.evaluate(()=>(window as any).__outsideClicks)).toBe(1);expect(await widget.hostCount()).toBe(1);
    expect(await page.locator("body").getAttribute("inert")).toBeNull();
    expect(await page.locator("[data-overlay-panel]").getAttribute("aria-modal")).not.toBe("true");
    await page.mouse.move(50,500);await page.mouse.wheel(0,500);await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(0);await page.evaluate(()=>scrollTo(0,0));
    const results=[];
    for(const [width,height] of [[1280,720],[1366,768],[1440,900],[1280,640],[1280,600],[320,720],[375,720],[768,720]]) {
      await page.setViewportSize({width,height});
      for(const zoom of (width===1280&&height===720?[1,1.25,1.5,2]:[1])) {
        await worker.evaluate(async ({tabId,zoom})=>chrome.tabs.setZoom(tabId,zoom),{tabId,zoom});
        await expect.poll(()=>worker.evaluate(async id=>chrome.tabs.getZoom(id),tabId)).toBe(zoom);
        const m=await widget.inspectLayout();results.push({width,height,zoom,...m});
        expect(m.box.top).toBeGreaterThanOrEqual(0);expect(m.box.bottom).toBeLessThanOrEqual(m.viewport.height);
        expect(m.horizontalOverflow).toBe(false);expect(m.panelLive).toBeNull();
        expect(m.name?.trim()).toBe("XpertApply");expect(m.liveRole).toBe("status");expect(m.live).toBe("polite");
        await page.locator("#xpertapply-assistant-overlay-v1 #complete").scrollIntoViewIfNeeded();
        await expect(page.locator("#xpertapply-assistant-overlay-v1 #complete")).toBeInViewport();
      }
    }
    await worker.evaluate(async id=>chrome.tabs.setZoom(id,1),tabId);
    await page.setViewportSize({width:1280,height:720});
    await widget.openReview();
    // Retain unique real-review density/focus stress in the canonical body.
    await widget.probe(`function(){const panel=this.querySelector('.review-panel'),sample=panel.querySelector('.item');if(!sample)throw Error('No production review card');for(let i=0;i<500;i++){const card=sample.cloneNode(true);card.removeAttribute('data-item');card.classList.add('xa-density-stress');card.querySelector('.q').textContent='Long review field '+i+' '+ 'LongLabel'.repeat(30);panel.append(card)}}`);
    for(const height of [900,600,640,720,900]) {
      await page.setViewportSize({width:1280,height});
      const state=await widget.inspectLayout();expect(state.body.scrollHeight).toBeGreaterThan(state.body.clientHeight);expect(state.horizontalOverflow).toBe(false);
      await page.locator("#xpertapply-assistant-overlay-v1 #complete").scrollIntoViewIfNeeded();
      await expect(page.locator("#xpertapply-assistant-overlay-v1 #complete")).toBeInViewport();
      const focus=await widget.probe<{focused:boolean,top:number,bottom:number}>(`function(){const button=this.querySelector('.review-panel .item:last-child button');button.blur();button.focus();const r=button.getBoundingClientRect();return {focused:this.activeElement===button,top:r.top,bottom:r.bottom}}`);
      const body=(await widget.inspectLayout()).body;
      expect(focus.focused).toBe(true);expect(focus.top).toBeGreaterThanOrEqual(body.top);expect(focus.bottom).toBeLessThanOrEqual(body.bottom);
    }
    await widget.probe(`function(){this.querySelectorAll('.xa-density-stress').forEach(el=>el.remove())}`);
    await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
    await page.keyboard.press("Tab");
    await page.locator("[data-overlay-minimize]").focus();
    const colors=await page.locator("[data-overlay-minimize]").evaluate(el=>{const s=getComputedStyle(el);return {outline:s.outlineStyle,width:s.outlineWidth,transition:s.transitionDuration}});
    expect(colors).toEqual({outline:"solid",width:"3px",transition:"0s"});
    expect(await page.locator("[data-overlay-panel]").evaluate(el=>getComputedStyle(el).borderTopStyle)).toBe("solid");
    await page.emulateMedia({forcedColors:"none",reducedMotion:"no-preference"});
    // Observe the containing employer form and consumer message traffic during
    // existing idle verification; the nested facade observer remains below.
    await worker.evaluate(async id=>{await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},func:()=>{const w=globalThis as any;w.__r13bIdle={mutations:0,viewReads:0};new MutationObserver(r=>w.__r13bIdle.mutations+=r.length).observe(document.querySelector('#application')!,{subtree:true,childList:true,attributes:true,characterData:true});const send=chrome.runtime.sendMessage.bind(chrome.runtime);(chrome.runtime as any).sendMessage=(message:any,...args:any[])=>{if(["XPERTAPPLY_OVERLAY_GET_CONTEXT","XPERTAPPLY_OVERLAY_GET_VIEW"].includes(message.type))w.__r13bIdle.viewReads++;return (send as any)(message,...args)}}})},tabId);
    const idle=()=>worker.evaluate(async id=>(await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},func:()=>({...((globalThis as any).__r13bIdle)})}))[0].result,tabId);
    const idleBefore=await idle();
    const mutations=await widget.probe<number>(`async function(){let n=0;const o=new MutationObserver(r=>n+=r.length);o.observe(this,{subtree:true,childList:true,attributes:true,characterData:true});await new Promise(r=>setTimeout(r,500));o.disconnect();return n}`);
    expect(mutations).toBe(0);expect(await idle()).toEqual(idleBefore);
    // Resolve both required review fields using current production handlers.
    for(const value of ["Test","Candidate"]) {
      await widget.probe(`function(){const card=this.querySelector('.review-panel .item:not(.resolved)');const save=card.querySelector('label.save input');if(save)save.checked=false;card.querySelector('input[type="text"]').focus()}`);
      await page.keyboard.press("ControlOrMeta+A");await page.keyboard.type(value);
      await widget.probe(`function(){this.querySelector('.review-panel .item:not(.resolved) .row button').click()}`);
      await expect.poll(async()=>(await state()).view?.requiredReviewRemaining).toBe(value==="Test"?1:0);
    }
    const complete=page.locator("#xpertapply-assistant-overlay-v1 #complete");
    const clear=page.locator("#xpertapply-assistant-overlay-v1 #clear");
    await clear.scrollIntoViewIfNeeded();await clear.focus();
    let reached=false;
    for(let i=0;i<15;i++){await page.keyboard.press("Tab");if(await complete.evaluate(el=>el.getRootNode() instanceof ShadowRoot&&(el.getRootNode() as ShadowRoot).activeElement===el)){reached=true;break}}
    expect(reached).toBe(true);await expect(complete).toBeInViewport();await expect(complete).toBeEnabled();
    await expect.poll(async()=>(await state()).view?.requiredReviewRemaining).toBe(0);
    page.once("dialog",dialog=>dialog.accept()); // explicit manual-submission acknowledgment only
    await page.keyboard.press("Enter");
    await expect.poll(()=>widget.error()).toBe("Couldn’t mark complete. Try again.");
    expect(completionRequests).toBe(1);await expect(complete).toBeEnabled();await expect(complete).toBeInViewport();
    expect((await state()).packagePresent).toBe(true);expect((await state()).pendingPresent).toBe(true);
    await page.keyboard.press("Tab");
    expect(await complete.evaluate(el=>(el.getRootNode() as ShadowRoot).activeElement===el)).toBe(false);
    const cdp=await context.newCDPSession(page);const tree=await cdp.send("Accessibility.getFullAXTree");
    expect(tree.nodes.filter(n=>n.role?.value==="complementary"&&n.name?.value==="XpertApply")).toHaveLength(1);
    expect(tree.nodes.filter(n=>n.role?.value==="status")).toHaveLength(1);
    await expect(page.locator("#xpertapply-assistant-overlay-v1 #final")).toContainText("XpertApply never submits for you");
    await expect(page.locator("#privacy")).not.toBeChecked();
    expect(await page.evaluate(()=>(window as any).__xa11Submit)).toBe(0);
    expect(await page.evaluate(()=>(window as any).__xa16SubmitClicks)).toBe(0);
    // Lifecycle is explicit: minimize/restore, close, a real CONTENT_READY
    // update stays closed, then the unchanged toolbar driver reopens exactlyone.
    const publish = async (patch: Record<string, unknown>) => {
      const current = (await state()).view;
      const response = await worker.evaluate(async ({id, payload}) => {
        return (await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},func:async payload=>chrome.runtime.sendMessage({type:"JOBPILOT_AUTOFILL_PROGRESS",payload}),args:[payload]}))[0].result;
      }, {id:tabId,payload:{...current,documentsUploaded:[],reviewDocuments:[],...patch}});
      expect(response).toMatchObject({ok:true});
    };
    await expect.poll(async()=>{const v=(await state()).view;const s=await widget.summary();return [s.discovered,s.filled,s.review].join('/')=== [v.fieldsDiscovered,v.filled,v.reviewRequired].join('/')}).toBe(true);
    await page.locator("[data-overlay-minimize]").click();await expect(page.locator("[data-overlay-restore]")).toBeVisible();
    await publish({filled:2,reviewRequired:2});
    await expect.poll(async()=>{const s=await widget.summary();return [s.discovered,s.filled,s.review]}).toEqual([4,2,2]);
    await page.locator("[data-overlay-restore]").click();
    await publish({filled:3,reviewRequired:1});
    await expect.poll(async()=>{const s=await widget.summary();return [s.discovered,s.filled,s.review]}).toEqual([4,3,1]);
    await page.locator("[data-overlay-close]").click();await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);
    await publish({state:"completed"});await expect.poll(async()=>(await state()).view.state).toBe("completed");await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);
    await publish({state:"completed_with_review"});
    const passive=await worker.evaluate(async id=>(await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},func:async()=>chrome.runtime.sendMessage({type:"JOBPILOT_CONTENT_READY",url:location.href,title:document.title,protocolVersion:3,isTopFrame:true,topUrl:location.href,detectedAts:null})}))[0].result,tabId);
    expect(passive).toMatchObject({matched:true});await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(0);
    widget=await CanonicalOverlayDriver.openFromToolbar(page,worker);expect(await widget.hostCount()).toBe(1);
    const reopened=await state();expect([reopened.view.fieldsDiscovered,reopened.view.filled,reopened.view.reviewRequired]).toEqual([4,3,1]);expect(reopened.view.requiredReviewRemaining).toBe(0);await expect.poll(async()=>{const s=await widget.summary();return [s.discovered,s.filled,s.review]}).toEqual([reopened.view.fieldsDiscovered,reopened.view.filled,reopened.view.reviewRequired]);
    await expect(page.locator("#xpertapply-assistant-overlay-v1 #complete")).toBeEnabled();
    page.once("dialog",d=>d.accept());await page.locator("#xpertapply-assistant-overlay-v1 #complete").click();await expect.poll(()=>completionRequests).toBe(2);expect((await state()).packagePresent).toBe(true);
    await expect(page.locator("#privacy")).not.toBeChecked();
    expect(await page.evaluate(()=>(window as any).__xa11Submit)).toBe(0);
    expect(await page.evaluate(()=>(window as any).__xa16SubmitClicks)).toBe(0);
    network.assertContained();

    await page.close();
  } finally {
    await context.close();
    await fixture.close();
  }
});
