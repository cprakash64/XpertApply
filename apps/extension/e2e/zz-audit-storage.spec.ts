/* AUDIT ARTIFACT — temporary. What the extension persists, and where. */
import { test, stubApi, seedHandoff } from "./zz-audit-harness";

test.setTimeout(180_000);

const PAGE = `<!doctype html><meta charset="utf-8"><title>AuditCo</title>
<h1>Apply</h1><h2>Personal information</h2>
<form id="application-form">
  <label for="first_name">First name</label><input id="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" required>
  <label for="email">Email</label><input id="email" type="email" required>
  <button type="submit" id="final-submit">Submit application</button>
</form>`;

function redact(s: string): string {
  return s
    .replace(/"(sessionToken|launchToken|handoffToken)":"[^"]*"/g, '"$1":"<REDACTED>"')
    .replace(/aisha\.audit@example\.test/g, "<EMAIL>")
    .replace(/\+1 602 555 0134/g, "<PHONE>");
}

test("AUDIT-16 storage inventory after a completed run", async ({ context, worker, origin, routes }) => {
  routes.set("/storage", PAGE);
  const applicationUrl = `${origin}/storage`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForTimeout(20_000);

  const dump = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    const sync = await chrome.storage.sync.get(null).catch(() => ({}));
    const summarize = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]));
    return { localKeys: Object.keys(local), local: summarize(local), sessionKeys: Object.keys(session), session: summarize(session), syncKeys: Object.keys(sync) };
  });

  console.log("AUDIT-16 LOCAL_KEYS " + JSON.stringify(dump.localKeys));
  console.log("AUDIT-16 SESSION_KEYS " + JSON.stringify(dump.sessionKeys));
  console.log("AUDIT-16 SYNC_KEYS " + JSON.stringify(dump.syncKeys));
  for (const [k, v] of Object.entries(dump.local)) console.log(`AUDIT-16 LOCAL[${k}] = ${redact(String(v)).slice(0, 900)}`);
  for (const [k, v] of Object.entries(dump.session)) console.log(`AUDIT-16 SESSION[${k}] = ${redact(String(v)).slice(0, 700)}`);

  // Now: does closing the tab / clearing the session remove any of it?
  await page.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 3000));
  const after = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return { local: Object.keys(local), session: Object.keys(session), activePresent: Boolean((local as any).activeAssistedApplyHandoffV1), packagesPresent: JSON.stringify((session as any).sessionPackages ?? null).length };
  });
  console.log("AUDIT-16 AFTER_TAB_CLOSE " + JSON.stringify(after));
});
