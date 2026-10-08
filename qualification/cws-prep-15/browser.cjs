'use strict';
// Shared observation contract lives in this authorized helper; importing it runs no browser.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => ({ utc: new Date().toISOString(), monotonicMs: performance.now() });
const known = new Set(['/', '/login', '/signup', '/pricing', '/privacy', '/opensource', '/dashboard', '/auth/google/callback', '/csp-qualification-error', '/unknown-csp-qualification', '/this-route-must-not-exist-csp-test', '/auth/providers', '/dashboard/summary', '/csp-error.css', '/favicon.ico']);
function urlEvidence(value) {
  try {
    const u = new URL(value);
    return { origin: ['http://127.0.0.1:3550', 'http://127.0.0.1:3551', 'http://127.0.0.1:3552', 'https://api.xpertapply.com'].includes(u.origin) ? u.origin : 'UNAPPROVED_ORIGIN',
      path: known.has(u.pathname) || /^\/_next\/static\/[a-zA-Z0-9_./%-]+$/.test(u.pathname) ? u.pathname : null,
      pathCategory: known.has(u.pathname) ? 'QUALIFICATION_ROUTE' : u.pathname.startsWith('/_next/static/') ? 'STATIC' : 'UNKNOWN',
      pathFingerprint: known.has(u.pathname) ? null : hash(u.pathname), _rscPresent: u.searchParams.has('_rsc') };
  } catch { return { origin: 'INVALID', path: null, pathCategory: 'INVALID' }; }
}
function sanitize(text) {
  // Arbitrary diagnostic text is fingerprinted, not retained: tokens need not resemble URLs.
  return { textFingerprint: hash(String(text)), knownError: /CSP_QUAL_FATAL_ROUTER_URL/.test(String(text)) ? 'CSP_QUAL_FATAL_ROUTER_URL' : /An error occurred in the Server Components render/.test(String(text)) ? 'INJECTED_SERVER_RENDER_ERROR' : null };
}
function atomic(dir, name, value) { const p = path.join(dir, name + '.json'); fs.writeFileSync(p + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(p + '.tmp', p); }
function canonicalNonce(n) { return typeof n === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(n) && Buffer.from(n, 'base64').length === 16 && Buffer.from(n, 'base64').toString('base64') === n; }
function policyEvidence(headers, html) {
  const entries = Array.isArray(headers) ? headers : Object.entries(headers).map(([name, value]) => ({name, value}));
  const values = name => entries.filter(h => h.name.toLowerCase() === name).map(h => h.value);
  const policies = values('content-security-policy'), csp = policies[0] || '';
  const nonces = [...csp.matchAll(/'nonce-([^']+)'/g)].map(m => m[1]), n = nonces[0];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/\bsrc\s*=/.test(m[1]));
  const scriptMatches = scripts.map(m => m[1].match(/\bnonce="([^"]+)"/)?.[1] === n);
  const directives = Object.fromEntries(csp.split(';').map(s => s.trim().split(/\s+/)).filter(s => s[0]).map(([k,...v]) => [k,v]));
  const template=csp.replace(/'nonce-[^']+'/g,"'nonce-REDACTED'"), expected=process.env.QUAL_POLICY_TEMPLATE;
  const styleHash = "'sha256-Wwucq8eX2r0YFymkQhDXm5hN0+FfSvI3s4JSSaqa4iw='";
  const cache = values('cache-control').join(',');
  return { nonceFingerprint: n ? hash(n) : null, nonceValid: canonicalNonce(n), cspCount: policies.length, reportOnlyCount: values('content-security-policy-report-only').length,
    scriptCount: scripts.length, scriptAuthority: scripts.length > 0 && scriptMatches.every(Boolean), headerBodyMismatches: scriptMatches.filter(x => !x).length,
    missingScriptNonces: scripts.filter(m => !/\bnonce="[^"]+"/.test(m[1])).length,
    policyPass: !!expected && template===expected && policies.length === 1 && values('content-security-policy-report-only').length === 0 && nonces.length === 1 && canonicalNonce(n) &&
      (directives['script-src'] || []).includes("'self'") && !(directives['script-src'] || []).some(v => ["'unsafe-inline'", "'unsafe-eval'"].includes(v)) &&
      (directives['style-src'] || []).includes(styleHash) && !(directives['style-src'] || []).includes("'unsafe-inline'") && !Object.values(directives).flat().some(v => v.includes('*')),
    fatalStyleControl: JSON.stringify(directives['style-src'])===JSON.stringify(["'self'"]) ? 'remove' : JSON.stringify(directives['style-src'])===JSON.stringify(["'self'","'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='"]) ? 'wrong' : null,
    fatalControlBasePass: !!expected && [expected.replace(' '+styleHash,''),expected.replace(styleHash,"'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='")].includes(template) && policies.length===1 && values('content-security-policy-report-only').length===0 && nonces.length===1 && canonicalNonce(n) && JSON.stringify(directives['script-src'])===JSON.stringify(["'self'","'nonce-"+n+"'"]) && !Object.values(directives).flat().some(v=>v.includes('*')||v==="'unsafe-eval'") && !(directives['style-src']||[]).includes("'unsafe-inline'"),
    htmlCachePass: /(?:^|[,\s])private(?:[,\s]|$)/.test(cache) && /(?:^|[,\s])no-store(?:[,\s]|$)/.test(cache), poweredByAbsent: values('x-powered-by').length === 0 };
}
class Ledger {
  constructor(dir, phase) { this.dir = dir; this.phase = phase; this.records = new Map(); this.file = path.join(dir, phase + '-nonces.jsonl'); fs.writeFileSync(this.file, ''); }
  add(documentId, requestId, scenario, route, status, authority) {
    const record = {schema:1, runId:process.env.GITHUB_RUN_ID, sha:process.env.GITHUB_SHA, phase:this.phase, documentId, requestId, scenario, route:urlEvidence(route), status, ...authority};
    const previous = this.records.get(documentId);
    if (previous) { if (JSON.stringify(previous) !== JSON.stringify(record)) throw Error('conflicting document observation'); return previous; }
    this.records.set(documentId, record); fs.appendFileSync(this.file, JSON.stringify(record) + '\n'); return record;
  }
}
function requiredKind(r) {
  if (r.isNavigationRequest || r.resourceType === 'document') return 'NAVIGATION_DOCUMENT_FAILURE';
  if (r.resourceType === 'script') return 'REQUIRED_JS_FAILURE';
  if (r.resourceType === 'stylesheet') return 'REQUIRED_CSS_FAILURE';
  if (r.purpose === 'API' || r.url.origin === 'https://api.xpertapply.com') return 'APPLICATION_API_FAILURE';
  if (r.purpose === 'REQUIRED_RESOURCE') return 'REQUIRED_RESOURCE_FAILURE';
  return null;
}
function healthy(c) { return !!c && c.pass === true && c.routeMarkerResult === true && c.expectedURL === c.actualURL && c.expectedStatus === c.actualStatus && c.documentNonceAuthority === true && c.cspEvents === 0 && c.pageErrors === 0 && c.requiredFailures === 0 && c.clientProof === true; }
function classify(r, checkpoints) {
  const hard = requiredKind(r); if (hard) return hard;
  const checkpoint = checkpoints.find(c => c.checkpointId === r.checkpointId);
  const superseded = !!r.failure && checkpoint?.pageId===r.pageId && checkpoint?.navigationId===r.supersedingNavigationId && checkpoint?.timestamp?.monotonicMs>=r.supersedingTimestampMs && !!r.supersedingNavigationId && r.supersedingTimestampMs >= r.start.monotonicMs && r.failure.monotonicMs >= r.supersedingTimestampMs;
  const teardown = !!r.failure && checkpoint?.pageId===r.pageId && checkpoint?.timestamp?.monotonicMs<=r.teardownTimestampMs && r.teardownKnownOutstanding === true && r.teardownTimestampMs >= r.start.monotonicMs && r.failure.monotonicMs >= r.teardownTimestampMs;
  const background = r.rscMarker === true || r.prefetchMarker === true;
  if (background && r.errorText === 'net::ERR_ABORTED' && (superseded || teardown) && healthy(checkpoint)) return r.prefetchMarker ? 'PREFETCH_EXPECTED_CANCELLATION' : 'RSC_EXPECTED_CANCELLATION';
  return r.rscMarker ? 'RSC_UNEXPECTED_FAILURE' : 'OTHER_UNEXPECTED_FAILURE';
}
function assetStatus(r, verifiedCache = new Set()) {
  if (r.status >= 300 && r.status < 400 && r.status !== 304) return r.redirectApproved === true && r.terminalStatus===200 && r.terminalTypeValid===true;
  if (r.status === 304) return (verifiedCache.has(r.assetKey)||r.cacheAssociationVerified===true) && r.typeValid === true;
  return r.status === 200 && r.typeValid === true;
}
function clientProof(kind, p) {
  const transition = p.action === true && p.before !== p.after && p.afterExpected === true;
  switch (kind) {
    case 'callback': return p.status === 200 && p.route === '/auth/google/callback' && p.id === 'google-link-error' && p.role === 'alert' && p.text === 'The Google sign-in completion is missing. Please try again.';
    case 'segment': case 'global': return transition && p.faultCleared === true && p.errorGone === true && p.unrelatedGoto === false && (kind !== 'global' || p.landingInteraction === true);
    case '404': return p.status === 404 && p.heading === 'Page not found' && p.homeNavigation === true && p.landingInteraction === true;
    case 'password': return p.before === 'password' && p.after === 'text' && p.restored === 'password' && p.action === true;
    default: return transition;
  }
}
const dashboardSummary = {freshMatches:4, applications:{saved:2,inProgress:1,interviews:1,offers:0}, recentApplications:[], topMatches:[], strongMatches:2, nextAction:{kind:'discover',eyebrow:'Next step',title:'Find your next role',body:'Review the latest jobs selected for your search.',href:'/jobs',cta:'Browse jobs',firstName:'Taylor',profileProgress:80}};
function fixture(request, auth, scenario) {
  const u = new URL(request.url());
  if (u.origin !== 'https://api.xpertapply.com' || u.search || request.method() !== 'GET') return null;
  if (u.pathname === '/auth/providers' && !auth && /login|signup|guard|public|landing/.test(scenario)) return {id:'disabled-google-v1', body:{google:{enabled:false}}};
  if (u.pathname === '/dashboard/summary' && auth && scenario === 'auth-dashboard') return {id:'dashboard-summary-v1', body:dashboardSummary};
  return null;
}
function allowLocal(request,origin) {
 const h=request.headers();return new URL(request.url()).origin===origin && (request.isNavigationRequest()||['script','stylesheet','image','font'].includes(request.resourceType())||h.rsc==='1'||h['next-router-prefetch']==='1'||!!h['next-router-segment-prefetch']);
}
class Observer {
  constructor(page, ledger, scenario, pageId) {
    this.page = page; this.ledger = ledger; this.scenario = scenario; this.pageId = pageId; this.requests = []; this.responses = []; this.checkpoints = []; this.csp = []; this.errors = []; this.expectedErrors = []; this.documents = []; this.tasks = []; this.sequence = 0; this.generation = 0; this.outstanding = new Map(); this.lookup = new WeakMap(); this.frameIds = new WeakMap(); this.frameSequence = 0; this.console = []; this.verifiedCache=new Map();
    page.on('request', r => this.request(r));
    page.on('response', r => this.tasks.push(this.response(r)));
    page.on('requestfinished', r => {const x=this.lookup.get(r);if(x){x.lifecycleState='COMPLETED';x.finished=now();this.outstanding.delete(x.requestId);}});
    page.on('requestfailed', r => {const x = this.lookup.get(r) || this.request(r); x.failure = now();x.lifecycleState=x.teardownKnownOutstanding?'FAILED_DURING_TEARDOWN':x.supersedingNavigationId?'FAILED_AFTER_SUPERSEDING_NAVIGATION':'FAILED'; x.errorText = /^net::ERR_[A-Z_]+$/.test(r.failure()?.errorText || '') ? r.failure().errorText : null; this.outstanding.delete(x.requestId);});
    page.on('pageerror', e => {const x = {...sanitize(e.message), scenario:this.scenario, timestamp:now()}; if (x.knownError === 'INJECTED_SERVER_RENDER_ERROR' && this.injectedFaultActive) this.expectedErrors.push(x); else if (x.knownError === 'CSP_QUAL_FATAL_ROUTER_URL' && this.fatalInjected) this.expectedErrors.push(x); else this.errors.push(x);});
    page.on('console', m => this.console.push({type:m.type(),...sanitize(m.text())}));
  }
  async install(context) {
    await context.exposeBinding('__qualCSP', (_, e) => this.csp.push(e));
    await context.addInitScript(() => {window.__qualDocument = crypto.randomUUID(); addEventListener('securitypolicyviolation', e => window.__qualCSP({directive:e.effectiveDirective, disposition:e.disposition, timestamp:Date.now()}));});
  }
  request(r) {
    const headers = r.headers(), rsc = headers.rsc === '1', prefetch = headers['next-router-prefetch'] === '1' || !!headers['next-router-segment-prefetch'];
    let frameId = null, frameUnavailableReason = null;
    try { const f = r.frame(); if (!this.frameIds.has(f)) this.frameIds.set(f, this.pageId + '-frame-' + (++this.frameSequence)); frameId = this.frameIds.get(f); } catch {frameUnavailableReason = 'FRAME_NOT_AVAILABLE';}
    const u = urlEvidence(r.url());
    const x = {schema:1,runId:process.env.GITHUB_RUN_ID,sha:process.env.GITHUB_SHA,phase:this.ledger.phase,scenarioId:this.scenario,pageId:this.pageId, requestId:this.pageId+'-r'+(++this.sequence), frameId,frameUnavailableReason,url:u,method:r.method(),resourceType:r.resourceType(),isNavigationRequest:r.isNavigationRequest(), start:now(),failure:null,errorText:null,responseStatus:null,rscMarker:rsc,prefetchMarker:prefetch,purpose:u.origin === 'https://api.xpertapply.com' || (['fetch','xhr'].includes(r.resourceType())&&!rsc&&!prefetch) ? 'API' : rsc || prefetch ? 'BACKGROUND' : ['image','font'].includes(r.resourceType()) ? 'REQUIRED_RESOURCE' : 'OTHER',navigationGeneration:this.generation,supersedingNavigationId:null,supersedingTimestampMs:null,lifecycleState:'IN_FLIGHT',teardownState:'NOT_STARTED',teardownKnownOutstanding:false,teardownTimestampMs:null,checkpointId:null,classification:null,redirectedFrom:this.lookup.get(r.redirectedFrom())?.requestId || null};
    this.requests.push(x); this.lookup.set(r,x); this.outstanding.set(x.requestId,x); return x;
  }
  navigate(scenario) {
    this.scenario = scenario; this.generation++; const id = this.pageId+'-nav'+this.generation, t = performance.now();
    for (const x of this.outstanding.values()) if (x.rscMarker || x.prefetchMarker) {x.supersedingNavigationId=id; x.supersedingTimestampMs=t;x.lifecycleState='SUPERSEDED_IN_FLIGHT';}
    return id;
  }
  async response(response) {
    const r = response.request(), x = this.lookup.get(r) || this.request(r); x.responseStatus = response.status();
    const h = response.headers(), type = r.resourceType(), rawMime=(h['content-type'] || '').split(';')[0].trim().toLowerCase(), mime=['text/html','text/x-component','text/css','text/javascript','application/javascript','application/ecmascript','text/ecmascript','application/json','image/svg+xml','image/png','image/jpeg','image/webp','image/x-icon','image/avif','font/woff','font/woff2','font/ttf','font/otf','application/font-woff','application/x-font-ttf'].includes(rawMime)?rawMime:'UNAPPROVED_MIME';
    const assetKey=JSON.stringify(x.url),cached=this.verifiedCache.get(assetKey);
    const typeValid = response.status()===304 ? !!cached?.typeValid : type === 'script' ? ['text/javascript','application/javascript','application/ecmascript','text/ecmascript'].includes(mime) : type === 'stylesheet' ? mime === 'text/css' : type==='image'?mime.startsWith('image/'):type==='font'?mime.startsWith('font/')||['application/font-woff','application/x-font-ttf'].includes(mime):mime!=='UNAPPROVED_MIME';
    const redirectApproved = response.status() >= 300 && response.status() < 400 && response.status() !== 304 && !!h.location && /^http:\/\/127\.0\.0\.1:355[012]\//.test(new URL(h.location || '',response.url()).href);
    const evidence={requestId:x.requestId,url:x.url,type,rscMarker:x.rscMarker,navigationGeneration:x.navigationGeneration,status:response.status(),mime,typeValid,redirectApproved,cacheControl:h['cache-control'] || (response.status()===304?cached?.cacheControl:null) || null,assetKey,cacheAssociationVerified:response.status()===304&&!!cached};
    this.responses.push(evidence); if(evidence.status===200&&evidence.typeValid)this.verifiedCache.set(assetKey,evidence);
    if (type === 'document' && r.isNavigationRequest() && mime === 'text/html') {
      const html = await response.text(), authority = policyEvidence(await response.headersArray(),html), documentId = this.pageId+'-doc-'+x.requestId;
      const d = this.ledger.add(documentId,x.requestId,x.scenarioId,response.url(),response.status(),authority); this.documents.push(d);
    }
  }
  async checkpoint(expectedPath, expectedStatus, marker, proof) {
    const deadline=performance.now()+10000;
    while([...this.outstanding.values()].some(r=>requiredKind(r)) && performance.now()<deadline) await new Promise(r=>setTimeout(r,20));
    if([...this.outstanding.values()].some(r=>requiredKind(r))) throw Error('required request did not settle');
    while(this.tasks.length) {const tasks=this.tasks.splice(0); await Promise.all(tasks);}
    const actualURL = new URL(this.page.url()).pathname, latest = this.documents.at(-1);
    const routeResponse=this.responses.filter(r=>r.url.path===actualURL && (r.type==='document'||r.rscMarker)).at(-1);
    const authority = latest && latest.nonceValid && latest.scriptAuthority && (latest.policyPass || (['remove','wrong'].includes(this.fatalControl) && latest.fatalStyleControl===this.fatalControl && latest.fatalControlBasePass)) && latest.htmlCachePass && latest.poweredByAbsent;
    for(const response of this.responses){
      if(response.status>=300&&response.status<400&&response.status!==304){
        let end=response,seen=new Set();
        while(end.status>=300&&end.status<400&&end.status!==304){
          if(seen.has(end.requestId)||!end.redirectApproved){end=null;break;}seen.add(end.requestId);
          const next=this.requests.find(r=>r.redirectedFrom===end.requestId);end=next?this.responses.find(r=>r.requestId===next.requestId):null;if(!end)break;
        }response.terminalStatus=end?.status||null;response.terminalTypeValid=end?.typeValid===true;
      }
    }
    const requiredFailures = this.requests.filter(r => r.failure && requiredKind(r)).length + this.responses.filter(r => ['script','stylesheet','image','font'].includes(r.type) && !assetStatus(r)).length + this.responses.filter(r => r.url.origin === 'https://api.xpertapply.com' && r.status !== 200).length;
    const c = {schema:1,checkpointId:this.pageId+'-checkpoint'+(this.checkpoints.length+1),scenario:this.scenario,pageId:this.pageId,documentId:latest?.documentId || null,navigationGeneration:this.generation,navigationId:this.pageId+'-nav'+this.generation,expectedURL:expectedPath,actualURL,expectedStatus,actualStatus:routeResponse?.status ?? null,originalDocumentStatus:latest?.status || null,statusSource:routeResponse?.type==='document'?'DOCUMENT':'RSC_OR_VERIFIED_ROUTE_RESPONSE',routeMarkerResult:marker,documentNonceAuthority:!!authority,cspEvents:this.fatalInjected&&['remove','wrong','unrelated'].includes(this.fatalControl)?this.csp.filter(e=>e.directive!=='style-src-elem'||e.disposition!=='enforce').length:this.csp.length,pageErrors:this.errors.length,requiredFailures,clientProof:proof,timestamp:now()};
    c.pass = c.expectedURL === c.actualURL && c.expectedStatus === c.actualStatus && marker && !!authority && !c.cspEvents && !c.pageErrors && !requiredFailures && proof;
    this.checkpoints.push(c);
    for (const r of this.requests) if (r.supersedingNavigationId===c.navigationId && r.navigationGeneration < this.generation || r.navigationGeneration===this.generation && !r.checkpointId) r.checkpointId = c.checkpointId;
    if (!c.pass) throw Error('settled checkpoint failed'); return c;
  }
  async close(context) {
    const checkpoint = this.checkpoints.at(-1), t = performance.now();
    for (const x of this.outstanding.values()) {x.teardownKnownOutstanding=true;x.teardownState='INTENTIONAL_TEARDOWN_STARTED'; x.teardownTimestampMs=t; x.checkpointId=checkpoint?.checkpointId || null;}
    await context.close(); while(this.tasks.length){const tasks=this.tasks.splice(0);await Promise.all(tasks);}
    for (const r of this.requests) if (r.failure) r.classification=classify(r,this.checkpoints);
    for(const r of this.outstanding.values()){r.incompleteLifecycle=true;r.lifecycleState='INCOMPLETE_AFTER_TEARDOWN';}
    const hard = this.requests.filter(r => r.incompleteLifecycle || r.failure && !['RSC_EXPECTED_CANCELLATION','PREFETCH_EXPECTED_CANCELLATION'].includes(r.classification));
    const controlsPass=!this.fatalInjected ? this.csp.length===0 : (['remove','wrong','unrelated'].includes(this.fatalControl)?this.csp.length===1&&this.csp[0].directive==='style-src-elem'&&this.csp[0].disposition==='enforce':this.csp.length===0);
    const result = {expectedCSPEvents:this.fatalInjected&&['remove','wrong','unrelated'].includes(this.fatalControl)?this.csp.length:0,scenario:this.scenario,pageId:this.pageId,requests:this.requests,responses:this.responses,checkpoints:this.checkpoints,documents:this.documents,csp:this.csp,errors:this.errors,expectedErrors:this.expectedErrors,console:this.console,hardFailures:hard.length,pass:!!checkpoint && this.checkpoints.every(c=>c.pass) && !hard.length && !this.errors.length && controlsPass};
    return result;
  }
}
async function landing(page, mobile) {
  if (mobile) {await page.getByRole('button',{name:'Open menu',exact:true}).click(); await page.locator('#xa-mobile-menu').waitFor(); await page.keyboard.press('Escape'); await page.locator('#xa-mobile-menu').waitFor({state:'hidden'}); await page.getByRole('button',{name:'Open menu',exact:true}).click(); await page.locator('#xa-mobile-menu').getByRole('button',{name:'Pricing',exact:true}).click();}
  else await page.getByRole('button',{name:'Pricing',exact:true}).first().click();
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'hidden'}); return true;
}
async function password(page) {const id=await page.locator('input[type="password"]').first().getAttribute('id'); if(!id)throw Error('password identity absent');const input=page.locator('[id='+JSON.stringify(id)+']'); if (await input.getAttribute('type') !== 'password') throw Error('password initial type'); await page.getByRole('button',{name:'Show password',exact:true}).click(); if (await input.getAttribute('type') !== 'text') throw Error('password toggle inert'); await page.getByRole('button',{name:'Hide password',exact:true}).click(); if (await input.getAttribute('type') !== 'password') throw Error('password restore'); return true;}
async function concurrent() {
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE), dir=process.env.EVIDENCE_DIR, ledger=new Ledger(dir,'concurrent-browser'), browser=await chromium.launch({headless:true}), results=[];
  try {await Promise.all(['/', '/login','/pricing','/unknown-csp-qualification'].flatMap(route=>[0,1].map(async ordinal=>{
    const c=await browser.newContext({viewport:{width:1440,height:1000}}), p=await c.newPage(), o=new Observer(p,ledger,'public-'+route,'concurrent-'+route.replace(/\W/g,'_')+'-'+ordinal); await o.install(c);
    await c.route('**/*',r=>{if (allowLocal(r.request(),'http://127.0.0.1:3551')) return r.continue(); const f=fixture(r.request(),false,o.scenario); if(f)return r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'http://127.0.0.1:3551'},body:JSON.stringify(f.body)}); return r.abort('blockedbyclient');});
    o.navigate('public-'+route); await p.goto('http://127.0.0.1:3551'+route);
    let proof;
    if(route==='/') proof=await landing(p,false);
    else if(route==='/login'){await p.getByRole('heading',{name:'Sign in to XpertApply',exact:true}).waitFor();proof=await password(p);}
    else if(route==='/pricing'){await p.getByRole('heading',{name:'Pricing',exact:true}).waitFor(); const marker=await p.evaluate(()=>window.__qualDocument);o.navigate('pricing-home');await p.locator('a[href="/"]').first().click();await p.waitForURL(u=>u.pathname==='/');proof=marker===await p.evaluate(()=>window.__qualDocument)&&await landing(p,false);await o.checkpoint('/',200,true,proof);o.navigate('pricing-back');await p.goBack();await p.waitForURL(u=>u.pathname==='/pricing');proof=await p.getByRole('heading',{name:'Pricing',exact:true}).isVisible();}
    else {await p.getByRole('heading',{name:'Page not found',exact:true}).waitFor();await o.checkpoint(route,404,true,true);o.navigate('404-home');await p.getByRole('link',{name:'Return home',exact:true}).click();await p.waitForURL(u=>u.pathname==='/');proof=await landing(p,false);await o.checkpoint('/',200,true,proof);results.push(await o.close(c));return;}
    await o.checkpoint(route,200,true,proof);results.push(await o.close(c));
  })));} finally {await browser.close();atomic(dir,'concurrent-browser',{schema:1,pass:results.length===8&&results.every(r=>r.pass),results});}
  if(results.length!==8||results.some(r=>!r.pass)) throw Error('concurrent classification failure');
}
module.exports={hash,now,urlEvidence,sanitize,atomic,canonicalNonce,policyEvidence,Ledger,requiredKind,healthy,classify,assetStatus,clientProof,fixture,allowLocal,Observer,landing,password};
if(require.main===module) concurrent().catch(e=>{atomic(process.env.EVIDENCE_DIR,'concurrent-browser-error',sanitize(e.message));process.exitCode=1;});
