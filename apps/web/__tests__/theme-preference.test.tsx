/**
 * Theme preference: persistence, resolution, the init script and the control.
 *
 *   - the stored choice (light | dark | system) resolves to data-theme on <html>;
 *   - with NO stored choice the approved light appearance applies, whatever the OS prefers;
 *   - the blocking init script and lib/theme.ts agree on that resolution;
 *   - the control is a radio group that stores, applies and announces a choice;
 *   - storage failures fall back to the OS preference instead of throwing.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeControl, ThemeSync } from "../components/ThemeControl";
import {
  THEMED_ROUTE_PREFIXES,
  applyThemePreference,
  isThemedPath,
  readThemePreference,
  resolveTheme,
  themeForPath
} from "../lib/theme";

let mockPathname = "/dashboard";
vi.mock("next/navigation", () => ({ usePathname: () => mockPathname }));

const initScript = readFileSync(join(__dirname, "../public/theme-init.js"), "utf8");
const root = () => document.documentElement;

function stubOsDark(dark: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: dark && query.includes("dark"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }));
}

beforeEach(() => {
  localStorage.clear();
  mockPathname = "/dashboard";
  window.history.pushState({}, "", "/dashboard"); // the signed-in app, where the preference applies
  root().removeAttribute("data-theme");
  root().removeAttribute("data-theme-pref");
  stubOsDark(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme resolution", () => {
  it("follows the OS only for the system preference", () => {
    stubOsDark(true);
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    stubOsDark(false);
    expect(resolveTheme("system")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("ignores junk in storage and uses the approved light default", () => {
    localStorage.setItem("xa-theme", "purple");
    expect(readThemePreference()).toBe("light");
  });

  it("defaults to light with nothing stored, even when the OS prefers dark", () => {
    stubOsDark(true);
    expect(readThemePreference()).toBe("light");
    applyThemePreference(readThemePreference());
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("keeps an explicit system choice as system", () => {
    localStorage.setItem("xa-theme", "system");
    stubOsDark(true);
    expect(readThemePreference()).toBe("system");
    applyThemePreference(readThemePreference());
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readThemePreference()).toBe("light");
  });
});

describe("theme-init.js (runs before first paint)", () => {
  const run = () => new Function(initScript)();

  it.each([
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["system", true, "dark"],
    ["system", false, "light"],
    [null, true, "light"], // no stored choice: the approved light default, not the OS
    [null, false, "light"]
  ])("stored %s, OS dark=%s -> data-theme %s", (stored, osDark, expected) => {
    if (stored) localStorage.setItem("xa-theme", stored);
    stubOsDark(osDark);
    run();
    expect(root().getAttribute("data-theme")).toBe(expected);
    expect(root().getAttribute("data-theme-pref")).toBe(stored ?? "light");
  });

  it("agrees with lib/theme for every combination", () => {
    for (const stored of [null, "light", "dark", "system"] as const) {
      for (const osDark of [true, false]) {
        localStorage.clear();
        if (stored) localStorage.setItem("xa-theme", stored);
        stubOsDark(osDark);
        run();
        const fromScript = root().getAttribute("data-theme");
        applyThemePreference(readThemePreference());
        expect(root().getAttribute("data-theme")).toBe(fromScript);
      }
    }
  });
});

describe("theme control", () => {
  it("is a labelled radio group with one selected option, light by default", () => {
    render(React.createElement(ThemeControl));
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Light theme" })).toBeChecked();
  });

  it("stores and applies a choice, including an explicit system choice", async () => {
    render(React.createElement(ThemeControl));
    await userEvent.click(screen.getByRole("radio", { name: "Dark theme" }));
    expect(localStorage.getItem("xa-theme")).toBe("dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark theme" })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: "Match system theme" }));
    expect(localStorage.getItem("xa-theme")).toBe("system");     // stored, because the default is now light
    expect(root().getAttribute("data-theme")).toBe("light");     // OS is light in this test
  });

  it("reflects a stored choice and moves between options with the arrow keys", async () => {
    localStorage.setItem("xa-theme", "dark");
    render(React.createElement(ThemeControl));
    const dark = await screen.findByRole("radio", { name: "Dark theme" });
    expect(dark).toBeChecked();
    dark.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Match system theme" })).toBeChecked();
  });

  it("can show visible words (Settings) without changing the accessible names", () => {
    render(React.createElement(ThemeControl, { showLabels: true }));
    for (const [name, word] of [["Light theme", "Light"], ["Match system theme", "System"], ["Dark theme", "Dark"]]) {
      const radio = screen.getByRole("radio", { name });
      expect(radio).toHaveTextContent(word);
      expect(name.toLowerCase()).toContain(word.toLowerCase()); // the visible label is contained in the accessible name
    }
  });

  it("keeps two mounted controls in step", async () => {
    render(React.createElement("div", null, React.createElement(ThemeControl), React.createElement(ThemeControl)));
    await userEvent.click(screen.getAllByRole("radio", { name: "Light theme" })[0]);
    for (const radio of screen.getAllByRole("radio", { name: "Light theme" })) expect(radio).toBeChecked();
  });
});

const PUBLIC_PATHS = ["/", "/login", "/signup", "/forgot-password", "/reset-password", "/pricing", "/privacy", "/opensource", "/auth/google/callback", "/not-a-page"];
const APP_PATHS = ["/dashboard", "/jobs", "/jobs/12", "/tracker", "/profile/personal", "/settings", "/resume", "/cover-letter"];

describe("the public website is always light", () => {
  it("classifies routes: only the signed-in application is themed", () => {
    for (const path of PUBLIC_PATHS) expect(isThemedPath(path), path).toBe(false);
    for (const path of APP_PATHS) expect(isThemedPath(path), path).toBe(true);
    // A prefix must not match a longer public path ("/jobsearch" is not "/jobs").
    expect(isThemedPath("/jobsearch")).toBe(false);
  });

  it("renders light on every public path for every saved choice and OS setting", () => {
    for (const path of PUBLIC_PATHS)
      for (const pref of ["light", "dark", "system"] as const)
        for (const osDark of [true, false]) {
          stubOsDark(osDark);
          expect(themeForPath(path, pref), `${path} ${pref} os-dark=${osDark}`).toBe("light");
        }
  });

  it("applies the saved choice inside the app", () => {
    stubOsDark(true);
    expect(themeForPath("/dashboard", "dark")).toBe("dark");
    expect(themeForPath("/dashboard", "light")).toBe("light");
    expect(themeForPath("/dashboard", "system")).toBe("dark");
    stubOsDark(false);
    expect(themeForPath("/dashboard", "system")).toBe("light");
  });

  it("theme-init.js agrees with lib/theme on every route, choice and OS setting", () => {
    for (const path of [...PUBLIC_PATHS, ...APP_PATHS])
      for (const stored of [null, "light", "dark", "system"] as const)
        for (const osDark of [true, false]) {
          localStorage.clear();
          if (stored) localStorage.setItem("xa-theme", stored);
          window.history.pushState({}, "", path);
          stubOsDark(osDark);
          new Function(initScript)();
          expect(root().getAttribute("data-theme"), `${path} stored=${stored} os-dark=${osDark}`).toBe(
            themeForPath(path, stored ?? "light")
          );
        }
  });

  it("keeps the init script's route list identical to THEMED_ROUTE_PREFIXES", () => {
    const listed = /var themed = (\[[^\]]*\]);/.exec(initScript)?.[1];
    expect(JSON.parse(listed ?? "[]")).toEqual([...THEMED_ROUTE_PREFIXES]);
  });

  it("never rewrites the saved choice by visiting a public page", () => {
    localStorage.setItem("xa-theme", "dark");
    window.history.pushState({}, "", "/");
    new Function(initScript)();
    applyThemePreference(readThemePreference());
    expect(localStorage.getItem("xa-theme")).toBe("dark");
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(root().getAttribute("data-theme-pref")).toBe("dark");
  });

  it("ThemeSync re-resolves on client navigation between public and app routes", () => {
    localStorage.setItem("xa-theme", "dark");
    mockPathname = "/dashboard";
    window.history.pushState({}, "", "/dashboard");
    const view = render(React.createElement(ThemeSync));
    expect(root().getAttribute("data-theme")).toBe("dark");

    mockPathname = "/login"; // log out
    window.history.pushState({}, "", "/login");
    view.rerender(React.createElement(ThemeSync));
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("xa-theme")).toBe("dark");

    mockPathname = "/jobs"; // log back in
    window.history.pushState({}, "", "/jobs");
    view.rerender(React.createElement(ThemeSync));
    expect(root().getAttribute("data-theme")).toBe("dark");
  });
});
