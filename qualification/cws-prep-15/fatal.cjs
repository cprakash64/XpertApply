'use strict';
const fs=require('fs'),crypto=require('crypto');
const {Ledger,Observer,atomic,sanitize,allowLocal}=require('./browser.cjs');
const dir=process.env.EVIDENCE_DIR, {chromium}=require(process.env.PLAYWRIGHT_MODULE);
async function run(){
 const style=JSON.parse(fs.readFileSync(dir+'/fatal-style-hash.json')), ledger=new Ledger(dir,'fatal'),browser=await chromium.launch({headless:true}),results=[];
 try{
  const matrix=[['desktop','positive',0],['mobile','positive',0],...['remove','wrong','unrelated','positive-restored'].map(mode=>['desktop',mode,1])];
  for(const [viewport,mode,ordinal] of matrix){
   const scenario='fatal-'+viewport+'-'+mode, c=await browser.newContext({viewport:viewport==='desktop'?{width:1440,height:1000}:{width:390,height:844}}),p=await c.newPage(),o=new Observer(p,ledger,scenario,scenario);await o.install(c);o.fatalInjected=true;o.fatalControl=mode;
   // The original qualification fault and three style-control mutations are preserved.
   await c.addInitScript(()=>{window.__fatalFaultCalls=[];const NativeURL=window.URL;window.URL=class extends NativeURL{constructor(input,base){if(String(input).startsWith('/')&&String(base)===location.href){const error=new Error('CSP_QUAL_FATAL_ROUTER_URL');window.__fatalFaultCalls.push({input:String(input),base:String(base),stack:error.stack});throw error;}super(input,base);}};});
   await c.route('**/*',async r=>{
    const u=new URL(r.request().url());if(!allowLocal(r.request(),'http://127.0.0.1:3551'))return r.abort('blockedbyclient');
    if(r.request().isNavigationRequest()&&r.request().resourceType()==='document'&&['remove','wrong','unrelated'].includes(mode)){
     const response=await r.fetch(),headers={...response.headers()};delete headers['content-encoding'];delete headers['content-length'];let policy=headers['content-security-policy'];
     if(mode==='remove')policy=policy.replace(' '+style.hashSource,'');
     if(mode==='wrong')policy=policy.replace(style.hashSource,"'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='");headers['content-security-policy']=policy;
     let body=await response.text();if(mode==='unrelated')body=body.replace('</head>','<style id="unrelated-control">html{outline:9px solid rgb(255,0,255)}</style></head>');return r.fulfill({status:response.status(),headers,body});
    }return r.continue();
   });
   o.navigate(scenario);await p.goto('http://127.0.0.1:3551/?qualification='+ordinal);await p.getByRole('heading',{name:'This page couldn’t load',exact:true}).waitFor();await p.waitForTimeout(100);
   const dom=await p.evaluate(()=>({heading:document.querySelector('h1')?.textContent,styles:[...document.querySelectorAll('style')].map(s=>({text:s.textContent,noncePresent:!!s.nonce})),faultCount:window.__fatalFaultCalls.length,overflow:document.documentElement.scrollWidth>innerWidth,outline:getComputedStyle(document.documentElement).outlineWidth,buttons:[...document.querySelectorAll('button')].map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))}));
   const styles=dom.styles.map(s=>({bytes:Buffer.byteLength(s.text),sha256Hex:crypto.createHash('sha256').update(s.text).digest('hex'),hashSource:"'sha256-"+crypto.createHash('sha256').update(s.text).digest('base64')+"'",noncePresent:s.noncePresent}));delete dom.styles;
   const cssPass=styles.some(s=>s.bytes===888&&s.sha256Hex===style.sha256Hex&&s.hashSource===style.hashSource);
   if(!cssPass||dom.faultCount<1)throw Error('fatal style or fault proof');await o.checkpoint('/',200,true,true);const observed=await o.close(c);
   const result={viewport,mode,ordinal,styles,dom,...observed};result.pass=observed.pass&&cssPass&&observed.expectedErrors.length===1;results.push(result);atomic(dir,'fatal-browser',{schema:1,pass:results.every(r=>r.pass),results});if(!result.pass)throw Error('fatal expected control or request classification');
  }
 }finally{await browser.close();atomic(dir,'fatal-browser',{schema:1,pass:results.length===6&&results.every(r=>r.pass),results});}
 if(results.length!==6||results.some(r=>!r.pass))throw Error('fatal matrix incomplete');
}
if(require.main===module)run().catch(e=>{atomic(dir,'fatal-error',sanitize(e.message));process.exitCode=1;});
