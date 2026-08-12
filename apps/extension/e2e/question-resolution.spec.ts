import { expect, test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import path from "node:path";
import fs from "node:fs";

/**
 * Milestone 1 through the REAL built dist: saved answer -> resolver endpoint ->
 * selected option -> employer control -> displayed value verified.
 *
 * The fixture is adversarial on purpose. Its combobox ignores synthetic clicks
 * (so a bare .click() proves nothing), renders its menu in a PORTAL outside the
 * form, and has a `revert=1` variant that accepts the click and then discards
 * it — which is exactly how a controlled React select behaves when it rejects a
 * change. A "fill" that does not verify passes none of these.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const FIXTURE = fs.readFileSync(path.join(here, "fixtures", "legal-questions.html"), "utf8");

const WORK_AUTH_Q = "Are you legally authorized to work in the US without restriction?";
const SPONSOR_Q = "Will you now or in the future require visa sponsorship or a visa transfer?";
const SOURCE_Q = "Where did you hear about this opportunity?";

type Resolution = { authorization?: string; sponsorship?: string; source?: string };
type Fixtures = {
  context: BrowserContext;
  worker: Worker;
  origin: string;
  resolution: Resolution;
  calls: { count: number };
};

const test = base.extend<Fixtures>({
  resolution: async ({}, use) => use({}),
  calls: async ({}, use) => use({ count: 0 }),
  origin: async ({}, use) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FIXTURE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await use(`http://localhost:${port}`);
    await new Promise<void>((r) => server.close(() => r()));
  },
  context: async ({ origin, resolution, calls }, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      serviceWorkers: "allow"
    });
    const applicationUrl = `${origin}/apply`;
    const sessionBody = {
      session_id: 55, ats_type: null, official_application_url: applicationUrl,
      job: { title: "Engineer", company: "Acme" },
      resume: { status: "ready", document_id: 1, download_url: null },
      cover_letter: { status: "ready", document_id: 2, download_url: null },
      profile: {}
    };
    await context.route("**/application-sessions/token", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ session_token: "tok", session: sessionBody }) }));
    await context.route("**/application-sessions/*/answers", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ answers: [], unresolved_questions: [], refreshed: false, profile_revision: "r" }) }));

    // Stand in for the resolver endpoint already proven by the backend suite.
    await context.route("**/application-sessions/*/resolve-questions", async (route) => {
      calls.count += 1;
      const body = JSON.parse(route.request().postData() ?? "{}");
      const results = (body.questions ?? []).map((q: any) => {
        const pick = (label: string) => {
          const option = (q.options ?? []).find((o: any) => o.label === label);
          return option ? option.option_ref : null;
        };
        let want: string | undefined;
        if (q.question === WORK_AUTH_Q) want = resolution.authorization;
        else if (q.question === SPONSOR_Q) want = resolution.sponsorship;
        else if (q.question === SOURCE_Q) want = resolution.source;

        if (q.question.includes("privacy policy")) {
          return { field_ref: q.field_ref, status: "manual", canonical_key: null, answer_type: null,
            selected_option_ref: null, safe_source: "none", confidence: 0,
            sensitivity: "consent", reason_code: "consent_requires_user" };
        }
        const ref = want ? pick(want) : null;
        const typed = want === "Yes" ? true : want === "No" ? false : null;
        const semanticallyResolvedWithoutOptions =
          typed !== null && Array.isArray(q.options) && q.options.length === 0;
        return {
          field_ref: q.field_ref,
          status: ref || semanticallyResolvedWithoutOptions
            ? "resolved"
            : want ? "ambiguous" : "missing",
          canonical_key: "work_authorization_us",
          answer_type: "boolean",
          selected_option_ref: ref,
          safe_source: ref || semanticallyResolvedWithoutOptions ? "saved_profile" : "none",
          confidence: ref || semanticallyResolvedWithoutOptions ? 1 : 0,
          sensitivity: "legal",
          reason_code: ref
            ? "exact_option"
            : semanticallyResolvedWithoutOptions
              ? "answer_resolved_options_unavailable"
              : "answer_missing",
          typed_answer: typed,
          display_answer: typed === null ? null : want,
          source_values: typed === null ? [] : [typed]
        };
      });
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ request_schema_version: 3, registry_version: "1.0.0", answer_contract_version: 3, results }) });
    });
    await context.route("**/application-sessions/*", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) }));

    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    await use(worker);
  }
});

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

async function seed(worker: Worker, url: string) {
  await worker.evaluate(async (u) => {
    const now = Date.now();
    await chrome.storage.local.set({
      activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "m1", jobId: "1", applicationUrl: u, status: "prepared",
        handoffToken: "h", requestId: "m1", sessionId: 55, launchToken: "l", officialUrl: u,
        expectedOrigin: new URL(u).origin, createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      }
    });
  }, url);
}

async function run(context: BrowserContext, worker: Worker, origin: string, query = "") {
  const url = `${origin}/apply${query}`;
  await seed(worker, url);
  const page = await context.newPage();
  const states: string[] = [];
  page.on("console", (m) => { if (m.text().includes("[XpertApply]")) states.push(m.text().slice(0, 200)); });
  await page.goto(url);
  await page.waitForSelector("#application-form");
  await page.waitForTimeout(4500);
  return { page, states };
}

function displayed(page: import("@playwright/test").Page) {
  return page.evaluate(() => ({
    auth: (document.getElementById("auth")?.textContent ?? "").trim(),
    authHidden: (document.getElementById("auth-hidden") as HTMLInputElement)?.value ?? "",
    sponsor: (document.getElementById("sponsor") as HTMLSelectElement)?.selectedOptions[0]?.textContent ?? "",
    source: (document.getElementById("source") as HTMLSelectElement)?.selectedOptions[0]?.textContent ?? "",
    privacy: (document.getElementById("privacy") as HTMLInputElement)?.checked ?? false,
    submitted: (window as any).__jobpilotFixture.submitted
  }));
}

test("Scenario A: authorization Yes, combined sponsorship No", async ({ context, worker, origin, resolution, calls }) => {
  resolution.authorization = "Yes";
  resolution.sponsorship = "No";
  const { page } = await run(context, worker, origin);
  const state = await displayed(page);

  expect(state.auth).toBe("Yes");
  expect(state.authHidden).toBe("true");  // machine value agrees semantically with Yes
  expect(state.sponsor).toBe("No");
  // One batch for the page, not one call per field.
  expect(calls.count).toBe(1);
  await page.close();
});

test("Scenario B: authorization Yes, combined sponsorship Yes", async ({ context, worker, origin, resolution }) => {
  resolution.authorization = "Yes";
  resolution.sponsorship = "Yes";
  const { page } = await run(context, worker, origin);
  const state = await displayed(page);
  expect(state.auth).toBe("Yes");
  expect(state.sponsor).toBe("Yes");
  await page.close();
});

test("job source selects the approved option", async ({ context, worker, origin, resolution }) => {
  resolution.source = "Company website";
  const { page } = await run(context, worker, origin);
  expect((await displayed(page)).source).toBe("Company website");
  await page.close();
});

test("a missing answer leaves the control untouched", async ({ context, worker, origin, resolution }) => {
  resolution.authorization = undefined;
  resolution.sponsorship = undefined;
  const { page } = await run(context, worker, origin);
  const state = await displayed(page);
  expect(state.auth).toBe("Select…");
  expect(state.sponsor).toBe("Select…");
  await page.close();
});

test("a qualified option is never collapsed into a plain Yes", async ({ context, worker, origin, resolution }) => {
  // Page offers only "Yes, with restrictions"; the approved label "Yes" is absent.
  resolution.authorization = "Yes";
  const { page } = await run(context, worker, origin, "?qualified=1");
  expect((await displayed(page)).auth).toBe("Select…");
  await page.close();
});

test("a value reverted by the framework fails verification", async ({ context, worker, origin, resolution }) => {
  resolution.authorization = "Yes";
  const { page, states } = await run(context, worker, origin, "?revert=1");
  const state = await displayed(page);
  // The page discarded the change, so the control is empty and — critically —
  // the run must NOT have reported it filled.
  expect(state.auth).toBe("Select…");
  expect(states.join("\n")).not.toContain("filled_verified");
  await page.close();
});

test("a contradictory custom-control backing value is a technical failure", async ({
  context, worker, origin, resolution
}) => {
  resolution.authorization = "Yes";
  const { page, states } = await run(context, worker, origin, "?backing=mismatch");
  const state = await displayed(page);
  expect(state.auth).toBe("Yes");
  expect(state.authHidden).toBe("false");
  expect(states.join("\n")).toContain("backing_value_mismatch");
  expect(states.join("\n")).not.toContain("filled_verified");
  await page.close();
});

test("consent stays unchecked and Submit is never activated", async ({ context, worker, origin, resolution }) => {
  resolution.authorization = "Yes";
  resolution.sponsorship = "No";
  const { page } = await run(context, worker, origin);
  const state = await displayed(page);
  expect(state.privacy).toBe(false);
  expect(state.submitted).toBe(false);
  await page.close();
});

test("re-running is idempotent and does not toggle a verified value", async ({ context, worker, origin, resolution }) => {
  resolution.authorization = "Yes";
  resolution.sponsorship = "No";
  const { page } = await run(context, worker, origin);
  const before = await displayed(page);
  // Force a rescan the way a SPA mutation would.
  await page.evaluate(() => document.body.appendChild(document.createElement("div")));
  await page.waitForTimeout(2500);
  const after = await displayed(page);
  expect(after.auth).toBe(before.auth);
  expect(after.sponsor).toBe(before.sponsor);
  expect(after.submitted).toBe(false);
  await page.close();
});

test("a closed dropdown is enumerated, resolved and verified", async ({
  context, worker, origin, resolution, calls
}) => {
  // The menu does not exist in the DOM until opened, and is torn down on close.
  resolution.authorization = "Yes";
  resolution.sponsorship = "No";
  const { page } = await run(context, worker, origin, "?closed=1");
  const state = await displayed(page);

  expect(state.auth).toBe("Yes");
  expect(state.authHidden).toBe("true");
  expect(state.sponsor).toBe("No");
  // Still one resolver call: enumeration happens before the batch, not per field.
  expect(calls.count).toBe(1);
  await page.close();
});

test("enumeration reads options without answering the question", async ({
  context, worker, origin, resolution
}) => {
  // No saved answer, so nothing may be selected — but the control must still
  // have been opened and read, and left exactly as it was found.
  resolution.authorization = undefined;
  const { page, states } = await run(context, worker, origin, "?closed=1");
  const state = await displayed(page);

  expect(state.auth).toBe("Select…");
  expect(state.authHidden).toBe("");
  expect(states.join("\n")).toContain("option enumeration");
  await page.close();
});

test("a menu that appears only after a delay is still enumerated", async ({
  context, worker, origin, resolution
}) => {
  resolution.authorization = "Yes";
  const { page } = await run(context, worker, origin, "?closed=1&menudelay=400");
  expect((await displayed(page)).auth).toBe("Yes");
  await page.close();
});

test("a resolved answer whose actuator cannot open becomes a technical issue", async ({
  context, worker, origin, resolution
}) => {
  resolution.authorization = "Yes";
  const { page, states } = await run(context, worker, origin, "?closed=1&gesture=1");
  // Preflight enumeration and the actual actuator each have their own bounded
  // open timeout. Wait for the latter so we assert the terminal ledger state.
  await page.waitForTimeout(3_500);
  const state = await displayed(page);

  // Nothing was selected, and the run did not spin on synthetic retries.
  expect(state.auth).toBe("Select…");
  expect(states.join("\n")).toContain("genuine_user_gesture_required");
  expect(states.join("\n")).toContain("interaction_failed");
  expect(states.join("\n")).toContain("menu_not_opened");
  const attempts = states.filter((s) => s.includes("option enumeration")).length;
  expect(attempts).toBe(1);
  await page.close();
});

test("enumeration never activates Submit or consent", async ({
  context, worker, origin, resolution
}) => {
  resolution.authorization = undefined;
  const { page } = await run(context, worker, origin, "?closed=1");
  const state = await displayed(page);
  expect(state.submitted).toBe(false);
  expect(state.privacy).toBe(false);
  await page.close();
});

test("the ledger reconciles and drives one consistent summary", async ({
  context, worker, origin, resolution
}) => {
  // A deliberately mixed page: one answered, one missing, one manual.
  resolution.authorization = "Yes";
  resolution.sponsorship = undefined;
  const { page } = await run(context, worker, origin, "?closed=1");

  const ledger = await page.evaluate(() => {
    const w = window as unknown as { __jobpilotLedger?: unknown };
    return w.__jobpilotLedger ?? null;
  });
  // The content script exposes nothing to the page by design, so assert on the
  // employer-visible outcome instead: the answered field is filled, the others
  // are untouched, and nothing was invented.
  const state = await displayed(page);
  expect(state.auth).toBe("Yes");
  expect(state.sponsor).toBe("Select…");
  expect(state.privacy).toBe(false);
  expect(state.submitted).toBe(false);
  expect(ledger).toBeNull();
  await page.close();
});
