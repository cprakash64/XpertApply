import { expect, test, type Page } from "@playwright/test";
import { overlayCdp } from "./overlay-cdp";
import { PROFILES, directDrafts, employerTls, launchSignedIn, overlayCount, startDirectApi, submitsUntouched } from "./xa-core1-harness";

/**
 * EXT-E2C account isolation for direct drafts, in real Chromium with synthetic accounts 7 and 9 and an owned mock backend that
 * enforces the real contract: session tokens work only for their own session and account.
 */
const POSTING = "https://careers.withwaymo.com/jobs/machine-learning-engineer/apply";

async function env(userId: number | null = 7) {
  const tls = await employerTls();
  const api = await startDirectApi();
  const b = await launchSignedIn({ api, tls, userId });
  return { tls, api, ...b, async close() { await b.close(); tls.server.close(); await api.close(); } };
}
type Env = Awaited<ReturnType<typeof env>>;

const readAuth = (worker: import("@playwright/test").Worker, expire = false) => worker.evaluate((expireNow) => new Promise<unknown>((resolve, reject) => {
  const open = indexedDB.open("xpertapply-extension-auth", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const store = open.result.transaction("kv", "readwrite").objectStore("kv");
    const get = store.get("xaExtensionAuthV1");
    get.onsuccess = () => {
      const value = get.result ?? null;
      if (expireNow && value) store.put({ ...value, expiresAt: Date.now() - 1 }, "xaExtensionAuthV1");
      resolve(value);
    };
  };
}), expire);

async function open(e: Env, user: number) {
  const p = await e.ctx.newPage();
  p.on("dialog", d => void d.accept().catch(() => undefined));   // the page may already have dismissed it (reload); accepting a gone dialog is not a product failure
  await p.goto(POSTING);
  await p.click("#apply-now");
  await expect.poll(() => p.inputValue("#first_name"), { timeout: 45_000 }).toBe(PROFILES[user].first_name);
  return p;
}
const values = (p: Page) => p.evaluate(() => [...document.querySelectorAll("input,textarea,select")].map(el => (el as HTMLInputElement).value).filter(Boolean));
/** Every request that carries a credential of `user`, after position `from` of the API log. */
const carrying = (e: Env, user: number, from: number) => e.api.log.slice(from).filter(l => new RegExp(`^Bearer (acc|ref|sess)-${user}\\b`).test(l.auth));

test("1. disconnect ends the account's draft: nothing of it is fetched, shown or reused, and the next account starts clean", async () => {
  test.setTimeout(240_000);
  const e = await env(7);
  try {
    const p = await open(e, 7);
    await overlayCdp(p).clickSynthetic("#disconnect");
    await expect.poll(() => readAuth(e.worker), { timeout: 20_000 }).toBeNull();
    const mark = e.api.log.length;
    await p.reload();
    await p.click("#apply-now");
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 40_000 });
    await expect.poll(async () => (await overlayCdp(p).text("#account")) ?? "").toMatch(/Not connected/);
    expect(await values(p)).toEqual([]);                                  // nothing of account 7 reappears
    expect(carrying(e, 7, mark)).toEqual([]);                             // and no request is made as account 7
    // Account 9 connects on the same tab: a fresh draft, 9's data only.
    await e.signIn(9);
    await p.reload();
    await p.click("#apply-now");
    await expect.poll(() => p.inputValue("#first_name"), { timeout: 45_000 }).toBe(PROFILES[9].first_name);
    expect(await values(p)).not.toContain(PROFILES[7].email);
    expect(carrying(e, 7, mark)).toEqual([]);
    const owners = [...e.api.sessions.values()].map(s => s.userId).sort();
    expect(owners).toEqual([7, 9]);
    expect(await submitsUntouched(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await e.close(); }
});

test("2. the account changes while the worker is stopped: the old draft is dropped, never resumed, and the new account gets its own", async () => {
  test.setTimeout(240_000);
  const e = await env(7);
  try {
    const p = await open(e, 7);
    const oldDraft = [...e.api.sessions.keys()][0];
    const cdp = await e.ctx.newCDPSession(p);
    const scopes: string[] = [];
    cdp.on("ServiceWorker.workerRegistrationUpdated", (ev) => { for (const r of ev.registrations) scopes.push(r.scopeURL); });
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    // Root cause of the historical hang: `e.signIn` used the ORIGINAL worker handle. After stopAllWorkers that handle never resolves
    // and never rejects, so `.catch` never ran and the test sat until its timeout. Start the worker again and write through the NEW handle.
    const extScope = scopes.find((u) => u.startsWith("chrome-extension://"));
    expect(extScope, "the extension's service worker registration").toBeTruthy();
    // Wake the worker by opening one of the extension's own pages, then write through whichever handle answers.
    const nudge = await e.ctx.newPage();
    await nudge.goto(`${extScope!}access.html`);
    let worker = e.ctx.serviceWorkers().at(-1);
    await expect.poll(async () => {
      worker = e.ctx.serviceWorkers().at(-1);
      if (!worker) return false;
      return Promise.race([worker.evaluate(() => true).catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
    }, { timeout: 30_000 }).toBe(true);
    await nudge.close();
    await e.signIn(9, worker!);
    const mark = e.api.log.length;
    await p.reload();
    await p.click("#apply-now");
    await expect.poll(() => p.inputValue("#first_name"), { timeout: 60_000 }).toBe(PROFILES[9].first_name);
    expect(carrying(e, 7, mark)).toEqual([]);
    expect(e.api.log.slice(mark).some(l => l.path.startsWith(`/application-sessions/${oldDraft}`))).toBe(false);
    expect(await overlayCount(p)).toBe(1);
  } finally { await e.close(); }
});

test("3. the account changes under an open assistant: Fill neither reuses the old draft nor writes the old account's data", async () => {
  test.setTimeout(240_000);
  const e = await env(7);
  try {
    const p = await open(e, 7);
    await e.signIn(9);                                                    // credential replaced; the page and its assistant are untouched
    await p.evaluate(() => document.querySelectorAll("input,textarea").forEach(el => { (el as HTMLInputElement).value = ""; }));
    const mark = e.api.log.length;
    await overlayCdp(p).clickSynthetic("#fill").catch(() => undefined);
    await p.waitForTimeout(6000);
    expect(await p.inputValue("#email")).not.toBe(PROFILES[7].email);
    expect(await p.inputValue("#first_name")).not.toBe(PROFILES[7].first_name);
    expect(carrying(e, 7, mark).filter(l => l.auth.startsWith("Bearer sess-"))).toEqual([]);   // account 7's session credential is never used again
  } finally { await e.close(); }
});

test("4. an expired access token is renewed once from the refresh credential; the draft belongs to the same account", async () => {
  test.setTimeout(180_000);
  const e = await env(7);
  try {
    await readAuth(e.worker, true);
    const p = await open(e, 7);
    expect(e.api.log.filter(l => l.path === "/extension/auth/token")).toHaveLength(1);
    expect([...e.api.sessions.values()].map(s => s.userId)).toEqual([7]);
    expect(directDrafts(e.api)).toHaveLength(1);
    void p;
  } finally { await e.close(); }
});

test("5. an employer page cannot impersonate the extension, an account or a website launch", async () => {
  test.setTimeout(180_000);
  const e = await env(7);
  try {
    const p = await open(e, 7);
    const drafts = directDrafts(e.api).length;
    const sessions = e.api.sessions.size;
    const before = await e.worker.evaluate(async () => JSON.stringify(Object.keys(await chrome.storage.session.get(null)).sort()));
    await p.evaluate(() => {
      const types = ["JOBPILOT_LAUNCH_REQUEST", "JOBPILOT_STAGE_LAUNCH", "JOBPILOT_RUNTIME_IDENTITY", "JOBPILOT_CONTENT_READY", "XPERTAPPLY_DIRECT_AUTH_STATE",
        "XPERTAPPLY_DIRECT_DISCONNECT", "XPERTAPPLY_OVERLAY_DISCONNECT", "JOBPILOT_USER_CONFIRMED_SUBMITTED"];
      for (const type of types) {
        window.postMessage({ type, payload: { sessionId: 1, officialUrl: "https://evil.test/apply", webAuthenticatedUserId: 9, webEnvironment: "production", userId: 9, accessToken: "acc-9" } }, "*");
        window.dispatchEvent(new CustomEvent(type, { detail: { userId: 9 } }));
        document.dispatchEvent(new MessageEvent("message", { data: { type, userId: 9 }, origin: "https://staging.xpertapply.com" }));
      }
      (window as any).chrome?.runtime?.sendMessage?.({ type: "JOBPILOT_STAGE_LAUNCH" });
    });
    await p.waitForTimeout(4000);
    expect(directDrafts(e.api)).toHaveLength(drafts);
    expect(e.api.sessions.size).toBe(sessions);
    expect(e.api.log.some(l => l.auth.includes("acc-9") || l.auth.includes("sess-9"))).toBe(false);
    expect((await readAuth(e.worker) as { userId: number } | null)?.userId).toBe(7);
    expect(await e.worker.evaluate(async () => JSON.stringify(Object.keys(await chrome.storage.session.get(null)).sort()))).toBe(before);
    expect((await e.worker.evaluate(async () => (await chrome.storage.local.get("jobpilotWebRuntimeV2")).jobpilotWebRuntimeV2 ?? null))).toBeNull();
    expect(await overlayCount(p)).toBe(1);
    expect(await overlayCdp(p).text("#account")).toMatch(new RegExp(PROFILES[7].email));
    expect(await submitsUntouched(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await e.close(); }
});
