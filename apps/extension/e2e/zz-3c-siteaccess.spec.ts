/* STAGE 3C VERIFICATION ARTIFACT — temporary. Not production code.
 *
 * Real Chromium, real cross-origin HTTPS (hostnames mapped to loopback, so
 * nothing leaves the machine and no employer is contacted). No form submitted.
 *
 * Two extension builds are used, and the difference between them is the point:
 *
 *   dist/          the SHIPPED manifest. No employer-site authority at all.
 *                  Every "must not" assertion runs against this.
 *
 *   dist-granted/  dist plus ONE origin added to host_permissions, which is
 *                  exactly the state Chrome is in after a user grants that
 *                  origin. Used for the "must still work" assertions, because
 *                  Playwright cannot click Chrome's native permission dialog
 *                  (verified: the request from an extension page never
 *                  resolves under automation, and the service worker throws
 *                  "must be called during a user gesture").
 */
import { chromium, test as base, expect, type BrowserContext, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:https";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedHandoff, PROFILE_ANSWERS } from "./zz-audit-harness";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const CERTS = "/private/tmp/claude-501/-Users-cprakash-Documents-Jobs-XpertApply/449891c0-0782-4c8f-84fa-f25a9ad50a94/scratchpad/stage3a";
const PORT = 8443;

const EMPLOYER = `https://careers.mongodb.com:${PORT}`;
const ATS = `https://boards.greenhouse.io:${PORT}`;
const THIRD_PARTY = `https://ads.doubleclick.net:${PORT}`;
const UNRELATED = `https://news.example.test:${PORT}`;
const ELSEWHERE = `https://login.other-idp.test:${PORT}`;

/** dist + the named origins pre-granted: the post-grant state, nothing else. */
function grantedBuild(origins: string[], tag: string): string {
  const out = path.resolve(here, "..", `dist-granted-${tag}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(DIST, out, { recursive: true });
  const manifestPath = path.join(out, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [...manifest.host_permissions, ...origins];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return out;
}

const APPLICATION_FORM = `<!doctype html><meta charset="utf-8"><title>Apply</title>
<h1>Apply for this job</h1><h2>Personal information</h2>
<form id="application-form" action="/submit" method="post">
  <label for="v_first">First name</label><input id="v_first" name="first_name" required>
  <label for="v_last">Last name</label><input id="v_last" name="last_name" required value="TYPED-BY-USER">
  <label for="v_email">Email</label><input id="v_email" name="email" type="email" required>
  <label for="v_phone">Phone</label><input id="v_phone" name="phone" required>
  <label for="v_resume">Resume/CV</label><input type="file" id="v_resume" name="resume">
  <button type="submit" id="submit">Submit application</button>
</form>`;

const CARRIER_WITH_FRAMES = `<!doctype html><meta charset="utf-8"><title>MongoDB Careers</title>
<h1>Software Engineer</h1><p>Apply below.</p>
<iframe id="ats" src="${ATS}/embed"></iframe>
<iframe id="ad" src="${THIRD_PARTY}/embed"></iframe>`;

const PLAIN_PAGE = `<!doctype html><meta charset="utf-8"><title>Unrelated news</title>
<h1>Today's headlines</h1><form><label for="e">Email</label><input id="e" name="email"></form>`;

type F = { server: Server; makeContext: (extDir: string) => Promise<{ ctx: BrowserContext; worker: Worker }> };

const test = base.extend<F>({
  server: async ({}, use) => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer(
      { key: readFileSync(path.join(CERTS, "key.pem")), cert: readFileSync(path.join(CERTS, "cert.pem")) },
      (req, res) => {
        const host = (req.headers.host ?? "").split(":")[0];
        const url = (req.url || "/").split("?")[0];
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (host === "news.example.test") return void res.end(PLAIN_PAGE);
        if (url.startsWith("/embed")) return void res.end(APPLICATION_FORM);
        if (url.startsWith("/frames")) return void res.end(CARRIER_WITH_FRAMES);
        res.end(APPLICATION_FORM);
      }
    );
    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    await use(server);
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  },
  makeContext: async ({}, use) => {
    const opened: BrowserContext[] = [];
    await use(async (extDir: string) => {
      const ctx = await chromium.launchPersistentContext("", {
        channel: "chromium", ignoreHTTPSErrors: true,
        args: [
          `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--ignore-certificate-errors",
          "--host-resolver-rules=MAP careers.mongodb.com 127.0.0.1, MAP boards.greenhouse.io 127.0.0.1," +
          " MAP ads.doubleclick.net 127.0.0.1, MAP news.example.test 127.0.0.1, MAP login.other-idp.test 127.0.0.1"
        ],
        serviceWorkers: "allow"
      });
      opened.push(ctx);
      const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20_000 }));
      return { ctx, worker };
    });
    for (const ctx of opened) await ctx.close().catch(() => undefined);
    for (const tag of ["employer", "ats", "elsewhere"]) {
      rmSync(path.resolve(here, "..", `dist-granted-${tag}`), { recursive: true, force: true });
    }
  }
});

test.setTimeout(240_000);

async function stub(ctx: BrowserContext, applicationUrl: string): Promise<void> {
  const sessionBody = {
    session_id: 55, authenticated_user_id: 900, ats_type: null,
    official_application_url: applicationUrl,
    job: { title: "Software Engineer", company: "MongoDB", location: "San Francisco, CA" },
    resume: { status: "ready", document_id: 1, download_url: null },
    cover_letter: { status: "missing", document_id: null, download_url: null },
    profile: { email: "aisha.audit@example.test" }
  };
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await ctx.route("**/application-sessions/token", (r) => r.fulfill(json({ session_token: "t", session: sessionBody })));
  await ctx.route("**/application-sessions/*/answers", (r) => r.fulfill(json({ answers: PROFILE_ANSWERS, unresolved_questions: [], profile_revision: "r1" })));
  await ctx.route("**/application-sessions/*/resolve-questions", (r) => r.fulfill(json({ request_schema_version: 3, registry_version: "a", answer_contract_version: 3, results: [] })));
  await ctx.route("**/application-sessions/*/resume*", (r) => r.fulfill({
    status: 200,
    headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Aisha_Okonkwo_Resume.pdf"' },
    body: Buffer.from("%PDF-1.4\n%%EOF")
  }));
  await ctx.route("**/application-sessions/*", (r) => r.fulfill(json(sessionBody)));
}

const readForm = (frame: { evaluate: <T>(fn: () => T) => Promise<T> }) => frame.evaluate(() => ({
  first: (document.getElementById("v_first") as HTMLInputElement)?.value ?? "(missing)",
  last: (document.getElementById("v_last") as HTMLInputElement)?.value ?? "(missing)",
  email: (document.getElementById("v_email") as HTMLInputElement)?.value ?? "(missing)",
  resume: Array.from((document.getElementById("v_resume") as HTMLInputElement)?.files ?? []).map((f) => f.name).join(",") || "(none)",
  scripted: Boolean((window as unknown as Record<string, unknown>).__jobpilotContentInstance),
  submitted: String((window as unknown as { __submitted?: boolean }).__submitted ?? false)
}));

// --------------------------------------------------------------------------- //

test("1/2 · fresh install holds no employer-site authority, and unrelated sites are not scripted", async ({ server, makeContext }) => {
  void server;
  const { ctx, worker } = await makeContext(DIST);
  const perms = await worker.evaluate(async () => chrome.permissions.getAll());
  const origins: string[] = (perms as { origins: string[] }).origins;
  console.log("3C INSTALL_ORIGINS " + JSON.stringify(origins));
  for (const origin of origins) {
    expect(origin, origin).toMatch(/xpertapply\.com|jobpilot\.ai|ezjobfind\.com|127\.0\.0\.1:3000|localhost:3000/);
  }

  const page = await ctx.newPage();
  await page.goto(`${UNRELATED}/`);
  await page.waitForTimeout(3000);
  const scripted = await page.evaluate(() =>
    Boolean((window as unknown as Record<string, unknown>).__jobpilotContentInstance));
  console.log("3C UNRELATED_SCRIPTED " + scripted);
  expect(scripted).toBe(false);
});

test("3/4 · an authorized workflow on an ungranted origin does not fill, and says why", async ({ server, makeContext }) => {
  void server;
  const { ctx, worker } = await makeContext(DIST);
  const applicationUrl = `${EMPLOYER}/apply`;
  await stub(ctx, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await ctx.newPage();
  await page.goto(applicationUrl);
  await page.waitForTimeout(15_000);

  const state = await readForm(page);
  console.log("3C UNGRANTED_WORKFLOW " + JSON.stringify(state));
  expect(state.scripted).toBe(false);
  expect(state.first).toBe("");
  expect(state.email).toBe("");
  expect(state.resume).toBe("(none)");
  expect(state.last).toBe("TYPED-BY-USER");
  expect(state.submitted).toBe("false");

  // The workflow is not silently stalled: the worker recorded what it needs.
  const need = await worker.evaluate(async () => {
    const store = await chrome.storage.local.get("viewStates");
    const views = (store.viewStates ?? {}) as Record<string, {
      siteAccess?: string; siteAccessOrigin?: string; siteAccessPattern?: string;
    }>;
    return Object.values(views).map((v) => ({
      siteAccess: v.siteAccess, origin: v.siteAccessOrigin, pattern: v.siteAccessPattern
    }));
  });
  console.log("3C RECORDED_NEED " + JSON.stringify(need));
  expect(need.some((n) => n.siteAccess === "site_access_required"
    && n.origin === `careers.mongodb.com:${PORT}`
    && n.pattern === "https://careers.mongodb.com/*")).toBe(true);
});

test("5/6/13/14 · once the origin is granted the application fills, resume included", async ({ server, makeContext }) => {
  void server;
  const { ctx, worker } = await makeContext(grantedBuild(["https://careers.mongodb.com/*"], "employer"));
  const applicationUrl = `${EMPLOYER}/apply`;
  await stub(ctx, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await ctx.newPage();
  await page.goto(applicationUrl);
  await page.waitForTimeout(25_000);

  const state = await readForm(page);
  console.log("3C GRANTED_WORKFLOW " + JSON.stringify(state));
  expect(state.scripted).toBe(true);
  expect(state.first).toBe("Aisha");
  expect(state.email).toBe("aisha.audit@example.test");
  expect(state.resume).toBe("Aisha_Okonkwo_Resume.pdf");
  expect(state.last).toBe("TYPED-BY-USER");   // pre-typed value preserved
  expect(state.submitted).toBe("false");      // nothing submitted
});

test("7 · a cross-origin hop does not inherit the granted origin", async ({ server, makeContext }) => {
  void server;
  const { ctx, worker } = await makeContext(grantedBuild(["https://careers.mongodb.com/*"], "elsewhere"));
  const applicationUrl = `${EMPLOYER}/apply`;
  await stub(ctx, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await ctx.newPage();
  await page.goto(applicationUrl);
  await page.waitForTimeout(8000);
  // The workflow navigates on, exactly as an employer→IdP redirect would.
  await page.goto(`${ELSEWHERE}/apply`);
  await page.waitForTimeout(12_000);

  const state = await readForm(page);
  console.log("3C AFTER_CROSS_ORIGIN_HOP " + JSON.stringify(state));
  expect(state.scripted).toBe(false);
  expect(state.first).toBe("");
  expect(state.resume).toBe("(none)");
});

test("8/9 · granting the ATS origin reaches the embedded application and nothing else", async ({ server, makeContext }) => {
  void server;
  const { ctx, worker } = await makeContext(
    grantedBuild(["https://careers.mongodb.com/*", "https://boards.greenhouse.io/*"], "ats")
  );
  const applicationUrl = `${EMPLOYER}/frames`;
  await stub(ctx, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await ctx.newPage();
  await page.goto(applicationUrl);
  await page.waitForTimeout(30_000);

  const atsFrame = page.frames().find((f) => f.url().startsWith(ATS));
  const adFrame = page.frames().find((f) => f.url().startsWith(THIRD_PARTY));
  const ats = atsFrame ? await readForm(atsFrame) : { error: "missing" };
  const ad = adFrame ? await readForm(adFrame) : { error: "missing" };
  console.log("3C ATS_FRAME " + JSON.stringify(ats));
  console.log("3C THIRD_PARTY_FRAME " + JSON.stringify(ad));

  expect(ats).toMatchObject({ first: "Aisha", email: "aisha.audit@example.test", resume: "Aisha_Okonkwo_Resume.pdf" });
  // The unrelated frame's origin was never granted, so Chrome itself keeps the
  // content script out — it is not merely dormant, it is absent.
  expect(ad).toMatchObject({ first: "", email: "", resume: "(none)", scripted: false });
});
