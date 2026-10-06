import { OwnedPackageFixture } from "./owned-package-fixture";
import { containSyntheticNetwork } from "./network-containment";
import {test,expect,chromium} from '@playwright/test';
import fs from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import {createServer} from 'node:http';
const DIST=process.env.XA_E2E_DIST??path.resolve('dist-e2e-granted');
const controls=`<h1>Apply for Software Engineer</h1><form><label>First name <input id="first" name="first_name" autocomplete="given-name"></label><label>Email <input id="email" name="email" type="email" autocomplete="email"></label><label>Why join? <textarea id="manual" name="motivation"></textarea></label><label><input id="privacy" name="privacy" type="checkbox"> I agree to the privacy policy</label><button id="submit" type="submit">Submit application</button></form>`;
const tracked=`<script>window.audit={inputs:0,submits:0};document.addEventListener('input',()=>audit.inputs++);document.addEventListener('submit',e=>{e.preventDefault();audit.submits++});</script>`;

test('E4O-D-R3 real all-frame recovery preserves qualified living documents and child fill',async()=>{
 test.setTimeout(240_000);
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const url=req.url??'';res.end(url.includes('child-a')?controls+tracked:url.includes('child')?'<p>Employer information</p>'+tracked:url.includes('ordinary')?'<p>Ordinary unrelated page</p>'+tracked:`<h1>Employer application</h1><iframe id="child-a" src="${url}/child-a"></iframe>${url.includes('/apply-a')?`<iframe id="child-b" src="${url}/child-b"></iframe><iframe id="untrusted" src="${base}/untrusted-child"></iframe>`:''}${tracked}`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://localhost:${(server.address() as any).port}`;
 const profile=fs.mkdtempSync(path.join(tmpdir(),'xpertapply-r3-recovery-'));
 const ctx=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:false,args:[`--disable-extensions-except=${DIST}`,`--load-extension=${DIST}`],viewport:{width:1280,height:900}});
 const apiFixture=await new OwnedPackageFixture("<main>Owned API</main>").start();
 const network=await containSyntheticNetwork(ctx);
 const errors:string[]=[];ctx.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,250));});
 try{
 let worker=ctx.serviceWorkers()[0]??await ctx.waitForEvent('serviceworker');const extensionId=new URL(worker.url()).host;
 const makeSession=(id:number)=>({session_id:id,ats_type:'smartrecruiters',official_application_url:origin+(id===3003?'/apply-a':'/apply-b'),job:{title:'Software Engineer',company:'Synthetic Employer'},profile:{first_name:'Riley',email:'riley@example.test'},resume:{status:'not_requested'},cover_letter:{status:'not_requested'}});
 await apiFixture.route('**/application-sessions/token',route=>{const body=JSON.parse(route.request().postData()??'{}');const id=body.session_id??3003;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({session_token:apiFixture.sessionToken,session:makeSession(id)})});});
 await apiFixture.route('**/application-sessions/*/answers',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({answers:['first_name','email'].map(k=>({canonical_key:k,value:k==='email'?'riley@example.test':'Riley',display_value:k==='email'?'riley@example.test':'Riley',source:'profile',confidence:1,sensitive:false,verified:true,requires_review:false})),unresolved_questions:[],refreshed:false})}));
 await apiFixture.route('**/application-sessions/3003',route=>{const id=Number(new URL(route.request().url()).pathname.split('/').pop());return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(makeSession(id))});});
 await apiFixture.route('**/application-sessions/3004',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(makeSession(3004))}));
 for(const id of [3003,3004])for(const endpoint of ['answers/override','resolve-questions','events','autofill-results'])await apiFixture.route(`**/application-sessions/${id}/${endpoint}`,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(endpoint==='answers/override'?{overrides:[]}:endpoint==='resolve-questions'?{request_schema_version:3,answer_contract_version:3,registry_version:'fixture',results:[]}: {})}));
 await worker.evaluate(async base=>chrome.storage.local.set({apiBase:base}),apiFixture.origin);
 const a=await ctx.newPage();await a.goto(origin+'/apply-a');
 const bPromise=ctx.waitForEvent('page');await worker.evaluate(async url=>chrome.windows.create({url,type:'normal'}),origin+'/apply-b');const b=await bPromise;await b.waitForLoadState();
 const ordinary=await ctx.newPage();await ordinary.goto(origin+'/ordinary');
 const tabs=await worker.evaluate(async()=>chrome.tabs.query({}));const aid=tabs.find(t=>t.url===origin+'/apply-a')!.id!;const bid=tabs.find(t=>t.url===origin+'/apply-b')!.id!;const cid=tabs.find(t=>t.url===origin+'/ordinary')!.id!;
 const instrument=async(id:number)=>worker.evaluate(async id=>{await chrome.scripting.executeScript({target:{tabId:id,allFrames:true},func:()=>{
 const world=globalThis as any;if(world.__r3Frame)return;const m=world.__r3Frame={signals:0,ready:0,accepted:0,rejected:0,lastError:null,context:0,view:0,queries:0,formMutations:0,notifications:new Set(),lifecycle:new Map(),timers:new Set()};
 const form=document.querySelector('form');if(form)new MutationObserver(records=>{m.formMutations+=records.length;}).observe(form,{subtree:true,attributes:true,childList:true,characterData:true});
 const add=chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage),remove=chrome.runtime.onMessage.removeListener.bind(chrome.runtime.onMessage);
 chrome.runtime.onMessage.addListener=(listener)=>{if(listener.toString().includes('.OVERLAY_VIEW_CHANGED'))m.notifications.add(listener);add(listener);};
 chrome.runtime.onMessage.removeListener=(listener)=>{m.notifications.delete(listener);remove(listener);};
 const eventAdd=EventTarget.prototype.addEventListener,eventRemove=EventTarget.prototype.removeEventListener;
 EventTarget.prototype.addEventListener=function(type,callback,options){if((this===window||this===document)&&typeof callback==='function'&&['recover','onVisibilityChange'].includes(callback.name)){if(!m.lifecycle.has(type))m.lifecycle.set(type,new Set());m.lifecycle.get(type).add(callback);}return eventAdd.call(this,type,callback,options);};
 EventTarget.prototype.removeEventListener=function(type,callback,options){m.lifecycle.get(type)?.delete(callback);return eventRemove.call(this,type,callback,options);};
 const interval=window.setInterval.bind(window),clear=window.clearInterval.bind(window);
 window.setInterval=((fn:any,ms:any,...args:any[])=>{const id=interval(fn,ms,...args);if(ms===1000)m.timers.add(id);return id;}) as typeof window.setInterval;
 window.clearInterval=(id)=>{m.timers.delete(id);clear(id);};
 const query=document.querySelector.bind(document),queries=document.querySelectorAll.bind(document),elementQueries=Element.prototype.querySelectorAll;
 document.querySelector=((sel:string)=>{m.queries++;return query(sel);}) as typeof document.querySelector;
 document.querySelectorAll=((sel:string)=>{m.queries++;return queries(sel);}) as typeof document.querySelectorAll;
 Element.prototype.querySelectorAll=(function(this:Element,sel:string){if(this.getRootNode()===document)m.queries++;return elementQueries.call(this,sel);}) as typeof Element.prototype.querySelectorAll;
 const original=chrome.runtime.sendMessage.bind(chrome.runtime);
 (chrome.runtime as any).sendMessage=(message:any,cb:any)=>{if(message.type==='JOBPILOT_CONTENT_READY')m.ready++;if(message.type==='XPERTAPPLY_OVERLAY_GET_CONTEXT')m.context++;if(message.type==='XPERTAPPLY_OVERLAY_GET_VIEW')m.view++;
 return original(message,(response:any)=>{void chrome.runtime.lastError;if(message.type==='JOBPILOT_CONTENT_READY'){if(response?.matched&&response?.session)m.accepted++;else m.rejected++;m.lastError=response?.error??null;}if(typeof cb==='function')cb(response);});};
 chrome.runtime.onMessage.addListener(mess=>{if(mess.type==='JOBPILOT_CONTENT_RECONNECT')m.signals++;return false;});
 }});},id);
 const seed=async(id:number,url:string,sessionId:number)=>{
 await instrument(id);
 await worker.evaluate(async({id,url,sessionId})=>{const now=Date.now();await chrome.storage.session.set({activeAssistedApplyHandoffV1:{version:1,applicationId:`r3-${sessionId}`,jobId:String(sessionId),applicationUrl:url,status:'prepared',handoffToken:'synthetic-handoff',requestId:`r3-${sessionId}`,sessionId,launchToken:'synthetic-launch',officialUrl:url,expectedOrigin:new URL(url).origin,createdAt:now,expiresAt:now+900000,state:'waiting_for_content_script',protocolVersion:3,atsType:'smartrecruiters'}});
 // Explicit fixture bootstrap, never passive worker recovery. Loading the
 // toolbar receiver in all test frames keeps initial discovery read-only.
 await chrome.scripting.executeScript({target:{tabId:id,allFrames:true},files:['overlayBootstrap.js']});
 await chrome.scripting.executeScript({target:{tabId:id,allFrames:true},files:['content.js']});
 await chrome.tabs.sendMessage(id,{type:'XPERTAPPLY_SHOW_APPLICATION_OVERLAY'},{frameId:0});
 },{id,url,sessionId});};
 const topology=async(id:number)=>worker.evaluate(async id=>(await chrome.scripting.executeScript({target:{tabId:id,allFrames:true},func:()=>{const w=globalThis as any,m=w.__r3Frame;return {url:location.origin+location.pathname,signals:m?.signals??0,ready:m?.ready??0,accepted:m?.accepted??0,rejected:m?.rejected??0,lastError:m?.lastError??null,context:m?.context??0,view:m?.view??0,queries:m?.queries??0,formMutations:m?.formMutations??0,notificationListeners:m?.notifications.size??0,lifecycleListeners:m?Array.from(m.lifecycle.values() as Iterable<Set<Function>>).reduce((n,s)=>n+s.size,0):0,periodicViewTimers:m?.timers.size??0,controllers:w.__xpertapplyAssistantMountsV1__?.has(document)?1:0,host:document.querySelectorAll('#xpertapply-assistant-overlay-v1').length};}})).map(r=>({frameId:r.frameId,documentId:r.documentId,...r.result as any})),id);
 await seed(aid,origin+'/apply-a',3003);await seed(bid,origin+'/apply-b',3004);
 await expect.poll(async()=> (await topology(aid)).filter(r=>r.accepted>0).length).toBe(3);
 await expect.poll(async()=> (await topology(bid)).filter(r=>r.accepted>0).length).toBe(2);
 const before={a:await topology(aid),b:await topology(bid)};
 expect(before.a.find(r=>r.url.includes('127.0.0.1'))).toMatchObject({accepted:0,lastError:'FRAME_ORIGIN_NOT_IN_WORKFLOW'});
 const mutations=async()=>Promise.all([a,b].map(p=>Promise.all(p.frames().map(f=>f.evaluate(()=>({inputs:(window as any).audit?.inputs??0,submits:(window as any).audit?.submits??0}))))));
 expect((await mutations()).flat().reduce((s,v)=>s+v.inputs,0)).toBe(0);
 // Removed context cannot answer; replaced context must register under its
 // new Chrome document identity using the normal explicit fixture lifecycle.
 const removed=before.a.find(r=>r.url.endsWith('child-b'))!;
 await a.evaluate(()=>document.querySelector('#child-b')!.remove());
 const oldChild=before.a.find(r=>r.url.endsWith('child-a'))!;
 await a.evaluate(()=>{(document.querySelector('#child-a') as HTMLIFrameElement).src='/apply-a/child-a-replaced';});
 await expect.poll(()=>a.frames().some(f=>f.url().endsWith('child-a-replaced'))).toBe(true);
 await instrument(aid);
 await worker.evaluate(async id=>{await chrome.scripting.executeScript({target:{tabId:id,allFrames:true},files:['overlayBootstrap.js']});await chrome.scripting.executeScript({target:{tabId:id,allFrames:true},files:['content.js']});},aid);
 await expect.poll(async()=> (await topology(aid)).filter(r=>r.accepted>0).length).toBe(2);
 const stopAndWake=async()=>{
 const prior={a:await topology(aid),b:await topology(bid)};
 const internals=await ctx.newPage();await internals.goto('chrome://serviceworker-internals');const reg=internals.locator('.serviceworker-registration').filter({hasText:extensionId});await expect(reg).toHaveCount(1);await reg.getByRole('button',{name:'Stop'}).click();await expect.poll(async()=>(await reg.innerText()).toLowerCase()).toContain('stopped');
 await internals.close();await a.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect.poll(async()=>{const w=ctx.serviceWorkers().find(w=>w.url().includes(extensionId));return w?.evaluate(()=>true).catch(()=>false)??false;}).toBe(true);
 worker=ctx.serviceWorkers().find(w=>w.url().includes(extensionId))!;
 await expect.poll(async()=> (await topology(aid)).filter(r=>r.url.includes('localhost')&&r.ready>(prior.a.find(x=>x.documentId===r.documentId)?.ready??0)&&r.accepted>0).length).toBe(prior.a.filter(r=>r.url.includes('localhost')).length);
 await expect.poll(async()=> (await topology(bid)).filter(r=>r.ready>(prior.b.find(x=>x.documentId===r.documentId)?.ready??0)&&r.accepted>0).length).toBe(prior.b.length);
 const after={a:await topology(aid),b:await topology(bid)};
 for(const key of ['a','b'] as const){expect(after[key].map(r=>[r.frameId,r.documentId])).toEqual(prior[key].map(r=>[r.frameId,r.documentId]));for(const row of after[key])expect(row.signals-(prior[key].find(x=>x.documentId===row.documentId)?.signals??0)).toBe(1);expect(after[key].filter(r=>r.host===1)).toHaveLength(1);for(const row of after[key]){expect(row.controllers).toBe(row.frameId===0?1:0);expect(row.notificationListeners).toBe(row.frameId===0?1:0);expect(row.lifecycleListeners).toBe(row.frameId===0?3:0);expect(row.periodicViewTimers).toBe(0);}}
 expect(await worker.evaluate(()=>typeof chrome.webNavigation)).toBe('undefined');
 expect((await mutations()).flat().reduce((s,v)=>s+v.inputs,0)).toBe(0);
 };
 for(let cycle=0;cycle<5;cycle++)await stopAndWake();
 const after={a:await topology(aid),b:await topology(bid)};
 expect(after.a.some(r=>r.documentId===removed.documentId)).toBe(false);expect(after.a.some(r=>r.documentId===oldChild.documentId)).toBe(false);
 // A newly created frame uses the normal bootstrap/CONTENT_READY path, with
 // no new broadcast or worker restart. It cannot inherit another frame ID.
 await b.evaluate(()=>{const f=document.createElement('iframe');f.id='new-child';f.src='/apply-b/new-child';document.body.append(f);});
 await expect.poll(()=>b.frames().some(f=>f.url().endsWith('new-child'))).toBe(true);await instrument(bid);
 const newFrame=(await topology(bid)).find(r=>r.url.endsWith('new-child'))!;
 await worker.evaluate(async({id,frameId})=>{await chrome.scripting.executeScript({target:{tabId:id,frameIds:[frameId]},files:['overlayBootstrap.js']});await chrome.scripting.executeScript({target:{tabId:id,frameIds:[frameId]},files:['content.js']});},{id:bid,frameId:newFrame.frameId});
 await expect.poll(async()=> (await topology(bid)).find(r=>r.documentId===newFrame.documentId)?.accepted??0).toBe(1);
 expect((await topology(bid)).find(r=>r.documentId===newFrame.documentId)?.signals).toBe(0);
 // Duplicate probes cannot grow registration/controller ownership or mutate
 // the employer form. Independent CONTENT_READY replies still carry authority.
 const duplicateBefore={a:await topology(aid),b:await topology(bid)};
 await worker.evaluate(async ids=>{for(const id of ids)await Promise.all([chrome.tabs.sendMessage(id,{type:'JOBPILOT_CONTENT_RECONNECT'}),chrome.tabs.sendMessage(id,{type:'JOBPILOT_CONTENT_RECONNECT'})]);},[aid,bid]);
 await expect.poll(async()=> (await topology(aid)).filter(r=>r.url.includes('localhost')&&r.ready>duplicateBefore.a.find(x=>x.documentId===r.documentId)!.ready).length).toBe(2);
 const duplicateAfter={a:await topology(aid),b:await topology(bid)};
 for(const key of ['a','b'] as const)expect(duplicateAfter[key].map(r=>[r.frameId,r.documentId,r.controllers,r.notificationListeners,r.lifecycleListeners])).toEqual(duplicateBefore[key].map(r=>[r.frameId,r.documentId,r.controllers,r.notificationListeners,r.lifecycleListeners]));
 await a.waitForTimeout(500);
 let idleNetwork=0;const countRequest=()=>{idleNetwork++;};
 const idleBefore={a:await topology(aid),b:await topology(bid)};ctx.on('request',countRequest);
 await a.waitForTimeout(60_000);ctx.off('request',countRequest);
 const idleAfter={a:await topology(aid),b:await topology(bid)};const idleDeltas:any[]=[];
 for(const key of ['a','b'] as const)for(const row of idleAfter[key]){const old=idleBefore[key].find(x=>x.documentId===row.documentId)!;const delta={context:row.context-old.context,view:row.view-old.view,recoverySignals:row.signals-old.signals,ready:row.ready-old.ready,discoveryQueries:row.queries-old.queries-1};idleDeltas.push(delta);expect(delta).toEqual({context:0,view:0,recoverySignals:0,ready:0,discoveryQueries:0});}
 expect(idleNetwork).toBe(0);expect((await mutations()).flat().reduce((s,v)=>s+v.inputs,0)).toBe(0);
 expect((await topology(aid)).concat(await topology(bid)).reduce((n,r)=>n+r.formMutations,0)).toBe(0);
 const fill=a.locator('#xpertapply-assistant-overlay-v1').locator('#fill');await expect(fill).toBeEnabled();await fill.click();
 const child=a.frames().find(f=>f.url().endsWith('child-a-replaced'))!;
 await expect(child.locator('#first')).toHaveValue('Riley');await expect(child.locator('#email')).toHaveValue('riley@example.test');await expect(child.locator('#manual')).toHaveValue('');await expect(child.locator('#privacy')).not.toBeChecked();
 expect((await mutations()).flat().reduce((s,v)=>s+v.submits,0)).toBe(0);
 await expect.poll(async()=> (await topology(aid)).find(r=>r.url.includes('127.0.0.1'))?.accepted).toBe(0);
 const noReceiver=await worker.evaluate(async id=>{try{await chrome.tabs.sendMessage(id,{type:'JOBPILOT_CONTENT_RECONNECT'});return false;}catch{return true;}},cid);expect(noReceiver).toBe(true);expect(await ordinary.locator('#xpertapply-assistant-overlay-v1').count()).toBe(0);
 const normalWindows=await worker.evaluate(async({a,b})=>{const ta=await chrome.tabs.get(a),tb=await chrome.tabs.get(b);return {a:ta.windowId,b:tb.windowId};},{a:aid,b:bid});expect(normalWindows.a).not.toBe(normalWindows.b);


 expect(errors.filter(e=>/webNavigation|getAllFrames|Unhandled|TypeError/.test(e))).toEqual([]);
 network.assertContained();
 }finally{await ctx.close();await apiFixture.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(profile,{recursive:true,force:true});}
});
