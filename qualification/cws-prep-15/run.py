"""Fail-closed, ephemeral Linux qualification. Importing performs no I/O or execution."""
import contextlib
import hashlib
import json
import math
import os
import platform
import re
import shutil
import signal
import statistics
import subprocess
import threading
import time
from pathlib import Path

BASE = 'a63945ea5f84f63d45d30ff81b67c043fad57ba9'
R1 = 'f7735c469fc147d40c49a414dc763aca057565c6'
R4 = 'efa1fe38b7c164b1c6d6e10191799e0dadf76a68'
R3 = 'c81e1f62ed6434ac7bcab551a4b1a96a485c7d5b'
DIGEST = 'cbe49db9c79b7ff5dfcb964f777f8948add521429ba732bc18e4f40bf9cfe1b0'
BRANCH = 'refs/heads/qualification/cws-prep-15-nonce-container'
STYLE_SHA = '5b0b9cabc797dabd181729a44210d79b984dd3e15f4af237b3825249aa9ae22c'
STYLE_SOURCE = "'sha256-Wwucq8eX2r0YFymkQhDXm5hN0+FfSvI3s4JSSaqa4iw='"
R3_PATHS = frozenset({'.github/workflows/cws-prep-15-qualification.yml', 'qualification/cws-prep-15/run.py'})
R4_PATHS = R3_PATHS | frozenset('qualification/cws-prep-15/' + n for n in ('browser.cjs','smoke.cjs','load.cjs','fatal.cjs'))
R1_PATHS = R4_PATHS | frozenset({
 'qualification/cws-prep-15/frozen-manifest.json', 'apps/web/app/csp-qualification-error/page.tsx',
 'apps/web/app/error.tsx', 'apps/web/app/global-error.tsx', 'apps/web/app/layout.tsx',
 'apps/web/app/not-found.tsx', 'apps/web/lib/securityPolicy.d.mts', 'apps/web/next.config.mjs',
 'apps/web/proxy.ts', 'apps/web/public/csp-error.css'})
REPAIR_PATHS = R3_PATHS | frozenset('qualification/cws-prep-15/' + n for n in ('browser.cjs','smoke.cjs'))
PHASES = ('AUTHORITY','RUNNER','BASELINE_BUILD','NONCE_BUILD','FRAMEWORK_HASH','FUNCTIONAL_SMOKE',
 'DESKTOP','MOBILE','CONCURRENT_BROWSER','HTTP_NONCE','HEADERS_CACHE','STATIC_ASSETS',
 'BASELINE_PERFORMANCE','NONCE_PERFORMANCE','RELATIVE_DELTAS','STEADY_STATE','COOLDOWN',
 'REPOSITORY_CHECKS','SECURITY_AGGREGATION')
RO_TEST = 'uses only Report-Only and suppresses the powered-by header'
RO_FULL_TEST = 'static-safe CSP observation ' + RO_TEST
LEDGERS = ('smoke','fatal','concurrent-browser','http-nonce','nonce-performance','steady-state')

class Block(Exception):
    pass

def fingerprint(data):
    return hashlib.sha256(data).hexdigest()

def utc():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

def diagnostic(error):
    return {'type': type(error).__name__, 'messageFingerprint': fingerprint(str(error).encode())}

def helper_diagnostic(out, helper, phase, started, ended, duration, rc, artifact):
    report={'schema':1,'helper':helper if helper in ('smoke.cjs','browser.cjs','fatal.cjs','load.cjs') else 'UNKNOWN',
            'phase':phase if phase in PHASES else 'UNKNOWN','started':started,'ended':ended,
            'durationSeconds':duration,'returnCode':rc,'expectedArtifact':artifact,
            'artifactExists':False,'artifactStatus':'DIAGNOSTIC_ARTIFACT_MISSING',
            'stdoutHandling':'DISCARDED_NOT_PERSISTED','stderrHandling':'DISCARDED_NOT_PERSISTED','pass':False,'complete':False}
    if artifact and (out/artifact).is_file():
        report['artifactExists']=True
        try:
            data=json.loads((out/artifact).read_text())
            valid=(isinstance(data,dict) and data.get('schema')==1 and data.get('pass') is False and
                   data.get('complete') is False and data.get('phase') in ('smoke','concurrent-browser') and
                   data.get('sha')==os.environ.get('GITHUB_SHA') and isinstance(data.get('error'),dict) and
                   isinstance(data.get('operation'),dict) and isinstance(data.get('snapshot'),dict))
            report['artifactStatus']='STRUCTURED_FAILURE_VALID' if valid else 'DIAGNOSTIC_ARTIFACT_INVALID'
        except (ValueError,OSError):report['artifactStatus']='DIAGNOSTIC_ARTIFACT_INVALID'
    return report

def edge_paths(entries, expected, allowed_statuses=('M',)):
    return (len(entries) == len(expected) and {p for status,p in entries} == set(expected)
            and all(status in allowed_statuses for status,p in entries))

def qualification_authority(expected_sha, head, parents, r4_parents, r3_parents, r1_parents, edges,
                            event='push', ref=BRANCH, manifest=DIGEST):
    sha = isinstance(expected_sha,str) and re.fullmatch('[0-9a-f]{40}',expected_sha) is not None
    topology = sha and head == expected_sha and parents == [R4] and r4_parents == [R3] and r3_parents == [R1] and r1_parents == [BASE]
    paths = (edge_paths(edges.get('r1',[]),R1_PATHS,('A','M')) and
             edge_paths(edges.get('r3',[]),R3_PATHS) and edge_paths(edges.get('r4',[]),R4_PATHS) and
             edge_paths(edges.get('repair',[]),REPAIR_PATHS))
    return {'shaValid':sha,'topologyPass':topology,'pathsPass':paths,
            'pass':bool(topology and paths and event=='push' and ref==BRANCH and manifest==DIGEST)}

def frozen(root):
    manifest = json.loads((root/'qualification/cws-prep-15/frozen-manifest.json').read_text())
    actual = {'baseSHA':BASE,'files':[]}
    for record in manifest['files']:
        data = (root/record['path']).read_bytes()
        actual['files'].append({**record,'bytes':len(data),'sha256':fingerprint(data)})
    digest = fingerprint(json.dumps(actual,sort_keys=True,indent=2).encode())
    if manifest.get('baseSHA') != BASE or len(actual['files']) != 9 or digest != DIGEST:
        raise Block('BLOCK — AUTHORITY/FROZEN SOURCE VIOLATION')
    return digest

def aggregate_nonce(out, run_id, sha, phases, require_nonempty=True):
    documents, seen = {}, {}
    result = {'schema':1,'totalDocuments':0,'uniqueFingerprints':0,'collisions':0,
              'crossDocumentReuse':0,'crossPhaseReuse':0,'headerBodyMismatches':0,
              'missingMalformed':0,'policyFailures':0,'cacheFailures':0,'poweredByFailures':0}
    for phase in phases:
        file = out/(phase+'-nonces.jsonl')
        if not file.is_file(): raise ValueError('missing nonce ledger')
        lines = file.read_text().splitlines()
        if require_nonempty and not lines: raise ValueError('empty nonce ledger')
        for line in lines:
            x = json.loads(line)
            required = ('schema','runId','sha','phase','documentId','requestId','scenario','route','status',
                        'nonceFingerprint','nonceValid','cspCount','scriptAuthority','scriptCount',
                        'headerBodyMismatches','missingScriptNonces','policyPass','htmlCachePass','poweredByAbsent')
            if any(k not in x for k in required): raise ValueError('missing nonce record field')
            if x['schema']!=1 or x['runId']!=run_id or x['sha']!=sha or x['phase']!=phase:
                raise ValueError('wrong nonce authority')
            if not isinstance(x['documentId'],str) or not x['documentId'] or not isinstance(x['requestId'],str) or not x['requestId']:
                raise ValueError('invalid document identity')
            allowed=set(required)|{'reportOnlyCount','fatalStyleControl','fatalControlBasePass'}
            if set(x)-allowed:raise ValueError('unapproved nonce field')
            if any(type(x[k]) is not bool for k in ('nonceValid','scriptAuthority','policyPass','htmlCachePass','poweredByAbsent')):raise ValueError('malformed boolean')
            if any(type(x[k]) is not int or x[k]<0 for k in ('cspCount','scriptCount','headerBodyMismatches','missingScriptNonces')):raise ValueError('malformed count')
            if type(x['status']) is not int or x['status'] not in (200,404,500):raise ValueError('invalid document status')
            f = x['nonceFingerprint']
            if not isinstance(f,str) or re.fullmatch('[0-9a-f]{64}',f) is None: raise ValueError('malformed fingerprint')
            key = x['documentId']
            if key in documents:
                if documents[key] != x: raise ValueError('conflicting same document')
                continue
            documents[key] = x
            if f in seen:
                result['collisions'] += 1; result['crossDocumentReuse'] += 1
                if seen[f]['phase'] != phase: result['crossPhaseReuse'] += 1
            else: seen[f] = x
            if x['nonceValid'] is not True or x['cspCount']!=1 or x['scriptAuthority'] is not True or x['scriptCount']<1:
                result['missingMalformed'] += 1
            result['missingMalformed'] += x['missingScriptNonces']
            result['headerBodyMismatches'] += x['headerBodyMismatches']
            control = phase=='fatal' and x.get('scenario','').endswith(('remove','wrong')) and x.get('fatalControlBasePass') is True and x.get('fatalStyleControl') in ('remove','wrong')
            if x['policyPass'] is not True and not control: result['policyFailures'] += 1
            if x['htmlCachePass'] is not True: result['cacheFailures'] += 1
            if x['poweredByAbsent'] is not True: result['poweredByFailures'] += 1
    result['totalDocuments']=len(documents); result['uniqueFingerprints']=len(seen)
    result['pass']=bool(documents) and not any(result[k] for k in ('collisions','crossDocumentReuse','crossPhaseReuse','headerBodyMismatches','missingMalformed','policyFailures','cacheFailures','poweredByFailures'))
    return result

def fresh(sample, at=None):
    at = time.time() if at is None else at
    if not isinstance(sample,dict) or sample.get('schema')!=1 or sample.get('safe') is not True or type(sample.get('containerRequired')) is not bool:return False
    keys=('timestamp','monotonic','hostTimestamp','hostMemoryBytes','availableMemoryBytes','swapTotalBytes','swapUsedBytes','swapInPages','swapOutPages','diskFreeBytes','collectionDurationSeconds')
    if any(not isinstance(sample.get(k),(int,float)) or not math.isfinite(sample[k]) or sample[k]<0 for k in keys):return False
    if not 0<=at-sample['timestamp']<=3 or not 0<=at-sample['hostTimestamp']<=3:return False
    if not isinstance(sample.get('load'),(list,tuple)) or len(sample['load'])!=3 or any(not isinstance(x,(int,float)) or not math.isfinite(x) or x<0 for x in sample['load']):return False
    return not sample['containerRequired'] or bool(sample.get('containerId')) and all(isinstance(sample.get(k),(int,float)) and math.isfinite(sample[k]) and sample[k]>=0 for k in ('rssBytes','cpuUsageUsec','processCount'))

def coverage(xs, count, seconds, max_gap=3):
    if len(xs)<count or any(not isinstance(x.get('rssBytes'),(int,float)) or x['rssBytes']<=0 or x.get('safe') is not True for x in xs): return False
    ts=[x['monotonic'] for x in xs]
    return ts==sorted(ts) and ts[-1]-ts[0]>=seconds and all(0 < b-a <= max_gap for a,b in zip(ts,ts[1:]))

def memory_classification(reference, steady, cooldown):
    if not coverage(reference,25,28) or not coverage(steady,150,175) or not coverage(cooldown,25,28):
        return {'classification':'INSUFFICIENT_EVIDENCE','pass':False}
    ref=statistics.median(x['rssBytes'] for x in reference); start=steady[0]['monotonic']
    bins=[[x['rssBytes'] for x in steady if i*30 <= x['monotonic']-start < (i+1)*30] for i in range(6)]
    if any(not b for b in bins): return {'classification':'INSUFFICIENT_EVIDENCE','pass':False}
    medians=[statistics.median(b) for b in bins]; end=cooldown[-1]['monotonic']
    post=statistics.median(x['rssBytes'] for x in cooldown if x['monotonic']>=end-10)
    growth=medians[-1]-medians[0]; slope=growth/150; allowance=max(64*1024**2,ref*.25)
    clear=(all(b>a for a,b in zip(medians,medians[1:])) and growth>max(128*1024**2,ref*.5)
           and slope>=1024**2 and post>=medians[-1]-allowance)
    possible=post>ref+allowance or (slope>0 and growth>allowance)
    category='CLEAR UNBOUNDED GROWTH' if clear else 'POSSIBLE RETENTION' if possible else 'NO CONCERN OBSERVED'
    return {'classification':category,'pass':category=='NO CONCERN OBSERVED','referenceMedianBytes':ref,
            'steadyPeakBytes':max(x['rssBytes'] for x in steady),'lateSteadyMedianBytes':medians[-1],
            'cooldownFinalTenSecondMedianBytes':post,'steadyBinMediansBytes':medians,'observedSlopeBytesPerSecond':slope,
            'claim':'Finite observation only; absence of a memory leak is not established'}

def steady_complete(state, samples):
    try:
        windows=state['windows']
        return (state['status']=='PASS' and state['intendedIssuanceSeconds']==180 and
                180<=state['actualIssuanceSeconds']<=180.1 and 180<=state['actualTotalSeconds']<=195 and
                0<=state['drainSeconds']<=15 and state['issued']==state['completedRequests'] and state['issued']>0 and state['nonceFailures']==0 and
                len(windows)==36 and all(w['index']==i and w['startSeconds']==i*5 and w['endSeconds']==(i+1)*5 and w['complete'] is True and w['requests']>0 and w['errors']==0 and w['requests']==w['success'] for i,w in enumerate(windows)) and
                sum(w['requests'] for w in windows)==state['completedRequests'] and coverage(samples,150,175))
    except (KeyError,TypeError):return False

def compare_performance(before, after, plan, resource):
    result={'schema':1,'status':'INSUFFICIENT_EVIDENCE','reason':None,'deltas':[]}
    try:
        if before['status']!='PASS' or after['status']!='PASS': raise ValueError('incomplete performance')
        b={x['concurrency']:x for x in before['summaries']}; n={x['concurrency']:x for x in after['summaries']}
        if len(b)!=len(before['summaries']) or len(n)!=len(after['summaries']) or set(b)!=set(plan['levels']) or set(n)!=set(b): raise ValueError('planned level mismatch')
        for level in plan['levels']:
            a,z=b[level],n[level]
            if a['requests']!=200 or z['requests']!=200 or a['success']!=200 or z['success']!=200 or a['errors'] or z['errors'] or a['routeCounts']!=z['routeCounts'] or a['routeCounts']!={r:50 for r in plan['routes']}:
                raise ValueError('incomplete or unequal workload')
            rs={}
            for mode,x in [('baseline',a),('nonce',z)]:
                # Samples bracketing each level: retain the nearest sample on either side.
                all_x=sorted([s for s in resource if s.get('phase')==mode+'-performance' and s.get('rssBytes') is not None],key=lambda s:s['monotonic'])
                lo=x['startMonotonicMs']/1000; hi=x['endMonotonicMs']/1000
                prior=[s for s in all_x if s['monotonic']<=lo]; following=[s for s in all_x if s['monotonic']>=hi]
                middle=[s for s in all_x if lo<s['monotonic']<hi]
                xs=(prior[-1:] + middle + following[:1])
                if len(xs)<3 or not prior or not following or xs[-1]['monotonic']-xs[0]['monotonic']<.1 or any(not fresh(s,s['timestamp']) for s in xs): raise ValueError('insufficient resource interval')
                elapsed=xs[-1]['monotonic']-xs[0]['monotonic']; cpu=(xs[-1]['cpuUsageUsec']-xs[0]['cpuUsageUsec'])/1e6/elapsed*100
                rs[mode]={'samples':len(xs),'meanRSSBytes':statistics.mean(s['rssBytes'] for s in xs),'cpuPercent':cpu}
            def delta(v,w):
                if not all(isinstance(t,(int,float)) and math.isfinite(t) and t>0 for t in (v,w)): raise ValueError('nonpositive or invalid measurement')
                return 100*(w/v-1)
            result['deltas'].append({'concurrency':level,'throughputPercent':delta(a['reqPerSecond'],z['reqPerSecond']),
             'ttfbPercent':{k:delta(a['ttfb'][k],z['ttfb'][k]) for k in ('p50','p95','p99')},
             'latencyPercent':{k:delta(a['latency'][k],z['latency'][k]) for k in ('p50','p95','p99')},'resources':rs,
             'rssPercent':delta(rs['baseline']['meanRSSBytes'],rs['nonce']['meanRSSBytes']),
             'cpuPercentDelta':delta(rs['baseline']['cpuPercent'],rs['nonce']['cpuPercent'])})
        result['status']='PASS'
    except (ValueError,KeyError,TypeError) as e: result['reason']=diagnostic(e)
    return result

def source_mode_conflict(report):
    tests=[x for suite in report.get('testResults',[]) for x in suite.get('assertionResults',[])]
    failures=[x for x in tests if x.get('status')=='failed']
    if len(failures)!=1 or failures[0].get('fullName')!=RO_FULL_TEST: return False
    suite_failures=[s for s in report.get('testResults',[]) if s.get('status')=='failed']
    if len(suite_failures)!=1 or not suite_failures[0].get('name','').endswith('/__tests__/securityPolicy.test.ts'): return False
    messages=failures[0].get('failureMessages',[])
    return len(messages)==1 and 'AssertionError' in messages[0] and 'Content-Security-Policy-Report-Only' in messages[0] and 'to deeply equal' in messages[0] and report.get('numFailedTests')==1 and all(t.get('status') in ('passed','failed') for t in tests)

class Harness:
    def __init__(self, root, out):
        self.root=root; self.help=root/'qualification/cws-prep-15';self.out=out;out.mkdir(parents=True,exist_ok=True)
        self.run_id=os.environ['GITHUB_RUN_ID'];self.sha=os.environ.get('GITHUB_SHA');self.phase='AUTHORITY';self.samples=[];self.container=None;self.cgroup=None;self.stop=threading.Event();self.monitor_thread=None;self.latest=None;self.docker_root=None;self.safety_fault=None;self.nonce_completed=[];self.state_lock=threading.Lock()
        self.phases={p:{'schema':1,'runId':self.run_id,'sha':self.sha,'phase':p,'required':True,'status':'NOT_RUN','started':None,'completed':None,'artifacts':[],'expectedCounts':{},'actualCounts':{},'dependencies':[],'reason':'not executed'} for p in PHASES}
        self.write('phase-manifest',{'schema':1,'runId':self.run_id,'sha':self.sha,'phases':list(self.phases.values())})
    def write(self,name,data):
        p=self.out/(name+'.json');tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(data,indent=2));tmp.replace(p)
    def read(self,name):return json.loads((self.out/(name+'.json')).read_text())
    def command(self,*args,cwd=None,timeout=60):return subprocess.check_output(args,cwd=cwd or self.root,text=True,timeout=timeout).strip()
    def seal(self,p,artifacts,counts=None,dependencies=()):
        x=self.phases[p];x.update(status='PASS',completed=utc(),reason=None,dependencies=list(dependencies) or ([] if p=='AUTHORITY' else [PHASES[PHASES.index(p)-1]]),expectedCounts=counts or {},actualCounts=counts or {})
        x['artifacts']=[{'path':name,'sha256':fingerprint((self.out/name).read_bytes())} for name in artifacts]
        if not artifacts:raise ValueError('empty phase evidence')
        self.write('phase-manifest',{'schema':1,'runId':self.run_id,'sha':self.sha,'phases':list(self.phases.values())})
    @contextlib.contextmanager
    def stage(self,p):
        self.phase=p;self.phases[p].update(status='RUNNING',started=utc(),reason=None)
        self.write('phase-manifest',{'schema':1,'runId':self.run_id,'sha':self.sha,'phases':list(self.phases.values())})
        try:yield
        except BaseException as e:
            self.phases[p].update(status='BLOCK',completed=utc(),reason=diagnostic(e));raise
    def logged(self,args,name,cwd=None,check=True,timeout=1200):
        # Process output is not persisted; structured test reporters provide sanitized summaries.
        p=subprocess.Popen(args,cwd=cwd or self.root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        begin=time.monotonic();reason=None
        while p.poll() is None:
            if time.monotonic()-begin>timeout:reason='timeout'
            if self.monitor_thread and not fresh(self.latest):reason='stale or unsafe safety evidence'
            if reason:
                os.killpg(p.pid,signal.SIGTERM)
                try:p.wait(timeout=5)
                except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
                self.write(name,{'returnCode':p.returncode,'status':'INSUFFICIENT_EVIDENCE','reason':reason});raise Block('BLOCK — STEADY-STATE/RESOURCE EVIDENCE INCOMPLETE')
            time.sleep(.1)
        if check and p.returncode:raise subprocess.CalledProcessError(p.returncode,args)
        return p.returncode
    def nonce_boundary(self,phase):
        if phase not in LEDGERS or phase in self.nonce_completed:raise ValueError('invalid or repeated ledger phase boundary')
        self.nonce_completed.append(phase)
        try:result=aggregate_nonce(self.out,self.run_id,self.sha,self.nonce_completed)
        except (ValueError,KeyError,TypeError) as e:
            self.write('nonce-aggregation-'+phase,{'schema':1,'pass':False,'reason':diagnostic(e)});raise Block('BLOCK — CONCURRENT NONCE AUTHORITY FAILURE')
        self.write('nonce-aggregation-'+phase,result)
        if not result['pass']:raise Block('BLOCK — CROSS-PHASE NONCE REUSE' if result['crossPhaseReuse'] else 'BLOCK — CONCURRENT NONCE AUTHORITY FAILURE')
        return result
    def node(self,name,*args,check=True,timeout=600):
        started=utc();begin=time.monotonic()
        artifact={'smoke.cjs':'smoke-error.json','browser.cjs':'concurrent-browser-error.json'}.get(name)
        try:
            rc=self.logged(['node',str(self.help/name),*args],name+'-'+('-'.join(args) or 'run'),check=False,timeout=timeout)
        except BaseException:
            self.write('helper-diagnostic',helper_diagnostic(self.out,name,self.phase,started,utc(),time.monotonic()-begin,None,artifact))
            raise
        if rc:
            report=helper_diagnostic(self.out,name,self.phase,started,utc(),time.monotonic()-begin,rc,artifact)
            self.write('helper-diagnostic',report)
            if check:raise Block('BLOCK — HELPER FAILURE: '+report['artifactStatus'])
        phase={'smoke.cjs':'smoke','fatal.cjs':'fatal','browser.cjs':'concurrent-browser'}.get(name)
        if name=='load.cjs' and args and args[0]=='nonce':phase='steady-state' if len(args)>1 and args[1]=='steady' else 'http-nonce' if len(args)>1 and args[1]=='http' else 'nonce-performance'
        if rc==0 and phase:self.nonce_boundary(phase)
        return rc
    def host(self):
        begin=time.monotonic();m={l.split(':')[0]:int(l.split()[1])*1024 for l in Path('/proc/meminfo').read_text().splitlines()};v={l.split()[0]:int(l.split()[1]) for l in Path('/proc/vmstat').read_text().splitlines()}
        disk=min(shutil.disk_usage('/').free,shutil.disk_usage(self.docker_root).free);load=os.getloadavg()
        swap_in=v['pswpin']-self.swap_origin['pswpin'];swap_out=v['pswpout']-self.swap_origin['pswpout']
        return {'hostTimestamp':time.time(),'hostMonotonic':time.monotonic(),'collectionDurationSeconds':time.monotonic()-begin,'hostMemoryBytes':m['MemTotal'],'availableMemoryBytes':m['MemAvailable'],'swapTotalBytes':m['SwapTotal'],'swapUsedBytes':m['SwapTotal']-m['SwapFree'],'swapInPages':swap_in,'swapOutPages':swap_out,'diskFreeBytes':disk,'load':load,
          'hostSafe':m['MemAvailable']>=1024**3 and disk>=5*1024**3 and load[0]<os.cpu_count()*6 and (swap_in+swap_out)*os.sysconf('SC_PAGE_SIZE')<64*1024**2}
    def monitor(self):
        host=None;last_cpu=None
        while not self.stop.is_set():
            begin=time.monotonic()
            try:
                if host is None or time.time()-host['hostTimestamp']>=1:host=self.host()
                with self.state_lock:observed_container,cg=self.container,self.cgroup
                x={**host,'schema':1,'timestamp':time.time(),'utc':utc(),'monotonic':time.monotonic(),'phase':self.phase.lower().replace('_','-'),'containerId':observed_container,'containerRequired':bool(observed_container),'cpuUsageUsec':None,'cpuPercent':None,'rssBytes':None,'rssMethod':'sum process VmRSS from cgroup.procs','processCount':None,'availability':{}}
                if observed_container:
                    if cg is None:raise ValueError('cgroup unavailable')
                    cpus=dict(line.split() for line in (cg/'cpu.stat').read_text().splitlines());pids=(cg/'cgroup.procs').read_text().split();rss=[]
                    for pid in pids:
                        try:
                            text=Path('/proc/'+pid+'/status').read_text();match=re.search(r'^VmRSS:\s+(\d+) kB$',text,re.M)
                            if match:rss.append(int(match[1])*1024)
                        except FileNotFoundError:continue
                    if not rss:raise ValueError('RSS unavailable')
                    x.update(cpuUsageUsec=int(cpus['usage_usec']),rssBytes=sum(rss),processCount=len(rss))
                    if last_cpu and last_cpu[0]==observed_container:
                        dt=x['monotonic']-last_cpu[1];x['cpuPercent']=(x['cpuUsageUsec']-last_cpu[2])/1e6/dt*100
                    last_cpu=(observed_container,x['monotonic'],x['cpuUsageUsec'])
                else:last_cpu=None
                x['sampleAgeSeconds']=time.time()-x['timestamp'];x['hostSampleAgeSeconds']=time.time()-host['hostTimestamp'];x['collectionDurationSeconds']+=time.monotonic()-begin
                x['availability']={k:'AVAILABLE' if x[k] is not None else 'UNAVAILABLE' for k in ('rssBytes','cpuUsageUsec','processCount')}
                x['safe']=host['hostSafe'] and x['hostSampleAgeSeconds']<=3 and (not observed_container or all(x[k] is not None for k in ('rssBytes','cpuUsageUsec','processCount')))
            except Exception as e:
                if locals().get('observed_container') != self.container:continue
                x={'schema':1,'timestamp':time.time(),'monotonic':time.monotonic(),'phase':self.phase.lower().replace('_','-'),'safe':False,'rssBytes':None,'cpuUsageUsec':None,'processCount':None,'availability':{'rssBytes':'UNAVAILABLE'},'reason':diagnostic(e)}
            if x.get('safe') is not True and self.safety_fault is None:self.safety_fault=x.get('reason',{'reason':'required safety contract failed'})
            if self.safety_fault is not None:x['safe']=False;x['safetyFailureLatched']=True;x['latchedReason']=self.safety_fault
            self.latest=x;self.samples.append(x);self.write('resource-latest',x)
            with (self.out/'resource-samples.jsonl').open('a') as f:f.write(json.dumps(x)+'\n')
            self.stop.wait(.01 if self.phase in ('BASELINE_PERFORMANCE','NONCE_PERFORMANCE') else max(.01,1-(time.monotonic()-begin)))
    def start(self,image,mode):
        name='cws15-'+mode+'-'+self.run_id;port=3550 if mode=='baseline' else 3551
        self.command('docker','run','-d','--name',name,'--publish',f'127.0.0.1:{port}:3000',image)
        pid=self.command('docker','inspect','--format','{{.State.Pid}}',name)
        entry=[l for l in Path('/proc/'+pid+'/cgroup').read_text().splitlines() if l.startswith('0::')]
        if len(entry)!=1:raise ValueError('unavailable cgroup v2')
        cg=Path('/sys/fs/cgroup')/entry[0][3:].lstrip('/')
        if not (cg/'cpu.stat').is_file() or not (cg/'cgroup.procs').is_file():raise ValueError('unavailable cgroup measurements')
        with self.state_lock:self.cgroup=cg;self.container=name
        time.sleep(1.1)
        import urllib.request
        for _ in range(90):
            try:
                with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:'+str(port),method='HEAD'),timeout=3) as r:
                    if r.status==200:return
            except Exception:time.sleep(1)
        raise Block('BLOCK — CLIENT-EXECUTION PROOF FAILURE')
    def stop_container(self):
        if self.container:
            name=self.container
            with self.state_lock:self.container=None;self.cgroup=None
            self.command('docker','rm','-f',name)
    def window_samples(self,p):return [s for s in self.samples if s.get('phase')==p and s.get('containerRequired')]

def validate_manifest(entries, out, run_id, sha, allow_pending_security=False):
    if len(entries)!=len(PHASES) or {x.get('phase') for x in entries}!=set(PHASES):return False
    for x in entries:
        if allow_pending_security and x.get('phase')=='SECURITY_AGGREGATION':continue
        required=('schema','runId','sha','phase','required','status','started','completed','artifacts','expectedCounts','actualCounts','dependencies','reason')
        if any(k not in x for k in required):return False
        if not isinstance(x['expectedCounts'],dict) or not isinstance(x['actualCounts'],dict) or any(type(v) is not int or v<0 for v in x['expectedCounts'].values()):return False
        if not isinstance(x['dependencies'],list):return False
        try:
            start=time.strptime(x['started'],'%Y-%m-%dT%H:%M:%SZ');end=time.strptime(x['completed'],'%Y-%m-%dT%H:%M:%SZ')
            if end<start:return False
        except (ValueError,TypeError):return False
        if x.get('schema')!=1 or x.get('runId')!=run_id or x.get('sha')!=sha or x.get('required') is not True or x.get('status')!='PASS' or not x.get('started') or not x.get('completed') or not x.get('artifacts'):return False
        if x.get('expectedCounts')!=x.get('actualCounts'):return False
        if any(not any(y.get('phase')==dep and y.get('status')=='PASS' for y in entries) for dep in x.get('dependencies',[])):return False
        for artifact in x['artifacts']:
            p=out/artifact.get('path','')
            if p.parent!=out or not p.is_file() or fingerprint(p.read_bytes())!=artifact.get('sha256'):return False
    return True

def browser_security(smoke, fatal, concurrent):
    results=smoke.get('results',[])+fatal.get('results',[])+concurrent.get('results',[])
    failures={'unexpectedCSP':0,'unexpectedPageErrors':0,'requiredJSFailures':0,'requiredCSSFailures':0,'unclassifiedFailures':0,'unapprovedStatuses':0,'hardRequestFailures':0}
    assets=[]
    for result in results:
        expected=result.get('expectedCSPEvents',0)
        failures['unexpectedCSP']+=len(result.get('csp',[]))-expected
        failures['unexpectedPageErrors']+=len(result.get('errors',[]))
        for r in result.get('requests',[]):
            if r.get('incompleteLifecycle'):failures['unclassifiedFailures']+=1;failures['hardRequestFailures']+=1
            if not r.get('failure'):continue
            c=r.get('classification')
            failures['requiredJSFailures']+=c=='REQUIRED_JS_FAILURE';failures['requiredCSSFailures']+=c=='REQUIRED_CSS_FAILURE'
            failures['unclassifiedFailures']+=c is None
            failures['hardRequestFailures']+=c not in ('RSC_EXPECTED_CANCELLATION','PREFETCH_EXPECTED_CANCELLATION')
        for r in result.get('responses',[]):
            if r['type'] in ('script','stylesheet','image','font'):
                acceptable=(r['status']==200 and r['typeValid'] or r['status']==304 and r.get('cacheAssociationVerified') is True and r['typeValid'] or 300<=r['status']<400 and r['status']!=304 and r['redirectApproved'] and r.get('terminalStatus')==200 and r.get('terminalTypeValid') is True)
                failures['unapprovedStatuses']+=not acceptable
            if r['url'].get('path','') and r['url']['path'].startswith('/_next/static/'):
                if r['status'] in (200,304):assets.append(r)
    cache_pass=bool(assets) and all(r['status'] in (200,304) and 'immutable' in (r['cacheControl'] or '') and 'max-age=31536000' in (r['cacheControl'] or '') for r in assets)
    matrix=smoke.get('pass') is True and fatal.get('pass') is True and concurrent.get('pass') is True and len(smoke.get('results',[]))==10 and len(fatal.get('results',[]))==6 and len(concurrent.get('results',[]))==8
    return {'schema':1,'pass':matrix and not any(failures.values()) and cache_pass,'failures':failures,'staticAssets':assets,'staticCachePass':cache_pass,'matrixComplete':matrix}

def repository_checks(h, baseline):
    evidence={'schema':1,'candidate':{},'qualification':{},'sourceModeConflict':None,'pass':False}
    py=h.root.parent/'qualification-python'
    h.logged(['python3','-m','venv',str(py)],'api-venv')
    h.logged([str(py/'bin/pip'),'install','-r',str(baseline/'apps/api/requirements.txt')],'api-dependencies')
    for label,source in [('candidate',baseline),('qualification',h.root)]:
        for app in ('web','extension'):
            h.logged(['npm','ci','--no-audit','--no-fund'],label+'-'+app+'-dependencies',cwd=source/'apps'/app)
        (source/'.env').write_text('')  # Isolated runner source only; no credentials.
        for target in ('test-api','test-web','test-extension'):
            args=['make',target,'API_PYTHON='+str(py/'bin/python')]
            rc=h.logged(args,label+'-'+target,cwd=source,check=False)
            evidence[label][target]={'command':args,'sourceSHA':BASE if label=='candidate' else h.sha,'returnCode':rc,'completed':utc()}
            h.write('repository-validation',evidence)
            if target!='test-web' or label=='candidate':
                if rc:raise Block('BLOCK — REPOSITORY CHECK FAILURE')
        rc=h.logged(['docker','compose','config','--quiet'],label+'-compose-config',cwd=source,check=False)
        evidence[label]['docker compose config']={'returnCode':rc,'sourceSHA':BASE if label=='candidate' else h.sha,'completed':utc()}
        if rc:raise Block('BLOCK — REPOSITORY CHECK FAILURE')
        if label=='qualification':
            # Establish that make's lint/typecheck/build completed independently; no earlier failure is exempt.
            for task in ('lint','typecheck','build'):
                rc=h.logged(['npm','run',task],'qualification-web-'+task,cwd=source/'apps/web',check=False)
                evidence[label][task]={'returnCode':rc}
                if rc:raise Block('BLOCK — REPOSITORY CHECK FAILURE')
            report=h.root.parent/('vitest-'+h.run_id+'-full.json')
            rc=h.logged(['npm','test','--','--reporter=json','--outputFile='+str(report)],'qualification-vitest',cwd=source/'apps/web',check=False)
            raw=json.loads(report.read_text());conflict=rc!=0 and source_mode_conflict(raw)
            # Do not retain raw failure diagnostics, paths, payloads or arbitrary test messages.
            evidence['sourceModeConflict']={'exactFile':'apps/web/__tests__/securityPolicy.test.ts','exactTest':RO_TEST,'fullSuiteReturnCode':rc,'matchedExactAssertion':conflict,'failedTests':raw.get('numFailedTests')};report.unlink()
            if not conflict or evidence[label]['test-web']['returnCode']==0:raise Block('BLOCK — REPOSITORY CHECK FAILURE')
            pattern=r'^(?!static-safe CSP observation '+re.escape(RO_TEST)+r'$).*'
            report=h.root.parent/('vitest-'+h.run_id+'-remaining.json')
            rc=h.logged(['npm','test','--','-t',pattern,'--reporter=json','--outputFile='+str(report)],'qualification-vitest-remaining',cwd=source/'apps/web',check=False)
            raw=json.loads(report.read_text());tests=[t for s in raw.get('testResults',[]) for t in s.get('assertionResults',[])]
            excluded=[t for t in tests if t.get('status')!='passed'];exact_exclusion=len(excluded)==1 and excluded[0].get('fullName')==RO_FULL_TEST and excluded[0].get('status') in ('pending','skipped','todo')
            evidence['sourceModeConflict'].update(remainingSuiteReturnCode=rc,exactExclusion=exact_exclusion,classification='EXPECTED_SOURCE_MODE_CONFLICT');report.unlink()
            if rc or not exact_exclusion:raise Block('BLOCK — REPOSITORY CHECK FAILURE')
        h.write('repository-validation',evidence)
    evidence['pass']=True;h.write('repository-validation',evidence)
    return evidence

def main():
    h=Harness(Path.cwd(),Path(os.environ['EVIDENCE_DIR']));verdict='BLOCK — QUALIFICATION INCOMPLETE';builds={};images={};baseline=h.root.parent/('cws15-baseline-'+h.run_id)
    def interrupted(signum,frame):raise Block('BLOCK — QUALIFICATION INCOMPLETE')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    try:
        with h.stage('AUTHORITY'):
            head=h.command('git','rev-parse','HEAD');parents=h.command('git','show','-s','--format=%P',head).split()
            r4_parents=h.command('git','show','-s','--format=%P',R4).split()
            r3_parents=h.command('git','show','-s','--format=%P',R3).split();r1_parents=h.command('git','show','-s','--format=%P',R1).split()
            def edge(a,b):
                lines=h.command('git','diff','--name-status','--no-renames',a,b,'--').splitlines()
                return [tuple(line.split('\t')) for line in lines]
            edges={'r1':edge(BASE,R1),'r3':edge(R1,R3),'r4':edge(R3,R4),'repair':edge(R4,head)};digest=frozen(h.root)
            check=qualification_authority(h.sha,head,parents,r4_parents,r3_parents,r1_parents,edges,os.environ.get('GITHUB_EVENT_NAME'),os.environ.get('GITHUB_REF'),digest)
            authority={'schema':1,'head':head,'parents':parents,'r4Parents':r4_parents,'r3Parents':r3_parents,'r1Parents':r1_parents,'edges':edges,'manifest':digest,'checks':check}
            h.write('source-authority',authority)
            if not check['pass'] or h.command('git','cat-file','-t',BASE)!='commit' or h.command('git','status','--porcelain'):raise Block('BLOCK — QUALIFICATION AUTHORITY FAILED')
            h.seal('AUTHORITY',['source-authority.json'],{'edges':4,'frozenFiles':9})
        with h.stage('RUNNER'):
            info=json.loads(h.command('docker','info','--format','{{json .}}'));h.docker_root=info['DockerRootDir']
            h.swap_origin={line.split()[0]:int(line.split()[1]) for line in Path('/proc/vmstat').read_text().splitlines()}
            host=h.host();inventory={**host,'osRelease':Path('/etc/os-release').read_text(),'kernel':platform.release(),'architecture':platform.machine(),'logicalCPUs':os.cpu_count(),'dockerArchitecture':info['Architecture'],'dockerCPUs':info['NCPU'],'dockerRAMBytes':info['MemTotal'],'dockerVersion':json.loads(h.command('docker','version','--format','{{json .}}'))}
            inventory['floorPass']=os.cpu_count()>=2 and host['hostMemoryBytes']>=6*1024**3 and host['availableMemoryBytes']>=4*1024**3 and host['diskFreeBytes']>=20*1024**3
            h.write('runner-inventory',inventory)
            if not inventory['floorPass']:raise Block('BLOCK — RUNNER RESOURCE FLOOR NOT MET')
            (h.out/'resource-samples.jsonl').write_text('');h.monitor_thread=threading.Thread(target=h.monitor,daemon=True);h.monitor_thread.start();time.sleep(1.1)
            if not fresh(h.latest):raise Block('BLOCK — RUNNER RESOURCE FLOOR NOT MET')
            plan={'schema':1,'routes':['/','/login','/pricing','/privacy'],'requestsPerLevel':200,'levels':[1,5,10],'optional25Reason':'preflight comfortable-margin rule not met'}
            x=h.latest
            if x['availableMemoryBytes']>=4*1024**3 and x['diskFreeBytes']>=20*1024**3 and x['swapInPages']==0 and x['swapOutPages']==0 and x['load'][0]<=os.cpu_count()*2:
                plan['levels'].append(25);plan['optional25Reason']='admitted before either baseline or nonce execution'
            h.write('performance-plan',plan);h.seal('RUNNER',['runner-inventory.json','performance-plan.json'])
        lock=json.loads((h.root/'apps/web/package-lock.json').read_text());version=lock['packages']['node_modules/@playwright/test']['version'];pw=h.root.parent/('cws15-playwright-'+h.run_id)
        h.logged(['npm','install','--prefix',str(pw),'--no-audit','--no-fund','@playwright/test@'+version],'playwright-install')
        os.environ['PLAYWRIGHT_MODULE']=str(pw/'node_modules/@playwright/test');os.environ['QUAL_WEB']=str(h.root/'apps/web')
        h.logged([str(pw/'node_modules/.bin/playwright'),'install','--with-deps','chromium'],'chromium-install')
        h.command('git','worktree','add','--detach',str(baseline),BASE)
        if h.command('git','rev-parse','HEAD',cwd=baseline)!=BASE or h.command('git','status','--porcelain',cwd=baseline):raise Block('BLOCK — QUALIFICATION AUTHORITY FAILED')
        dockerfile=(h.root/'apps/web/Dockerfile').read_bytes()
        if dockerfile!=(baseline/'apps/web/Dockerfile').read_bytes():raise Block('BLOCK — QUALIFICATION AUTHORITY FAILED')
        for mode,source in [('baseline',baseline),('nonce',h.root)]:
            p=mode.upper()+'_BUILD'
            with h.stage(p):
                image='cws15-'+mode+':'+h.run_id;begin=time.monotonic()
                args=['docker','build','--file',str(source/'apps/web/Dockerfile'),'--tag',image,'--build-arg','NEXT_PUBLIC_API_URL=https://api.xpertapply.com','--build-arg','NEXT_PUBLIC_SITE_URL=https://xpertapply.com','--build-arg','NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj','--build-arg','NEXT_PUBLIC_CHROME_EXTENSION_URL=',str(source/'apps/web')]
                try:h.logged(args,'build-'+mode,timeout=1800)
                except subprocess.CalledProcessError:raise Block('BLOCK — CONTAINER BUILD FAILURE')
                inspect=json.loads(h.command('docker','image','inspect',image))[0]
                versions=json.loads(h.command('docker','run','--rm',image,'node','-e',"console.log(JSON.stringify({node:process.version,next:require('next/package.json').version,react:require('react/package.json').version,alpine:require('fs').readFileSync('/etc/alpine-release','utf8').trim()}))"))
                builds[mode]={'result':'PASS','imageID':inspect['Id'],'imageSizeBytes':inspect['Size'],'durationSeconds':time.monotonic()-begin,'versions':versions,'dockerfileSHA256':fingerprint(dockerfile)};images[mode]=image
                h.write('build-'+mode,builds[mode]);h.seal(p,['build-'+mode+'.json'])
        with h.stage('FRAMEWORK_HASH'):
            expression="const c=require('next/dist/client/components/builtin/error-styles.js').errorThemeCss,h=require('crypto').createHash('sha256').update(c).digest();console.log(JSON.stringify({next:require('next/package.json').version,bytes:Buffer.byteLength(c),sha256Hex:h.toString('hex'),hashSource:\"'sha256-\"+h.toString('base64')+\"'\"}))"
            fatal=json.loads(h.command('docker','run','--rm',images['nonce'],'node','-e',expression));fatal['pass']=fatal['next']=='16.3.5' and fatal['bytes']==888 and fatal['sha256Hex']==STYLE_SHA and fatal['hashSource']==STYLE_SOURCE
            h.write('fatal-style-hash',fatal)
            if not fatal['pass']:raise Block('BLOCK — FRAMEWORK HASH DRIFT')
            h.seal('FRAMEWORK_HASH',['fatal-style-hash.json'])
        policy_module=(h.root/'apps/web/lib/securityPolicy.mjs').as_uri()
        expression='const {reportOnlyPolicy}=await import('+json.dumps(policy_module)+');process.stdout.write(reportOnlyPolicy().replace("script-src \'self\'","script-src \'self\' \'nonce-REDACTED\'").replace("style-src \'self\'","style-src \'self\' "+'+json.dumps(STYLE_SOURCE)+'));'
        os.environ['QUAL_POLICY_TEMPLATE']=h.command('node','--input-type=module','-e',expression)
        h.start(images['nonce'],'nonce')
        with h.stage('FUNCTIONAL_SMOKE'):
            h.node('smoke.cjs');h.node('fatal.cjs');smoke=h.read('functional-smoke');fatal_browser=h.read('fatal-browser')
            if not smoke['pass'] or not fatal_browser['pass']:raise Block('BLOCK — CLIENT-EXECUTION PROOF FAILURE')
            h.seal('FUNCTIONAL_SMOKE',['functional-smoke.json','fatal-browser.json','smoke-nonces.jsonl','fatal-nonces.jsonl'],{'smokeScenarios':10,'fatalScenarios':6})
            for viewport in ('desktop','mobile'):
                p=viewport.upper();h.phases[p]['started']=h.phases['FUNCTIONAL_SMOKE']['started']
                selected=[x for x in smoke['results'] if x['viewport']==viewport]
                if len(selected)!=5 or not all(x['pass'] for x in selected):raise Block('BLOCK — CLIENT-EXECUTION PROOF FAILURE')
                h.write(viewport,{'schema':1,'pass':True,'scenarios':len(selected)});h.seal(p,[viewport+'.json','functional-smoke.json'],{'scenarios':5},('FUNCTIONAL_SMOKE',))
        with h.stage('CONCURRENT_BROWSER'):
            h.node('browser.cjs');concurrent=h.read('concurrent-browser')
            if not concurrent['pass']:raise Block('BLOCK — REQUEST/RESOURCE CLASSIFICATION FAILURE')
            h.seal('CONCURRENT_BROWSER',['concurrent-browser.json','concurrent-browser-nonces.jsonl'],{'pages':8})
        with h.stage('HTTP_NONCE'):
            h.node('load.cjs','nonce','http');load=h.read('http-nonce')
            if load['status']!='PASS':raise Block('BLOCK — CONCURRENT NONCE AUTHORITY FAILURE')
            partial=aggregate_nonce(h.out,h.run_id,h.sha,LEDGERS[:4]);h.write('nonce-aggregation-partial',partial)
            if not partial['pass']:raise Block('BLOCK — CROSS-PHASE NONCE REUSE' if partial['crossPhaseReuse'] else 'BLOCK — CONCURRENT NONCE AUTHORITY FAILURE')
            h.seal('HTTP_NONCE',['http-nonce.json','http-nonce-nonces.jsonl','nonce-aggregation-partial.json'])
        with h.stage('HEADERS_CACHE'):
            security=browser_security(smoke,fatal_browser,concurrent);h.write('browser-security',security)
            if not security['pass']:raise Block('BLOCK — CSP/HEADER/CACHE REGRESSION')
            h.write('headers-cache',{'schema':1,'pass':partial['policyFailures']==partial['cacheFailures']==partial['poweredByFailures']==0})
            h.seal('HEADERS_CACHE',['headers-cache.json','browser-security.json'])
        with h.stage('STATIC_ASSETS'):
            if not security['staticCachePass'] or security['failures']['unapprovedStatuses']:raise Block('BLOCK — CSP/HEADER/CACHE REGRESSION')
            h.seal('STATIC_ASSETS',['browser-security.json'],{'assets':len(security['staticAssets'])})
        h.stop_container()
        for mode in ('baseline','nonce'):
            p=mode.upper()+'_PERFORMANCE'
            with h.stage(p):
                h.start(images[mode],mode);h.node('load.cjs',mode);time.sleep(.12)
                perf=h.read(mode+'-performance')
                if perf['status']!='PASS':raise Block('BLOCK — PERFORMANCE EVIDENCE INCOMPLETE')
                artifacts=[mode+'-performance.json']+([mode+'-performance-nonces.jsonl'] if mode=='nonce' else [])
                h.seal(p,artifacts,{'levels':len(plan['levels']),'responses':200*len(plan['levels'])})
                if mode=='baseline':h.stop_container()
        with h.stage('RELATIVE_DELTAS'):
            delta=compare_performance(h.read('baseline-performance'),h.read('nonce-performance'),plan,h.samples);h.write('relative-deltas',delta)
            if delta['status']!='PASS':raise Block('BLOCK — PERFORMANCE EVIDENCE INCOMPLETE')
            h.seal('RELATIVE_DELTAS',['relative-deltas.json'])
        h.phase='REFERENCE';time.sleep(30);reference=h.window_samples('reference');h.write('reference-resources',{'samples':reference})
        with h.stage('STEADY_STATE'):
            level=max(plan['levels']);os.environ['STEADY_CONCURRENCY']=str(level);h.node('load.cjs','nonce','steady',timeout=210)
            steady=h.read('steady-state');resources=h.window_samples('steady-state')
            if not steady_complete(steady,resources):raise Block('BLOCK — STEADY-STATE/RESOURCE EVIDENCE INCOMPLETE')
            h.write('steady-resources',{'schema':1,'samples':resources});h.seal('STEADY_STATE',['steady-state.json','steady-resources.json','steady-state-nonces.jsonl'],{'windows':36})
        with h.stage('COOLDOWN'):
            time.sleep(30);cooldown=h.window_samples('cooldown');memory=memory_classification(reference,resources,cooldown)
            h.write('cooldown',{'schema':1,'samples':cooldown,'reference':reference,'memory':memory})
            if not memory['pass']:raise Block('BLOCK — STEADY-STATE/RESOURCE EVIDENCE INCOMPLETE')
            h.seal('COOLDOWN',['cooldown.json','reference-resources.json'])
        h.stop_container()
        with h.stage('REPOSITORY_CHECKS'):
            repository_checks(h,baseline);h.seal('REPOSITORY_CHECKS',['repository-validation.json'])
        with h.stage('SECURITY_AGGREGATION'):
            nonce=aggregate_nonce(h.out,h.run_id,h.sha,LEDGERS);h.write('nonce-aggregation',nonce)
            phases_pass=validate_manifest(list(h.phases.values()),h.out,h.run_id,h.sha,True)
            result={'schema':1,'runId':h.run_id,'sha':h.sha,'nonce':nonce,'browser':security,'fatalStyle':fatal,'repositoryPass':h.read('repository-validation')['pass'],'frozenManifest':frozen(h.root),'requiredPrecedingPhasesPass':phases_pass,'pass':nonce['pass'] and security['pass'] and fatal['pass'] and phases_pass and h.read('repository-validation')['pass']}
            eligible=result.pop('pass');result.update({'status':'ELIGIBLE' if eligible else 'BLOCK','pass':False,'allRequiredPhasesPass':False,'completeNonceLedger':nonce['pass'],'scriptUnsafeInlineAbsent':nonce['policyFailures']==0,'scriptUnsafeEvalAbsent':nonce['policyFailures']==0,'styleSrcUnsafeInlineAbsent':nonce['policyFailures']==0,'wildcardAbsent':nonce['policyFailures']==0,'htmlPrivateNoStore':nonce['cacheFailures']==0,'immutableStaticAssets':security['staticCachePass']})
            h.write('final-security',result)
            if not eligible:raise Block('BLOCK — FINAL SECURITY AGGREGATION FAILED')
            h.seal('SECURITY_AGGREGATION',['final-security.json','nonce-aggregation.json'])
            if not validate_manifest(list(h.phases.values()),h.out,h.run_id,h.sha):raise Block('BLOCK — FINAL SECURITY AGGREGATION FAILED')
            result.update({'status':'PASS','pass':True,'allRequiredPhasesPass':True});h.write('final-security',result)
            h.seal('SECURITY_AGGREGATION',['final-security.json','nonce-aggregation.json'])
            if not validate_manifest(list(h.phases.values()),h.out,h.run_id,h.sha):raise Block('BLOCK — FINAL SECURITY AGGREGATION FAILED')
        verdict='PASS — EPHEMERAL LINUX CONTAINER/NONCE QUALIFICATION PASSED; READY FOR LOW-IMPACT PRODUCTION-HOST SHADOW SMOKE'
    except Block as e:verdict=str(e)
    except BaseException as e:
        h.write('qualification-error',diagnostic(e));verdict='BLOCK — QUALIFICATION INCOMPLETE'
    finally:
        for suffix in ('full','remaining'):
            (h.root.parent/('vitest-'+h.run_id+'-'+suffix+'.json')).unlink(missing_ok=True)
        h.stop.set()
        if h.monitor_thread:h.monitor_thread.join(timeout=5)
        try:h.stop_container()
        except Exception:pass
        h.write('phase-manifest',{'schema':1,'runId':h.run_id,'sha':h.sha,'phases':list(h.phases.values())})
        try:source_unchanged=frozen(h.root)==DIGEST
        except Exception:source_unchanged=False
        if not source_unchanged:verdict='BLOCK — QUALIFICATION AUTHORITY FAILED'
        h.write('final-verification',{'schema':1,'verdict':verdict,'runId':h.run_id,'sha':h.sha,'phaseReached':h.phase,'sourceUnchanged':source_unchanged,'productionMutation':'NONE','productionDockerMutation':'NONE','nginxMutation':'NONE','DBMutation':'NONE','StoreMutation':'NONE'})
        print(verdict,flush=True)
    return 0 if verdict.startswith('PASS —') else 1

if __name__=='__main__':
    raise SystemExit(main())
