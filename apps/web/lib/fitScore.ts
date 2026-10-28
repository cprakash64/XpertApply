/**
 * Fit-score visual tone.
 *
 * Maps a 0–100 fit score to a tone + label. The band is carried by the LABEL
 * and the number, never by hue alone: the scale is a single slate/glacier
 * family that steps from emphasised (strong) to quiet (low), so no band reads
 * as traffic-light green, amber or red, and a colour-blind user loses nothing.
 *
 *   >= 80  "Strong fit"   selected surface, brand border, brand number
 *   60–79  "Good fit"     subtle surface, interactive border, link-coloured number
 *   45–59  "Stretch"      subtle surface, default border, secondary number
 *   < 45   "Low fit"      subtle surface, default border, muted number
 *
 * Every class resolves through a semantic token that already has a light and a
 * dark value, so no `dark:` variants are needed. The class strings are STATIC
 * so Tailwind's compiler can see them; never build them dynamically.
 */

export type FitToneKey = "strong" | "good" | "stretch" | "low" | "none";

export type FitScoreTone = {
  key: FitToneKey;
  label: "Strong fit" | "Good fit" | "Stretch" | "Low fit" | "Not scored";
  /** Container classes: border + background tint + text color for the card. */
  container: string;
  /** Class for the large score number. */
  number: string;
  description: string;
};

export const FIT_SCORE_STYLES: Record<FitToneKey, Omit<FitScoreTone, "key">> = {
  strong: {
    label: "Strong fit",
    container: "border-line-selected bg-surface-selected text-foreground",
    number: "text-brand-primary",
    description: "Your profile strongly matches this role."
  },
  good: {
    label: "Good fit",
    container: "border-line-interactive bg-surface-subtle text-foreground",
    number: "text-foreground-link",
    description: "A decent chance with a few gaps to address."
  },
  stretch: {
    label: "Stretch",
    container: "border-line-default bg-surface-subtle text-foreground",
    number: "text-foreground-secondary",
    description: "A stretch — expect notable skill gaps."
  },
  low: {
    label: "Low fit",
    container: "border-line-default bg-surface-subtle text-foreground-secondary",
    number: "text-foreground-muted",
    description: "This role is far from your current profile."
  },
  none: {
    label: "Not scored",
    container: "border-line-default bg-surface-subtle text-foreground-muted",
    number: "text-foreground-muted",
    description: "Refresh matches after completing your profile for a fit score."
  }
};

export function getFitScoreTone(score: number | null | undefined): FitScoreTone {
  const key = fitToneKey(score);
  return { key, ...FIT_SCORE_STYLES[key] };
}

export type ScoreStateValue =
  | "pending"
  | "scoring"
  | "scored"
  | "failed"
  | "profile_incomplete";

export type ScoreDisplay = {
  /** How to render the card body. */
  kind: "score" | "calculating" | "profile_incomplete" | "failed";
  label: string;
  helper: string;
  /** Whether the list should keep polling because this score is still settling. */
  pending: boolean;
};

/**
 * Resolve what to show for a match given its lifecycle state.
 *
 * A missing state with no score is treated as a transient "calculating" rather
 * than a permanent "Not scored": a background task is expected to fill it in, so
 * the list should poll instead of showing a dead end.
 */
export function getScoreDisplay(
  state: ScoreStateValue | null | undefined,
  score: number | null | undefined
): ScoreDisplay {
  const resolved = state ?? (typeof score === "number" ? "scored" : "pending");
  switch (resolved) {
    case "scored":
      return { kind: "score", label: "", helper: "", pending: false };
    case "profile_incomplete":
      return {
        kind: "profile_incomplete",
        label: "Complete your profile for a fit score",
        helper: "We need your target roles or skills to score this role.",
        pending: false
      };
    case "failed":
      return {
        kind: "failed",
        label: "Score unavailable",
        helper: "We couldn't score this role. Retry, or it will be retried automatically.",
        pending: false
      };
    case "pending":
    case "scoring":
    default:
      return {
        kind: "calculating",
        label: "Calculating fit…",
        helper: "Scoring this role against your profile.",
        pending: true
      };
  }
}

function fitToneKey(score: number | null | undefined): FitToneKey {
  if (score === null || score === undefined || Number.isNaN(score)) {
    return "none";
  }
  if (score >= 80) return "strong";
  if (score >= 60) return "good";
  if (score >= 45) return "stretch";
  return "low";
}
