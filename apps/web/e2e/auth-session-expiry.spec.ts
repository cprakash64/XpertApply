import { expect, test } from "@playwright/test";

test("a protected API 401 removes the app shell and returns to login", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "stale-e2e-token"));
  await page.route("**/dashboard/summary", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Invalid token" })
    })
  );

  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
  await expect(page.getByRole("heading", { name: "Sign in to XpertApply" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Primary" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("jobpilot_token"))).toBeNull();
});

test("a logged-out protected deep link redirects without rendering protected content", async ({
  page
}) => {
  await page.goto("/profile/preferences");

  await expect(page).toHaveURL(/\/login\?next=%2Fprofile%2Fpreferences$/);
  await expect(page.getByRole("heading", { name: "Sign in to XpertApply" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Job preferences" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Primary" })).toHaveCount(0);
});
