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
// Diagnostics are projections only: unknown strings are never copied into artifacts.
const diagnosticSelectors=new Set(['a[href="/"]:visible','a[href="/login"]:visible','form','form input[type="email"]','form input[type="password"]','Show password','Hide password','Return home','Try again','Reload','#google-link-error']);
const diagnosticOperations=new Set(['scenario','navigate','reload','checkpoint','home-back','auth-form','landing-login','404-home','recovery','cleanup']);
function safeField(value, allowed) { return allowed.has(value) ? value : {fingerprint:hash(String(value))}; }
function operationMetadata(meta={}) {
 return {label:safeField(meta.label,diagnosticOperations),selector:meta.selector==null?null:safeField(meta.selector,diagnosticSelectors),
  route:known.has(meta.route)?meta.route:null,routeFingerprint:known.has(meta.route)?null:hash(String(meta.route)),
  step:safeField(meta.step,diagnosticOperations)};
}
function structuredError(error) {
 const message=String(error?.message||''), timeout=message.match(/\bTimeout (\d{1,7})ms exceeded\b/);
 const knownMessages=new Set(['password identity absent','password initial type','password toggle inert','password restore','auth route mismatch','required request did not settle','settled checkpoint failed','client home performed full navigation','smoke classification failed','incomplete smoke']);
 const selectors=[...diagnosticSelectors].filter(x=>message.includes(x));
 const frames=[...String(error?.stack||'').matchAll(/(?:^|[\s(])(?:[^\s()]*\/)?(qualification\/cws-prep-15\/(?:smoke|browser|run)\.(?:cjs|py)):(\d+):(\d+)/gm)].map(m=>({path:m[1],line:Number(m[2]),column:Number(m[3])}));
 return {name:['TimeoutError','Error','TypeError','AssertionError'].includes(error?.name)?error.name:'UNKNOWN_ERROR',
  message:{...sanitize(message),knownMessage:knownMessages.has(message)?message:null},timeoutMs:timeout?Number(timeout[1]):null,
  callLog:message.split('\n').filter(line=>selectors.some(selector=>line.includes(selector))).map(line=>({
   lineFingerprint:hash(line),selectors:selectors.filter(selector=>line.includes(selector)),action:/waiting for/.test(line)?'WAIT':'OPERATION_ERROR'})),stack:frames};
}
function failureArtifact(error, meta={}, observer=null) {
 const sha=process.env.GITHUB_SHA;let activeRoute=meta.route;
 try{if(observer?.page?.url)activeRoute=new URL(observer.page.url()).pathname;}catch{activeRoute=null;}
 return {schema:1,version:1,sha:/^[0-9a-f]{40}$/.test(sha||'')?sha:null,
  phase:meta.phase==='concurrent-browser'?'concurrent-browser':'smoke',
  scenarioId:/^(smoke-(desktop|mobile)-(public-regression|auth-fixture|guard|segment-error|root-error)|concurrent-[_a-z]+-[01])$/.test(meta.scenarioId||'')?meta.scenarioId:'UNAVAILABLE',
  viewport:['desktop','mobile'].includes(meta.viewport)?meta.viewport:null,
  activeRoute:known.has(activeRoute)?activeRoute:null,activeStep:operationMetadata(meta).step,
  operation:operationMetadata(meta),error:structuredError(error),
  snapshot:observer?observer.diagnosticSnapshot():{available:false},pass:false,complete:false};
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

// Sidecar observations never feed classify(): legacy request/navigation fields remain authoritative.
let causalSequence = 0;
const causalDomain = crypto.randomUUID();
const pageObservers = new WeakMap();
const actionKinds = new Set(['DIRECT_GOTO','RELOAD','LINK_NAVIGATION','CLIENT_NAVIGATION','HISTORY_BACK','ERROR_RETRY','GLOBAL_RELOAD','PAGE_CLOSE','CONTEXT_CLOSE','UI_INTERACTION']);
function classifierReplay(r, checkpoints) {
  const c=checkpoints.find(x=>x.checkpointId===r.checkpointId);
  const comparisons={samePage:c?.pageId===r.pageId,matchingNavigation:c?.navigationId===r.supersedingNavigationId,
    checkpointAfterSupersession:c?.timestamp?.monotonicMs>=r.supersedingTimestampMs,
    supersessionAfterStart:r.supersedingTimestampMs>=r.start.monotonicMs,
    failureAfterSupersession:!!r.failure&&r.failure.monotonicMs>=r.supersedingTimestampMs,
    checkpointBeforeTeardown:c?.timestamp?.monotonicMs<=r.teardownTimestampMs,
    teardownAfterStart:r.teardownTimestampMs>=r.start.monotonicMs,
    failureAfterTeardown:!!r.failure&&r.failure.monotonicMs>=r.teardownTimestampMs};
  return {backgroundIdentity:r.rscMarker===true||r.prefetchMarker===true,errorIsExpectedAbort:r.errorText==='net::ERR_ABORTED',
    provenSupersession:!!(r.failure&&comparisons.samePage&&comparisons.matchingNavigation&&comparisons.checkpointAfterSupersession&&r.supersedingNavigationId&&comparisons.supersessionAfterStart&&comparisons.failureAfterSupersession),
    intentionalTeardown:!!(r.failure&&comparisons.samePage&&comparisons.checkpointBeforeTeardown&&r.teardownKnownOutstanding===true&&comparisons.teardownAfterStart&&comparisons.failureAfterTeardown),
    healthyCheckpoint:healthy(c),requiredResource:!!requiredKind(r),comparisons,finalCategory:classify(r,checkpoints),
    inputs:{request:JSON.parse(JSON.stringify(r, (key,value)=>key==='causal'?undefined:value)),checkpoint:c||null}};
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
// NETWORK_ONLY forensic sidecar. No result below feeds classify() or its inputs.
const cdpArtifacts=['cdp-request-ledger','cdp-initiator-summary','cdp-loading-failures','cdp-correlation','cdp-causality-analysis'];
const cdpTypes=new Set(['Document','Stylesheet','Image','Media','Font','Script','TextTrack','XHR','Fetch','Prefetch','EventSource','WebSocket','Manifest','SignedExchange','Ping','CSPViolationReport','Preflight','FedCM','Other']);
const cdpInitiators=new Set(['parser','script','preload','SignedExchange','preflight','FedCM','other']);
const cdpErrors=new Set(['net::ERR_ABORTED','net::ERR_FAILED','net::ERR_BLOCKED_BY_CLIENT','net::ERR_BLOCKED_BY_RESPONSE','net::ERR_CONNECTION_CLOSED','net::ERR_CONNECTION_RESET','net::ERR_CONNECTION_REFUSED','net::ERR_TIMED_OUT','net::ERR_NAME_NOT_RESOLVED','net::ERR_INTERNET_DISCONNECTED','net::ERR_NETWORK_CHANGED']);
const cdpBlocked=new Set(['other','csp','mixed-content','origin','inspector','integrity','subresource-filter','content-type','coep-frame-resource-needs-coep-header','coop-sandboxed-iframe-cannot-navigate-to-coop-page','corp-not-same-origin','corp-not-same-origin-after-defaulted-to-same-origin-by-coep','corp-not-same-origin-after-defaulted-to-same-origin-by-dip','corp-not-same-origin-after-defaulted-to-same-origin-by-coep-and-dip','corp-not-same-site','sri-message-signature-mismatch']);
const cdpCors=new Set(['DisallowedByMode', 'InvalidResponse', 'WildcardOriginNotAllowed', 'MissingAllowOriginHeader', 'MultipleAllowOriginValues', 'InvalidAllowOriginValue', 'AllowOriginMismatch', 'InvalidAllowCredentials', 'CorsDisabledScheme', 'PreflightInvalidStatus', 'PreflightDisallowedRedirect', 'PreflightWildcardOriginNotAllowed', 'PreflightMissingAllowOriginHeader', 'PreflightMultipleAllowOriginValues', 'PreflightInvalidAllowOriginValue', 'PreflightAllowOriginMismatch', 'PreflightInvalidAllowCredentials', 'PreflightMissingAllowExternal', 'PreflightInvalidAllowExternal', 'InvalidAllowMethodsPreflightResponse', 'InvalidAllowHeadersPreflightResponse', 'MethodDisallowedByPreflightResponse', 'HeaderDisallowedByPreflightResponse', 'RedirectContainsCredentials', 'InsecureLocalNetwork', 'InvalidLocalNetworkAccess', 'NoCorsRedirectModeNotFollow', 'LocalNetworkAccessPermissionDenied']);
const cdpMimes=new Set(['text/html','text/x-component','text/css','text/javascript','application/javascript','application/json','image/png','image/jpeg','image/svg+xml','image/webp','image/x-icon','font/woff','font/woff2']);
const cdpEvents=['Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed','Network.requestServedFromCache','Page.frameNavigated','Page.lifecycleEvent','Page.navigatedWithinDocument','Page.frameStartedNavigating'];
const cdpFinite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
function cdpId(value,prefix) {return typeof value==='string'&&value.length>0&&value.length<=256?prefix+'-'+hash(value):null;}
function cdpRef(value) {return typeof value==='string'&&/^smoke-(desktop|mobile)-(public-regression|auth-fixture|guard|segment-error|root-error)(?:-r\d+|-action\d+|-nav\d+|-js-[a-f0-9]{64})?$/.test(value)?value:null;}
function cdpURL(value) {
 try {const u=new URL(value), local=['http://127.0.0.1:3550','http://127.0.0.1:3551','http://127.0.0.1:3552'].includes(u.origin), api=u.origin==='https://api.xpertapply.com';
  const approved=(local||api)&&!u.username&&!u.password&&known.has(u.pathname);
  return {originClass:local?'LOCAL_QUALIFICATION':api?'FIXTURE_API':'UNKNOWN',path:approved?u.pathname:null,redactionLoss:!approved||!!u.search||!!u.hash};
 }catch{return {originClass:'UNKNOWN',path:null,redactionLoss:true};}
}
function cdpPWURL(value) {return {originClass:['http://127.0.0.1:3550','http://127.0.0.1:3551','http://127.0.0.1:3552'].includes(value?.origin)?'LOCAL_QUALIFICATION':value?.origin==='https://api.xpertapply.com'?'FIXTURE_API':'UNKNOWN',path:known.has(value?.path)?value.path:null,redactionLoss:true};}
function cdpCorrelate(hops,requests,complete=false) {
 // Public PW evidence lacks a lossless URL/ID bridge. Never emit EXACT, even for a singleton.
 const rows=requests.map(p=>{const u=cdpPWURL(p.url),type=String(p.resourceType||'').toLowerCase();
  const candidates=hops.filter(h=>u.path&&h.url.path===u.path&&h.url.originClass===u.originClass&&h.method===p.method&&h.type?.toLowerCase()===type);
  const frameKnown=p.cdpMainFrameKnown===true&&candidates.every(h=>h.mainFrame===true);
  const contrary=candidates.filter(h=>h.response&&p.responseStatus!=null&&h.response.status!==p.responseStatus||h.state==='CONTRADICTORY_TERMINAL'||h.state==='LOADING_COMPLETED'&&!!p.failure||!!h.failure&&!!p.finished);
  return {playwrightRequestId:cdpRef(p.requestId),candidateKeys:candidates.map(h=>h.key),correlationClass:!candidates.length?'UNMATCHED':candidates.length>1?'AMBIGUOUS':contrary.length||!complete||!frameKnown?'UNKNOWN':'HIGH_CONFIDENCE_FORENSIC',reason:!candidates.length?'NO_COMPATIBLE_OBSERVATION':candidates.length>1?'COMPETING_CANDIDATES':contrary.length?'LIFECYCLE_DISAGREEMENT':!complete?'CAPTURE_PARTIAL':!frameKnown?'FRAME_ASSOCIATION_UNVERIFIED':'NO_PUBLIC_EXACT_ID_BRIDGE',exactEligible:false};
 });
 // A CDP singleton shared by multiple PW records is also a collision; never consume greedily.
 const count=new Map();for(const r of rows)for(const k of r.candidateKeys)count.set(k,(count.get(k)||0)+1);
 for(const r of rows)if(r.candidateKeys.some(k=>count.get(k)>1)){r.correlationClass='AMBIGUOUS';r.reason='COMPETING_PLAYWRIGHT_RECORDS';}
 return {rows,unmatchedCDP:hops.filter(h=>!count.has(h.key)).map(h=>h.key)};
}
class CDPGroup {
 constructor(dir) {this.dir=dir;this.pages=[];this.bytes=0;this.limitBytes=16777216;this.persistenceSucceeded=false;this.persistenceFailures=0;this.persistenceGeneration=0;}
 add(owner) {const s=new CDPSidecar(owner,this,this.pages.length+1);this.pages.push(s);return s;}
 artifacts() {
  const pages=this.pages.map(s=>s.projection()), hops=pages.flatMap(p=>p.hops),correlations=this.pages.map(s=>s.correlations());
  const envelope={schema:1,persistenceGeneration:this.persistenceGeneration,mode:'NETWORK_ONLY',runId:/^\d+$/.test(process.env.GITHUB_RUN_ID||'')?process.env.GITHUB_RUN_ID:null,sha:/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||'')?process.env.GITHUB_SHA:null};
  return [
   {...envelope,pages},
   {...envelope,pages:pages.map(p=>({sessionId:p.sessionId,initiators:p.hops.map(h=>({key:h.key,initiator:h.initiator})),completeness:p.completeness}))},
   {...envelope,failures:hops.filter(h=>h.failure).map(h=>({key:h.key,loaderId:h.loaderId,frameId:h.frameId,response:h.response,failure:h.failure,state:h.state}))},
   {...envelope,pages:correlations},
   {...envelope,classifierUnchanged:true,persistenceSucceeded:this.persistenceSucceeded,persistenceFailures:this.persistenceFailures,pages:pages.map(p=>({sessionId:p.sessionId,completeness:p.completeness,transitions:p.transitions,unknownCausalOrigin:true})),causalAcceptance:'NOT_EVALUATED_FORENSIC_ONLY'}
  ];
 }
 persist() {
  // The final status artifact is written last, after the other four writes succeed.
  this.persistenceSucceeded=false;this.persistenceGeneration++;
  try {const artifacts=this.artifacts();atomic(this.dir,cdpArtifacts[4],artifacts[4]);for(let i=0;i<4;i++)atomic(this.dir,cdpArtifacts[i],artifacts[i]);
   this.persistenceSucceeded=true;atomic(this.dir,cdpArtifacts[4],this.artifacts()[4]);return true;
  }catch{this.persistenceSucceeded=false;this.persistenceFailures++;for(const s of this.pages)s.gap('PERSISTENCE_FAILURE');return false;}
 }
}
class CDPSidecar {
 constructor(owner,group,ordinal) {
  this.owner=owner;this.group=group;this.sessionId='cdp-session-'+ordinal;this.session=null;this.handlers=[];this.hops=[];this.active=new Map();this.transitions=[];this.receiptSequence=0;this.closed=false;this.frame=null;this.maxEvents=20000;
  this.meta={status:'CDP_UNAVAILABLE',coverage:'ATTACHED_PAGE_TARGET_ONLY',workerAndOopifCoverage:'UNKNOWN',attachedBeforeNavigation:false,networkEnabled:false,pageEnabled:false,listenersAttached:false,cleanupExecuted:false,detachSucceeded:false,persistenceAttempted:false,internalExceptions:0,observationGaps:[],targetClosed:false,sessionClosed:false,limitsExceeded:false,protocolCompatibility:'UNKNOWN',runtime:null};
 }
 gap(reason) {if(!this.meta.observationGaps.includes(reason))this.meta.observationGaps.push(reason);if(this.meta.status!=='CDP_UNAVAILABLE')this.meta.status='CDP_PARTIAL';}
 receipt() {return {nodeClockDomainId:causalDomain,nodeReceiptSequence:++this.receiptSequence,nodeReceiptPerformanceNow:performance.now(),browserClockDomainId:this.sessionId+'-browser-monotonic',actionIdAtReceipt:cdpRef(this.owner.activeAction?.actionId),documentIdAtReceipt:cdpRef(this.owner.activeDocumentId),generationAtReceipt:cdpFinite(this.owner.observedGeneration)};}
 async attach(context) {
  try {
   this.session=await context.newCDPSession(this.owner.page);this.meta.attachedBeforeNavigation=this.owner.page.url()==='about:blank';if(!this.meta.attachedBeforeNavigation)this.gap('ATTACH_AFTER_NAVIGATION');
   for(const name of cdpEvents){const handler=e=>this.receive(name,e);this.session.on(name,handler);this.handlers.push([name,handler]);}this.session.on('close',this.onSessionClose=()=>{this.meta.sessionClosed=true;if(!this.closed)this.gap('SESSION_CLOSED_BEFORE_CAPTURE_CUTOFF');});this.meta.listenersAttached=true;
   this.owner.page.on('close',this.onPageClose=()=>{this.meta.targetClosed=true;if(this.hops.some(h=>['STARTED','HEADERS_RECEIVED'].includes(h.state)))this.gap('TARGET_CLOSED_WITH_UNSETTLED_REQUEST');});
   await this.session.send('Network.enable');this.meta.networkEnabled=true;this.meta.status='CDP_PARTIAL';
   await this.session.send('Page.enable');this.meta.pageEnabled=true;
   await this.session.send('Page.setLifecycleEventsEnabled',{enabled:true});
   const v=await this.session.send('Browser.getVersion');
   const browserVersion=typeof v.product==='string'?v.product.match(/^(?:Chrome|HeadlessChrome)\/(\d+\.\d+\.\d+\.\d+)$/)?.[1]:null;
   let playwrightVersion=null;try{const pv=require(path.join(process.env.PLAYWRIGHT_MODULE,'package.json')).version;if(/^\d+\.\d+\.\d+$/.test(pv))playwrightVersion=pv;}catch{}
   this.meta.runtime={playwrightVersion,nodeVersion:/^v\d+\.\d+\.\d+$/.test(process.version)?process.version:null,browserVersion:browserVersion||null,protocolVersion:/^\d+\.\d+$/.test(v.protocolVersion||'')?v.protocolVersion:null};
   this.meta.protocolCompatibility=browserVersion==='149.0.7827.55'&&playwrightVersion==='1.61.1'?'EXPECTED_PIN_MATCH':'UNKNOWN';if(this.meta.protocolCompatibility==='UNKNOWN')this.gap('RUNTIME_PIN_UNVERIFIED');
   const tree=await this.session.send('Page.getFrameTree');this.frame=cdpId(tree.frameTree?.frame?.id,'frame');if(!this.frame)this.gap('MAIN_FRAME_BASELINE_UNAVAILABLE');
   this.transition('BASELINE_FRAME',tree.frameTree?.frame||{});
   this.meta.status=this.meta.observationGaps.length?'CDP_PARTIAL':'CDP_READY';
  }catch{this.meta.internalExceptions++;this.gap('ATTACH_OR_ENABLE_FAILURE');if(!this.meta.networkEnabled)this.meta.status='CDP_UNAVAILABLE';}
 }
 receive(name,event) {
  // Do not retain event objects, header/body payloads, query values or arbitrary text.
  const receipt=this.receipt();
  try {
   if(this.closed||this.meta.limitsExceeded)return;
   if(this.group.bytes>=this.group.limitBytes){this.meta.limitsExceeded=true;this.gap('BUFFER_LIMIT');return;}
   if(this.receiptSequence>this.maxEvents){this.meta.limitsExceeded=true;this.gap('EVENT_LIMIT');return;}
   if(name.startsWith('Page.'))this.transition(name,event,receipt);
   else this.network(name,event,receipt);
   const bytes=Buffer.byteLength(JSON.stringify({hop:this.hops.at(-1)||null,transition:this.transitions.at(-1)||null}));
   this.group.bytes+=bytes;
   if(bytes>4096||this.group.bytes>this.group.limitBytes){this.meta.limitsExceeded=true;this.gap('BUFFER_LIMIT');return;}
  }catch{this.meta.internalExceptions++;this.gap('EVENT_PROJECTION_FAILURE');}
 }
 transition(name,e,receipt=this.receipt()) {
  const f=e.frame||e,id=cdpId(f.id||e.frameId,'frame'),loader=cdpId(f.loaderId||e.loaderId,'loader');
  const names=new Set(['BASELINE_FRAME','Page.frameNavigated','Page.lifecycleEvent','Page.navigatedWithinDocument','Page.frameStartedNavigating']);
  if(!names.has(name))return;
  const lifecycle=new Set(['init','DOMContentLoaded','load','networkAlmostIdle','networkIdle','firstPaint','firstContentfulPaint']);
  const nav=new Set(['Navigation','BackForwardCacheRestore','fragment','historyApi','other','reload','reloadBypassingCache','restore','restoreWithPost','historySameDocument','historyDifferentDocument','sameDocument','differentDocument']);
  this.transitions.push({kind:name,frameId:id,loaderId:loader,url:cdpURL(f.url),lifecycleName:lifecycle.has(e.name)?e.name:null,navigationType:nav.has(e.type||e.navigationType)?e.type||e.navigationType:null,cdpMonotonicSeconds:cdpFinite(e.timestamp),receipt});
 }
 network(name,e,receipt) {
  const id=cdpId(e.requestId,'request');if(!id){this.gap('MISSING_REQUEST_ID');return;}
  let h=this.active.get(id);
  if(name==='Network.requestWillBeSent') {
   const redirect=!!e.redirectResponse;
   if(cdpFinite(e.timestamp)===null||typeof e.loaderId!=='string'||typeof e.documentURL!=='string'||!e.request||!cdpInitiators.has(e.initiator?.type))this.gap('INVALID_REQUEST_SCHEMA');
   if(h){if(redirect&&!['LOADING_COMPLETED','LOADING_FAILED','CONTRADICTORY_TERMINAL','REDIRECTED'].includes(h.state)){h.redirectResponse=this.response(e.redirectResponse,null,receipt);if(!h.response)h.response=h.redirectResponse;else if(h.response.status!==h.redirectResponse.status)this.gap('REDIRECT_RESPONSE_DISAGREEMENT');h.state='REDIRECTED';}else{this.gap('UNEXPECTED_REQUEST_ID_REUSE');h.state='CONTRADICTORY_TERMINAL';}}
   if(redirect&&!h)this.gap('MISSING_REDIRECT_START');
   const ordinal=h?h.hopOrdinal+1:0;
   const i=e.initiator||{},u=cdpURL(e.request?.url),method=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(e.request?.method)?e.request.method:null;
   h={key:this.sessionId+'/'+id+'/'+ordinal,cdpRequestId:id,hopOrdinal:ordinal,redirectedFrom:redirect&&h?h.key:null,loaderId:cdpId(e.loaderId,'loader'),emptyLoader:e.loaderId==='',frameId:cdpId(e.frameId,'frame'),mainFrame:!!this.frame&&cdpId(e.frameId,'frame')===this.frame,documentURL:cdpURL(e.documentURL),url:u,method,type:cdpTypes.has(e.type)?e.type:null,initiator:{type:cdpInitiators.has(i.type)?i.type:'UNKNOWN',url:cdpURL(i.url),lineNumber:Number.isInteger(i.lineNumber)&&i.lineNumber>=0?i.lineNumber:null,columnNumber:Number.isInteger(i.columnNumber)&&i.columnNumber>=0?i.columnNumber:null,requestId:cdpId(i.requestId,'request'),stackPresent:!!i.stack,stackCaptured:false},hasUserGesture:typeof e.hasUserGesture==='boolean'?e.hasUserGesture:null,start:{cdpMonotonicSeconds:cdpFinite(e.timestamp),receipt},state:'STARTED',response:null,redirectResponse:null,finished:null,failure:null,servedFromCache:false};
   this.hops.push(h);this.active.set(id,h);return;
  }
  if(!h){this.gap('ORPHAN_NETWORK_EVENT');return;}
  if(name!=='Network.requestServedFromCache'&&cdpFinite(e.timestamp)===null)this.gap('INVALID_EVENT_TIMESTAMP');
  if(cdpFinite(e.timestamp)!==null&&h.start.cdpMonotonicSeconds!==null&&e.timestamp<h.start.cdpMonotonicSeconds)this.gap('BROWSER_EVENT_ORDER_CONTRADICTION');
  const t={cdpMonotonicSeconds:cdpFinite(e.timestamp),receipt};
  if(name==='Network.responseReceived'){if(h.response||!['STARTED','HEADERS_RECEIVED'].includes(h.state))this.gap('UNEXPECTED_RESPONSE_ORDER');h.response={...this.response(e.response,e.timestamp,receipt),loaderId:cdpId(e.loaderId,'loader'),frameId:cdpId(e.frameId,'frame'),type:cdpTypes.has(e.type)?e.type:null};if(h.loaderId&&h.response.loaderId&&h.loaderId!==h.response.loaderId){this.gap('RESPONSE_LOADER_DISAGREEMENT');h.state='CONTRADICTORY_TERMINAL';}if(h.state==='STARTED')h.state='HEADERS_RECEIVED';}
  else if(name==='Network.loadingFinished'){if(h.finished||h.failure||h.state==='REDIRECTED'){h.state='CONTRADICTORY_TERMINAL';this.gap('CONTRADICTORY_TERMINAL');}else h.state='LOADING_COMPLETED';h.finished=t;if(cdpFinite(e.encodedDataLength)===null)this.gap('INVALID_FINISH_SCHEMA');}
  else if(name==='Network.loadingFailed'){if(h.finished||h.failure||h.state==='REDIRECTED'){h.state='CONTRADICTORY_TERMINAL';this.gap('CONTRADICTORY_TERMINAL');}else h.state='LOADING_FAILED';h.failure={...t,errorText:cdpErrors.has(e.errorText)?e.errorText:'UNKNOWN_ERROR',canceled:typeof e.canceled==='boolean'?e.canceled:null,blockedReason:cdpBlocked.has(e.blockedReason)?e.blockedReason:null,corsErrorStatus:e.corsErrorStatus?{present:true,corsError:cdpCors.has(e.corsErrorStatus.corsError)?e.corsErrorStatus.corsError:null}:null,type:cdpTypes.has(e.type)?e.type:null};}
  else if(name==='Network.requestServedFromCache')h.servedFromCache=true;
 }
 response(r,t,receipt) {return {status:Number.isInteger(r?.status)&&r.status>=100&&r.status<=599?r.status:null,mimeType:cdpMimes.has(r?.mimeType)?r.mimeType:'UNAPPROVED_MIME',cdpMonotonicSeconds:cdpFinite(t),receipt};}
 correlations() {
  const result=cdpCorrelate(this.hops,this.owner.requests.map(r=>({...r,cdpMainFrameKnown:r.frameId!=null&&r.frameId===this.owner.frameIds.get(this.owner.page.mainFrame())})),this.meta.status==='CDP_COMPLETE');
  return {sessionId:this.sessionId,...result,playwrightFacts:this.owner.requests.map(r=>{const replay=r.failure?classifierReplay(r,this.owner.checkpoints):null;return {requestId:cdpRef(r.requestId),requestfinished:!!r.finished,requestfailed:!!r.failure,finalCategory:r.classification||replay?.finalCategory||null,booleans:replay?{backgroundIdentity:replay.backgroundIdentity,errorIsExpectedAbort:replay.errorIsExpectedAbort,provenSupersession:replay.provenSupersession,intentionalTeardown:replay.intentionalTeardown,healthyCheckpoint:replay.healthyCheckpoint,requiredResource:replay.requiredResource}:null};})};
 }
 projection() {return {sessionId:this.sessionId,pageId:cdpRef(this.owner.pageId),clockDomains:{browser:'CDP_MONOTONIC_SECONDS',node:'NODE_PERFORMANCE_NOW_MS',directlyComparable:false},hops:this.hops,transitions:this.transitions,completeness:{...this.meta,observationGaps:[...this.meta.observationGaps],persistenceAttempted:this.meta.persistenceAttempted,complete:this.meta.status==='CDP_COMPLETE'}};}
 async finish() {
  if(this.closed)return;this.closed=true;this.meta.cleanupExecuted=true;
  if(this.hops.some(h=>['STARTED','HEADERS_RECEIVED'].includes(h.state)))this.gap('UNSETTLED_AT_CAPTURE_CUTOFF');
  try{if(this.session){await this.session.detach();this.meta.detachSucceeded=true;}}catch{this.gap('DETACH_FAILURE');}
  for(const [name,handler]of this.handlers)try{this.session.off(name,handler);}catch{this.gap('LISTENER_CLEANUP_FAILURE');}
  if(this.onSessionClose)try{this.session.off('close',this.onSessionClose);}catch{this.gap('LISTENER_CLEANUP_FAILURE');}
  if(this.onPageClose)try{this.owner.page.off('close',this.onPageClose);}catch{this.gap('LISTENER_CLEANUP_FAILURE');}
  if(this.meta.status!=='CDP_UNAVAILABLE')this.meta.status=this.meta.observationGaps.length?'CDP_PARTIAL':'CDP_COMPLETE';
  this.meta.persistenceAttempted=true;this.group.persist();
 }
}

class Observer {
  constructor(page, ledger, scenario, pageId) {
    this.page = page; this.ledger = ledger; this.scenario = scenario; this.pageId = pageId; this.requests = []; this.responses = []; this.checkpoints = []; this.csp = []; this.errors = []; this.expectedErrors = []; this.documents = []; this.tasks = []; this.sequence = 0; this.generation = 0; this.outstanding = new Map(); this.lookup = new WeakMap(); this.frameIds = new WeakMap(); this.frameSequence = 0; this.console = []; this.verifiedCache=new Map();
    pageObservers.set(page,this);
    this.actions=[]; this.activeAction=null; this.observedGeneration=0; this.activeDocumentId=null; this.documentVerifiedAt=null; this.seenDocumentIds=new Set(); this.causalEvents=[]; this.causalComplete=true; this.causalCount=0;
    page.on('request', r => this.request(r));
    page.on('response', r => this.tasks.push(this.response(r)));
    page.on('requestfinished', r => {const x=this.lookup.get(r);if(x){x.lifecycleState='COMPLETED';x.finished=now();this.causalEvent('REQUEST_FINISHED',{requestId:x.requestId,timestamp:x.finished.monotonicMs});if(x.causal){x.causal.requestfinishedTimestamp=x.finished.monotonicMs;x.causal.bodyState='TRANSPORT_COMPLETED';}this.outstanding.delete(x.requestId);}});
    page.on('requestfailed', r => {const x = this.lookup.get(r) || this.request(r); x.failure = now();x.lifecycleState=x.teardownKnownOutstanding?'FAILED_DURING_TEARDOWN':x.supersedingNavigationId?'FAILED_AFTER_SUPERSEDING_NAVIGATION':'FAILED'; x.errorText = /^net::ERR_[A-Z_]+$/.test(r.failure()?.errorText || '') ? r.failure().errorText : null; this.outstanding.delete(x.requestId);this.failureEvidence(x);});
    page.on('pageerror', e => {const x = {...sanitize(e.message), scenario:this.scenario, timestamp:now()}; if (x.knownError === 'INJECTED_SERVER_RENDER_ERROR' && this.injectedFaultActive) this.expectedErrors.push(x); else if (x.knownError === 'CSP_QUAL_FATAL_ROUTER_URL' && this.fatalInjected) this.expectedErrors.push(x); else this.errors.push(x);});
    page.on('console', m => this.console.push({type:m.type(),...sanitize(m.text())}));
  }
  causalEvent(kind, fields={}) {
    const event={schema:1,clockDomainId:causalDomain,eventSequence:++causalSequence,monotonicMs:performance.now(),pageId:this.pageId,phase:this.ledger.phase,kind,...fields};
    if(++this.causalCount>20000){this.causalComplete=false;return event;}
    // Keep in-memory history immutable as later action/edge records are enriched.
    const snapshot=JSON.parse(JSON.stringify(event));this.causalEvents.push(snapshot);
    if(this.ledger.dir)try{fs.appendFileSync(path.join(this.ledger.dir,this.ledger.phase+'-causal-events.jsonl'),JSON.stringify(snapshot)+'\n');}catch{this.causalComplete=false;}
    return event;
  }
  documentObservation(token) {
    if(typeof token!=='string'||!/^[0-9a-f-]{36}$/.test(token))return null;
    const id=this.pageId+'-js-'+hash(token),previous=this.activeDocumentId;
    const relation=id===previous?'SAME':this.seenDocumentIds.has(id)?'RESTORED':'NEW';
    this.activeDocumentId=id;this.seenDocumentIds.add(id);
    const e=this.causalEvent('DOCUMENT_OBSERVED',{documentId:id,previousDocumentId:previous,relation});this.documentVerifiedAt=e.monotonicMs;
    return {documentId:id,relation};
  }
  async observeDocument() {
    try {return this.documentObservation(await this.page.evaluate(()=>window.__qualDocument));}
    catch {this.causalEvent('DOCUMENT_UNAVAILABLE');return null;}
  }
  actionState(action,state) {
    const event=this.causalEvent('ACTION_STATE',{actionId:action.actionId,state});
    action.states.push({state,monotonicMs:event.monotonicMs,eventSequence:event.eventSequence});action.completionState=state;return event;
  }
  beginAction(meta) {
    if(!actionKinds.has(meta.kind))throw Error('unsupported diagnostic action');
    const a={actionId:this.pageId+'-action'+(this.actions.length+1),scenarioId:hash(String(meta.scenario||this.scenario)),pageId:this.pageId,
      sourceDocumentId:this.activeDocumentId,documentHistoryAtStart:[...this.seenDocumentIds],sourceNavigationGeneration:this.observedGeneration,sourceLegacyGeneration:this.generation,
      sourceURL:urlEvidence(this.page.url()),actionKind:meta.kind,safeTargetRoute:known.has(meta.route)?meta.route:null,
      expectedCheckpointRoute:known.has(meta.expectedRoute||meta.route)?meta.expectedRoute||meta.route:null,safeSelectorId:meta.selector?hash(String(meta.selector)):null,startMonotonic:null,browserOperationStart:null,browserOperationEnd:null,
      resultingURL:null,resultingDocumentId:null,resultingNavigationGeneration:null,completionState:'PLANNED',errorState:null,states:[],
      outstandingSnapshot:[],navigation:meta.navigation===true,parentActionId:this.activeAction?.actionId||null,operationResolved:false};
    this.actions.push(a);this.actionState(a,'PLANNED');
    const event=this.actionState(a,'STARTED');a.startMonotonic=event.monotonicMs;
    // Synchronous snapshot: no request callback can interleave before operation invocation.
    if(a.navigation)for(const r of this.outstanding.values())if(r.rscMarker||r.prefetchMarker){
      const edge={requestId:r.requestId,actionId:a.actionId,supersededByActionId:a.actionId,snapshotTimestamp:event.monotonicMs,
        supersessionTimestamp:event.monotonicMs,requestGeneration:r.navigationGeneration,oldGeneration:r.navigationGeneration,
        requestDocumentId:r.causal?.documentIdAtStart||null,sourceDocumentId:a.sourceDocumentId,intendedGeneration:this.observedGeneration+1,
        candidateSupersession:true,startedBeforeAction:true,presentInOutstandingSnapshot:true,proven:false,resultingGeneration:null};
      this.causalEvent('OUTSTANDING_SNAPSHOT',{edge});a.outstandingSnapshot.push(edge);if(r.causal)r.causal.supersessionEdges.push(edge);
    }
    if(this.activeAction&&a.navigation)this.actionState(this.activeAction,'SUPERSEDED');
    this.activeAction=a;return a;
  }
  async withAction(meta, operation, proof=null) {
    const previous=this.activeAction,a=this.beginAction(meta);
    if(meta.scenario&&a.navigation){a.legacyNavigationId=this.navigate(meta.scenario);}
    if(meta.teardown){this.actionState(a,'TEARDOWN');a.teardownSnapshot=[...this.outstanding.keys()];this.causalEvent('CLEANUP_TEARDOWN_INTENT',{actionId:a.actionId,outstandingRequestIds:a.teardownSnapshot});}
    const event=this.actionState(a,'BROWSER_OPERATION_IN_FLIGHT');a.browserOperationStart=event.monotonicMs;this.causalEvent('ACTION_OPERATION_STARTED',{action:a});
    try {
      const value=await operation();a.browserOperationEnd=performance.now();a.operationResolved=true;
      a.resultingURL=urlEvidence(this.page.url());a.operationDocumentId=this.activeDocumentId;a.operationDocumentVerifiedAt=this.documentVerifiedAt;a.operationObservedGeneration=this.observedGeneration;
      // Navigation response object linkage is observable; body/headers are not retained here.
      a.navigationResponseRequestId=value?.request?this.lookup.get(value.request())?.requestId||null:null;
      this.causalEvent('OPERATION_RESOLVED',{actionId:a.actionId,browserOperationEnd:a.browserOperationEnd,navigationResponseRequestId:a.navigationResponseRequestId});
      if(proof)await proof(value);
      if(!a.navigation){a.resultingDocumentId=this.activeDocumentId;a.resultingNavigationGeneration=this.observedGeneration;this.actionState(a,'COMPLETED');this.causalEvent('ACTION_RESULT',{action:a});this.activeAction=previous;}
      return value;
    } catch(error) {
      if(a.browserOperationEnd===null)a.browserOperationEnd=performance.now();a.errorState=structuredError(error);this.actionState(a,'FAILED');this.causalEvent('ACTION_RESULT',{action:a});this.activeAction=previous;throw error;
    }
  }
  async cleanupBrowser(browser) {try{return await this.withAction({kind:'CONTEXT_CLOSE',teardown:true},()=>browser.close());}finally{try{this.persistReplay();}finally{await this.finishCDP();}}}
  async finishCDP() {if(this.cdp)try{await this.cdp.finish();}catch{this.cdp.gap('CLEANUP_FAILURE');this.cdp.meta.internalExceptions++;this.cdp.group.persist();}}
  persistReplay() {for(const record of this.causalReplay())this.causalEvent('CLASSIFIER_REPLAY',{record});}
  failActiveAction(error) {
    if(this.activeAction&&!['COMPLETED','FAILED'].includes(this.activeAction.completionState)){this.activeAction.errorState=structuredError(error);this.actionState(this.activeAction,'FAILED');this.causalEvent('ACTION_RESULT',{action:this.activeAction});this.activeAction=null;}
  }
  failureEvidence(r) {
    const a=this.activeAction;
    if(r.causal){r.causal.failure={timestamp:r.failure.monotonicMs,currentActionAtFailure:a?.actionId||null,actionStateAtFailure:a?.completionState||null,
      generationAtFailure:this.generation,observedGenerationAtFailure:this.observedGeneration,documentIdAtFailure:this.activeDocumentId,
      phase:a?.actionId===r.causal.activeActionId?'DURING_INITIATING_ACTION':r.causal.supersessionEdges.some(e=>e.actionId===a?.actionId)?'DURING_LATER_ACTION':r.causal.activeActionId?'AFTER_OR_OUTSIDE_INITIATING_ACTION':'INDEPENDENT',errorText:r.errorText};r.causal.bodyState='TRANSPORT_FAILED';}
    this.causalEvent('REQUEST_FAILED',{requestId:r.requestId,failureTimestamp:r.failure.monotonicMs,currentActionAtFailure:a?.actionId||null,causal:r.causal||null,errorText:r.errorText,responseStatus:r.responseStatus,frameId:r.frameId,url:r.url,rscMarker:r.rscMarker,prefetchMarker:r.prefetchMarker,purpose:r.purpose});
  }
  causalReplay() {
    return this.requests.filter(r=>r.failure).map(r=>{const replay=classifierReplay(r,this.checkpoints);return {requestId:r.requestId,causal:r.causal||null,...replay,supersessionEvidence:(r.causal?.supersessionEdges||[]).map(edge=>{const a=this.actions.find(a=>a.actionId===edge.actionId);return {...edge,proven:replay.provenSupersession&&r.supersedingNavigationId===a?.legacyNavigationId,checkpointId:r.checkpointId,resultingGeneration:a?.resultingNavigationGeneration??null,resultingDocumentId:a?.resultingDocumentId||null,resultingURL:a?.resultingURL||null};})};});
  }
  async install(context) {
    if(this.ledger.phase==='smoke'&&process.env.QUAL_CDP_MODE==='NETWORK_ONLY'){
      this.ledger.cdpGroup ||= new CDPGroup(this.ledger.dir);this.cdp=this.ledger.cdpGroup.add(this);await this.cdp.attach(context);
    }
    await context.exposeBinding('__qualDocumentObserved', (source, token) => {if(source.page===this.page&&source.frame===this.page.mainFrame())this.documentObservation(token);});
    await context.exposeBinding('__qualCSP', (_, e) => this.csp.push(e));
    await context.addInitScript(() => {window.__qualDocument = crypto.randomUUID(); window.__qualDocumentObserved(window.__qualDocument); addEventListener('securitypolicyviolation', e => window.__qualCSP({directive:e.effectiveDirective, disposition:e.disposition, timestamp:Date.now()}));});
  }
  request(r) {
    const headers = r.headers(), rsc = headers.rsc === '1', prefetch = headers['next-router-prefetch'] === '1' || !!headers['next-router-segment-prefetch'];
    let frameId = null, frameUnavailableReason = null;
    try { const f = r.frame(); if (!this.frameIds.has(f)) this.frameIds.set(f, this.pageId + '-frame-' + (++this.frameSequence)); frameId = this.frameIds.get(f); } catch {frameUnavailableReason = 'FRAME_NOT_AVAILABLE';}
    const u = urlEvidence(r.url());
    const x = {schema:1,runId:process.env.GITHUB_RUN_ID,sha:process.env.GITHUB_SHA,phase:this.ledger.phase,scenarioId:this.scenario,pageId:this.pageId, requestId:this.pageId+'-r'+(++this.sequence), frameId,frameUnavailableReason,url:u,method:r.method(),resourceType:r.resourceType(),isNavigationRequest:r.isNavigationRequest(), start:now(),failure:null,errorText:null,responseStatus:null,rscMarker:rsc,prefetchMarker:prefetch,purpose:u.origin === 'https://api.xpertapply.com' || (['fetch','xhr'].includes(r.resourceType())&&!rsc&&!prefetch) ? 'API' : rsc || prefetch ? 'BACKGROUND' : ['image','font'].includes(r.resourceType()) ? 'REQUIRED_RESOURCE' : 'OTHER',navigationGeneration:this.generation,supersedingNavigationId:null,supersedingTimestampMs:null,lifecycleState:'IN_FLIGHT',teardownState:'NOT_STARTED',teardownKnownOutstanding:false,teardownTimestampMs:null,checkpointId:null,classification:null,redirectedFrom:this.lookup.get(r.redirectedFrom())?.requestId || null};
    const e=this.causalEvent('REQUEST_STARTED',{requestId:x.requestId,requestStartMonotonic:x.start.monotonicMs});
    x.causal={clockDomainId:causalDomain,eventSequence:e.eventSequence,requestStartMonotonic:x.start.monotonicMs,pageId:this.pageId,frameId,documentIdAtStart:this.activeDocumentId,documentVerifiedAt:this.documentVerifiedAt,initiatorDocumentId:null,initiatorRelation:'UNKNOWN',generationAtStart:this.generation,observedGenerationAtStart:this.observedGeneration,activeActionId:this.activeAction?.actionId||null,activeActionKind:this.activeAction?.actionKind||null,actionStateAtStart:this.activeAction?.completionState||null,startedBeforeAction:false,presentInOutstandingSnapshot:false,supersessionEdges:[],bodyState:'PENDING',requestfinishedTimestamp:null,responseHeaderTimestamp:null};
    this.causalEvent('REQUEST_START_SNAPSHOT',{requestId:x.requestId,startSnapshot:{...x.causal,supersessionEdges:undefined},url:x.url,method:x.method,resourceType:x.resourceType,isNavigationRequest:x.isNavigationRequest,rscMarker:x.rscMarker,prefetchMarker:x.prefetchMarker,purpose:x.purpose});
    this.requests.push(x); this.lookup.set(r,x); this.outstanding.set(x.requestId,x); return x;
  }
  navigate(scenario) {
    this.scenario = scenario; this.generation++; const id = this.pageId+'-nav'+this.generation, t = performance.now();
    for (const x of this.outstanding.values()) if (x.rscMarker || x.prefetchMarker) {x.supersedingNavigationId=id; x.supersedingTimestampMs=t;x.lifecycleState='SUPERSEDED_IN_FLIGHT';}
    return id;
  }
  async response(response) {
    const r = response.request(), x = this.lookup.get(r) || this.request(r); x.responseStatus = response.status();
    const received=this.causalEvent('RESPONSE_HEADERS',{requestId:x.requestId,status:x.responseStatus});if(x.causal)x.causal.responseHeaderTimestamp=received.monotonicMs;
    const h = response.headers(), type = r.resourceType(), rawMime=(h['content-type'] || '').split(';')[0].trim().toLowerCase(), mime=['text/html','text/x-component','text/css','text/javascript','application/javascript','application/ecmascript','text/ecmascript','application/json','image/svg+xml','image/png','image/jpeg','image/webp','image/x-icon','image/avif','font/woff','font/woff2','font/ttf','font/otf','application/font-woff','application/x-font-ttf'].includes(rawMime)?rawMime:'UNAPPROVED_MIME';
    const assetKey=JSON.stringify(x.url),cached=this.verifiedCache.get(assetKey);
    const typeValid = response.status()===304 ? !!cached?.typeValid : type === 'script' ? ['text/javascript','application/javascript','application/ecmascript','text/ecmascript'].includes(mime) : type === 'stylesheet' ? mime === 'text/css' : type==='image'?mime.startsWith('image/'):type==='font'?mime.startsWith('font/')||['application/font-woff','application/x-font-ttf'].includes(mime):mime!=='UNAPPROVED_MIME';
    const redirectApproved = response.status() >= 300 && response.status() < 400 && response.status() !== 304 && !!h.location && /^http:\/\/127\.0\.0\.1:355[012]\//.test(new URL(h.location || '',response.url()).href);
    const evidence={requestId:x.requestId,url:x.url,type,rscMarker:x.rscMarker,navigationGeneration:x.navigationGeneration,status:response.status(),mime,typeValid,redirectApproved,cacheControl:h['cache-control'] || (response.status()===304?cached?.cacheControl:null) || null,assetKey,cacheAssociationVerified:response.status()===304&&!!cached};
    if(x.causal)x.causal.contentType=mime;
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
    const observation=await this.observeDocument(),a=this.activeAction;
    c.causal={clockDomainId:causalDomain,eventSequence:this.causalEvent('CHECKPOINT',{checkpointId:c.checkpointId,actionId:a?.actionId||null,pass:!!c.pass}).eventSequence,actionId:a?.actionId||null,activeDocumentId:observation?.documentId||null,documentRelation:observation?.relation||'UNKNOWN',observedGeneration:this.observedGeneration};
    const matchingAction=!!a&&c.navigationId===a.legacyNavigationId&&c.expectedURL===a.expectedCheckpointRoute;
    c.causal.operationAssociation=matchingAction?'EXACT':'UNASSOCIATED';if(!matchingAction)c.causal.actionId=null;
    if(a?.navigation&&a.operationResolved&&matchingAction){
      if(c.pass){this.observedGeneration++;a.resultingNavigationGeneration=this.observedGeneration;a.resultingDocumentId=observation?.documentId||null;a.documentRelation=!a.resultingDocumentId?'UNKNOWN':a.resultingDocumentId===a.sourceDocumentId?'SAME':a.documentHistoryAtStart.includes(a.resultingDocumentId)?'RESTORED':'NEW';a.resultingURL=urlEvidence(this.page.url());c.causal.observedGeneration=this.observedGeneration;a.checkpointId=c.checkpointId;
        for(const edge of a.outstandingSnapshot){const r=this.requests.find(x=>x.requestId===edge.requestId);edge.resultingGeneration=this.observedGeneration;edge.resultingDocumentId=a.resultingDocumentId;edge.resultingURL=a.resultingURL;edge.proven=!!r&&r.supersedingNavigationId===a.legacyNavigationId&&classifierReplay(r,this.checkpoints).provenSupersession;}
        this.actionState(a,'COMPLETED');this.causalEvent('ACTION_RESULT',{action:a});this.activeAction=null;
      }else{a.errorState=structuredError(Error('settled checkpoint failed'));this.actionState(a,'FAILED');this.causalEvent('ACTION_RESULT',{action:a});this.activeAction=null;}
    }
    if (!c.pass) throw Error('settled checkpoint failed'); return c;
  }
  diagnosticSnapshot() {
    const totals={},statuses={},failed=this.requests.filter(r=>r.failure);
    for(const r of this.responses){const status=Number.isInteger(r.status)&&r.status>=100&&r.status<=599?r.status:'UNAVAILABLE';statuses[status]=(statuses[status]||0)+1;}
    for(const r of this.requests){const c=r.failure?classify(r,this.checkpoints):'PENDING_OR_COMPLETED';totals[c]=(totals[c]||0)+1;}
    const docs=this.documents;
    return {available:true,causal:{clockDomainId:causalDomain,evidenceComplete:this.causalComplete,actions:this.actions,failedRequests:this.causalReplay(),eventCount:this.causalCount},completedCheckpointIds:this.checkpoints.filter(c=>c.pass===true).map(c=>c.checkpointId),
      currentCheckpoint:this.checkpoints.length?{checkpointId:this.checkpoints.at(-1).checkpointId,pass:this.checkpoints.at(-1).pass===true}:null,
      pendingRequests:this.outstanding.size,requestTotals:totals,responseTotalsByStatus:statuses,failedRequests:failed.length,
      unclassifiedFailures:failed.filter(r=>!r.classification).length,
      responseStatusFailures:this.responses.filter(r=>['script','stylesheet','image','font'].includes(r.type)&&!assetStatus(r)||r.url.origin==='https://api.xpertapply.com'&&r.status!==200).length,
      cspEvents:this.csp.length,pageErrors:this.errors.length,
      requiredJSFailures:failed.filter(r=>requiredKind(r)==='REQUIRED_JS_FAILURE').length,
      requiredCSSFailures:failed.filter(r=>requiredKind(r)==='REQUIRED_CSS_FAILURE').length,
      documentCount:docs.length,nonceLedgerCount:this.ledger.records.size,
      nonceAuthority:{valid:docs.filter(d=>d.nonceValid&&d.scriptAuthority&&d.policyPass).length,
       missingMalformed:docs.filter(d=>!d.nonceValid).length,headerBodyMismatches:docs.reduce((n,d)=>n+(d.headerBodyMismatches||0),0)},
      navigationGeneration:this.generation,teardownState:this.requests.some(r=>r.teardownKnownOutstanding)?'OBSERVED_STARTED':'NOT_STARTED',pass:false,complete:false};
  }
  async close(context) {
    try {
    const closeAction=this.beginAction({kind:'CONTEXT_CLOSE'});this.actionState(closeAction,'TEARDOWN');
    const checkpoint = this.checkpoints.at(-1), t = performance.now();
    closeAction.teardownSnapshot=[...this.outstanding.keys()];
    this.causalEvent('TEARDOWN_INTENT',{actionId:closeAction.actionId,teardownTimestamp:t,checkpointId:checkpoint?.checkpointId||null,outstandingRequestIds:[...this.outstanding.keys()]});
    for (const x of this.outstanding.values()) {x.teardownKnownOutstanding=true;x.teardownState='INTENTIONAL_TEARDOWN_STARTED'; x.teardownTimestampMs=t; x.checkpointId=checkpoint?.checkpointId || null;}
    closeAction.browserOperationStart=performance.now();this.actionState(closeAction,'BROWSER_OPERATION_IN_FLIGHT');this.causalEvent('ACTION_OPERATION_STARTED',{action:closeAction});
    try{await context.close();closeAction.browserOperationEnd=performance.now();closeAction.operationResolved=true;closeAction.resultingDocumentId=this.activeDocumentId;closeAction.resultingNavigationGeneration=this.observedGeneration;closeAction.resultingURL=closeAction.sourceURL;this.actionState(closeAction,'COMPLETED');this.causalEvent('ACTION_RESULT',{action:closeAction});this.activeAction=null;}catch(error){closeAction.browserOperationEnd=performance.now();closeAction.errorState=structuredError(error);this.actionState(closeAction,'FAILED');this.causalEvent('ACTION_RESULT',{action:closeAction});this.activeAction=null;throw error;} while(this.tasks.length){const tasks=this.tasks.splice(0);await Promise.all(tasks);}
    for (const r of this.requests) if (r.failure) r.classification=classify(r,this.checkpoints);
    this.persistReplay();
    for(const r of this.outstanding.values()){r.incompleteLifecycle=true;r.lifecycleState='INCOMPLETE_AFTER_TEARDOWN';}
    const hard = this.requests.filter(r => r.incompleteLifecycle || r.failure && !['RSC_EXPECTED_CANCELLATION','PREFETCH_EXPECTED_CANCELLATION'].includes(r.classification));
    const controlsPass=!this.fatalInjected ? this.csp.length===0 : (['remove','wrong','unrelated'].includes(this.fatalControl)?this.csp.length===1&&this.csp[0].directive==='style-src-elem'&&this.csp[0].disposition==='enforce':this.csp.length===0);
    const result = {causal:{clockDomainId:causalDomain,evidenceComplete:this.causalComplete,actions:this.actions,failedRequests:this.causalReplay()},expectedCSPEvents:this.fatalInjected&&['remove','wrong','unrelated'].includes(this.fatalControl)?this.csp.length:0,scenario:this.scenario,pageId:this.pageId,requests:this.requests,responses:this.responses,checkpoints:this.checkpoints,documents:this.documents,csp:this.csp,errors:this.errors,expectedErrors:this.expectedErrors,console:this.console,hardFailures:hard.length,pass:this.causalComplete && !!checkpoint && this.checkpoints.every(c=>c.pass) && !hard.length && !this.errors.length && controlsPass};
    return result;
    } finally {await this.finishCDP();}
  }
}
async function landingOperation(page, mobile) {
  if (mobile) {await page.getByRole('button',{name:'Open menu',exact:true}).click(); await page.locator('#xa-mobile-menu').waitFor(); await page.keyboard.press('Escape'); await page.locator('#xa-mobile-menu').waitFor({state:'hidden'}); await page.getByRole('button',{name:'Open menu',exact:true}).click(); await page.locator('#xa-mobile-menu').getByRole('button',{name:'Pricing',exact:true}).click();}
  else await page.getByRole('button',{name:'Pricing',exact:true}).first().click();
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'hidden'}); return true;
}
async function passwordOperation(page) {const id=await page.locator('input[type="password"]').first().getAttribute('id'); if(!id)throw Error('password identity absent');const input=page.locator('[id='+JSON.stringify(id)+']'); if (await input.getAttribute('type') !== 'password') throw Error('password initial type'); await page.getByRole('button',{name:'Show password',exact:true}).click(); if (await input.getAttribute('type') !== 'text') throw Error('password toggle inert'); await page.getByRole('button',{name:'Hide password',exact:true}).click(); if (await input.getAttribute('type') !== 'password') throw Error('password restore'); return true;}
async function landing(page,mobile) {const o=pageObservers.get(page);return o?o.withAction({kind:'UI_INTERACTION',selector:'landing-modal-menu'},()=>landingOperation(page,mobile)):landingOperation(page,mobile);}
async function password(page) {const o=pageObservers.get(page);return o?o.withAction({kind:'UI_INTERACTION',selector:'password-toggle'},()=>passwordOperation(page)):passwordOperation(page);}
async function concurrent() {
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE), dir=process.env.EVIDENCE_DIR, ledger=new Ledger(dir,'concurrent-browser'), browser=await chromium.launch({headless:true}), results=[];
  let diagnosticWritten=false;
  try {await Promise.all(['/', '/login','/pricing','/unknown-csp-qualification'].flatMap(route=>[0,1].map(async ordinal=>{
    let observer=null;
    try {
    const c=await browser.newContext({viewport:{width:1440,height:1000}}), p=await c.newPage(), o=new Observer(p,ledger,'public-'+route,'concurrent-'+route.replace(/\W/g,'_')+'-'+ordinal);observer=o; await o.install(c);
    await c.route('**/*',r=>{if (allowLocal(r.request(),'http://127.0.0.1:3551')) return r.continue(); const f=fixture(r.request(),false,o.scenario); if(f)return r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'http://127.0.0.1:3551'},body:JSON.stringify(f.body)}); return r.abort('blockedbyclient');});
    await o.withAction({kind:'DIRECT_GOTO',route,scenario:'public-'+route,navigation:true},()=>p.goto('http://127.0.0.1:3551'+route));
    let proof;
    if(route==='/') proof=await landing(p,false);
    else if(route==='/login'){await p.getByRole('heading',{name:'Sign in to XpertApply',exact:true}).waitFor();proof=await password(p);}
    else if(route==='/pricing'){await p.getByRole('heading',{name:'Pricing',exact:true}).waitFor(); const marker=await p.evaluate(()=>window.__qualDocument);await o.withAction({kind:'LINK_NAVIGATION',route:'/',selector:'home-link',scenario:'pricing-home',navigation:true},()=>p.locator('a[href="/"]').first().click());await p.waitForURL(u=>u.pathname==='/');proof=marker===await p.evaluate(()=>window.__qualDocument)&&await landing(p,false);await o.checkpoint('/',200,true,proof);await o.withAction({kind:'HISTORY_BACK',route:'/pricing',scenario:'pricing-back',navigation:true},()=>p.goBack());await p.waitForURL(u=>u.pathname==='/pricing');proof=await p.getByRole('heading',{name:'Pricing',exact:true}).isVisible();}
    else {await p.getByRole('heading',{name:'Page not found',exact:true}).waitFor();await o.checkpoint(route,404,true,true);await o.withAction({kind:'LINK_NAVIGATION',route:'/',selector:'404-home',scenario:'404-home',navigation:true},()=>p.getByRole('link',{name:'Return home',exact:true}).click());await p.waitForURL(u=>u.pathname==='/');proof=await landing(p,false);await o.checkpoint('/',200,true,proof);results.push(await o.close(c));return;}
    await o.checkpoint(route,200,true,proof);results.push(await o.close(c));
    }catch(error){observer?.failActiveAction(error);if(!diagnosticWritten){diagnosticWritten=true;atomic(dir,'concurrent-browser-error',failureArtifact(error,{phase:'concurrent-browser',scenarioId:observer?.pageId,viewport:'desktop',route,label:'scenario',step:'scenario'},observer));}throw error;}
  })));} finally {await browser.close();atomic(dir,'concurrent-browser',{schema:1,pass:results.length===8&&results.every(r=>r.pass),results});}
  if(results.length!==8||results.some(r=>!r.pass)) throw Error('concurrent classification failure');
}
module.exports={CDPGroup,CDPSidecar,cdpCorrelate,cdpURL,cdpArtifacts,classifierReplay,actionKinds,structuredError,operationMetadata,failureArtifact,hash,now,urlEvidence,sanitize,atomic,canonicalNonce,policyEvidence,Ledger,requiredKind,healthy,classify,assetStatus,clientProof,fixture,allowLocal,Observer,landing,password};
if(require.main===module) concurrent().catch(()=>{process.exitCode=1;});
