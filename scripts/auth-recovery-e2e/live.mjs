/**
 * Live password-recovery E2E: real browser -> real web build -> real API -> real
 * PostgreSQL -> real SMTP delivery to a local sink (sink.py). Nothing is mocked.
 * Run from the repository root; see docs/plans/password-recovery.md for the setup.
 *
 *   node scripts/auth-recovery-e2e/live.mjs <workdir> <screenshot-dir>
 *
 * Environment: WEB (default http://127.0.0.1:3200), API (http://127.0.0.1:8001),
 * PG_CONTAINER (docker container running the API's PostgreSQL), PG_USER, PG_DB.
 */
const { chromium } = await import(process.cwd() + "/apps/web/node_modules/playwright/index.mjs");
import fs from "node:fs"; import path from "node:path"; import { execSync, spawn } from "node:child_process";
const S=process.argv[2], B=process.env.WEB||"http://127.0.0.1:3200", API=process.env.API||"http://127.0.0.1:8001", MAIL=`${S}/mail`, SHOTS=process.argv[3]; fs.mkdirSync(SHOTS,{recursive:true});
const psql=sql=>execSync(`docker exec ${process.env.PG_CONTAINER||"xa-auth-final-pg"} psql -U ${process.env.PG_USER||"postgres"} -d ${process.env.PG_DB||"jobpilot"} -Atc "${sql.replace(/"/g,'\\"')}"`).toString().trim();
const tag=Math.random().toString(36).slice(2,8); const EMAIL=`ada.${tag}@example.com`, OLD="old passphrase 123", NEW="brand new passphrase 456";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0; const ok=(c,m)=>{console.log((c?"PASS ":"FAIL ")+m); if(!c)fails++};
const mails=()=>fs.existsSync(MAIL)?fs.readdirSync(MAIL).sort().map(f=>({f,raw:fs.readFileSync(path.join(MAIL,f),"utf8")})):[];
const decode=raw=>raw.replace(/=\r?\n/g,"").replace(/=([0-9A-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
const to=m=>(/^To: (.*)$/m.exec(m.raw)||[])[1];
const waitMail=async(n,ms=6000)=>{const t=Date.now();while(Date.now()-t<ms){if(mails().length>=n)return mails()[n-1];await sleep(150)}return null};
const linkOf=m=>{const t=decode(m.raw);const x=/(https?:\/\/[^\s"<>]+\/reset-password#token=[A-Za-z0-9_-]+)/.exec(t);return x&&x[1]};
const seen=async(l,ms=8000)=>{try{await l.first().waitFor({state:'visible',timeout:ms});return true}catch{return false}};
const b=await chromium.launch();
async function ctx(opts={}){const c=await b.newContext({viewport:{width:1440,height:900},...opts});return c}
const c=await ctx(); const p=await c.newPage(); const apiErrors=[];
p.on("pageerror",e=>apiErrors.push(e.message));
// ---- 1. sign up through the real UI
await p.goto(B+"/signup",{waitUntil:"networkidle"});
await p.getByLabel("Email address").fill(EMAIL); await p.locator("#auth-password").fill(OLD);
await p.getByRole("button",{name:"Create account"}).click(); await p.waitForURL("**/dashboard",{timeout:15000});
const oldToken=await p.evaluate(()=>localStorage.getItem("jobpilot_token"));
ok(!!oldToken,"signup created an account and a session");
ok((await (await fetch(API+"/auth/me",{headers:{Authorization:`Bearer ${oldToken}`}})).status)===200,"old session works before the reset");
await p.evaluate(()=>localStorage.removeItem("jobpilot_token")); // sign out (UI: Log out)
// ---- 2. login page: forgot link, no privacy tagline, logo home link
await p.goto(B+"/login",{waitUntil:"networkidle"});
ok(!(await p.locator("body").innerText()).match(/Private by default|You stay in control/),"login: privacy tagline removed");
await p.screenshot({path:`${SHOTS}/login-1440.png`});
await p.getByRole("link",{name:"Forgot password?"}).click(); await p.waitForURL("**/forgot-password");
ok(true,"login: Forgot password? navigates to /forgot-password");
await p.screenshot({path:`${SHOTS}/forgot-1440.png`});
// ---- 3. nonexistent account vs existing: identical UI
await p.getByLabel("Email address").fill(`nobody.${tag}@example.com`); await p.getByRole("button",{name:"Send reset link"}).click();
await p.getByRole("heading",{name:"Check your email"}).waitFor(); const unknownText=await p.getByRole("status").innerText();
await sleep(1500); ok(mails().length===0,"nonexistent account: no email sent");
await p.getByRole("button",{name:"Use a different email"}).click();
await p.getByLabel("Email address").fill(EMAIL); await p.getByRole("button",{name:"Send reset link"}).click();
await p.getByRole("heading",{name:"Check your email"}).waitFor(); const knownText=await p.getByRole("status").innerText();
ok(unknownText.replace(/\S+@\S+/,"X")===knownText.replace(/\S+@\S+/,"X"),"existing and nonexistent accounts get identical confirmation text");
await p.screenshot({path:`${SHOTS}/forgot-sent-1440.png`});
// ---- 4. real email via real SMTP
const mail1=await waitMail(1); ok(!!mail1,"reset email delivered through real SMTP to the sink"); 
ok(to(mail1)?.includes(EMAIL),"email addressed to the account"); const link1=linkOf(mail1);
ok(!!link1&&link1.startsWith(B+"/reset-password#token="),"link uses the configured web origin and a URL fragment: "+link1?.replace(/token=.*/,"token=<redacted>"));
const tokenInDb=psql(`select count(*) from password_reset_tokens`); ok(tokenInDb==="1","exactly one live token row");
const tok1=link1.split("#token=")[1]; ok(!psql("select token_hash from password_reset_tokens").includes(tok1),"database stores a hash, not the token");
// ---- 5. open the link in a fresh tab: token stripped, weak/mismatch/success
const rp=await c.newPage(); await rp.goto(link1,{waitUntil:"networkidle"});
await rp.getByLabel("New password",{exact:true}).waitFor(); ok(!rp.url().includes("token"),"reset page removed the token from the address bar");
await rp.screenshot({path:`${SHOTS}/reset-1440.png`});
await rp.getByLabel("New password",{exact:true}).fill("short"); await rp.getByLabel("Confirm new password").fill("short"); await rp.getByRole("button",{name:"Update password"}).click();
ok((await rp.getByRole("alert").first().innerText()).includes("at least 10"),"weak password refused with a clear message");
await rp.getByLabel("New password",{exact:true}).fill(NEW); await rp.getByLabel("Confirm new password").fill(NEW+"x"); await rp.getByRole("button",{name:"Update password"}).click();
ok(await seen(rp.getByText("The passwords don't match.")),"password confirmation mismatch refused");
await rp.getByLabel("Confirm new password").fill(NEW); await rp.getByRole("button",{name:"Update password"}).click();
await rp.getByRole("heading",{name:"Password updated"}).waitFor(); ok(true,"password updated (UI confirmation)");
ok(await rp.evaluate(()=>!localStorage.getItem("jobpilot_token")),"no automatic login after reset");
await rp.screenshot({path:`${SHOTS}/reset-done-1440.png`});
// ---- 6. reuse the same link
const reuse=await c.newPage(); await reuse.goto(link1,{waitUntil:"networkidle"});
ok(await seen(reuse.getByRole("heading",{name:"This link can't be used"})),"reused link rejected");
await reuse.screenshot({path:`${SHOTS}/reset-invalid-1440.png`});
// ---- 7. login: old password fails, new works; old session revoked
await p.goto(B+"/login",{waitUntil:"networkidle"});
await p.getByLabel("Email address").fill(EMAIL); await p.locator("#auth-password").fill(OLD); await p.getByRole("button",{name:"Log in"}).click();
ok(await seen(p.getByText(/Email or password is incorrect/)),"old password no longer works");
await p.locator("#auth-password").fill(NEW); await p.getByRole("button",{name:"Log in"}).click(); await p.waitForURL("**/dashboard",{timeout:15000});
ok(true,"login with the new password succeeds");
const newToken=await p.evaluate(()=>localStorage.getItem("jobpilot_token"));
ok((await fetch(API+"/auth/me",{headers:{Authorization:`Bearer ${oldToken}`}})).status===401,"session issued before the reset is revoked (401)");
ok((await fetch(API+"/auth/me",{headers:{Authorization:`Bearer ${newToken}`}})).status===200,"new session works");
// ---- 8. expired token and garbage token
await p.evaluate(()=>localStorage.removeItem("jobpilot_token")); await p.goto(B+"/forgot-password",{waitUntil:"networkidle"});
await p.getByLabel("Email address").fill(EMAIL); await p.getByRole("button",{name:"Send reset link"}).click(); await p.getByRole("heading",{name:"Check your email"}).waitFor();
const mail2=await waitMail(2); const link2=linkOf(mail2);
psql("update password_reset_tokens set expires_at = now() - interval '1 minute'");
const ex=await c.newPage(); await ex.goto(link2,{waitUntil:"networkidle"}); ok(await seen(ex.getByRole("heading",{name:"This link can't be used"})),"expired token rejected");
const gb=await c.newPage(); await gb.goto(B+"/reset-password#token=notarealtokennotarealtokennotarealtoken1",{waitUntil:"networkidle"}); ok(await seen(gb.getByRole("heading",{name:"This link can't be used"})),"invalid token rejected");
const nt=await c.newPage(); await nt.goto(B+"/reset-password",{waitUntil:"networkidle"}); ok(await seen(nt.getByRole("heading",{name:"This link can't be used"})),"link without a token handled");
// ---- 9. OAuth-only (provider-only) account
const OA=`oauth.${tag}@example.com`; psql(`insert into users (email, hashed_password) values ('${OA}', NULL)`);
await p.goto(B+"/forgot-password",{waitUntil:"networkidle"}); await p.getByLabel("Email address").fill(OA); await p.getByRole("button",{name:"Send reset link"}).click(); await p.getByRole("heading",{name:"Check your email"}).waitFor();
const mail3=await waitMail(3); const t3=decode(mail3.raw); ok(to(mail3)?.includes(OA)&&!/reset-password/.test(t3)&&/Google/.test(t3),"provider-only account: informational email, no reset link");
ok(psql(`select count(*) from password_reset_tokens t join users u on u.id=t.user_id where u.email='${OA}'`)==="0","provider-only account: no token created");
ok(psql(`select hashed_password is null from users where email='${OA}'`)==="t","provider-only account: still has no local password");
// ---- 10. rate limit through the UI
const RL=`rate.${tag}@example.com`; psql(`insert into users (email, hashed_password) values ('${RL}', 'x')`);
const codes=[]; for(let i=0;i<4;i++){const r=await fetch(API+"/auth/password-reset/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:RL})});codes.push(r.status)}
ok(JSON.stringify(codes)==="[202,202,202,429]","per-address rate limit: "+codes);
await p.goto(B+"/forgot-password",{waitUntil:"networkidle"}); await p.getByLabel("Email address").fill(RL); await p.getByRole("button",{name:"Send reset link"}).click();
ok(await seen(p.getByRole("alert").filter({hasText:"Too many attempts"})),"rate limit shown clearly in the UI");
// ---- 11. email delivery failure: stop the sink
execSync("pkill -f 'auth-recovery-e2e/sink.py' || true"); await sleep(500);
await p.goto(B+"/forgot-password",{waitUntil:"networkidle"}); await p.getByLabel("Email address").fill(EMAIL); await p.getByRole("button",{name:"Send reset link"}).click();
ok(await seen(p.getByRole("heading",{name:"Check your email"})),"delivery failure: user still sees the generic confirmation");
await sleep(1500); const apiLog=fs.readFileSync(`${S}/api.log`,"utf8");
ok(/recovery email failed/.test(apiLog),"delivery failure was logged server-side");
ok(!apiLog.includes(tok1)&&!apiLog.includes(NEW)&&!apiLog.includes(EMAIL),"API log contains no token, password or address");
spawn("python3",[process.cwd()+"/scripts/auth-recovery-e2e/sink.py",MAIL],{detached:true,stdio:"ignore"}).unref(); await sleep(800);
// ---- 12. public pages stay light under OS dark + saved dark
const dk=await ctx({colorScheme:"dark"}); const dp=await dk.newPage(); await dp.addInitScript(()=>localStorage.setItem("xa-theme","dark"));
for(const pth of ["/forgot-password","/reset-password","/login","/signup"]){await dp.goto(B+pth,{waitUntil:"networkidle"});const r=await dp.evaluate(()=>({t:document.documentElement.dataset.theme,bg:getComputedStyle(document.body).backgroundColor,dl:[...document.querySelectorAll(".brand-mark__dark")].some(e=>getComputedStyle(e).display!=="none")}));ok(r.t==="light"&&!r.dl&&r.bg==="rgb(247, 249, 252)",`light under OS dark + saved dark: ${pth}`)}
await dk.close();
console.log(fails?`\n${fails} FAILURE(S)`:"\nALL LIVE E2E CHECKS PASSED"); console.log("page errors:",apiErrors.length?apiErrors:"none");
console.log("TAG",tag,"EMAIL",EMAIL);
await b.close();
