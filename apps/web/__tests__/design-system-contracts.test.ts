/**
 * Static contracts that keep the migrated product from regressing.
 *
 * These are deliberately narrow. A broad "no green anywhere" scan would reject
 * the things that are *supposed* to be green — success statuses, the emerald
 * fit band, the tinted "Mark as applied" affordance — and would be deleted the
 * first time it cried wolf. Each rule below targets one specific, provably
 * retired construct.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

/** Runtime source only: tests and e2e specs may name anything they assert on. */
const RUNTIME_DIRS = ["app", "components", "lib"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const runtimeFiles = RUNTIME_DIRS.flatMap((dir) => walk(join(ROOT, dir)));

function read(file: string): { path: string; source: string } {
  return { path: relative(ROOT, file), source: readFileSync(file, "utf8") };
}

describe("retired legacy Button adapter", () => {
  it("no longer exists", () => {
    expect(existsSync(join(ROOT, "components/Button.tsx"))).toBe(false);
  });

  it("is not imported by any runtime module", () => {
    // Resolve each specifier to a repo-relative path and compare against the
    // one retired module. Suffix-matching "…/Button" would also flag
    // `components/ui/Button` (the canonical one) and any third-party `Button`.
    const LEGACY = "components/Button";
    const offenders: string[] = [];

    for (const { path, source } of runtimeFiles.map(read)) {
      const dir = dirname(path);
      for (const [, specifier] of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const resolved = specifier.startsWith("@/")
          ? specifier.slice(2)
          : specifier.startsWith(".")
            ? join(dir, specifier)
            : null;
        if (resolved === LEGACY) offenders.push(`${path} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("left a canonical Button with the four semantic variants", () => {
    const button = readFileSync(join(ROOT, "components/ui/Button.tsx"), "utf8");
    for (const variant of ["primary", "secondary", "ghost", "destructive"]) {
      expect(button).toContain(`${variant}:`);
    }
  });
});

describe("retired pine brand utilities", () => {
  /**
   * `pine` is the pre-migration brand green.
   *
   * It stays defined in the Tailwind palette and `--accent` stays defined in
   * globals.css — both are named in the theme architecture test, and
   * `--accent-foreground` is still the paired foreground for the success fill
   * behind "Mark as applied". Deleting the names would turn `bg-pine` into a
   * class that silently does nothing, which is a worse failure than a test.
   *
   * So the rule is about USE, not existence, and it has no exemptions: after
   * the public entry surfaces were migrated, zero call sites remain anywhere in
   * the runtime. Green still means success, the emerald fit bands are
   * untouched, and vendor colours are unaffected — this forbids exactly one
   * thing, the old brand green standing in for XpertApply.
   */
  it("is absent from every runtime surface, public and authenticated", () => {
    const pine = /\b(?:bg|text|border|ring|fill|from|to|via)-pine\b/;
    const offenders = runtimeFiles
      .map(read)
      .filter(({ source }) => pine.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("cannot be smuggled back in through the raw accent variables", () => {
    // `bg-[var(--accent)]` would sidestep the palette-name rule above.
    const rawAccent = /var\(--accent(?:-hover)?\)/;
    const offenders = runtimeFiles
      .map(read)
      // The root error boundary replaces the whole document and inlines its own
      // palette under the same variable names; its values are canonical navy /
      // cyan and it cannot reference globals.css.
      .filter(({ path }) => path !== "app/global-error.tsx")
      .filter(({ source }) => rawAccent.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("keeps the public sign-in action on the canonical action role", () => {
    const auth = readFileSync(join(ROOT, "components/AuthDialog.tsx"), "utf8");
    expect(auth).toContain("bg-action-primary");
    expect(auth).toContain("text-action-primary-foreground");
    // Cyan is the dark primary; white text on it fails contrast, which is why
    // the paired foreground token exists.
    expect(auth).not.toMatch(/bg-action-primary[^"]*\btext-white\b/);
  });

  it("does not tint native form controls with the legacy accent", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    expect(css).toMatch(/accent-color:\s*var\(--color-brand-primary\)/);
    expect(css).not.toMatch(/accent-color:\s*var\(--accent\)/);
  });
});

describe("single canonical semantic sources", () => {
  it("routes every application-status tone through lib/applicationStatus", () => {
    const offenders = runtimeFiles
      .map(read)
      .filter(({ path }) => path !== "lib/applicationStatus.ts")
      // A page-local map keyed by the domain statuses is the duplication this
      // guards against; page-local *labels* remain fine.
      .filter(({ source }) => /["']ready_to_apply["']\s*:/.test(source) && /["']withdrawn["']\s*:/.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("routes every fit-score threshold through lib/fitScore", () => {
    const offenders = runtimeFiles
      .map(read)
      .filter(({ path }) => path !== "lib/fitScore.ts")
      .filter(({ source }) => /(?:score|fit)\s*>=\s*\d{2}/i.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

describe("loading placeholders", () => {
  it("use the canonical skeleton role, not the retired warm token", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    expect(css).toContain("--color-skeleton:");
    expect(css).not.toMatch(/^\s*--skeleton:/m);

    const offenders = runtimeFiles
      .map(read)
      .filter(({ source }) => source.includes("var(--skeleton)"))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

describe("generated document facsimiles", () => {
  it("pin paper and ink so a preview matches the exported DOCX/PDF in both themes", () => {
    for (const file of ["components/GeneratedResumePreview.tsx", "components/GeneratedCoverLetterPreview.tsx"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, `${file} must sit on document paper`).toContain("bg-document-paper");
      expect(source, `${file} must use document ink`).toContain("text-document-ink");
      // A theme-following surface token here is what made the "paper" charcoal.
      expect(source, `${file} must not follow the product theme`).not.toMatch(/\bbg-(?:white|surface-card)\b/);
    }

    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    for (const token of ["--color-document-paper", "--color-document-ink"]) {
      expect(css).toContain(`${token}:`);
      expect(darkBlock, `${token} is fixed and must not be themed`).not.toContain(`${token}:`);
    }
  });
});
