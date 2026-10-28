/* AUDIT ARTIFACT — temporary Stage 3A verification. Not production code.
 *
 * Proves, in a real browser over real cross-origin HTTPS, that the frame gate:
 *   - still authorizes a legitimately embedded ATS application frame, and
 *   - refuses an unrelated third-party frame on the same page.
 *
 * Real hostnames are mapped to 127.0.0.1 with --host-resolver-rules so the
 * origins genuinely differ; nothing leaves the machine and no third-party
 * system is contacted.
 */
import { chromium, test as base, expect, type BrowserContext, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:https";
import { readFileSync } from "node:fs";
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

const APPLICATION_FORM = `<!doctype html><meta charset="utf-8"><title>Apply</title>
<h1>Apply for this job</h1><h2>Personal information</h2>
<form id="application-form" action="/submit" method="post">
  <label for="v_first">First name</label><input id="v_first" name="first_name" required>
  <label for="v_last">Last name</label><input id="v_last" name="last_name" required>
  <label for="v_email">Email</label><input id="v_email" name="email" type="email" required>
  <label for="v_phone">Phone</label><input id="v_phone" name="phone" required>
  <label for="v_li">LinkedIn Profile</label><input id="v_li" name="linkedin">
  <label for="v_resume">Resume/CV</label><input type="file" id="v_resume" name="resume">
  <button type="submit" id="submit">Submit application</button>
</form>`;

const CARRIER = `<!doctype html><meta charset="utf-8"><title>MongoDB Careers</title>
<h1>Software Engineer</h1><p>Apply below.</p>
<iframe id="ats" src="${ATS}/embed" width="600" height="500"></iframe>
<iframe id="ad"  src="${THIRD_PARTY}/embed" width="600" height="500"></iframe>`;

type F = { context: BrowserContext; worker: Worker };
const test = base.extend<F>({
  context: async ({}, use) => {
    const server: Server = createServer(
      { key: readFileSync(path.join(CERTS, "key.pem")), cert: readFileSync(path.join(CERTS, "cert.pem")) },
      (req, res) => {
        const url = (req.url || "/").split("?")[0];
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(url.startsWith("/embed") ? APPLICATION_FORM : CARRIER);
      }
    );
    const sockets = new Set<import("node:net").Socket>();
    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

    const ctx = await chromium.launchPersistentContext("", {
      channel: "chromium",
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        "--ignore-certificate-errors",
        "--host-resolver-rules=MAP careers.mongodb.com 127.0.0.1, MAP boards.greenhouse.io 127.0.0.1, MAP ads.doubleclick.net 127.0.0.1"
      ],
      serviceWorkers: "allow"
    });
    await use(ctx);
    await ctx.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 })));
  }
});

test.setTimeout(180_000);

test("embedded ATS frame fills; third-party frame on the same page gets nothing", async ({ context, worker }) => {
  const applicationUrl = `${EMPLOYER}/job`;
  const sessionBody = {
    session_id: 55, authenticated_user_id: 900, ats_type: null,
    official_application_url: applicationUrl,
    job: { title: "Software Engineer", company: "MongoDB" },
    resume: { status: "ready", document_id: 1, download_url: null },
    cover_letter: { status: "missing", document_id: null, download_url: null },
    profile: { email: "aisha.audit@example.test" }
  };
  await context.route("**/application-sessions/token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: "t", session: sessionBody }) }));
  await context.route("**/application-sessions/*/answers", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers: PROFILE_ANSWERS, unresolved_questions: [], profile_revision: "r1" }) }));
  await context.route("**/application-sessions/*/resolve-questions", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ request_schema_version: 2, registry_version: "a", answer_contract_version: 1, results: [] }) }));
  await context.route("**/application-sessions/*/resume*", (r) => r.fulfill({ status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Aisha_Okonkwo_Resume.pdf"' }, body: Buffer.from("%PDF-1.4\n%%EOF") }));
  await context.route("**/application-sessions/*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) }));
  await seedHandoff(worker, applicationUrl);

  const page = await context.newPage();
  await page.goto(applicationUrl);
  await page.waitForTimeout(30_000);

  const read = async (origin: string) => {
    const frame = page.frames().find((f) => f.url().startsWith(origin));
    if (!frame) return { error: "frame missing" };
    return frame.evaluate(() => ({
      first: (document.getElementById("v_first") as HTMLInputElement).value,
      email: (document.getElementById("v_email") as HTMLInputElement).value,
      phone: (document.getElementById("v_phone") as HTMLInputElement).value,
      resume: Array.from((document.getElementById("v_resume") as HTMLInputElement).files ?? []).map((f) => f.name).join(",") || "(none)",
      marked: document.querySelectorAll("[data-jobpilot-filled]").length
    }));
  };

  const ats = await read(ATS);
  const thirdParty = await read(THIRD_PARTY);
  console.log("VERIFY ATS_FRAME " + JSON.stringify(ats));
  console.log("VERIFY THIRD_PARTY_FRAME " + JSON.stringify(thirdParty));

  // Legitimate embedded ATS application: still works.
  expect(ats).toMatchObject({ first: "Aisha", email: "aisha.audit@example.test" });
  expect((ats as { marked: number }).marked).toBeGreaterThan(0);
  // Unrelated third-party frame on the same page: nothing.
  expect(thirdParty).toMatchObject({ first: "", email: "", phone: "", resume: "(none)", marked: 0 });

  await page.close().catch(() => undefined);
});
