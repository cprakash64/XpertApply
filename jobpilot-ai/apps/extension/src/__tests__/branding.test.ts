/**
 * Product branding, at the two places Chrome and the user actually read it:
 * the manifest (store listing, extensions page, toolbar tooltip) and the side
 * panel's own markup.
 *
 * Internal identifiers are deliberately NOT covered here. `JOBPILOT_WEB_ORIGINS`,
 * `isApprovedJobPilotOrigin`, `clearJobPilotFields`, the `JOBPILOT_*` message
 * types and the `__JOBPILOT_BUILD_*` build defines keep their names on purpose:
 * they are a wire contract and a namespace, not a brand, and renaming them would
 * be a compatibility break rather than a rebrand. The guard at the bottom of
 * this file draws exactly that line — legacy spellings are allowed in code, and
 * forbidden in anything a user reads.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";
import { JOBPILOT_WEB_ORIGINS, isApprovedJobPilotOrigin } from "../config";
import { classifyEnvironment } from "../runtimeIdentity";

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf-8");

/** Every spelling the product has shipped under before XpertApply. */
const RETIRED_NAMES = /EZ\s?Job\s?Find|EZJobFind|JobPilot/i;

describe("extension branding", () => {
  it("presents XpertApply to Chrome", () => {
    expect(manifest.name).toBe("XpertApply — Assisted Apply");
    expect(manifest.short_name).toBe("XpertApply");
    expect(manifest.action.default_title).toBe("Open XpertApply Assisted Apply");
    expect(manifest.description).toContain("XpertApply");
  });

  it("leaves no retired product name in Chrome-facing manifest strings", () => {
    for (const value of [manifest.name, manifest.short_name, manifest.description, manifest.action.default_title]) {
      expect(value, value).not.toMatch(RETIRED_NAMES);
    }
  });

  /**
   * The Chrome Web Store rejects an upload whose strings exceed these limits,
   * which is a failure that only shows up at submission time — long after the
   * build is green. A rebrand is exactly when a name grows, so it is checked
   * here rather than discovered in the developer dashboard.
   */
  it("keeps manifest strings within the Chrome Web Store limits", () => {
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.name.length).toBeLessThanOrEqual(75);
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  it("titles and labels the side panel as XpertApply", () => {
    const html = read("src/ui/sidepanel.html");
    expect(html).toContain("<title>XpertApply Assisted Apply</title>");
    expect(html).toContain("<h1>XpertApply — Assisted Apply</h1>");
    // Every visible string in the panel — a retired spelling only survives in
    // code identifiers, and there are none in this file.
    expect(html).not.toMatch(RETIRED_NAMES);
  });
});

describe("production origins", () => {
  it("trusts the new production domain without dropping the previous ones", () => {
    expect(isApprovedJobPilotOrigin("https://xpertapply.com")).toBe(true);
    expect(isApprovedJobPilotOrigin("https://www.xpertapply.com")).toBe(true);
    // Installed extensions must keep working against older deployments. An
    // extension updates on Chrome's schedule, not on ours.
    expect(isApprovedJobPilotOrigin("https://ezjobfind.com")).toBe(true);
    expect(isApprovedJobPilotOrigin("https://www.ezjobfind.com")).toBe(true);
    expect(isApprovedJobPilotOrigin("https://app.jobpilot.ai")).toBe(true);
    expect(isApprovedJobPilotOrigin("http://localhost:3000")).toBe(true);
  });

  it("still rejects look-alike origins", () => {
    for (const origin of [
      "https://xpertapply.com.evil.example",
      "https://notxpertapply.com",
      "http://xpertapply.com",
      "https://xpertapply.com:8443",
      "https://ezjobfind.com.evil.example",
      "https://notezjobfind.com",
      "http://ezjobfind.com"
    ]) {
      expect(isApprovedJobPilotOrigin(origin), origin).toBe(false);
    }
  });

  it("classifies the new domain as production and keeps the old ones recognised", () => {
    expect(classifyEnvironment("https://xpertapply.com")).toBe("production");
    expect(classifyEnvironment("https://api.xpertapply.com")).toBe("production");
    expect(classifyEnvironment("https://staging.xpertapply.com")).toBe("staging");
    expect(classifyEnvironment("https://ezjobfind.com")).toBe("production");
    expect(classifyEnvironment("https://app.jobpilot.ai")).toBe("production");
    expect(classifyEnvironment("http://localhost:8000")).toBe("local");
  });

  it("keeps the manifest content scripts aligned with the trusted origins", () => {
    const bridgeScript = manifest.content_scripts.find((entry) =>
      entry.matches.includes("http://localhost:3000/*")
    );
    expect(bridgeScript).toBeTruthy();
    for (const origin of JOBPILOT_WEB_ORIGINS) {
      expect(bridgeScript?.matches, origin).toContain(`${origin}/*`);
    }
  });
});

/**
 * Regression guard.
 *
 * A rebrand does not fail loudly — it decays, one merged branch at a time, as
 * someone copies an old error message or writes a new one from memory. This
 * reads the extension's user-facing source and fails on a retired product name
 * inside a STRING LITERAL, which is the only place a user can ever see one.
 *
 * Identifiers, comments, URLs and message-type constants are excluded by
 * construction: they are not literals of prose, and the compatibility decisions
 * behind them are documented at their definitions.
 */
describe("no retired product name reaches the user", () => {
  const USER_FACING = [
    "src/content/bootstrap.ts",
    "src/content/review.ts",
    "src/content/reviewActions.ts",
    "src/content/reviewItems.ts",
    "src/content/widget.ts",
    "src/ui/sidepanel.ts",
    "src/ui/sidepanel.html",
    "src/runtimeIdentity.ts",
    "src/background.ts"
  ];

  /**
   * Quoted strings containing a space. A retired name inside `"JOBPILOT_PING"`
   * or `"https://app.jobpilot.ai"` is an identifier or a URL; one inside
   * `"Reopen from JobPilot."` is a sentence somebody reads. The space is what
   * separates the two cheaply and without false alarms.
   *
   * Applied one line at a time. Run against the whole file, an unbalanced quote
   * — an apostrophe in a comment, the closing quote of one import and the
   * opening quote of the next — pairs up across the gap and reports a span of
   * source that is not a literal at all.
   */
  const PROSE = /(["'`])((?:[^"'`\\]|\\.)*\s(?:[^"'`\\]|\\.)*)\1/g;
  /** Comments state the compatibility decisions; they may name the old brand. */
  const COMMENT = /^\s*(\/\/|\/\*|\*|<!--)/;
  const IMPORT = /^\s*(import|export)\b.*\bfrom\b/;
  /**
   * A `${...}` hole inside a template literal is an expression, not copy. The
   * widget renders `` `XpertApply filled ${value.jobpilotFilled}` `` — correct
   * text around an internal field name that stays as it is. Blank the holes so
   * the guard judges only what is actually printed.
   */
  const stripInterpolations = (literal: string) => literal.replace(/\$\{[^}]*\}/g, "");

  it.each(USER_FACING)("%s has no retired name in user-visible copy", (file) => {
    const offenders: string[] = [];
    for (const line of read(file).split("\n")) {
      if (COMMENT.test(line) || IMPORT.test(line)) continue;
      for (const match of line.matchAll(PROSE)) {
        const copy = stripInterpolations(match[2]);
        if (RETIRED_NAMES.test(copy)) offenders.push(copy.trim().slice(0, 120));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("recognises copy that would have regressed", () => {
    // Proves the matcher actually catches what it exists to catch, so a passing
    // suite means something.
    expect(RETIRED_NAMES.test("Reopen the application from JobPilot.")).toBe(true);
    expect(RETIRED_NAMES.test("Reopen the application from EZJobFind.")).toBe(true);
    expect(RETIRED_NAMES.test("Reopen the application from EZ Job Find.")).toBe(true);
    expect(RETIRED_NAMES.test("Reopen the application from XpertApply.")).toBe(false);
  });
});
