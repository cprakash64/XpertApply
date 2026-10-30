import { Loader2 } from "lucide-react";
import { getFitScoreTone, getScoreDisplay, type FitToneKey, type ScoreStateValue } from "@/lib/fitScore";
import { FitScoreChip } from "@/components/jobs/badges";

/**
 * The Jobs-page match score, in two shapes of the same data: a restrained panel on wide cards, and a compact inline
 * readout on narrow ones. Neither decides anything: the band, label and colour come from `getFitScoreTone`, whose
 * thresholds are the product's (and the ranking's) and are not touched here. A job with no score shows its real state
 * ("Calculating fit…", "Score unavailable", "No fit score"); a number is never invented.
 *
 * The number and the band label are always printed, so colour is never the only signal. Fill colours are STATIC class
 * strings (Tailwind must see them) over tokens that already have light and dark values.
 */
const BAR: Record<FitToneKey, string> = {
  strong: "bg-fit-strong",
  good: "bg-status-warning",
  stretch: "bg-status-warning",
  low: "bg-status-danger",
  none: "bg-foreground-muted"
};

type Props = {
  score: number | null;
  /** The backend's own label when it sends one; otherwise the band's label. */
  label?: string | null;
  scoreState?: ScoreStateValue | null;
  className?: string;
};

function resolve({ score, label, scoreState }: Props) {
  const display = getScoreDisplay(scoreState, score);
  if (display.kind !== "score" || score === null) return { display, scored: null };
  const tone = getFitScoreTone(score);
  const rounded = Math.round(score);
  return {
    display,
    scored: {
      tone,
      rounded,
      percent: Math.min(100, Math.max(0, score)),
      label: label ?? tone.label,
      announce: `Match score ${rounded} out of 100, ${label ?? tone.label}`
    }
  };
}

/** Desktop and tablet: a fixed-size panel on the right of the card. */
export function MatchScorePanel(props: Props) {
  const { display, scored } = resolve(props);
  return (
    <div
      data-testid="match-score-panel"
      data-fit-tone={scored?.tone.key ?? "none"}
      className={`flex min-h-[7.25rem] w-[13rem] shrink-0 flex-col justify-between rounded-card border border-line-default bg-surface-subtle p-3.5 ${props.className ?? ""}`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground-muted">Match score</p>
      {scored ? (
        <>
          <span className="sr-only">{scored.announce}</span>
          <div aria-hidden>
            <p className="flex items-baseline gap-1.5">
              <span className={`text-[2rem] font-semibold leading-none tabular-nums ${scored.tone.number}`}>{scored.rounded}</span>
              <span className="text-sm text-foreground-muted">/ 100</span>
            </p>
            <p className={`mt-1 text-sm font-medium ${scored.tone.number}`}>{scored.label}</p>
          </div>
          <div aria-hidden className="h-1.5 overflow-hidden rounded-pill bg-line-default">
            <div className={`h-full rounded-pill ${BAR[scored.tone.key]}`} style={{ width: `${scored.percent}%` }} />
          </div>
        </>
      ) : (
        <p
          data-score-state={props.scoreState ?? "pending"}
          title={display.helper}
          className="flex items-center gap-2 text-sm font-medium text-foreground-muted"
        >
          {display.kind === "calculating" && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
          {display.kind === "calculating" ? "Calculating fit…" : display.kind === "failed" ? "Score unavailable" : "No fit score"}
        </p>
      )}
    </div>
  );
}

/** Phone: one horizontal line, number, label and a short bar, with no box of its own. */
export function MatchScoreInline(props: Props) {
  const { scored } = resolve(props);
  if (!scored) return <FitScoreChip score={props.score} label={props.label} scoreState={props.scoreState} className={props.className} />;
  return (
    <div
      data-testid="match-score-inline"
      data-fit-tone={scored.tone.key}
      className={`flex shrink-0 items-center gap-2 whitespace-nowrap ${props.className ?? ""}`}
    >
      <span className="sr-only">{scored.announce}</span>
      <span aria-hidden className={`text-lg font-semibold leading-none tabular-nums ${scored.tone.number}`}>{scored.rounded}</span>
      <span aria-hidden className="text-xs text-foreground-muted">/100</span>
      <span aria-hidden className={`text-xs font-medium ${scored.tone.number}`}>{scored.label}</span>
      <span aria-hidden className="h-1 w-10 overflow-hidden rounded-pill bg-line-default">
        <span className={`block h-full rounded-pill ${BAR[scored.tone.key]}`} style={{ width: `${scored.percent}%` }} />
      </span>
    </div>
  );
}
