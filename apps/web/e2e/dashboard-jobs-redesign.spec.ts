import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The redesigned Dashboard and Jobs pages in a real browser. The API is mocked with synthetic data, including a fake `/jobs`
 * that honours `sort`, `limit` and `cursor`, so scrolling is exercised end to end.
 *
 *   SHOT_DIR=/path npx playwright test e2e/dashboard-jobs-redesign.spec.ts -g capture    # also writes review screenshots
 */
const AXE = require.resolve("axe-core/axe.min.js");

const job = (id: number, over: Record<string, unknown> = {}) => ({
  id, title: `Role ${String(id).padStart(3, "0")}`, company: `Company ${id}`, company_domain: "", company_logo_url: "", company_logo_proxy_path: null,
  source: "greenhouse", location: id % 2 ? "Remote, United States" : "New York, NY", location_display: id % 2 ? "Remote, US" : "New York, NY",
  workplace_type: id % 2 ? "remote" : "hybrid", employment_type: "full-time", seniority_level: "mid",
  posted_at: new Date(Date.now() - id * 3_600_000).toISOString(), discovered_at: new Date().toISOString(),
  application_url: `https://boards.greenhouse.io/acme/${id}`, source_url: `https://boards.greenhouse.io/acme/${id}`,
  description_clean: "Build resilient systems.", required_skills: ["Python", "FastAPI"], preferred_skills: [], responsibilities: [],
  match: { fit_score: [92, 66, 38][id % 3], fit_label: ["Strong fit", "Good fit", "Low fit"][id % 3], score_state: "scored",
    match_reasons: ["Your Python and FastAPI experience matches the core stack."], missing_skills: [], risk_factors: [] },
  ...over
});

const SUMMARY = {
  freshMatches: 227,
  applications: { saved: 4, inProgress: 15, interviews: 2, offers: 1, rejected: 2 },
  recentApplications: [
    { id: "1", jobId: 7, title: "Platform Engineer", company: "Northstar", status: "interview", updatedAt: "2026-07-30T12:00:00Z", appliedAt: "2026-07-24T12:00:00Z", fitScore: 84, logoUrl: null },
    { id: "2", jobId: 8, title: "Data Engineer", company: "Globex", status: "applied", updatedAt: "2026-07-29T12:00:00Z", appliedAt: "2026-07-28T12:00:00Z", fitScore: 61, logoUrl: null },
    { id: "3", jobId: 9, title: "Backend Developer with a very long title that must truncate cleanly", company: "Initech", status: "rejected", updatedAt: "2026-07-27T12:00:00Z", appliedAt: "2026-07-20T12:00:00Z", fitScore: null, logoUrl: null }
  ],
  topMatches: [
    { id: 11, title: "Senior Machine Learning Engineer", company: "Plaid", location: "Remote, US", workplaceType: "remote", employmentType: "full-time", postedAt: "2026-07-30T12:00:00Z", fitScore: 93, fitSummary: "Strong overlap.", matchedSkills: ["Python", "PyTorch", "FastAPI", "Docker"], snippet: "Build and ship the models behind our fraud detection platform, working with a small senior team.", logoUrl: null, saved: false },
    { id: 12, title: "Staff Backend Engineer, Platform Reliability", company: "Northstar Analytics", location: "New York, NY", workplaceType: "hybrid", employmentType: "full-time", postedAt: "2026-07-29T12:00:00Z", fitScore: 68, matchedSkills: ["Python"], snippet: "Own the reliability of the services that every product team depends on.", logoUrl: null, saved: true },
    { id: 13, title: "Junior Data Analyst", company: "Globex", location: null, workplaceType: null, employmentType: null, postedAt: null, fitScore: 38, matchedSkills: [], snippet: null, logoUrl: null, saved: false }
  ],
  strongMatches: 18,
  profile: { percent: 78, completed: [{ key: "identity", label: "Name" }, { key: "skills", label: "Skills" }, { key: "experience", label: "Experience" }], missing: [{ key: "links", label: "Professional links" }, { key: "education", label: "Education" }] },
  nextAction: { kind: "strong_matches", eyebrow: "18 strong matches", title: "Review your highest-fit opportunities", body: "18 fresh matches scored 80%+ fit.", href: "/jobs", cta: "View matches", firstName: "Taylor", profileProgress: 78 }
};

type Hit = { method: string; path: string; params: URLSearchParams };

async function install(page: Page, opts: { total?: number; empty?: boolean } = {}) {
  const total = opts.empty ? 0 : opts.total ?? 60;
  const hits: Hit[] = [];
  await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("jobpilot_token", "synthetic-e2e-token"); } });
  await page.route((url) => url.port === "8000" || url.port === "8001", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    hits.push({ method: request.method(), path: url.pathname, params: url.searchParams });
    const cors = { "access-control-allow-origin": "*" };
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (url.pathname === "/dashboard/summary") return json(opts.empty ? { ...SUMMARY, freshMatches: 0, strongMatches: 0, applications: { saved: 0, inProgress: 0, interviews: 0, offers: 0, rejected: 0 }, recentApplications: [], topMatches: [], profile: { percent: 0, completed: [], missing: [{ key: "identity", label: "Name" }] } } : SUMMARY);
    if (url.pathname === "/jobs") {
      const limit = Number(url.searchParams.get("limit") ?? total);
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? Number(cursor.replace("c:", "")) : 0;
      const ids = Array.from({ length: total }, (_, i) => i + 1);
      const slice = ids.slice(start, start + limit);
      const more = start + limit < total;
      return json({ profile_complete: true, criteria: { role_queries: [], skills: [], seniority_targets: [] }, profile_filters: { target_roles: [], target_levels: [], preferred_locations: [], work_preference: "remote" },
        jobs: slice.map((id) => job(id)), page: { sort: url.searchParams.get("sort") ?? "best_recent", total, limit, returned: slice.length, has_more: more, next_cursor: more ? `c:${start + limit}` : null } });
    }
    if (/^\/jobs\/\d+\/save$/.test(url.pathname)) return json({ tracker: { id: 1, job_id: 1, status: "saved" } });
    if (url.pathname.startsWith("/jobs/tracker/")) return json({ applications: [] });
    if (url.pathname === "/auth/me") return json({ id: 1, email: "taylor@example.test", full_name: "Taylor Example" });
    return json({});
  });
  return hits;
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number).slice(0, 3);
const colourOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);

async function axeViolations(page: Page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return result.violations.map((v: { id: string; impact: string; nodes: Array<{ target: unknown }> }) => `${v.impact}:${v.id}:${v.nodes.length} ${JSON.stringify(v.nodes[0]?.target)}`);
  });
}

const prefer = (page: Page, theme: "light" | "dark") => page.addInitScript((value) => localStorage.setItem("xa-theme", value), theme);

test.describe("Dashboard", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("layout: welcome and search, four metrics, three vertical match cards, a table, and a right rail", async ({ page }) => {
    await install(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome back, Taylor.");
    await expect(page.getByRole("search", { name: "Search jobs" })).toBeVisible();
    const metrics = page.getByRole("region", { name: "Search metrics" });
    await expect(metrics.getByText("Job matches")).toBeVisible();
    await expect(metrics.getByText("Applications")).toBeVisible();
    await expect(metrics.getByText("227")).toBeVisible();
    await expect(metrics.getByText("20")).toBeVisible();

    const cards = page.getByRole("article");
    await expect(cards).toHaveCount(3);
    const boxes = await Promise.all([0, 1, 2].map((i) => cards.nth(i).boundingBox()));
    expect(boxes.every((b) => b && Math.abs(b.y - boxes[0]!.y) < 2)).toBe(true);          // three across, one row
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width - 1);

    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText(["Role", "Applied", "Status", "Fit", "Actions"]);
    await expect(table.getByRole("row")).toHaveCount(4);

    const rail = page.getByRole("complementary", { name: "Profile and pipeline" });
    const [railBox, firstCard] = [await rail.boundingBox(), boxes[0]!];
    expect(railBox!.x).toBeGreaterThan(firstCard.x + firstCard.width);                      // the rail is beside, not below
    const content = (await page.locator("main").boundingBox())!;
    expect(railBox!.width / content.width).toBeGreaterThan(0.2);
    expect(railBox!.width / content.width).toBeLessThan(0.35);
    await expect(rail.getByRole("progressbar", { name: "Profile completion" })).toHaveAttribute("aria-valuenow", "78");
    await expect(rail.getByRole("link", { name: "Continue profile" })).toHaveAttribute("href", "/profile");
    await expect(rail.getByRole("region", { name: "Application pipeline" }).getByText("Rejected")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // The sidebar keeps real destinations only, and no theme control.
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Sections" });
    await expect(nav.getByRole("link")).toHaveCount(4);
    for (const name of ["Dashboard", "Find Jobs", "Applications", "My Profile"]) await expect(nav.getByRole("link", { name })).toBeVisible();
  });

  test("fit colours are green, amber and red in a real browser, with the number and label beside each", async ({ page }) => {
    await install(page);
    await page.goto("/dashboard");
    const chips = page.locator("article [data-fit-tone]");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toContainText("Strong fit");
    await expect(chips.nth(1)).toContainText("Good fit");
    await expect(chips.nth(2)).toContainText("Low fit");
    const [g, a, r] = (await Promise.all([0, 1, 2].map((i) => chips.nth(i).evaluate((el) => getComputedStyle(el).color)))).map(rgb);
    expect(g[1]).toBeGreaterThan(g[0]);  expect(g[1]).toBeGreaterThan(g[2]);              // green: green channel dominates
    expect(a[0]).toBeGreaterThan(a[2]);  expect(a[1]).toBeGreaterThan(a[2]);              // amber: red and green both above blue
    expect(r[0]).toBeGreaterThan(r[1]);  expect(r[0]).toBeGreaterThan(r[2]);              // red: red channel dominates
  });

  test("Save uses the real endpoint; Review & apply opens the job in the Jobs workspace", async ({ page }) => {
    const hits = await install(page);
    await page.goto("/dashboard");
    const card = page.getByRole("article", { name: /Senior Machine Learning Engineer/ });
    await card.getByRole("button", { name: /^Save / }).click();
    await expect(card.getByRole("button", { name: /is saved/ })).toHaveAttribute("aria-pressed", "true");
    expect(hits.some((h) => h.method === "POST" && h.path === "/jobs/11/save")).toBe(true);
    await card.getByRole("link", { name: /Review & apply/ }).click();
    await expect(page).toHaveURL(/\/jobs\?job=11/);
  });

  test("the search hands off to Jobs", async ({ page }) => {
    await install(page);
    await page.goto("/dashboard");
    await page.getByRole("textbox", { name: "Search jobs" }).fill("machine learning");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/jobs\?q=machine(%20|\+)learning/);
  });

  test("empty account: honest empty states and no fabricated figures", async ({ page }) => {
    await install(page, { empty: true });
    await page.goto("/dashboard");
    await expect(page.getByText("No scored matches yet")).toBeVisible();
    await expect(page.getByText(/No applications yet\./)).toBeVisible();
    await expect(page.getByText(/Save or start an application/)).toBeVisible();
    expect(await page.locator("main").innerText()).not.toMatch(/\d+%\s*(increase|growth)|vs\.? last/i);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`no serious or critical accessibility violations (${scheme})`, async ({ page }) => {
      await install(page);
      await prefer(page, scheme);
      await page.goto("/dashboard");
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await expect(page.getByRole("article")).toHaveCount(3);
      await page.waitForTimeout(300);
      const found = await axeViolations(page);
      expect(found.filter((v: string) => /^(serious|critical):/.test(v)), found.join("\n")).toEqual([]);
    });
  }
});

test.describe("Dashboard, responsive", () => {
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`no horizontal overflow at ${width}px, light and dark`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await install(page);
      for (const scheme of ["light", "dark"] as const) {
        await prefer(page, scheme);
        await page.goto("/dashboard");
        await expect(page.getByRole("article")).toHaveCount(3);
        expect(await overflow(page), `${scheme}`).toBeLessThanOrEqual(0);
      }
    });
  }

  test("phone: single column, the rail sits below the main content", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await install(page);
    await page.goto("/dashboard");
    const first = (await page.getByRole("article").first().boundingBox())!;
    const second = (await page.getByRole("article").nth(1).boundingBox())!;
    expect(second.y).toBeGreaterThan(first.y + first.height - 1);                            // stacked
    const rail = (await page.getByRole("complementary", { name: "Profile and pipeline" }).boundingBox())!;
    const table = (await page.getByRole("table").boundingBox())!;
    expect(rail.y).toBeGreaterThan(table.y);
  });

  test("tablet: the rail moves below the main content", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await install(page);
    await page.goto("/dashboard");
    const table = (await page.getByRole("table").boundingBox())!;
    const rail = (await page.getByRole("complementary", { name: "Profile and pipeline" }).boundingBox())!;
    expect(rail.y).toBeGreaterThan(table.y + table.height - 1);
  });
});

test.describe("Jobs", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("compact toolbar, no introductory header, semantic h1, and compact cards", async ({ page }) => {
    await install(page);
    await page.goto("/jobs");
    await expect(page.getByTestId("job-card").first()).toBeVisible();
    // The page title is hidden visually; the navigation already says where you are.
    const h1 = page.getByRole("heading", { level: 1, name: "Jobs" });
    await expect(h1).toHaveCount(1);
    expect(await h1.evaluate((el) => { const r = el.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; })).toBe(true);
    await expect(page.getByText("Fresh roles matched to your profile")).toHaveCount(0);
    for (const label of ["Role or skill", "Workplace type", "Minimum fit score", "Posted within days", "Sort jobs"]) await expect(page.getByLabel(label)).toBeVisible();
    await expect(page.getByText("25 jobs for you").or(page.getByText(/\d+ jobs? for you/))).toBeVisible();
    await expect(page.getByText(/Jobs without a posting date are not shown/)).toBeVisible();
    const toolbarTop = (await page.getByLabel("Role or skill").boundingBox())!.y;
    expect(toolbarTop).toBeLessThan(90);                                                    // no big empty band above the toolbar
    const card = (await page.getByTestId("job-card").first().boundingBox())!;
    expect(card.height).toBeLessThan(230);                                                  // was ~260 before; the actions row stays 40px tall for touch
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("navbar: full-width, borderless filters, search expands on focus and keeps its query", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error" && !/Content Security Policy/.test(message.text())) errors.push(message.text()); });
    // New CSP regressions must fail this test: every securitypolicyviolation event is collected (report-only ones included).
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (event) =>
        (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    await install(page);
    await page.goto("/jobs");
    await expect(page.getByTestId("job-card").first()).toBeVisible();
    const search = page.getByLabel("Role or skill");
    const collapsed = (await search.boundingBox())!.width;
    const sort = (await page.getByLabel("Sort jobs").boundingBox())!;
    const find = (await page.getByRole("button", { name: "Find fresh jobs" }).boundingBox())!;
    const card = (await page.getByTestId("job-card").first().boundingBox())!;
    expect(sort.y).toBeLessThan(find.y + find.height);                                      // one row on desktop
    expect(find.x).toBeGreaterThan(sort.x + sort.width);                                    // actions sit at the right end
    expect(card.width).toBeGreaterThan(1000);                                               // rows use the workspace width
    for (const label of ["Workplace type", "Minimum fit score", "Posted within days", "Sort jobs"]) {
      expect(await page.getByLabel(label).evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");   // no per-filter box
    }
    await search.click();
    await expect.poll(async () => (await search.boundingBox())!.width).toBeGreaterThan(collapsed + 40);
    await search.fill("python");
    await page.keyboard.press("Escape");
    await expect(search).not.toBeFocused();
    await expect(search).toHaveValue("python");                                             // a typed query is kept
    await expect(page.getByLabel("Sort jobs")).toHaveValue("best_recent");                  // nothing else was reset
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    // Known report-only baseline, present before this change: Next's inline bootstrap scripts, and the mocked API origin
    // (the policy allows the deployed API URL, not this test's localhost:8000). Anything else is a new regression.
    const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(violations.filter((v) => v !== "script-src-elem inline" && !v.startsWith("connect-src http://localhost:8000/"))).toEqual([]);
  });

  test("one filled action per card; the others are quiet", async ({ page }) => {
    await install(page);
    await page.goto("/jobs");
    const card = page.getByTestId("job-card").first();
    await expect(card.getByRole("button", { name: /Apply on official site/ })).toBeVisible();
    const bg = async (name: RegExp) => card.getByRole("button", { name }).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const filled = await bg(/Apply on official site/);
    for (const name of [/^Save/, /Resume/, /Cover Letter/, /Find people/]) {
      expect(await bg(name), String(name)).not.toBe(filled);
      expect(await card.getByRole("button", { name }).first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth))).toBe(0);
    }
  });

  test("fit chips are green, amber and red, with the number and the label", async ({ page }) => {
    await install(page);
    await page.goto("/jobs");
    const chips = page.locator("[data-testid='job-card'] [data-fit-tone]");
    const colours = new Map<string, number[]>();
    for (let i = 0; i < 3; i++) {
      const chip = chips.nth(i);
      const tone = (await chip.getAttribute("data-fit-tone"))!;
      colours.set(tone, rgb(await chip.evaluate((el) => getComputedStyle(el).color)));
      await expect(chip).toContainText(/\d+/);
      await expect(chip).toContainText(/Strong fit|Good fit|Low fit/);
    }
    expect([...colours.keys()].sort()).toEqual(["good", "low", "strong"]);
  });

  test("scrolling loads the next ranked page; the order is preserved and it stops at the end", async ({ page }) => {
    const hits = await install(page, { total: 60 });
    await page.goto("/jobs");
    await expect(page.getByTestId("job-card")).toHaveCount(25);
    const firstTitles = await page.getByTestId("job-card").locator("h2").allTextContents();
    await page.getByTestId("job-card").last().scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 4000);
    await expect(page.getByTestId("job-card")).toHaveCount(50);
    await page.mouse.wheel(0, 8000);
    await expect(page.getByTestId("job-card")).toHaveCount(60);
    await expect(page.getByText(/You.ve reached the end · 60 jobs/)).toBeVisible();
    const all = await page.getByTestId("job-card").locator("h2").allTextContents();
    expect(all.slice(0, 25)).toEqual(firstTitles);                                         // nothing already shown moved
    expect(new Set(all).size).toBe(60);                                                    // no duplicates
    const pages = hits.filter((h) => h.path === "/jobs");
    expect(pages.map((h) => h.params.get("cursor"))).toEqual([null, "c:25", "c:50"]);
    expect(pages.every((h) => h.params.get("sort") === "best_recent" && h.params.get("limit") === "25")).toBe(true);
    await page.waitForTimeout(500);
    expect(hits.filter((h) => h.path === "/jobs")).toHaveLength(3);                        // and it stopped asking
  });

  test("the sort control offers Best & recent (default), Best fit and Newest first and reloads from the server", async ({ page }) => {
    const hits = await install(page);
    await page.goto("/jobs");
    await expect(page.getByTestId("job-card").first()).toBeVisible();
    await expect(page.getByLabel("Sort jobs")).toHaveValue("best_recent");
    await expect(page.getByLabel("Sort jobs").locator("option")).toHaveText(["Best & recent", "Best fit", "Newest first"]);
    await page.getByLabel("Sort jobs").selectOption("newest");
    await expect.poll(() => hits.filter((h) => h.path === "/jobs").at(-1)?.params.get("sort")).toBe("newest");
    await expect(page).toHaveURL(/sort=newest/);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`no serious or critical accessibility violations (${scheme})`, async ({ page }) => {
      await install(page);
      await prefer(page, scheme);
      await page.goto("/jobs");
      await expect(page.getByTestId("job-card").first()).toBeVisible();
      await page.waitForTimeout(300);
      const found = await axeViolations(page);
      expect(found.filter((v: string) => /^(serious|critical):/.test(v)), found.join("\n")).toEqual([]);
    });
  }
});

test.describe("Jobs, responsive", () => {
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`no horizontal overflow at ${width}px, light and dark`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await install(page);
      for (const scheme of ["light", "dark"] as const) {
        await prefer(page, scheme);
        await page.goto("/jobs");
        await expect(page.getByTestId("job-card").first()).toBeVisible();
        expect(await overflow(page), `${scheme}`).toBeLessThanOrEqual(0);
      }
    });
  }

  test("phone: actions stack without crowding and every control is at least 40px tall", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await install(page);
    await page.goto("/jobs");
    const card = page.getByTestId("job-card").first();
    for (const name of [/Apply on official site/, /^Save/, /Resume/, /Cover Letter/]) {
      const box = (await card.getByRole("button", { name }).first().boundingBox())!;
      expect(box.height, String(name)).toBeGreaterThanOrEqual(39.5);
    }
    const apply = (await card.getByRole("button", { name: /Apply on official site/ }).boundingBox())!;
    expect(apply.width).toBeGreaterThan(300);                                              // Apply spans the card
  });
});

// ---------------------------------------------------------------------------------------------------------------- //
// Review screenshots. Only when SHOT_DIR is set.
// ---------------------------------------------------------------------------------------------------------------- //
test.describe("screenshots", () => {
  test.skip(!process.env.SHOT_DIR, "set SHOT_DIR to write the review screenshots");
  const dir = process.env.SHOT_DIR as string;

  test("capture", async ({ browser }) => {
    mkdirSync(dir, { recursive: true });
    for (const route of ["dashboard", "jobs"] as const) {
      const wait = route === "dashboard" ? "article" : "[data-testid='job-card']";
      for (const scheme of ["light", "dark"] as const) {
        const desktop = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
        await install(desktop); await prefer(desktop, scheme); await desktop.goto(`/${route}`);
        await desktop.locator(wait).first().waitFor();
        await desktop.waitForTimeout(500);
        await desktop.screenshot({ path: `${dir}/${route}-desktop-${scheme}.png` });
        if (route === "dashboard") await desktop.screenshot({ path: `${dir}/${route}-desktop-${scheme}-full.png`, fullPage: true });
        await desktop.context().close();
      }
      const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
      await install(phone); await prefer(phone, "light"); await phone.goto(`/${route}`);
      await phone.locator(wait).first().waitFor();
      await phone.waitForTimeout(500);
      await phone.screenshot({ path: `${dir}/${route}-mobile-light.png`, fullPage: route === "dashboard" });
      await phone.context().close();
    }
    const dark = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
    await install(dark); await prefer(dark, "dark"); await dark.goto("/dashboard");
    await dark.locator("article").first().waitFor(); await dark.waitForTimeout(500);
    await dark.screenshot({ path: `${dir}/dashboard-mobile-dark.png`, fullPage: true });
    await dark.context().close();
  });

  test("capture jobs navigation", async ({ browser }) => {
    mkdirSync(dir, { recursive: true });
    const open = async (width: number, height: number, scheme: "light" | "dark") => {
      const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
      await install(page); await prefer(page, scheme); await page.goto("/jobs");
      await page.locator("[data-testid='job-card']").first().waitFor(); await page.waitForTimeout(400);
      return page;
    };
    const dark = await open(1440, 900, "dark");
    await dark.screenshot({ path: `${dir}/jobs-nav-desktop-dark-collapsed.png` });
    await dark.getByLabel("Role or skill").click();
    await dark.waitForTimeout(300);
    await dark.screenshot({ path: `${dir}/jobs-nav-desktop-dark-expanded.png` });
    await dark.keyboard.press("Tab");
    await dark.keyboard.press("Tab");
    await dark.waitForTimeout(200);
    await dark.screenshot({ path: `${dir}/jobs-nav-desktop-dark-focus.png`, clip: { x: 0, y: 0, width: 1440, height: 160 } });
    await dark.mouse.wheel(0, 900); await dark.waitForTimeout(300);
    await dark.screenshot({ path: `${dir}/jobs-nav-desktop-dark-scrolled.png` });
    await dark.context().close();

    const light = await open(1440, 900, "light");
    await light.screenshot({ path: `${dir}/jobs-nav-desktop-light.png` });
    await light.context().close();

    for (const width of [1920, 1024, 768]) {
      const page = await open(width, 900, "light");
      await page.screenshot({ path: `${dir}/jobs-nav-${width}-light.png` });
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.context().close();
    }
    for (const width of [390, 320]) {
      const page = await open(width, 844, "light");
      await page.screenshot({ path: `${dir}/jobs-nav-${width}-light.png` });
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.context().close();
    }
  });
});
