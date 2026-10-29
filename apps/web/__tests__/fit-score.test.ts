import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIT_SCORE_STYLES, getFitScoreTone, getScoreDisplay } from "../lib/fitScore";

describe("getFitScoreTone", () => {
  it("is green for Strong fit (>= 80), with the number and label beside it", () => {
    const tone = getFitScoreTone(88);
    expect(tone.key).toBe("strong");
    expect(tone.label).toBe("Strong fit");
    expect(tone.container).toContain("fit-strong");
    expect(tone.number).toContain("text-fit-strong");
  });

  it("is amber for Good fit (60-79) and for Stretch (45-59), told apart by label", () => {
    const good = getFitScoreTone(79);
    expect(good.key).toBe("good");
    expect(good.label).toBe("Good fit");
    expect(good.container).toContain("status-warning");
    const stretch = getFitScoreTone(55);
    expect(stretch.key).toBe("stretch");
    expect(stretch.label).toBe("Stretch");
    expect(stretch.container).toContain("status-warning");
    expect(good.label).not.toBe(stretch.label);
  });

  it("is red for Low fit (< 45)", () => {
    const tone = getFitScoreTone(30);
    expect(tone.key).toBe("low");
    expect(tone.label).toBe("Low fit");
    expect(tone.container).toContain("status-danger");
    expect(tone.number).toContain("text-status-danger");
  });

  it("uses only the semantic status tokens (green, amber, red), never raw palette colours", () => {
    for (const [key, style] of Object.entries(FIT_SCORE_STYLES)) {
      const classes = `${style.container} ${style.number}`;
      expect(classes, key).not.toMatch(/\b(?:bg|text|border)-(?:emerald|green|lime|orange|amber|yellow|red|rose|teal)-\d/);
      if (key !== "none") expect(classes, key).toMatch(/fit-strong|status-(?:warning|danger)/);
    }
  });

  it("every band keeps a visible text label, so colour is never the only signal", () => {
    for (const score of [95, 70, 50, 10]) expect(getFitScoreTone(score).label).toMatch(/fit|Stretch/);
  });

  it("handles boundary values inclusively", () => {
    expect(getFitScoreTone(80).key).toBe("strong");
    expect(getFitScoreTone(60).key).toBe("good");
    expect(getFitScoreTone(45).key).toBe("stretch");
    expect(getFitScoreTone(44).key).toBe("low");
  });

  it("returns a neutral tone when the score is missing", () => {
    expect(getFitScoreTone(null).key).toBe("none");
    expect(getFitScoreTone(undefined).label).toBe("Not scored");
  });

  it("no longer defines a colored top strip", () => {
    for (const style of Object.values(FIT_SCORE_STYLES)) {
      expect(style).not.toHaveProperty("strip");
    }
  });
});

describe("getScoreDisplay", () => {
  it("shows a calculating state for pending/scoring and keeps polling", () => {
    for (const state of ["pending", "scoring"] as const) {
      const d = getScoreDisplay(state, null);
      expect(d.kind).toBe("calculating");
      expect(d.label).toBe("Calculating fit…");
      expect(d.pending).toBe(true);
    }
  });

  it("treats a missing state with no score as calculating (not permanent 'Not scored')", () => {
    const d = getScoreDisplay(null, null);
    expect(d.kind).toBe("calculating");
    expect(d.pending).toBe(true);
  });

  it("prompts to complete the profile for profile_incomplete", () => {
    const d = getScoreDisplay("profile_incomplete", null);
    expect(d.kind).toBe("profile_incomplete");
    expect(d.label).toContain("Complete your profile");
    expect(d.pending).toBe(false);
  });

  it("shows an unavailable state for failed and stops polling", () => {
    const d = getScoreDisplay("failed", null);
    expect(d.kind).toBe("failed");
    expect(d.label).toBe("Score unavailable");
    expect(d.pending).toBe(false);
  });

  it("renders the real score for scored and stops polling", () => {
    const d = getScoreDisplay("scored", 82);
    expect(d.kind).toBe("score");
    expect(d.pending).toBe(false);
  });

  it("falls back to scored when a number exists but no state is given", () => {
    const d = getScoreDisplay(undefined, 70);
    expect(d.kind).toBe("score");
  });
});

describe("fit-strong tokens", () => {
  const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
  const tailwind = readFileSync(join(__dirname, "../tailwind.config.ts"), "utf8");

  it("define green for the light theme and a separate value for the dark theme", () => {
    const values = [...css.matchAll(/--color-fit-strong:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());
    expect(values).toHaveLength(2);
    expect(values[0]).not.toBe(values[1]);
    for (const family of ["--color-fit-strong-surface", "--color-fit-strong-border"]) {
      expect([...css.matchAll(new RegExp(`${family}:`, "g"))]).toHaveLength(2);
    }
  });

  it("are mapped in Tailwind so the static class names resolve", () => {
    for (const name of ["fit-strong", "fit-strong-surface", "fit-strong-border"]) expect(tailwind).toContain(`"${name}"`);
  });
});
