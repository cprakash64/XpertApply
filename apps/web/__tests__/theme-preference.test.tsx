/**
 * Theme preference: persistence, resolution, the init script and the control.
 *
 *   - the stored choice (light | dark | system) resolves to data-theme on <html>;
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
import { ThemeControl } from "../components/ThemeControl";
import { applyThemePreference, readThemePreference, resolveTheme } from "../lib/theme";

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

  it("ignores junk in storage and treats it as system", () => {
    localStorage.setItem("xa-theme", "purple");
    expect(readThemePreference()).toBe("system");
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readThemePreference()).toBe("system");
  });
});

describe("theme-init.js (runs before first paint)", () => {
  const run = () => new Function(initScript)();

  it.each([
    ["light", true, "light"],
    ["dark", false, "dark"],
    [null, true, "dark"],
    [null, false, "light"]
  ])("stored %s, OS dark=%s -> data-theme %s", (stored, osDark, expected) => {
    if (stored) localStorage.setItem("xa-theme", stored);
    stubOsDark(osDark);
    run();
    expect(root().getAttribute("data-theme")).toBe(expected);
    expect(root().getAttribute("data-theme-pref")).toBe(stored ?? "system");
  });

  it("agrees with lib/theme for every combination", () => {
    for (const stored of [null, "light", "dark"] as const) {
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
  it("is a labelled radio group with one selected option, system by default", () => {
    render(React.createElement(ThemeControl));
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Match system theme" })).toBeChecked();
  });

  it("stores and applies a choice, then restores system by clearing storage", async () => {
    render(React.createElement(ThemeControl));
    await userEvent.click(screen.getByRole("radio", { name: "Dark theme" }));
    expect(localStorage.getItem("xa-theme")).toBe("dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark theme" })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: "Match system theme" }));
    expect(localStorage.getItem("xa-theme")).toBeNull();
    expect(root().getAttribute("data-theme")).toBe("light");
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

  it("keeps two mounted controls in step", async () => {
    render(React.createElement("div", null, React.createElement(ThemeControl), React.createElement(ThemeControl)));
    await userEvent.click(screen.getAllByRole("radio", { name: "Light theme" })[0]);
    for (const radio of screen.getAllByRole("radio", { name: "Light theme" })) expect(radio).toBeChecked();
  });
});
