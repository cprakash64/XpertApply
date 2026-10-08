const fs=require('fs'),http=require('http'),crypto=require('crypto');
const dir=process.env.EVIDENCE_DIR, mode=process.argv[2],kind=process.argv[3]||'load',port=Number(process.env.QUAL_TEST_PORT)||(mode==='nonce'?3551:3550);
const agent=new http.Agent({keepAlive:true,maxSockets:25}),routes=['/','/login','/pricing','/privacy'];
const seen=new Set(),records=[],summaries=[],windows=[];let total=0,stop=false,current=[];
const failures={collisions:0,reuse:0,headerBodyMismatch:0,missing:0,malformed:0,crossResponseMixing:0,headerFailures:0};
const fp=s=>crypto.createHash('sha256').update(s).digest('hex');
function safe(){try{return JSON.parse(fs.readFileSync(dir+'/resource-latest.json')).safe}catch{return false}}
function request(route,level){return new Promise(resolve=>{let done=false;const start=performance.now();function finish(rec){if(done)return;done=true;total++;current.push(rec);if(kind!=='steady')records.push(rec);resolve(rec)}
const q=http.get({hostname:'127.0.0.1',port,path:route,agent,headers:{'x-nonce':'qualification-caller-chosen','content-security-policy':"script-src 'unsafe-inline'"}},r=>{const ttfb=performance.now()-start;const chunks=[];r.on('data',b=>chunks.push(b));r.on('error',e=>finish({error:e.message,latency:performance.now()-start}));r.on('end',()=>{const html=Buffer.concat(chunks).toString(),csp=r.headers['content-security-policy'],n=csp?.match(/'nonce-([^']+)'/)?.[1];const rec={route,level,status:r.statusCode,ttfb,latency:performance.now()-start,nonceFingerprint:n?fp(n):null,scriptFingerprints:[]};
if(mode==='nonce'){
if(!n)failures.missing++;else{if(!/^[A-Za-z0-9+/]{22}==$/.test(n)||Buffer.from(n,'base64').length!==16)failures.malformed++;const f=fp(n);if(seen.has(f)){failures.collisions++;failures.reuse++}seen.add(f)}
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){if(/\bsrc\s*=/.test(m[1])||/type="(?:application\/ld\+json|application\/json)"/.test(m[1]))continue;const sn=m[1].match(/\bnonce="([^"]+)"/)?.[1];rec.scriptFingerprints.push(sn?fp(sn):null);if(!sn)failures.missing++;if(sn!==n)failures.headerBodyMismatch++}
if(new Set(rec.scriptFingerprints).size>1)failures.crossResponseMixing++;
const count=r.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()==='content-security-policy').length,script=csp?.match(/(?:^|;)\s*script-src\s+([^;]+)/)?.[1]||'',style=csp?.match(/(?:^|;)\s*style-src\s+([^;]+)/)?.[1]||'';
if(count!==1||r.headers['content-security-policy-report-only']||!csp?.includes("'sha256-Wwucq8eX2r0YFymkQhDXm5hN0+FfSvI3s4JSSaqa4iw='")||(script.match(/'nonce-/g)||[]).length!==1||script.includes('unsafe-inline')||script.includes('unsafe-eval')||style.includes('unsafe-inline')||csp.includes('*')||!r.headers['cache-control']?.includes('private')||!r.headers['cache-control']?.includes('no-store')||!rec.scriptFingerprints.length)failures.headerFailures++;
}finish(rec)})});q.setTimeout(15000,()=>q.destroy(Error('request timeout')));q.on('error',e=>finish({route,level,error:e.message,latency:performance.now()-start}));})}
const quant=(xs,p)=>{xs=xs.filter(Number.isFinite).sort((a,b)=>a-b);return xs.length?xs[Math.floor((xs.length-1)*p)]:null};
function summary(xs,seconds){return {requests:xs.length,success:xs.filter(x=>x.status>=200&&x.status<400).length,errors:xs.filter(x=>x.error||x.status>=400).length,durationSeconds:seconds,reqPerSecond:xs.length/seconds,ttfb:Object.fromEntries([['p50',.5],['p95',.95],['p99',.99]].map(([k,p])=>[k,quant(xs.map(x=>x.ttfb),p)])),latency:Object.fromEntries([['p50',.5],['p95',.95],['p99',.99]].map(([k,p])=>[k,quant(xs.map(x=>x.latency),p)]))}}
(async()=>{const levels=kind==='steady'?[Number(process.env.STEADY_CONCURRENCY)]:[1,5,10,25];
for(const level of levels){if(!safe()){stop=true;break}let issued=0;current=[];const start=performance.now();let last=start;let interval;if(kind==='steady')interval=setInterval(()=>{const now=performance.now();windows.push(summary(current,(now-last)/1000));current=[];last=now;if(!safe())stop=true},5000);
await Promise.all(Array.from({length:level},async()=>{while(!stop&&(kind==='steady'?performance.now()-start<180000:issued<200)){issued++;const x=await request(routes[(issued-1)%4],level);if(x.error||x.status>=500||Object.values(failures).some(v=>v)){stop=true;break}if(issued%25===0&&!safe())stop=true}}));
if(interval)clearInterval(interval);const seconds=(performance.now()-start)/1000;let sum;
if(kind==='steady'){windows.push(summary(current,(performance.now()-last)/1000));sum={requests:windows.reduce((n,w)=>n+w.requests,0),success:windows.reduce((n,w)=>n+w.success,0),errors:windows.reduce((n,w)=>n+w.errors,0),durationSeconds:seconds,reqPerSecond:total/seconds}}
else sum=summary(current,seconds);
summaries.push({concurrency:level,...sum});if(sum.errors||sum.ttfb?.p95>3000)stop=true;
fs.writeFileSync(dir+'/'+(kind==='steady'?'steady-state':mode+'-performance')+'.json',JSON.stringify({mode,kind,totalResponses:total,uniqueNonces:seen.size,failures,summaries,windows,records,safetyAborted:stop},null,2));console.log(JSON.stringify({mode,kind,level,...sum,failures}));if(stop)break;
}agent.destroy();if(mode==='nonce'&&kind==='load')fs.copyFileSync(dir+'/nonce-performance.json',dir+'/concurrent-nonce.json');if(stop)process.exitCode=2;
})().catch(e=>{console.error(e.message);agent.destroy();process.exitCode=1});
