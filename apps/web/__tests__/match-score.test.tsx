import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MatchScoreInline, MatchScorePanel } from "@/components/jobs/MatchScore";

const fill = (container: HTMLElement) => container.querySelector<HTMLElement>("div.h-full, span.h-full")!;

afterEach(cleanup);

describe("Jobs match score", () => {
  // The bands are the product's long-standing thresholds (fitScore.ts); this pins them where the Jobs page uses them.
  it.each([
    [92, "strong", "Strong fit"],
    [80, "strong", "Strong fit"],
    [79, "good", "Good fit"],
    [60, "good", "Good fit"],
    [59, "stretch", "Stretch"],
    [45, "stretch", "Stretch"],
    [44, "low", "Low fit"],
    [0, "low", "Low fit"]
  ])("score %i is %s", (score, tone, label) => {
    const { container } = render(<MatchScorePanel score={score} scoreState="scored" />);
    expect(screen.getByTestId("match-score-panel")).toHaveAttribute("data-fit-tone", tone);
    expect(container).toHaveTextContent(label);
    expect(container).toHaveTextContent(`${score}`);
    expect(fill(container).style.width).toBe(`${score}%`);
  });

  it("uses the backend's label and announces the number and the label, not colour alone", () => {
    render(<MatchScorePanel score={79.6} label="Good match" scoreState="scored" />);
    expect(screen.getByText("Match score 80 out of 100, Good match")).toBeInTheDocument();
  });

  it("clamps the bar to 0-100", () => {
    expect(fill(render(<MatchScorePanel score={140} scoreState="scored" />).container).style.width).toBe("100%");
    expect(fill(render(<MatchScorePanel score={-5} scoreState="scored" />).container).style.width).toBe("0%");
  });

  it.each([
    ["pending", null, "Calculating fit…"],
    ["failed", null, "Score unavailable"],
    ["profile_incomplete", null, "No fit score"]
  ] as const)("never invents a score for a %s job", (state, score, text) => {
    const { container } = render(<MatchScorePanel score={score} scoreState={state} />);
    expect(container).toHaveTextContent(text);
    expect(container.querySelector(".h-full")).toBeNull();
    expect(container).not.toHaveTextContent("/ 100");
  });

  it("the compact inline form carries the same number, label and fill", () => {
    const { container } = render(<MatchScoreInline score={66} scoreState="scored" />);
    expect(screen.getByTestId("match-score-inline")).toHaveAttribute("data-fit-tone", "good");
    expect(container).toHaveTextContent("66");
    expect(container).toHaveTextContent("Good fit");
    expect(fill(container).style.width).toBe("66%");
  });

  it("the compact form falls back to the existing chip for an unscored job", () => {
    const { container } = render(<MatchScoreInline score={null} scoreState="pending" />);
    expect(container).toHaveTextContent("Calculating fit…");
  });
});
