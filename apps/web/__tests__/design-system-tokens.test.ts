import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const tailwind = readFileSync(join(ROOT, "tailwind.config.ts"), "utf8");

const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
const darkStart = css.indexOf(":root {", css.indexOf("@media (prefers-color-scheme: dark)"));
const darkBlock = css.slice(darkStart, css.indexOf("\n  }\n}", darkStart));

const RAW_TOKENS = [
  "--xa-navy",
  "--xa-navy-hover",
  "--xa-cyan",
  "--xa-cyan-highlight",
  "--xa-cyan-dark",
  "--xa-ink",
  "--xa-neutral-secondary",
  "--xa-neutral-muted",
  "--xa-light-page",
  "--xa-light-card",
  "--xa-light-border-subtle",
  "--xa-light-border",
  "--xa-light-border-strong"
];

const SEMANTIC_TOKENS = [
  "--color-brand-primary",
  "--color-brand-primary-hover",
  "--color-brand-accent",
  "--color-brand-accent-highlight",
  "--color-brand-accent-foreground",
  "--color-brand-accent-text",
  "--color-action-primary-background",
  "--color-action-primary-foreground",
  "--color-action-primary-hover",
  "--color-action-secondary-background",
  "--color-action-secondary-foreground",
  "--color-action-secondary-border",
  "--color-action-ghost-foreground",
  "--color-action-ghost-hover",
  "--color-action-destructive-background",
  "--color-action-destructive-foreground",
  "--color-action-destructive-hover",
  "--color-surface-page",
  "--color-surface-shell",
  "--color-surface-card",
  "--color-surface-raised",
  "--color-surface-subtle",
  "--color-surface-selected",
  "--color-surface-overlay",
  "--color-surface-disabled",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-muted",
  "--color-text-disabled",
  "--color-text-inverse",
  "--color-text-link",
  "--color-border-subtle",
  "--color-border-default",
  "--color-border-strong",
  "--color-border-interactive",
  "--color-border-selected",
  "--color-border-error",
  "--color-focus-ring",
  "--color-focus-ring-offset",
  "--color-focus-ring-error",
  "--color-status-neutral",
  "--color-status-neutral-surface",
  "--color-status-neutral-border",
  "--color-status-info",
  "--color-status-info-surface",
  "--color-status-info-border",
  "--color-status-success",
  "--color-status-success-surface",
  "--color-status-success-border",
  "--color-status-warning",
  "--color-status-warning-surface",
  "--color-status-warning-border",
  "--color-status-danger",
  "--color-status-danger-surface",
  "--color-status-danger-border"
];

function declaration(block: string, token: string): string {
  const value = new RegExp(`${token}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
  if (!value) throw new Error(`Missing ${token}`);
  return value;
}

function resolveHex(token: string, theme: "light" | "dark"): string {
  const themedBlock = theme === "dark" ? darkBlock : rootBlock;
  const themedMatch = new RegExp(`${token}:\\s*([^;]+);`).exec(themedBlock)?.[1]?.trim();
  const value = themedMatch ?? declaration(rootBlock, token);
  const reference = /^var\((--[^)]+)\)$/.exec(value)?.[1];
  return reference ? resolveHex(reference, theme) : value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("canonical design tokens", () => {
  it("defines the small marketing-derived raw palette exactly", () => {
    const expected = {
      "--xa-navy": "#06245c",
      "--xa-navy-hover": "#0b3577",
      "--xa-cyan": "#14b8c4",
      "--xa-cyan-highlight": "#63d7dc",
      "--xa-cyan-dark": "#0e7c85",
      "--xa-ink": "#08182f",
      "--xa-neutral-secondary": "#475467",
      "--xa-neutral-muted": "#667085",
      "--xa-light-page": "#f8fafc",
      "--xa-light-card": "#ffffff",
      "--xa-light-border-subtle": "#edf0f4",
      "--xa-light-border": "#e5e9f0",
      "--xa-light-border-strong": "#d9e1eb"
    } as const;
    expect(RAW_TOKENS).toEqual(Object.keys(expected));
    for (const [token, value] of Object.entries(expected)) {
      expect(declaration(rootBlock, token)).toBe(value);
    }
  });

  it("defines every semantic role in light and dark themes", () => {
    for (const token of SEMANTIC_TOKENS) {
      expect(rootBlock, `${token} light`).toContain(`${token}:`);
      expect(darkBlock, `${token} dark`).toContain(`${token}:`);
    }
  });

  it("keeps legacy pine independent from canonical cyan", () => {
    expect(declaration(rootBlock, "--accent")).toBe("#1f5e45");
    expect(declaration(darkBlock, "--accent")).toBe("#4c9e7a");
    expect(css).not.toMatch(/--accent:\s*var\(--xa-cyan/);
  });

  it("maps Tailwind semantic aliases to variables, never duplicated hex values", () => {
    for (const alias of [
      "brand-primary",
      "action-primary",
      "surface-page",
      "surface-card",
      "foreground",
      "foreground-link",
      "line-default",
      "line-selected",
      "focus-ring",
      "status-success",
      "status-warning",
      "status-danger"
    ]) {
      expect(tailwind).toMatch(new RegExp(`"?${alias}"?:\\s*"var\\(--color-`));
    }
  });
});

describe("canonical contrast contracts", () => {
  const textPairs = [
    ["--color-action-primary-foreground", "--color-action-primary-background", "primary button"],
    ["--color-brand-accent-foreground", "--color-brand-accent", "accent foreground"],
    ["--color-text-primary", "--color-surface-page", "primary text"],
    ["--color-text-secondary", "--color-surface-page", "secondary text"],
    ["--color-text-muted", "--color-surface-page", "muted text"],
    ["--color-text-link", "--color-surface-page", "link"],
    ["--color-text-disabled", "--color-surface-disabled", "disabled text"],
    ["--color-status-success", "--color-status-success-surface", "success"],
    ["--color-status-warning", "--color-status-warning-surface", "warning"],
    ["--color-status-danger", "--color-status-danger-surface", "danger"]
  ] as const;

  it.each(["light", "dark"] as const)("meets WCAG AA normal-text contrast in %s mode", (theme) => {
    for (const [foreground, background, label] of textPairs) {
      expect(
        contrast(resolveHex(foreground, theme), resolveHex(background, theme)),
        `${theme} ${label}`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark"] as const)("keeps the focus indicator distinct from the page in %s mode", (theme) => {
    expect(
      contrast(resolveHex("--color-focus-ring", theme), resolveHex("--color-surface-page", theme))
    ).toBeGreaterThanOrEqual(3);
  });

  it("forbids white text on canonical cyan and permits dark ink instead", () => {
    expect(contrast("#ffffff", resolveHex("--xa-cyan", "light"))).toBeLessThan(4.5);
    expect(contrast(resolveHex("--xa-ink", "light"), resolveHex("--xa-cyan", "light"))).toBeGreaterThanOrEqual(4.5);
  });
});
