/* AUDIT ARTIFACT — temporary. Fixture C: large + rapidly mutating DOM. */
import { test, stubApi, seedHandoff } from "./zz-audit-harness";

test.setTimeout(600_000);

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

for (const n of [100, 1000, 5000]) {
  test(`AUDIT-7 large form n=${n}`, async ({ context, worker, origin, routes }) => {
    routes.set(`/big${n}`, bigForm(n));
    const applicationUrl = `${origin}/big${n}`;
    await stubApi(context, applicationUrl);
    await seedHandoff(worker, applicationUrl);

    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(applicationUrl);
    await page.waitForSelector("#application-form", { timeout: 60_000 });
    const loaded = Date.now() - t0;
    // Wait until the extension has visibly finished (widget reports) or 120s.
    const deadline = Date.now() + 120_000;
    let filled = 0;
    while (Date.now() < deadline) {
      filled = await page.evaluate(() => document.querySelectorAll("[data-jobpilot-filled]").length);
      if (filled >= 3) break;
      await page.waitForTimeout(1000);
    }
    const settled = Date.now() - t0;
    // Responsiveness probe: how long does a trivial main-thread task take now?
    const probe = await page.evaluate(() => {
      const s = performance.now();
      return new Promise<number>((res) => requestAnimationFrame(() => res(performance.now() - s)));
    });
    console.log(`AUDIT-7 n=${n} pageLoadMs=${loaded} timeToFirstFillMs=${settled} markedFields=${filled} rafLatencyMs=${probe.toFixed(1)}`);
    await page.close();
  });
}

test("AUDIT-8 rapidly mutating DOM", async ({ context, worker, origin, routes }) => {
  routes.set("/mutating", `<!doctype html><meta charset="utf-8"><title>AuditCo Mutating</title>
<h1>Apply</h1><h2>Personal information</h2>
<form id="application-form">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <button type="submit" id="final-submit">Submit application</button>
</form>
<div id="churn"></div>
<script>
  let n = 0;
  setInterval(() => {
    const d = document.getElementById("churn");
    d.innerHTML = "";
    for (let i = 0; i < 50; i++) {
      const el = document.createElement("div");
      el.textContent = "churn " + (n++);
      d.appendChild(el);
    }
  }, 20);
</script>`);
  const applicationUrl = `${origin}/mutating`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);
  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 30_000 });
  await page.waitForTimeout(40_000);
  const out = await page.evaluate(() => ({
    marked: document.querySelectorAll("[data-jobpilot-filled]").length,
    first: (document.getElementById("first_name") as HTMLInputElement).value
  }));
  console.log("AUDIT-8 MUTATING " + JSON.stringify(out));
  await page.close();
});
