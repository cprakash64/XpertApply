/**
 * "Answer for this application", as a decision procedure.
 *
 * The DOM work (finding the control, driving the menu, verifying the value) and
 * the network work live in the content script. What lives here is the ORDER and
 * the honesty rules: validate before sending, never claim a fill that was not
 * verified, never skip a consent question, and never move a required field out
 * of review because the user deferred it.
 *
 * It is separated from `bootstrap.ts` because those rules are the part worth
 * testing exhaustively, and they should not require a page, a service worker or
 * a session to exercise.
 */

import type { QuestionLedger, QuestionState } from "./questionLedger";
import { APPLICATION_SOURCE_LABEL } from "./reviewItems";
import { affectedCanonicalKeys, validateOverrideRequest } from "./reviewActions";
import type { AnswerOutcome, DeferOutcome } from "./widget";

/** Everything the procedure needs from the outside world, injected. */
export interface ApplicationAnswerDeps {
  ledger: QuestionLedger;
  /** The session the widget is bound to, or null when it is not connected. */
  sessionId: () => number | null;
  /**
   * Store the override. Resolves `{ ok: false, error }` for every failure —
   * 401/403/404/410/422, a timeout, or no network at all — because the caller
   * must treat "we do not know" exactly as it treats a refusal.
   */
  storeOverride: (
    canonicalKey: string,
    value: boolean
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Re-resolve the given canonical questions and report each field's outcome. */
  reresolve: (canonicalKeys: string[]) => Promise<Map<string, QuestionState>>;
  /** Safe, low-cardinality audit. Never receives an answer value. */
  audit: (event: { action_type: string; field_key: string; status: string }) => void;
  /** Re-render the review list from the ledger. */
  onLedgerChanged: () => void;
  /** Re-attach recovered application-answer provenance to the ledger. */
  markRecovered?: (canonicalKey: string) => void;
}

/**
 * Which ledger fields does answering `canonicalKey` require re-resolving?
 *
 * The whole point of the targeted refresh: everything NOT in this set is left
 * alone, including every control that is already filled and verified. Re-driving
 * a dropdown that is already correct is how a controlled React select gets
 * another chance to reject the value it accepted.
 */
export function targetFieldKeysFor(ledger: QuestionLedger, canonicalKey: string): string[] {
  const wanted = new Set(affectedCanonicalKeys(canonicalKey));
  return ledger
    .all()
    .filter((entry) => entry.canonicalCategory !== null && wanted.has(entry.canonicalCategory))
    .map((entry) => entry.fieldKey);
}

export function createApplicationAnswerHandlers(deps: ApplicationAnswerDeps): {
  answerForThisApplication: (request: unknown) => Promise<AnswerOutcome>;
  leaveUnresolved: (fieldKey: string) => Promise<DeferOutcome>;
} {
  return {
    async answerForThisApplication(request): Promise<AnswerOutcome> {
      // Boundary 2 of 4. The widget validated this before building it; that is
      // not a reason to trust it here.
      const validation = validateOverrideRequest(request);
      if (!validation.ok) {
        return { ok: false, stored: false, code: "ANSWER_NOT_PERMITTED" };
      }
      const { fieldKey, canonicalKey, value, sessionId } = validation.request;

      const activeSession = deps.sessionId();
      if (activeSession === null || activeSession !== sessionId) {
        return { ok: false, stored: false, code: "SESSION_NOT_FOUND" };
      }

      // The consent rule, restated where the action happens. A consent item
      // offers no answer button, and must not acquire one through a crafted
      // request — the server refuses the same sensitivities independently.
      const entry = deps.ledger.get(fieldKey);
      if (entry && (entry.state === "sensitive_manual" || entry.sensitivity === "consent")) {
        return { ok: false, stored: false, code: "ANSWER_NOT_PERMITTED" };
      }

      const stored = await deps.storeOverride(canonicalKey, value);
      if (!stored.ok) {
        // Nothing changed on the employer's page and nothing was stored, so the
        // item is exactly as reviewable as it was a moment ago.
        return { ok: false, stored: false, code: stored.error ?? "UNKNOWN" };
      }

      deps.markRecovered?.(canonicalKey);
      deps.audit({
        action_type: "application_answer_override",
        // A registry key. Never the answer.
        field_key: canonicalKey,
        status: "confirmed_for_application"
      });

      // Only this question, plus anything whose resolution depends on it.
      const outcomes = await deps.reresolve(affectedCanonicalKeys(canonicalKey));
      deps.onLedgerChanged();

      const state = outcomes.get(fieldKey);
      if (state === "filled_verified") {
        return { ok: true, stored: true, sourceLabel: APPLICATION_SOURCE_LABEL };
      }
      // Stored, but the employer's page does not show it. Reported as a failure:
      // saying otherwise would tell the user a required field is answered when
      // the control is still blank.
      return {
        ok: false,
        stored: true,
        code: state === undefined ? "CONTROL_NOT_FOUND" : "SELECTION_FAILED"
      };
    },

    async leaveUnresolved(fieldKey): Promise<DeferOutcome> {
      const entry = deps.ledger.get(fieldKey);
      if (!entry) return { ok: false, stillVisible: true };

      // Consent and attestations are never skipped on the user's behalf, at any
      // scope, through any action.
      if (entry.state === "sensitive_manual" || entry.sensitivity === "consent") {
        return { ok: false, stillVisible: true };
      }

      if (entry.required) {
        // Deferred, NOT resolved. The state does not move, so the field keeps
        // counting as a required blank, keeps blocking "Mark application
        // complete", and keeps its place in the final review.
        deps.ledger.record({
          fieldKey,
          state: entry.state,
          reasonCode: "user_deferred",
          deferred: true
        });
      } else {
        // An optional question the user declines is a legitimate outcome. It
        // reuses the SAME ledger entry rather than adding a second one.
        deps.ledger.record({
          fieldKey,
          state: "optional_skipped",
          reasonCode: "user_deferred",
          deferred: true
        });
      }

      deps.audit({
        action_type: "review_item_deferred",
        field_key: entry.canonicalCategory ?? "unmapped",
        status: entry.required ? "required_deferred" : "optional_skipped"
      });
      deps.onLedgerChanged();
      return { ok: true, stillVisible: entry.required };
    }
  };
}
