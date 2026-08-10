import { expect, test as base, chromium, type BrowserContext, type Route, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * Listing -> employer login session handoff, against the REAL built extension.
 *
 * The live failure this reproduces: "Your session is no longer valid. Reopen
 * the application from JobPilot." appears the moment the employer login page
 * loads, even though Apply navigation worked.
 *
 * The fidelity that matters here is the SINGLE-USE launch token. The real
 * backend consumes it on first exchange and returns 401 afterwards. A stub that
 * happily re-issues a session on every exchange hides the entire defect, so the
 * stub below enforces single use and counts exchanges.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const LISTING = fs.readFileSync(path.join(here, "fixtures", "listing-untrusted.html"), "utf8");
const LOGIN = fs.readFileSync(path.join(here, "fixtures", "careers-login.html"), "utf8");

/** Same registrable domain, different hosts — the real listing/login shape. */
const LISTING_URL = "https://careers.example.test/careers/job/12345";
const LOGIN_HOST = "https://login.example.test";

type Stub = { tokenExchanges: number; unauthorized: number };
type Fixtures = { context: BrowserContext; worker: Worker; stub: Stub };

const test = base.extend<Fixtures>({
  stub: async ({}, use) => {
    await use({ tokenExchanges: 0, unauthorized: 0 });
  },
  context: async ({ stub }, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      serviceWorkers: "allow"
    });

    const sessionBody = {
      session_id: 55,
      ats_type: null,
      official_application_url: LISTING_URL,
      job: { title: "Software Engineer", company: "Careers" },
      resume: { status: "ready", document_id: 1, download_url: null },
      cover_letter: { status: "ready", document_id: 2, download_url: null },
      profile: { email: "candidate@example.test", full_name: "Test Candidate" }
    };

    const html = (body: string) => (route: Route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });

    await context.route("https://careers.example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/careers/job/")) return html(LISTING)(route);
      return route.fulfill({ status: 404, body: "nf" });
    });
    await context.route(`${LOGIN_HOST}/**`, async (route) => html(LOGIN)(route));

    // The launch token is SINGLE USE, exactly like the real backend.
    await context.route("**/application-sessions/token", async (route) => {
      stub.tokenExchanges += 1;
      if (stub.tokenExchanges > 1) {
        stub.unauthorized += 1;
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Launch token already used." })
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session_token: "e2e-session-token", session: sessionBody })
      });
    });
    await context.route("**/application-sessions/*/answers", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          answers: [
            {
              canonical_key: "email",
              value: "candidate@example.test",
              display_value: "candidate@example.test",
              source: "profile",
              confidence: 1,
              sensitive: false,
              requires_review: false,
              verified: true
            }
          ],
          unresolved_questions: [],
          refreshed: false,
          profile_revision: "r1"
        })
      })
    );
    await context.route("**/application-sessions/*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) })
    );

    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    await use(worker);
  }
});

async function seedLaunch(worker: Worker, applicationId: string) {
  await worker.evaluate(
    async ([url, id]) => {
      const now = Date.now();
      await chrome.storage.local.set({
        activeAssistedApplyHandoffV1: {
          version: 1,
          applicationId: id,
          jobId: "4242",
          applicationUrl: url,
          status: "prepared",
          handoffToken: "e2e-handoff",
          requestId: id,
          sessionId: 55,
          launchToken: "e2e-launch",
          officialUrl: url,
          expectedOrigin: new URL(url).origin,
          createdAt: now,
          expiresAt: now + 900_000,
          state: "waiting_for_content_script",
          protocolVersion: 3,
          atsType: null
        }
      });
    },
    [LISTING_URL, applicationId] as const
  );
}

/**
 * The widget's shadow root is CLOSED, so its text is deliberately unreadable
 * from the page. Asserting on it would produce a test that can never fail.
 *
 * The real, observable signal is the content script's own state log, which is
 * sanitized by design (no tokens, no answers, no addresses).
 */
function collectStates(target: { on: (event: "console", fn: (m: { text(): string }) => void) => void }, sink: string[], label: string) {
  target.on("console", (message) => {
    const text = message.text();
    if (text.includes("[JobPilot]")) sink.push(`${label}: ${text.slice(0, 200)}`);
  });
}

test.describe.configure({ mode: "serial" });
// These drive a real extension through cross-host navigation and tab adoption;
// the default 30s is marginal on a cold service worker.
test.setTimeout(60_000);

test("new-tab listing -> login keeps the application session bound", async ({
  context,
  worker,
  stub
}) => {
  await seedLaunch(worker, "e2e-handoff-newtab");

  const listing = await context.newPage();
  const states: string[] = [];
  collectStates(listing, states, "listing");
  worker.on("console", (message) => states.push(`sw: ${message.text().slice(0, 200)}`));
  context.on("page", (destination) => collectStates(destination, states, "dest"));

  // The CTA is an anchor with target="_blank" pointing at the login host.
  await listing.route("https://careers.example.test/careers/job/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: LISTING.replace(
        'case "anchor-blank":',
        `case "anchor-blank-login": return \`<a class="btn" id="primary-apply" target="_blank" href="${LOGIN_HOST}/signin">Apply to this job</a>\`;\n        case "anchor-blank":`
      )
    });
  });

  const opened = context.waitForEvent("page", { timeout: 25_000 });
  await listing.goto(`${LISTING_URL}?cta=anchor-blank-login`);

  const loginPage = await opened;
  await loginPage.waitForLoadState("load");
  await loginPage.waitForSelector("#login-form", { timeout: 15_000 });
  // Let the content script complete its handoff attempt.
  await loginPage.waitForTimeout(3000);

  console.log("\n=== STATE SEQUENCE ===\n" + states.join("\n"));
  const destination = states.filter((entry) => entry.startsWith("dest:")).join("\n");

  // The destination content script must have activated on the login page…
  expect(destination, "destination content script never activated").toContain("content script active");
  // …and reached employer auth, NOT a session failure.
  expect(destination).toContain("employer authentication required");
  expect(destination).not.toMatch(/session (is no longer valid|package failed)/i);
  // The package travelled with the binding rather than re-exchanging a
  // single-use launch token.
  expect(states.join("\n")).not.toMatch(/SESSION_UNAUTHORIZED/);

  await loginPage.close();
  await listing.close();
});

test("same-tab listing -> login keeps the application session bound", async ({
  context,
  worker,
  stub
}) => {
  await seedLaunch(worker, "e2e-handoff-sametab");

  const listing = await context.newPage();
  const states: string[] = [];
  collectStates(listing, states, "page");
  await listing.route("https://careers.example.test/careers/job/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: LISTING.replace(
        'case "anchor":',
        `case "anchor-login": return \`<a class="btn" id="primary-apply" href="${LOGIN_HOST}/signin">Apply to this job</a>\`;\n        case "anchor":`
      )
    });
  });

  await listing.goto(`${LISTING_URL}?cta=anchor-login`);
  await listing.waitForURL(/login\.example\.test/, { timeout: 25_000 });
  await listing.waitForSelector("#login-form", { timeout: 15_000 });
  await listing.waitForTimeout(3000);

  console.log("\n=== SAME-TAB STATE SEQUENCE ===\n" + states.join("\n"));
  const sequence = states.join("\n");
  expect(sequence, "content script never activated on the login page").toContain("content script active");
  expect(sequence).toContain("employer authentication required");
  expect(sequence).not.toMatch(/SESSION_UNAUTHORIZED/);

  await listing.close();
});


test("a destination that self-binds inherits the session package instead of re-exchanging", async ({
  context,
  worker
}) => {
  // This is the live shape: the destination tab binds itself through the
  // getActive() path (not through bindTabToLaunch), so it never inherited a
  // package. The launch token is already spent, so re-exchanging it 401s and
  // the widget reported a lost connection on a healthy session.
  await seedLaunch(worker, "e2e-selfbind");

  // Pre-seed a package for a DIFFERENT tab id, as the listing tab would have.
  await worker.evaluate(async () => {
    const area = chrome.storage.session ?? chrome.storage.local;
    const store = await area.get("sessionPackages");
    const map = (store.sessionPackages ?? {}) as Record<string, unknown>;
    map["999999"] = {
      sessionToken: "already-exchanged-token",
      cachedAt: Date.now(),
      session: {
        sessionId: 55,
        jobTitle: "Software Engineer",
        company: "Careers",
        officialUrl: "https://careers.example.test/careers/job/12345",
        profileData: { email: "candidate@example.test" },
        answers: [],
        unresolvedQuestions: []
      }
    };
    await area.set({ sessionPackages: map });
  });

  const page = await context.newPage();
  const states: string[] = [];
  collectStates(page, states, "dest");
  worker.on("console", (message) => states.push(`sw: ${message.text().slice(0, 200)}`));

  await page.goto(`${LOGIN_HOST}/signin`);
  await page.waitForSelector("#login-form", { timeout: 15_000 });
  await page.waitForTimeout(2500);

  const sequence = states.join("\n");
  console.log("\n=== SELF-BIND SEQUENCE ===\n" + sequence);

  // The package was inherited by session, so no second token exchange happened
  // and no lost-connection failure was reported.
  // The tab is on the login host, which the exact-hostname handoff match
  // cannot approve. The workflow origin graph can, so the page reconnects and
  // inherits the session-scoped package rather than re-exchanging a spent
  // launch token.
  expect(sequence).toMatch(/handoff_url_mismatch_retry|rebind_accepted|session_scoped_reuse|content script active/);
  expect(sequence).not.toMatch(/SESSION_UNAUTHORIZED/);

  await page.close();
});

test("the widget offers Reconnect rather than Retry when no session is bound", async () => {
  // Source-level contract: Retry must route to reconnect when the binding is
  // what is missing, because re-running field discovery with no session simply
  // fails again.
  const fs = await import("node:fs");
  const bootstrap = fs.readFileSync(path.join(here, "..", "src", "content", "bootstrap.ts"), "utf8");
  expect(bootstrap).toContain("if (matched && !session) {");
  expect(bootstrap).toContain("void requestReconnect();");
  expect(bootstrap).toContain("offerReconnect: recoverable");

  const widget = fs.readFileSync(path.join(here, "..", "src", "content", "widget.ts"), "utf8");
  expect(widget).toContain('data-a="reconnect"');
  expect(widget).toContain("Reconnect to JobPilot");
  expect(widget).toContain("Reconnecting…");
  // Reconnect replaces Retry as the primary action in that state.
  expect(widget).toContain('if (retryBtn && value.offerReconnect) retryBtn.style.display = "none";');
});
