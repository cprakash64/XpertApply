import { expect, test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import path from "node:path";
import fs from "node:fs";

/**
 * Stage 2F / B-03 through the REAL built MV3 extension.
 *
 * The finding, run end to end: a provider answers a consequential question with
 * an option this page really offers, for a canonical key it really resolved, at
 * confidence 1.0 — and names the WRONG one. Every structural gate passes. Only a
 * deterministic semantic rule stops it, and the proof that it did is not a
 * status string but the employer's control still reading "Select…".
 *
 * The custom combobox here ignores synthetic clicks and renders its menu in a
 * portal outside the form, so a fill that does not genuinely interact and then
 * verify passes none of this.
 *
 * Nothing in this file submits anything. Every case asserts it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");
const FIXTURE = fs.readFileSync(path.join(here, "fixtures", "legal-questions.html"), "utf8");

const WORK_AUTH_Q = "Are you legally authorized to work in the US without restriction?";
const SPONSOR_Q = "Will you now or in the future require visa sponsorship or a visa transfer?";

/** What the (possibly malicious, possibly broken) provider returns. */
interface ProviderAnswer {
  /** The canonical boolean the provider claims. */
  typed: boolean;
  /** The option label it points its reference at — the adversarial knob. */
  option: string;
  /** Declared provenance. */
  source?: string;
}

type Provider = { authorization?: ProviderAnswer; sponsorship?: ProviderAnswer };

/** What the extension independently holds for the user. Emptied in the cases
 * that need to prove a refusal leaves the control ENTIRELY untouched — with a
 * stored answer present, the ordinary profile path legitimately fills the right
 * answer afterwards, which is safe but is not the same observation. */
type Stored = { authorization: boolean | null; sponsorship: boolean | null };

/** Hold the resolver response back, so the user can act while it is in flight. */
type Timing = { resolverDelayMs: number };

type Fixtures = {
  context: BrowserContext;
  worker: Worker;
  origin: string;
  provider: Provider;
  stored: Stored;
  timing: Timing;
};

const test = base.extend<Fixtures>({
  provider: async ({}, use) => use({}),
  stored: async ({}, use) => use({ authorization: true, sponsorship: false }),
  timing: async ({}, use) => use({ resolverDelayMs: 0 }),
  origin: async ({}, use) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FIXTURE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await use(`http://localhost:${port}`);
    await new Promise<void>((r) => server.close(() => r()));
  },
  context: async ({ origin, provider, stored, timing }, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      serviceWorkers: "allow"
    });
    const applicationUrl = `${origin}/apply`;
    const sessionBody = {
      session_id: 77, ats_type: null, official_application_url: applicationUrl,
      job: { title: "Engineer", company: "Acme", location: "San Francisco, CA" },
      resume: { status: "ready", document_id: 1, download_url: null },
      cover_letter: { status: "ready", document_id: 2, download_url: null },
      profile: {}
    };
    await context.route("**/application-sessions/token", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ session_token: "tok", session: sessionBody }) }));

    // The user's own verified answers, exactly as the extension holds them:
    // authorized, and does NOT require sponsorship now or in the future.
    await context.route("**/application-sessions/*/answers", (r) => {
      const held = (key: string, value: boolean | null) => value === null ? [] : [{
        canonical_key: key, value: value ? "Yes" : "No", display_value: value ? "Yes" : "No",
        source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true
      }];
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({
          answers: [
            ...held("work_authorization_us", stored.authorization),
            ...held("sponsorship_required_future", stored.sponsorship)
          ],
          unresolved_questions: [], refreshed: false, profile_revision: "r"
        }) });
    });

    await context.route("**/application-sessions/*/resolve-questions", async (route) => {
      if (timing.resolverDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, timing.resolverDelayMs));
      }
      const body = JSON.parse(route.request().postData() ?? "{}");
      const results = (body.questions ?? []).map((q: any) => {
        const answer = q.question === WORK_AUTH_Q ? provider.authorization
          : q.question === SPONSOR_Q ? provider.sponsorship
          : undefined;
        const key = q.question === WORK_AUTH_Q ? "work_authorization_us"
          : q.question === SPONSOR_Q ? "sponsorship_required_future"
          : null;
        if (!answer || !key) {
          return { field_ref: q.field_ref, status: "missing", canonical_key: key, answer_type: null,
            selected_option_ref: null, safe_source: "none", confidence: 0, sensitivity: null,
            reason_code: "answer_missing", typed_answer: null, display_answer: null, source_values: [] };
        }
        const ref = (q.options ?? []).find((o: any) => o.label === answer.option)?.option_ref ?? null;
        return {
          field_ref: q.field_ref,
          status: "resolved",
          canonical_key: key,
          answer_type: "boolean",
          selected_option_ref: ref,
          safe_source: answer.source ?? "saved_profile",
          // The adversarial parameter. Never a reason to act.
          confidence: 1,
          sensitivity: "legal",
          reason_code: "exact_option",
          typed_answer: answer.typed,
          display_answer: answer.option,
          source_values: [answer.typed]
        };
      });
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ request_schema_version: 3, registry_version: "1.0.0",
          answer_contract_version: 3, results }) });
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
    await (chrome.storage.session ?? chrome.storage.local).set({
      activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "b03", jobId: "1", applicationUrl: u, status: "prepared",
        handoffToken: "h", requestId: "b03", sessionId: 77, launchToken: "l", officialUrl: u,
        expectedOrigin: new URL(u).origin, createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      }
    });
  }, url);
}

async function run(context: BrowserContext, worker: Worker, origin: string) {
  const url = `${origin}/apply`;
  await seed(worker, url);
  const page = await context.newPage();
  const states: string[] = [];
  page.on("console", (m) => { if (m.text().includes("[XpertApply]")) states.push(m.text().slice(0, 300)); });
  await page.goto(url);
  await page.waitForSelector("#application-form");
  await page.waitForTimeout(4500);
  return { page, states };
}

function state(page: import("@playwright/test").Page) {
  return page.evaluate(() => ({
    auth: (document.getElementById("auth")?.textContent ?? "").trim(),
    authHidden: (document.getElementById("auth-hidden") as HTMLInputElement)?.value ?? "",
    sponsor: (document.getElementById("sponsor") as HTMLSelectElement)?.selectedOptions[0]?.textContent ?? "",
    privacy: (document.getElementById("privacy") as HTMLInputElement)?.checked ?? false,
    submitted: (window as any).__jobpilotFixture.submitted
  }));
}

// --------------------------------------------------------------------------- //

test("B-03 · the exactly-offered WRONG option is never committed, at any confidence", async ({
  context, worker, origin, provider
}) => {
  // Canonical: does NOT require future sponsorship. Provider: points its option
  // reference at "Yes", at confidence 1.0, for the key it itself says is
  // sponsorship_required_future.
  provider.sponsorship = { typed: false, option: "Yes" };
  const { page } = await run(context, worker, origin);
  const seen = await state(page);

  // THE assertion. The wrong answer never reached the employer's form.
  expect(seen.sponsor).not.toBe("Yes");
  expect(seen.submitted).toBe(false);
  await page.close();
});

test("B-03 · with nothing else holding authority, the control is left untouched", async ({
  context, worker, origin, provider, stored
}) => {
  // Same refusal, with the ordinary profile path removed from the picture, so
  // what is observed is the refusal alone: zero employer-visible mutation.
  stored.sponsorship = null;
  provider.sponsorship = { typed: false, option: "Yes" };
  const { page, states } = await run(context, worker, origin);
  const seen = await state(page);

  expect(seen.sponsor).toBe("Select…");
  expect(states.join("\n")).not.toContain("filled_verified");
  expect(seen.submitted).toBe(false);
  await page.close();
});

test("B-03 · the semantically correct option still fills and verifies", async ({
  context, worker, origin, provider, stored
}) => {
  // Nothing stored, so the resolver's answer is the only one that can fill this
  // control — and it does, because it is the right one.
  stored.sponsorship = null;
  provider.sponsorship = { typed: false, option: "No" };
  const { page } = await run(context, worker, origin);
  const seen = await state(page);

  expect(seen.sponsor).toBe("No");
  expect(seen.submitted).toBe(false);
  await page.close();
});

test("B-03 · work authorization is not inverted either", async ({
  context, worker, origin, provider, stored
}) => {
  // Canonical: authorized. Provider: points at "No" on the portal combobox.
  stored.authorization = null;
  provider.authorization = { typed: true, option: "No" };
  const { page } = await run(context, worker, origin);
  const seen = await state(page);

  expect(seen.auth).toBe("Select…");
  expect(seen.authHidden).toBe("");
  expect(seen.submitted).toBe(false);
  await page.close();
});

test("B-03 · the correct authorization answer drives the portal combobox", async ({
  context, worker, origin, provider, stored
}) => {
  // Proof the refusal above is a REFUSAL and not a broken actuator: the same
  // control, same portal menu, driven to a verified selection.
  stored.authorization = null;
  provider.authorization = { typed: true, option: "Yes" };
  const { page } = await run(context, worker, origin);
  const seen = await state(page);

  expect(seen.auth).toBe("Yes");
  expect(seen.authHidden).toBe("true");
  expect(seen.submitted).toBe(false);
  await page.close();
});

test("B-03 · a provider that contradicts the user's own stored answer is refused", async ({
  context, worker, origin, provider, stored
}) => {
  // Internally consistent — typed answer and option agree with each other — and
  // both disagree with the verified answer the extension independently holds.
  stored.sponsorship = false;
  provider.sponsorship = { typed: true, option: "Yes" };
  const { page } = await run(context, worker, origin);
  const seen = await state(page);

  expect(seen.sponsor).not.toBe("Yes");
  expect(seen.submitted).toBe(false);
  await page.close();
});

test("B-03 · a derived source may not state a consequential fact", async ({
  context, worker, origin, provider, stored
}) => {
  // The option is the RIGHT one. The authority to state it is what is missing.
  stored.sponsorship = null;
  provider.sponsorship = { typed: false, option: "No", source: "resume" };
  const { page } = await run(context, worker, origin);
  const seen = await state(page);

  expect(seen.sponsor).toBe("Select…");
  expect(seen.submitted).toBe(false);
  await page.close();
});

test("XA-07 · no run in this file activates the employer's submission", async ({
  context, worker, origin, provider, stored
}) => {
  stored.authorization = null;
  stored.sponsorship = null;
  provider.authorization = { typed: true, option: "Yes" };
  provider.sponsorship = { typed: false, option: "No" };
  const { page } = await run(context, worker, origin);
  const seen = await state(page);

  // Both consequential answers are filled and verified…
  expect(seen.auth).toBe("Yes");
  expect(seen.sponsor).toBe("No");
  // …and the form is still exactly where the user left it.
  expect(seen.submitted).toBe(false);
  expect(seen.privacy).toBe(false);
  await page.close();
});

test("CASE H · a user's own answer, made while the request was in flight, is not overwritten", async ({
  context, worker, origin, provider, stored, timing
}) => {
  // Nothing stored, so only the resolver could fill this control — and its
  // answer ("No") is perfectly correct. The point is that it arrives AFTER the
  // user has already answered the same question themselves.
  stored.sponsorship = null;
  provider.sponsorship = { typed: false, option: "No" };
  timing.resolverDelayMs = 3_000;

  const url = `${origin}/apply`;
  await seed(worker, url);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector("#application-form");

  // The user picks Yes by hand while the resolver request is still open.
  await page.selectOption("#sponsor", { label: "Yes" });
  expect(await page.inputValue("#sponsor")).toBe("y");

  // Now let the response land, and give the extension time to act on it.
  await page.waitForTimeout(8_000);

  const seen = await state(page);
  // THE assertion: their answer still stands. A response computed before they
  // acted is stale with respect to THEM, and neither re-discovery nor the
  // option-set staleness check can see that.
  expect(seen.sponsor).toBe("Yes");
  expect(seen.submitted).toBe(false);
  await page.close();
});
