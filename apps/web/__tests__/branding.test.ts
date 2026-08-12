/**
 * The rebrand, as a property of the source rather than a thing someone
 * remembers to check.
 *
 * A rebrand never fails loudly. It decays: a new empty state written from
 * memory, an error message copied from an older one, a component that spells
 * the name the way the author first learned it. By the time anyone notices, the
 * product reads as half-renamed. This file is the guard against that.
 *
 * The line it draws is the same one the rest of the codebase draws:
 *
 *   forbidden — a retired name in anything a user reads
 *   allowed   — a retired name in an identifier, storage key, wire constant,
 *               URL or comment, each documented where it is defined
 *
 * On centralisation: the brand's IDENTITY (name, tagline, domain, logo) lives in
 * lib/siteConfig.ts and components/BrandLogo.tsx and is imported. Prose is
 * allowed to spell "XpertApply" literally mid-sentence — interpolating a
 * constant into every paragraph is what caused the "XpertApplyChrome extension"
 * defect app/page.tsx still carries a comment about. The literals are safe
 * because this test verifies every one of them.
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND, PRODUCT_NAME } from "../lib/siteConfig";

const ROOT = join(__dirname, "..");

/** Every spelling the product has shipped under before XpertApply. */
const RETIRED_NAMES = /EZ\s?Job\s?Find|EZJobFind|Job\s?Pilot/i;

/** Surfaces a user reads. Tests and e2e fixtures are deliberately excluded. */
const SOURCE_DIRS = ["app", "components", "lib"];

function walk(dir: string, out: string[] = []): string[] {
  // Dirent avoids a stat per entry — material on this repo, which lives in a
  // macOS File Provider folder where statSync can block on hydration.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if ([".ts", ".tsx", ".css", ".svg"].includes(extname(entry.name))) out.push(full);
  }
  return out;
}

const FILES = SOURCE_DIRS.flatMap((dir) => walk(join(ROOT, dir)));

describe("brand identity is defined once", () => {
  it("names the product, its positioning, and its domain in one object", () => {
    expect(BRAND).toEqual({
      name: "XpertApply",
      tagline: "Your AI Job Application Copilot",
      domain: "xpertapply.com"
    });
    expect(PRODUCT_NAME).toBe(BRAND.name);
  });

  it("finds real source files to check", () => {
    // Guards the guard: a walk that silently returns nothing would make every
    // assertion below vacuously true.
    expect(FILES.length).toBeGreaterThan(40);
  });
});

describe("no retired product name reaches the user", () => {
  /** Comments carry the compatibility decisions; they may name the old brand. */
  const COMMENT = /^\s*(\/\/|\/\*|\*|<!--)/;
  const IMPORT = /^\s*(import|export)\b.*\bfrom\b/;
  /**
   * Quoted literals with no whitespace inside are identifiers, storage keys,
   * wire constants, class names or URLs — `"jobpilot_token"`,
   * `"JOBPILOT_STAGE_LAUNCH"`, `"jobpilot:jobsquery"`, `"jobpilot-web"`. Each is
   * retained on purpose and documented at its definition. Blanking them leaves
   * exactly the prose behind, which is the thing being checked.
   */
  const IDENTIFIER_LITERAL = /(["'`])[^"'`\s]*\1/g;
  /** A `${...}` hole is an expression, not copy. */
  const INTERPOLATION = /\$\{[^}]*\}/g;

  const offendersIn = (source: string): string[] =>
    source
      .split("\n")
      .filter((line) => !COMMENT.test(line) && !IMPORT.test(line))
      .map((line) => line.replace(IDENTIFIER_LITERAL, '""').replace(INTERPOLATION, ""))
      .filter((line) => RETIRED_NAMES.test(line))
      .map((line) => line.trim().slice(0, 140));

  it.each(FILES.map((f) => [relative(ROOT, f), f] as const))(
    "%s",
    (_label, file) => {
      expect(offendersIn(readFileSync(file, "utf8"))).toEqual([]);
    }
  );

  it("catches the regressions it exists to catch", () => {
    // Without this, a broken matcher would leave the whole suite green and
    // prove nothing at all.
    expect(offendersIn("<h1>Welcome to JobPilot AI</h1>")).toHaveLength(1);
    expect(offendersIn('  <p>Sign in to EZJobFind</p>')).toHaveLength(1);
    expect(offendersIn('const msg = "Reopen from EZ Job Find.";')).toHaveLength(1);

    // ...and leaves the deliberately-preserved identifiers alone.
    expect(offendersIn('const LEGACY_STORAGE_KEY = "jobpilot_profile";')).toEqual([]);
    expect(offendersIn('export const AUTH_TOKEN_STORAGE_KEY = "jobpilot_token";')).toEqual([]);
    expect(offendersIn('const MSG_PING = "JOBPILOT_PING";')).toEqual([]);
    expect(offendersIn('const QUERY_EVENT = "jobpilot:jobsquery";')).toEqual([]);
    expect(offendersIn('// app.jobpilot.ai stays trusted for older installs.')).toEqual([]);
    expect(offendersIn('<h1>Welcome to XpertApply</h1>')).toEqual([]);
  });
});
