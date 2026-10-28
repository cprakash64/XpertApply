/* AUDIT ARTIFACT — temporary. Control: same page WITHOUT the extension loaded. */
import { test as base, chromium, expect } from "@playwright/test";
import { createServer } from "node:http";

function bigForm(n: number): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(`<div class="fg"><label for="f${i}">Question ${i} about your experience</label><input id="f${i}" name="q_${i}" required></div>`);
  }
  return `<!doctype html><meta charset="utf-8"><title>AuditCo Big</title>
<h1>Apply</h1><h2>Personal information</h2>
<form id="application-form">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  ${rows.join("")}
  <button type="submit" id="final-submit">Submit application</button>
</form>`;
}

base.setTimeout(300_000);

base("AUDIT-9 control: big forms with NO extension", async () => {
  const pages = new Map([[100, bigForm(100)], [1000, bigForm(1000)], [5000, bigForm(5000)]]);
  const server = createServer((req, res) => {
    const n = Number((req.url || "").replace("/big", "").split("?")[0]);
    const body = pages.get(n);
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  const port = (server.address() as { port: number }).port;
  const context = await chromium.launchPersistentContext("", { channel: "chromium" });
  for (const n of [100, 1000, 5000]) {
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(`http://localhost:${port}/big${n}`);
    await page.waitForSelector("#application-form", { timeout: 120_000 });
    console.log(`AUDIT-9 CONTROL n=${n} pageLoadMs=${Date.now() - t0}`);
    await page.close();
  }
  await context.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  expect(true).toBe(true);
});
