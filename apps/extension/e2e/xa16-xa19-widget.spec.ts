import { expect, test, chromium } from "@playwright/test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WidgetDriver } from "./widget-driver";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION = path.resolve(here, "..", "dist");

const FIXTURE = `<!doctype html><title>Apply</title><main><h1>Apply for this job</h1>
  <form id="application">
    <label for="first_name">First name</label><input id="first_name" name="first_name" required>
    <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <button type="submit" id="submit">Submit application</button>
  </form></main>
  <script>
    window.__xa11Submit = 0;
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
          if (node.id === 'jobpilot-assisted-apply' || node.querySelector?.('#jobpilot-assisted-apply')) {
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
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(FIXTURE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://localhost:${(server.address() as { port: number }).port}`;
  const applicationUrl = `${origin}/apply`;
  const DIST = mkdtempSync(path.join(tmpdir(), "xa1619-production-"));
  cpSync(PRODUCTION, DIST, { recursive: true });
  // Only fixture origin permission changes: all production JS bytes are retained.
  const manifestPath = path.join(DIST, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.version_name).toContain("production");
  manifest.host_permissions.push(`${origin}/*`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const control = process.env.XA1619_NEGATIVE_CONTROL;
  if (control) {
    const file = path.join(DIST, "content.js");
    let source = readFileSync(file, "utf8");
    if (control === "semantics") {
      source = source.replace('<section class="box" aria-labelledby="xpertapply-heading">', '<section class="box" aria-live="polite">')
        .replace('class="message" role="status" aria-atomic="true"', 'class="message"');
    } else if (control === "layout") {
      const footer = source.match(/      <footer class="footer">[\s\S]*?<\/footer>/)?.[0];
      expect(footer).toBeTruthy();
      source = source.replace(footer!, "").replace('<details class="more-actions">', '<button type="button" data-a="complete">Mark application complete</button><details class="more-actions">')
        .replace('max-height:min(780px,calc(100vh - 36px));max-height:min(780px,calc(100dvh - 36px));', 'max-height:min(82vh,780px);');
    } else throw new Error("Unknown negative control");
    writeFileSync(file, source);
  }
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
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
    await context.route("**/application-sessions/token", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session_token: "xa11-token", session })
    }));
    await context.route("**/application-sessions/*/answers", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ answers, unresolved_questions: [], refreshed: false, profile_revision: "r" })
    }));
    await context.route("**/application-sessions/*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session)
    }));

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    await worker.evaluate(async (url) => {
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

    const page = await context.newPage();

    await page.goto(applicationUrl);
    // Inject the unchanged production employer entrypoint into the fixture.
    await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({url}))[0];
      await chrome.scripting.executeScript({target:{tabId:tab.id!},files:["content.js"]});
    }, applicationUrl);
    await expect(page.locator("#email")).toHaveValue("candidate@example.test", { timeout: 20_000 });
    await page.waitForSelector("#jobpilot-assisted-apply", { state: "attached" });
    const widget = await WidgetDriver.attach(page);
    await expect.poll(() => widget.summary()).toMatchObject({ title: "Autofill incomplete" });

    const cdp = await context.newCDPSession(page);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id!, applicationUrl);
    const baseline = process.env.XA1619_BASELINE === "1";
    const results = [];
    for (const [width, height] of [[1280,720],[1366,768],[1440,900],[1280,640],[1280,600],[320,720],[375,720],[768,720]]) {
      await page.setViewportSize({width,height});
      for (const zoom of (width === 1280 && height === 720 ? [1,1.25,1.5,2] : [1])) {
        await worker.evaluate(async ({tabId,zoom}) => chrome.tabs.setZoom(tabId,zoom), {tabId,zoom});
        await page.waitForTimeout(100);
        const measurement = await widget.inspectLayout();
        const record = {width,height,zoom,...measurement};
        results.push(record);
        if (!baseline) {
          expect(measurement.live).toEqual([{tag:"DIV",role:"status",live:null,atomic:"true",className:"message"}]);
          expect(measurement.name).toBe("XpertApply assisted application");
          expect(measurement.panelLive).toBeNull();
          expect(measurement.actionVisible).toBe(true);
          expect(measurement.box.top).toBeGreaterThanOrEqual(0);
          expect(measurement.box.bottom).toBeLessThanOrEqual(measurement.viewport.height);
          expect(measurement.horizontalOverflow).toBe(false);
        }
      }
    }
    await worker.evaluate(async tabId => chrome.tabs.setZoom(tabId,1), tabId);
    await page.setViewportSize({width:1280,height:720});
    await widget.openReview();
    console.log("XA1619_REVIEW " + await widget.probe<string>(`function(){return this.querySelector('.body').innerText}`));
    // Baseline scroll reachability is measured separately from initial clipping.
    const scrollReachability = await widget.probe(`function(){
      const body=this.querySelector('.body');body.scrollTop=body.scrollHeight;
      const b=this.querySelector('[data-a="complete"]').getBoundingClientRect();
      return {top:b.top,bottom:b.bottom,viewport:innerHeight,scrollTop:body.scrollTop};
    }`);
    console.log("XA1619_SCROLL " + JSON.stringify(scrollReachability));
    if (!baseline) {
      // Native Tab traversal reaches Clear through the disclosure without a trap.
      await widget.probe(`function(){this.querySelector('.more-actions').open=true;this.querySelector('.collapse').focus()}`);
      const tabNames: string[]=[];
      for(let i=0;i<40;i++) {
        await page.keyboard.press("Tab");
        const name=await widget.probe<string>(`function(){return this.activeElement?.textContent?.trim()||this.activeElement?.getAttribute('placeholder')||''}`);
        tabNames.push(name);
        if(name==='Clear XpertApply-filled fields') break;
      }
      expect(tabNames).toContain("Clear XpertApply-filled fields");
      console.log("XA1619_KEYBOARD " + JSON.stringify(tabNames));
      // Deliberate presentation stress only: clone real review cards to 500
      // entries. This does not assert that synthetic cards alter the ledger.
      await widget.probe(`function(){
        const panel=this.querySelector('.review-panel');
        const sample=panel.querySelector('.item');
        if(!sample) throw new Error('No production review card');
        for(let i=0;i<500;i++){
          const card=sample.cloneNode(true);card.removeAttribute('data-item');card.classList.add('xa-density-stress');
          card.querySelector('.q').textContent='Long review field '+i+' '+ 'LongLabel'.repeat(30);
          panel.append(card);
        }
        this.querySelector('.message').textContent='Unable to save completion. '+ 'Long validation detail. '.repeat(80);
        this.querySelector('.body').scrollTop=0;
      }`);
      for (const height of [900,600,640,720,900]) {
        await page.setViewportSize({width:1280,height});
        const state=await widget.inspectLayout();
        expect(state.actionVisible).toBe(true);
        expect(state.body.scrollHeight).toBeGreaterThan(state.body.clientHeight);
        expect(state.horizontalOverflow).toBe(false);
        const focus=await widget.probe<any>(`function(){
          this.querySelector('.collapse').focus();const button=this.querySelector('.review-panel .item:last-child button');button.focus();
          const r=button.getBoundingClientRect(),b=this.querySelector('.body').getBoundingClientRect();
          return {focused:this.activeElement===button,top:r.top,bottom:r.bottom,bodyTop:b.top,bodyBottom:b.bottom};
        }`);
        expect(focus.focused).toBe(true);
        expect(focus.top).toBeGreaterThanOrEqual(focus.bodyTop);
        expect(focus.bottom).toBeLessThanOrEqual(focus.bodyBottom);
      }
      await widget.probe(`function(){this.querySelectorAll('.xa-density-stress').forEach(el=>el.remove())}`);
      await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
      await page.setViewportSize({width:1280,height:600});
      const colors=await widget.probe<any>(`function(){
        const b=this.querySelector('.collapse');b.focus();const s=getComputedStyle(b);
        return {outline:s.outlineStyle,outlineWidth:s.outlineWidth,border:getComputedStyle(this.querySelector('.box')).borderTopStyle,transition:s.transitionDuration};
      }`);
      expect(colors).toEqual({outline:"solid",outlineWidth:"3px",border:"solid",transition:"0s"});
      await page.screenshot({path:"/tmp/xa1619-forced-colors.png"});
      await page.emulateMedia({forcedColors:"none",reducedMotion:"no-preference"});
      await page.screenshot({path:"/tmp/xa1619-layout.png"});
      // Observe only the widget after settling; no production polling added.
      const mutations=await widget.probe<number>(`async function(){
        let count=0;const observer=new MutationObserver(r=>count+=r.length);
        observer.observe(this,{subtree:true,childList:true,attributes:true,characterData:true});
        await new Promise(resolve=>setTimeout(resolve,500));observer.disconnect();return count;
      }`);
      expect(mutations).toBe(0);
    }
    // Resolve the two real required review cards through their production handlers.
    if (!baseline) {
      // Restore short status after synthetic density stress.
      await widget.probe(`function(){this.querySelector('.message').textContent='Review your application.'}`);
      for(const value of ["Test", "Candidate"]) {
        await widget.probe(`function(){
          const card=this.querySelector('.review-panel .item:not(.resolved)');
          const save=card.querySelector('label.save input');if(save) save.checked=false;
          card.querySelector('input[type="text"]').focus();
        }`);
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type(value);
        await widget.probe(`function(){this.querySelector('.review-panel .item:not(.resolved) .row button').click()}`);
        await page.waitForTimeout(100);
      }
      await expect.poll(()=>widget.probe<boolean>(`function(){return this.querySelector('[data-a="complete"]').disabled}`)).toBe(false);
      await widget.probe(`function(){this.querySelector('.more-actions').open=true;this.querySelector('[data-a="clear"]').focus()}`);
      let reached=false;
      for(let i=0;i<15;i++) {
        await page.keyboard.press("Tab");
        reached=await widget.probe<boolean>(`function(){return this.activeElement===this.querySelector('[data-a="complete"]')}`);
        if(reached)break;
      }
      expect(reached).toBe(true);
      expect((await widget.inspectLayout()).actionVisible).toBe(true);
      let completionRequests=0;
      await context.route("**/application-sessions/*/complete", route => {
        completionRequests++;
        return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({detail:"Synthetic completion rejection"})});
      });
      await page.keyboard.press("Enter");
      await expect.poll(()=>widget.message()).toBe("Application completion could not be saved. Please try again.");
      expect(completionRequests).toBe(1);
      expect((await widget.inspectLayout()).actionVisible).toBe(true);
      expect(await widget.probe<boolean>(`function(){return this.querySelector('[data-a="complete"]').disabled}`)).toBe(false);
      await page.keyboard.press("Tab");
      expect(await widget.probe<boolean>(`function(){return Boolean(this.activeElement)}`)).toBe(false);
    }
    const tree = await cdp.send("Accessibility.getFullAXTree");
    const semantics = tree.nodes.filter(n => ["region","status","note","heading","button"].includes(String(n.role?.value)))
      .map(n => ({role:n.role?.value,name:n.name?.value,properties:n.properties}));
    console.log("XA1619_EVIDENCE " + JSON.stringify({baseline,results,semantics}));
    expect(await page.evaluate(() => (window as any).__xa11Submit)).toBe(0);
    if (!baseline) {
      expect(semantics.filter(n => n.role === "region" && n.name === "XpertApply assisted application")).toHaveLength(1);
      expect(semantics.filter(n => n.role === "status")).toHaveLength(1);
      expect(semantics.filter(n => n.role === "note")).toHaveLength(3);
    }
    await page.close();
  } finally {
    await context.close();
    rmSync(DIST, {recursive:true,force:true});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
