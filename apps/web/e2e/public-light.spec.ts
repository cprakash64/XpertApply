import { expect, test, type Page } from "@playwright/test";

/**
 * The public website is ALWAYS light; the signed-in app follows the saved choice.
 * The API is mocked with synthetic data; only theme behaviour is asserted.
 */
const luminance = (rgb: string) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};
const PUBLIC = ["/", "/login", "/signup", "/pricing", "/privacy", "/opensource"];

async function mockApi(page: Page) {
  await page.route((url) => url.port === "8001" || url.port === "8000", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path === "/auth/providers" ? { google: { enabled: false } }
      : path === "/auth/login" ? { access_token: "synthetic", token_type: "bearer" }
      : path === "/dashboard/summary" ? { freshMatches: 0, applications: { saved: 0, inProgress: 0, interviews: 0, offers: 0 }, recentApplications: [], topMatches: [], strongMatches: 0, nextAction: { kind: "discover", eyebrow: "Next step", title: "Find your next role", body: "x", href: "/jobs", cta: "Browse jobs", firstName: "Taylor", profileProgress: 0 } }
      : {};
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
}

for (const saved of ["dark", "light", "system"] as const) {
  test(`public pages stay light under OS dark and a saved "${saved}" choice, on reload too`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await mockApi(page);
    await page.addInitScript((value) => localStorage.setItem("xa-theme", value), saved);
    for (const path of PUBLIC) {
      await page.goto(path);
      for (const pass of ["direct", "reload"]) {
        if (pass === "reload") await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
        expect(luminance(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)), `${path} ${pass}`).toBeGreaterThan(0.9);
        await expect(page.getByRole("radio")).toHaveCount(0);
        await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#ffffff");
        await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute("content", "light");
      }
    }
    expect(await page.evaluate(() => localStorage.getItem("xa-theme"))).toBe(saved);
  });
}

test("the app follows the saved choice, and logging out then in does not change it", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await mockApi(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("jobpilot_token", "synthetic");
    localStorage.setItem("xa-theme", "dark");
  });
  await page.goto("/dashboard");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Log out" }).first().click();
  await page.waitForURL("**/login**");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Email address").fill("taylor@example.test");
  await page.locator("#auth-password").fill("a-long-test-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL("**/dashboard");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("xa-theme"))).toBe("dark");
});
