/**
 * Bounded, cancellable multi-step application workflow (EXT-LIVE-05W).
 *
 * Pure decision logic: given the current run and an observation of the page it returns the next action and
 * the updated run. The caller performs the action (fill, click one verified Next, wait). The engine never
 * touches the DOM and never stores field values, only counts, step signatures and identifiers.
 *
 * Guarantees:
 *  - Advancing needs an explicit user-started run in "application" mode ("Complete application").
 *  - At most one advance per step signature (no duplicate Next, no navigation loops).
 *  - Hard caps on steps, advances and wall time; every cap ends in FAILED with a reason, never a retry loop.
 *  - A run is bound to origin, application identity, account identity and run id; a mismatch discards it.
 *  - Review/submit pages are terminal for the engine (REVIEW_READY). Final submission is not an action here.
 */

export type WorkflowState =
  | "IDLE" | "DETECTING" | "FILLING" | "VERIFYING" | "WAITING_FOR_USER"
  | "ADVANCING" | "REVIEW_READY" | "FAILED" | "CANCELLED";

export type WorkflowMode = "page" | "application";

export interface WorkflowRun {
  runId: string;
  mode: WorkflowMode;
  origin: string;
  applicationKey: string;
  accountKey: string;
  state: WorkflowState;
  startedAt: number;
  stepsSeen: number;
  advances: number;
  /** Step signatures already advanced from; a signature is never advanced twice. */
  advancedFrom: string[];
  /** Signature of the page the last advance was issued from, awaiting a different page. */
  awaitingChangeFrom: string | null;
  pausedAt: number | null;
  /** When the last advance was issued; bounds the wait for the next page. */
  advancedAt: number | null;
  lastSignature: string | null;
  reason: string | null;
  paused: boolean;
}

export const LIMITS = { maxSteps: 40, maxAdvances: 30, maxMs: 45 * 60_000, maxAdvanceWaitMs: 20_000 } as const;

export interface Observation {
  now: number;
  /** Stable signature of the visible step (no values). */
  signature: string;
  /** Step kind from the ATS adapter ("review" ends the run; others per `boundary`). */
  stepKind: string;
  isReview: boolean;
  /** Authentication, verification, CAPTCHA, start choice, or disclosure the person must handle. */
  boundary: string | null;
  /** Required answers still missing/uncertain after the fill pass. */
  unresolved: number;
  technicalIssues: number;
  consentActions: number;
  validationErrors: number;
  /** A safe forward control exists. */
  hasSafeNext: boolean;
  /** The fill pass for this signature has finished and been verified against the live form. */
  fillVerified: boolean;
  origin: string;
  applicationKey: string;
  accountKey: string;
}

export type Action =
  | { kind: "none" }
  | { kind: "fill" }
  | { kind: "advance" }
  | { kind: "wait"; reason: string }
  | { kind: "review_ready" }
  | { kind: "fail"; reason: string };

export function newRunId(rand: () => number = Math.random): string {
  return `run-${Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0")}${Date.now().toString(16)}`;
}

export function startRun(mode: WorkflowMode, o: Pick<Observation, "now" | "origin" | "applicationKey" | "accountKey">, runId = newRunId()): WorkflowRun {
  return { runId, mode, origin: o.origin, applicationKey: o.applicationKey, accountKey: o.accountKey, state: "DETECTING", startedAt: o.now, stepsSeen: 0, advances: 0, advancedFrom: [], awaitingChangeFrom: null, pausedAt: null, advancedAt: null, lastSignature: null, reason: null, paused: false };
}

const terminal = (s: WorkflowState): boolean => s === "REVIEW_READY" || s === "FAILED" || s === "CANCELLED";

export function cancel(run: WorkflowRun): WorkflowRun { return terminal(run.state) ? run : { ...run, state: "CANCELLED", reason: "cancelled_by_user" }; }
export function pause(run: WorkflowRun, now: number): WorkflowRun { return terminal(run.state) ? run : { ...run, paused: true, pausedAt: now, state: "WAITING_FOR_USER", reason: "paused_by_user" }; }
export function resume(run: WorkflowRun): WorkflowRun { return run.state === "WAITING_FOR_USER" || run.paused ? { ...run, paused: false, pausedAt: null, state: "DETECTING", reason: null } : run; }

/** A restored run is only valid for the same origin, application and account, and within its time bound. */
export function isRunValidFor(run: WorkflowRun, o: Pick<Observation, "now" | "origin" | "applicationKey" | "accountKey">): boolean {
  return run.origin === o.origin && run.applicationKey === o.applicationKey && run.accountKey === o.accountKey
    && o.now - run.startedAt <= LIMITS.maxMs && !terminal(run.state);
}

export function decide(run: WorkflowRun, o: Observation): { run: WorkflowRun; action: Action } {
  if (terminal(run.state)) return { run, action: { kind: "none" } };
  if (!isRunValidFor(run, o)) {
    const bad = o.now - run.startedAt > LIMITS.maxMs ? "run_timed_out" : "run_identity_changed";
    return { run: { ...run, state: "FAILED", reason: bad }, action: { kind: "fail", reason: bad } };
  }
  if (run.paused) return { run, action: { kind: "wait", reason: "paused_by_user" } };

  // The page we advanced from has not changed yet: wait, but not forever.
  if (run.awaitingChangeFrom !== null && run.awaitingChangeFrom === o.signature) {
    const waited = run.advancedAt === null ? 0 : o.now - run.advancedAt;
    if (run.advancedAt !== null && waited > LIMITS.maxAdvanceWaitMs) {
      const r = { ...run, state: "WAITING_FOR_USER" as const, reason: o.validationErrors > 0 ? "validation_errors_after_next" : "next_did_not_navigate", awaitingChangeFrom: null };
      return { run: r, action: { kind: "wait", reason: r.reason! } };
    }
    return { run: { ...run, state: "ADVANCING" }, action: { kind: "none" } };
  }

  let r: WorkflowRun = run;
  if (run.awaitingChangeFrom !== null) r = { ...r, awaitingChangeFrom: null, advancedAt: null };
  if (o.signature !== r.lastSignature) r = { ...r, stepsSeen: r.stepsSeen + 1, lastSignature: o.signature };
  if (r.stepsSeen > LIMITS.maxSteps) return fail(r, "too_many_steps");

  if (o.isReview) return { run: { ...r, state: "REVIEW_READY", reason: null }, action: { kind: "review_ready" } };
  if (o.boundary) return waitFor(r, o.boundary);
  if (r.mode === "page" && o.fillVerified) return { run: { ...r, state: "REVIEW_READY", reason: "page_complete" }, action: { kind: "none" } };
  if (!o.fillVerified) return { run: { ...r, state: "FILLING", reason: null }, action: { kind: "fill" } };

  // Verified: anything unresolved means the person decides, never a guess.
  if (o.unresolved > 0) return waitFor(r, `${o.unresolved}_needs_answer`);
  if (o.consentActions > 0) return waitFor(r, "consent_needs_you");
  if (o.technicalIssues > 0) return waitFor(r, "technical_issue");
  if (o.validationErrors > 0) return waitFor(r, "validation_errors");
  if (!o.hasSafeNext) return waitFor(r, "no_safe_next_control");
  if (r.advancedFrom.includes(o.signature)) return fail(r, "navigation_loop");
  if (r.advances >= LIMITS.maxAdvances) return fail(r, "too_many_advances");
  return {
    run: { ...r, state: "ADVANCING", reason: null, advances: r.advances + 1, advancedFrom: [...r.advancedFrom, o.signature], awaitingChangeFrom: o.signature, advancedAt: o.now },
    action: { kind: "advance" }
  };
}

function waitFor(r: WorkflowRun, reason: string): { run: WorkflowRun; action: Action } {
  return { run: { ...r, state: "WAITING_FOR_USER", reason }, action: { kind: "wait", reason } };
}
function fail(r: WorkflowRun, reason: string): { run: WorkflowRun; action: Action } {
  return { run: { ...r, state: "FAILED", reason }, action: { kind: "fail", reason } };
}

// ---- persistence (page sessionStorage: per tab, per origin, survives reloads and worker sleep) ----
const KEY = "xpertapply.workflow.v1";
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export function saveRun(store: StorageLike, run: WorkflowRun): void {
  try { store.setItem(KEY, JSON.stringify(run)); } catch { /* storage unavailable: run simply will not survive a reload */ }
}
export function clearRun(store: StorageLike): void { try { store.removeItem(KEY); } catch { /* ignore */ } }
export function loadRun(store: StorageLike, o: Pick<Observation, "now" | "origin" | "applicationKey" | "accountKey">): WorkflowRun | null {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const run = JSON.parse(raw) as WorkflowRun;
    if (typeof run?.runId !== "string" || !Array.isArray(run.advancedFrom)) { clearRun(store); return null; }
    if (!isRunValidFor(run, o)) { clearRun(store); return null; }
    return run;
  } catch { clearRun(store); return null; }
}

/** Human wording for every pause, shown in the assistant. */
export function pauseMessage(reason: string | null): string {
  if (!reason) return "";
  if (/^\d+_needs_answer$/.test(reason)) { const n = Number(reason.split("_")[0]); return `${n} question${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} your answer. XpertApply will continue when you have answered.`; }
  const map: Record<string, string> = {
    sign_in: "Sign in to this employer's site yourself. XpertApply will continue afterwards.",
    create_account: "This employer needs an account. Create it yourself; XpertApply never creates accounts or handles passwords for you here.",
    verification: "Complete the verification or CAPTCHA yourself. XpertApply will not bypass it.",
    start_choice: "Choose how to start (Autofill with Resume or Apply Manually). XpertApply continues on the next page.",
    voluntary_disclosures: "Voluntary disclosures are your decision. Answer them yourself, then continue.",
    self_identify: "Self-identification is your decision. Answer it yourself, then continue.",
    consent_needs_you: "A consent or attestation needs your own choice.",
    technical_issue: "A field could not be filled and verified. Check it, then continue.",
    validation_errors: "The page shows validation errors. Fix them, then continue.",
    validation_errors_after_next: "The employer rejected the step. Fix the highlighted fields, then continue.",
    next_did_not_navigate: "The page did not move to the next step. Check it, then continue.",
    no_safe_next_control: "No safe Next button was found. Continue yourself; XpertApply will keep helping.",
    paused_by_user: "Paused.",
    navigation_loop: "Stopped: the same step appeared again.",
    too_many_steps: "Stopped: too many steps for one run.",
    too_many_advances: "Stopped: too many page changes for one run.",
    run_timed_out: "Stopped: this run took too long. Start again.",
    run_identity_changed: "Stopped: the application or account changed.",
    cancelled_by_user: "Cancelled."
  };
  return map[reason] ?? "Waiting for you.";
}
