import { expect, test, type Page } from "@playwright/test";

/**
 * Recovery UI in a real browser against the production build. The API is mocked
 * (the full API + Postgres + SMTP flow is scripts/auth-recovery-e2e); this file
 * guards what only a browser can: the rendered text, the token leaving the
 * address bar, focus order, and light mode under a dark OS preference.
 */
const TOKEN = "Zk3q9XvV1pQmWb7nR2sT5uYc8dFgHjLaEoNiMtBeUwA";
const json = (route: import("@playwright/test").Route, body: object, status = 200) =>
  route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

async function mockApi(page: Page, opts: { verify?: boolean; available?: boolean } = {}) {
  const seen: string[] = [];
  await page.route((url) => url.port === "8001" || url.port === "8000", (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    }
    const path = new URL(route.request().url()).pathname;
    seen.push(`${route.request().method()} ${path}${new URL(route.request().url()).search}`);
    if (path === "/auth/providers") return json(route, { google: { enabled: false } });
    if (path.endsWith("/availability")) return json(route, { available: opts.available ?? true });
    if (path.endsWith("/request")) return json(route, { status: "accepted" }, 202);
    if (path.endsWith("/verify")) return json(route, { valid: opts.verify ?? true });
    if (path.endsWith("/confirm")) return json(route, { status: "password_updated" });
    return json(route, {});
  });
  return seen;
}

test("login offers Forgot password? and no longer shows the privacy tagline", async ({ page }) => {
  await mockApi(page);
  await page.goto("/login");
  await expect(page.getByText(/Private by default|You stay in control/)).toHaveCount(0);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveCount(0);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("link", { name: "XpertApply" }).first().click();
  await expect(page).toHaveURL(/\/$/);
});

test("the request page gives the same generic confirmation and a sensible tab order", async ({ page }) => {
  await mockApi(page);
  await page.goto("/forgot-password");
  const email = page.getByLabel("Email address");
  await expect(email).toBeFocused(); // autofocus
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Back to sign in" })).toBeFocused();
  await email.fill("nobody@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("If an account exists for nobody@example.com");
});

test("recovery says so, instead of showing a dead form, when email is not configured", async ({ page }) => {
  await mockApi(page, { available: false });
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: "Password recovery is unavailable" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveCount(0);
});

test("the reset page removes the token from the address bar and renders correct text", async ({ page }) => {
  const seen = await mockApi(page);
  await page.goto(`/reset-password#token=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  expect(page.url()).not.toContain(TOKEN);
  expect(new URL(page.url()).hash).toBe("");
  // Regression: a production-build text node once lost the space after "10".
  await expect(page.getByText("Use at least 10 characters. Don’t use your email address.")).toBeVisible();
  expect(seen.every((entry) => !entry.includes(TOKEN))).toBe(true);
  await page.getByLabel("New password", { exact: true }).fill("a brand new passphrase");
  await page.getByLabel("Confirm new password").fill("a brand new passphrase");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Go to sign in/ })).toHaveAttribute("href", "/login");
});

test("an invalid or expired link is a clear final state", async ({ page }) => {
  await mockApi(page, { verify: false });
  await page.goto(`/reset-password#token=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/forgot-password");
});

for (const path of ["/forgot-password", "/reset-password"]) {
  test(`${path} stays light under a dark OS and a saved dark choice, with the light logo`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await mockApi(page);
    await page.addInitScript(() => localStorage.setItem("xa-theme", "dark"));
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#ffffff");
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    await expect(page.locator(".brand-mark__dark").first()).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("xa-theme"))).toBe("dark");
  });
}
