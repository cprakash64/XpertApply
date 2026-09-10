import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatApplicationStatus,
  getApplicationStatusTone,
  isApplicationStatus,
  type ApplicationStatus,
  type ApplicationStatusTone
} from "../lib/applicationStatus";
import type { StatusTone } from "../components/ui";

const ROOT = join(__dirname, "..");

/**
 * The full lifecycle, spelled out as data.
 *
 * Written as an exhaustive record rather than a list of cases so that adding a
 * status to the union without deciding what it *means* fails to typecheck here.
 */
const EXPECTED: Record<ApplicationStatus, { tone: ApplicationStatusTone; label: string }> = {
  saved: { tone: "neutral", label: "Saved" },
  ready_to_apply: { tone: "neutral", label: "Saved" },
  applying: { tone: "warning", label: "Applying" },
  applied: { tone: "warning", label: "Applied" },
  interview: { tone: "info", label: "Interview" },
  offer: { tone: "success", label: "Offer" },
  rejected: { tone: "danger", label: "Rejected" },
  withdrawn: { tone: "neutral", label: "Withdrawn" }
};

describe("application status semantics", () => {
  it.each(Object.entries(EXPECTED))("maps %s to its domain tone and label", (status, expected) => {
    expect(getApplicationStatusTone(status)).toBe(expected.tone);
    expect(formatApplicationStatus(status)).toBe(expected.label);
  });

  it("reserves success for an offer and danger for a rejection", () => {
    // The two claims most worth protecting: green must mean a good outcome and
    // nothing else, and a rejection must never read as neutral.
    const success = Object.keys(EXPECTED).filter(
      (status) => getApplicationStatusTone(status) === "success"
    );
    const danger = Object.keys(EXPECTED).filter(
      (status) => getApplicationStatusTone(status) === "danger"
    );
    expect(success).toEqual(["offer"]);
    expect(danger).toEqual(["rejected"]);
  });

  it("degrades an unrecognised status to neutral rather than throwing", () => {
    // The backend can grow a status before the frontend knows about it. Neutral
    // reads as "no judgement", which is the only honest thing to show.
    for (const unknown of ["ghosted", "on_hold", "", "OFFER", "offer "]) {
      expect(getApplicationStatusTone(unknown)).toBe("neutral");
    }
    expect(getApplicationStatusTone(null)).toBe("neutral");
    expect(getApplicationStatusTone(undefined)).toBe("neutral");
  });

  it("still shows something truthful for an unrecognised status", () => {
    expect(formatApplicationStatus("on_hold")).toBe("On hold");
    expect(formatApplicationStatus(null)).toBe("");
  });

  it("narrows only known statuses", () => {
    expect(isApplicationStatus("offer")).toBe(true);
    expect(isApplicationStatus("ghosted")).toBe(false);
    expect(isApplicationStatus(42)).toBe(false);
    // Guards against a prototype key being mistaken for a status.
    expect(isApplicationStatus("toString")).toBe(false);
  });

  it("stays assignable to the design system's StatusTone", () => {
    // lib/ deliberately does not import from components/, so the two unions are
    // declared separately. This is the assertion that stops them drifting.
    const toDesignSystem: StatusTone = getApplicationStatusTone("offer");
    const fromDesignSystem: ApplicationStatusTone = "warning" satisfies StatusTone;
    expect(toDesignSystem).toBe("success");
    expect(fromDesignSystem).toBe("warning");
  });
});

/**
 * The point of the module: one mapping, two screens.
 *
 * Asserted against source rather than by re-listing the expected map a third
 * time — a copy of the table in each screen's test is exactly the drift this
 * module exists to prevent.
 */
describe("both screens consume the canonical mapping", () => {
  it.each(["components/DashboardClient.tsx", "components/TrackerClient.tsx"])(
    "%s imports the shared helper and declares no local tone map",
    (file) => {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).toContain('from "@/lib/applicationStatus"');
      expect(source).toContain("getApplicationStatusTone(");
      // No screen may re-derive a tone locally.
      expect(source).not.toMatch(/function\s+statusTone\b/);
      expect(source).not.toMatch(/border-sky-300|bg-sky-500/);
      expect(source).not.toMatch(/--success-surface|--warning-surface|--danger-surface/);
    }
  );
});
