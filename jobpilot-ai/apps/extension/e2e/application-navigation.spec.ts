import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * Application navigation in a REAL browser, against the production classifier
 * and the production click dispatcher.
 *
 * The defect these lock down: the extension classified the listing correctly
 * and selected the right CTA, then delivered the click with
 * `HTMLElement.click()` — a bare `click` event with no preceding pointer
 * events. Pointer-driven employer pages ignore that, nothing navigated, no
 * exception was thrown, and the run eventually failed with "The application
 * form did not render in time."
 *
 * The fixtures reproduce that behaviour exactly: their Apply handler checks for
 * a preceding `pointerdown` and refuses a synthetic click, so a regression to
 * `.click()` fails these tests instead of passing them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = fs.readFileSync(path.join(here, "bundle", "harness.js"), "utf8");
const TIKTOK = pathToFileURL(path.join(here, "fixtures", "listing-tiktok.html")).href;
const VARIANTS = pathToFileURL(path.join(here, "fixtures", "listing-variants.html")).href;

type Harness = Record<string, (...args: unknown[]) => unknown>;

async function load(page: Page, url: string) {
  await page.goto(url);
  await page.addScriptTag({ content: HARNESS });
}

function fixtureState(page: Page) {
  return page.evaluate(() => {
    const f = (window as unknown as { __jobpilotFixture: { clicks: string[] } }).__jobpilotFixture;
    return {
      clicks: f.clicks,
      url: location.href,
      formPresent: Boolean(document.querySelector("#application-form")),
      loginPresent: Boolean(document.querySelector("#login-form")),
      iframePresent: Boolean(document.querySelector("#grnhse_iframe"))
    };
  });
}

const call = (page: Page, method: string) =>
  page.evaluate(
    (name) => (window as unknown as { JobPilotHarness: Harness }).JobPilotHarness[name](),
    method
  );

test.describe("TikTok-style listing page", () => {
  test("classifies as a listing with an Apply CTA, not as a loading form", async ({ page }) => {
    await load(page, TIKTOK);
    const classification = (await call(page, "classify")) as { state: string; candidateName: string };
    expect(classification.state).toBe("apply_cta_detected");
    expect(classification.candidateName).toBe("Apply to this job");
  });

  test("prefers the job-content CTA over the header Apply and the sticky duplicate", async ({ page }) => {
    await load(page, TIKTOK);
    const candidates = (await call(page, "candidates")) as { name: string; score: number }[];
    // The header "Apply" is excluded outright; both job CTAs are eligible and
    // the one inside the job content scores highest.
    expect(candidates.map((c) => c.name)).not.toContain("Apply");
    expect(candidates[0].name).toBe("Apply to this job");
    expect(candidates[0].score).toBeGreaterThan(candidates[1].score);

    const selected = (await call(page, "selected")) as { name: string };
    expect(selected.name).toBe("Apply to this job");
  });

  test("activation opens the application and mounts the form", async ({ page }) => {
    await load(page, TIKTOK);
    const outcome = (await call(page, "activate")) as { ok: boolean; method: string };
    expect(outcome.ok).toBe(true);
    expect(outcome.method).toBe("pointer_sequence");

    await page.waitForSelector("#application-form", { timeout: 5000 });
    const state = await fixtureState(page);
    expect(state.formPresent).toBe(true);
    expect(state.url).toContain("step=application");
    // The CTA was really activated — not merely "no exception thrown".
    expect(state.clicks).toContain("primary-apply");
    expect(state.clicks).not.toContain("primary-apply:ignored-no-pointer");
  });

  test("clicks exactly one CTA, once", async ({ page }) => {
    await load(page, TIKTOK);
    await call(page, "activate");
    await page.waitForSelector("#application-form", { timeout: 5000 });
    const state = await fixtureState(page);
    expect(state.clicks.filter((c) => c === "primary-apply")).toHaveLength(1);
    expect(state.clicks.filter((c) => c === "sticky-apply")).toHaveLength(0);
  });

  test("never clicks Accept all, the header Apply, or another job's Apply", async ({ page }) => {
    await load(page, TIKTOK);
    await call(page, "activate");
    await page.waitForSelector("#application-form", { timeout: 5000 });
    const state = await fixtureState(page);
    expect(state.clicks).not.toContain("cookie-accept");
    expect(state.clicks).not.toContain("header-apply");
  });

  test("never activates the final Submit application control", async ({ page }) => {
    await load(page, TIKTOK);
    await call(page, "activate");
    await page.waitForSelector("#application-form", { timeout: 5000 });
    // The application is now mounted and DOES contain a submit button. Ask the
    // classifier again: it must never propose that control.
    const candidates = (await call(page, "candidates")) as { name: string }[];
    for (const candidate of candidates) {
      expect(candidate.name.toLowerCase()).not.toContain("submit");
    }
    const state = await fixtureState(page);
    expect(state.clicks.some((c) => c.includes("submit"))).toBe(false);
  });

  test("a bottom cookie bar that does not cover the CTA is left alone", async ({ page }) => {
    await load(page, TIKTOK);
    // The banner exists (page is "obstructed"), but hit-testing says the CTA
    // itself is reachable, so consent must not be touched.
    const classification = (await call(page, "classify")) as { obstructed: boolean };
    expect(classification.obstructed).toBe(true);
    expect(await call(page, "ctaObstructed")).toBe(false);

    await call(page, "activate");
    await page.waitForSelector("#application-form", { timeout: 5000 });
    const state = await fixtureState(page);
    expect(state.clicks).not.toContain("cookie-accept");
    expect(state.clicks).not.toContain("cookie-decline");
  });

  test("after the application mounts, the page is no longer a listing", async ({ page }) => {
    await load(page, TIKTOK);
    await call(page, "activate");
    await page.waitForSelector("#application-form", { timeout: 5000 });
    const classification = (await call(page, "classify")) as { state: string };
    expect(classification.state).toBe("application_form_ready");
  });

  test("the CTA fingerprint is stable, so activation is idempotent", async ({ page }) => {
    await load(page, TIKTOK);
    const first = await call(page, "ctaFingerprint");
    const second = await call(page, "ctaFingerprint");
    expect(first).toBe(second);
    expect(String(first)).toContain("Apply to this job");
  });
});

test.describe("variants", () => {
  test("an overlay that really covers the CTA is declined, never accepted", async ({ page }) => {
    await load(page, `${VARIANTS}?variant=blocked`);
    expect(await call(page, "ctaObstructed")).toBe(true);
    expect(await call(page, "consentDismissal")).toBe("Decline all");

    // Dismiss via the safe control, then activate.
    await page.evaluate(() => {
      const h = (window as unknown as { JobPilotHarness: Harness }).JobPilotHarness;
      const control = document.getElementById("overlay-decline")!;
      void h;
      control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await call(page, "activate");
    await page.waitForSelector("#application-form", { timeout: 5000 });

    const state = await fixtureState(page);
    expect(state.clicks).toContain("overlay-decline");
    expect(state.clicks).not.toContain("overlay-accept");
  });

  test("a consent-only banner offers no safe dismissal", async ({ page }) => {
    await load(page, `${VARIANTS}?variant=consent-only`);
    expect(await call(page, "ctaObstructed")).toBe(true);
    // Only "Accept all" remains, which JobPilot will not choose for the user.
    expect(await call(page, "consentDismissal")).toBeNull();
  });

  test("same-tab SPA route change is detected", async ({ page }) => {
    await load(page, `${VARIANTS}?variant=same-tab`);
    await call(page, "activate");
    await page.waitForSelector("#application-form", { timeout: 5000 });
    const state = await fixtureState(page);
    expect(state.url).toContain("step=application");
    expect(state.formPresent).toBe(true);
  });

  test("a login page after Apply is classified as auth, not as a missing form", async ({ page }) => {
    await load(page, `${VARIANTS}?variant=login`);
    await call(page, "activate");
    await page.waitForSelector("#login-form", { timeout: 5000 });

    const classification = (await call(page, "classify")) as { state: string };
    expect(classification.state).toBe("employer_auth_required");
    const state = await fixtureState(page);
    expect(state.loginPresent).toBe(true);
  });

  test("an iframe application is detected as a transition", async ({ page }) => {
    await load(page, `${VARIANTS}?variant=iframe`);
    await call(page, "activate");
    await page.waitForSelector("#grnhse_iframe", { timeout: 5000 });
    const state = await fixtureState(page);
    expect(state.iframePresent).toBe(true);
  });

  test("a CTA click with no effect leaves the page classifiable for the manual fallback", async ({ page }) => {
    await load(page, `${VARIANTS}?variant=no-effect`);
    const outcome = (await call(page, "activate")) as { ok: boolean };
    // The dispatch itself succeeded…
    expect(outcome.ok).toBe(true);
    await page.waitForTimeout(400);

    // …but nothing happened, and the CTA is still the right one to offer the
    // user manually.
    const state = await fixtureState(page);
    expect(state.formPresent).toBe(false);
    expect(state.clicks).toContain("primary-apply");
    const selected = (await call(page, "selected")) as { name: string };
    expect(selected.name).toBe("Apply to this job");
  });
});

test.describe("regression guard", () => {
  test("a bare element.click() does NOT open the application", async ({ page }) => {
    // This is the old behaviour. If someone reverts the dispatcher, the tests
    // above go red — this one documents exactly why.
    await load(page, TIKTOK);
    await page.evaluate(() => {
      const el = document.querySelector('[data-role="primary-apply"]') as HTMLElement;
      el.scrollIntoView({ block: "center" });
      el.focus?.();
      el.click();
    });
    await page.waitForTimeout(400);
    const state = await fixtureState(page);
    expect(state.formPresent).toBe(false);
    expect(state.clicks).toContain("primary-apply:ignored-no-pointer");
  });
});
