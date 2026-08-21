import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";

const ROOT = join(__dirname, "..");
const routerMock = vi.hoisted(() => ({ replace: vi.fn() }));
const navigation = vi.hoisted(() => ({ pathname: "/tracker" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => routerMock
}));

const mediaState = new Map<string, boolean>();
const mediaListeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>();

function installMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return mediaState.get(query) ?? false;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      const listeners = mediaListeners.get(query) ?? new Set();
      listeners.add(listener);
      mediaListeners.set(query, listeners);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      mediaListeners.get(query)?.delete(listener);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));
}

function setMedia(query: string, matches: boolean) {
  mediaState.set(query, matches);
  for (const listener of mediaListeners.get(query) ?? []) {
    listener({ matches, media: query } as MediaQueryListEvent);
  }
}

function renderShell() {
  return render(
    React.createElement(AppShell, null, React.createElement("p", null, "content"))
  );
}

function sidebar(): HTMLElement {
  return screen.getByRole("complementary", { name: "Primary" });
}

describe("sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("jobpilot_token", "test-token");
    navigation.pathname = "/tracker";
    routerMock.replace.mockClear();
    mediaState.clear();
    mediaListeners.clear();
    installMatchMedia();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("presents the search flow in order", () => {
    renderShell();
    const labels = within(sidebar())
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label") ?? link.textContent?.trim())
      .filter((label) => label && label !== "XpertApply home");
    expect(labels).toEqual([
      "Dashboard",
      "Find Jobs",
      "Applications",
      "My Profile",
      "Settings"
    ]);
  });

  /**
   * `/resume`, `/cover-letter` and `/application-answers` are explanatory
   * placeholders, not a document-management product: document generation runs
   * inside the Jobs workspace against a specific job. A primary entry pointing
   * at them advertised a product that does not exist, so it was removed. The
   * routes stay reachable by direct URL.
   */
  it("offers no primary navigation into the document placeholder routes", () => {
    renderShell();
    const hrefs = within(sidebar())
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).not.toContain("/resume");
    expect(hrefs).not.toContain("/cover-letter");
    expect(hrefs).not.toContain("/application-answers");
    expect(within(sidebar()).queryByRole("link", { name: "My Resumes" })).toBeNull();
  });

  it("leaves a directly opened placeholder route with no active primary item", () => {
    navigation.pathname = "/resume";
    renderShell();
    const current = within(sidebar())
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current).toEqual([]);
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

  it("uses canonical selection roles instead of legacy success branding", () => {
    renderShell();
    const active = within(sidebar()).getByRole("link", { name: "Applications" });
    expect(active).toHaveClass("bg-surface-selected", "text-brand-primary");
    expect(active).not.toHaveClass("text-pine");

    const source = readFileSync(join(ROOT, "components/AppShell.tsx"), "utf8");
    expect(source).not.toMatch(/success-surface|text-pine|bg-pine|border-pine/);
    expect(source).toContain("bg-surface-overlay");
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
    renderShell();
    expect(sidebar()).toHaveAttribute("data-collapsed", "false");

    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
    // Names survive collapse, so the rail stays usable.
    expect(within(sidebar()).getByRole("link", { name: "Applications" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(sidebar()).toHaveAttribute("data-collapsed", "false");
  });

  it("persists only the desktop collapse preference", async () => {
    const first = renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(localStorage.getItem("xpertapply:desktop-sidebar-collapsed")).toBe("true");
    first.unmount();

    renderShell();
    await waitFor(() => expect(sidebar()).toHaveAttribute("data-collapsed", "true"));
    expect(screen.queryByRole("dialog", { name: "Application navigation" })).not.toBeInTheDocument();
  });

  it("keeps nested routes mapped to their top-level navigation item", () => {
    navigation.pathname = "/profile/preferences";
    const first = renderShell();
    expect(within(sidebar()).getByRole("link", { name: "My Profile" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    first.unmount();

    navigation.pathname = "/matches/42";
    renderShell();
    expect(within(sidebar()).getByRole("link", { name: "Find Jobs" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("expands and dismisses the tablet rail without changing desktop preference", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
    expect(sidebar()).toHaveAttribute("data-tablet-expanded", "true");
    expect(screen.queryByTestId("mobile-navigation-backdrop")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close expanded navigation" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(sidebar()).toHaveAttribute("data-tablet-expanded", "false");
    expect(localStorage.getItem("xpertapply:desktop-sidebar-collapsed")).toBeNull();
  });

  it("provides an accessible mobile drawer with focus, Escape, backdrop, and scroll cleanup", async () => {
    const view = renderShell();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Application navigation" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close navigation" })).toHaveFocus();
    expect(document.documentElement).toHaveClass("app-drawer-open");
    expect(view.container.querySelector("[inert]")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Application navigation" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.documentElement).not.toHaveClass("app-drawer-open");

    await userEvent.click(trigger);
    await userEvent.click(screen.getByTestId("mobile-navigation-backdrop"));
    expect(screen.queryByRole("dialog", { name: "Application navigation" })).not.toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass("app-drawer-open");

    await userEvent.click(trigger);
    expect(document.documentElement).toHaveClass("app-drawer-open");
    view.unmount();
    expect(document.documentElement).not.toHaveClass("app-drawer-open");
  });

  it("closes the mobile drawer on navigation without returning focus to the old trigger", async () => {
    renderShell();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Application navigation" });
    await userEvent.click(within(dialog).getByRole("link", { name: "Settings" }));

    expect(screen.queryByRole("dialog", { name: "Application navigation" })).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
    expect(document.documentElement).not.toHaveClass("app-drawer-open");
  });

  it("keeps keyboard focus inside the mobile drawer", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const dialog = screen.getByRole("dialog", { name: "Application navigation" });
    const first = within(dialog).getByRole("link", { name: "XpertApply home" });
    const last = within(dialog).getByRole("button", { name: "Log out" });

    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();

    first.focus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("retires transient overlays when crossing responsive modes", async () => {
    const mobileQuery = "(max-width: 639px)";
    const tabletQuery = "(min-width: 640px) and (max-width: 1279px)";
    mediaState.set(mobileQuery, true);
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog", { name: "Application navigation" })).toBeInTheDocument();

    act(() => {
      setMedia(mobileQuery, false);
      setMedia(tabletQuery, true);
    });
    expect(screen.queryByRole("dialog", { name: "Application navigation" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
    expect(sidebar()).toHaveAttribute("data-tablet-expanded", "true");
    act(() => setMedia(tabletQuery, false));
    expect(sidebar()).toHaveAttribute("data-tablet-expanded", "false");
  });
});
