'use strict';
const {Ledger,Observer,atomic,fixture,allowLocal,landing,password,clientProof,failureArtifact}=require('./browser.cjs');
const dir=process.env.EVIDENCE_DIR, origin='http://127.0.0.1:3551';
const homeRoutes=new Set(['/pricing','/privacy','/opensource']);
async function authProof(page,route) {
 if(!['/login','/signup'].includes(route)||new URL(page.url()).pathname!==route)throw Error('auth route mismatch');
 await page.getByRole('heading',{name:route==='/login'?'Sign in to XpertApply':'Create your account',exact:true}).waitFor();
 await page.locator('form').waitFor();await page.locator('form input[type="email"]').waitFor();await page.locator('form input[type="password"]').waitFor();
 return password(page);
}
async function run() {
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
 let active={phase:'smoke',label:'scenario',step:'scenario'}, observer=null, failed=false;
 let browser=null;const results=[];
 try {
  const ledger=new Ledger(dir,'smoke');browser=await chromium.launch({headless:true});
  for(const viewport of ['desktop','mobile']) for(const label of ['public-regression','auth-fixture','guard','segment-error','root-error']) {
   observer=null;active={phase:'smoke',scenarioId:'smoke-'+viewport+'-'+label,viewport,label:'scenario',step:'scenario'};
   const mobile=viewport==='mobile', auth=label==='auth-fixture', context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000}});
   const page=await context.newPage(), o=new Observer(page,ledger,label,'smoke-'+viewport+'-'+label); observer=o;active={phase:'smoke',scenarioId:o.pageId,viewport,label:'scenario',step:'scenario'}; await o.install(context);
   if(auth) await context.addInitScript(()=>localStorage.setItem('jobpilot_token','responsive-shell-token'));
   await context.route('**/*',r=>{if(allowLocal(r.request(),origin))return r.continue(); const f=fixture(r.request(),auth,o.scenario);if(f)return r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':origin},body:JSON.stringify(f.body)});return r.abort('blockedbyclient');});
   const goto=async(route,scenario=o.scenario)=>{active={...active,route,label:'navigate',step:'navigate'};const response=await o.withAction({kind:'DIRECT_GOTO',route,expectedRoute:scenario==='guard-dashboard'?'/login':route,scenario,navigation:true},()=>page.goto(origin+route));return response.status();};
   const checkpoint=async(route,status,proof=true)=>{active={...active,route,label:'checkpoint',step:'checkpoint'};return o.checkpoint(route,status,true,proof);};
   const homeProof=async(route,status)=>{
    active={...active,route,label:'home-back',step:'home-back',selector:'a[href="/"]:visible'};
    const before=await page.evaluate(()=>window.__qualDocument);await o.withAction({kind:'LINK_NAVIGATION',route:'/',selector:'home-link',scenario:'public-home-'+route,navigation:true},()=>page.locator('a[href="/"]:visible').first().click());await page.waitForURL(u=>u.pathname==='/');
    if(before!==await page.evaluate(()=>window.__qualDocument))throw Error('client home performed full navigation');await checkpoint('/',200,await landing(page,mobile));
    await o.withAction({kind:'HISTORY_BACK',route,scenario:'public-back-'+route,navigation:true},()=>page.goBack());await page.waitForURL(u=>u.pathname===route);return checkpoint(route,status,true);
   };
   if(label==='public-regression') {
    await goto('/','public-landing');await checkpoint('/',200,await landing(page,mobile));
    await o.withAction({kind:'RELOAD',route:'/',scenario:'public-landing-reload',navigation:true},()=>page.reload());await checkpoint('/',200,await landing(page,mobile));
    for(const route of ['/login','/signup','/pricing','/privacy','/opensource','/auth/google/callback']) {
     for(const action of ['direct','reload']) {
      if(action==='direct')await goto(route,'public-'+route);else{active={...active,route,label:'reload',step:'reload'};await o.withAction({kind:'RELOAD',route,scenario:'public-reload-'+route,navigation:true},()=>page.reload());}
      let proof=true;
      if(['/login','/signup'].includes(route)){active={...active,route,label:'auth-form',step:'auth-form',selector:'form'};proof=await authProof(page,route);}
      else if(route.endsWith('callback')){const alert=page.locator('#google-link-error');await alert.waitFor();proof=clientProof('callback',{route:new URL(page.url()).pathname,status:200,id:await alert.getAttribute('id'),role:await alert.getAttribute('role'),text:await alert.innerText()});}
      else await page.getByRole('heading',{name:{'/pricing':'Pricing','/privacy':'Privacy policy','/opensource':'Open source'}[route],exact:true}).waitFor();
      await checkpoint(route,200,proof);
     }
     if(homeRoutes.has(route))await homeProof(route,200);
    }
    await goto('/','public-client-login-start');await checkpoint('/',200,await landing(page,mobile));if(mobile)await o.withAction({kind:'UI_INTERACTION',selector:'open-menu'},()=>page.getByRole('button',{name:'Open menu',exact:true}).click());
    active={...active,route:'/login',label:'landing-login',step:'landing-login',selector:'a[href="/login"]:visible'};const before=await page.evaluate(()=>window.__qualDocument);await o.withAction({kind:'CLIENT_NAVIGATION',route:'/login',selector:'login-link',scenario:'public-client-login',navigation:true},()=>page.locator('a[href="/login"]:visible').first().click());await page.waitForURL(u=>u.pathname==='/login');await checkpoint('/login',200,before===await page.evaluate(()=>window.__qualDocument)&&await password(page));
    const route='/this-route-must-not-exist-csp-test', status=await goto(route,'public-404');await page.getByRole('heading',{name:'Page not found',exact:true}).waitFor();await checkpoint(route,404,status===404);
    active={...active,route:'/',label:'404-home',step:'404-home',selector:'Return home'};await o.withAction({kind:'LINK_NAVIGATION',route:'/',selector:'404-home',scenario:'public-404-home',navigation:true},()=>page.getByRole('link',{name:'Return home',exact:true}).click());await page.waitForURL(u=>u.pathname==='/');await checkpoint('/',200,await landing(page,mobile));
   } else if(auth) {
    await goto('/dashboard','auth-dashboard');await page.getByRole('heading',{name:'Find your next role',exact:true}).waitFor();await page.getByText('Review the latest jobs selected for your search.',{exact:true}).waitFor();
    await o.withAction({kind:'UI_INTERACTION',selector:'auth-shell-navigation'},async()=>{
    if(mobile){const toggle=page.getByRole('button',{name:'Open navigation',exact:true});await toggle.click();if(await toggle.getAttribute('aria-expanded')!=='true')throw Error('mobile nav inert');await page.locator('#mobile-app-navigation').waitFor();await page.keyboard.press('Escape');if(await toggle.getAttribute('aria-expanded')!=='false')throw Error('mobile nav did not close');}
    else{await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();const expand=page.getByRole('button',{name:'Expand sidebar',exact:true});if(await expand.getAttribute('aria-expanded')!=='false')throw Error('collapse inert');await expand.click();if(await page.getByRole('button',{name:'Collapse sidebar',exact:true}).getAttribute('aria-expanded')!=='true')throw Error('expand inert');}
    });
    await checkpoint('/dashboard',200,true);
   } else if(label==='guard') {
    await goto('/dashboard','guard-dashboard');await page.waitForURL(u=>u.pathname==='/login');await page.getByRole('heading',{name:'Sign in to XpertApply',exact:true}).waitFor();await checkpoint('/login',200,await password(page));
   } else {
    const segment=label==='segment-error', route=segment?'/csp-qualification-error':'/', header=segment?'x-csp-qual-segment-error':'x-csp-qual-root-error', heading=segment?'Something went wrong':'XpertApply could not load';
    await context.setExtraHTTPHeaders({[header]:'1'});o.injectedFaultActive=true;const status=await goto(route,label);await page.getByRole('heading',{name:heading,exact:true}).waitFor();const control=page.getByRole('button',{name:segment?'Try again':'Reload',exact:true});if(!await control.isEnabled()||status!==500)throw Error('injected boundary proof');
    if(!segment){const radius=await page.locator('.card').evaluate(e=>getComputedStyle(e).borderRadius);if(radius!=='16px')throw Error('standalone fallback style');}
    await checkpoint(route,500,true);active={...active,route,label:'recovery',step:'recovery',selector:segment?'Try again':'Reload'};await context.setExtraHTTPHeaders({});o.injectedFaultActive=false;const before=await page.evaluate(()=>window.__qualDocument), clickedAt=performance.now();await o.withAction({kind:segment?'ERROR_RETRY':'GLOBAL_RELOAD',route,selector:segment?'segment-retry':'global-reload',scenario:label+'-retry',navigation:true},()=>control.click());await page.getByRole('heading',{name:heading,exact:true}).waitFor({state:'hidden'});
    if(segment)await page.getByRole('heading',{name:'Qualification segment recovered',exact:true}).waitFor();else await page.locator('.xa-page').waitFor();
    const after=await page.evaluate(()=>window.__qualDocument);o.injectedFaultActive=false;
    o.recovery={faultCleared:true,clickedAt,observedAt:performance.now(),beforeDocument:before,afterDocument:after,sameDocument:before===after,unrelatedGoto:false};
    const recoveredHeading=segment?'Qualification segment recovered':await page.locator('.xa-page h1').innerText();
    const proof=clientProof(segment?'segment':'global',{action:true,before:heading,after:recoveredHeading,afterExpected:segment?recoveredHeading==='Qualification segment recovered':!!recoveredHeading,faultCleared:true,errorGone:!await page.getByRole('heading',{name:heading,exact:true}).isVisible(),unrelatedGoto:false,landingInteraction:segment?false:await landing(page,mobile)});
    await checkpoint(route,200,proof);
   }
   const result=await o.close(context);result.viewport=viewport;result.label=label;result.recovery=o.recovery||null;results.push(result);atomic(dir,'functional-smoke',{schema:1,pass:results.every(r=>r.pass),results});if(!result.pass)throw Error('smoke classification failed');
  }
 } catch(error) {observer?.failActiveAction(error);failed=true;atomic(dir,'smoke-error',failureArtifact(error,active,observer));throw error;
 } finally {try{if(browser){if(observer)await observer.cleanupBrowser(browser);else await browser.close();}}catch(error){if(!failed){failed=true;atomic(dir,'smoke-error',failureArtifact(error,{...active,label:'cleanup',step:'cleanup'},observer));throw error;}}finally{atomic(dir,'functional-smoke',{schema:1,pass:!failed&&results.length===10&&results.every(r=>r.pass),complete:!failed&&results.length===10,results});}}
 if(results.length!==10||results.some(r=>!r.pass))throw Error('incomplete smoke');
}
module.exports={authProof,homeRoutes,run};
if(require.main===module)run().catch(()=>{process.exitCode=1;});
