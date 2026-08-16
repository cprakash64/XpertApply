import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";

const ROOT = join(__dirname, "..");
const routerMock = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/tracker",
  useRouter: () => routerMock
}));

function renderShell() {
  return render(
    React.createElement(AppShell, null, React.createElement("p", null, "content"))
  );
}

function sidebar(): HTMLElement {
  return screen.getByRole("complementary", { name: "Primary" });
}

describe("sidebar", () => {
  beforeEach(() => localStorage.setItem("jobpilot_token", "test-token"));
  afterEach(() => cleanup());

  it("presents the search flow in order", () => {
    renderShell();
    const labels = within(sidebar())
      .getAllByRole("link")
      .map((link) => link.textContent?.trim())
      .filter((label) => label && label !== "XpertApply");
    expect(labels).toEqual([
      "Dashboard",
      "Find Jobs",
      "My Resumes",
      "Applications",
      "My Profile",
      "Settings"
    ]);
  });

  it("marks the current section", () => {
    renderShell();
    expect(within(sidebar()).getByRole("link", { name: "Applications" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(within(sidebar()).getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current"
    );
  });

  it("never links to a route that does not exist", () => {
    renderShell();
    const hrefs = within(sidebar())
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href): href is string => Boolean(href) && href !== "/");

    for (const href of hrefs) {
      // Every destination must resolve to a real page file — the guard against
      // a sidebar entry added from a design mock with no route behind it.
      const page = join(ROOT, "app", href.replace(/^\//, ""), "page.tsx");
      expect(existsSync(page), `${href} has no page.tsx`).toBe(true);
    }
  });

  it("omits Networking until it has a route of its own", () => {
    // The people/referral features are a tab inside the Jobs workspace. A
    // sidebar entry for them today would be a 404.
    renderShell();
    expect(within(sidebar()).queryByRole("link", { name: /networking/i })).not.toBeInTheDocument();
    expect(existsSync(join(ROOT, "app/networking/page.tsx"))).toBe(false);
  });

  it("keeps Settings pinned at the bottom, away from the section list", () => {
    const source = readFileSync(join(ROOT, "components/AppShell.tsx"), "utf8");
    expect(source).toContain("settingsItem");
    expect(source).toMatch(/mt-auto/);
  });

  it("still supports collapsing to the icon rail", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    renderShell();
    expect(sidebar()).toHaveAttribute("data-collapsed", "false");

    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
    // Names survive collapse, so the rail stays usable.
    expect(within(sidebar()).getByRole("link", { name: "Applications" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(sidebar()).toHaveAttribute("data-collapsed", "false");
  });
});
