import { expect, test, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { employerTls } from "./xa-core1-harness";

/**
 * XA-CORE1 connect flow in a real browser, against the REAL website page (`/extension/connect`, Next dev
 * server) and the REAL API (this checkout, throwaway SQLite, exact extension-id allowlist, CORS on).
 *
 * What cannot be automated is Chrome's own sign-in window: `chrome.identity.launchWebAuthFlow` is replaced,
 * inside the worker, by a function that hands the authorization URL to this test. The test then does what
 * Chrome would: it opens that URL in a real tab, lets the user-visible page run, and captures the redirect to
 * `https://<id>.chromiumapp.org/...` (never fetched) to hand back. Everything else is the shipped code: the
 * worker's PKCE/state handling, the website page, the API's code/token endpoints, the overlay's buttons.
 */
const WEB = "http://localhost:3000";
const here = path.dirname(new URL(import.meta.url).pathname);
const extRoot = path.resolve(here, "..");
const webRoot = path.resolve(extRoot, "..", "web");
const apiRoot = path.resolve(extRoot, "..", "api");
const API_PYTHON = process.env.XA_E2E_API_PYTHON ?? path.join(apiRoot, ".venv", "bin", "python");
const PASSWORD = "password-for-e2e-1";

async function waitFor(url: string, child: ChildProcess, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`${url} server exited with ${child.exitCode}`);
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

async function stack() {
  const tls = await employerTls();
  const dist = process.env.XA_E2E_DIST!;
  const ctx: BrowserContext = await chromium.launchPersistentContext("", { channel: "chromium", serviceWorkers: "allow", ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...tls.args] });
  const worker: Worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId: string = await worker.evaluate(() => chrome.runtime.id);
  worker.on("console", m => { if (process.env.XA_E2E_DEBUG) console.log("[worker]", m.text().slice(0, 220)); });

  // Fixed on purpose: Next inlines NEXT_PUBLIC_API_URL into its dev cache, so a random port would go stale.
  const apiPort = 18721;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const db = path.join(mkdtempSync(path.join(tmpdir(), "xa-connect-")), "api.db");
  const api = spawn(API_PYTHON, [path.join(here, "connect-api.py")], {
    env: { PATH: process.env.PATH!, XA_API_ROOT: apiRoot, XA_API_DB: db, XA_API_PORT: String(apiPort), APP_ENV: "test",
      SECRET_KEY: "e2e-secret-key-e2e-secret-key-0123456789", CORS_ORIGINS: JSON.stringify([WEB]),
      EXTENSION_ALLOWED_IDS: JSON.stringify([extId]) }, stdio: ["ignore", "ignore", "pipe"]
  });
  await waitFor(`${apiOrigin}/healthz`, api);
  const web = spawn(process.execPath, [path.join(webRoot, "node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "localhost", "--port", "3000"], {
    // Own process group: `next dev` forks its server, and killing only the launcher left it holding port 3000 for later specs.
    cwd: webRoot, env: { ...process.env, NEXT_PUBLIC_API_URL: apiOrigin }, stdio: ["ignore", "ignore", "ignore"], detached: true
  });
  await waitFor(`${WEB}/login`, web);

  await worker.evaluate(async ([a, w]) => chrome.storage.local.set({ apiBase: a, webBase: w }), [apiOrigin, WEB]);
  // Replace ONLY Chrome's native window: hand the URL to the test, wait for it to hand back a result.
  await worker.evaluate(() => {
    const g = globalThis as any;
    g.__auth = null;
    chrome.identity.launchWebAuthFlow = ((details: { url: string }) => new Promise((resolve, reject) => {
      g.__auth = { url: details.url, resolve, reject };
    })) as typeof chrome.identity.launchWebAuthFlow;
  });
  const call = (p: string, init?: RequestInit) => fetch(`${apiOrigin}${p}`, init);
  const signup = async (email: string, fullName = "Chandra Pandey") => {
    const r = await call("/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
    const token = (await r.json()).access_token as string;
    const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
    await call("/profile", { method: "PUT", headers: h, body: JSON.stringify({ full_name: fullName, phone: "602-555-0100", location_city: "Phoenix", location_state: "AZ", location_country: "United States", work_authorization: "authorized_us", target_roles: ["Backend Engineer"], target_levels: ["Junior"], preferred_locations: ["United States"], remote_preference: "remote", skills: ["Python"] }) });
    await call("/profile/career", { method: "PUT", headers: h, body: JSON.stringify({ education: [{ school: "Arizona State University", degree: "BS" }], experience: [{ company: "Cardinal Health", title: "ML Engineer Intern", bullets: ["Built Python services"], technologies: ["Python"], currently_working: true }], projects: [], certifications: [], awards: [] }) });
    return token;
  };
  /** A tab on the website with the user signed in, as in the user's normal browser profile. */
  const websiteTab = async (token: string | null) => {
    const page = await ctx.newPage();
    await page.goto(`${WEB}/login`);
    await page.evaluate(t => { t ? localStorage.setItem("jobpilot_token", t) : localStorage.removeItem("jobpilot_token"); }, token);
    return page;
  };
  /** Do what Chrome would for the pending sign-in: open the URL in a tab, run `act`, and return the redirect captured. */
  const authUrl = async () => {
    await expect.poll(() => worker.evaluate(() => (globalThis as any).__auth?.url ?? null), { timeout: 30_000 }).not.toBeNull();
    return worker.evaluate(() => (globalThis as any).__auth.url as string);
  };
  const completeWith = (redirect: string) => worker.evaluate(r => { const a = (globalThis as any).__auth; (globalThis as any).__auth = null; a.resolve(r); }, redirect);
  const closeWindow = () => worker.evaluate(() => { const a = (globalThis as any).__auth; (globalThis as any).__auth = null; a.reject(new Error("The user did not approve access.")); });
  const captureRedirect = async (page: Page, url: string, act: (p: Page) => Promise<void>) => {
    let captured = "";
    await page.route(u => u.hostname.endsWith(".chromiumapp.org"), async route => { captured = route.request().url(); await route.abort(); });
    await page.goto(url);
    await act(page);
    await expect.poll(() => captured, { timeout: 30_000 }).not.toBe("");
    return captured;
  };
  const credential = () => worker.evaluate(() => new Promise<any>((resolve, reject) => {
    const open = indexedDB.open("xpertapply-extension-auth", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const get = open.result.transaction("kv").objectStore("kv").get("xaExtensionAuthV1"); get.onsuccess = () => resolve(get.result ?? null); };
  }));
  const employerApply = async () => {
    const page = await ctx.newPage();
    page.on("dialog", d => void d.accept());       // the overlay's own confirm() prompts
    await page.goto("https://careers.withwaymo.com/jobs/machine-learning-engineer");
    await page.click("#apply-now");
    await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    return page;
  };
  return {
    ctx, worker, extId, apiOrigin, call, signup, websiteTab, authUrl, completeWith, closeWindow, captureRedirect, credential, employerApply,
    async close() { await ctx.close().catch(() => undefined); try { if (web.pid) process.kill(-web.pid, "SIGKILL"); } catch { /* already gone */ } api.kill("SIGKILL"); tls.server.close();
      for (let i = 0; i < 50 && await fetch(`${WEB}/login`).then(() => true, () => false); i++) await new Promise(r => setTimeout(r, 100));
    }
  };
}
const consent = (p: Page) => p.getByRole("button", { name: /connect extension/i }).click();

test("signed-out extension, signed-in website user: Connect -> consent -> fills, status shown, Disconnect revokes", async () => {
  test.setTimeout(420_000);
  const s = await stack();
  try {
    const token = await s.signup("e2e.connect@mailbox.test-domain.co");
    const site = await s.websiteTab(token);
    const employer = await s.employerApply();
    const ov = overlayCdp(employer);
    await expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/Connect XpertApply/);
    await expect.poll(async () => (await ov.text("#account")) ?? "", { timeout: 20_000 }).toMatch(/Not connected/);
    expect(await employer.inputValue("#first_name")).toBe("");

    await ov.click("#fill");                                       // "Connect XpertApply"
    const url = new URL(await s.authUrl());
    expect(url.origin + url.pathname).toBe(`${WEB}/extension/connect`);
    expect(url.searchParams.get("redirect_uri")).toBe(`https://${s.extId}.chromiumapp.org/xpertapply`);
    expect(url.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")!.length).toBeGreaterThanOrEqual(20);
    expect(url.search).not.toMatch(/token|verifier|refresh/i);     // nothing secret in the browser URL

    const tab = await s.ctx.newPage();
    await tab.addInitScript(t => localStorage.setItem("jobpilot_token", t), token);
    const redirect = await s.captureRedirect(tab, url.toString(), async p => {
      await expect(p.getByText("e2e.connect@mailbox.test-domain.co")).toBeVisible({ timeout: 60_000 });   // names the account
      await consent(p);
    });
    const returned = new URL(redirect);
    expect(returned.searchParams.get("state")).toBe(url.searchParams.get("state"));
    expect(returned.searchParams.get("code")).toBeTruthy();
    expect(redirect).not.toContain(token);                         // the website token never rides the redirect
    await s.completeWith(redirect);

    // The fill pipeline ran against the REAL backend session. (Which fields it fills is the answer-verification
    // policy, e.g. names need an explicit confirmation; this test is about authentication, so it checks that the
    // authenticated draft was opened and processed, and that nothing was submitted.)
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 60_000 }).toBeGreaterThanOrEqual(5);
    await expect.poll(async () => Number(await ov.text("#filled")), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    expect(await ov.call<boolean>("function(){return this.getElementById('errors').hidden}")).toBe(true);   // no stale error beside a success
    await expect.poll(async () => (await ov.text("#stage")) ?? "", { timeout: 30_000 }).toMatch(/filled|review/i);
    expect(await employer.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
    await expect.poll(async () => (await ov.text("#account")) ?? "").toMatch(/Connected as e2e\.connect@mailbox\.test-domain\.co/);

    // The stored credential is real and live on the server; the website token was not copied.
    const cred = await s.credential();
    expect(cred.email).toBe("e2e.connect@mailbox.test-domain.co");
    expect(JSON.stringify(cred)).not.toContain(token);
    expect((await s.call("/extension/me", { headers: { authorization: `Bearer ${cred.accessToken}` } })).status).toBe(200);
    expect((await s.call("/auth/me", { headers: { authorization: `Bearer ${cred.accessToken}` } })).status).toBe(401);

    // Replay: the same redirect/code cannot be redeemed again.
    const replay = await s.call("/extension/auth/token", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: returned.searchParams.get("code"), code_verifier: "x".repeat(64), redirect_uri: `https://${s.extId}.chromiumapp.org/xpertapply` }) });
    expect(replay.status).toBe(400);

    // Disconnect from the assistant: server-side revoke, local credential gone, assistant says not connected.
    await ov.click("#disconnect");
    await expect.poll(() => s.credential(), { timeout: 20_000 }).toBeNull();
    // The local credential is dropped first; the server-side revoke follows. Wait for it, do not race it.
    await expect.poll(async () => (await s.call("/extension/me", { headers: { authorization: `Bearer ${cred.accessToken}` } })).status, { timeout: 20_000 }).toBe(401);
    const refreshStatus = (await s.call("/extension/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: cred.refreshToken }) })).status;
    expect(refreshStatus).toBe(401);                                // the refresh credential is dead too
    await expect.poll(async () => (await ov.text("#account")) ?? "").toMatch(/Not connected/);
    await site.close();
  } finally { await s.close(); }
});

test("interruptions: declined consent, closed window, forged state, wrong extension id, network failure", async () => {
  test.setTimeout(420_000);
  const s = await stack();
  try {
    const token = await s.signup("e2e.fail@mailbox.test-domain.co");
    const employer = await s.employerApply();
    const ov = overlayCdp(employer);
    const notice = async (re: RegExp) => expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(re);
    await notice(/Connect XpertApply/);

    // 1. The user clicks Cancel on the consent page.
    await ov.click("#fill");
    const declined = await s.captureRedirect(await s.websiteTab(token), await s.authUrl(), async p => {
      await expect(p.getByRole("button", { name: /^cancel$/i })).toBeVisible({ timeout: 60_000 });
      await p.getByRole("button", { name: /^cancel$/i }).click();
    });
    expect(new URL(declined).searchParams.get("error")).toBe("access_denied");
    await s.completeWith(declined);
    await notice(/declined/i);
    expect(await s.credential()).toBeNull();

    // 2. The user closes Chrome's window.
    await ov.click("#fill");
    await s.authUrl();
    await s.closeWindow();
    await notice(/cancelled/i);
    expect(await s.credential()).toBeNull();

    // 3. A response carrying someone else's state is not believed.
    await ov.click("#fill");
    const u = new URL(await s.authUrl());
    await s.completeWith(`https://${s.extId}.chromiumapp.org/xpertapply?code=whatever&state=forged-state`);
    // The security property first, independent of what the notice shows: a forged state stores no credential.
    await new Promise((r) => setTimeout(r, 2000));
    expect(await s.credential()).toBeNull();
    await notice(/couldn.t be verified/i);
    expect(await s.credential()).toBeNull();

    // 4. The exchange fails because the API is unreachable: nothing is stored, and the message says so.
    await ov.click("#fill");
    const url4 = await s.authUrl();
    const ok = await s.captureRedirect(await s.websiteTab(token), url4, async p => { await consent(p); });
    await s.worker.evaluate(async () => chrome.storage.local.set({ apiBase: "http://127.0.0.1:9" }));
    await s.completeWith(ok);
    await notice(/couldn.t be reached/i);
    expect(await s.credential()).toBeNull();
    await s.worker.evaluate(async a => chrome.storage.local.set({ apiBase: a }), s.apiOrigin);

    // 5. The API only ever mints a code for the allowlisted extension id.
    const rogue = await s.call("/extension/auth/code", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ code_challenge: u.searchParams.get("challenge"), redirect_uri: `https://${"c".repeat(32)}.chromiumapp.org/xpertapply` }) });
    expect(rogue.status).toBe(400);
    expect(await employer.inputValue("#first_name")).toBe("");
  } finally { await s.close(); }
});

test("signed-out website user: the consent page asks to sign in first and returns to the same request", async () => {
  test.setTimeout(240_000);
  const s = await stack();
  try {
    const employer = await s.employerApply();
    await overlayCdp(employer).click("#fill");
    const url = await s.authUrl();
    const tab = await s.ctx.newPage();
    await tab.goto(url);
    await expect(tab.getByText(/sign in to xpertapply first/i)).toBeVisible({ timeout: 60_000 });
    await expect(tab.getByRole("button", { name: /connect extension/i })).toHaveCount(0);
    const signIn = tab.getByRole("link", { name: /sign in/i });
    expect(await signIn.getAttribute("href")).toContain("/login?next=%2Fextension%2Fconnect");
    expect(decodeURIComponent((await signIn.getAttribute("href"))!)).toContain(new URL(url).searchParams.get("challenge")!);
    await s.closeWindow();
  } finally { await s.close(); }
});

// EXT-LIVE-10: a failed sign-in is STATE on the tab, not a transient string in the page. The worker re-resolves the same
// "not connected" application whenever the page reloads or a form-watch cycle ends; that used to write a fresh generic
// notice over the reason the last attempt failed. Every outcome below is asserted twice: the notice the person sees AND
// the stored authentication state (no credential unless a verified exchange succeeded).
test("sign-in outcomes: the reason survives re-resolution, duplicates are inert, retry and account change start clean", async () => {
  test.setTimeout(480_000);
  const s = await stack();
  try {
    const tokenA = await s.signup("e2e.auth.a@mailbox.test-domain.co");
    const tokenB = await s.signup("e2e.auth.b@mailbox.test-domain.co");
    const employer = await s.employerApply();
    const ov = overlayCdp(employer);
    const notice = async (re: RegExp) => expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(re);
    let live = ov;        // the overlay of the CURRENT document (a reload replaces it)
    const reopen = async () => {
      await employer.reload();
      await employer.click("#apply-now");
      await expect(employer.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
      live = overlayCdp(employer);
      return live;
    };
    const noticeHidden = async () => {
      try { await expect.poll(async () => live.call<boolean>("function(){return this.getElementById('errors').hidden}"), { timeout: 30_000 }).toBe(true); }
      catch (e) { console.log("NOTICE NOT HIDDEN:", JSON.stringify(await live.text("#errors"))); throw e; }
    };
    await notice(/isn.t connected/i);
    expect(await s.credential()).toBeNull();

    // Forged state, delivered TWICE (a duplicate callback): rejected, nothing stored, reason shown.
    await ov.click("#fill");
    await s.authUrl();
    await s.worker.evaluate(() => {
      const a = (globalThis as any).__auth; (globalThis as any).__auth = null;
      const forged = `https://${chrome.runtime.id}.chromiumapp.org/xpertapply?code=whatever&state=forged-state`;
      a.resolve(forged); a.resolve(forged);
    });
    await notice(/couldn.t be verified/i);
    expect(await s.credential()).toBeNull();

    // A DELAYED "not connected" answer: the worker re-resolves this same application (a real reload runs the real path).
    // The earlier outcome is the tab's state, so it is still what the person reads.
    let ov2 = await reopen();
    await expect.poll(async () => (await ov2.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/couldn.t be verified|isn.t connected/i);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await ov2.text("#errors")) ?? "").toMatch(/couldn.t be verified/i);
    expect(await s.credential()).toBeNull();

    // Network failure replaces the earlier reason (a new attempt starts clean); still nothing stored.
    await ov2.click("#fill");
    const url2 = await s.authUrl();
    const okRedirect = await s.captureRedirect(await s.websiteTab(tokenA), url2, async p => { await consent(p); });
    await s.worker.evaluate(async () => chrome.storage.local.set({ apiBase: "http://127.0.0.1:9" }));
    await s.completeWith(okRedirect);
    await expect.poll(async () => (await ov2.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/couldn.t be reached/i);
    expect((await ov2.text("#errors")) ?? "").not.toMatch(/couldn.t be verified/i);
    expect(await s.credential()).toBeNull();
    await s.worker.evaluate(async a => chrome.storage.local.set({ apiBase: a }), s.apiOrigin);

    // Retry succeeds as account A: the stale error is gone and the verified credential is stored.
    await ov2.click("#fill");
    const urlA = await s.authUrl();
    const redirectA = await s.captureRedirect(await s.websiteTab(tokenA), urlA, async p => { await consent(p); });
    await s.completeWith(redirectA);
    await expect.poll(async () => (await s.credential())?.email ?? null, { timeout: 30_000 }).toBe("e2e.auth.a@mailbox.test-domain.co");
    await noticeHidden();

    // Account switch: disconnect A; the "not connected" notice is clean (nothing of A's attempts leaks), a cancelled
    // attempt is reported as cancelled, and a successful attempt as B leaves a clean notice and B's credential only.
    await ov2.click("#disconnect");
    await expect.poll(() => s.credential(), { timeout: 20_000 }).toBeNull();
    await expect.poll(async () => (await ov2.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/isn.t connected/i);
    ov2 = await reopen();                 // after Disconnect the page is detached; a person reopens the application
    await expect.poll(async () => (await ov2.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/isn.t connected/i);
    expect((await ov2.text("#errors")) ?? "").not.toMatch(/couldn.t be verified|couldn.t be reached/i);
    await ov2.click("#fill");
    await s.authUrl();
    await s.closeWindow();
    await notice(/cancelled/i);
    expect(await s.credential()).toBeNull();
    await ov2.click("#fill");
    const urlB = await s.authUrl();
    const redirectB = await s.captureRedirect(await s.websiteTab(tokenB), urlB, async p => { await consent(p); });
    await s.completeWith(redirectB);
    await expect.poll(async () => (await s.credential())?.email ?? null, { timeout: 30_000 }).toBe("e2e.auth.b@mailbox.test-domain.co");
    await noticeHidden();
    expect(await employer.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
  } finally { await s.close(); }
});

// EXT-LIVE-10: Chrome may stop the MV3 worker while Chrome's sign-in window is open. The in-flight attempt dies with the
// worker; nothing is stored, and the person simply starts again.
test("sign-in survives worker suspension: the dead attempt stores nothing and a fresh attempt connects", async () => {
  test.setTimeout(360_000);
  const s = await stack();
  try {
    const token = await s.signup("e2e.suspend@mailbox.test-domain.co");
    const employer = await s.employerApply();
    const ov = overlayCdp(employer);
    await expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/isn.t connected/i);
    await ov.click("#fill");
    await s.authUrl();                                        // Chrome's window is "open"

    const cdp = await s.ctx.newCDPSession(employer);
    const scopes: string[] = [];
    cdp.on("ServiceWorker.workerRegistrationUpdated", (ev) => { for (const r of ev.registrations) scopes.push(r.scopeURL); });
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await expect.poll(() => scopes.find((u) => u.startsWith("chrome-extension://")) ?? null, { timeout: 15_000 }).not.toBeNull();
    const nudge = await s.ctx.newPage();
    await nudge.goto(`${scopes.find((u) => u.startsWith("chrome-extension://"))!}access.html`);
    let worker = s.ctx.serviceWorkers().at(-1)!;
    await expect.poll(async () => {
      worker = s.ctx.serviceWorkers().at(-1)!;
      return worker ? Promise.race([worker.evaluate(() => true).catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]) : false;
    }, { timeout: 30_000 }).toBe(true);
    await worker.evaluate(() => {                              // the new worker has no test stand-in for Chrome's window yet
      const g = globalThis as any; g.__auth = null;
      chrome.identity.launchWebAuthFlow = ((d: { url: string }) => new Promise((resolve, reject) => { g.__auth = { url: d.url, resolve, reject }; })) as typeof chrome.identity.launchWebAuthFlow;
    });
    await nudge.close();
    const stored = () => worker.evaluate(() => new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open("xpertapply-extension-auth", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => { const get = open.result.transaction("kv").objectStore("kv").get("xaExtensionAuthV1"); get.onsuccess = () => resolve(get.result ?? null); };
    }));
    expect(await stored()).toBeNull();                         // the interrupted attempt stored nothing

    // The person reopens the application and tries again; this attempt is complete and verified.
    await employer.reload();
    await employer.click("#apply-now");
    await expect(employer.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    const ov2 = overlayCdp(employer);
    await expect.poll(async () => (await ov2.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/isn.t connected/i);
    await ov2.click("#fill");
    await expect.poll(() => worker.evaluate(() => (globalThis as any).__auth?.url ?? null), { timeout: 30_000 }).not.toBeNull();
    const url = await worker.evaluate(() => (globalThis as any).__auth.url as string);
    const redirect = await s.captureRedirect(await s.websiteTab(token), url, async p => { await consent(p); });
    await worker.evaluate(r => { const a = (globalThis as any).__auth; (globalThis as any).__auth = null; a.resolve(r); }, redirect);
    await expect.poll(async () => ((await stored()) as { email?: string } | null)?.email ?? null, { timeout: 30_000 }).toBe("e2e.suspend@mailbox.test-domain.co");
    await expect.poll(async () => ov2.call<boolean>("function(){return this.getElementById('errors').hidden}"), { timeout: 30_000 }).toBe(true);
  } finally { await s.close(); }
});

// EXT-LIVE-10: Connect -> Disconnect -> Connect again on the SAME document, as a different account. No reload: the open page
// resolves again as soon as the new sign-in lands, shows only the new account's data, and leaves one assistant and one draft.
test("same-page reconnect: Disconnect then Connect (another account) rebinds the open tab without a reload", async () => {
  test.setTimeout(480_000);
  const s = await stack();
  try {
    const tokenA = await s.signup("e2e.re.a@mailbox.test-domain.co", "Alice Alpha");
    const tokenB = await s.signup("e2e.re.b@mailbox.test-domain.co", "Brenda Beta");
    const employer = await s.employerApply();
    const ov = overlayCdp(employer);
    await expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/isn.t connected/i);
    const connectAs = async (token: string) => {
      await ov.click("#fill");
      const url = await s.authUrl();
      const redirect = await s.captureRedirect(await s.websiteTab(token), url, async p => { await consent(p); });
      await s.completeWith(redirect);
    };
    const resumeName = () => employer.inputValue("#resume");        // the attached résumé carries the account's own name
    await connectAs(tokenA);
    await expect.poll(resumeName, { timeout: 60_000 }).toContain("Alice_Alpha");
    const credA = await s.credential();
    expect(credA.email).toBe("e2e.re.a@mailbox.test-domain.co");

    await ov.click("#disconnect");
    await expect.poll(() => s.credential(), { timeout: 20_000 }).toBeNull();
    await expect.poll(async () => (await s.call("/extension/me", { headers: { authorization: `Bearer ${credA.accessToken}` } })).status, { timeout: 20_000 }).toBe(401);
    await expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(/isn.t connected/i);

    // Same document, no reload. The employer form is the person's: clear what A's run wrote so B's value is unambiguous.
    await employer.evaluate(() => { for (const id of ["resume", "cover"]) (document.getElementById(id) as HTMLInputElement).value = ""; });   // the person clears the earlier attachments
    await connectAs(tokenB);
    await expect.poll(resumeName, { timeout: 60_000 }).toContain("Brenda_Beta");
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 60_000 }).toBeGreaterThanOrEqual(5);
    await expect.poll(async () => (await ov.text("#account")) ?? "", { timeout: 30_000 }).toMatch(/Connected as e2e\.re\.b@mailbox\.test-domain\.co/);
    expect(await ov.call<boolean>("function(){return this.getElementById('errors').hidden}")).toBe(true);
    expect((await s.credential()).email).toBe("e2e.re.b@mailbox.test-domain.co");
    expect(await employer.locator("#xpertapply-assistant-overlay-v1").count()).toBe(1);
    const drafts = await s.worker.evaluate(async () => Object.keys(((await chrome.storage.session.get("pendingLaunches")) as any).pendingLaunches ?? {}).length);
    expect(drafts).toBe(1);
    expect((await s.call("/extension/me", { headers: { authorization: `Bearer ${credA.accessToken}` } })).status).toBe(401);   // A stays revoked
    expect(await employer.evaluate(() => (window as any).__emp)).toEqual({ submits: 0, clicks: 0 });
  } finally { await s.close(); }
});
