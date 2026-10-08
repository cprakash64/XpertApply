const fs=require('fs'),crypto=require('crypto'),{chromium}=require(process.env.PLAYWRIGHT_MODULE);
const dir=process.env.EVIDENCE_DIR,fp=s=>s?crypto.createHash('sha256').update(s).digest('hex'):null,redact=s=>s.replace(/'nonce-[^']+'/g,"'nonce-REDACTED'").replace(/nonce="[^"]*"/g,'nonce="REDACTED"');
(async()=>{const b=await chromium.launch({headless:true}),results=[];
try{await Promise.all(['/', '/login','/pricing','/unknown-csp-qualification'].flatMap(route=>[0,1].map(async ordinal=>{
const x={route,ordinal,csp:[],pageerrors:[],failed:[],console:[]};results.push(x);const c=await b.newContext({viewport:{width:1440,height:1000}});
await c.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({google:{enabled:false}})}));
await c.exposeBinding('__event',(_,e)=>x.csp.push(e));await c.addInitScript(()=>addEventListener('securitypolicyviolation',e=>window.__event({effectiveDirective:e.effectiveDirective,blockedURI:e.blockedURI,disposition:e.disposition})));
const p=await c.newPage();p.on('pageerror',e=>x.pageerrors.push(redact(e.message)));p.on('requestfailed',r=>x.failed.push({url:r.url(),type:r.resourceType()}));p.on('console',m=>x.console.push({type:m.type(),text:redact(m.text())}));
const response=await p.goto('http://127.0.0.1:3551'+route);await p.waitForLoadState('networkidle');const hs=await response.headersArray(),csp=response.headers()['content-security-policy'],n=csp?.match(/'nonce-([^']+)'/)?.[1];const scripts=await p.evaluate(()=>[...document.scripts].filter(s=>!s.src&&!['application/ld+json','application/json'].includes(s.type)).map(s=>s.nonce));
x.status=response.status();x.nonceFingerprint=fp(n);x.scriptFingerprints=scripts.map(fp);x.authorityMatch=!!n&&scripts.length>0&&scripts.every(s=>s===n);x.cspCount=hs.filter(h=>h.name.toLowerCase()==='content-security-policy').length;x.hydrated=await p.evaluate(()=>[...document.querySelectorAll('a,button,form')].some(e=>Object.keys(e).some(k=>k.startsWith('__reactFiber$'))));await c.close();
})));}finally{await b.close()}
const pass=results.every(x=>x.authorityMatch&&x.cspCount===1&&x.hydrated&&!x.csp.length&&!x.pageerrors.length&&!x.failed.length)&&new Set(results.map(x=>x.nonceFingerprint)).size===results.length;
fs.writeFileSync(dir+'/concurrent-browser.json',JSON.stringify({pass,results},null,2));if(!pass)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1});
