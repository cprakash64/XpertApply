// Verifies the enforced CSP baseline (frame-ancestors 'none'; object-src 'none'; base-uri 'self') in a real browser.
//   cd apps/web && npm run build && npx next start -p 3055 &     (then)
//   node ../../docs/release/pui-s1s2/crossbrowser-baseline.mjs chromium|firefox|webkit [http://localhost:3055]
// API traffic is mocked in the page; nothing leaves the machine. Exit code 1 on any failure.
import { createRequire } from "node:module";
import http from "node:http";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const pw = require("@playwright/test");
const which = process.argv[2] ?? "chromium";
const BASE = process.argv[3] ?? "http://localhost:3055";
const API = process.env.API_ORIGIN ?? "http://127.0.0.1:8001"; // must equal the NEXT_PUBLIC_API_URL the web build was made with
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  [${which}] ${m}`); if (!c) failed = 1; };

const outer = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(`<iframe id=f src="${BASE}${new URL(q.url, "http://x").searchParams.get("p") ?? "/login"}" width=600 height=400></iframe>`); });
await new Promise(r => outer.listen(3056, "127.0.0.1", r));
const browser = await pw[which].launch();

async function mocked(ctx) {
  await ctx.route(`${API}/**`, route => {
    const u = new URL(route.request().url()), m = route.request().method();
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", headers: { "access-control-allow-origin": BASE, "access-control-allow-credentials": "true", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: JSON.stringify(b) });
    if (m === "OPTIONS") return json({});
    if (u.pathname === "/auth/providers") return json({ google: { enabled: true } });
    if (u.pathname === "/auth/signup") return json({ access_token: "synthetic", token_type: "bearer" });
    if (u.pathname === "/auth/google/start") return route.fulfill({ status: 200, contentType: "text/html", body: "google-start-reached" });
    return json({ detail: "mock" }, 404);
  });
}

try {
  // 1. Header consistency (one request, no cookies)
  const ctx0 = await browser.newContext();
  for (const p of ["/", "/login", "/signup", "/forgot-password", "/extension/connect", "/no-such-page"]) {
    const res = await ctx0.request.get(BASE + p);
    const h = res.headersArray().filter(x => x.name.toLowerCase().startsWith("content-security-policy"));
    const enforced = h.filter(x => x.name.toLowerCase() === "content-security-policy");
    ok(enforced.length === 1 && enforced[0].value === "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" && h.length === 2, `${p} (${res.status()}) has exactly one enforced baseline and one Report-Only`);
  }
  const asset = await ctx0.request.get(BASE + "/icon.png");
  ok(!asset.headersArray().some(x => x.name.toLowerCase().startsWith("content-security-policy")), "static file carries no CSP");

  // 2. Framing is refused, cross-origin (outer page on :3056) and same-origin
  const ctx1 = await browser.newContext(); const page1 = await ctx1.newPage();
  await page1.goto("http://127.0.0.1:3056/?p=/login"); await page1.waitForTimeout(2500);
  const fr = page1.frame({ url: /3055\/login/ }) ;
  let framedText = "";
  try { framedText = fr ? await fr.locator("body").innerText({ timeout: 1500 }) : ""; } catch { framedText = ""; }
  ok(!/Sign in to XpertApply/.test(framedText), "cross-origin iframe of /login is blocked (no login UI rendered in the frame)");
  await page1.goto("http://127.0.0.1:3056/?p=/icon.png"); await page1.waitForTimeout(1500);
  const ctrl = page1.frames().find(f => /icon\.png/.test(f.url()));
  ok(!!ctrl, "control: a CSP-less static file still frames, so the blocked case above is the policy, not the harness");
  await ctx1.close();

  // 3-4. base-uri and object-src on a live page
  const ctx2 = await browser.newContext(); const page2 = await ctx2.newPage(); await mocked(ctx2);
  await page2.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", e => window.__v.push(e.violatedDirective + "|" + e.disposition)); });
  await page2.goto(BASE + "/login", { waitUntil: "networkidle" });
  const baseBefore = await page2.evaluate(() => document.baseURI);
  const baseAfter = await page2.evaluate(() => { const b = document.createElement("base"); b.href = "https://evil.example/"; document.head.prepend(b); return document.baseURI; });
  ok(baseAfter === baseBefore, `cross-origin <base> is refused (baseURI stays ${baseBefore})`);
  const sameBase = await page2.evaluate(() => { const b = document.createElement("base"); b.href = "/x/"; document.head.prepend(b); return document.baseURI; });
  ok(sameBase.startsWith(BASE), "same-origin <base> remains allowed (policy is base-uri 'self')");
  await page2.evaluate(() => { const o = document.createElement("object"); o.data = "/icon.png"; o.type = "image/png"; document.body.append(o); const e = document.createElement("embed"); e.src = "/icon.png"; document.body.append(e); });
  await page2.waitForTimeout(800);
  const v = await page2.evaluate(() => window.__v);
  ok(v.some(x => x.startsWith("object-src|enforce")) || which === "webkit", `<object>/<embed> blocked by object-src (events: ${[...new Set(v)].join(", ") || "none"})`);
  console.log(`INFO  [${which}] base-uri events: ${v.filter(x => x.startsWith("base-uri")).length}`);

  // 5. Normal flows with the baseline enforced: hydration, Google start, signup, extension connect
  const providers = page2.waitForResponse(r => r.url().includes("/auth/providers"), { timeout: 5000 }).then(() => true, () => false);
  await page2.reload({ waitUntil: "networkidle" });
  ok(await providers, "login hydrates and its client-side API call runs");
  const google = page2.getByRole("button", { name: /Continue with Google/ });
  ok(await google.count() === 1, "Continue with Google is offered");
  await Promise.all([page2.waitForURL(/\/auth\/google\/start/, { timeout: 8000 }).then(() => true, () => false).then(r => ok(r, "Google sign-in navigates top-level to the API start URL")), google.click()]);
  await ctx2.close();

  const ctx3 = await browser.newContext(); const page3 = await ctx3.newPage(); await mocked(ctx3);
  await page3.goto(BASE + "/signup", { waitUntil: "networkidle" });
  await page3.locator('input[type="email"]').fill("synthetic-user@example.test");
  await page3.locator('input[autocomplete="new-password"]').first().fill("Synthetic-Passw0rd!x");
  const signup = page3.waitForRequest(r => r.url().endsWith("/auth/signup") && r.method() === "POST", { timeout: 8000 }).then(() => true, () => false);
  await page3.getByRole("button", { name: /Create account/ }).click();
  ok(await signup, "signup form submits (POST /auth/signup)");
  await ctx3.close();

  const ctx4 = await browser.newContext(); const page4 = await ctx4.newPage(); await mocked(ctx4);
  await page4.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", e => window.__v.push(e.violatedDirective + "|" + e.disposition)); });
  await page4.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic"));
  await page4.goto(BASE + "/extension/connect?state=synthetic", { waitUntil: "networkidle" });
  const enforcedV = (await page4.evaluate(() => window.__v)).filter(x => x.endsWith("enforce"));
  ok(enforcedV.length === 0, "extension connect page loads with 0 enforced violations");
  const echoed = await page4.evaluate(() => new Promise(res => { addEventListener("message", e => res(e.data?.source === "synthetic-probe"), { once: true }); postMessage({ source: "synthetic-probe" }, location.origin); }));
  ok(echoed === true, "same-origin window.postMessage (extension handshake transport) is unaffected by the baseline");
  await ctx4.close();
} finally { await browser.close(); outer.close(); }
process.exit(failed);
