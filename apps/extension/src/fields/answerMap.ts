import type { ApplicationSessionData } from "../types";

type SessionAnswer = ApplicationSessionData["answers"][number];

const YES = new Set(["yes", "true", "y"]);
const NO = new Set(["no", "false", "n"]);
const polarity = (value: string | undefined): "yes" | "no" | null => {
  const v = (value ?? "").trim().toLowerCase();
  return YES.has(v) ? "yes" : NO.has(v) ? "no" : null;
};

/**
 * The session's answers by canonical key.
 *
 * "Will you now OR in the future require sponsorship" is a third question, not the
 * future one. It is answered only when the user has verified BOTH halves:
 * "No" when both are No, "Yes" when either is Yes. If one half is missing,
 * unverified or not a plain yes/no, no answer is produced and the question goes to
 * review. An answer the user saved for the combined wording itself always wins.
 */
export function answerMapFor(session: ApplicationSessionData): Map<string, SessionAnswer> {
  const answers = new Map<string, SessionAnswer>(session.answers.map((a) => [a.canonical_key, a]));
  if (!answers.has("sponsorship_required_now_or_future")) {
    const now = answers.get("sponsorship_required_now");
    const future = answers.get("sponsorship_required_future");
    const a = polarity(now?.value);
    const b = polarity(future?.value);
    if (now?.verified && future?.verified && a && b) {
      const value = a === "yes" || b === "yes" ? "Yes" : "No";
      answers.set("sponsorship_required_now_or_future", {
        ...now, canonical_key: "sponsorship_required_now_or_future", value, display_value: value,
        confidence: Math.min(now.confidence, future.confidence),
        requires_review: now.requires_review || future.requires_review
      });
    }
  }
  return answers;
}
