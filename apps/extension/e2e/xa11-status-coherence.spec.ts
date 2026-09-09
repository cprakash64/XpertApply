import { expect, test, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WidgetDriver } from "./widget-driver";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");

const FIXTURE = `<!doctype html><title>Apply</title><main><h1>Apply for this job</h1>
  <form id="application">
    <label for="first_name">First name</label><input id="first_name" name="first_name" required>
    <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <button type="submit" id="submit">Submit application</button>
  </form></main>
  <script>
    window.__xa11Submit = 0;
    window.__xa14ReviewMutations = { attributes: [], style: 0, widgetAdds: 0, nativeInput: 0, nativeChange: 0 };
    document.addEventListener('input', () => window.__xa14ReviewMutations.nativeInput++, true);
    document.addEventListener('change', () => window.__xa14ReviewMutations.nativeChange++, true);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const name = record.attributeName || '';
          window.__xa14ReviewMutations.attributes.push({
            id: record.target.id || '',
            name,
            value: record.target.getAttribute(name)
          });
          if (name === 'style') window.__xa14ReviewMutations.style++;
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.id === 'jobpilot-assisted-apply' || node.querySelector?.('#jobpilot-assisted-apply')) {
            window.__xa14ReviewMutations.widgetAdds++;
          }
        }
      }
    }).observe(document.documentElement, { subtree: true, attributes: true, childList: true });
    document.querySelector('#application').addEventListener('submit', event => {
      event.preventDefault();
      window.__xa11Submit++;
    });
  </script>`;

test("XA-11: widget confirmation total matches controls marked for review", async () => {
  test.setTimeout(60_000);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(FIXTURE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://localhost:${(server.address() as { port: number }).port}`;
  const applicationUrl = `${origin}/apply`;
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    serviceWorkers: "allow"
  });
  try {
    const answers = [
      { canonical_key: "first_name", value: "Test", display_value: "Test", source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true },
      { canonical_key: "last_name", value: "Candidate", display_value: "Candidate", source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true },
      { canonical_key: "email", value: "candidate@example.test", display_value: "candidate@example.test", source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true }
    ];
    const session = {
      session_id: 911,
      ats_type: null,
      official_application_url: applicationUrl,
      job: { title: "Engineer", company: "XA-11 Fixture" },
      resume: { status: "ready", document_id: 1, download_url: null },
      cover_letter: { status: "ready", document_id: 2, download_url: null },
      profile: {
        first_name: "Test",
        last_name: "Candidate",
        email: "candidate@example.test"
      },
      answers,
      unresolved_questions: []
    };
    await context.route("**/application-sessions/token", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session_token: "xa11-token", session })
    }));
    await context.route("**/application-sessions/*/answers", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ answers, unresolved_questions: [], refreshed: false, profile_revision: "r" })
    }));
    await context.route("**/application-sessions/*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session)
    }));

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    await worker.evaluate(async (url) => {
      const now = Date.now();
      await chrome.storage.session.set({ activeAssistedApplyHandoffV1: {
        version: 1,
        applicationId: "xa11-e2e",
        jobId: "911",
        applicationUrl: url,
        status: "prepared",
        handoffToken: "xa11-handoff",
        requestId: "xa11-request",
        sessionId: 911,
        launchToken: "xa11-launch",
        officialUrl: url,
        expectedOrigin: new URL(url).origin,
        createdAt: now,
        expiresAt: now + 900_000,
        state: "waiting_for_content_script",
        protocolVersion: 3,
        atsType: null
      }});
    }, applicationUrl);

    const page = await context.newPage();
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto(applicationUrl);
    await expect(page.locator("#email")).toHaveValue("candidate@example.test", { timeout: 20_000 });
    await page.waitForSelector("#jobpilot-assisted-apply", { state: "attached" });
    const widget = await WidgetDriver.attach(page);
    await expect.poll(() => widget.summary()).toMatchObject({ title: "Autofill incomplete" });

    const pageState = await page.evaluate(() => ({
      review: document.querySelectorAll('[data-jobpilot-status="review"]').length,
      verified: document.querySelectorAll('[data-jobpilot-status="verified"]').length,
      privateMarkers: Array.from(document.querySelectorAll("*")).flatMap((element) =>
        Array.from(element.attributes)
          .filter((attribute) => attribute.name.startsWith("data-jobpilot-"))
          .map((attribute) => attribute.name)
      ),
      styles: ["first_name", "last_name", "email"].map((id) => {
        const element = document.getElementById(id)!;
        const computed = getComputedStyle(element);
        return {
          id,
          inlineOutline: (element as HTMLElement).style.outline,
          inlineOutlineOffset: (element as HTMLElement).style.outlineOffset,
          computedOutline: computed.outline,
          computedOutlineColor: computed.outlineColor,
          computedOutlineStyle: computed.outlineStyle,
          computedOutlineWidth: computed.outlineWidth
        };
      }),
      observer: (window as any).__xa14ReviewMutations,
      widgetHostReadable: document.getElementById("jobpilot-assisted-apply")?.id ?? null,
      pageWindowInstanceVisible: Object.prototype.hasOwnProperty.call(window, "__jobpilotContentInstance"),
      fieldExpandos: ["first_name", "last_name", "email"].flatMap((id) =>
        Object.keys(document.getElementById(id)!).filter((key) => /jobpilot|xpertapply/i.test(key))
      ),
      submitted: (window as any).__xa11Submit
    }));
    const summary = await widget.summary();
    const cdp = await context.newCDPSession(page);
    const accessibility = await cdp.send("Accessibility.getFullAXTree");
    const accessibleNames = accessibility.nodes
      .map((node) => node.name?.value)
      .filter((value): value is string => typeof value === "string");
    const confirmation = Number(/Needs confirmation:\s*(\d+)/.exec(summary.counts)?.[1] ?? -1);
    console.log(`XA11_MV3 ${JSON.stringify({ pageState, summary, confirmation, accessibleNames })}`);

    expect(pageState.submitted).toBe(0);
    expect(pageState).toMatchObject({
      review: 0,
      verified: 0,
      privateMarkers: [],
      pageWindowInstanceVisible: false,
      fieldExpandos: []
    });
    expect(pageState.styles.map((style) => style.inlineOutline)).toEqual(["", "", ""]);
    expect(pageState.styles.map((style) => style.inlineOutlineOffset)).toEqual(["", "", ""]);
    expect(pageState.observer.style).toBe(0);
    expect(accessibleNames.filter((name) => name === "XpertApply field status: Needs review")).toHaveLength(2);
    expect(accessibleNames.filter((name) => name === "XpertApply field status: Verified")).toHaveLength(1);
    expect(summary.count).toBe("Filled 1 of 3");
    expect(summary.message).toContain("2 filled fields need your confirmation");
    expect(confirmation).toBe(2);
    await page.close();
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
