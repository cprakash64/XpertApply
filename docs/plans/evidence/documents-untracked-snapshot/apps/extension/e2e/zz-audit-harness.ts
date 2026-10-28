/* AUDIT ARTIFACT — temporary, added by a security audit. Not production code. */
import { chromium, test as base, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.resolve(here, "..", "dist");

export const PROFILE_ANSWERS = [
  { canonical_key: "first_name", value: "Aisha", display_value: "Aisha", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "last_name", value: "Okonkwo-Núñez", display_value: "Aisha", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "full_name", value: "Aisha Okonkwo-Núñez", display_value: "Aisha Okonkwo-Núñez", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "email", value: "aisha.audit@example.test", display_value: "aisha.audit@example.test", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "phone", value: "+1 602 555 0134", display_value: "+1 602 555 0134", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "address", value: "44 Audit Way", display_value: "44 Audit Way", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "city", value: "Phoenix", display_value: "Phoenix", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "postal_code", value: "85004", display_value: "85004", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "linkedin_url", value: "https://linkedin.com/in/aisha-audit", display_value: "…", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "work_authorization_us", value: "Yes", display_value: "Yes", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "sponsorship_required_future", value: "No", display_value: "No", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "sponsorship_required_now", value: "No", display_value: "No", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "years_of_experience", value: "7", display_value: "7", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true },
  { canonical_key: "salary_expectation", value: "185000", display_value: "185000", source: "explicit_user_answer", confidence: 1, sensitive: false, requires_review: false, verified: true }
];

export type AuditFixtures = {
  context: BrowserContext;
  worker: Worker;
  origin: string;
  altOrigin: string;
  routes: Map<string, string>;
};

const sockets = new Set<import("node:net").Socket>();

export function destroySockets(): void { for (const s of sockets) s.destroy(); sockets.clear(); }

function serve(routes: Map<string, string>, host: string): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];
      const body = routes.get(url);
      if (body == null) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.listen(0, host, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, origin: `http://${host}:${port}` });
    });
  });
}

export const test = base.extend<AuditFixtures>({
  routes: async ({}, use) => { await use(new Map<string, string>()); },
  origin: async ({ routes }, use) => {
    const { server, origin } = await serve(routes, "localhost");
    await use(origin);
    destroySockets();
    await new Promise<void>((r) => server.close(() => r()));
  },
  altOrigin: async ({ routes }, use) => {
    const { server, origin } = await serve(routes, "127.0.0.1");
    await use(origin);
    destroySockets();
    await new Promise<void>((r) => server.close(() => r()));
  },
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      serviceWorkers: "allow"
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
    await use(worker);
  }
});

export async function stubApi(context: BrowserContext, applicationUrl: string): Promise<void> {
  const sessionBody = {
    session_id: 55,
    authenticated_user_id: 900,
    ats_type: null,
    official_application_url: applicationUrl,
    job: { title: "Staff Engineer", company: "AuditCo" },
    resume: { status: "ready", document_id: 1, download_url: null },
    cover_letter: { status: "ready", document_id: 2, download_url: null },
    profile: {
      email: "aisha.audit@example.test",
      full_name: "Aisha Okonkwo-Núñez",
      location: "Phoenix, AZ",
      phone: "+1 602 555 0134"
    }
  };
  await context.route("**/application-sessions/token", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: "audit-session-token", session: sessionBody }) }));
  await context.route("**/application-sessions/*/answers", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers: PROFILE_ANSWERS, unresolved_questions: [], profile_revision: "r1" }) }));
  await context.route("**/application-sessions/*/resolve-questions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ request_schema_version: 2, registry_version: "audit", answer_contract_version: 1, results: [] }) }));
  await context.route("**/application-sessions/*/answers/override", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ overrides: [] }) }));
  await context.route("**/application-sessions/*/resume*", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Aisha_Okonkwo_Resume.pdf"' }, body: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF") }));
  await context.route("**/application-sessions/*/cover-letter*", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Aisha_Cover_Letter.pdf"' }, body: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF") }));
  await context.route("**/application-sessions/*/events", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await context.route("**/application-sessions/*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionBody) }));
}

export async function seedHandoff(worker: Worker, applicationUrl: string): Promise<void> {
  await worker.evaluate(async (url) => {
    const now = Date.now();
    await chrome.storage.local.set({
      activeAssistedApplyHandoffV1: {
        version: 1, applicationId: "audit-app", jobId: "4242", applicationUrl: url,
        status: "prepared", handoffToken: "audit-handoff", requestId: "audit-request",
        sessionId: 55, launchToken: "audit-launch", officialUrl: url,
        expectedOrigin: new URL(url).origin, createdAt: now, expiresAt: now + 900_000,
        state: "waiting_for_content_script", protocolVersion: 3, atsType: null
      }
    });
  }, applicationUrl);
}
