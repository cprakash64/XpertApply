/* AUDIT ARTIFACT — temporary security audit spec. Not production code. */
import { expect } from "@playwright/test";
import { test, stubApi, seedHandoff } from "./zz-audit-harness";

test.setTimeout(180_000);
test.describe.configure({ mode: "serial" });

// --------------------------------------------------------------------------- //
// 1. Same-origin embedded third-party form inside a bound application page
// --------------------------------------------------------------------------- //
const WITH_SAME_ORIGIN_FRAME = `<!doctype html><meta charset="utf-8"><title>AuditCo Apply</title>
<h1>Apply for Staff Engineer</h1><h2>Personal information</h2>
<form id="application-form" action="/submit" method="post">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <button type="submit" id="final-submit">Submit application</button>
</form>
<iframe id="so" src="/vendor-same-origin" width="500" height="400"></iframe>`;

const VENDOR_SO = `<!doctype html><meta charset="utf-8"><title>vendor</title>
<h3>Personal information</h3>
<form id="vendor-form">
  <label for="v_first">First name</label><input id="v_first" name="first_name">
  <label for="v_last">Last name</label><input id="v_last" name="last_name">
  <label for="v_email">Email</label><input id="v_email" name="email" type="email">
  <label for="v_phone">Phone</label><input id="v_phone" name="phone">
  <label for="v_li">LinkedIn</label><input id="v_li" name="linkedin">
</form>`;

test("AUDIT-1 same-origin embedded vendor frame in a bound tab", async ({ context, worker, origin, routes }) => {
  routes.set("/vendor-same-origin", VENDOR_SO);
  routes.set("/job-so", WITH_SAME_ORIGIN_FRAME);
  const applicationUrl = `${origin}/job-so`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  await page.waitForTimeout(25_000);

  const frame = page.frames().find((f) => f.url().includes("vendor-same-origin"));
  const vendor = frame ? await frame.evaluate(() => ({
    first: (document.getElementById("v_first") as HTMLInputElement).value,
    email: (document.getElementById("v_email") as HTMLInputElement).value,
    marked: document.querySelectorAll("[data-jobpilot-filled]").length,
    touched: document.documentElement.outerHTML.includes("jobpilot")
  })) : { error: "no frame" };
  const top = await page.evaluate(() => ({
    first: (document.getElementById("first_name") as HTMLInputElement).value,
    email: (document.getElementById("email") as HTMLInputElement).value
  }));
  console.log("AUDIT-1 TOP " + JSON.stringify(top));
  console.log("AUDIT-1 SAME_ORIGIN_FRAME " + JSON.stringify(vendor));
  await page.close();
});

// --------------------------------------------------------------------------- //
// 2. Hostile page probing the extension from page context
// --------------------------------------------------------------------------- //
const HOSTILE = `<!doctype html><meta charset="utf-8"><title>Hostile ATS</title>
<script>
  window.__audit = { attachShadowCalls: 0, capturedRoots: [], addedNodes: [], errors: [] };
  const realAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    window.__audit.attachShadowCalls++;
    const root = realAttach.call(this, { ...init, mode: "open" });
    window.__audit.capturedRoots.push(root);
    return root;
  };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType === 1) window.__audit.addedNodes.push((n.id || n.tagName));
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
</script>
<h1>Apply</h1><h2>Personal information</h2>
<form id="application-form">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <button type="submit" id="final-submit">Submit application</button>
</form>`;

test("AUDIT-2 hostile page probing the extension", async ({ context, worker, origin, routes }) => {
  routes.set("/hostile", HOSTILE);
  const applicationUrl = `${origin}/hostile`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  await page.waitForTimeout(20_000);

  const extensionId = new URL(worker.url()).host;

  const probe = await page.evaluate(async (extId) => {
    const out: Record<string, unknown> = {};
    const audit = (window as any).__audit;
    out.attachShadowCalls = audit.attachShadowCalls;
    out.capturedRootsHtml = audit.capturedRoots.map((r: ShadowRoot) => (r.innerHTML || "").slice(0, 200));
    out.widgetHostPresent = Boolean(document.getElementById("jobpilot-assisted-apply"));
    const host = document.getElementById("jobpilot-assisted-apply") as HTMLElement | null;
    out.widgetShadowRootReadable = Boolean(host && (host as any).shadowRoot);
    try { out.widgetGetHTML = host && typeof (host as any).getHTML === "function"
      ? String((host as any).getHTML({ serializableShadowRoots: true })).slice(0, 200) : "n/a"; }
    catch (e) { out.widgetGetHTML = "throw:" + String(e).slice(0, 60); }
    out.jobpilotMarkers = Array.from(document.querySelectorAll("[data-jobpilot-filled],[data-jobpilot-status],[data-jobpilot-original]"))
      .map((el) => ({ id: el.id, filled: el.getAttribute("data-jobpilot-filled"), status: el.getAttribute("data-jobpilot-status"), original: el.getAttribute("data-jobpilot-original") }));
    out.chromeRuntimePresent = typeof (window as any).chrome?.runtime?.sendMessage === "function";
    try {
      const r = await fetch(`chrome-extension://${extId}/content.js`);
      out.warFetchContentJs = r.status;
    } catch (e) { out.warFetchContentJs = "blocked:" + String(e).slice(0, 60); }
    try {
      const r = await fetch(`chrome-extension://${extId}/manifest.json`);
      out.warFetchManifest = r.status;
    } catch (e) { out.warFetchManifest = "blocked:" + String(e).slice(0, 60); }
    out.globals = Object.getOwnPropertyNames(window).filter((k) => /jobpilot|xpertapply/i.test(k));
    out.addedNodes = audit.addedNodes.slice(0, 20);
    return out;
  }, extensionId);

  console.log("AUDIT-2 PROBE " + JSON.stringify(probe, null, 2));
  await page.close();
});

// --------------------------------------------------------------------------- //
// 3. Do-no-harm: unrelated forms + prefilled values on a bound application page
// --------------------------------------------------------------------------- //
const MIXED = `<!doctype html><meta charset="utf-8"><title>AuditCo</title>
<form id="site-search"><label for="q">Search</label><input id="q" name="q" type="search"></form>
<form id="login-form"><h3>Sign in</h3>
  <label for="lg_email">Email</label><input id="lg_email" name="email" type="email">
  <label for="lg_pass">Password</label><input id="lg_pass" name="password" type="password">
  <button type="submit">Log in</button></form>
<form id="newsletter"><h3>Newsletter</h3>
  <label for="nl_email">Email</label><input id="nl_email" name="email" type="email">
  <label for="nl_name">Your name</label><input id="nl_name" name="name">
  <button type="submit">Subscribe</button></form>
<form id="payment"><h3>Payment</h3>
  <label for="cc">Card number</label><input id="cc" name="cardnumber" autocomplete="cc-number">
  <label for="cvc">CVC</label><input id="cvc" name="cvc"></form>
<h1>Apply for Staff Engineer</h1><h2>Personal information</h2>
<form id="application-form">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required value="TYPED-BY-USER">
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" name="phone">
  <label for="hp">Leave blank</label><input id="hp" name="honeypot_field" style="position:absolute;left:-9999px">
  <input type="hidden" id="csrf" name="csrf_token" value="ORIGINAL-CSRF">
  <label for="captcha">Type the characters you see</label><input id="captcha" name="captcha">
  <button type="submit" id="final-submit">Submit application</button>
</form>`;

test("AUDIT-3 do-no-harm on a bound page", async ({ context, worker, origin, routes }) => {
  routes.set("/mixed", MIXED);
  const applicationUrl = `${origin}/mixed`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  await page.waitForTimeout(25_000);

  const state = await page.evaluate(() => {
    const v = (id: string) => (document.getElementById(id) as HTMLInputElement)?.value ?? "(missing)";
    return {
      search_q: v("q"),
      login_email: v("lg_email"),
      login_password: v("lg_pass"),
      newsletter_email: v("nl_email"),
      newsletter_name: v("nl_name"),
      cc: v("cc"),
      cvc: v("cvc"),
      app_first: v("first_name"),
      app_last_prefilled: v("last_name"),
      app_email: v("email"),
      app_phone: v("phone"),
      honeypot: v("hp"),
      csrf: v("csrf"),
      captcha: v("captcha"),
      submitted: (window as any).__submitted ?? false
    };
  });
  console.log("AUDIT-3 STATE " + JSON.stringify(state, null, 2));
  await page.close();
});
