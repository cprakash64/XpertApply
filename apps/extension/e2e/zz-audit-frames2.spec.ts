/* AUDIT ARTIFACT — temporary. */
import { test, stubApi, seedHandoff } from "./zz-audit-harness";

test.setTimeout(180_000);

const TOP = `<!doctype html><meta charset="utf-8"><title>AuditCo</title>
<h1>Apply</h1><h2>Personal information</h2>
<form id="application-form">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <button type="submit" id="final-submit">Submit application</button>
</form>
<iframe id="so" src="/vendor-so"></iframe>
<iframe id="xo" src="ALT/vendor-xo"></iframe>`;

// A third-party frame that PRESENTS ITSELF as an application form.
const VENDOR = `<!doctype html><meta charset="utf-8"><title>vendor</title>
<h1>Apply for this job</h1>
<h2>Personal information</h2>
<form id="vendor-form" action="/collect" method="post">
  <label for="v_first">First name</label><input id="v_first" name="first_name" required>
  <label for="v_last">Last name</label><input id="v_last" name="last_name" required>
  <label for="v_email">Email</label><input id="v_email" name="email" type="email" required>
  <label for="v_phone">Phone</label><input id="v_phone" name="phone" required>
  <label for="v_li">LinkedIn Profile</label><input id="v_li" name="linkedin">
  <label for="v_city">City</label><input id="v_city" name="city">
  <label for="v_resume">Resume/CV</label><input type="file" id="v_resume" name="resume">
  <button type="submit" id="vendor-submit">Submit application</button>
</form>`;

test("AUDIT-4 is the content script actually injected into sub-frames?", async ({ context, worker, origin, altOrigin, routes }) => {
  routes.set("/vendor-so", VENDOR);
  routes.set("/vendor-xo", VENDOR);
  routes.set("/job-frames", TOP.replace("ALT", altOrigin));
  const applicationUrl = `${origin}/job-frames`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  await page.waitForTimeout(20_000);

  const tabInfo = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || "").includes("/job-frames"));
    if (!tab?.id) return { error: "no tab" };
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => ({
        url: location.href,
        instance: (window as unknown as Record<string, unknown>).__jobpilotContentInstance ?? null,
        marked: document.querySelectorAll("[data-jobpilot-filled]").length,
        values: Array.from(document.querySelectorAll("input")).map((i) => `${(i as HTMLInputElement).id}=${(i as HTMLInputElement).value}`),
        files: Array.from(document.querySelectorAll('input[type=file]')).map((i) => `${(i as HTMLInputElement).id}:${Array.from((i as HTMLInputElement).files ?? []).map((f) => f.name + "/" + f.type + "/" + f.size).join(",") || "(none)"}`),
        widget: Boolean(document.getElementById("jobpilot-assisted-apply"))
      })
    });
    return { frames: results.map((r) => ({ frameId: r.frameId, ...(r.result as object) })) };
  });
  console.log("AUDIT-4 FRAMES " + JSON.stringify(tabInfo, null, 2));
  await page.close();
});
