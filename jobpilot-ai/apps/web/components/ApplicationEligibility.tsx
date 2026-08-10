"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, ShieldQuestion } from "lucide-react";
import { api } from "@/lib/api";

/**
 * The three legal answers an employer asks for, answered once here.
 *
 * Two rules drive the whole component:
 *
 * 1. Unanswered is a real state, visually distinct from "No". Nothing is
 *    preselected, because a preselected No is an answer the user never gave —
 *    and these end up on real applications.
 * 2. "Answer during each application" is a deliberate third choice, not the
 *    absence of a choice, so it is offered explicitly rather than inferred
 *    from silence.
 */

type Choice = "yes" | "no" | "answer_each_time";

type EligibilityAnswer = {
  field: string;
  prompt: string;
  answer: "yes" | "no" | null;
  answered: boolean;
  reusable: boolean;
  needs_confirmation: boolean;
  confirmed_at: string | null;
  version: number;
};

const CHOICES: { value: Choice; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "answer_each_time", label: "Answer during each application" }
];

export function ApplicationEligibility() {
  const [answers, setAnswers] = useState<EligibilityAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedField, setSavedField] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await api<{ answers: EligibilityAnswer[] }>("/profile/application-eligibility");
        if (active) setAnswers(result.answers);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load your answers.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const choose = useCallback(async (field: string, answer: Choice) => {
    setSaving(field);
    setError("");
    setSavedField(null);
    try {
      const result = await api<{ answers: EligibilityAnswer[] }>("/profile/application-eligibility", {
        method: "PUT",
        body: JSON.stringify({ field, answer })
      });
      setAnswers(result.answers);
      setSavedField(field);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save that answer.");
    } finally {
      setSaving(null);
    }
  }, []);

  return (
    <section aria-labelledby="eligibility-heading" className="rounded-2xl border border-line bg-white p-6">
      <div className="flex items-start gap-3">
        <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-[var(--text-muted)]" aria-hidden />
        <div>
          <h2 id="eligibility-heading" className="text-base font-semibold">
            Application eligibility answers
          </h2>
          <p className="mt-1 max-w-prose text-sm leading-6 text-[var(--text-muted)]">
            JobPilot can reuse these answers for equivalent application questions. You can review or
            change them before submitting.
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-6 flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading your answers…
        </p>
      ) : (
        <div className="mt-6 space-y-7">
          {answers.map((entry) => {
            // The selected radio reflects ONLY an explicitly confirmed answer.
            // An unanswered question leaves every option unselected.
            const selected: Choice | null = entry.answered ? entry.answer : null;
            const busy = saving === entry.field;
            return (
              <fieldset key={entry.field} disabled={busy} className="border-0 p-0">
                <legend className="text-sm font-medium text-[var(--text-secondary)]">
                  {entry.prompt}
                </legend>
                <div role="radiogroup" aria-label={entry.prompt} className="mt-3 flex flex-wrap gap-2">
                  {CHOICES.map((choice) => {
                    const active = selected === choice.value;
                    return (
                      <button
                        key={choice.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => void choose(entry.field, choice.value)}
                        className={`focus-ring inline-flex h-10 items-center rounded-lg border px-4 text-sm font-medium transition-colors ${
                          active
                            ? "border-[var(--accent)] bg-[var(--success-surface)] text-[var(--accent)]"
                            : "border-line bg-white text-[var(--text-secondary)] hover:bg-panel"
                        }`}
                      >
                        {choice.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  {busy ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving…
                    </span>
                  ) : savedField === entry.field ? (
                    <span className="inline-flex items-center gap-1.5 text-[var(--accent)]">
                      <Check className="h-3 w-3" aria-hidden /> Saved
                    </span>
                  ) : entry.needs_confirmation ? (
                    "Please confirm this answer is still correct."
                  ) : entry.answered && entry.confirmed_at ? (
                    `Confirmed ${new Date(entry.confirmed_at).toLocaleDateString()}`
                  ) : (
                    "Not answered yet — JobPilot will ask you during an application."
                  )}
                </p>
              </fieldset>
            );
          })}
        </div>
      )}
    </section>
  );
}
