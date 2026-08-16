import { expect, test, type Page } from "@playwright/test";

const screenshotDirectory = process.env.RESPONSIVE_SCREENSHOT_DIR;

const dashboardSummary = {
  freshMatches: 4,
  applications: { saved: 2, inProgress: 1, interviews: 1, offers: 0 },
  recentApplications: [],
  topMatches: [],
  strongMatches: 2,
  nextAction: {
    kind: "discover",
    eyebrow: "Next step",
    title: "Find your next role",
    body: "Review the latest jobs selected for your search.",
    href: "/jobs",
    cta: "Browse jobs",
    firstName: "Taylor",
    profileProgress: 80
  }
};

async function authenticate(page: Page) {
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "responsive-shell-token"));
  await page.route("**/dashboard/summary", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(dashboardSummary)
    })
  );
  await page.route("**/profile", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ profile: null })
    })
  );
}

async function capture(page: Page, name: string) {
  if (!screenshotDirectory) return;
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: false });
}

async function installCorePageApi(page: Page) {
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "core-page-shell-token"));
  await page.route("http://localhost:8000/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: object = {};
    if (path === "/dashboard/summary") body = dashboardSummary;
    else if (path === "/jobs") {
      body = {
        profile_complete: true,
        criteria: { role_queries: [], skills: [], seniority_targets: [] },
        profile_filters: {
          target_roles: [],
          target_levels: [],
          preferred_locations: [],
          work_preference: "remote"
        },
        jobs: []
      };
    } else if (path.startsWith("/jobs/tracker/")) body = { applications: [] };
    else if (path === "/profile") {
      body = {
        profile: {
          full_name: "Taylor Example",
          email: "taylor@example.test",
          location: "New York, NY"
        }
      };
    } else if (path === "/profile/career") {
      body = {
        education: [],
        experience: [],
        projects: [],
        certifications: [],
        awards: [],
        publications: []
      };
    } else if (path === "/profile/completeness") {
      const score = { percent: 60, satisfied: [], missing: [] };
      body = { completion: score, autofillReadiness: score };
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("desktop sidebar collapses, remains accessible, and persists its preference", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page);
  await page.goto("/dashboard");

  const sidebar = page.getByRole("complementary", { name: "Primary" });
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "256px");
  await expect(sidebar.locator(".app-nav-label", { hasText: "Dashboard" })).toBeVisible();

  await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveCSS("width", "56px");
  await expect(sidebar.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(sidebar.locator(".app-nav-label", { hasText: "Dashboard" })).toBeHidden();

  await page.reload();
  await expect(sidebar).toHaveCSS("width", "56px");
  await sidebar.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(sidebar).toHaveCSS("width", "256px");
  await capture(page, "desktop-dashboard-expanded");
});

test("tablet keeps a compact rail and expands it as a dismissible overlay", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await authenticate(page);
  await page.goto("/dashboard");

  const sidebar = page.getByRole("complementary", { name: "Primary" });
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "64px");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();

  await sidebar.getByRole("button", { name: "Expand navigation" }).click();
  await expect(sidebar).toHaveCSS("width", "256px");
  await expect(sidebar.locator(".app-nav-label", { hasText: "My Profile" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close expanded navigation" })).toBeVisible();
  await capture(page, "tablet-dashboard-expanded");

  await page.keyboard.press("Escape");
  await expect(sidebar).toHaveCSS("width", "64px");
  await expect(page.getByRole("button", { name: "Close expanded navigation" })).toHaveCount(0);
});

test("phone drawer opens accessibly, dismisses, and closes after navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await authenticate(page);
  await page.goto("/dashboard");

  const menu = page.getByRole("button", { name: "Open navigation" });
  const drawer = page.getByRole("dialog", { name: "Application navigation" });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Primary" })).toBeHidden();
  await expect(drawer).toHaveCount(0);

  await menu.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close navigation" })).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflow))
    .toBe("hidden");
  await capture(page, "phone-dashboard-drawer");

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(menu).toBeFocused();

  await menu.click();
  await page.getByTestId("mobile-navigation-backdrop").click({ position: { x: 380, y: 400 } });
  await expect(drawer).toHaveCount(0);
  await expect(menu).toBeFocused();

  await menu.click();
  await drawer.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings and data controls" })).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});

test("breakpoint transitions retire transient overlays and restore desktop preference", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page);
  await page.goto("/dashboard");

  const sidebar = page.getByRole("complementary", { name: "Primary" });
  await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveCSS("width", "56px");

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(sidebar).toHaveCSS("width", "64px");
  await sidebar.getByRole("button", { name: "Expand navigation" }).click();
  await expect(sidebar).toHaveCSS("width", "256px");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toBeHidden();
  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.click();
  await expect(page.getByRole("dialog", { name: "Application navigation" })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("dialog", { name: "Application navigation" })).toHaveCount(0);
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "56px");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflow))
    .not.toBe("hidden");
});

test("the exact breakpoint boundaries always expose one usable navigation mode", async ({ page }) => {
  await authenticate(page);
  await page.setViewportSize({ width: 639, height: 800 });
  await page.goto("/dashboard");

  const sidebar = page.getByRole("complementary", { name: "Primary" });
  const menu = page.getByRole("button", { name: "Open navigation" });
  await expect(menu).toBeVisible();
  await expect(sidebar).toBeHidden();

  await page.setViewportSize({ width: 640, height: 800 });
  await expect(menu).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "64px");

  await page.setViewportSize({ width: 1279, height: 800 });
  await expect(menu).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "64px");

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(menu).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "256px");
});

test("Settings and Logout remain reachable in short navigation viewports", async ({ page }) => {
  await authenticate(page);
  await page.setViewportSize({ width: 390, height: 667 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Open navigation" }).click();

  const drawer = page.getByRole("dialog", { name: "Application navigation" });
  const mobileLogout = drawer.getByRole("button", { name: "Log out" });
  await mobileLogout.scrollIntoViewIfNeeded();
  await expect(mobileLogout).toBeInViewport();
  await expect(drawer.getByRole("link", { name: "Settings" })).toBeVisible();

  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 900, height: 400 });
  const sidebar = page.getByRole("complementary", { name: "Primary" });
  const tabletLogout = sidebar.getByRole("button", { name: "Log out" });
  await tabletLogout.scrollIntoViewIfNeeded();
  await expect(tabletLogout).toBeInViewport();
  await expect(sidebar.getByRole("link", { name: "Settings" })).toBeVisible();
});

test("mobile auth expiry removes an open drawer with the protected shell", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("jobpilot_token", "expired-shell-token"));
  await page.route("**/dashboard/summary", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Invalid token" })
    });
  });
  await page.goto("/dashboard");

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Application navigation" })).toBeVisible();

  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
  await expect(page.getByRole("dialog", { name: "Application navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in to XpertApply" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflow))
    .not.toBe("hidden");
  expect(await page.evaluate(() => localStorage.getItem("jobpilot_token"))).toBeNull();
});

test("core authenticated pages keep shell geometry within desktop and phone viewports", async ({
  page
}) => {
  await installCorePageApi(page);
  const routes = [
    ["dashboard", "/dashboard"],
    ["jobs", "/jobs"],
    ["applications", "/tracker"],
    ["profile", "/profile"],
    ["settings", "/settings"]
  ] as const;

  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 }
  ] as const) {
    await page.setViewportSize(viewport);
    for (const [name, path] of routes) {
      await page.goto(path);
      if (viewport.name === "desktop") {
        await expect(page.getByRole("complementary", { name: "Primary" })).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      if (viewport.name === "phone") await capture(page, `phone-${name}`);
    }
  }
});
