import { expect, test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { WidgetDriver } from "./widget-driver";

/**
 * "Answer for this application", through the REAL built dist.
 *
 * The loop under test is the whole one: an unanswered legal question appears in
 * review → the user presses a button that exists → picks Yes with nothing
 * preselected → the extension calls the authenticated override endpoint → only
 * the affected question is re-resolved → the employer's control is driven and
 * VERIFIED → the ledger and the review list agree → the source line says the
 * answer belongs to this application alone.
 *
 * The override endpoint is stood in for here (the backend suite proves its
 * policy, ownership and expiry). Everything on the browser side is production
 * code: the widget in its closed shadow root, the real message plumbing, the
 * real dropdown transaction, the real verification.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const FIXTURE = fs.readFileSync(path.join(here, "fixtures", "legal-questions.html"), "utf8");

const WORK_AUTH_Q = "Are you legally authorized to work in the US without restriction?";
const SPONSOR_Q = "Will you now or in the future require visa sponsorship or a visa transfer?";
const SOURCE_Q = "Where did you hear about this opportunity?";

/** The canonical key each fixture question resolves to, as the registry would. */
const SPONSOR_NOW_Q = "Do you currently require employer sponsorship or a visa transfer?";
const SPONSOR_FUTURE_Q = "Will you require employer sponsorship in the future?";

const CANONICAL: Record<string, string> = {
  [WORK_AUTH_Q]: "work_authorization_us",
  [SPONSOR_Q]: "sponsorship_required_now_or_future",
  [SPONSOR_NOW_Q]: "sponsorship_required_now",
  [SPONSOR_FUTURE_Q]: "sponsorship_required_future",
  [SOURCE_Q]: "source_where_heard_about_job"
};

/**
 * A stand-in for the session's override store, with the server's own rules:
 * the value is normalized here, provenance is stamped here, and a component
 * answer feeds the combined question — never the other way round.
 */
class OverrideStore {
  values = new Map<string, boolean>();
  /** Every PUT the extension made: path, body, and headers we care about. */
  calls: { key: string; body: unknown; authorized: boolean }[] = [];
  /** Saved profile answers, so the tests can prove they are never written. */
  vault = new Map<string, string>();
  status = 200;

  answerFor(canonicalKey: string): boolean | undefined {
    if (this.values.has(canonicalKey)) return this.values.get(canonicalKey);
    if (canonicalKey === "sponsorship_required_now_or_future") {
      const now = this.values.get("sponsorship_required_now");
      const future = this.values.get("sponsorship_required_future");
      const savedNow = this.vault.get("sponsorship_required_now");
      const savedFuture = this.vault.get("sponsorship_required_future");
      const resolvedNow = now ?? (savedNow ? savedNow === "Yes" : undefined);
      const resolvedFuture = future ?? (savedFuture ? savedFuture === "Yes" : undefined);
      // A missing half is not evidence about the whole.
      if (resolvedNow === undefined || resolvedFuture === undefined) return undefined;
      return resolvedNow || resolvedFuture;
    }
    const saved = this.vault.get(canonicalKey);
    return saved === undefined ? undefined : saved === "Yes";
  }

  isOverride(canonicalKey: string): boolean {
    if (this.values.has(canonicalKey)) return true;
    if (canonicalKey === "sponsorship_required_now_or_future") {
      return this.values.has("sponsorship_required_now")
        || this.values.has("sponsorship_required_future");
    }
    return false;
  }
}

type Fixtures = {
  context: BrowserContext;
  worker: Worker;
  origin: string;
  store: OverrideStore;
  resolveCalls: { batches: string[][] };
};

const test = base.extend<Fixtures>({
  store: async ({}, use) => use(new OverrideStore()),
  resolveCalls: async ({}, use) => use({ batches: [] }),
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
  context: async ({ origin, store, resolveCalls }, use) => {
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

    // PUT one application-only answer. Matched before the generic
    // /answers route so the two cannot be confused.
    await context.route("**/application-sessions/*/answers/override/*", async (route) => {
      const request = route.request();
      const key = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
      if (request.method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({
            overrides: Array.from(store.values.keys()).map((canonical_key) => ({
              canonical_key, scope: "application_session",
              source_label: "Confirmed for this application"
            }))
          }) });
        return;
      }
      const body = JSON.parse(request.postData() ?? "{}");
      store.calls.push({
        key,
        body,
        authorized: (request.headers().authorization ?? "").startsWith("Bearer ")
      });
      if (store.status !== 200) {
        await route.fulfill({ status: store.status, contentType: "application/json",
          body: JSON.stringify({ detail: "rejected" }) });
        return;
      }
      // The server accepts a boolean and nothing else.
      if (typeof body.value !== "boolean") {
        await route.fulfill({ status: 422, contentType: "application/json",
          body: JSON.stringify({ detail: "invalid_boolean" }) });
        return;
      }
      store.values.set(key, body.value);
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({
          canonical_key: key, scope: "application_session", answered: true,
          source_label: "Confirmed for this application",
          confirmed_at: new Date().toISOString()
        }) });
    });

    // The override LIST endpoint, used to recover state after a reinjection.
    await context.route("**/application-sessions/*/answers/override", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({
          overrides: Array.from(store.values.keys()).map((canonical_key) => ({
            canonical_key, scope: "application_session",
            source_label: "Confirmed for this application"
          }))
        }) }));

    await context.route("**/application-sessions/*/answers", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ answers: [], unresolved_questions: [], refreshed: false, profile_revision: "r" }) }));

    // The resolver, applying the same precedence the backend does: this
    // application's answer first, then the reusable vault.
    await context.route("**/application-sessions/*/resolve-questions", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const asked: string[] = [];
      const results = (body.questions ?? []).map((q: any) => {
        asked.push(q.question);
        if (q.question.includes("privacy policy")) {
          return { field_ref: q.field_ref, status: "manual", canonical_key: null, answer_type: null,
            selected_option_ref: null, safe_source: "none", confidence: 0,
            sensitivity: "consent", reason_code: "consent_requires_user" };
        }
        const key = CANONICAL[q.question] ?? null;
        const base = {
          field_ref: q.field_ref, canonical_key: key,
          answer_type: key === "source_where_heard_about_job" ? "single_select" : "boolean",
          sensitivity: key === "source_where_heard_about_job" ? null : "legal"
        };
        if (!key) {
          return { ...base, status: "unsupported", selected_option_ref: null,
            safe_source: "none", confidence: 0, reason_code: "no_deterministic_match" };
        }
        const answer = store.answerFor(key);
        if (answer === undefined) {
          return { ...base, status: "missing", selected_option_ref: null,
            safe_source: "none", confidence: 0, reason_code: "answer_missing",
            typed_answer: null, display_answer: null, source_values: [] };
        }
        const wanted = answer ? "Yes" : "No";
        const option = (q.options ?? []).find((o: any) => o.label === wanted);
        if (!option) {
          return { ...base, status: "missing", selected_option_ref: null,
            safe_source: "none", confidence: 0, reason_code: "option_not_found" };
        }
        return { ...base, status: "resolved", selected_option_ref: option.option_ref,
          safe_source: store.isOverride(key) ? "application_override" : "saved_profile",
          confidence: 1, reason_code: "exact_option", typed_answer: answer,
          display_answer: wanted, source_values: [answer] };
      });
      resolveCalls.batches.push(asked);
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
test.setTimeout(90_000);

async function seed(worker: Worker, url: string) {
  await worker.evaluate(async (u) => {
    const now = Date.now();
    await chrome.storage.local.set({
      activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "m2", jobId: "1", applicationUrl: u, status: "prepared",
        handoffToken: "h", requestId: "m2", sessionId: 55, launchToken: "l", officialUrl: u,
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

/** The widget's own summary numbers, so assertions read the ledger's totals. */
function counts(summary: { counts: string }) {
  const read = (label: string) => {
    const match = new RegExp(`${label}:\\s*(\\d+)`).exec(summary.counts);
    return match ? Number(match[1]) : -1;
  };
  return {
    discovered: read("Discovered"),
    filled: read("Filled"),
    needsInformation: read("Needs information"),
    optionalSkipped: read("Optional skipped")
  };
}

/** All three sponsorship controls, for the dependency tests. */
function componentState(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const text = (id: string) =>
      (document.getElementById(id) as HTMLSelectElement)?.selectedOptions[0]?.textContent ?? "";
    return { now: text("sponsor-now"), future: text("sponsor-future"), combined: text("sponsor") };
  });
}

/** The card for the work-authorization question, whatever field key it got. */
async function authCard(widget: WidgetDriver) {
  return cardMatching(widget, (title) => title.includes("Work authorization"));
}

/**
 * Poll for a card rather than reading the panel once.
 *
 * The custom combobox is enumerated by opening it, so its question reaches the
 * resolver a beat after the native selects do. Reading the panel at a fixed
 * moment makes that ordering a coin flip.
 */
async function cardMatching(widget: WidgetDriver, match: (title: string) => boolean) {
  let items: Awaited<ReturnType<WidgetDriver["actionItems"]>> = [];
  let previous = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await widget.openReview();
    items = await widget.actionItems();
    const signature = JSON.stringify(items.map((item) => item.fieldKey));
    const card = items.find((item) => match(item.title));
    // Both conditions: the card is present AND the panel looked the same a beat
    // ago. A card is legitimately absent while its question is mid-resolution
    // (the in-flight states are not reviewable), so a single read can land in
    // that gap and a bare "is it there yet" poll can land on a passing read that
    // is about to change.
    if (card && signature === previous) return card;
    previous = signature;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`no stable matching card in ${JSON.stringify(items)}`);
}

// --------------------------------------------------------------------------- //
// The full loop
// --------------------------------------------------------------------------- //
test("an unanswered work-authorization question is answerable, applied and verified", async ({
  context, worker, origin, store, resolveCalls
}) => {
  // Nothing saved and nothing overridden: the question genuinely has no answer.
  const { page } = await run(context, worker, origin);

  // 1. It appears in review, and the control was left alone.
  expect((await displayed(page)).auth).toBe("Select…");
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const card = await authCard(widget);

  // 2. The action is a real button, not text.
  expect(card.buttons).toContain("answer");
  expect(card.buttons).toContain("jump");
  expect(card.buttons).toContain("defer");
  expect(card.source).toBeNull();

  const batchesBefore = resolveCalls.batches.length;
  expect(await widget.clickAction(card.fieldKey, "answer")).toBe(true);

  // 3. Nothing is preselected, and the scope is stated.
  const choice = await widget.choiceState(card.fieldKey);
  expect(choice.present).toBe(true);
  expect(choice.choices).toEqual(["yes", "no", "cancel"]);
  expect(choice.preselected).toBe(0);
  expect(choice.valueControls).toBe(0);
  expect(choice.notes.join(" ")).toContain("Use this answer only for this application.");

  // 4. The user chooses Yes.
  expect(await widget.chooseAnswer(card.fieldKey, "yes")).toBe(true);
  await page.waitForTimeout(3500);

  // 5. The override endpoint was called, authenticated, with only the value.
  expect(store.calls).toHaveLength(1);
  expect(store.calls[0].key).toBe("work_authorization_us");
  expect(store.calls[0].authorized).toBe(true);
  expect(store.calls[0].body).toEqual({ value: true });

  // 6. Only the affected question was re-resolved.
  const refreshBatches = resolveCalls.batches.slice(batchesBefore);
  expect(refreshBatches).toHaveLength(1);
  expect(refreshBatches[0]).toEqual([WORK_AUTH_Q]);

  // 7-9. The employer control shows Yes, and its backing input agrees.
  const state = await displayed(page);
  expect(state.auth).toBe("Yes");
  expect(state.authHidden).toBe("true");

  // 10-12. The item resolved, and the source names this application only.
  const after = await widget.actionItems();
  const resolvedCard = after.find((i) => i.fieldKey === card.fieldKey);
  expect(resolvedCard?.source).toBe("Confirmed for this application");
  expect(resolvedCard?.buttons.filter(Boolean)).toEqual([]);
  expect(JSON.stringify(after)).not.toMatch(/saved for future|all applications|your profile/i);

  // 13. The reusable answer vault was never written.
  expect(store.vault.size).toBe(0);

  // Consent and Submit, untouched throughout.
  expect(state.privacy).toBe(false);
  expect(state.submitted).toBe(false);
  await page.close();
});

test("the displayed value persists after the page re-renders", async ({
  context, worker, origin, store
}) => {
  store.values.set("work_authorization_us", true);
  const { page } = await run(context, worker, origin);
  expect((await displayed(page)).auth).toBe("Yes");

  // Force the rescan a controlled SPA would.
  await page.evaluate(() => document.body.appendChild(document.createElement("div")));
  await page.waitForTimeout(2500);
  const after = await displayed(page);
  expect(after.auth).toBe("Yes");
  expect(after.authHidden).toBe("true");
  expect(after.submitted).toBe(false);
  await page.close();
});

test("Cancel sends nothing and leaves the question answerable", async ({
  context, worker, origin, store, resolveCalls
}) => {
  const { page } = await run(context, worker, origin);
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const card = await authCard(widget);

  const batches = resolveCalls.batches.length;
  expect(await widget.clickAction(card.fieldKey, "answer")).toBe(true);
  expect(await widget.chooseAnswer(card.fieldKey, "cancel")).toBe(true);
  await page.waitForTimeout(800);

  expect(store.calls).toHaveLength(0);
  expect(resolveCalls.batches.length).toBe(batches);
  expect((await widget.choiceState(card.fieldKey)).present).toBe(false);
  expect((await authCard(widget)).buttons).toContain("answer");
  expect((await displayed(page)).auth).toBe("Select…");
  await page.close();
});

test("answering No selects No, not a qualified variant", async ({
  context, worker, origin, store
}) => {
  const { page } = await run(context, worker, origin);
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const card = await authCard(widget);
  expect(await widget.clickAction(card.fieldKey, "answer")).toBe(true);
  expect(await widget.chooseAnswer(card.fieldKey, "no")).toBe(true);
  await page.waitForTimeout(3500);

  expect(store.calls[0].body).toEqual({ value: false });
  expect((await displayed(page)).auth).toBe("No");
  await page.close();
});

// --------------------------------------------------------------------------- //
// Sponsorship dependency
// --------------------------------------------------------------------------- //
test("answering the current-sponsorship component refreshes the combined question", async ({
  context, worker, origin, store, resolveCalls
}) => {
  // This employer asks all three sponsorship questions. The FUTURE component is
  // saved as No; the current one is unanswered, so the combined question cannot
  // be answered either — "no sponsorship today" says nothing about later.
  store.vault.set("sponsorship_required_future", "No");
  const { page } = await run(context, worker, origin, "?components=1");
  let state = await componentState(page);
  expect(state.now).toBe("Select…");
  expect(state.combined).toBe("Select…");
  expect(state.future).toBe("No");

  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const nowCard = await cardMatching(widget, (t) => t.includes("Current sponsorship"));

  const before = resolveCalls.batches.length;
  expect(await widget.clickAction(nowCard.fieldKey, "answer")).toBe(true);
  const choice = await widget.choiceState(nowCard.fieldKey);
  expect(choice.present).toBe(true);
  expect(choice.preselected).toBe(0);
  expect(await widget.chooseAnswer(nowCard.fieldKey, "yes")).toBe(true);
  await page.waitForTimeout(4000);

  // One targeted batch, naming BOTH the component and the combined question —
  // and nothing else on the page.
  const refresh = resolveCalls.batches.slice(before);
  expect(refresh).toHaveLength(1);
  expect(refresh[0].sort()).toEqual([
    "Do you currently require employer sponsorship or a visa transfer?",
    "Will you now or in the future require visa sponsorship or a visa transfer?"
  ]);

  state = await componentState(page);
  expect(state.now).toBe("Yes");
  // now OR future — answering the current component Yes makes the whole Yes.
  expect(state.combined).toBe("Yes");
  // The future component was NOT re-answered from the combined result.
  expect(state.future).toBe("No");
  expect(store.calls.map((c) => c.key)).toEqual(["sponsorship_required_now"]);
  // The saved answers are exactly what they were.
  expect(store.vault.get("sponsorship_required_future")).toBe("No");
  expect(store.vault.has("sponsorship_required_now")).toBe(false);
  expect((await displayed(page)).submitted).toBe(false);
  await page.close();
});

test("a direct combined answer does not answer either component", async ({
  context, worker, origin, store, resolveCalls
}) => {
  const { page } = await run(context, worker, origin, "?components=1");
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const combined = await cardMatching(widget, (t) => /^Sponsorship answer/.test(t));

  const before = resolveCalls.batches.length;
  expect(await widget.clickAction(combined.fieldKey, "answer")).toBe(true);
  const choice = await widget.choiceState(combined.fieldKey);
  expect(choice.present).toBe(true);
  expect(choice.preselected).toBe(0);
  // The combined question warns that the saved components are untouched.
  expect(choice.notes.join(" ")).toContain("does not update your saved current or future");
  expect(await widget.chooseAnswer(combined.fieldKey, "yes")).toBe(true);
  await page.waitForTimeout(4000);

  // Only the combined question was re-resolved — the dependency does not run
  // backwards into the components.
  const refresh = resolveCalls.batches.slice(before);
  expect(refresh).toHaveLength(1);
  expect(refresh[0]).toEqual([
    "Will you now or in the future require visa sponsorship or a visa transfer?"
  ]);

  const state = await componentState(page);
  expect(state.combined).toBe("Yes");
  expect(state.now).toBe("Select…");
  expect(state.future).toBe("Select…");
  expect(store.calls.map((c) => c.key)).toEqual(["sponsorship_required_now_or_future"]);
  await page.close();
});

// --------------------------------------------------------------------------- //
// Lifecycle
// --------------------------------------------------------------------------- //
test("a reinjected content script still applies the answer", async ({
  context, worker, origin, store
}) => {
  const { page } = await run(context, worker, origin);
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const card = await authCard(widget);
  expect(await widget.clickAction(card.fieldKey, "answer")).toBe(true);
  expect(await widget.chooseAnswer(card.fieldKey, "yes")).toBe(true);
  await page.waitForTimeout(3500);
  expect((await displayed(page)).auth).toBe("Yes");

  // A full reload discards every scrap of content-script memory: the ledger, the
  // widget, the local override mirror. Only the session holds the answer.
  await seed(worker, `${origin}/apply`);
  await page.reload();
  await page.waitForSelector("#application-form");
  await page.waitForTimeout(4500);

  const after = await displayed(page);
  expect(after.auth).toBe("Yes");
  expect(after.authHidden).toBe("true");
  expect(store.calls).toHaveLength(1);   // recovered, not re-stored
  expect(after.submitted).toBe(false);
  await page.close();
});

/**
 * The COLD service-worker path: a tab the worker holds no cached session package
 * for.
 *
 * A restarted MV3 worker takes exactly this path — its in-memory
 * tab -> package map is gone, so it rebuilds from persisted storage and re-reads
 * the session. A brand-new tab id reaches the same code with the same empty
 * cache, and unlike an extension reload it is reproducible: Playwright's
 * persistent context never brings an extension worker back after
 * `chrome.runtime.reload()`, and `ServiceWorker.stopAllWorkers` is not available
 * on the browser target.
 *
 * What this proves either way is the property that matters: the override is not
 * held in extension memory. The extension learns about it in exactly two places
 * — the override GET and the resolver's `safe_source` — both of which are
 * server round-trips.
 */
test("a cold worker with no cached session package still applies the answer", async ({
  context, worker, origin, store, resolveCalls
}) => {
  // The user answered on an earlier visit; only the session holds it.
  store.values.set("work_authorization_us", true);
  const { page } = await run(context, worker, origin);
  expect((await displayed(page)).auth).toBe("Yes");
  await page.close();

  const batches = resolveCalls.batches.length;
  // A new tab id: nothing the worker cached for the previous tab applies.
  const { page: fresh } = await run(context, worker, origin);

  expect(resolveCalls.batches.length).toBeGreaterThan(batches);
  const after = await displayed(fresh);
  expect(after.auth).toBe("Yes");
  expect(after.authHidden).toBe("true");
  // Read, not rewritten: no PUT was made at any point in this test.
  expect(store.calls).toHaveLength(0);
  expect(after.submitted).toBe(false);
  await fresh.close();
});

test("an expired session fails safely and keeps the question reviewable", async ({
  context, worker, origin, store
}) => {
  store.status = 410;
  const { page } = await run(context, worker, origin);
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const card = await authCard(widget);
  expect(await widget.clickAction(card.fieldKey, "answer")).toBe(true);
  expect(await widget.chooseAnswer(card.fieldKey, "yes")).toBe(true);
  await page.waitForTimeout(2000);

  const after = await authCard(widget);
  // Told plainly, still reachable, and nothing was claimed about the field.
  expect(after.status).toMatch(/expired/i);
  expect(after.source).toBeNull();
  expect(after.buttons).toContain("jump");
  expect(after.buttons).toContain("answer");
  expect((await displayed(page)).auth).toBe("Select…");
  expect((await displayed(page)).submitted).toBe(false);
  await page.close();
});

test("a rejected answer never claims the field was filled", async ({
  context, worker, origin, store
}) => {
  store.status = 422;
  const { page } = await run(context, worker, origin);
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const card = await authCard(widget);
  expect(await widget.clickAction(card.fieldKey, "answer")).toBe(true);
  expect(await widget.chooseAnswer(card.fieldKey, "yes")).toBe(true);
  await page.waitForTimeout(2000);

  const after = await authCard(widget);
  expect(after.source).toBeNull();
  expect((await displayed(page)).auth).toBe("Select…");
  await page.close();
});

// --------------------------------------------------------------------------- //
// Leave unresolved
// --------------------------------------------------------------------------- //
/**
 * Deferring an OPTIONAL question.
 *
 * The required path — the item stays in the final review and keeps blocking
 * "Mark application complete" — is asserted in the unit suite instead, because
 * this fixture has no required CHOICE control to defer: its required fields are
 * text inputs, which autofill fills, so they never reach the review list.
 */
test("leaving an optional question unresolved records it without filling it", async ({
  context, worker, origin, store, resolveCalls
}) => {
  const { page } = await run(context, worker, origin);
  const widget = await WidgetDriver.attach(page);
  const card = await cardMatching(
    widget,
    (title) => title.includes("This question needs your review")
  );
  expect(card.buttons).toContain("defer");

  const batches = resolveCalls.batches.length;
  const before = counts(await widget.summary());
  const employerBefore = await displayed(page);
  expect(await widget.clickAction(card.fieldKey, "defer")).toBe(true);
  await page.waitForTimeout(1000);

  // An optional question the user declines is settled: it leaves the list of
  // things needing attention, and it moves into SKIPPED — never into filled.
  const items = await widget.actionItems();
  expect(items.find((item) => item.fieldKey === card.fieldKey)).toBeUndefined();
  const after = counts(await widget.summary());
  expect(after.optionalSkipped).toBe(before.optionalSkipped + 1);
  expect(after.filled).toBe(before.filled);
  expect(after.needsInformation).toBe(before.needsInformation);

  // Nothing was stored, nothing was re-resolved, nothing was filled.
  expect(store.calls).toHaveLength(0);
  expect(resolveCalls.batches.length).toBe(batches);
  // Deferring changes nothing on the employer's page — not the control it was
  // about, and not anything else.
  const state = await displayed(page);
  expect(state).toEqual(employerBefore);
  expect(state.privacy).toBe(false);
  expect(state.submitted).toBe(false);
  await page.close();
});

// --------------------------------------------------------------------------- //
// The live contradiction must be unreachable in the production bundle
// --------------------------------------------------------------------------- //
/**
 * The reported live state was: header "Detecting fields", headline
 * "Filled 0 of 0", grid "Discovered 11 / Filled 1 / Needs information 10".
 *
 * This drives the real dist through a full run and asserts that combination
 * cannot appear — the headline agrees with the grid, and the header names the
 * ledger's stage rather than a hardcoded one.
 */
test("the production widget never contradicts its own totals", async ({
  context, worker, origin, store
}) => {
  store.vault.set("work_authorization_us", "Yes");
  store.vault.set("sponsorship_required_now", "No");
  store.vault.set("sponsorship_required_future", "No");
  const { page } = await run(context, worker, origin);
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();

  const summary = await widget.summary();
  const grid = counts(summary);
  const headline = /Filled\s+(\d+)\s+of\s+(\d+)/.exec(summary.count);

  // The headline count exists and agrees with the grid, digit for digit.
  expect(headline, `count line was ${JSON.stringify(summary.count)}`).not.toBeNull();
  expect(Number(headline![1])).toBe(grid.filled);
  expect(Number(headline![2])).toBe(grid.discovered);

  // The exact reported contradiction.
  expect(summary.count).not.toBe("Filled 0 of 0");
  expect(grid.discovered).toBeGreaterThan(0);

  // Discovery has finished, so the header must not still claim to be detecting.
  const LEDGER_STAGES = [
    "Understanding questions", "Reading available options", "Matching your saved answers",
    "Filling verified answers", "Waiting for your input", "Ready for final review"
  ];
  expect([...LEDGER_STAGES, "Needs review", "Autofill incomplete", "Ready for review"]).toContain(summary.title);
  expect(summary.title).not.toBe("Detecting fields");

  // And the answers the user saved actually landed.
  const state = await displayed(page);
  expect(state.auth).toBe("Yes");
  expect(state.sponsor).toBe("No");
  expect(state.privacy).toBe(false);
  expect(state.submitted).toBe(false);
  await page.close();
});

test("saved No/No resolves the combined sponsorship question to No", async ({
  context, worker, origin, store
}) => {
  store.vault.set("sponsorship_required_now", "No");
  store.vault.set("sponsorship_required_future", "No");
  const { page } = await run(context, worker, origin);
  expect((await displayed(page)).sponsor).toBe("No");
  await page.close();
});

test("saved No/Yes resolves the combined sponsorship question to Yes", async ({
  context, worker, origin, store
}) => {
  store.vault.set("sponsorship_required_now", "No");
  store.vault.set("sponsorship_required_future", "Yes");
  const { page } = await run(context, worker, origin);
  expect((await displayed(page)).sponsor).toBe("Yes");
  await page.close();
});

// --------------------------------------------------------------------------- //
// Consent and Submit
// --------------------------------------------------------------------------- //
test("the consent question offers no answer action and stays unchecked", async ({
  context, worker, origin
}) => {
  const { page } = await run(context, worker, origin);
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const consent = await cardMatching(widget, (t) => /privacy terms/i.test(t));
  // Revealing the control is the only thing offered.
  expect(consent.buttons.filter(Boolean)).toEqual(["jump"]);
  expect((await displayed(page)).privacy).toBe(false);
  await page.close();
});

test("keyboard input inside the widget cannot submit the application", async ({
  context, worker, origin
}) => {
  const { page } = await run(context, worker, origin);
  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const card = await authCard(widget);

  for (const key of ["Enter", " ", "Enter"]) {
    await widget.pressKeyInside(card.fieldKey, key);
  }
  await page.waitForTimeout(500);

  const state = await displayed(page);
  expect(state.submitted).toBe(false);
  expect(state.privacy).toBe(false);
  await page.close();
});

test("the targeted refresh never focuses or clicks Submit", async ({
  context, worker, origin
}) => {
  const { page } = await run(context, worker, origin);
  await page.evaluate(() => {
    const submit = document.querySelector('#application-form [type="submit"],#application-form button[type="submit"]');
    (window as any).__submitTouched = false;
    submit?.addEventListener("focus", () => { (window as any).__submitTouched = true; });
    submit?.addEventListener("click", () => { (window as any).__submitTouched = true; });
  });

  const widget = await WidgetDriver.attach(page);
  await widget.openReview();
  const card = await authCard(widget);
  expect(await widget.clickAction(card.fieldKey, "answer")).toBe(true);
  expect(await widget.chooseAnswer(card.fieldKey, "yes")).toBe(true);
  await page.waitForTimeout(3500);

  expect(await page.evaluate(() => (window as any).__submitTouched)).toBe(false);
  expect((await displayed(page)).submitted).toBe(false);
  await page.close();
});
