/**
 * Fit-score visual tone.
 *
 * Maps a 0-100 fit score to a band, a label and a semantic colour. The BANDS are the product's long-standing thresholds and
 * are unchanged (the backend ranks with the same ones, see `app/jobs/ranking.py`):
 *
 *   >= 80  "Strong fit"   green   (fit-strong, the one dedicated fit token family)
 *   60-79  "Good fit"     amber   (status-warning)
 *   45-59  "Stretch"      amber   (status-warning)
 *   < 45   "Low fit"      red     (status-danger)
 *
 * Green, amber and red here are SEMANTIC colours, not brand colours. Amber and red are the status-warning and status-danger
 * tokens; green is the dedicated fit-strong family, because the product's status-success token is navy. Each has a verified
 * light and dark value. Colour is never the only signal:
 * the number and the band label are always rendered next to it. Two bands share amber on purpose (the label tells them
 * apart), so the traffic-light reading stays three-way.
 *
 * Every class resolves through a semantic token that already has a light and a dark value, so no `dark:` variants are
 * needed. The class strings are STATIC so Tailwind's compiler can see them; never build them dynamically.
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
    container: "border-fit-strong-border bg-fit-strong-surface text-fit-strong",
    number: "text-fit-strong",
    description: "Your profile strongly matches this role."
  },
  good: {
    label: "Good fit",
    container: "border-status-warning-border bg-status-warning-surface text-status-warning",
    number: "text-status-warning",
    description: "A decent chance with a few gaps to address."
  },
  stretch: {
    label: "Stretch",
    container: "border-status-warning-border bg-status-warning-surface text-status-warning",
    number: "text-status-warning",
    description: "A stretch — expect notable skill gaps."
  },
  low: {
    label: "Low fit",
    container: "border-status-danger-border bg-status-danger-surface text-status-danger",
    number: "text-status-danger",
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
