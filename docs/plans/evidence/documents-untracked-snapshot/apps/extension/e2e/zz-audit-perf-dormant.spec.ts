/* AUDIT ARTIFACT — temporary. Cost of the always-injected content script on an UNBOUND page. */
import { test } from "./zz-audit-harness";

test.setTimeout(600_000);

function bigForm(n: number): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(`<div class="fg"><label for="f${i}">Question ${i} first name email phone</label><input id="f${i}" name="q_${i}" required></div>`);
  }
  return `<!doctype html><meta charset="utf-8"><title>Ordinary page</title>
<h1>Some page</h1><form id="big-form">${rows.join("")}<button type="submit">Go</button></form>`;
}

test("AUDIT-10 dormant cost on an unbound page (no handoff seeded)", async ({ context, origin, routes, worker }) => {
  void worker; // ensure the service worker is up
  for (const n of [100, 1000, 5000]) routes.set(`/plain${n}`, bigForm(n));
  for (const n of [100, 1000, 5000]) {
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(`${origin}/plain${n}`);
    await page.waitForSelector("#big-form", { timeout: 120_000 });
    const load = Date.now() - t0;
    // Let document_idle + probeFrame run, then measure main-thread responsiveness.
    const probe = await page.evaluate(() => {
      const s = performance.now();
      return new Promise<number>((r) => setTimeout(() => r(performance.now() - s), 0));
    });
    const touched = await page.evaluate(() => document.documentElement.outerHTML.includes("jobpilot"));
    console.log(`AUDIT-10 DORMANT n=${n} pageLoadMs=${load} setTimeout0LatencyMs=${probe.toFixed(1)} domTouched=${touched}`);
    await page.close();
  }
});
