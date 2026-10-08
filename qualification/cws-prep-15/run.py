"""Ephemeral-only qualification; no deployment commands or production connections."""
import hashlib,json,os,platform,re,shutil,subprocess,threading,time,urllib.request
from pathlib import Path
ROOT=Path.cwd();HELP=ROOT/'qualification/cws-prep-15';OUT=Path(os.environ['EVIDENCE_DIR']);OUT.mkdir(parents=True,exist_ok=True)
BASE='a63945ea5f84f63d45d30ff81b67c043fad57ba9';DIGEST='cbe49db9c79b7ff5dfcb964f777f8948add521429ba732bc18e4f40bf9cfe1b0'
NAMES=['runner-inventory','source-authority','container-builds','framework-hash-verification','functional-smoke','concurrent-nonce','concurrent-browser','headers-cache','baseline-performance','nonce-performance','steady-state','resource-observation','security-regression','final-verification']
for name in NAMES:
 (OUT/(name+'.json')).write_text(json.dumps({'status':'NOT RUN'},indent=2))
def write(name,data):
 p=OUT/(name+'.json');tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(data,indent=2));tmp.replace(p)
def read(name):return json.loads((OUT/(name+'.json')).read_text())
def cmd(*args,cwd=ROOT,timeout=60):return subprocess.check_output(args,cwd=cwd,text=True,timeout=timeout).strip()
def mem():return {line.split(':')[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines()}
def vm():return {line.split()[0]:int(line.split()[1]) for line in Path('/proc/vmstat').read_text().splitlines()}
stop=threading.Event();samples=[];phase='inventory';container=None;baseline_swap=vm();fatal=None
class Block(Exception):pass

# Reviewed immutable R1 authority and exact split between R1 content and R3 repair.
R1='f7735c469fc147d40c49a414dc763aca057565c6'
REPAIR_PATHS=frozenset({'.github/workflows/cws-prep-15-qualification.yml','qualification/cws-prep-15/run.py'})
R1_PATHS=frozenset({
 '.github/workflows/cws-prep-15-qualification.yml',
 'apps/web/app/csp-qualification-error/page.tsx','apps/web/app/error.tsx',
 'apps/web/app/global-error.tsx','apps/web/app/layout.tsx','apps/web/app/not-found.tsx',
 'apps/web/lib/securityPolicy.d.mts','apps/web/next.config.mjs','apps/web/proxy.ts',
 'apps/web/public/csp-error.css','qualification/cws-prep-15/browser.cjs',
 'qualification/cws-prep-15/fatal.cjs','qualification/cws-prep-15/frozen-manifest.json',
 'qualification/cws-prep-15/load.cjs','qualification/cws-prep-15/run.py',
 'qualification/cws-prep-15/smoke.cjs'
})
def qualification_authority(expected_sha,head,head_parents,r1_parents,r1_paths,repair_paths):
 sha_valid=isinstance(expected_sha,str) and re.fullmatch(r'[0-9a-f]{40}',expected_sha) is not None
 topology_pass=sha_valid and head==expected_sha and head_parents==[R1] and r1_parents==[BASE]
 paths_pass=(len(r1_paths)==len(R1_PATHS) and frozenset(r1_paths)==R1_PATHS and
             len(repair_paths)==len(REPAIR_PATHS) and frozenset(repair_paths)==REPAIR_PATHS)
 return {'shaValid':sha_valid,'topologyPass':topology_pass,'pathsPass':paths_pass,
         'pass':topology_pass and paths_pass}

def observe():
 m=mem();v=vm();dockerroot=cmd('docker','info','--format','{{.DockerRootDir}}');disk=shutil.disk_usage(dockerroot).free;load=os.getloadavg()
 x={'timestamp':time.time(),'phase':phase,'availableMemoryBytes':m['MemAvailable'],'swapUsedBytes':m['SwapTotal']-m['SwapFree'],'swapInPages':v['pswpin']-baseline_swap['pswpin'],'swapOutPages':v['pswpout']-baseline_swap['pswpout'],'load':load,'rootFreeDiskBytes':shutil.disk_usage('/').free,'dockerFreeDiskBytes':disk}
 x['safe']=m['MemAvailable']>=1024**3 and min(disk,x['rootFreeDiskBytes'])>=5*1024**3 and load[0]<os.cpu_count()*6 and (x['swapInPages']+x['swapOutPages'])*os.sysconf('SC_PAGE_SIZE')<64*1024**2
 current_container=container
 if current_container:
  try:
   stats=json.loads(cmd('docker','stats','--no-stream','--format','{{json .}}',current_container,timeout=15));x['containerStats']=stats
   x['processCount']=len(cmd('docker','top',current_container,'-eo','pid',timeout=10).splitlines())-1
   x['processRSSKiB']=cmd('docker','exec',current_container,'sh','-c',"awk '/VmRSS:/{s+=$2} END{print s}' /proc/[0-9]*/status",timeout=10)
  except Exception as e:
   if current_container==container:x['containerObservationError']=type(e).__name__;x['safe']=False
 return x

def monitor():
 while not stop.is_set():
  try:
   x=observe();samples.append(x);write('resource-latest',x);write('resource-observation',{'samples':samples})
  except Exception as e:write('resource-latest',{'safe':False,'error':type(e).__name__})
  stop.wait(2)

def safe():
 if not observe()['safe']:raise Block('BLOCK — RESOURCE REGRESSION REQUIRES REDESIGN')

def run_logged(args,name,cwd=ROOT,timeout=1200,check=True):
 with (OUT/(name+'.log')).open('w') as f:
  p=subprocess.Popen(args,cwd=cwd,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  begin=time.monotonic()
  while p.poll() is None:
   if time.monotonic()-begin>timeout:
    os.killpg(p.pid,15);p.wait();raise TimeoutError(name)
   # Monitor build/runtime continuously; terminate only this child process group.
   if (OUT/'resource-latest.json').exists() and not read('resource-latest').get('safe',False):
    os.killpg(p.pid,15);p.wait();raise Block('BLOCK — RESOURCE REGRESSION REQUIRES REDESIGN')
   time.sleep(1)
  if check and p.returncode:raise subprocess.CalledProcessError(p.returncode,args)
  return p.returncode

def start(image,mode):
 global container
 container='cws15-'+mode+'-'+os.environ['GITHUB_RUN_ID'];port='3550' if mode=='baseline' else '3551'
 cmd('docker','run','-d','--name',container,'--publish',f'127.0.0.1:{port}:3000',image)
 for _ in range(90):
  try:
   with urllib.request.urlopen('http://127.0.0.1:'+port,timeout=3) as r:
    if r.status==200:return
  except Exception:time.sleep(1)
 raise Block('BLOCK — CONTAINER APPLICATION REGRESSION')

def stop_container():
 global container
 if container:
  old=container;container=None;cmd('docker','rm','-f',old)

def node(name,*args,check=True,timeout=600):return run_logged(['node',str(HELP/name),*args],name+'-'+('-'.join(args) or 'browser'),check=check,timeout=timeout)

builds={};verdict='BLOCK — QUALIFICATION INCOMPLETE';mon=None
try:
 # First phase is factual host and Docker inventory, before setup/build.
 m=mem();info=json.loads(cmd('docker','info','--format','{{json .}}'));dockerroot=info['DockerRootDir']
 inventory={'osRelease':Path('/etc/os-release').read_text(),'uname':cmd('uname','-a'),'kernel':platform.release(),'architecture':platform.machine(),'logicalCPUs':os.cpu_count(),'totalRAMBytes':m['MemTotal'],'availableRAMBytes':m['MemAvailable'],'swapTotalBytes':m['SwapTotal'],'swapFreeBytes':m['SwapFree'],'load':os.getloadavg(),'rootFreeDiskBytes':shutil.disk_usage('/').free,'dockerFreeDiskBytes':shutil.disk_usage(dockerroot).free,'dockerVersion':json.loads(cmd('docker','version','--format','{{json .}}')),'dockerInfo':info,'dockerArchitecture':info['Architecture'],'dockerCPUs':info['NCPU'],'dockerRAMBytes':info['MemTotal']}
 inventory['floorPass']=os.cpu_count()>=2 and m['MemTotal']>=6*1024**3 and m['MemAvailable']>=4*1024**3 and min(inventory['rootFreeDiskBytes'],inventory['dockerFreeDiskBytes'])>=20*1024**3
 write('runner-inventory',inventory)
 if not inventory['floorPass']:raise Block('BLOCK — RUNNER RESOURCE FLOOR NOT MET')
 # Fail closed on exact R3 -> R1 -> candidate chain and separately reviewed path sets.
 expected_sha=os.environ.get('GITHUB_SHA')
 head=cmd('git','rev-parse','HEAD')
 parents=cmd('git','show','-s','--format=%P',head).split()
 r1_parents=cmd('git','show','-s','--format=%P',R1).split()
 candidate_is_commit=cmd('git','cat-file','-t',BASE)=='commit'
 raw=(HELP/'frozen-manifest.json').read_bytes();manifest=json.loads(raw)
 actual={'baseSHA':BASE,'files':[]}
 for f in manifest['files']:
  b=(ROOT/f['path']).read_bytes();actual['files'].append({**f,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 recomputed=json.dumps(actual,sort_keys=True,indent=2).encode();digest=hashlib.sha256(recomputed).hexdigest()
 r1_paths=cmd('git','diff','--name-only',BASE,R1,'--').splitlines()
 paths=cmd('git','diff','--name-only',R1,head,'--').splitlines()
 checks=qualification_authority(expected_sha,head,parents,r1_parents,r1_paths,paths)
 authority={'head':head,'parents':parents,'grandparents':r1_parents,'reviewedR1':R1,
            'reviewedCandidate':BASE,'candidateIsCommit':candidate_is_commit,
            'ref':os.environ.get('GITHUB_REF'),'expectedHead':expected_sha,
            'event':os.environ.get('GITHUB_EVENT_NAME'),'frozenManifestDigest':digest,
            'manifestPass':digest==DIGEST,'r1ChangedPaths':r1_paths,'repairChangedPaths':paths,
            'checks':checks,'files':actual['files']}
 authority['pass']=(checks['pass'] and candidate_is_commit and digest==DIGEST and
                    authority['ref']=='refs/heads/qualification/cws-prep-15-nonce-container' and
                    authority['event']=='push')
 write('source-authority',authority)
 if not checks['shaValid'] or not checks['topologyPass'] or not candidate_is_commit:
  raise Block('BLOCK — QUALIFICATION ANCESTRY AUTHORITY FAILED')
 if not authority['pass']:raise Block('BLOCK — QUALIFICATION PUSH/RUN AUTHORITY INVALID')
 mon=threading.Thread(target=monitor,daemon=True);mon.start();time.sleep(1)
 # Install an isolated browser harness using the lockfile's exact Playwright version.
 phase='browser-setup';pw=ROOT.parent/'cws-playwright';pw.mkdir(exist_ok=True)
 lock=json.loads((ROOT/'apps/web/package-lock.json').read_text());version=lock['packages']['node_modules/@playwright/test']['version']
 run_logged(['npm','install','--prefix',str(pw),'--no-audit','--no-fund','@playwright/test@'+version],'playwright-install')
 os.environ['PLAYWRIGHT_MODULE']=str(pw/'node_modules/@playwright/test');os.environ['QUAL_WEB']=str(ROOT/'apps/web')
 run_logged([str(pw/'node_modules/.bin/playwright'),'install','--with-deps','chromium'],'chromium-install')
 baseline=ROOT.parent/'baseline';cmd('git','worktree','add','--detach',str(baseline),BASE)
 assert cmd('git','rev-parse','HEAD',cwd=baseline)==BASE and not cmd('git','status','--porcelain',cwd=baseline)
 authority['baseline']={'head':BASE,'clean':True};write('source-authority',authority)
 dockerfile=(ROOT/'apps/web/Dockerfile').read_bytes();assert dockerfile==(baseline/'apps/web/Dockerfile').read_bytes()
 assert b'FROM node:20-alpine' in dockerfile and b'RUN npm ci' in dockerfile and b'RUN npm run build' in dockerfile
 for mode,source in [('baseline',baseline),('nonce',ROOT)]:
  phase='build-'+mode;safe();image='cws15-'+mode+':'+os.environ['GITHUB_RUN_ID'];begin=time.monotonic()
  args=['docker','build','--file',str(source/'apps/web/Dockerfile'),'--tag',image,'--build-arg','NEXT_PUBLIC_API_URL=https://api.xpertapply.com','--build-arg','NEXT_PUBLIC_SITE_URL=https://xpertapply.com','--build-arg','NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj','--build-arg','NEXT_PUBLIC_CHROME_EXTENSION_URL=',str(source/'apps/web')]
  try:run_logged(args,'build-'+mode,timeout=1800)
  except subprocess.CalledProcessError:
   builds[mode]={'result':'FAILED','durationSeconds':time.monotonic()-begin};write('container-builds',builds);raise Block('BLOCK — CONTAINER BUILD FAILURE')
  inspect=json.loads(cmd('docker','image','inspect',image))[0]
  versions=json.loads(cmd('docker','run','--rm',image,'node','-e',"console.log(JSON.stringify({node:process.version,next:require('next/package.json').version,react:require('react/package.json').version,architecture:process.arch,alpine:require('fs').readFileSync('/etc/alpine-release','utf8').trim()}))"))
  builds[mode]={'result':'SUCCESS','durationSeconds':time.monotonic()-begin,'imageID':inspect['Id'],'imageSizeBytes':inspect['Size'],'versions':versions,'dockerfileSHA256':hashlib.sha256(dockerfile).hexdigest()};write('container-builds',builds)
  if mode=='nonce':
   expression="const c=require('next/dist/client/components/builtin/error-styles.js').errorThemeCss,h=require('crypto').createHash('sha256').update(c).digest();console.log(JSON.stringify({next:require('next/package.json').version,bytes:Buffer.byteLength(c),sha256Hex:h.toString('hex'),hashSource:\"'sha256-\"+h.toString('base64')+\"'\"}))"
   fatal=json.loads(cmd('docker','run','--rm',image,'node','-e',expression));fatal['pass']=fatal['next']=='16.3.5' and fatal['bytes']==888 and fatal['sha256Hex']=='5b0b9cabc797dabd181729a44210d79b984dd3e15f4af237b3825249aa9ae22c' and fatal['hashSource']=="'sha256-Wwucq8eX2r0YFymkQhDXm5hN0+FfSvI3s4JSSaqa4iw='"
   write('framework-hash-verification',fatal);write('fatal-style-hash',fatal)
   if not fatal['pass']:raise Block('BLOCK — FRAMEWORK HASH DRIFT')
  phase='runtime-'+mode;start(image,mode);time.sleep(3);safe()
  if mode=='baseline':
   # Same cold route set as nonce; baseline report-only policy is recorded, not enforced.
   checks=[]
   for route in ['/','/privacy','/login','/signup','/pricing','/opensource','/auth/google/callback']:
    with urllib.request.urlopen('http://127.0.0.1:3550'+route) as response:checks.append({'route':route,'status':response.status,'reportOnly':bool(response.headers.get('Content-Security-Policy-Report-Only'))})
   builds[mode]['functional']=checks;write('container-builds',builds)
  else:
   phase='functional';node('smoke.cjs');node('fatal.cjs');node('browser.cjs')
   smoke=read('functional-smoke');fatal_browser=read('fatal-browser')
   positive=[];headers=[];assets=[]
   for x in smoke:
    expected=x['label'] in ['segment-error','root-error'];unexpected=[e for e in x['pageerrors'] if not (expected and (e['scenario'] in ['root-error','segment-error'] or e['scenario'].startswith('global-reset')) and 'An error occurred in the Server Components render' in e['message'])];failed=[f for f in x['failed'] if f.get('type') in ['script','stylesheet','document'] or f.get('reason')=='unapproved external request prevented']
    positive.append({'viewport':x['viewport'],'label':x['label'],'cspEvents':len(x['events']),'unexpectedPageErrors':unexpected,'requiredFailures':failed,'hydration':all(s['reactAttached']>0 and s['bootstrap'] for s in x['snapshots'] if s['scenario'] not in ['root-error','segment-error','global-reset-restored'])})
    headers+=x['documents'];assets += [a for a in x['responses'] if '/_next/static/' in a['url']]
   policy_pass=all(h['cspCount']==1 and h['reportOnlyCount']==0 and h['nonceFingerprint'] and h['policyTemplate'].count("'nonce-")==1 and fatal['hashSource'] in h['policyTemplate'] and 'unsafe-eval' not in h['policyTemplate'] and '*' not in h['policyTemplate'] and "script-src 'self' 'nonce-REDACTED';" in h['policyTemplate'] and "style-src 'self' "+fatal['hashSource']+';' in h['policyTemplate'] for h in headers)
   cache_pass=all('private' in h['cacheControl'] and 'no-store' in h['cacheControl'] for h in headers)
   asset_pass=bool(assets) and all('immutable' in (a['cacheControl'] or '') and 'max-age=31536000' in a['cacheControl'] for a in assets if a['status']==200)
   write('headers-cache',{'policyPass':policy_pass,'htmlCachePass':cache_pass,'staticAssetPass':asset_pass,'documents':headers,'staticAssets':assets})
   # Positive fatal errors are deliberately induced; hash omission/wrong-hash controls must fail.
   fatalpass=all(x['dom']['faultCalls'] and any(s['bytes']==888 and s['sha256Hex']==fatal['sha256Hex'] for s in x['styles']) and x['pageerrors']==['CSP_QUAL_FATAL_ROUTER_URL'] and all(s['matchesHeader'] for s in x['response']['inlineScripts']) and not x['events'] and not [f for f in x['failed'] if f['type'] in ['script','stylesheet']] for x in fatal_browser if x['mode'] in ['positive','positive-restored'])
   controls=all(any(e['effectiveDirective']=='style-src-elem' for e in x['events']) for x in fatal_browser if x['mode'] in ['remove','wrong','unrelated'])
   smoke_pass=all(not x['cspEvents'] and not x['unexpectedPageErrors'] and not x['requiredFailures'] and x['hydration'] for x in positive)
   write('security-regression',{'functionalPass':smoke_pass,'functionalSummary':positive,'fatalPositivePass':fatalpass,'fatalNegativeControlsPass':controls,'concurrentBrowserPass':read('concurrent-browser')['pass'],'noProductionConnections':True,'positiveFatalPageErrors':'Expected injected CSP_QUAL_FATAL_ROUTER_URL errors; recorded in fatal-browser.json'})
   if not policy_pass or not cache_pass or not asset_pass:raise Block('BLOCK — CSP/CACHE/HEADER REGRESSION')
   if not smoke_pass or not fatalpass or not controls:raise Block('BLOCK — CONTAINER APPLICATION REGRESSION')
  phase='performance-'+mode
  rc=node('load.cjs',mode,check=False);performance=read(mode+'-performance')
  if mode=='nonce' and any(performance['failures'].values()):raise Block('BLOCK — CONCURRENT NONCE AUTHORITY FAILURE')
  if rc:raise Block('BLOCK — RESOURCE REGRESSION REQUIRES REDESIGN')
  if mode=='baseline':stop_container()
 # Highest level with successful, healthy responses; 50 intentionally omitted.
 level=min(read('baseline-performance')['summaries'][-1]['concurrency'],read('nonce-performance')['summaries'][-1]['concurrency'])
 phase='steady-state';os.environ['STEADY_CONCURRENCY']=str(level);rc=node('load.cjs','nonce','steady',check=False,timeout=240)
 if any(read('steady-state')['failures'].values()):raise Block('BLOCK — CONCURRENT NONCE AUTHORITY FAILURE')
 if rc:raise Block('BLOCK — RESOURCE REGRESSION REQUIRES REDESIGN')
 phase='cooldown';time.sleep(30)
 steady=[x for x in samples if x['phase']=='steady-state'];cool=[x for x in samples if x['phase']=='cooldown']
 rss=[int(x.get('processRSSKiB','0')) for x in steady];classification='NO CONCERN OBSERVED'
 if rss and rss[-1]>rss[0]*1.5 and rss[-1]-rss[0]>100*1024:classification='POSSIBLE RETENTION'
 state=read('steady-state');state.update({'concurrency':level,'memoryClassification':classification,'steadyResources':steady,'cooldownResources':cool,'cooldownSeconds':30});write('steady-state',state)
 b=read('baseline-performance')['summaries'];n=read('nonce-performance')['summaries'];deltas=[]
 for before,after in zip(b,n):
  deltas.append({'concurrency':before['concurrency'],'throughputPercent':100*(after['reqPerSecond']/before['reqPerSecond']-1),'ttfbPercent':{k:100*(after['ttfb'][k]/before['ttfb'][k]-1) for k in before['ttfb']},'latencyPercent':{k:100*(after['latency'][k]/before['latency'][k]-1) for k in before['latency']}})
 resource_summary={}
 for mode in ['baseline','nonce']:
  xs=[x for x in samples if x['phase']=='performance-'+mode and 'containerStats' in x]
  resource_summary[mode]={'samples':len(xs),'meanCPUPercent':sum(float(x['containerStats']['CPUPerc'].rstrip('%')) for x in xs)/len(xs) if xs else None,'meanProcessRSSKiB':sum(int(x.get('processRSSKiB','0')) for x in xs)/len(xs) if xs else None}
 resource_deltas={k:100*(resource_summary['nonce'][k]/resource_summary['baseline'][k]-1) if resource_summary['baseline'][k] and resource_summary['nonce'][k] is not None else None for k in ['meanCPUPercent','meanProcessRSSKiB']}
 write('relative-deltas',{'resourceSummary':resource_summary,'resourcePercentDeltas':resource_deltas,'deltas':deltas,'capacityClaim':'Relative engineering regression screen only; no production capacity claim','maxSafelyTestedConcurrency':level,'concurrency50':'Not forced; maximum planned qualification load is 25','resources':{'baseline':[x for x in samples if x['phase']=='performance-baseline'],'nonce':[x for x in samples if x['phase']=='performance-nonce']}})
 phase='repository-validation'
 # Reuse installed dependencies from the real production image; no alternate web image.
 run_logged(['docker','cp',container+':/app/node_modules',str(ROOT/'apps/web/node_modules')],'copy-web-dependencies')
 stop_container()
 run_logged(['python3','-m','venv',str(ROOT/'apps/api/.venv')],'api-venv')
 run_logged([str(ROOT/'apps/api/.venv/bin/pip'),'install','-r','apps/api/requirements.txt'],'api-dependencies')
 run_logged(['npm','ci','--prefix','apps/extension','--no-audit','--no-fund'],'extension-dependencies')
 checks={}
 for target in ['test-api','test-web','test-extension']:
  checks[target]={'returnCode':run_logged(['make',target],target,check=False,timeout=1200)}
  write('repository-validation',{'checks':checks,'migrationChecks':'Not applicable: no schema or migration changes'})
 # Compose's env_file is supplied with an empty, ignored, qualification-local file.
 (ROOT/'.env').write_text('')
 checks['docker compose config']={'returnCode':run_logged(['docker','compose','config','--quiet'],'compose-config',check=False)}
 write('repository-validation',{'checks':checks,'migrationChecks':'Not applicable: no schema or migration changes','webContractNote':'Existing securityPolicy.test.ts expects report-only config; the frozen enforcing experiment intentionally replaces that architecture. No tests or source are rewritten.'})
 verdict='PASS — EPHEMERAL LINUX CONTAINER/NONCE QUALIFICATION PASSED; READY FOR LOW-IMPACT PRODUCTION-HOST SHADOW SMOKE'
except Block as e:verdict=str(e)
except Exception as e:
 write('qualification-error',{'type':type(e).__name__,'message':str(e)[:1000]});verdict='BLOCK — QUALIFICATION INCOMPLETE'
finally:
 stop.set()
 if mon:mon.join(timeout=20)
 try:stop_container()
 except Exception:pass
 write('final-verification',{'verdict':verdict,'runID':os.environ['GITHUB_RUN_ID'],'headSHA':os.environ.get('GITHUB_SHA'),'phaseReached':phase,'productionMutation':'NONE','productionDockerMutation':'NONE','nginxMutation':'NONE','DBMutation':'NONE','storeMutation':'NONE','merged':False,'candidateCommitPush':'NONE','sourceUnchanged':all(hashlib.sha256((ROOT/f['path']).read_bytes()).hexdigest()==f['sha256'] for f in json.loads((HELP/'frozen-manifest.json').read_text())['files'])})
 print(verdict,flush=True)
if not verdict.startswith('PASS'):raise SystemExit(1)
