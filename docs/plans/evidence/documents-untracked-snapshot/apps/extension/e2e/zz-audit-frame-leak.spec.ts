/* AUDIT ARTIFACT — temporary security audit spec. Not production code. */
import { expect } from "@playwright/test";
import { test, stubApi, seedHandoff } from "./zz-audit-harness";

const APPLICATION = `<!doctype html><meta charset="utf-8"><title>AuditCo — Apply</title>
<h1>Apply for Staff Engineer</h1>
<h2>Personal information</h2>
<form id="application-form" action="/submit" method="post">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" name="phone">
  <input type="file" id="resume" name="resume">
  <button type="submit" id="final-submit">Submit application</button>
</form>
<!-- A THIRD-PARTY iframe on a different origin, as an ad / chat / analytics vendor would embed. -->
<iframe id="third-party" src="ALT_ORIGIN/vendor" width="500" height="400"></iframe>`;

// A third-party vendor page that merely LOOKS application-shaped.
const VENDOR = `<!doctype html><meta charset="utf-8"><title>vendor widget</title>
<h3>Personal information</h3>
<form id="vendor-form">
  <label for="v_first">First name</label><input id="v_first" name="first_name">
  <label for="v_last">Last name</label><input id="v_last" name="last_name">
  <label for="v_email">Email</label><input id="v_email" name="email" type="email">
  <label for="v_phone">Phone</label><input id="v_phone" name="phone">
  <label for="v_li">LinkedIn</label><input id="v_li" name="linkedin">
</form>`;

test.setTimeout(180_000);

test("AUDIT: does a bound tab's third-party iframe receive the user's profile?", async ({
  context, worker, origin, altOrigin, routes
}) => {
  routes.set("/vendor", VENDOR);
  routes.set("/job-audit-frame", APPLICATION.replace("ALT_ORIGIN", altOrigin));

  const applicationUrl = `${origin}/job-audit-frame`;
  await stubApi(context, applicationUrl);
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => { const t = m.text(); if (t.includes("[XpertApply]")) logs.push(`${m.location().url.includes("/vendor") ? "VENDOR" : "TOP"} ${t.slice(0,140)}`); });
  await page.goto(applicationUrl);
  await page.waitForSelector("#application-form", { timeout: 20_000 });
  await page.waitForTimeout(30_000);

  const top = await page.evaluate(() => ({
    first: (document.getElementById("first_name") as HTMLInputElement).value,
    last: (document.getElementById("last_name") as HTMLInputElement).value,
    email: (document.getElementById("email") as HTMLInputElement).value,
    phone: (document.getElementById("phone") as HTMLInputElement).value
  }));

  const frame = page.frames().find((f) => f.url().includes("/vendor"));
  const vendor = frame
    ? await frame.evaluate(() => ({
        first: (document.getElementById("v_first") as HTMLInputElement).value,
        last: (document.getElementById("v_last") as HTMLInputElement).value,
        email: (document.getElementById("v_email") as HTMLInputElement).value,
        phone: (document.getElementById("v_phone") as HTMLInputElement).value,
        li: (document.getElementById("v_li") as HTMLInputElement).value,
        extensionTouched: document.documentElement.outerHTML.includes("jobpilot"),
        widgetHost: Boolean(document.getElementById("jobpilot-assisted-apply")),
        markedFields: document.querySelectorAll("[data-jobpilot-filled]").length
      }))
    : { error: "frame not found" };

  console.log("AUDIT_RESULT_TOP " + JSON.stringify(top));
  console.log("AUDIT_RESULT_VENDOR_FRAME " + JSON.stringify(vendor));
  console.log("AUDIT_FRAMES " + JSON.stringify(page.frames().map((f) => f.url())));
  console.log("AUDIT_LOGS\n" + logs.join("\n"));
  await page.close();
});
