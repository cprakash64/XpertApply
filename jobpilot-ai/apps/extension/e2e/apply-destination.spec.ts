import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * URL-first application navigation, against fixtures that REJECT untrusted
 * events.
 *
 * Every CTA here checks `event.isTrusted` and ignores script-dispatched
 * clicks — the real production constraint an extension cannot work around. A
 * fixture that accepts any dispatched click (as the earlier ones did) proves
 * nothing about a live site, which is why the pointer-sequence fix passed tests
 * and still failed on TikTok.
 *
 * So: no test here may pass by dispatching a click. Passing requires either a
 * safely extracted destination, or an honest user-gesture fallback.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = fs.readFileSync(path.join(here, "bundle", "harness.js"), "utf8");
const BASE = pathToFileURL(path.join(here, "fixtures", "listing-untrusted.html")).href;

type Harness = Record<string, (...args: unknown[]) => unknown>;

async function load(page: Page, query: string) {
  // Served over https-like file:// is fine for structure, but destination
  // validation needs a real host, so route a stable https origin to the file.
  await page.route("https://careers.example.test/**", async (route) => {
    const body = fs.readFileSync(path.join(here, "fixtures", "listing-untrusted.html"), "utf8");
    await route.fulfill({ status: 200, contentType: "text/html", body });
  });
  await page.goto(`https://careers.example.test/careers/job/12345${query}`);
  await page.addScriptTag({ content: HARNESS });
}

const call = (page: Page, method: string, arg?: unknown) =>
  page.evaluate(
    ([name, value]) =>
      (window as unknown as { JobPilotHarness: Harness }).JobPilotHarness[name as string](value),
    [method, arg] as const
  );

function fixture(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as {
        __jobpilotFixture: { clicks: string[]; untrustedRejected: number };
      }).__jobpilotFixture
  );
}

test.describe("destination extraction", () => {
  test("a direct anchor href needs no synthetic click", async ({ page }) => {
    await load(page, "?cta=anchor");
    const result = (await call(page, "destination")) as {
      ok: boolean;
      destination: { url: string; source: string; opensNewTab: boolean };
    };
    expect(result.ok).toBe(true);
    expect(result.destination.source).toBe("anchor_href");
    expect(result.destination.url).toBe("https://careers.example.test/careers/apply/12345");
    expect(result.destination.opensNewTab).toBe(false);

    // Nothing was clicked to learn this.
    expect((await fixture(page)).clicks).toEqual([]);
  });

  test("a button wrapped in an anchor resolves to the anchor's destination", async ({ page }) => {
    await load(page, "?cta=ancestor-anchor");
    const result = (await call(page, "destination")) as {
      ok: boolean;
      destination: { url: string; source: string };
    };
    expect(result.ok).toBe(true);
    // The wrapping anchor and the inner button are equivalent — same
    // destination — so the tie-break takes the first in document order, which
    // is the anchor itself. Either source is correct; the URL is what matters.
    expect(["anchor_href", "ancestor_anchor"]).toContain(result.destination.source);
    expect(result.destination.url).toBe("https://careers.example.test/careers/apply/12345");
  });

  test("target=_blank is reported so the service worker opens a new tab", async ({ page }) => {
    await load(page, "?cta=anchor-blank");
    const result = (await call(page, "destination")) as {
      ok: boolean;
      destination: { opensNewTab: boolean; url: string };
    };
    expect(result.ok).toBe(true);
    expect(result.destination.opensNewTab).toBe(true);
  });

  test("a data-url attribute is accepted", async ({ page }) => {
    await load(page, "?cta=data-url");
    const result = (await call(page, "destination")) as {
      ok: boolean;
      destination: { source: string; url: string };
    };
    expect(result.ok).toBe(true);
    expect(result.destination.source).toBe("data_attribute");
    expect(result.destination.url).toBe("https://careers.example.test/careers/apply/12345");
  });

  test("a CTA inside an open shadow root is found and resolved", async ({ page }) => {
    await load(page, "?cta=shadow");
    // The old scan stopped at the shadow boundary and reported no CTA at all.
    const selected = (await call(page, "selected")) as { name: string } | null;
    expect(selected?.name).toBe("Apply to this job");
    const result = (await call(page, "destination")) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  test("two identical CTAs in main content are not treated as ambiguous", async ({ page }) => {
    await load(page, "?cta=duplicate");
    // This is the shape that made the old tie-break return null, leaving the
    // page classified as "form still loading" and stalling the whole run.
    const classification = (await call(page, "classify")) as { state: string };
    expect(classification.state).toBe("apply_cta_detected");
    const selected = (await call(page, "selected")) as { name: string } | null;
    expect(selected?.name).toBe("Apply to this job");
    const result = (await call(page, "destination")) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

test.describe("destination validation", () => {
  test("javascript: and other unsafe schemes are rejected", async ({ page }) => {
    await load(page, "?cta=unsafe-scheme");
    const result = (await call(page, "destination")) as { ok: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("UNSAFE_SCHEME");

    for (const raw of ["javascript:alert(1)", "data:text/html,x", "blob:https://x/y", "file:///etc/passwd"]) {
      const check = (await call(page, "validateDestination", raw)) as { ok: boolean; reason: string };
      expect(check.ok, raw).toBe(false);
      expect(check.reason, raw).toBe("UNSAFE_SCHEME");
    }
  });

  test("a cross-employer destination is rejected", async ({ page }) => {
    await load(page, "?cta=cross-employer");
    const result = (await call(page, "destination")) as { ok: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HOST_NOT_ALLOWED");
  });

  test("credential-bearing URLs are rejected", async ({ page }) => {
    await load(page, "?cta=anchor");
    const check = (await call(page, "validateDestination", "https://user:pw@careers.example.test/apply")) as {
      ok: boolean;
      reason: string;
    };
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("CREDENTIALS_IN_URL");
  });

  test("plain http on a public host is rejected", async ({ page }) => {
    await load(page, "?cta=anchor");
    const check = (await call(page, "validateDestination", "http://careers.example.test/apply")) as {
      ok: boolean;
      reason: string;
    };
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("UNSAFE_SCHEME");
  });

  test("a known ATS host is allowed even though it is a different domain", async ({ page }) => {
    await load(page, "?cta=anchor");
    for (const url of [
      "https://job-boards.greenhouse.io/acme/jobs/1",
      "https://jobs.lever.co/acme/1",
      "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1"
    ]) {
      const check = (await call(page, "validateDestination", url)) as { ok: boolean };
      expect(check.ok, url).toBe(true);
    }
  });

  test("a lookalike host is not mistaken for an allowed ATS", async ({ page }) => {
    await load(page, "?cta=anchor");
    const check = (await call(page, "validateDestination", "https://greenhouse.io.evil.test/apply")) as {
      ok: boolean;
      reason: string;
    };
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("HOST_NOT_ALLOWED");
  });
});

test.describe("user-gesture fallback", () => {
  test("a script-only CTA yields no destination and rejects synthetic clicks", async ({ page }) => {
    await load(page, "?cta=script-only");

    // There is a CTA, and it is correctly chosen…
    const selected = (await call(page, "selected")) as { name: string } | null;
    expect(selected?.name).toBe("Apply to this job");

    // …but no destination can be extracted.
    const result = (await call(page, "destination")) as { ok: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NO_URL");

    // And synthetic activation is genuinely ignored — proving why the
    // pointer-sequence approach could never be the primary strategy.
    await call(page, "activate");
    await page.waitForTimeout(300);
    const state = await fixture(page);
    expect(state.untrustedRejected).toBeGreaterThan(0);
    expect(state.clicks).toContain("primary-apply:untrusted-ignored");
    expect(state.clicks).not.toContain("primary-apply:trusted");
  });

  test("a real user click on the same control IS honoured", async ({ page }) => {
    await load(page, "?cta=script-only");
    // Playwright's click delivers trusted input, like the user's own click in
    // the "Open application form" fallback.
    await page.locator("#primary-apply").click();
    const state = await fixture(page);
    expect(state.clicks).toContain("primary-apply:trusted");
  });
});

test.describe("cookie overlay", () => {
  test("a banner that does not cover the CTA is left alone", async ({ page }) => {
    await load(page, "?cta=anchor&cover=none");
    expect(await call(page, "ctaObstructed")).toBe(false);
    const state = await fixture(page);
    expect(state.clicks).not.toContain("cookie-accept");
    expect(state.clicks).not.toContain("cookie-decline");
  });

  test("a banner that covers the CTA offers Decline all, never Accept all", async ({ page }) => {
    await load(page, "?cta=anchor&cover=1");
    expect(await call(page, "ctaObstructed")).toBe(true);
    expect(await call(page, "consentDismissal")).toBe("Decline all");
  });

  test("a covering banner does not block URL-first navigation", async ({ page }) => {
    // An overlay stops a CLICK, not a URL. The destination is still resolvable,
    // so consent never needs to be touched to advance.
    await load(page, "?cta=anchor&cover=1");
    const result = (await call(page, "destination")) as { ok: boolean };
    expect(result.ok).toBe(true);
    const state = await fixture(page);
    expect(state.clicks).not.toContain("cookie-accept");
  });
});

test.describe("safety", () => {
  test("another job's Apply is never selected", async ({ page }) => {
    await load(page, "?cta=anchor");
    const candidates = (await call(page, "candidates")) as { name: string }[];
    for (const candidate of candidates) {
      expect(candidate.name).not.toMatch(/other roles/i);
    }
  });

  test("the header Apply is never selected when a job CTA exists", async ({ page }) => {
    await load(page, "?cta=anchor");
    const selected = (await call(page, "selected")) as { name: string } | null;
    expect(selected?.name).toBe("Apply to this job");
  });
});
