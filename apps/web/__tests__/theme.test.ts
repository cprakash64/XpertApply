/**
 * Section F/G — the theme is token-based and OS-driven.
 *
 * These assert the *architecture*, which is what keeps light and dark in sync:
 * a hard-coded colour in a component is invisible to a screenshot diff of one
 * theme but wrong in the other. Rendered-appearance checks live in the
 * Playwright suite (e2e/theme.spec.ts).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const globalsCss = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const tailwindConfig = readFileSync(join(ROOT, "tailwind.config.ts"), "utf8");

/** Every semantic token the design system is required to define. */
const REQUIRED_TOKENS = [
  "--background", "--surface", "--surface-raised", "--surface-muted",
  "--text-primary", "--text-secondary", "--text-muted",
  "--border", "--border-strong",
  "--accent", "--accent-hover", "--accent-foreground",
  "--focus-ring",
  "--success", "--warning", "--danger", "--danger-hover",
  "--overlay", "--shadow",
  "--input-background", "--disabled-background"
];

/**
 * Legacy token names that are now ALIASES onto a canonical `--color-*` role.
 *
 * An alias must NOT be restated in the dark block: `var()` resolves against the
 * element's own computed value, so the single declaration already follows the
 * active scheme. Restating one is how light and dark drift apart again, which
 * is why the dark-mode test below asserts their absence rather than their
 * presence. Each entry is `[legacy, canonical]`.
 */
const ALIASED_TOKENS: [string, string][] = [
  ["--background", "--color-surface-page"],
  ["--surface", "--color-surface-card"],
  ["--surface-raised", "--color-surface-raised"],
  ["--surface-muted", "--color-surface-subtle"],
  ["--text-primary", "--color-text-primary"],
  ["--text-secondary", "--color-text-secondary"],
  ["--text-muted", "--color-text-muted"],
  ["--border", "--color-border-default"],
  ["--border-strong", "--color-border-interactive"],
  ["--focus-ring", "--color-focus-ring"],
  ["--success", "--color-status-success"],
  ["--warning", "--color-status-warning"],
  ["--danger", "--color-status-danger"],
  ["--danger-hover", "--color-status-danger-strong"],
  ["--overlay", "--color-surface-overlay"],
  ["--input-background", "--color-surface-raised"],
  ["--disabled-background", "--color-surface-disabled"]
];

const ALIASED_NAMES = new Set(ALIASED_TOKENS.map(([legacy]) => legacy));

function walk(dir: string, out: string[] = []): string[] {
  // Dirent avoids a separate stat call for every file. That distinction is
  // material on macOS workspaces backed by File Provider/iCloud, where statSync
  // can block while metadata is hydrated and make this otherwise tiny test
  // exceed Vitest's default timeout.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("theme tokens", () => {
  it("defines every required semantic token", () => {
    for (const token of REQUIRED_TOKENS) {
      expect(globalsCss, `${token} must be defined`).toContain(`${token}:`);
    }
  });

  it("resolves every legacy token name through a canonical design-system role", () => {
    for (const [legacy, canonical] of ALIASED_TOKENS) {
      expect(globalsCss, `${legacy} must alias ${canonical}`).toContain(
        `${legacy}: var(${canonical});`
      );
    }
  });

  it("overrides every non-aliased token for dark mode", () => {
    const darkBlock = globalsCss.slice(globalsCss.indexOf("@media (prefers-color-scheme: dark)"));
    for (const token of REQUIRED_TOKENS) {
      if (ALIASED_NAMES.has(token)) continue;
      expect(darkBlock, `${token} needs a dark value`).toContain(`${token}:`);
    }
  });

  it("never restates an alias in the dark block, where it could drift", () => {
    const darkBlock = globalsCss.slice(globalsCss.indexOf("@media (prefers-color-scheme: dark)"));
    for (const [legacy] of ALIASED_TOKENS) {
      expect(darkBlock, `${legacy} is an alias and must not be redeclared`).not.toMatch(
        new RegExp(`^\\s*${legacy}:`, "m")
      );
    }
  });

  it("declares color-scheme: light dark so native UI and first paint follow the OS", () => {
    expect(globalsCss).toMatch(/color-scheme:\s*light dark/);
  });

  it("paints html as well as body, so first paint and over-scroll are themed", () => {
    expect(globalsCss).toMatch(/html\s*\{[^}]*background:\s*var\(--background\)/);
    expect(globalsCss).toMatch(/body\s*\{[^}]*background:\s*var\(--background\)/);
  });

  it("does not use pure black as the dark background", () => {
    // Read the canonical page role the `--background` alias resolves to.
    const darkBlock = globalsCss.slice(globalsCss.indexOf("@media (prefers-color-scheme: dark)"));
    const background = /--color-surface-page:\s*(#[0-9a-fA-F]{6})/.exec(darkBlock)?.[1]?.toLowerCase();
    expect(background).toBeDefined();
    expect(background).not.toBe("#000000");
  });

  it("respects prefers-reduced-motion", () => {
    expect(globalsCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps placeholders and focus rings themed", () => {
    expect(globalsCss).toMatch(/::placeholder[^{]*\{[^}]*var\(--color-text-muted\)/);
    expect(globalsCss).toMatch(/focus-visible[^{]*\{[^}]*var\(--focus-ring\)/);
  });

  /**
   * Tailwind's preflight ships `input::placeholder, textarea::placeholder`
   * with gray-400. A bare `::placeholder` rule loses to it on specificity, so
   * the themed colour silently did nothing and placeholders sat at 2.6:1 on a
   * white field. The element-qualified selectors are what make the rule apply.
   */
  it("outranks Tailwind preflight on placeholder colour", () => {
    const block = /(^|\n)([^{]*::placeholder[^{]*)\{/.exec(globalsCss)?.[2] ?? "";
    expect(block).toContain("input::placeholder");
    expect(block).toContain("textarea::placeholder");
  });

  it("themes scrollbars", () => {
    expect(globalsCss).toContain("::-webkit-scrollbar");
  });
});

describe("tailwind palette", () => {
  it("maps the palette onto tokens rather than literal colours", () => {
    for (const name of ["ink", "panel", "line", "pine", "white"]) {
      expect(tailwindConfig).toMatch(new RegExp(`${name}:\\s*"var\\(--`));
    }
  });

  it("uses the media strategy so dark: follows the OS with no toggle", () => {
    expect(tailwindConfig).toMatch(/darkMode:\s*"media"/);
  });
});

describe("no hard-coded colours in components", () => {
  it("has no arbitrary hex values left in app/ or components/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))];
    const offenders: string[] = [];
    for (const file of files) {
      // global-error.tsx inlines its palette on purpose: it replaces the whole
      // document and cannot rely on the stylesheet having loaded.
      if (file.endsWith("global-error.tsx")) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.match(/\[#[0-9a-fA-F]{3,8}\]/g) ?? []) {
        offenders.push(`${file.replace(ROOT, "")}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});

describe("fit-score colours", () => {
  const fitScore = readFileSync(join(ROOT, "lib/fitScore.ts"), "utf8");

  it("keeps the same hue per band in both themes", () => {
    // The colour carries the score's meaning; only lightness may change.
    expect(fitScore).toMatch(/border-emerald-300[^"]*dark:border-emerald-\d+/);
    expect(fitScore).toMatch(/border-lime-300[^"]*dark:border-lime-\d+/);
    expect(fitScore).toMatch(/border-orange-300[^"]*dark:border-orange-\d+/);
    expect(fitScore).toMatch(/border-red-300[^"]*dark:border-red-\d+/);
  });

  it("still maps the documented score bands to the documented hues", () => {
    expect(fitScore).toMatch(/strong:\s*\{[\s\S]*?emerald/);
    expect(fitScore).toMatch(/good:\s*\{[\s\S]*?lime/);
    expect(fitScore).toMatch(/stretch:\s*\{[\s\S]*?orange/);
    expect(fitScore).toMatch(/low:\s*\{[\s\S]*?red/);
  });
});
