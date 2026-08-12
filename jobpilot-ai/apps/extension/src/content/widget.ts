/** Compact, side-panel-independent status UI + review assistant. Isolated in
 * Shadow DOM so ATS styles cannot break it and it cannot affect application
 * form layout. Never submits anything — every action here either fills a
 * field the user explicitly chose an answer for, or saves that answer to the
 * XpertApply profile/answer vault on explicit opt-in. */
import type { LedgerCounts } from "../fields/ledger";
import type { AuthoritativeReviewItem } from "./reviewItems";
import { answerNotesFor, overrideFailureMessage, type OverrideRequest } from "./reviewActions";

export type WidgetStage = "preparing" | "opening" | "detecting" | "filling" | "uploading" | "review" | "ready" | "failed";

export interface WidgetUpdate {
  stage: WidgetStage;
  filled?: number;
  total?: number;
  /**
   * The header text, when the caller has a more accurate name for what is
   * happening than the coarse `stage` enum does.
   *
   * This exists because the header used to be derived from `stage` alone, and
   * the question-resolution path published everything as `detecting` — so the
   * panel said "Detecting fields" while the line beneath it correctly said
   * "Matching your saved answers". One authoritative stage now names both.
   */
  stageLabel?: string;
  message?: string;
  /** false for a terminal failure (expired/consumed/mismatched handoff) —
   * Retry is disabled instead of re-asking the same unanswerable question. */
  recoverable?: boolean;
  /** Show "Open application form": automatic activation of a control we already
   * validated did not produce a transition, so the user's own click is needed. */
  offerOpenApplication?: boolean;
  /** Show "Reconnect to XpertApply": the workflow binding is missing but the
   * session itself is fine. */
  offerReconnect?: boolean;
  /** A reconnect request is in flight. */
  reconnecting?: boolean;
  lifecyclePhase?: string;
  atsPopulated?: number;
  jobpilotFilled?: number;
  sectionRecordsAdded?: number;
  optionalSectionsSkipped?: number;
  requiredFieldsVerified?: number;
  requiredFieldsRemaining?: number;
  manualConsentActions?: number;
  finalTechnicalIssues?: number;
}

export type ReviewCategory = "required" | "optional" | "sensitive" | "application" | "technical";

export interface ReviewItem {
  /** DiscoveredField.uid for a fillable field, or a synthetic id for a
   * name-confirmation / backend-only unresolved question. */
  id: string;
  kind: "field" | "name_confirm";
  category: ReviewCategory;
  question: string;
  required: boolean;
  reasonText: string;
  /** Real options discovered on the ATS page — never invented. */
  options?: string[];
  control?: string;
  /** A multi-select: the user may pick several options; value is pipe-joined. */
  multiple?: boolean;
  suggestedValue?: string;
  reusable: boolean;
  defaultScope?: "global" | "company";
  resolved?: boolean;
}

/**
 * What an application-only answer actually did.
 *
 * Deliberately three-valued rather than a boolean. "The answer was stored but
 * the employer's control refused it" is a real outcome the user must be told
 * about honestly — reporting it as success would claim a field was filled when
 * the page still shows nothing.
 */
export interface AnswerOutcome {
  /** The answer was stored AND verified on the employer's page. */
  ok: boolean;
  /** True when the override reached the server, whatever happened after. */
  stored: boolean;
  /** Low-cardinality failure code, mapped to copy by reviewActions. */
  code?: string;
  /** Provenance to display, set only when the page really shows the answer. */
  sourceLabel?: string;
}

export interface DeferOutcome {
  ok: boolean;
  /** Whether the item stays in the list (a required field always does). */
  stillVisible: boolean;
}

/**
 * Handlers for the authoritative review actions.
 *
 * Every action an item can name has an entry here. That correspondence is what
 * stops the panel from rendering a button that does nothing.
 */
export interface ReviewActionHandlers {
  onAnswerForThisApplication: (request: OverrideRequest) => Promise<AnswerOutcome>;
  onLeaveUnresolved: (fieldKey: string) => Promise<DeferOutcome>;
  onFocusControl: (fieldKey: string) => void;
  onApplyApprovedAnswer?: (fieldKey: string) => Promise<AnswerOutcome>;
  /** The session the answer belongs to. Context the widget carries, not a claim
   * — the server authenticates the token and derives everything from it. */
  sessionId: () => number | null;
}

export interface ReviewHandlers {
  /** Apply `value` to the field `id` right now. A multi-select passes an ARRAY
   * of chosen labels (never comma-joined text). For kind="name_confirm",
   * `value` is "Given|Family|PreferredFirst|PreferredLast". Returns whether the
   * fill was VERIFIED against the employer page. */
  onFill: (id: string, value: string | string[]) => Promise<boolean>;
  /** Persist `value` for future applications (only offered when reusable). */
  onSave: (id: string, value: string | string[], displayValue: string) => Promise<boolean>;
  onJumpToField: (id: string) => void;
}

/** A learned answer awaiting the user's explicit save decision. Nothing is ever
 * persisted until the user picks a scope here. */
export interface RememberPrompt {
  id: string;
  question: string;
  /** What the user chose, for their own confirmation. Sensitive answers are
   * summarised rather than echoed. */
  chosenSummary: string;
  employer: string | null;
  sensitive: boolean;
  proposedScope: "application" | "global" | "company" | "sensitive" | "none";
  /** When false the proposal is a guess, so no option is preselected. */
  scopeConfident: boolean;
  onDecision: (scope: "application" | "global" | "company" | "sensitive" | "none") => void;
}

export interface TransactionPanelItem {
  category: "eligibility" | "consent";
  fieldLabel: string;
  fingerprint: string | null;
  domGeneration: number | null;
  canonicalKey: string | null;
  typedAnswer: boolean | null;
  displayAnswer: string | null;
  answerSource: string;
  state: string;
  actuator: string | null;
  trigger: string | null;
  listboxFound: boolean;
  optionsDiscovered: number;
  matchedOption: boolean;
  displayedResult: string | null;
  backingResult: string | null;
  finalStatus: string;
  failureCode: string | null;
  details?: string[];
}

const SCOPE_LABEL: Record<string, string> = {
  application: "Use only for this application",
  global: "Remember for all applications",
  company: "Remember only for this company",
  sensitive: "Sensitive — remember only with my explicit consent",
  none: "Don't save"
};

const CATEGORY_LABEL: Record<ReviewCategory, string> = {
  required: "Required information",
  optional: "Optional profile information",
  sensitive: "Sensitive / EEO information",
  application: "Application-specific questions",
  technical: "Unsupported controls or technical failures"
};

export function createWidget(actions: {
  retry: () => void;
  rescan?: () => void;
  clear: () => void;
  complete: () => void;
  /** Manual fallback: activate the already-validated Apply control. Offered
   * only after automatic activation failed to produce any transition. */
  openApplication?: () => void;
  /** Re-establish the application workflow for this page. */
  reconnect?: () => void;
  diagnostics?: () => void;
  captureControl?: () => void;
  /** Toggle "Teach XpertApply" observation. */
  teach?: (enabled: boolean) => void;
}): {
  update: (value: WidgetUpdate) => void;
  showReview: (items: ReviewItem[], handlers: ReviewHandlers, counts?: LedgerCounts) => void;
  /** The authoritative review list: items derived from the question ledger,
   * each rendering only the actions it declares. `confirmed` holds the ones the
   * user already answered for this application, shown as settled rather than
   * silently dropped. */
  showActions: (
    items: AuthoritativeReviewItem[],
    handlers: ReviewActionHandlers,
    confirmed?: AuthoritativeReviewItem[]
  ) => void;
  refreshCounts: (counts: LedgerCounts) => void;
  showTransactions: (items: TransactionPanelItem[]) => void;
  /** Step the widget out of the way while a dropdown menu is being driven, so
   * its overlay can never intercept an option click (section L). */
  setInteractionMode: (active: boolean) => void;
  /** Ask the user whether (and at what scope) to remember a learned answer. */
  askToRemember: (prompt: RememberPrompt) => void;
  destroy: () => void;
} {
  // A prior content script can leave a frozen widget behind after the
  // extension is reloaded. The newly connected instance owns the UI and
  // replaces that inert host rather than creating a duplicate panel.
  document.getElementById("jobpilot-assisted-apply")?.remove();
  const host = document.createElement("div");
  host.id = "jobpilot-assisted-apply";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host{all:initial}
      *,*::before,*::after{box-sizing:border-box}
      .box{
        --ink:#17211c;--muted:#657069;--line:rgba(66,84,73,.16);--accent:#176b46;
        position:fixed;right:18px;bottom:18px;z-index:2147483647;
        width:min(372px,calc(100vw - 24px));max-height:min(82vh,780px);
        display:flex;flex-direction:column;overflow:hidden;
        color:var(--ink);border:1px solid rgba(255,255,255,.72);border-radius:22px;
        background:linear-gradient(150deg,rgba(255,255,255,.92),rgba(245,249,246,.78));
        box-shadow:0 24px 70px rgba(22,35,27,.20),0 2px 10px rgba(22,35,27,.08),inset 0 1px 0 rgba(255,255,255,.9);
        -webkit-backdrop-filter:blur(24px) saturate(150%);backdrop-filter:blur(24px) saturate(150%);
        font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;
        letter-spacing:-.006em
      }
      header{display:flex;align-items:center;gap:10px;min-height:58px;padding:11px 14px 11px 16px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.42);font-size:14px;font-weight:660;cursor:pointer}
      .dot{width:9px;height:9px;border-radius:50%;background:#21a267;box-shadow:0 0 0 4px rgba(33,162,103,.11);flex-shrink:0}
      .title{letter-spacing:-.01em}
      .body{padding:14px 14px 12px;overflow:auto;scrollbar-width:thin;scrollbar-color:rgba(79,96,86,.28) transparent}
      .message{font-size:13px;color:#354139}
      .count{color:var(--muted);margin-top:3px;font-size:12px}
      .counts-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:11px;font-size:11px;color:var(--muted)}
      .counts-row span{padding:7px 9px;border:1px solid rgba(71,92,79,.10);border-radius:10px;background:rgba(255,255,255,.54)}
      .counts-row b{display:block;margin-top:1px;color:var(--ink);font-size:13px;font-weight:660}
      .actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:11px;padding-top:11px;border-top:1px solid var(--line)}
      button{min-height:34px;border:1px solid rgba(60,86,70,.18);background:rgba(255,255,255,.68);color:#244334;border-radius:10px;padding:7px 10px;cursor:pointer;font:inherit;font-weight:560;transition:background .16s ease,border-color .16s ease,transform .16s ease,box-shadow .16s ease}
      button:hover{background:rgba(255,255,255,.95);border-color:rgba(37,104,68,.34);box-shadow:0 3px 12px rgba(31,57,42,.08)}
      button:active{transform:scale(.985)}
      button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid rgba(30,116,76,.22);outline-offset:2px}
      button:disabled{opacity:.42;cursor:default;box-shadow:none;transform:none}
      .collapse{margin-left:auto;width:32px;min-height:32px;border:0;background:rgba(255,255,255,.48);padding:0;border-radius:50%;font-size:18px;font-weight:400;color:#53615a}
      .collapsed .body{display:none}
      .failed .dot{background:#c85a3e}
      .review .dot{background:#d69416;box-shadow:0 0 0 4px rgba(214,148,22,.12)}
      .review-toggle{position:relative;width:100%;text-align:left;margin-top:12px;padding:10px 34px 10px 12px;border-color:rgba(35,105,69,.20);background:rgba(235,246,239,.72);font-weight:650}
      .review-toggle::after{content:"⌄";position:absolute;right:12px;top:8px;color:#647068;font-size:16px}
      .review-toggle[aria-expanded="true"]::after{content:"⌃"}
      .review-panel{display:none;margin-top:12px}
      .review-panel.open{display:block}
      .action-panel{display:none;margin-top:12px}
      .action-panel.open{display:block}
      .group-title{font-size:10px;font-weight:720;text-transform:uppercase;letter-spacing:.095em;color:#748078;margin:17px 2px 7px}
      .group-title:first-child{margin-top:2px}
      .item{border:1px solid rgba(54,87,67,.13);border-radius:16px;padding:13px;margin-bottom:9px;background:rgba(255,255,255,.62);box-shadow:0 1px 0 rgba(255,255,255,.8),0 5px 18px rgba(32,54,41,.035)}
      .item.resolved{opacity:.55}
      .item .q{font-size:14px;line-height:1.3;font-weight:670;letter-spacing:-.012em}
      .item .why{color:var(--muted);font-size:12px;line-height:1.42;margin-top:5px}
      .item .reason-code{margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;letter-spacing:.02em;color:#9b3f2a;background:#fff0eb;border-radius:6px;padding:3px 6px;display:inline-block;user-select:all}
      .item .req{display:inline-flex;vertical-align:1px;margin-left:6px;padding:2px 6px;border-radius:999px;background:#fff0eb;color:#9b3f2a;font-size:9px;font-weight:740;letter-spacing:.03em;text-transform:uppercase}
      .item select,.item input[type=text]{width:100%;min-height:42px;margin-top:11px;padding:8px 10px;border:1px solid rgba(57,93,70,.24);border-radius:11px;background:rgba(255,255,255,.82);color:var(--ink);font:inherit;font-size:13px;box-shadow:inset 0 1px 2px rgba(26,43,33,.035)}
      .item input::placeholder{color:#8a938d}
      .item label.save{display:flex;align-items:flex-start;gap:8px;margin-top:10px;font-size:11px;line-height:1.35;color:#46534b}
      .item label.save input{accent-color:var(--accent);margin-top:1px}
      .item .row{display:flex;gap:7px;margin-top:10px}
      .item .row button{flex:1}
      .item .row button:first-child{background:#1b704a;border-color:#1b704a;color:white;box-shadow:0 5px 14px rgba(27,112,74,.17)}
      .item .row button:first-child:hover{background:#155f3e;border-color:#155f3e}
      .item .row button+button{background:rgba(255,255,255,.58);border-color:rgba(60,86,70,.16);color:#53615a;box-shadow:none}
      .empty{color:var(--muted);font-size:12px;padding:8px 2px}
      .item .actions-row{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}
      .item .actions-row button{flex:1 1 auto;min-width:96px}
      .item .actions-row button[data-act="answer"]{flex:1 1 100%;background:#1b704a;border-color:#1b704a;color:#fff;box-shadow:0 5px 14px rgba(27,112,74,.17)}
      .item .actions-row button[data-act="answer"]:hover:not(:disabled){background:#155f3e;border-color:#155f3e}
      .choice{margin-top:11px;padding:11px;border:1px solid rgba(35,105,69,.20);border-radius:13px;background:rgba(235,246,239,.62)}
      .choice .note{font-size:11px;line-height:1.42;color:#3d4c44}
      .choice .note+.note{margin-top:4px}
      .choice .row{display:flex;gap:7px;margin-top:10px}
      .choice .row button{flex:1}
      .choice .row button[data-choice="cancel"]{background:rgba(255,255,255,.58);color:#53615a}
      .item .status{margin-top:9px;font-size:11px;line-height:1.42;color:#5c675f}
      .item .status.error{color:#8f3b25}
      .item .source{margin-top:7px;font-size:11px;font-weight:640;color:#176b46}
      .item.deferred{opacity:.72}
      .teach-panel{margin-top:8px}
      .teach-item{border:1px solid rgba(173,134,45,.22);background:rgba(255,249,231,.76);border-radius:14px;padding:12px;margin-bottom:8px}
      .teach-item .q{font-weight:600}
      .teach-item .scopes{display:flex;flex-direction:column;gap:4px;margin-top:6px}
      .teach-item .scopes label{display:flex;align-items:center;gap:6px;font-size:11px}
      [data-a="continue"],[data-a="next"]{background:rgba(235,246,239,.78);border-color:rgba(35,105,69,.20)}
      [data-a="complete"]{grid-column:1/-1;background:#1b704a;border-color:#1b704a;color:#fff}
      [data-a="teach"][aria-pressed="true"]{background:#e9f5ed;border-color:#2f8f5b;font-weight:650}
      .more-actions{grid-column:1/-1}
      .more-actions summary{list-style:none;text-align:center;color:#667169;font-size:11px;cursor:pointer;padding:6px;border-radius:8px}
      .more-actions summary::-webkit-details-marker{display:none}
      .more-actions summary:hover{background:rgba(255,255,255,.48)}
      .more-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px}
      .more-grid button:first-child{grid-column:1/-1}
      .transaction-panel{grid-column:1/-1;margin-top:7px;font-size:10px;color:#526058}
      .transaction-panel summary{cursor:pointer;font-weight:650}
      .transaction-row{margin-top:6px;padding:7px;border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
      .interacting{opacity:.25}
      .interacting .body{display:none}
      @media(max-width:520px){.box{right:12px;bottom:12px}.counts-row{grid-template-columns:1fr}}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
    </style>
    <section class="box" aria-live="polite">
      <header><span class="dot"></span><span class="title">Preparing</span><button class="collapse" type="button" aria-label="Collapse XpertApply" title="Collapse">−</button></header>
      <div class="body">
        <div class="message">Preparing your application…</div>
        <div class="lifecycle" style="font-size:11px;color:#5c675f;margin-top:5px"></div>
        <div class="count"></div>
        <div class="counts-row"></div>
        <button class="review-toggle" type="button" aria-expanded="false" style="display:none"></button>
        <div class="action-panel"></div>
        <div class="review-panel"></div>
        <div class="teach-panel"></div>
        <div class="actions">
          <!-- Shown only when automatic activation of an already-validated
               Apply control failed. Hidden by default; the user's click is
               what activates it, which some employer pages require. -->
          <button type="button" data-a="open-application" style="display:none">Open application form</button>
          <!-- Primary recovery when the workflow binding is missing. Retrying
               field detection with no session would just fail again. -->
          <button type="button" data-a="reconnect" style="display:none">Reconnect to XpertApply</button>
          <button type="button" data-a="retry">Retry autofill</button>
          <button type="button" data-a="continue">Continue filling</button>
          <button type="button" data-a="next">Jump to next issue</button>
          <button type="button" data-a="complete">Mark application complete</button>
          <details class="more-actions">
            <summary>More options</summary>
            <div class="more-grid">
              <button type="button" data-a="clear">Clear XpertApply-filled fields</button>
              <button type="button" data-a="teach" aria-pressed="false" title="Watch how you answer, and offer to remember it">Teach XpertApply</button>
              <button type="button" data-a="diagnostics" title="Copy the redacted eligibility runtime trace">Copy eligibility diagnostic</button>
              <button type="button" data-a="capture-control" title="Capture the currently rendered eligibility control and any open listbox">Capture current control</button>
              <button type="button" data-a="rescan" title="Rediscover the current employer form without uploading the resume again">Rescan application</button>
            </div>
          </details>
          <details class="transaction-panel eligibility-transactions" style="display:none"><summary>Eligibility transaction trace</summary><div data-transaction-rows="eligibility"></div></details>
          <details class="transaction-panel consent-transactions" style="display:none"><summary>Consent trace</summary><div data-transaction-rows="consent"></div></details>
        </div>
      </div>
    </section>`;
  document.documentElement.appendChild(host);
  const box = root.querySelector<HTMLElement>(".box")!;
  const reviewToggle = root.querySelector<HTMLButtonElement>(".review-toggle")!;
  const reviewPanel = root.querySelector<HTMLElement>(".review-panel")!;
  const actionPanel = root.querySelector<HTMLElement>(".action-panel")!;
  const countsRow = root.querySelector<HTMLElement>(".counts-row")!;

  // Keyboard containment. A Space or Enter pressed on a widget button must not
  // continue on to the employer's document, where it could reach a default
  // submit control. Bubble phase, on the shadow host: the widget's own handlers
  // have already run by the time this fires, and nothing past the host does.
  for (const type of ["keydown", "keyup", "keypress"] as const) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }

  const collapseBtn = root.querySelector<HTMLButtonElement>(".collapse")!;
  collapseBtn.addEventListener("click", () => {
    const collapsed = box.classList.toggle("collapsed");
    collapseBtn.textContent = collapsed ? "+" : "−";
    collapseBtn.setAttribute("aria-label", collapsed ? "Expand XpertApply" : "Collapse XpertApply");
    collapseBtn.title = collapsed ? "Expand" : "Collapse";
  });
  const reconnectBtn = root.querySelector<HTMLButtonElement>('[data-a="reconnect"]')!;
  if (actions.reconnect) reconnectBtn.addEventListener("click", actions.reconnect);
  const openApplicationBtn = root.querySelector<HTMLButtonElement>('[data-a="open-application"]')!;
  if (actions.openApplication) {
    openApplicationBtn.addEventListener("click", actions.openApplication);
  }
  root.querySelector('[data-a="retry"]')?.addEventListener("click", actions.retry);
  root.querySelector('[data-a="continue"]')?.addEventListener("click", actions.retry);
  const rescanBtn = root.querySelector<HTMLButtonElement>('[data-a="rescan"]')!;
  if (actions.rescan) rescanBtn.addEventListener("click", actions.rescan);
  else rescanBtn.style.display = "none";
  root.querySelector('[data-a="clear"]')?.addEventListener("click", actions.clear);
  const completeBtn = root.querySelector<HTMLButtonElement>('[data-a="complete"]')!;
  completeBtn.addEventListener("click", () => {
    if (!completeBtn.disabled) actions.complete();
  });
  completeBtn.disabled = true; // stays disabled until a ledger with no required blanks arrives
  const diagnosticsBtn = root.querySelector<HTMLButtonElement>('[data-a="diagnostics"]')!;
  if (actions.diagnostics) diagnosticsBtn.addEventListener("click", actions.diagnostics);
  else diagnosticsBtn.style.display = "none";
  const captureBtn = root.querySelector<HTMLButtonElement>('[data-a="capture-control"]')!;
  if (actions.captureControl) captureBtn.addEventListener("click", actions.captureControl);
  else captureBtn.style.display = "none";
  reviewToggle.addEventListener("click", () => {
    const open = reviewPanel.classList.toggle("open");
    actionPanel.classList.toggle("open", open);
    reviewToggle.setAttribute("aria-expanded", String(open));
  });
  const teachPanel = root.querySelector<HTMLElement>(".teach-panel")!;
  const teachBtn = root.querySelector<HTMLButtonElement>('[data-a="teach"]')!;
  if (actions.teach) {
    teachBtn.addEventListener("click", () => {
      const enabled = teachBtn.getAttribute("aria-pressed") !== "true";
      teachBtn.setAttribute("aria-pressed", String(enabled));
      teachBtn.textContent = enabled ? "Stop teaching" : "Teach XpertApply";
      actions.teach!(enabled);
    });
  } else {
    teachBtn.style.display = "none";
  }

  let items: ReviewItem[] = [];
  let handlers: ReviewHandlers | null = null;
  let ledgerCounts: LedgerCounts | null = null;
  let actionItems: AuthoritativeReviewItem[] = [];
  let confirmedItems: AuthoritativeReviewItem[] = [];
  let actionHandlers: ReviewActionHandlers | null = null;
  let finalRequiredVerified: number | null = null;
  let finalRequiredRemaining: number | null = null;
  let finalManualConsent: number | null = null;
  let finalTechnical: number | null = null;

  /** Completion is BLOCKED while any required control is still blank — either a
   * ledger-reported required blank, or a pending required review item (incl.
   * name confirmation). "Ready for review" ≠ "complete": the user still submits. */
  function updateCompleteGate(): void {
    const pendingRequired = items.some((i) => !i.resolved && i.required);
    const requiredBlank = (ledgerCounts?.requiredBlank ?? 0) > 0 || pendingRequired;
    completeBtn.disabled = requiredBlank;
    completeBtn.title = requiredBlank
      ? "Every required field must be filled before you can mark this application complete."
      : "";
  }

  root.querySelector('[data-a="next"]')?.addEventListener("click", () => {
    const next = items.find((i) => !i.resolved);
    if (!next) {
      document.querySelector<HTMLElement>('[data-jobpilot-status="review"],[data-jobpilot-status="invalid"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    box.classList.remove("collapsed");
    reviewPanel.classList.add("open");
    reviewToggle.setAttribute("aria-expanded", "true");
    handlers?.onJumpToField(next.id);
    root.querySelector<HTMLElement>(`[data-item="${cssId(next.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  function cssId(id: string): string {
    return id.replace(/"/g, "");
  }

  function renderCounts(): void {
    // Counts derive from the ledger when available (the single source of truth);
    // the item-derived fallback keeps the widget usable in isolation/tests.
    const resolvedHere = items.filter((i) => i.resolved).length;
    const c = ledgerCounts;
    if (c) {
      // Written HERE as well as in `update`, from the same snapshot, so the
      // headline count cannot lag behind the grid it sits above.
      root.querySelector<HTMLElement>(".count")!.textContent =
        `Filled ${c.filled} of ${c.discovered}`;
      // Render the ledger's own numbers verbatim — it is refreshed (refreshCounts)
      // every time the user resolves an item, so no local re-derivation is needed
      // and the displayed counts can never drift from the ledger.
      countsRow.innerHTML =
        `<span>Discovered: <b>${c.discovered}</b></span>` +
        `<span>Filled: <b>${c.filled}</b></span>` +
        (finalRequiredVerified == null ? "" : `<span>Required fields verified: <b>${finalRequiredVerified}</b></span>`) +
        (finalRequiredRemaining == null ? "" : `<span>Required fields remaining: <b>${finalRequiredRemaining}</b></span>`) +
        (finalManualConsent == null ? "" : `<span>Manual consent actions: <b>${finalManualConsent}</b></span>`) +
        `<span>Needs information: <b>${c.needsInformation}</b></span>` +
        `<span>Needs confirmation: <b>${c.needsConfirmation}</b></span>` +
        `<span>Sensitive/consent: <b>${c.sensitive}</b></span>` +
        `<span>Technical issues: <b>${finalTechnical ?? c.technical}</b></span>` +
        `<span>Optional skipped: <b>${c.optionalSkipped}</b></span>`;
    } else {
      const needsInfo = items.filter((i) => !i.resolved && (i.category === "required" || i.category === "optional")).length;
      const needsConfirm = items.filter((i) => !i.resolved && i.category === "sensitive").length;
      const technical = items.filter((i) => !i.resolved && i.category === "technical").length;
      countsRow.innerHTML = items.length
        ? `<span>Filled: <b>${resolvedHere}</b></span><span>Needs information: <b>${needsInfo}</b></span><span>Needs confirmation: <b>${needsConfirm}</b></span><span>Technical issues: <b>${technical}</b></span>`
        : "";
    }
    // The toggle reveals BOTH panels, so it appears whenever either has
    // something in it — a page whose only unresolved items are authoritative
    // actions must not hide them behind an invisible toggle.
    const remaining = items.filter((i) => !i.resolved).length + actionItems.length;
    reviewToggle.style.display = items.length || actionItems.length ? "" : "none";
    reviewToggle.textContent = remaining > 0 ? `${remaining} question${remaining === 1 ? "" : "s"} need your input` : "All caught up";
    updateCompleteGate();
  }

  function renderReview(): void {
    reviewPanel.innerHTML = "";
    const order: ReviewCategory[] = ["required", "sensitive", "optional", "application", "technical"];
    const pending = items.filter((i) => !i.resolved);
    if (pending.length === 0) {
      reviewPanel.innerHTML = `<div class="empty">Nothing left to review.</div>`;
      renderCounts();
      return;
    }
    for (const category of order) {
      const inGroup = pending.filter((i) => i.category === category);
      if (inGroup.length === 0) continue;
      const heading = document.createElement("div");
      heading.className = "group-title";
      heading.textContent = CATEGORY_LABEL[category];
      reviewPanel.appendChild(heading);
      for (const item of inGroup) reviewPanel.appendChild(renderItem(item));
    }
    renderCounts();
  }

  function renderItem(item: ReviewItem): HTMLElement {
    const el = document.createElement("div");
    el.className = "item";
    el.setAttribute("data-item", item.id);
    const reqBadge = item.required ? `<span class="req">Required</span>` : "";
    el.innerHTML = `
      <div class="q">${escapeHtml(item.question)}${reqBadge}</div>
      <div class="why">${escapeHtml(item.reasonText)}</div>`;

    if (item.kind === "name_confirm") {
      const parts = (item.suggestedValue || "").split("|");
      const given = textInput("First / given name", parts[0] || "");
      const middle = textInput("Middle name (optional)", parts[1] || "");
      const family = textInput("Last / family name", parts[2] || "");
      const prefFirst = textInput("Preferred first name (optional)", parts[3] || "");
      const prefLast = textInput("Preferred last name (optional)", parts[4] || "");
      el.appendChild(given);
      el.appendChild(middle);
      el.appendChild(family);
      el.appendChild(prefFirst);
      el.appendChild(prefLast);
      const row = document.createElement("div");
      row.className = "row";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.textContent = "Confirm and fill";
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        // first|middle|last|preferredFirst|preferredLast. Middle may be blank
        // (many people have none). Blank preferred fields fall back to the legal
        // name, for the common "enter your legal name" preferred-name field.
        const value = [
          given.value.trim(),
          middle.value.trim(),
          family.value.trim(),
          prefFirst.value.trim(),
          prefLast.value.trim()
        ].join("|");
        const ok = given.value.trim() && family.value.trim() ? await handlers?.onFill(item.id, value) : false;
        if (ok) markResolved(item.id);
        else saveBtn.disabled = false;
      });
      row.appendChild(saveBtn);
      el.appendChild(row);
      if (item.resolved) el.classList.add("resolved");
      return el;
    }

    // How to read the chosen value back — a pipe-joined string for multi-select,
    // the single value otherwise.
    if (item.control === "file") {
      const row = document.createElement("div");
      row.className = "row";
      const attachBtn = document.createElement("button");
      attachBtn.type = "button";
      attachBtn.textContent = "Show attach field";
      attachBtn.addEventListener("click", () => handlers?.onJumpToField(item.id));
      row.appendChild(attachBtn);
      if (!item.required) {
        const skip = document.createElement("button");
        skip.type = "button";
        skip.textContent = "Skip";
        skip.addEventListener("click", () => markResolved(item.id));
        row.appendChild(skip);
      }
      el.appendChild(row);
      return el;
    }

    let readValue: () => string | string[];
    let displayValue: () => string;
    if (item.multiple && item.options && item.options.length > 0) {
      // Multi-select: real checkboxes, one per discovered option. The user may
      // pick several; each is filled deterministically. Never a single-select.
      const boxes: HTMLInputElement[] = [];
      for (const opt of item.options) {
        const row = document.createElement("label");
        row.className = "save";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = opt;
        boxes.push(cb);
        row.appendChild(cb);
        row.appendChild(document.createTextNode(opt));
        el.appendChild(row);
      }
      readValue = () => boxes.filter((b) => b.checked).map((b) => b.value);
      displayValue = () => boxes.filter((b) => b.checked).map((b) => b.value).join(", ");
    } else if (item.options && item.options.length > 0) {
      const select = document.createElement("select");
      select.appendChild(new Option("Select an answer…", ""));
      for (const opt of item.options) select.appendChild(new Option(opt, opt));
      el.appendChild(select);
      readValue = () => select.value.trim();
      displayValue = () => select.options[select.selectedIndex]?.text ?? select.value;
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = inputPlaceholder(item);
      el.appendChild(input);
      readValue = () => input.value.trim();
      displayValue = () => input.value.trim();
    }

    let saveCheckbox: HTMLInputElement | null = null;
    if (item.reusable) {
      const label = document.createElement("label");
      label.className = "save";
      saveCheckbox = document.createElement("input");
      saveCheckbox.type = "checkbox";
      saveCheckbox.checked = true;
      const scopeNote = item.defaultScope === "company" ? " (this employer only)" : "";
      label.appendChild(saveCheckbox);
      label.appendChild(document.createTextNode(`Save for future applications${scopeNote}`));
      el.appendChild(label);
    }

    const row = document.createElement("div");
    row.className = "row";
    const fillBtn = document.createElement("button");
    fillBtn.type = "button";
    fillBtn.textContent = item.reusable ? "Save and fill" : "Use this answer";
    fillBtn.addEventListener("click", async () => {
      const value = readValue();
      if (Array.isArray(value) ? value.length === 0 : !value) return;
      fillBtn.disabled = true;
      const filled = await handlers?.onFill(item.id, value);
      if (filled && saveCheckbox?.checked) {
        await handlers?.onSave(item.id, value, displayValue());
      }
      if (filled) markResolved(item.id);
      else fillBtn.disabled = false;
    });
    row.appendChild(fillBtn);
    if (!item.required) {
      const skip = document.createElement("button");
      skip.type = "button";
      skip.textContent = "Skip";
      skip.addEventListener("click", () => markResolved(item.id));
      row.appendChild(skip);
    }
    el.appendChild(row);
    if (item.resolved) el.classList.add("resolved");
    return el;
  }

  // ------------------------------------------------------------------------- //
  // The authoritative review list: real actions, real handlers.
  // ------------------------------------------------------------------------- //
  const ACTION_LABEL: Record<string, string> = {
    answer_for_this_application: "Answer for this application",
    apply_approved_answer: "Apply approved answer",
    focus_control: "Jump to question",
    leave_unresolved: "Leave unresolved"
  };

  /**
   * The card whose Yes/No block is open, if any.
   *
   * The panel re-renders whenever the ledger changes, and the employer's page
   * mutating is enough to cause that. Without this, a user who opened the choice
   * block and paused would watch it vanish under them mid-decision.
   */
  let openChoiceFor: string | null = null;

  function renderActions(): void {
    actionPanel.innerHTML = "";
    if (!actionHandlers) return;
    if (actionItems.length > 0) {
      const heading = document.createElement("div");
      heading.className = "group-title";
      heading.textContent = "Questions that need you";
      actionPanel.appendChild(heading);
      for (const item of actionItems) actionPanel.appendChild(renderActionItem(item));
    }
    // Settled, and shown as settled. The user needs to be able to read WHICH
    // scope their answer was recorded at after the card stops asking for it.
    const pendingKeys = new Set(actionItems.map((item) => item.fieldKey));
    const settled = confirmedItems.filter((item) => !pendingKeys.has(item.fieldKey));
    if (settled.length > 0) {
      const heading = document.createElement("div");
      heading.className = "group-title";
      heading.textContent = "Answered for this application";
      actionPanel.appendChild(heading);
      for (const item of settled) actionPanel.appendChild(renderConfirmedItem(item));
    }

    // Reopen the block the user was in the middle of. The fresh card has none,
    // so activating its answer button opens it rather than toggling it shut.
    if (openChoiceFor) {
      const card = actionPanel.querySelector(`[data-action-item="${cssId(openChoiceFor)}"]`);
      card?.querySelector<HTMLButtonElement>('[data-act="answer"]')?.click();
    }
  }

  /** A question the user answered for this application, already on the page. */
  function renderConfirmedItem(item: AuthoritativeReviewItem): HTMLElement {
    const el = document.createElement("div");
    el.className = "item resolved";
    el.setAttribute("data-action-item", item.fieldKey);
    el.setAttribute("data-confirmed", "");
    el.innerHTML = `<div class="q">${escapeHtml(item.title)}</div>`;
    const source = document.createElement("div");
    source.className = "source";
    source.setAttribute("data-source", "");
    // Never "saved to your profile": nothing reusable was written.
    source.textContent = item.sourceLabel ?? "Confirmed for this application";
    el.appendChild(source);
    return el;
  }

  function renderActionItem(item: AuthoritativeReviewItem): HTMLElement {
    const el = document.createElement("div");
    el.className = "item";
    if (item.deferred) el.classList.add("deferred");
    el.setAttribute("data-action-item", item.fieldKey);

    const reqBadge = item.required ? `<span class="req">Required</span>` : "";
    el.innerHTML = `
      <div class="q">${escapeHtml(item.title)}${reqBadge}</div>
      <div class="why">${escapeHtml(item.explanation)}</div>`;

    // The stable failure code, on the card itself.
    //
    // It was only ever reachable by expanding the transaction trace, so the one
    // fact that says WHY a required field did not fill was invisible in every
    // screenshot of a stuck application — including to the person trying to fix
    // it. It is low-cardinality and carries no answer value, so it is safe to
    // show and useless to hide.
    if (item.reasonCode && item.state !== "filled_verified") {
      const code = document.createElement("div");
      code.className = "reason-code";
      code.setAttribute("data-reason-code", item.reasonCode);
      code.textContent = item.reasonCode;
      el.appendChild(code);
    }

    if (item.sourceLabel) {
      const source = document.createElement("div");
      source.className = "source";
      source.setAttribute("data-source", "");
      source.textContent = item.sourceLabel;
      el.appendChild(source);
    }

    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("data-status", "");
    status.hidden = true;
    el.appendChild(status);

    const row = document.createElement("div");
    row.className = "actions-row";
    el.appendChild(row);

    // The choice block lives in the DOM only while the user is choosing, so
    // there is no lingering control that could be re-read as a selection.
    let choiceBlock: HTMLElement | null = null;
    const buttons: HTMLButtonElement[] = [];

    /** Bound activation: while an action runs, no button on this item can start
     * another. A double click is therefore one request, not two. */
    let busy = false;
    function setBusy(active: boolean): void {
      busy = active;
      for (const button of buttons) button.disabled = active;
    }
    function say(text: string, isError = false): void {
      status.hidden = false;
      status.textContent = text;
      status.classList.toggle("error", isError);
    }

    function actionButton(action: string): HTMLButtonElement {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-act", action === "answer_for_this_application" ? "answer" : action === "focus_control" ? "jump" : "defer");
      button.textContent = action === "apply_approved_answer" && item.assistedAnswer
        ? `Select ${item.assistedAnswer} for ${item.assistedQuestionLabel ?? "this question"}`
        : ACTION_LABEL[action] ?? action;
      buttons.push(button);
      row.appendChild(button);
      return button;
    }

    for (const action of item.actions) {
      // An action with no label is one this widget cannot perform. It is not
      // rendered at all rather than rendered inert.
      if (!ACTION_LABEL[action]) continue;
      const button = actionButton(action);

      if (action === "focus_control") {
        button.addEventListener("click", () => {
          if (busy) return;
          actionHandlers?.onFocusControl(item.fieldKey);
        });
        continue;
      }

      if (action === "apply_approved_answer") {
        button.addEventListener("click", async () => {
          if (busy) return;
          setBusy(true);
          say(`Selecting the approved ${item.assistedAnswer ?? "answer"} on TikTok…`);
          const outcome = (await actionHandlers?.onApplyApprovedAnswer?.(item.fieldKey)) ?? {
            ok: false,
            stored: false,
            code: "ASSISTED_ACTION_UNAVAILABLE"
          };
          setBusy(false);
          if (!outcome.ok) {
            say(
              `TikTok did not keep the selection. Choose ${item.assistedAnswer ?? "the approved answer"} on the highlighted field, then Rescan application.`,
              true
            );
            return;
          }
          say("TikTok kept the approved selection and XpertApply verified it.");
        });
        continue;
      }

      if (action === "leave_unresolved") {
        button.addEventListener("click", async () => {
          if (busy) return;
          setBusy(true);
          say("Recording that you will answer this one yourself…");
          const outcome = (await actionHandlers?.onLeaveUnresolved(item.fieldKey)) ?? {
            ok: false,
            stillVisible: true
          };
          setBusy(false);
          if (!outcome.ok) {
            say("XpertApply could not record that. Nothing was changed.", true);
            return;
          }
          openChoiceFor = null;
          // Truthful either way: a required field is NOT resolved by deferring
          // it, and the item says so rather than disappearing.
          say(
            outcome.stillVisible
              ? "Left for you. This stays in the final review until the employer's form has an answer."
              : "Skipped for this application."
          );
          choiceBlock?.remove();
          choiceBlock = null;
          el.classList.add("deferred");
          for (const other of buttons) {
            if (other.getAttribute("data-act") !== "jump") other.remove();
          }
        });
        continue;
      }

      // answer_for_this_application
      button.addEventListener("click", () => {
        if (busy) return;
        if (choiceBlock) {
          choiceBlock.remove();
          choiceBlock = null;
          openChoiceFor = null;
          return;
        }
        openChoiceFor = item.fieldKey;
        choiceBlock = renderChoiceBlock(item, {
          onChoose: async (value) => {
            const sessionId = actionHandlers?.sessionId() ?? null;
            if (sessionId == null) {
              say("XpertApply is not connected to this application right now.", true);
              return;
            }
            // Built here, validated here, and validated again at every boundary
            // it crosses. Provenance is absent by construction.
            const request: OverrideRequest = {
              action: "answer_for_this_application",
              fieldKey: item.fieldKey,
              canonicalKey: item.canonicalKey ?? "",
              answerType: "boolean",
              value,
              sessionId
            };
            setBusy(true);
            choiceBlock?.remove();
            choiceBlock = null;
            openChoiceFor = null;
            say("Saving your answer for this application…");
            const outcome = (await actionHandlers?.onAnswerForThisApplication(request)) ?? {
              ok: false,
              stored: false,
              code: "UNKNOWN"
            };
            setBusy(false);
            if (outcome.ok) {
              say("Answered on the employer's form.");
              if (outcome.sourceLabel) {
                const source = document.createElement("div");
                source.className = "source";
                source.setAttribute("data-source", "");
                source.textContent = outcome.sourceLabel;
                el.appendChild(source);
              }
              for (const other of buttons) other.remove();
              return;
            }
            // Failure keeps the item exactly as reviewable as it was. Nothing
            // here claims the field was filled.
            say(overrideFailureMessage(outcome.code ?? "UNKNOWN"), true);
          },
          onCancel: () => {
            choiceBlock?.remove();
            choiceBlock = null;
            openChoiceFor = null;
          }
        });
        el.appendChild(choiceBlock);
      });
    }

    return el;
  }

  function markResolved(id: string): void {
    const item = items.find((i) => i.id === id);
    if (item) item.resolved = true;
    renderReview();
  }

  return {
    update(value) {
      const labels: Record<WidgetStage, string> = { preparing:"Preparing", opening:"Opening application", detecting:"Detecting fields", filling:"Filling", uploading:"Uploading resume", review:"Needs review", ready:"Ready for review", failed:"Failed" };
      const title = value.stageLabel ?? labels[value.stage];
      root.querySelector<HTMLElement>(".title")!.textContent = title;
      root.querySelector<HTMLElement>(".message")!.textContent = value.message ?? title;
      if (value.requiredFieldsVerified != null) finalRequiredVerified = value.requiredFieldsVerified;
      if (value.requiredFieldsRemaining != null) finalRequiredRemaining = value.requiredFieldsRemaining;
      if (value.manualConsentActions != null) finalManualConsent = value.manualConsentActions;
      if (value.finalTechnicalIssues != null) finalTechnical = value.finalTechnicalIssues;
      const lifecycle = root.querySelector<HTMLElement>(".lifecycle")!;
      const sourceParts = [
        value.lifecyclePhase,
        value.atsPopulated == null ? "" : `ATS populated ${value.atsPopulated}`,
        value.jobpilotFilled == null ? "" : `XpertApply filled ${value.jobpilotFilled}`,
        value.sectionRecordsAdded == null ? "" : `section records added ${value.sectionRecordsAdded}`,
        value.optionalSectionsSkipped == null ? "" : `optional sections skipped ${value.optionalSectionsSkipped}`
      ].filter(Boolean);
      lifecycle.textContent = sourceParts.join(" · ");
      // ONE source for the numbers. Once a ledger snapshot exists it wins
      // outright, so this line and the counts grid beneath it cannot disagree —
      // which is exactly how "Filled 0 of 0" came to sit beside
      // "Discovered 11 / Filled 1". A caller's own totals are only used before
      // any ledger exists.
      const counted = ledgerCounts
        ? { filled: ledgerCounts.filled, total: ledgerCounts.discovered }
        : value.total == null
          ? null
          : { filled: value.filled ?? 0, total: value.total };
      root.querySelector<HTMLElement>(".count")!.textContent =
        counted === null ? "" : `Filled ${counted.filled} of ${counted.total}`;
      box.classList.toggle("failed", value.stage === "failed"); box.classList.toggle("review", value.stage === "review");
      // A terminal failure (expired/consumed/mismatched handoff) must not
      // offer a Retry that just re-asks the same unanswerable question.
      const terminal = value.stage === "failed" && value.recoverable === false;
      const retryBtn = root.querySelector<HTMLButtonElement>('[data-a="retry"]');
      const continueBtn = root.querySelector<HTMLButtonElement>('[data-a="continue"]');
      if (retryBtn) { retryBtn.disabled = terminal; retryBtn.title = terminal ? "Reopen the application from XpertApply instead." : ""; }
      if (continueBtn) { continueBtn.disabled = terminal; continueBtn.title = terminal ? "Reopen the application from XpertApply instead." : ""; }
      // The manual fallback appears only when the caller asks for it: an
      // already-validated Apply control that automatic activation could not
      // open. The user's own click carries a real user gesture.
      openApplicationBtn.style.display = value.offerOpenApplication ? "" : "none";
      // Reconnect is the PRIMARY action when the binding is missing, so Retry
      // (which would re-run field detection with no session) steps aside.
      reconnectBtn.style.display = value.offerReconnect ? "" : "none";
      reconnectBtn.disabled = Boolean(value.reconnecting);
      reconnectBtn.textContent = value.reconnecting ? "Reconnecting…" : "Reconnect to XpertApply";
      if (retryBtn && value.offerReconnect) retryBtn.style.display = "none";
      else if (retryBtn) retryBtn.style.display = "";
    },
    showReview(nextItems, nextHandlers, counts) {
      items = nextItems.map((i) => ({ ...i }));
      handlers = nextHandlers;
      ledgerCounts = counts ?? null;
      renderReview();
    },
    showActions(nextItems, nextHandlers, confirmed) {
      actionItems = nextItems.map((i) => ({ ...i }));
      // Merged rather than replaced: a targeted refresh reports only the fields
      // it touched, and an earlier confirmation is still true.
      if (confirmed) {
        const byKey = new Map(confirmedItems.map((item) => [item.fieldKey, item]));
        for (const item of confirmed) byKey.set(item.fieldKey, { ...item });
        confirmedItems = Array.from(byKey.values());
      }
      actionHandlers = nextHandlers;
      renderActions();
      renderCounts();
    },
    refreshCounts(counts) {
      ledgerCounts = counts;
      renderCounts();
    },
    showTransactions(nextItems) {
      // Developer Mode only. Production users get stable failure copy without
      // raw implementation detail; local live debugging gets the full boundary.
      const isDev = !chrome.runtime.getManifest().update_url;
      for (const category of ["eligibility", "consent"] as const) {
        const panel = root.querySelector<HTMLElement>(`.${category}-transactions`)!;
        const rows = root.querySelector<HTMLElement>(`[data-transaction-rows="${category}"]`)!;
        const categoryItems = nextItems.filter((item) => item.category === category);
        panel.style.display = isDev && categoryItems.length > 0 ? "" : "none";
        rows.innerHTML = "";
        for (const item of categoryItems) {
          const row = document.createElement("div");
          row.className = "transaction-row";
          row.textContent = [
            item.fieldLabel,
            `${item.canonicalKey ?? "unresolved"} · ${item.state}`,
            `fingerprint=${item.fingerprint ?? "unknown"} generation=${item.domGeneration ?? "unknown"}`,
            `answer=${String(item.typedAnswer)} (${item.displayAnswer ?? "none"}) source=${item.answerSource}`,
            `adapter=${item.actuator ?? "none"} trigger=${item.trigger ?? "none"} listbox=${item.listboxFound} options=${item.optionsDiscovered}`,
            `matched=${item.matchedOption} display=${item.displayedResult ?? "unknown"} backing=${item.backingResult ?? "unknown"}`,
            `final=${item.finalStatus} failure=${item.failureCode ?? "none"}`,
            ...(item.details ?? [])
          ].join("\n");
          rows.appendChild(row);
        }
      }
    },
    askToRemember(prompt) {
      teachPanel.appendChild(renderRememberPrompt(prompt));
      box.classList.remove("collapsed");
    },
    setInteractionMode(active) {
      // Collapse to the header and become click-through. The widget is fixed
      // bottom-right, exactly where a dropdown menu often opens; leaving it
      // interactive would let it swallow the option click.
      box.classList.toggle("interacting", active);
      host.style.pointerEvents = active ? "none" : "";
    },
    destroy: () => host.remove()
  };
}

/**
 * The Yes / No / Cancel block for an application-only Boolean answer.
 *
 * Nothing is preselected, and there is no control holding a value: the answer
 * exists only as the button the user pressed. An unanswered question therefore
 * cannot fall through to No, which for a work-authorization or sponsorship
 * question would be a statement the user never made.
 */
function renderChoiceBlock(
  item: AuthoritativeReviewItem,
  callbacks: { onChoose: (value: boolean) => void | Promise<void>; onCancel: () => void }
): HTMLElement {
  const block = document.createElement("div");
  block.className = "choice";
  block.setAttribute("data-choice-block", item.fieldKey);

  // Scope, in the user's words. The canonical key is never shown.
  for (const note of answerNotesFor(item.canonicalKey ?? "")) {
    const line = document.createElement("div");
    line.className = "note";
    line.textContent = note;
    block.appendChild(line);
  }

  const row = document.createElement("div");
  row.className = "row";
  const choices: [string, string, boolean | null][] = [
    ["yes", "Yes", true],
    ["no", "No", false],
    ["cancel", "Cancel", null]
  ];
  for (const [key, label, value] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-choice", key);
    button.textContent = label;
    button.addEventListener("click", () => {
      if (value === null) callbacks.onCancel();
      else void callbacks.onChoose(value);
    });
    row.appendChild(button);
  }
  block.appendChild(row);
  return block;
}

/** Render the "Should XpertApply remember this answer?" card. Every option is an
 * explicit user choice — there is no default that silently saves. */
function renderRememberPrompt(prompt: RememberPrompt): HTMLElement {
  const el = document.createElement("div");
  el.className = "teach-item";
  el.setAttribute("data-teach", prompt.id);
  const scopeNote = prompt.employer && !prompt.sensitive ? ` (${prompt.employer})` : "";
  el.innerHTML = `
    <div class="q">Should XpertApply remember this answer?</div>
    <div class="why">${escapeHtml(prompt.question)}</div>
    <div class="why"><b>${escapeHtml(prompt.chosenSummary)}</b>${escapeHtml(scopeNote)}</div>`;

  const scopes = document.createElement("div");
  scopes.className = "scopes";
  // A sensitive answer may ONLY be stored via its explicit-consent option.
  const choices: RememberPrompt["proposedScope"][] = prompt.sensitive
    ? ["sensitive", "application", "none"]
    : ["application", "global", "company", "none"];
  const name = `scope-${prompt.id}`;
  for (const scope of choices) {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = name;
    radio.value = scope;
    // Only preselect when XpertApply is confident; otherwise the user must choose.
    if (prompt.scopeConfident && scope === prompt.proposedScope) radio.checked = true;
    label.appendChild(radio);
    label.appendChild(document.createTextNode(SCOPE_LABEL[scope]));
    scopes.appendChild(label);
  }
  el.appendChild(scopes);

  const row = document.createElement("div");
  row.className = "row";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Confirm";
  save.addEventListener("click", () => {
    const chosen = scopes.querySelector<HTMLInputElement>("input:checked");
    if (!chosen) return; // no silent default — the user must decide
    save.disabled = true;
    prompt.onDecision(chosen.value as RememberPrompt["proposedScope"]);
    el.remove();
  });
  row.appendChild(save);
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Not now";
  dismiss.addEventListener("click", () => {
    prompt.onDecision("none");
    el.remove();
  });
  row.appendChild(dismiss);
  el.appendChild(row);
  return el;
}

function textInput(placeholder: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.value = value;
  return input;
}

function inputPlaceholder(item: ReviewItem): string {
  const question = item.question.toLowerCase();
  if (question.includes("school") || question.includes("university")) return "e.g. Arizona State University";
  if (question.includes("degree")) return "e.g. Master's Degree";
  if (question.includes("major") || question.includes("field of study")) return "e.g. Computer Science";
  if (question.includes("calling code")) return "e.g. United States (+1)";
  if (question.includes("country")) return "Enter a country";
  if (question.includes("graduat")) return "YYYY";
  return "Enter your answer";
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
