import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Tracker document downloads in a real browser. The API is mocked; the point is what the BROWSER does: a real file download with
 * the server's filename and bytes, readable errors, and no storage path or token in the page or the URL bar.
 */
const API = process.env.API_BASE_URL ?? "http://localhost:8000";
const PDF_BYTES = Buffer.from("%PDF-1.4\n%synthetic tracker resume\n");

const job = (id: number, company: string) => ({
  id, title: "Senior Machine Learning Engineer", company, company_domain: "", company_logo_url: "", location: "Remote",
  workplace_type: "remote", employment_type: "full-time", posted_at: new Date().toISOString(), application_url: "https://x.test/1", match: null
});
const doc = (path: string) => ({ id: 1, title: "t", created_at: "2026-07-20T12:00:00Z", prepared_for_application: true, attached_by_extension: false, frozen: true, formats: ["pdf", "docx"], download_path: path });

async function install(page: Page, opts: { status?: number; documents?: unknown } = {}) {
  const seen: string[] = [];
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic-e2e-token"));
  await page.route(`${API}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    seen.push(`${request.method()} ${url.pathname}${url.search}`);
    if (url.pathname === "/jobs/tracker/submitted" || url.pathname === "/jobs/tracker/all") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applications: [{
        id: 31, job_id: 7, status: "applied", applied_at: "2026-07-20T12:00:00Z", applied_source: "user_confirmed", notes: null, submission_reference: null,
        opened_at: null, application_url: "https://x.test/1", follow_up_date: null, created_at: "2026-07-20T12:00:00Z", updated_at: "2026-07-20T12:00:00Z",
        documents: opts.documents ?? { resume: doc("/jobs/tracker/31/documents/resume"), cover_letter: null }, job: job(7, "Plaid")
      }] }) });
    }
    if (url.pathname === "/jobs/tracker/31/documents/resume") {
      if (opts.status && opts.status !== 200) return route.fulfill({ status: opts.status, contentType: "application/json", body: JSON.stringify({ detail: "/srv/generated/document-9.pdf" }) });
      expect(request.headers()["authorization"]).toBe("Bearer synthetic-e2e-token");
      return route.fulfill({ status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="Plaid_Resume_2026-07-20.pdf"', "Access-Control-Expose-Headers": "Content-Disposition" }, body: PDF_BYTES });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return seen;
}

test("the Tracker offers Download resume, saves the exact file under the server's name, and Not available for the missing cover letter", async ({ page }) => {
  const seen = await install(page);
  await page.goto("/tracker");
  await expect(page.getByRole("heading", { name: "Senior Machine Learning Engineer" })).toBeVisible();
  await expect(page.getByText(/cover letter: Not available/i)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download resume for/i }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Plaid_Resume_2026-07-20.pdf");
  const saved = await download.path();
  expect(readFileSync(saved!).equals(PDF_BYTES)).toBe(true);
  expect(seen.filter((s) => s.includes("/documents/"))).toEqual(["GET /jobs/tracker/31/documents/resume?fmt=pdf"]);
  await expect(page.getByText("Prepared for this application", { exact: false })).toBeVisible();
  await expect(page.getByText(/Not confirmed as uploaded to the employer/i)).toBeVisible();
  // nothing sensitive in the address bar or visible text
  expect(page.url()).not.toMatch(/token|synthetic-e2e|generated|\.pdf/i);
  expect(await page.locator("body").innerText()).not.toMatch(/synthetic-e2e-token|\/srv\/generated/);
});

for (const [status, message] of [[404, /no longer available/i], [409, /can.t be opened/i], [500, /couldn.t download/i]] as const) {
  test(`a ${status} download answer shows a readable error and no server detail`, async ({ page }) => {
    await install(page, { status });
    await page.goto("/tracker");
    await page.getByRole("button", { name: /Download resume for/i }).click();
    const alert = page.getByRole("alert").filter({ hasText: message });
    await expect(alert).toBeVisible();
    await expect(page.locator("body")).not.toContainText("/srv/generated");
    await expect(page.getByRole("button", { name: /Download resume for/i })).toBeEnabled();
  });
}

test("on a phone the controls fit the screen, are tappable, and the documents stack", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await install(page, { documents: { resume: doc("/jobs/tracker/31/documents/resume"), cover_letter: doc("/jobs/tracker/31/documents/cover-letter") } });
  await page.goto("/tracker");
  const resume = page.getByRole("button", { name: /Download resume for/i });
  const cover = page.getByRole("button", { name: /Download cover letter for/i });
  await expect(resume).toBeVisible();
  const [a, b] = [await resume.boundingBox(), await cover.boundingBox()];
  expect(a!.height).toBeGreaterThanOrEqual(40);
  expect(a!.x + a!.width).toBeLessThanOrEqual(375);
  expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);          // stacked, not side by side
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("an application with no documents renders and offers no download", async ({ page }) => {
  await install(page, { documents: { resume: null, cover_letter: null } });
  await page.goto("/tracker");
  await expect(page.getByRole("heading", { name: "Senior Machine Learning Engineer" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Download/i })).toHaveCount(0);
  await expect(page.getByText(/resume: Not available/i)).toBeVisible();
});
