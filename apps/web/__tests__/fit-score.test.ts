import { describe, expect, it } from "vitest";
import { FIT_SCORE_STYLES, getFitScoreTone, getScoreDisplay } from "../lib/fitScore";

describe("getFitScoreTone", () => {
  it("returns the emphasised slate tone for Strong fit (>= 80)", () => {
    const tone = getFitScoreTone(88);
    expect(tone.key).toBe("strong");
    expect(tone.label).toBe("Strong fit");
    expect(tone.container).toContain("bg-surface-selected");
    expect(tone.number).toContain("text-brand-primary");
  });

  it("returns the link-toned Good fit for 60–79", () => {
    const tone = getFitScoreTone(79);
    expect(tone.key).toBe("good");
    expect(tone.label).toBe("Good fit");
    expect(tone.number).toContain("text-foreground-link");
  });

  it("returns the quiet Stretch tone for 45–59", () => {
    const tone = getFitScoreTone(55);
    expect(tone.key).toBe("stretch");
    expect(tone.label).toBe("Stretch");
    expect(tone.number).toContain("text-foreground-secondary");
  });

  it("returns the muted Low fit tone for < 45", () => {
    const tone = getFitScoreTone(30);
    expect(tone.key).toBe("low");
    expect(tone.label).toBe("Low fit");
    expect(tone.number).toContain("text-foreground-muted");
  });

  it("uses no traffic-light hues in any band", () => {
    for (const style of Object.values(FIT_SCORE_STYLES)) {
      expect(`${style.container} ${style.number}`).not.toMatch(
        /emerald|green|lime|orange|amber|yellow|red|rose|teal|brown/
      );
    }
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
