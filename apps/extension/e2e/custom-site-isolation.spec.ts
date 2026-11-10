import { expect, test, type Page } from "@playwright/test";
import { answer, launchFromWebsite } from "./cws-p1-launch-harness";
import { site } from "./employer-site";

/**
 * EXT-LIVE-09. Different JOBS on a custom career site or a smaller ATS family that share a hostname, an employer path prefix, similar titles
 * and IDENTICAL form fields. Real Chromium, the real extension, owned pages served under the stated hostnames (these are fixtures; no live
 * Tesla / SmartRecruiters / employer site was contacted). Job X is launched from XpertApply; job Y is only ever opened by hand until it is
 * launched explicitly.
 */
const form = (title: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<main><h1>${title}</h1><form id="application-form" novalidate>
<div><label for="first_name">First Name *</label><input id="first_name" name="first_name" autocomplete="given-name" required></div>
<div><label for="last_name">Last Name *</label><input id="last_name" name="last_name" autocomplete="family-name" required></div>
<div><label for="email">Email *</label><input id="email" name="email" type="email" autocomplete="email" required></div>
<div><label for="phone">Phone *</label><input id="phone" name="phone" type="tel" autocomplete="tel" required></div>
<button id="submit_app" type="submit">Submit Application</button></form></main>
<script>window.__emp={submits:0,clicks:0};document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('#submit_app'))window.__emp.clicks++},true);
document.getElementById('application-form').addEventListener('submit',e=>{e.preventDefault();window.__emp.submits++});</script>`;
const labelKey = (t: string) => /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^e-?mail/i.test(t) ? "email" : /^phone/i.test(t) ? "phone" : null;
const who = (first: string) => ({ first_name: first, last_name: "Candidate", email: `${first.toLowerCase()}@example.test`, phone: "+16025550199" });
const answersFor = (first: string) => Object.entries(who(first)).map(([k, v]) => answer(k, v));
const first = (p: Page) => p.inputValue("#first_name").catch(() => "(none)");
const sub = (p: Page) => p.evaluate(() => (window as unknown as { __emp: { submits: number; clicks: number } }).__emp);

type Family = { name: string; host: string; atsType: string; x: string; y: string };
const FAMILIES: Family[] = [
  { name: "Tesla-style (/careers/search/job/apply/<id>)", host: "www.tesla.com", atsType: "generic", x: "/careers/search/job/apply/201111", y: "/careers/search/job/apply/202222" },
  { name: "custom employer, shared prefix and similar titles", host: "careers.acme-corp.example", atsType: "generic", x: "/jobs/senior-backend-engineer/apply", y: "/jobs/senior-backend-engineer-payments/apply" },
  { name: "SmartRecruiters, one company, identical title", host: "jobs.smartrecruiters.com", atsType: "generic", x: "/Acme/743999111111111-data-engineer", y: "/Acme/743999222222222-data-engineer" }
];

async function launch(f: Family, sid: number) {
  const s = await site({ [f.x]: () => ({ body: form(`Job X - ${f.name}`) }), [f.y]: () => ({ body: form(`Job Y - ${f.name}`) }) }, [f.host]);
  const h = await launchFromWebsite({
    html: "<!doctype html><title>u</title>", sessionId: sid, atsType: f.atsType, officialUrl: `https://${f.host}${f.x}`, launchArgs: s.args,
    profile: who("Riley"), answers: answersFor("Riley"), keyFor: labelKey, jobTitle: "Job X", company: "Acme"
  });
  await h.addJob({ sessionId: sid + 1, atsType: f.atsType, officialUrl: `https://${f.host}${f.y}`, jobTitle: "Job Y", company: "Acme", profile: who("Morgan"), answers: answersFor("Morgan"), keyFor: labelKey, launchToken: "synthetic-launch-b" });
  const payloadY = { requestId: `req-${sid + 1}`, launchToken: "synthetic-launch-b", sessionId: sid + 1, jobId: sid + 1, officialUrl: `https://${f.host}${f.y}`, atsType: f.atsType, webApiBase: h.employer.origin, webAuthenticatedUserId: 1 };
  return { s, h, payloadY };
}
async function startPayload(h: Awaited<ReturnType<typeof launchFromWebsite>>, payload: Record<string, unknown>): Promise<Page> {
  await h.site.evaluate((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_STAGE_LAUNCH", payload: p }, location.origin), payload);
  const [page] = await Promise.all([
    h.ctx.waitForEvent("page", { timeout: 30_000 }),
    h.site.evaluate((p) => window.postMessage({ source: "jobpilot-web", type: "JOBPILOT_START_ASSISTED_APPLY", payload: p }, location.origin), payload)
  ]);
  await page.waitForURL(payload.officialUrl as string);
  return page;
}
const tabsOn = (h: Awaited<ReturnType<typeof launchFromWebsite>>, host: string) => h.ctx.pages().filter((p) => p.url().includes(host));

for (const [i, f] of FAMILIES.entries()) {
  test(`${f.name}: job Y opened by hand stays idle in a new tab and in a new WINDOW; launching Y explicitly fills Y only; nothing is submitted`, async () => {
    test.setTimeout(300_000);
    const { s, h, payloadY } = await launch(f, 8600 + i * 10);
    try {
      const { empPage: x } = await h.start();
      await expect.poll(() => first(x), { timeout: 60_000 }).toBe("Riley");
      // New tab, same site, DIFFERENT job, identical fields.
      const tab = await h.ctx.newPage();
      await tab.goto(`https://${f.host}${f.y}`);
      // New browser WINDOW.
      const cdp = await h.ctx.newCDPSession(x);
      const [win] = await Promise.all([h.ctx.waitForEvent("page", { timeout: 20_000 }), cdp.send("Target.createTarget", { url: `https://${f.host}${f.y}`, newWindow: true })]);
      await win.waitForLoadState("load");
      await tab.waitForTimeout(15_000);
      expect(await first(tab)).toBe("");
      expect(await first(win)).toBe("");
      expect((await sub(tab)).submits + (await sub(win)).submits + (await sub(x)).submits).toBe(0);
      expect(await first(x)).toBe("Riley");
      // Now the user explicitly starts job Y from XpertApply.
      const y = await startPayload(h, payloadY);
      await expect.poll(() => first(y), { timeout: 60_000 }).toBe("Morgan");
      expect(await first(x)).toBe("Riley");                       // X not rewritten
      for (const p of [x, y]) expect((await sub(p)).submits).toBe(0);
      expect(await y.inputValue("#email")).toBe("morgan@example.test");
      expect(await x.inputValue("#email")).toBe("riley@example.test");
      await tab.close(); await win.close();
    } finally { await h.close().catch(() => undefined); s.close(); }
  });

  test(`${f.name}: the SAME tab navigating to job Y (link/back/forward) does not carry job X's session`, async () => {
    test.setTimeout(300_000);
    const { s, h } = await launch(f, 8650 + i * 10);
    try {
      const { empPage: x } = await h.start();
      await expect.poll(() => first(x), { timeout: 60_000 }).toBe("Riley");
      await x.goto(`https://${f.host}${f.y}`);                    // full navigation to a different job in the same tab
      await x.waitForTimeout(15_000);
      expect(await first(x)).toBe("");
      await x.goBack(); await x.waitForTimeout(3000);
      await x.goForward(); await x.waitForTimeout(8000);
      expect(await first(x)).toBe("");                            // job Y is still not filled after back/forward
      expect((await sub(x)).submits).toBe(0);
      expect(tabsOn(h, f.host)).toHaveLength(1);
    } finally { await h.close().catch(() => undefined); s.close(); }
  });
}
