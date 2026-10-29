import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The redesigned Applications page (master-detail), the removal of the sidebar theme control and the light default,
 * in a real browser. The API is mocked with synthetic data and keeps the status it is given, so "the change is saved on
 * the server" is checked by reloading, not by trusting the screen.
 *
 *   SHOT_DIR=/path npx playwright test e2e/applications-redesign.spec.ts -g screenshots   # also writes review screenshots
 */
const PDF = Buffer.from("%PDF-1.4\n%synthetic\n");
const AXE = require.resolve("axe-core/axe.min.js");

const job = (id: number, company: string, title: string, fit: number | null) => ({
  id, title, company, company_domain: "", company_logo_url: "", company_logo_proxy_path: null, location: id % 2 ? "Remote" : "New York, NY",
  workplace_type: "remote", employment_type: "full-time", posted_at: "2026-07-01T12:00:00Z", application_url: `https://jobs.example.test/${id}`,
  match: fit === null ? null : { fit_score: fit }
});
const doc = (path: string) => ({ id: 1, title: "t", created_at: "2026-07-20T12:00:00Z", prepared_for_application: true, attached_by_extension: false, frozen: true, formats: ["pdf", "docx"], download_path: path });

type Row = { id: number; job_id: number; status: string; applied_at: string; company: string; title: string; fit: number | null; docs: boolean };
const SEED: Row[] = [
  { id: 1, job_id: 11, status: "applied", applied_at: "2026-07-24T12:00:00Z", company: "Plaid", title: "Senior Machine Learning Engineer", fit: 88, docs: true },
  { id: 2, job_id: 12, status: "interview", applied_at: "2026-07-22T12:00:00Z", company: "Northstar Analytics", title: "Staff Backend Engineer, Platform Reliability", fit: 91, docs: false },
  { id: 3, job_id: 13, status: "offer", applied_at: "2026-07-20T12:00:00Z", company: "Acme", title: "Software Engineer", fit: null, docs: true },
  { id: 4, job_id: 14, status: "rejected", applied_at: "2026-07-18T12:00:00Z", company: "Globex", title: "Data Engineer", fit: 62, docs: false },
  { id: 5, job_id: 15, status: "applied", applied_at: "2026-07-15T12:00:00Z", company: "Initech", title: "Frontend Engineer", fit: 74, docs: false }
];

async function install(page: Page, opts: { rows?: Row[]; fail?: "list" | "update" } = {}) {
  const rows = (opts.rows ?? SEED).map((row) => ({ ...row }));
  const puts: Array<{ job: number; status: string }> = [];
  await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("jobpilot_token", "synthetic-e2e-token"); } });
  // The built bundle talks to whichever API origin it was compiled with (8000 by default, 8001 in some local builds).
  await page.route((url) => url.port === "8000" || url.port === "8001", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Playwright answers the CORS preflight for a fulfilled route itself; only the response headers are needed.
    const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "Content-Disposition" };
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (url.pathname === "/jobs/tracker/submitted") {
      if (opts.fail === "list") return json({ detail: "psycopg2.OperationalError" }, 500);
      return json({ applications: rows.map((row) => ({
        id: row.id, job_id: row.job_id, status: row.status, applied_at: row.applied_at, created_at: row.applied_at, updated_at: row.applied_at,
        applied_source: "user_confirmed", application_url: `https://apply.example.test/${row.id}`,
        documents: row.docs ? { resume: doc(`/jobs/tracker/${row.id}/documents/resume`), cover_letter: doc(`/jobs/tracker/${row.id}/documents/cover-letter`) } : { resume: null, cover_letter: null },
        documents_availability: row.docs ? "frozen" : "none", job: job(row.job_id, row.company, row.title, row.fit)
      })) });
    }
    const put = /^\/jobs\/(\d+)\/tracker$/.exec(url.pathname);
    if (put && request.method() === "PUT") {
      if (opts.fail === "update") return json({ detail: "boom" }, 500);
      const status = JSON.parse(request.postData() ?? "{}").status as string;
      puts.push({ job: Number(put[1]), status });
      const row = rows.find((r) => r.job_id === Number(put[1]));
      if (row) row.status = status;
      return json({ tracker: { id: row?.id, job_id: Number(put[1]), status } });
    }
    if (/\/documents\//.test(url.pathname)) {
      return route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="Plaid_Resume_2026-07-24.pdf"' }, body: PDF });
    }
    if (url.pathname === "/auth/me") return json({ id: 1, email: "taylor@example.test", full_name: "Taylor Example" });
    return json({});
  });
  return { puts };
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const luminance = (rgb: string) => { const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const list = (page: Page) => page.getByRole("list", { name: "Tracked applications" });

async function axeViolations(page: Page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return result.violations.map((v: { id: string; impact: string; nodes: Array<{ target: unknown }> }) => `${v.impact}:${v.id}:${v.nodes.length} ${JSON.stringify(v.nodes[0]?.target)}`);
  });
}

test.describe("Applications page, desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("header, filters, two-column master-detail, and no statistic cards", async ({ page }) => {
    await install(page);
    await page.goto("/tracker");
    await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Workspace");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).locator('[aria-current="page"]')).toHaveText("Applications");
    await expect(page.getByText("Your job search", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Find more jobs" })).toHaveAttribute("href", "/jobs");
    for (const name of ["All", "Applied", "Interviews", "Offers", "Rejected"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(page.getByLabel("Search applications")).toBeVisible();
    await expect(page.getByText("Total tracked")).toHaveCount(0);

    await expect(list(page).getByRole("button")).toHaveCount(5);
    // Newest first, and the newest is open.
    await expect(list(page).getByRole("button").first()).toContainText("Senior Machine Learning Engineer");
    await expect(list(page).getByRole("button").first()).toHaveAttribute("aria-current", "true");
    const detail = page.getByRole("region", { name: "Selected application" });
    await expect(detail.getByRole("heading", { level: 2, name: "Senior Machine Learning Engineer" })).toBeVisible();
    await expect(detail.getByText("88% fit")).toBeVisible();
    await expect(detail.getByText(/not an employer receipt/i)).toBeVisible();

    // Roughly 55 / 45, side by side.
    const l = await page.locator("#tracked-applications-heading").locator("xpath=ancestor::section[1]").boundingBox();
    const d = await detail.boundingBox();
    expect(l && d && d.x > l.x + l.width - 1).toBeTruthy();
    const ratio = l!.width / (l!.width + d!.width);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.6);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("the sidebar has no theme control; Settings > Appearance does", async ({ page }) => {
    await install(page);
    await page.goto("/tracker");
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toHaveCount(0);
    await expect(page.getByText("Theme", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Log out" }).first()).toBeVisible();
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toHaveCount(1);
    await expect(page.getByRole("radio", { name: "Light theme" })).toBeChecked();   // the approved default
  });

  test("a new user gets light even when the OS prefers dark; an explicit choice applies in the app only", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await install(page);
    await page.goto("/tracker");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(luminance(await bg(page))).toBeGreaterThan(0.85);

    await page.goto("/settings");
    await page.getByRole("radio", { name: "Dark theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.goto("/tracker");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(luminance(await bg(page))).toBeLessThan(0.3);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toHaveCount(0);   // still not in the sidebar
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");        // persisted

    await page.goto("/settings");
    await page.getByRole("radio", { name: "Match system theme" }).click();           // explicit system choice follows the OS
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("status changes are sent to the server and survive a reload", async ({ page }) => {
    const { puts } = await install(page);
    await page.goto("/tracker");
    await list(page).getByRole("button", { name: /Frontend Engineer/ }).click();
    await page.getByLabel("Update status for Frontend Engineer").selectOption("interview");
    await expect(page.getByRole("status").filter({ hasText: "Moved to Interview." })).toBeVisible();
    expect(puts).toEqual([{ job: 15, status: "interview" }]);
    await page.reload();
    await page.getByRole("button", { name: "Interviews" }).click();
    await expect(list(page).getByRole("button", { name: /Frontend Engineer/ })).toBeVisible();
    await expect(list(page).getByRole("button")).toHaveCount(2);
  });

  test("selection, filtering, search and sorting", async ({ page }) => {
    await install(page);
    await page.goto("/tracker");
    await list(page).getByRole("button", { name: /Data Engineer/ }).click();
    await expect(page.getByRole("region", { name: "Selected application" }).getByRole("heading", { level: 2 })).toHaveText("Data Engineer");
    await page.reload();
    await expect(list(page).getByRole("button", { name: /Data Engineer/ })).toHaveAttribute("aria-current", "true");   // remembered for the tab
    await page.getByRole("button", { name: "Applied", exact: true }).click();
    await expect(list(page).getByRole("button")).toHaveCount(2);
    await page.getByLabel("Sort applications").selectOption("oldest");
    await expect(list(page).getByRole("button").first()).toContainText("Frontend Engineer");
    await page.getByLabel("Search applications").fill("plaid");
    await expect(list(page).getByRole("button")).toHaveCount(1);
    await page.getByLabel("Search applications").fill("zzz");
    await expect(page.getByText("No applications found")).toBeVisible();
    await expect(page.getByRole("link", { name: "Find jobs", exact: true })).toHaveCount(0);   // the sidebar says "Find Jobs"; exact is case-sensitive
  });

  test("keyboard: rows are tab stops that select with Enter, focus is visible, and the status select is reachable", async ({ page }) => {
    await install(page);
    await page.goto("/tracker");
    const second = list(page).getByRole("button", { name: /Staff Backend Engineer/ });
    await second.focus();
    await expect(second).toBeFocused();
    const outline = await second.evaluate((el) => { const s = getComputedStyle(el); return `${s.outlineStyle}|${s.outlineWidth}|${s.boxShadow}`; });
    expect(outline).not.toMatch(/^none\|0px\|none$/);
    await page.keyboard.press("Enter");
    await expect(second).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("region", { name: "Selected application" }).getByRole("heading", { level: 2 })).toContainText("Staff Backend Engineer");
    await expect(page.getByLabel(/Update status for Staff Backend/)).toBeEnabled();
  });

  test("downloads the prepared resume and cover letter, with the PDF and Word choices, from the details", async ({ page }) => {
    await install(page);
    await page.goto("/tracker");
    const detail = page.getByRole("region", { name: "Selected application" });
    await expect(detail.getByRole("button", { name: /Download cover letter as Word document/i })).toBeVisible();
    const pdf = page.waitForEvent("download");
    await detail.getByRole("button", { name: /Download resume for/i }).click();
    const file = await pdf;
    expect(file.suggestedFilename()).toBe("Plaid_Resume_2026-07-24.pdf");
    expect(readFileSync((await file.path())!).equals(PDF)).toBe(true);
    await expect(detail.getByText(/Not confirmed as uploaded to the employer/i).first()).toBeVisible();
    await expect(detail.getByRole("link", { name: /View job posting/i })).toHaveAttribute("href", "https://jobs.example.test/11");
    await expect(detail.getByRole("link", { name: /Application link/i })).toHaveAttribute("href", "https://apply.example.test/1");
  });

  test("empty and error states", async ({ page }) => {
    await install(page, { rows: [] });
    await page.goto("/tracker");
    await expect(page.getByRole("heading", { name: "No applications yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Find jobs", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Tracked applications" })).toHaveCount(0);

    const other = await page.context().newPage();
    await install(other, { fail: "list" });
    await other.goto("/tracker");
    await expect(other.getByRole("alert").filter({ hasText: /couldn.t load your applications/i })).toBeVisible();
    expect(await other.locator("body").innerText()).not.toMatch(/psycopg2|OperationalError/);
  });

  test("a failed status update keeps the old status and says so", async ({ page }) => {
    await install(page, { fail: "update" });
    await page.goto("/tracker");
    await page.getByLabel("Update status for Senior Machine Learning Engineer").selectOption("offer");
    await expect(page.getByRole("alert").filter({ hasText: /couldn.t update that application/i })).toBeVisible();
    await expect(list(page).getByRole("button").first()).not.toContainText("Offer");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`no serious or critical accessibility violations (${scheme})`, async ({ page }) => {
      await install(page);
      await page.addInitScript((value) => localStorage.setItem("xa-theme", value), scheme);
      await page.goto("/tracker");
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await expect(list(page).getByRole("button").first()).toBeVisible();
      await page.waitForTimeout(300);
      const found = await axeViolations(page);
      expect(found.filter((v: string) => /^(serious|critical):/.test(v)), found.join("\n")).toEqual([]);
    });
  }
});

test.describe("Applications page, responsive", () => {
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`no horizontal overflow at ${width}px (light and dark)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await install(page);
      for (const scheme of ["light", "dark"]) {
        await page.addInitScript((value) => localStorage.setItem("xa-theme", value), scheme);
        await page.goto("/tracker");
        await expect(list(page).getByRole("button").first()).toBeVisible();
        expect(await overflow(page), `${scheme} list`).toBeLessThanOrEqual(0);
        if (width < 768) {
          await list(page).getByRole("button").first().click();
          await expect(page.getByRole("region", { name: "Selected application" })).toBeVisible();
          expect(await overflow(page), `${scheme} details`).toBeLessThanOrEqual(0);
        }
      }
    });
  }

  test("phone: the list first, details on selection, and a way back", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await install(page);
    await page.goto("/tracker");
    const detail = page.getByRole("region", { name: "Selected application" });
    await expect(list(page)).toBeVisible();
    await expect(detail).toBeHidden();
    await list(page).getByRole("button", { name: /Staff Backend Engineer/ }).click();
    await expect(detail).toBeVisible();
    await expect(list(page)).toBeHidden();
    await expect(detail.getByRole("heading", { level: 2 })).toContainText("Staff Backend Engineer");
    await detail.getByRole("button", { name: /All applications/i }).click();
    await expect(list(page)).toBeVisible();
    await expect(detail).toBeHidden();
    // The row that was open is still the current one.
    await expect(list(page).getByRole("button", { name: /Staff Backend Engineer/ })).toHaveAttribute("aria-current", "true");
  });

  for (const width of [768, 900, 1024]) {
    test(`tablet ${width}px: both panels fit side by side without clipping, and the document buttons stay on one row`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await install(page);
      await page.goto("/tracker");
      const detail = page.getByRole("region", { name: "Selected application" });
      await expect(list(page)).toBeVisible();
      await expect(detail).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const [l, d] = [await list(page).boundingBox(), await detail.boundingBox()];
      expect(d!.x).toBeGreaterThan(l!.x + l!.width - 1);                              // side by side
      expect(d!.x + d!.width).toBeLessThanOrEqual(width + 0.5);                        // nothing clipped
      const [r, w] = [await detail.getByRole("button", { name: /Download resume for/i }).boundingBox(), await detail.getByRole("button", { name: /Download resume as Word/i }).boundingBox()];
      expect(Math.abs(r!.y - w!.y)).toBeLessThan(4);
      expect(w!.height).toBeLessThan(56);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------- //
// Review screenshots. Only when SHOT_DIR is set, so a normal run never writes files.
// ---------------------------------------------------------------------------------------------------------------- //
test.describe("screenshots", () => {
  test.skip(!process.env.SHOT_DIR, "set SHOT_DIR to write the review screenshots");
  const dir = process.env.SHOT_DIR as string;
  const shot = async (page: Page, name: string, full = false) => { mkdirSync(dir, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: `${dir}/${name}.png`, fullPage: full }); };
  const pref = (page: Page, value: string) => page.addInitScript((v) => localStorage.setItem("xa-theme", v), value);

  test("capture", async ({ browser }) => {
    for (const scheme of ["light", "dark"] as const) {
      const desktop = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      await install(desktop); await pref(desktop, scheme); await desktop.goto("/tracker");
      await expect(list(desktop).getByRole("button").first()).toBeVisible();
      await shot(desktop, `applications-desktop-${scheme}`);
      if (scheme === "light") {
        await list(desktop).getByRole("button", { name: /Staff Backend Engineer/ }).click();
        await shot(desktop, "applications-selected-state-desktop-light");
        await desktop.goto("/settings"); await expect(desktop.getByRole("heading", { name: "Appearance" })).toBeVisible();
        await shot(desktop, "settings-appearance-light");
      }
      await desktop.context().close();

      const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
      await install(phone); await pref(phone, scheme); await phone.goto("/tracker");
      await expect(list(phone).getByRole("button").first()).toBeVisible();
      await shot(phone, `applications-mobile-${scheme}`);
      await list(phone).getByRole("button").first().click();
      await shot(phone, `applications-mobile-details-${scheme}`);
      await phone.context().close();
    }
    const empty = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await install(empty, { rows: [] }); await pref(empty, "light"); await empty.goto("/tracker");
    await expect(empty.getByRole("heading", { name: "No applications yet" })).toBeVisible();
    await shot(empty, "applications-empty-state-light");
    await empty.context().close();

    const side = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await install(side); await pref(side, "light"); await side.goto("/tracker");
    await expect(list(side).getByRole("button").first()).toBeVisible();
    await side.getByRole("navigation", { name: "Sections" }).locator("xpath=ancestor::aside[1]").screenshot({ path: `${dir}/sidebar-without-theme-control.png` }).catch(async () => { await shot(side, "sidebar-without-theme-control"); });
    await side.context().close();
  });
});
