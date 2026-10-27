import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Tracker downloads end to end against the REAL API on a disposable PostgreSQL database (no mocked responses).
 * Skipped unless XA_LIVE_API=1 with XA_LIVE_PY (a Python with the API dependencies), XA_LIVE_API_DIR and XA_LIVE_DATABASE_URL set to a
 * database whose name starts with "xa_live". `make` targets never set these, so a normal run skips this file.
 */
const live = process.env.XA_LIVE_API === "1";
const API = process.env.API_BASE_URL ?? "http://localhost:8000";
test.skip(!live, "needs a live API on a disposable PostgreSQL database (XA_LIVE_API=1)");

const profile = {
  full_name: "Chandra Pandey", phone: "602-555-0100", location_city: "Phoenix", location_state: "AZ", location_country: "United States",
  work_authorization: "authorized_us", target_roles: ["Backend Engineer"], target_levels: ["Junior"], preferred_locations: ["United States"],
  remote_preference: "remote", skills: ["Python", "FastAPI", "PostgreSQL"]
};
const career = {
  education: [{ school: "Arizona State University", degree: "BS" }],
  experience: [{ company: "Cardinal Health", title: "ML Engineer Intern", bullets: ["Built Python services"], technologies: ["Python"], currently_working: true }],
  projects: [], certifications: [], awards: []
};

function seedJob(external: string): number {
  const out = execFileSync(process.env.XA_LIVE_PY!, [path.resolve("e2e/support/seed_live_tracker.py")], {
    cwd: process.env.XA_LIVE_API_DIR, env: { ...process.env, PYTHONPATH: process.env.XA_LIVE_API_DIR, DATABASE_URL: process.env.XA_LIVE_DATABASE_URL!, APP_ENV: "test", SEED_EXTERNAL: external }
  });
  return Number(out.toString().trim());
}

async function signup(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.post(`${API}/auth/signup`, { data: { email, password: "password123" } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).access_token as string;
}

async function applied(request: APIRequestContext, token: string, jobId: number) {
  const headers = { Authorization: `Bearer ${token}` };
  expect((await request.put(`${API}/profile`, { headers, data: profile })).ok()).toBeTruthy();
  expect((await request.put(`${API}/profile/career`, { headers, data: career })).ok()).toBeTruthy();
  const session = await request.post(`${API}/application-sessions`, { headers, data: { job_id: jobId } });
  expect(session.ok(), await session.text()).toBeTruthy();
  const confirm = await request.post(`${API}/jobs/${jobId}/applications/confirm-applied`, { headers, data: { confirmed: true } });
  expect(confirm.ok(), await confirm.text()).toBeTruthy();
}

test("a user downloads the resume and cover letter prepared for an applied application, from the real API", async ({ page, request }) => {
  const jobId = seedJob(`live-${Date.now()}`);
  const token = await signup(request, `live-${Date.now()}@mailbox.test-domain.co`);
  await applied(request, token, jobId);

  const tracker = await (await request.get(`${API}/jobs/tracker/all`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const entry = tracker.applications[0];
  expect(entry.documents_availability).toBe("frozen");
  expect(entry.documents.resume.download_path).toBe(`/jobs/tracker/${entry.id}/documents/resume`);
  expect(JSON.stringify(entry.documents)).not.toMatch(/file_path|\.pdf|\/generated|uploads/);

  await page.addInitScript((value) => localStorage.setItem("jobpilot_token", value), token);
  await page.goto("/tracker");
  await expect(page.getByRole("heading", { name: "Senior Machine Learning Engineer" })).toBeVisible();
  await expect(page.getByText(/Saved document prepared for this application/).first()).toBeVisible();
  await expect(page.getByText(/Not confirmed as uploaded to the employer/).first()).toBeVisible();

  const resumePromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download resume for/i }).click();
  const resume = await resumePromise;
  expect(resume.suggestedFilename()).toMatch(/^Plaid_Resume_\d{4}-\d{2}-\d{2}\.pdf$/);
  expect(readFileSync((await resume.path())!).subarray(0, 4).toString()).toBe("%PDF");

  const coverPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download cover letter as Word document/i }).click();
  const cover = await coverPromise;
  expect(cover.suggestedFilename()).toMatch(/^Plaid_Cover_Letter_\d{4}-\d{2}-\d{2}\.docx$/);
  expect(readFileSync((await cover.path())!).subarray(0, 2).toString()).toBe("PK");
});

test("another real account cannot download that application's documents", async ({ request }) => {
  const jobId = seedJob(`live-idor-${Date.now()}`);
  const owner = await signup(request, `owner-${Date.now()}@mailbox.test-domain.co`);
  await applied(request, owner, jobId);
  const trackerId = (await (await request.get(`${API}/jobs/tracker/all`, { headers: { Authorization: `Bearer ${owner}` } })).json()).applications[0].id;
  const intruder = await signup(request, `intruder-${Date.now()}@mailbox.test-domain.co`);
  for (const kind of ["resume", "cover-letter"]) {
    const denied = await request.get(`${API}/jobs/tracker/${trackerId}/documents/${kind}`, { headers: { Authorization: `Bearer ${intruder}` } });
    expect(denied.status()).toBe(404);
    expect(denied.headers()["content-type"]).not.toMatch(/pdf|officedocument/);
  }
  expect((await request.get(`${API}/jobs/tracker/${trackerId}/documents/resume`)).status()).toBe(401);
  const ok = await request.get(`${API}/jobs/tracker/${trackerId}/documents/resume`, { headers: { Authorization: `Bearer ${owner}` } });
  expect(ok.status()).toBe(200);
  expect(ok.headers()["cache-control"]).toBe("private, no-store");
});

test("an application recorded with no XpertApply session says so in the browser and offers no download", async ({ page, request }) => {
  const jobId = seedJob(`live-nosession-${Date.now()}`);
  const token = await signup(request, `nosession-${Date.now()}@mailbox.test-domain.co`);
  const headers = { Authorization: `Bearer ${token}` };
  expect((await request.put(`${API}/profile`, { headers, data: profile })).ok()).toBeTruthy();
  expect((await request.post(`${API}/jobs/${jobId}/applications/confirm-applied`, { headers, data: { confirmed: true } })).ok()).toBeTruthy();
  const entry = (await (await request.get(`${API}/jobs/tracker/all`, { headers })).json()).applications[0];
  expect(entry.documents).toEqual({ resume: null, cover_letter: null });
  expect(entry.documents_unavailable_reason).toBe("no_session");

  await page.addInitScript((value) => localStorage.setItem("jobpilot_token", value), token);
  await page.goto("/tracker");
  await expect(page.getByRole("heading", { name: "Senior Machine Learning Engineer" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Download/i })).toHaveCount(0);
  await expect(page.getByText(/recorded without an XpertApply session/i).first()).toBeVisible();
  await expect(page.getByText(/resume: Not available/i)).toBeVisible();
  expect((await request.get(`${API}/jobs/tracker/${entry.id}/documents/resume`, { headers })).status()).toBe(404);
});

test("several saved documents for a job and no session are not guessed, and the browser says why", async ({ page, request }) => {
  const jobId = seedJob(`live-several-${Date.now()}`);
  const token = await signup(request, `several-${Date.now()}@mailbox.test-domain.co`);
  const headers = { Authorization: `Bearer ${token}` };
  expect((await request.put(`${API}/profile`, { headers, data: profile })).ok()).toBeTruthy();
  expect((await request.put(`${API}/profile/career`, { headers, data: career })).ok()).toBeTruthy();
  for (let i = 0; i < 2; i++) expect((await request.post(`${API}/jobs/${jobId}/documents/resume`, { headers })).ok()).toBeTruthy();
  expect((await request.post(`${API}/jobs/${jobId}/applications/confirm-applied`, { headers, data: { confirmed: true } })).ok()).toBeTruthy();
  await page.addInitScript((value) => localStorage.setItem("jobpilot_token", value), token);
  await page.goto("/tracker");
  await expect(page.getByRole("button", { name: /^Download/i })).toHaveCount(0);
  await expect(page.getByText(/nothing links them to this application/i).first()).toBeVisible();
});
