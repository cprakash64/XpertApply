/**
 * XA-05 — a safety module that nothing imports is worse than no module.
 *
 * The audit found three of them: `eeoMapping.ts`, `sensitivePolicy.ts` and
 * `submissionEvidence.ts` had zero production importers, none of their symbols
 * appeared in `dist/*.js`, and between them they carried thirty-plus passing
 * tests asserting behaviour the shipped extension did not have. The tests were
 * not wrong about the code; the code was simply never reached. That is the
 * failure mode this guard exists to make impossible to reintroduce silently.
 *
 * The rule: every module under `src/` is either imported by production code, or
 * named below with the finding that owns it. Adding a module and testing it is
 * not enough — it has to be wired, or the omission has to be deliberate and
 * visible here.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");

/** Entry points: nothing imports these, the manifest and build.mjs name them. */
const ENTRY_POINTS = new Set([
  "background.ts",
  "content/bootstrap.ts",
  "ui/sidepanel.ts",
  "e2e-harness.ts"
]);

/**
 * Modules knowingly not wired, each with the finding that owns it.
 *
 * This list is the point of the test: an orphan may exist, but only on the
 * record. Removing an entry must either wire the module or delete it.
 */
const KNOWN_ORPHANS: Record<string, string> = {
  // XA-22 (Informational): run-level frame coordination, superseded in practice
  // by the background's frame registry and the fill lease built on it.
  "frames/runCoordinator.ts": "XA-22 — orphaned run coordinator"
};

// Decommissioned in Stage 3B-R1 (XA-05). Both were "safety modules" with large
// green test suites and zero production effect:
//
//   fields/eeoMapping.ts        its matcher consumed the backend's internal
//                               canonical tokens while the extension only ever
//                               receives display labels, so its fail-closed
//                               guarantee could never have applied. The
//                               invariant now lives in fields/answerAuthority
//                               (checkDemographicOptions), on the live path and
//                               against the real contract.
//
//   ats/submissionEvidence.ts   no producer existed anywhere in the content
//                               script; nothing could reach it. XA-07 (the
//                               missing submission-confirmation feature) stays
//                               OPEN and will need this logic re-implemented
//                               against the path that actually runs.
const DECOMMISSIONED = ["fields/eeoMapping.ts", "ats/submissionEvidence.ts"];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__dbg__") continue;
      walk(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      acc.push(path.relative(SRC, full));
    }
  }
  return acc;
}

/** Every module referenced by an import/export-from in production source. */
function productionImports(modules: string[]): Set<string> {
  const imported = new Set<string>();
  for (const rel of modules) {
    const source = readFileSync(path.join(SRC, rel), "utf8");
    const dir = path.dirname(rel);
    for (const match of source.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
      const target = match[1];
      // Resolve "./x", "../x/y" and directory imports ("./dropdown" -> index.ts).
      const base = path.normalize(path.join(dir, target));
      for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
        const normalized = candidate.split(path.sep).join("/");
        if (modules.includes(normalized)) imported.add(normalized);
      }
    }
  }
  return imported;
}

describe("XA-05 · every module is reachable from production code", () => {
  const modules = walk(SRC).map((m) => m.split(path.sep).join("/"));
  const imported = productionImports(modules);

  it("finds the source tree", () => {
    expect(modules.length).toBeGreaterThan(30);
    expect(modules).toContain("fields/answerAuthority.ts");
  });

  it("has no unrecorded orphan module", () => {
    const orphans = modules.filter(
      (m) => !imported.has(m) && !ENTRY_POINTS.has(m) && !(m in KNOWN_ORPHANS) && !m.endsWith(".mjs")
    );
    expect(orphans).toEqual([]);
  });

  it("keeps the recorded orphans honest — each is still genuinely unimported", () => {
    // If one becomes reachable, the entry is stale and must be removed, so the
    // list can never quietly accumulate modules that are actually in use.
    for (const orphan of Object.keys(KNOWN_ORPHANS)) {
      expect(modules).toContain(orphan);
      expect(imported.has(orphan)).toBe(false);
    }
  });

  it("keeps the decommissioned modules gone rather than re-orphaned", () => {
    // Re-adding either without wiring it would recreate XA-05 exactly.
    for (const removed of DECOMMISSIONED) expect(modules).not.toContain(removed);
  });

  it("proves the modules Stage 3B wired are now genuinely reachable", () => {
    // sensitivePolicy was one of the three dead safety modules. It now decides
    // consent in fields/answerAuthority, so it must be imported.
    expect(imported.has("application/sensitivePolicy.ts")).toBe(true);
    expect(imported.has("fields/answerSemantics.ts")).toBe(true);
    expect(imported.has("fields/answerAuthority.ts")).toBe(true);
    expect(imported.has("security/senderTrust.ts")).toBe(true);
  });
});
