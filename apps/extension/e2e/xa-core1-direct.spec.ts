import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { overlayCdp } from "./overlay-cdp";
import { LEVER_UUID, PROFILES, UNGRANTED_HOST, directDrafts, employerTls, launchSignedIn, overlayCount, startDirectApi, submitsUntouched } from "./xa-core1-harness";

/**
 * XA-CORE1 acceptance: an application opened DIRECTLY on an employer origin the user already
 * granted. No xpertapply.com launch, no website-created session, no toolbar click, no second window.
 *
 * Every test starts a fresh Chromium profile with the real unpacked extension, a signed-in
 * extension credential, and owned loopback employer + XpertApply servers. Nothing is submitted.
 */
async function env(opts: { userId?: number | null; profileDir?: string } = {}) {
  const tls = await employerTls();
  const api = await startDirectApi();
  const browser = await launchSignedIn({ api, tls, ...opts });
  return {
    tls, api, ...browser,
    async close() { await browser.close(); tls.server.close(); await api.close(); }
  };
}

/** Read (or expire) the credential in the extension's own IndexedDB, exactly where the worker keeps it. */
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

const widgetsOpen = (e: Awaited<ReturnType<typeof env>>) =>
  e.worker.evaluate(async () => (await chrome.windows.getAll({ populate: true })).flatMap(w => (w.tabs ?? []).map(t => t.url ?? "")).filter(u => u.startsWith("chrome-extension://") && !u.includes("/access.html?welcome=1")));

async function expectWaymoFilled(p: Page, user = 7) {
  const want = PROFILES[user];
  await expect.poll(() => p.inputValue("#first_name"), { timeout: 45_000 }).toBe(want.first_name);
  await expect.poll(() => p.inputValue("#email"), { timeout: 15_000 }).toBe(want.email);
  expect(await p.inputValue("#last_name")).toBe(want.last_name);
  expect(await p.inputValue("#phone")).toBe(want.phone);
  expect(await p.inputValue("#linkedin")).toBe(want.linkedin_url);
  expect(await p.inputValue("#website")).toBe(want.portfolio_url);
  // Sensitive and open-ended questions are never inferred.
  for (const sel of ["#auth", "#spons", "#gender", "#why"]) expect(await p.inputValue(sel), sel).toBe("");
  expect(await submitsUntouched(p)).toEqual({ submits: 0, clicks: 0 });
}

test("A. Waymo-shaped custom careers domain, opened directly: one assistant, one independent draft, verified fields filled", async () => {
  test.setTimeout(180_000);
  const e = await env();
  try {
    const p = await e.ctx.newPage();
    await p.goto("https://careers.withwaymo.com/jobs/machine-learning-engineer?gh_src=tracking123#overview");
    // A description with no form yet: nothing is created, nothing opens.
    await p.waitForTimeout(3500);
    expect(directDrafts(e.api)).toHaveLength(0);
    expect(await overlayCount(p)).toBe(0);

    // "Apply Now" renders the form with no navigation; it is recognised without any user action on XpertApply.
    await p.click("#apply-now");
    await expect(p.locator("#first_name")).toBeVisible({ timeout: 10_000 });
    await expectWaymoFilled(p);

    expect(directDrafts(e.api)).toHaveLength(1);
    expect(e.api.log.some(l => l.path === "/application-sessions/token")).toBe(false);   // no website launch token anywhere
    expect(e.api.sessions.size).toBe(1);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    expect(await widgetsOpen(e)).toEqual([]);                                             // no extension window or page
    const ov = overlayCdp(p);
    await expect.poll(async () => Number(await ov.text("#discovered")), { timeout: 30_000 }).toBeGreaterThanOrEqual(5);

    // Reload: same posting resumes the same draft; still exactly one assistant.
    await p.reload();
    await p.click("#apply-now");
    await expect.poll(() => p.inputValue("#first_name"), { timeout: 45_000 }).toBe("Riley");
    expect(e.api.sessions.size).toBe(1);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
  } finally { await e.close(); }
});

test("A2. Pages on a granted origin that are not applications never open a draft or an assistant", async () => {
  test.setTimeout(120_000);
  const e = await env();
  try {
    for (const route of ["/newsletter", "/login", "/search", "/"]) {
      const p = await e.ctx.newPage();
      await p.goto(`https://careers.withwaymo.com${route}`);
      await p.waitForTimeout(3000);
      expect(await overlayCount(p), route).toBe(0);
      await p.close();
    }
    expect(directDrafts(e.api)).toHaveLength(0);
  } finally { await e.close(); }
});

test("B. Greenhouse, opened directly", async () => {
  test.setTimeout(150_000);
  const e = await env();
  try {
    const p = await e.ctx.newPage();
    await p.goto("https://job-boards.greenhouse.io/acme/jobs/4012345");
    await expect.poll(() => p.inputValue("#first_name"), { timeout: 45_000 }).toBe("Riley");
    expect(await p.inputValue("#last_name")).toBe("Candidate");
    expect(await p.inputValue("#email")).toBe("riley@example.test");
    expect(await p.inputValue("#phone")).toBe("+16025550199");
    expect(directDrafts(e.api)).toHaveLength(1);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    expect(await submitsUntouched(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await e.close(); }
});

test("C. Lever, opened directly", async () => {
  test.setTimeout(150_000);
  const e = await env();
  try {
    const p = await e.ctx.newPage();
    await p.goto(`https://jobs.lever.co/zoox/${LEVER_UUID}/apply`);
    await expect.poll(() => p.inputValue('[name="email"]'), { timeout: 45_000 }).toBe("riley@example.test");
    expect(await p.inputValue('[name="name"]')).toBe("Riley Candidate");
    expect(directDrafts(e.api)).toHaveLength(1);
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    expect(await submitsUntouched(p)).toEqual({ submits: 0, clicks: 0 });
  } finally { await e.close(); }
});

test("E. A stale website launch for a DIFFERENT application no longer blocks a direct application (the Waymo failure)", async () => {
  test.setTimeout(150_000);
  const e = await env();
  try {
    await e.worker.evaluate(async () => {
      const now = Date.now(); const u = "https://job-boards.greenhouse.io/acme/jobs/999";
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: { version: 1, applicationId: "stale", jobId: "1", applicationUrl: u, status: "prepared", handoffToken: "h", requestId: "stale", sessionId: 55, launchToken: "l", officialUrl: u, expectedOrigin: new URL(u).origin, createdAt: now, expiresAt: now + 900000, state: "waiting_for_content_script", protocolVersion: 3, atsType: null } });
    });
    const p = await e.ctx.newPage();
    await p.goto("https://careers.withwaymo.com/jobs/machine-learning-engineer/apply");
    await p.click("#apply-now");
    await expectWaymoFilled(p);
    expect(await overlayCdp(p).text("#errors") ?? "").not.toMatch(/doesn.t match the prepared application/i);
    // The stale website launch is untouched and was never used.
    expect(e.api.log.some(l => l.path === "/application-sessions/token" || l.path === "/application-sessions/55")).toBe(false);
  } finally { await e.close(); }
});

test("F. A site without a grant is never read: no draft, no assistant, no network", async () => {
  test.setTimeout(90_000);
  const e = await env();
  try {
    const p = await e.ctx.newPage();
    await p.goto(`https://${UNGRANTED_HOST}/jobs/machine-learning-engineer`);   // served, but not granted
    await p.waitForTimeout(3500);
    expect(await p.locator("#apply-now").count()).toBe(1);
    await p.click("#apply-now");
    await p.waitForTimeout(3000);
    expect(await overlayCount(p)).toBe(0);
    expect(await p.inputValue("#first_name")).toBe("");
    expect(directDrafts(e.api)).toHaveLength(0);
    expect(await e.worker.evaluate(async h => chrome.permissions.contains({ origins: [`https://${h}/*`] }), UNGRANTED_HOST)).toBe(false);
  } finally { await e.close(); }
});

test("G1. Signed out: the assistant says to connect and nothing is created or filled", async () => {
  test.setTimeout(120_000);
  const e = await env({ userId: null });
  try {
    const p = await e.ctx.newPage();
    await p.goto("https://careers.withwaymo.com/jobs/machine-learning-engineer");
    await p.click("#apply-now");
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 30_000 });
    const ov = overlayCdp(p);
    await expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 20_000 }).toMatch(/connect/i);
    expect(directDrafts(e.api)).toHaveLength(0);
    expect(await p.inputValue("#first_name")).toBe("");
  } finally { await e.close(); }
});

test("G2. Revoked credential: refresh is refused, the extension signs itself out, nothing is filled", async () => {
  test.setTimeout(120_000);
  const e = await env();
  try {
    e.api.state.revoked = true;                       // server-side revocation after sign-in
    await readAuth(e.worker, true);                  // access token already stale, so a refresh is attempted
    const p = await e.ctx.newPage();
    await p.goto("https://careers.withwaymo.com/jobs/machine-learning-engineer");
    await p.click("#apply-now");
    await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 30_000 });
    expect(await p.inputValue("#first_name")).toBe("");
    expect(directDrafts(e.api)).toHaveLength(0);
    await expect.poll(() => readAuth(e.worker)).toBeNull();
  } finally { await e.close(); }
});

test("G3. Account switch: the previous account's draft and data never reach the new account", async () => {
  test.setTimeout(180_000);
  const e = await env({ userId: 7 });
  try {
    const p = await e.ctx.newPage();
    await p.goto("https://careers.withwaymo.com/jobs/machine-learning-engineer");
    await p.click("#apply-now");
    await expectWaymoFilled(p, 7);
    const firstDraft = [...e.api.sessions.keys()][0];

    await e.signIn(9);                                 // a different account signs the extension in
    const q = await e.ctx.newPage();
    await q.goto("https://careers.withwaymo.com/jobs/machine-learning-engineer");
    await q.click("#apply-now");
    await expectWaymoFilled(q, 9);
    expect(await q.inputValue("#email")).not.toBe(PROFILES[7].email);
    const drafts = [...e.api.sessions.entries()];
    expect(drafts).toHaveLength(2);
    expect(drafts.find(([id]) => id !== firstDraft)?.[1].userId).toBe(9);
    // No request made as account 9 ever carried account 7's session credential, and vice versa.
    for (const entry of e.api.log) {
      const sess = /^Bearer sess-(\d+)-(\d+)$/.exec(entry.auth);
      if (sess) expect(e.api.sessions.get(Number(sess[2]))?.userId).toBe(Number(sess[1]));
    }
  } finally { await e.close(); }
});

test("H. Persistence: the credential survives a Chrome restart and the direct flow still works", async () => {
  test.setTimeout(240_000);
  const profileDir = mkdtempSync(path.join(tmpdir(), "xa-core1-profile-"));
  let e = await env({ profileDir });
  try {
    await e.close();
    // Restart: same profile, the credential is NOT re-seeded.
    const tls = await employerTls(); const api = await startDirectApi();
    const { launchSignedIn } = await import("./xa-core1-harness");
    const b = await launchSignedIn({ api, tls, userId: null, profileDir });
    try {
      // apiBase is a stored setting that points at a port that no longer exists: repoint it, nothing else.
      await b.worker.evaluate(async origin => chrome.storage.local.set({ apiBase: origin }), api.origin);
      expect((await readAuth(b.worker) as { userId: number } | null)?.userId).toBe(7);
      const p = await b.ctx.newPage();
      await p.goto("https://careers.withwaymo.com/jobs/machine-learning-engineer");
      await p.click("#apply-now");
      await expectWaymoFilled(p);
    } finally { await b.close(); tls.server.close(); await api.close(); }
  } finally { await e.close().catch(() => undefined); }
});

for (const [name, url] of [
  ["Ashby", `https://jobs.ashbyhq.com/acme/${LEVER_UUID}/application`],
  ["Workday", "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Remote/Engineer_R1/apply"]
] as const) {
  test(`D. ${name} (simple fixture form), opened directly: independent draft and fill`, async () => {
    test.setTimeout(150_000);
    const e = await env();
    try {
      const p = await e.ctx.newPage();
      await p.goto(url);
      await expect.poll(() => p.inputValue("#first_name"), { timeout: 45_000 }).toBe("Riley");
      expect(await p.inputValue("#email")).toBe("riley@example.test");
      expect(directDrafts(e.api)).toHaveLength(1);
      await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
      expect(await submitsUntouched(p)).toEqual({ submits: 0, clicks: 0 });
    } finally { await e.close(); }
  });
}
