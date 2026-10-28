/* AUDIT ARTIFACT — temporary. Error handling + widget UI states. */
import { chromium, test as base, type BrowserContext, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedHandoff, PROFILE_ANSWERS } from "./zz-audit-harness";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const OUT = process.env.AUDIT_OUT || "/tmp";

const PAGE = `<!doctype html><meta charset="utf-8"><title>AuditCo</title>
<h1>Apply for Staff Engineer</h1><h2>Personal information</h2>
<form id="application-form">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <button type="submit" id="final-submit">Submit application</button>
</form>`;

type F = { context: BrowserContext; worker: Worker; origin: string };
const test = base.extend<F>({
  origin: async ({}, use) => {
    const sockets = new Set<import("node:net").Socket>();
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    });
    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(0, "localhost", r));
    const port = (server.address() as { port: number }).port;
    await use(`http://localhost:${port}`);
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  },
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      serviceWorkers: "allow"
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 })));
  }
});

test.setTimeout(180_000);
test.describe.configure({ mode: "serial" });

async function widgetShot(page: import("@playwright/test").Page, name: string) {
  const host = page.locator("#jobpilot-assisted-apply");
  if (await host.count()) {
    await host.screenshot({ path: `${OUT}/widget-${name}.png` }).catch(() => undefined);
    console.log(`AUDIT-SHOT ${name} -> ${OUT}/widget-${name}.png`);
  } else {
    console.log(`AUDIT-SHOT ${name}: no widget host present`);
  }
}

test("AUDIT-11 API 401 on the session package", async ({ context, worker, origin }) => {
  await context.route("**/application-sessions/token", (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"expired"}' }));
  await seedHandoff(worker, origin);
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForTimeout(15_000);
  await widgetShot(page, "401");
  await page.close();
});

test("AUDIT-12 API 500 on the answers endpoint", async ({ context, worker, origin }) => {
  const sessionBody = { session_id: 55, ats_type: null, official_application_url: origin, job: { title: "T", company: "C" }, resume: { status: "ready", document_id: 1, download_url: null }, cover_letter: { status: "missing", document_id: null, download_url: null }, profile: {} };
  await context.route("**/application-sessions/token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: "t", session: sessionBody }) }));
  await context.route("**/application-sessions/*/answers", (r) => r.fulfill({ status: 500, contentType: "text/html", body: "<html>oops</html>" }));
  await context.route("**/application-sessions/*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) }));
  await seedHandoff(worker, origin);
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForTimeout(15_000);
  await widgetShot(page, "500");
  await page.close();
});

test("AUDIT-13 malformed JSON from the session endpoint", async ({ context, worker, origin }) => {
  await context.route("**/application-sessions/token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{not json" }));
  await seedHandoff(worker, origin);
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForTimeout(15_000);
  await widgetShot(page, "malformed");
  await page.close();
});

test("AUDIT-14 happy path widget + service-worker restart", async ({ context, worker, origin }) => {
  const sessionBody = { session_id: 55, ats_type: null, official_application_url: origin, job: { title: "Staff Engineer", company: "AuditCo" }, resume: { status: "ready", document_id: 1, download_url: null }, cover_letter: { status: "ready", document_id: 2, download_url: null }, profile: { email: "aisha.audit@example.test" } };
  await context.route("**/application-sessions/token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: "t", session: sessionBody }) }));
  await context.route("**/application-sessions/*/answers", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers: PROFILE_ANSWERS, unresolved_questions: [], profile_revision: "r1" }) }));
  await context.route("**/application-sessions/*/resolve-questions", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ request_schema_version: 2, registry_version: "a", answer_contract_version: 1, results: [] }) }));
  await context.route("**/application-sessions/*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) }));
  await seedHandoff(worker, origin);
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForTimeout(18_000);
  await widgetShot(page, "ready");
  const before = await page.evaluate(() => (document.getElementById("first_name") as HTMLInputElement).value);

  // Force a service-worker restart, then ask the extension to work again.
  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable").catch(() => undefined);
  await cdp.send("ServiceWorker.stopAllWorkers").catch(() => undefined);
  await page.waitForTimeout(2000);

  const page2 = await context.newPage();
  await page2.goto(origin);
  await page2.waitForTimeout(18_000);
  const after = await page2.evaluate(() => (document.getElementById("first_name") as HTMLInputElement).value);
  await widgetShot(page2, "after-sw-restart");
  console.log(`AUDIT-14 beforeRestart="${before}" afterRestart="${after}"`);
  await page.close();
  await page2.close();
});
