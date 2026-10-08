'use strict';
const fs=require('fs'),http=require('http');
const {Ledger,atomic,policyEvidence,sanitize}=require('./browser.cjs');
function fresh(sample, at=Date.now()/1000) {
 if(!sample||sample.schema!==1||sample.safe!==true||typeof sample.containerRequired!=='boolean')return false;
 const keys=['timestamp','monotonic','hostTimestamp','hostMemoryBytes','availableMemoryBytes','swapTotalBytes','swapUsedBytes','swapInPages','swapOutPages','diskFreeBytes','collectionDurationSeconds'];
 if(keys.some(k=>!Number.isFinite(sample[k])||sample[k]<0)||at<sample.timestamp||at-sample.timestamp>3||at<sample.hostTimestamp||at-sample.hostTimestamp>3)return false;
 if(!Array.isArray(sample.load)||sample.load.length!==3||sample.load.some(x=>!Number.isFinite(x)||x<0))return false;
 return !sample.containerRequired||!!sample.containerId&&['rssBytes','cpuUsageUsec','processCount'].every(k=>Number.isFinite(sample[k])&&sample[k]>=0);
}

function stats(xs, seconds) {
 const q=(values,p)=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.floor((a.length-1)*p)]:null;};
 return {requests:xs.length,success:xs.filter(x=>x.status===200&&!x.error).length,errors:xs.filter(x=>x.status!==200||x.error).length,durationSeconds:seconds,reqPerSecond:seconds>0?xs.length/seconds:null,
  ttfb:Object.fromEntries([['p50',.5],['p95',.95],['p99',.99]].map(([k,p])=>[k,q(xs.map(x=>x.ttfb),p)])),latency:Object.fromEntries([['p50',.5],['p95',.95],['p99',.99]].map(([k,p])=>[k,q(xs.map(x=>x.latency),p)]))};
}
async function execute(mode,kind='load') {
 const dir=process.env.EVIDENCE_DIR, phase=kind==='steady'?'steady-state':kind==='http'?'http-nonce':mode+'-performance', nonce=mode==='nonce';let ledger=null;
 let plan=null,routes=[],levels=[];
 const out={schema:1,runId:process.env.GITHUB_RUN_ID,sha:process.env.GITHUB_SHA,phase,mode,kind,status:'NOT_RUN',reason:null,started:new Date().toISOString(),completed:null,plannedLevels:levels,completedLevels:[],incompleteLevels:[...levels],summaries:[],windows:[],issued:0,completedRequests:0,nonceFailures:0,lastResourceSample:null,triggeringSample:null,sampleAgeSeconds:null};
 atomic(dir,phase,out);
 let stop=false, current=[], serial=0, active=new Set(), lastValid=null; const agent=new http.Agent({keepAlive:true,maxSockets:25});
 const finalize=()=>{out.completed=new Date().toISOString();out.lastResourceSample=lastValid;atomic(dir,phase,out);};
 const abort=(status,reason,sample)=>{if(stop)return;stop=true;out.status=status;out.reason=reason;out.triggeringSample=sample;out.sampleAgeSeconds=sample&&Number.isFinite(sample.timestamp)?Date.now()/1000-sample.timestamp:null;for(const q of active)q.destroy(Error('qualification stopped'));};
 const safety=()=>{let x;try{x=JSON.parse(fs.readFileSync(dir+'/resource-latest.json'));}catch{x=null;}if(!fresh(x)){abort(x&&x.safe===false?'ABORTED_FOR_SAFETY':'INSUFFICIENT_EVIDENCE','unsafe, stale or unavailable safety sample',x);return false;}lastValid=x;return true;};
 const signal=()=>{let trigger=null;try{trigger=JSON.parse(fs.readFileSync(dir+'/resource-latest.json'));}catch{}abort('ABORTED_FOR_SAFETY','orchestrator stop signal',trigger);finalize();};process.once('SIGTERM',signal);process.once('SIGINT',signal);
 async function request(route,level,issuedAt,window) {
  const ordinal=++serial, start=performance.now();out.issued++;
  return new Promise(resolve=>{
   let done=false;const finish=r=>{if(done)return;done=true;active.delete(q);out.completedRequests++;current.push(r);if(window)window.push(r);resolve(r);};
   const q=http.get({hostname:'127.0.0.1',port:Number(process.env.QUAL_TEST_PORT)||(nonce?3551:3550),path:route,agent,headers:{'x-nonce':'qualification-caller-chosen','content-security-policy':"script-src 'unsafe-inline'"}},r=>{
    const ttfb=performance.now()-start,chunks=[];r.on('data',b=>chunks.push(b));r.on('error',e=>finish({route,level,error:sanitize(e.message),latency:performance.now()-start}));
    r.on('end',()=>{try{
     const x={route,level,status:r.statusCode,issuedAt,ttfb,latency:performance.now()-start};
     if(nonce){const headers=[];for(let i=0;i<r.rawHeaders.length;i+=2)headers.push({name:r.rawHeaders[i],value:r.rawHeaders[i+1]});const a=policyEvidence(headers,Buffer.concat(chunks).toString());ledger.add(phase+'-doc-'+ordinal,phase+'-request-'+ordinal,phase+'-'+level,'http://127.0.0.1:3551'+route,r.statusCode,a);if(!a.nonceValid||!a.scriptAuthority||!a.policyPass||!a.htmlCachePass||!a.poweredByAbsent){out.nonceFailures++;abort('BLOCK','nonce authority failure',lastValid);}}
     if(r.statusCode!==200)abort('BLOCK','unexpected HTTP status',lastValid);finish(x);
    }catch(e){abort('BLOCK','nonce evidence exception',lastValid);finish({route,level,error:sanitize(e.message),latency:performance.now()-start});}});
   });
   active.add(q);q.setTimeout(15000,()=>q.destroy(Error('request timeout')));q.on('error',e=>{finish({route,level,error:sanitize(e.message),latency:performance.now()-start});if(!stop)abort('BLOCK','HTTP request failure',lastValid);});
  });
 }
 let interval;
 try {
  plan=JSON.parse(fs.readFileSync(dir+'/performance-plan.json'));routes=plan.routes;levels=kind==='steady'?[Number(process.env.STEADY_CONCURRENCY)]:plan.levels;out.plannedLevels=levels;out.incompleteLevels=[...levels];if(nonce)ledger=new Ledger(dir,phase);
  if(!Array.isArray(levels)||!levels.length||levels.some(x=>![1,5,10,25].includes(x))||JSON.stringify(routes)!==JSON.stringify(['/','/login','/pricing','/privacy']))throw Error('invalid frozen plan');
  out.status='RUNNING';interval=setInterval(safety,250);
  for(const level of levels) {
   if(!safety())break;
   current=[];let issued=0;const start=performance.now(), startMono=Number(process.hrtime.bigint())/1e6, windows=Array.from({length:36},()=>[]), counts=Object.fromEntries(routes.map(r=>[r,0]));
   const target=kind==='steady'?Infinity:200;
   await Promise.all(Array.from({length:level},async()=>{
    while(!stop && issued<target && (kind!=='steady'||performance.now()-start<180000)) {
     if(!safety())break;const elapsed=performance.now()-start, ordinal=issued++,route=routes[ordinal%routes.length];counts[route]++;
     await request(route,level,elapsed,kind==='steady'?windows[Math.min(35,Math.floor(elapsed/5000))]:null);
    }
   }));
   const duration=(performance.now()-start)/1000;
   if(kind==='steady'){
    out.intendedIssuanceSeconds=180;out.actualIssuanceSeconds=stop?Math.min(duration,180):180;out.actualTotalSeconds=duration;out.drainSeconds=Math.max(0,duration-180);
    out.windows=windows.map((xs,i)=>({index:i,startSeconds:i*5,endSeconds:(i+1)*5,complete:!stop&&duration>=180,...stats(xs,5)}));
   }
   const summary={concurrency:level,startMonotonicMs:startMono,endMonotonicMs:Number(process.hrtime.bigint())/1e6,routeCounts:counts,...stats(current,duration)};out.summaries.push(summary);
   const complete=!stop && summary.errors===0 && (kind==='steady'?duration>=180&&duration<=195&&out.windows.length===36&&out.windows.every(w=>w.complete&&w.requests>0):summary.requests===200&&summary.success===200&&routes.every(r=>counts[r]===50));
   if(!complete && !stop)abort('INSUFFICIENT_EVIDENCE','incomplete level or issuance/drain accounting',lastValid);
   if(complete){out.completedLevels.push(level);out.incompleteLevels=levels.filter(x=>!out.completedLevels.includes(x));}
   finalize();if(stop)break;
  }
  if(!stop&&out.incompleteLevels.length===0&&out.issued===out.completedRequests)out.status='PASS';else if(!stop)out.status='INSUFFICIENT_EVIDENCE';
 }catch(e){out.status='BLOCK';out.reason=sanitize(e.message);stop=true;}
 finally{clearInterval(interval);agent.destroy();process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);finalize();}
 return out;
}
module.exports={fresh,stats,execute};
if(require.main===module)execute(process.argv[2],process.argv[3]||'load').then(x=>{if(x.status!=='PASS')process.exitCode=2;}).catch(()=>{process.exitCode=1;});
