const { chromium } = require("/Users/cprakash/Developer/XpertApply-stage50d/apps/web/node_modules/playwright");
const fs = require("fs"); const acc = JSON.parse(fs.readFileSync("accounts.json")).a;
const W = "https://staging.xpertapply.com"; const log = (...a) => console.log(...a);
async function login(page) {
  await page.goto(W + "/login"); 
  await page.getByLabel(/email/i).first().fill(acc.email);
  await page.locator('input[type="password"]').first().fill(acc.password);
  await page.getByRole("button", { name: /^log in$/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
}
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", e => errs.push(String(e))); 
  const apiHosts = new Set(); page.on("request", r => { const u = new URL(r.url()); if (!u.hostname.includes("staging.xpertapply.com")) apiHosts.add(u.hostname); else if (u.hostname.startsWith("api")) apiHosts.add(u.hostname); });
  await login(page); log("login ok ->", page.url());
  await page.goto(W + "/tracker"); await page.getByText("Documents for", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500); await page.screenshot({ path: "shots/desktop-tracker.png", fullPage: true });
  const dlBtns = await page.getByRole("button", { name: /^Download (resume|cover letter) for/ }).evaluateAll(els => els.map(e => e.getAttribute("aria-label")));
  log("download buttons:", dlBtns.length); dlBtns.forEach(l => log("  ", l));
  log("word buttons:", await page.getByRole("button", { name: /as Word document/ }).count());
  const unavailable = await page.getByText(/no documents were prepared|didn.t prepare|nothing links them|can.t tell which saved documents|Not available/i).allTextContents(); log("unavailable texts:", JSON.stringify(unavailable));
  log("API hosts contacted:", [...apiHosts].join(","));
  // click each download button
  let n = 0;
  for (const label of dlBtns) {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.getByRole("button", { name: label, exact: true }).click()]);
    const p = "dl/" + (++n) + "-" + dl.suggestedFilename(); await dl.saveAs(p); const b = fs.readFileSync(p);
    log("DOWNLOAD", label.slice(0, 60), "=>", dl.suggestedFilename(), b.length, "B magic", b.subarray(0, 4).toString("latin1").replace(/[^\x20-\x7e]/g, "?"));
  }
  // docx buttons
  const w = page.getByRole("button", { name: /as Word document/ }); const wc = await w.count();
  for (let i = 0; i < wc; i++) { const [dl] = await Promise.all([page.waitForEvent("download"), w.nth(i).click()]); const p = "dl/w" + i + "-" + dl.suggestedFilename(); await dl.saveAs(p); log("DOCX", dl.suggestedFilename(), fs.statSync(p).size); }
  // filters + search
  for (const f of ["Applied", "Interview", "Offer", "Rejected", "All"]) { const b = page.getByRole("group", { name: "Application status filters" }).getByRole("button", { name: new RegExp("^" + f) }); if (await b.count()) { await b.first().click(); await page.waitForTimeout(300); log("filter", f, "cards:", await page.getByText(/Documents for/).count() >= 0 ? await page.locator("[aria-label^='Documents for']").count() : "?"); } else log("filter", f, "not found"); }
  await page.getByLabel("Search applications").fill("Mongodb"); await page.waitForTimeout(300); log("search Mongodb cards:", await page.locator("[aria-label^='Documents for']").count()); await page.getByLabel("Search applications").fill("");
  log("status selects:", await page.locator("select[aria-label^='Update status for']").count());
  // keyboard: focus first download button and press Enter
  const first = page.getByRole("button", { name: /^Download resume for/ }).first(); await first.focus();
  log("focus visible outline:", await first.evaluate(e => getComputedStyle(e).outlineStyle + "/" + getComputedStyle(e).boxShadow.slice(0, 30)));
  const [kd] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]); log("KEYBOARD Enter download:", kd.suggestedFilename());
  const [kd2] = await Promise.all([page.waitForEvent("download"), (async () => { await first.focus(); await page.keyboard.press("Space"); })()]); log("KEYBOARD Space download:", kd2.suggestedFilename());
  // loading + failure states
  await page.route("**/jobs/tracker/*/documents/resume*", async r => { await new Promise(s => setTimeout(s, 1500)); await r.continue(); });
  const b1 = page.getByRole("button", { name: /^Download resume for/ }).first(); const dlp = page.waitForEvent("download"); await b1.click(); await page.waitForTimeout(400);
  log("loading label:", JSON.stringify(await b1.textContent()), "disabled:", await b1.isDisabled(), "aria-busy:", await b1.getAttribute("aria-busy")); await dlp; await page.unroute("**/jobs/tracker/*/documents/resume*");
  for (const [code, name] of [[500, "500"], [404, "404"], [409, "409"], [401, "401"]]) {
    await page.route("**/jobs/tracker/*/documents/resume*", r => r.fulfill({ status: code, contentType: "application/json", body: "{}" }));
    await page.getByRole("button", { name: /^Download resume for/ }).first().click(); await page.waitForTimeout(500);
    log("failure", name, "=>", JSON.stringify(await page.getByRole("alert").allTextContents())); await page.unroute("**/jobs/tracker/*/documents/resume*"); 
  }
  log("page errors:", JSON.stringify(errs));
  // jobs list/detail
  await page.goto(W + "/jobs"); await page.waitForTimeout(3000); await page.screenshot({ path: "shots/desktop-jobs.png" }); log("jobs page title/h1:", await page.locator("h1").first().textContent().catch(() => "none"));
  // mobile
  const m = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, acceptDownloads: true }); const mp = await m.newPage(); await login(mp); await mp.goto(W + "/tracker"); await mp.waitForTimeout(3000);
  await mp.screenshot({ path: "shots/mobile-tracker.png", fullPage: true });
  log("mobile horizontal overflow:", await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), await mp.evaluate(() => document.documentElement.scrollWidth));
  const small = await mp.getByRole("button", { name: /^Download (resume|cover letter) for/ }).evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return Math.round(r.height) + "x" + Math.round(r.width); }));
  log("mobile button sizes (h x w):", small.join(" "));
  const [md] = await Promise.all([mp.waitForEvent("download"), mp.getByRole("button", { name: /^Download resume for/ }).first().click()]); log("mobile download:", md.suggestedFilename());
  await browser.close();
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
