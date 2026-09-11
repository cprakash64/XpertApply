import { expect, test, type Page, type Route } from "@playwright/test";

const API = process.env.API_BASE_URL ?? "http://localhost:8000";

async function json(route: Route, body: object, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function snapshot(id: number, attempt: number, filename: string) {
  return {
    id, application_tracker_id: 11, attempt_number: attempt, confirmation_source: "user_confirmed",
    submission_evidence_type: "manual", job_title: `Historical Engineer ${attempt}`,
    company_name: "Historical Co", job_url: "https://example.test/historical", source_url: null,
    job_description_snapshot: "Historical job description\nPreserved at application time.",
    resume: { document_id: id + 100, filename, content_hash: `hash-${id}` },
    resume_used: true, resume_provenance: "upload_verified", cover_letter_used: true,
    cover_letter_mode: "file", cover_letter: { document_id: id + 200, filename: `letter-${attempt}.docx`, content_hash: `letter-${id}` },
    cover_letter_text_snapshot: null, answers: [], applied_at: `2026-07-2${attempt}T12:00:00Z`, created_at: `2026-07-2${attempt}T12:01:00Z`
  };
}

async function installTracker(page: Page, attempts = [snapshot(501, 1, "exact-resume.pdf")], scheduled = false) {
  let deletionScheduledAt: string | null = scheduled ? "2099-09-17T12:00:00Z" : null;
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "synthetic-e2e-token"));
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/jobs/tracker/submitted") return json(route, { applications: [{
      id: 11, job_id: 101, status: scheduled ? "rejected" : "applied", applied_at: "2026-07-21T12:00:00Z",
      snapshot_available: true, snapshot_count: attempts.length, deletion_scheduled_at: deletionScheduledAt,
      job: { id: 101, title: "Current job", company: "Current company", company_domain: null,
        company_logo_url: null, company_logo_proxy_path: null, location: "Remote", workplace_type: "remote",
        employment_type: "Full-time", posted_at: null, application_url: "https://example.test/current", match: { fit_score: 88 } }
    }] });
    if (path === "/jobs/tracker/11/snapshots") return json(route, { snapshots: attempts });
    if (path === "/jobs/tracker/11/cancel-deletion" && request.method() === "POST") {
      deletionScheduledAt = null;
      return json(route, { tracker: { id: 11, status: "rejected", deletion_scheduled_at: null, deletion_cancelled_at: "2026-09-10T12:00:00Z" } });
    }
    return json(route, {}, 404);
  });
}

test("one snapshot exposes exact historical resume and cover-letter metadata", async ({ page }) => {
  await installTracker(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tracker");
  await page.getByRole("button", { name: "Application details" }).click();
  const dialog = page.getByRole("dialog", { name: "Application details" });
  await expect(dialog.getByText("exact-resume.pdf")).toBeVisible();
  await expect(dialog.getByText("letter-1.docx")).toBeVisible();
  await expect(dialog.getByText("Historical Engineer 1")).toBeVisible();
  await expect(dialog.getByText("Current job")).toHaveCount(0);
});

test("multiple attempts default to latest and switch exact artifacts", async ({ page }) => {
  await installTracker(page, [snapshot(501, 1, "attempt-one.pdf"), snapshot(502, 2, "attempt-two.pdf")]);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/tracker");
  await page.getByRole("button", { name: "Application details" }).click();
  await expect(page.getByText("attempt-two.pdf")).toBeVisible();
  await page.getByRole("button", { name: /Attempt 1/ }).click();
  await expect(page.getByText("attempt-one.pdf")).toBeVisible();
  await expect(page.getByText("attempt-two.pdf")).toHaveCount(0);
});

test("scheduled deletion can be undone without rewriting rejected status", async ({ page }) => {
  await installTracker(page, [snapshot(501, 1, "exact-resume.pdf")], true);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/tracker");
  await expect(page.getByText(/Scheduled for deletion/)).toBeVisible();
  await page.getByRole("button", { name: "Undo deletion" }).click();
  await expect(page.getByText(/Scheduled for deletion/)).toHaveCount(0);
  await expect(page.getByLabel("Update status for Current job")).toHaveValue("rejected");
});

test("Tracker details remain bounded at required responsive widths", async ({ page }) => {
  await installTracker(page, [snapshot(501, 1, `${"very-long-historical-filename-".repeat(8)}.pdf`)]);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/tracker");
    await page.getByRole("button", { name: "Application details" }).click();
    await expect(page.getByRole("dialog", { name: "Application details" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Close application details" }).click();
  }
});
