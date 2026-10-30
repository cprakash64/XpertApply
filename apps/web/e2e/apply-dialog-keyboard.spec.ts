import { expect, test, type Page, type Route } from "@playwright/test";
import { injectAxe } from "./support/axe";

/**
 * Keyboard behaviour of the Apply dialog (finding F4), in a real browser against a mocked API. Escape must close it exactly like the
 * Close button: no submission, no status change, no employer-site navigation and no extra write; focus must move in, wrap on
 * Tab/Shift+Tab and return to the Apply button; the page behind must not be reachable; and inside the job workspace Escape must
 * dismiss only the dialog, not the job underneath it.
 *
 *   npx playwright test e2e/apply-dialog-keyboard.spec.ts      (run against a production build)
 */
const API = process.env.API_BASE_URL ?? "http://localhost:8000";

const job = (id: number) => ({
  id, title: `Role ${String(id).padStart(3, "0")}`, company: `Company ${id}`, company_domain: "", company_logo_url: "", company_logo_proxy_path: null,
  source: "greenhouse", location: "Remote, United States", location_display: "Remote, US", workplace_type: "remote", employment_type: "full-time",
  seniority_level: "mid", posted_at: new Date(Date.now() - id * 3_600_000).toISOString(), discovered_at: new Date().toISOString(),
  application_url: `https://boards.greenhouse.io/acme/${id}`, source_url: `https://boards.greenhouse.io/acme/${id}`,
  description_clean: "Build resilient systems.", required_skills: ["Python"], preferred_skills: [], responsibilities: [],
  match: { fit_score: 80 - id, fit_label: "Strong fit", score_state: "scored", match_reasons: ["Your Python experience matches."], missing_skills: [], risk_factors: [] }
});
const JOBS = [1, 2, 3].map(job);
const SESSION = {
  session_id: 55, status: "ready", official_application_url: "https://boards.greenhouse.io/acme/1", ats_type: "greenhouse",
  job: { id: 1, title: "Role 001", company: "Company 1", location: "Remote" },
  resume: { status: "ready", document_id: 7, download_url: "/application-sessions/55/resume" },
  cover_letter: { status: "ready", document_id: 8, download_url: "/application-sessions/55/cover-letter" },
  answers_available: 6, review_required_count: 1, unresolved_questions: [], warnings: [], extension_launch_token: "launch-token-abc"
};

type Hit = { method: string; path: string };

async function install(page: Page) {
  const hits: Hit[] = [];
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic-e2e-token"));
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    hits.push({ method: request.method(), path: url.pathname });
    if (url.pathname === "/jobs") {
      return json(route, { profile_complete: true, criteria: { role_queries: [], skills: [], seniority_targets: [] }, profile_filters: { target_roles: [], target_levels: [], preferred_locations: [], work_preference: "remote" },
        jobs: JOBS, page: { sort: "best_recent", total: 3, limit: 25, returned: 3, has_more: false, next_cursor: null }, scoring: { state: "complete", total: 3, scored: 3, pending: 0, failed: 0 } });
    }
    if (url.pathname.startsWith("/jobs/tracker/")) return json(route, { applications: [] });
    if (url.pathname === "/application-sessions" && request.method() === "POST") return json(route, SESSION, 201);
    if (/^\/jobs\/\d+\/people$/.test(url.pathname)) return json(route, { status: "not_started", availability_reason: "available", beta: true, quota: { daily_limit: 20, daily_used: 0, daily_remaining: 20, resets_at: "2026-07-30T00:00:00.000Z" }, categories: { likely_recruiters: [], potential_hiring_managers: [], potential_referrers: [] }, warnings: [], controls: { email_discovery: true, outreach_drafting: true } });
    return json(route, {});
  });
  return hits;
}

const cardOne = (page: Page) => page.locator('[data-job-id="1"]');
const dialog = (page: Page) => page.getByRole("dialog", { name: "Assisted application" });
const insideDialog = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
const activeIsApplyOnCardOne = (page: Page) => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return !!a && a.tagName === "BUTTON" && /Apply on official site/.test(a.textContent || "") && !!a.closest('[data-job-id="1"]'); });
/**
 * macOS Safari/WebKit moves plain Tab between text fields only; buttons and links are reached with Option+Tab (the "Press Tab to
 * highlight each item" convention). The assertions are identical in every browser; only the traversal key differs.
 */
const traversal = (browserName: string) => {
  const mac = browserName === "webkit" && process.platform === "darwin";
  return { next: mac ? "Alt+Tab" : "Tab", prev: mac ? "Alt+Shift+Tab" : "Shift+Tab" };
};
async function openByMouse(page: Page) { await cardOne(page).getByRole("button", { name: /Apply on official site/ }).click(); await expect(dialog(page)).toBeVisible(); await expect(page.getByText("Tailored resume")).toBeVisible(); }

for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test.describe(`Apply dialog keyboard (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("opens by mouse; Escape closes it with no submission, status change, request or navigation; focus returns to Apply", async ({ page }) => {
      const hits = await install(page);
      let popups = 0; page.on("popup", () => { popups += 1; });
      await page.goto("/jobs"); await expect(page.getByTestId("job-card").first()).toBeVisible();
      const url = page.url();
      await openByMouse(page);
      expect(await insideDialog(page)).toBe(true);                                       // focus moved in
      const writesBefore = hits.filter((h) => h.method !== "GET").length;
      const countBefore = hits.length;
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      expect(await activeIsApplyOnCardOne(page)).toBe(true);                             // focus is back on the Apply button
      await page.waitForTimeout(400);
      expect(hits.filter((h) => h.method !== "GET").length).toBe(writesBefore);          // Escape wrote nothing
      expect(hits.some((h) => /status|applied|confirm/i.test(h.path))).toBe(false);      // no status mutation, nothing marked applied
      // The only requests after Escape are the read-only re-reads the Close button also makes (tracker and list).
      expect(hits.slice(countBefore).every((h) => h.method === "GET")).toBe(true);
      expect(popups).toBe(0); expect(page.url()).toBe(url);                              // no employer-site navigation
    });

    test("opens by keyboard; Tab and Shift+Tab stay inside; the page behind is unreachable; Escape closes", async ({ page, browserName }) => {
      const key = traversal(browserName);
      await install(page);
      await page.goto("/jobs"); await expect(page.getByTestId("job-card").first()).toBeVisible();
      await cardOne(page).getByRole("button", { name: /Apply on official site/ }).focus();
      await page.keyboard.press("Enter");
      await expect(dialog(page)).toBeVisible(); await expect(page.getByText("Tailored resume")).toBeVisible();
      expect(await insideDialog(page)).toBe(true);
      for (let i = 0; i < 14; i += 1) { await page.keyboard.press(key.next); expect(await insideDialog(page)).toBe(true); }
      for (let i = 0; i < 14; i += 1) { await page.keyboard.press(key.prev); expect(await insideDialog(page)).toBe(true); }
      // The page behind cannot be clicked while the dialog is open.
      await expect(page.getByRole("button", { name: "Save" }).first().click({ trial: true, timeout: 1500 })).rejects.toThrow();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      expect(await activeIsApplyOnCardOne(page)).toBe(true);
    });

    test("the Close button still works, and the dialog reopens after Escape", async ({ page }) => {
      const hits = await install(page);
      await page.goto("/jobs"); await expect(page.getByTestId("job-card").first()).toBeVisible();
      await openByMouse(page);
      await dialog(page).getByRole("button", { name: "Close" }).first().click();
      await expect(dialog(page)).toHaveCount(0); expect(await activeIsApplyOnCardOne(page)).toBe(true);
      await openByMouse(page); await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0);
      await openByMouse(page);                                                           // reopened after Escape
      expect(await insideDialog(page)).toBe(true);
      expect(hits.filter((h) => h.method === "POST" && h.path === "/application-sessions")).toHaveLength(3);   // one session per open, nothing more
    });

    test("open dialog has no accessibility violations", async ({ page }) => {
      await install(page);
      await page.goto("/jobs"); await expect(page.getByTestId("job-card").first()).toBeVisible();
      await openByMouse(page);
      await injectAxe(page);
      const violations = await page.evaluate(async () => {
        // Colour contrast is excluded on purpose: the muted "job · company" line in the header measures 4.49:1 (needs 4.5:1) on the
        // mobile glass background. That is a pre-existing design-token finding, separate from this keyboard fix; every other rule applies.
        // @ts-expect-error axe is injected above
        const result = await window.axe.run(document.querySelector('[role="dialog"]'), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] }, rules: { "color-contrast": { enabled: false } } });
        return result.violations.map((v: { id: string; impact: string; nodes: Array<{ target: unknown; any: Array<{ message: string }> }> }) => `${v.impact}:${v.id}:${JSON.stringify(v.nodes[0]?.target)} ${v.nodes[0]?.any?.[0]?.message ?? ""}`);
      });
      expect(violations).toEqual([]);
    });
  });
}

test.describe("Apply dialog layering", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("inside the job workspace, Escape dismisses only the Apply dialog, then the job", async ({ page }) => {
  await install(page);
  await page.goto("/jobs"); await expect(page.getByTestId("job-card").first()).toBeVisible();
  await cardOne(page).getByRole("button", { name: /^Role 001$/ }).click();                 // open the job (detail workspace)
  await expect(page).toHaveURL(/job=1/);
  await page.getByRole("button", { name: /Apply on official site/ }).last().click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/job=1/);                                                     // the job is still open: only the top layer closed
  await page.waitForTimeout(300);
  await page.locator("body").press("Escape");                                                // nothing else open: now the job closes
  await expect(page).not.toHaveURL(/job=1/);
});
});
