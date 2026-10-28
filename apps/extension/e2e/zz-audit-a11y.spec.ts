/* AUDIT ARTIFACT — temporary. Widget accessibility. */
import { chromium, test as base, type BrowserContext, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedHandoff, PROFILE_ANSWERS } from "./zz-audit-harness";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");

const PAGE = `<!doctype html><meta charset="utf-8"><title>AuditCo</title>
<h1>Apply</h1><h2>Personal information</h2>
<form id="application-form">
  <label for="first_name">First name</label><input id="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" required>
  <label for="email">Email</label><input id="email" type="email" required>
  <fieldset><legend>What is your gender?</legend>
    <label><input type="radio" name="g" value="Male" required> Male</label>
    <label><input type="radio" name="g" value="Female"> Female</label>
    <label><input type="radio" name="g" value="Decline to self identify"> Decline to self identify</label>
  </fieldset>
  <button type="submit" id="final-submit">Submit application</button>
</form>`;

type F = { context: BrowserContext; worker: Worker; origin: string };
const test = base.extend<F>({
  origin: async ({}, use) => {
    const sockets = new Set<import("node:net").Socket>();
    const server: Server = createServer((_q, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE));
    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(0, "localhost", r));
    await use(`http://localhost:${(server.address() as { port: number }).port}`);
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  },
  context: async ({}, use) => {
    const c = await chromium.launchPersistentContext("", { channel: "chromium", args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`], serviceWorkers: "allow" });
    await use(c); await c.close();
  },
  worker: async ({ context }, use) => { await use(context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }))); }
});

test.setTimeout(150_000);

test("AUDIT-15 widget accessibility", async ({ context, worker, origin }) => {
  const sessionBody = { session_id: 55, ats_type: null, official_application_url: origin, job: { title: "Staff Engineer", company: "AuditCo" }, resume: { status: "missing", document_id: null, download_url: null }, cover_letter: { status: "missing", document_id: null, download_url: null }, profile: {} };
  await context.route("**/application-sessions/token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: "t", session: sessionBody }) }));
  await context.route("**/application-sessions/*/answers", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers: PROFILE_ANSWERS, unresolved_questions: [], profile_revision: "r1" }) }));
  await context.route("**/application-sessions/*/resolve-questions", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ request_schema_version: 2, registry_version: "a", answer_contract_version: 1, results: [] }) }));
  await context.route("**/application-sessions/*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) }));
  await seedHandoff(worker, origin);

  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForTimeout(20_000);

  const cdp = await context.newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const tree = await cdp.send("Accessibility.getFullAXTree") as any;
  const widgetNodes = tree.nodes
    .filter((n: any) => n.role?.value && ["button", "checkbox", "textbox", "combobox", "heading", "link"].includes(n.role.value))
    .map((n: any) => ({ role: n.role.value, name: n.name?.value ?? "", focusable: (n.properties ?? []).some((p: any) => p.name === "focusable" && p.value.value) }));
  console.log("AUDIT-15 AX_CONTROLS " + JSON.stringify(widgetNodes, null, 1));

  // Keyboard: can a keyboard user reach the widget's controls at all?
  const order: string[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const info = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }).then(async () => {
      const r = await cdp.send("Runtime.evaluate", { expression: "(()=>{const a=document.activeElement; return a? (a.id||a.tagName)+':'+(a.getAttribute('aria-label')||a.textContent||'').trim().slice(0,30):'none'})()", returnByValue: true }) as any;
      return r.result?.value as string;
    });
    order.push(info);
  }
  console.log("AUDIT-15 TAB_ORDER " + JSON.stringify(order));
  // Sensitive control: was gender touched?
  const gender = await page.evaluate(() => document.querySelector<HTMLInputElement>('input[name="g"]:checked')?.value ?? "(blank)");
  console.log("AUDIT-15 GENDER " + gender);
  await cdp.detach().catch(() => undefined);
  await page.close().catch(() => undefined);
});
