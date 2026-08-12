/**
 * Select one backend-approved option and PROVE it stuck.
 *
 * The rule this module exists to enforce: opening a menu is not a fill. A
 * control counts as filled only after the page still shows the chosen value
 * once the framework has finished re-rendering — which is exactly when a
 * React-controlled select silently reverts an unaccepted change.
 *
 * Only the label the backend approved may be chosen. There is no "closest
 * match", no first-option fallback, and no "Other" when the expected option is
 * absent; every one of those is a wrong answer on a real application.
 */

import { deepQueryAll, scopedElementById } from "../dom/deepDom";
import type { DiscoveredField } from "../types";

export type TransactionFailure =
  | "control_not_found"
  | "control_replaced"
  | "control_disabled"
  | "control_covered"
  | "menu_not_opened"
  | "option_container_missing"
  | "option_not_found"
  | "ambiguous_option"
  | "interaction_failed"
  | "selected_value_not_persisted"
  | "backing_value_mismatch"
  | "validation_failed"
  | "stale_resolution"
  | "timeout";

export interface TransactionResult {
  ok: boolean;
  reason: TransactionFailure | "verified";
  /** What the control displays after settling. Compared, never logged. */
  displayed?: string;
  /** Submitted machine value, when the control exposes one. Kept in-memory for
   * verification and redacted before diagnostics for legal questions. */
  backing?: string;
  states: ChoiceTransactionState[];
  adapter: "native_select" | "custom_choice";
  trigger?: string;
  listboxFound?: boolean;
  options?: string[];
  matchedOption?: string;
  verificationSource?: string;
  openStrategy?: "already_open" | "click" | "mouse" | "pointer" | "enter" | "space" | "arrow_down" | "alt_arrow_down";
}

export type ChoiceTransactionState =
  | "DISCOVERED"
  | "RESOLVER_REQUESTED"
  | "SEMANTICALLY_RESOLVED"
  | "QUEUED_FOR_ACTUATION"
  | "CONTROL_LOCATED"
  | "OPEN_ATTEMPTED"
  | "CONTROL_OPENED"
  | "OPTIONS_DISCOVERED"
  | "OPTION_MATCHED"
  | "OPTION_SELECTED"
  | "COMMIT_OBSERVED"
  | "VERIFIED"
  | "FILLED";

export interface ChoiceAnswer {
  canonicalKey?: string | null;
  typedAnswer?: boolean | null;
  displayAnswer: string;
}

export interface ChoiceTransactionOptions {
  /** Re-find the field after a framework render replaces the original node. */
  reacquire?: () => DiscoveredField | null;
  /**
   * The caller already opened this control inside a real user gesture.
   *
   * Set only by the assisted review action, which must click synchronously from
   * the user's own click to satisfy pages that gate on `isTrusted`. Without
   * this, the menu that click just opened looks — correctly — like a menu this
   * control does not own, and would be dismissed rather than used. The caller
   * is responsible for clearing foreign menus BEFORE it opens the control, so
   * "whatever is open now" is unambiguously this one's.
   */
  callerOpened?: boolean;
}

const SETTLE_MS = 120;
const MENU_TIMEOUT_MS = 2500;
const OPEN_ATTEMPT_TIMEOUT_MS = 420;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isVisible(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return false;
  if (style.display === "none" || style.visibility === "hidden") return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 || box.height > 0;
}

function isEnabled(element: HTMLElement): boolean {
  if ((element as HTMLSelectElement).disabled) return false;
  return element.getAttribute("aria-disabled") !== "true";
}

/** Is something else on top of the control's own centre point? */
function isCovered(element: HTMLElement): boolean {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view) return false;
  const box = element.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  if (x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) return false;
  const top = doc.elementFromPoint(x, y);
  if (!top) return false;
  return !(top === element || element.contains(top) || top.contains(element));
}

/**
 * Text of an element, with element boundaries preserved as whitespace.
 *
 * `textContent` concatenates adjacent nodes with no separator, so a trigger
 * built as `<span class="sr-only">Work authorization</span><span>Yes</span>`
 * reads back as "Work authorizationYes" — in which the committed value "Yes" is
 * no longer a word at all. That is why a control plainly showing Yes could not
 * be verified: not the comparison, the extraction feeding it.
 */
function boundaryAwareText(element: HTMLElement): string {
  const parts: string[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (insideOwnPopup(element, node)) continue;
    const text = node.textContent?.trim();
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

/**
 * Is this text inside the popup the trigger itself opened?
 *
 * A trigger that renders its menu INSIDE its own subtree reads back as
 * "Yes No" while the menu is open — and "Yes No" contains the approved token,
 * so the idempotence check in `selectApprovedOption` concluded the control was
 * already answered and returned `verified` without selecting anything. A menu
 * lists the CHOICES; only the trigger's own chrome shows the ANSWER.
 *
 * Scoped tightly: it applies only to an element that declares popup semantics,
 * and never to a control that IS the listbox.
 */
function insideOwnPopup(trigger: HTMLElement, node: Node): boolean {
  const role = (trigger.getAttribute("role") ?? "").toLowerCase();
  if (role === "listbox" || role === "menu") return false;
  const opensPopup = trigger.hasAttribute("aria-haspopup")
    || trigger.hasAttribute("aria-controls")
    || trigger.getAttribute("aria-expanded") === "true"
    || role === "combobox";
  if (!opensPopup) return false;
  const popup = (node.parentElement as HTMLElement | null)?.closest('[role="listbox"],[role="menu"]');
  return Boolean(popup && popup !== trigger && trigger.contains(popup));
}

/** What the control currently shows, across native and custom shapes. */
export function displayedValue(element: HTMLElement): string {
  if (element instanceof HTMLSelectElement) {
    return element.selectedOptions[0]?.textContent ?? "";
  }
  // A combobox usually reports its own value, or names the selected option.
  const owned = element.getAttribute("aria-activedescendant");
  if (owned) {
    const node = element.ownerDocument.getElementById(owned);
    if (node?.textContent) return node.textContent;
  }
  if (element instanceof HTMLInputElement) return element.value;
  return boundaryAwareText(element);
}

/** The hidden input a custom widget writes through, when there is one. */
function backingInput(element: HTMLElement): HTMLInputElement | null {
  // Do not stop at the trigger's own generic <div>: custom controls usually
  // place their hidden submitted value beside the trigger in a labelled
  // wrapper. The old selector therefore verified only what was painted.
  const container = element.closest("[data-jobpilot-control],fieldset") ?? element.parentElement;
  if (!container) return null;
  return container.querySelector<HTMLInputElement>('input[type="hidden"]');
}

function validationFailed(element: HTMLElement): boolean {
  if (element.getAttribute("aria-invalid") === "true") return true;
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
    return !element.validity.valid;
  }
  const hidden = backingInput(element);
  return Boolean(hidden && (!hidden.validity.valid || hidden.getAttribute("aria-invalid") === "true"));
}

type Polarity = "affirmative" | "negative" | "unknown";

/** Interpret only explicit boolean wording. Negated forms are tested before
 * positive forms, and unknown wording never receives a polarity. */
export function booleanPolarity(value: string): Polarity {
  const normalized = normalize(value).replace(/[.!]$/g, "");
  if (/^(?:no|n|false|0|off)$/.test(normalized)) return "negative";
  if (/^(?:yes|y|true|1|on)$/.test(normalized)) return "affirmative";
  if (/\b(?:not authorized|not authorised|do not require|don't require|will not require|no sponsorship)\b/.test(normalized)) {
    return "negative";
  }
  if (/^(?:authorized|authorised)$/.test(normalized)) return "affirmative";
  if (/\b(?:i require sponsorship|will require sponsorship)\b/.test(normalized)) return "affirmative";
  return "unknown";
}

/**
 * Would this control SUBMIT the approved answer?
 *
 * Compared against the approved answer, not against the painted string. The old
 * check asked whether the hidden value agreed with the trigger's text, and a
 * decorated trigger ("Work authorization Yes \u25be") has no boolean polarity of
 * its own — so a control displaying Yes and submitting `true` was reported as a
 * display/backing mismatch and the whole selection was rejected.
 *
 * A backing value representing the OPPOSITE answer is still a hard failure:
 * that is the case this guard exists for.
 */
function backingRepresentsAnswer(
  backing: string,
  displayed: string,
  approvedLabel: string,
  typedAnswer?: boolean | null,
  optionLabels: string[] = []
): boolean {
  if (!backing) return false;
  if (normalize(displayed) === normalize(backing)) return true;
  if (committedValueMatches(backing, approvedLabel, typedAnswer, optionLabels)) return true;
  const displayPolarity = booleanPolarity(displayed);
  return displayPolarity !== "unknown" && displayPolarity === booleanPolarity(backing);
}

/** Whole-word containment. "no" must not match inside "not authorized". */
function containsToken(haystack: string, token: string): boolean {
  const normalizedToken = normalize(token);
  if (!normalizedToken) return false;
  const escaped = normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(normalize(haystack));
}

/**
 * Did the control actually commit the approved answer?
 *
 * The live TikTok defect: work authorization visibly displayed "Yes", and
 * XpertApply still reported "could not keep this selection". The comparison was
 * `normalize(trigger.textContent) === "yes"`, and a real widget's trigger is not
 * a bare text node — it carries a caret glyph, a clear affordance, a visually
 * hidden label, or the placeholder it replaced. Any one of those makes an exact
 * string equality fail on a control that is plainly, correctly filled.
 *
 * So equality is the FIRST test, not the only one. After it, the approved label
 * must appear as a whole word and no rejected option may appear alongside it —
 * which is what keeps "Yes" and "No" from ever being confused, including inside
 * phrases like "Not authorized". For an explicitly boolean answer, matching
 * polarity is accepted as well, so wording variants the employer chose
 * ("Authorized", "I do not require sponsorship") verify correctly.
 *
 * This is strictly more precise than the old check in the direction that
 * matters: a control showing the OPPOSITE answer is now rejected explicitly
 * rather than falling through an inequality.
 */
export function committedValueMatches(
  displayed: string,
  approvedLabel: string,
  typedAnswer?: boolean | null,
  rejectedLabels: string[] = []
): boolean {
  const shown = normalize(displayed);
  if (!shown) return false;
  const wanted = normalize(approvedLabel);
  if (shown === wanted) return true;

  const wantedPolarity: Polarity =
    typeof typedAnswer === "boolean"
      ? typedAnswer ? "affirmative" : "negative"
      : booleanPolarity(approvedLabel);

  // A control showing a DIFFERENT approved option is a hard no, whatever else
  // its markup contains.
  const conflicting = rejectedLabels.filter((label) => normalize(label) !== wanted);
  if (conflicting.some((label) => containsToken(shown, label))) return false;
  if (wantedPolarity !== "unknown") {
    const shownPolarity = booleanPolarity(shown);
    if (shownPolarity !== "unknown" && shownPolarity !== wantedPolarity) return false;
  }

  if (containsToken(shown, wanted)) return true;
  // Polarity equality covers employer wording that is not the literal label.
  return wantedPolarity !== "unknown" && booleanPolarity(shown) === wantedPolarity;
}

function dispatch(element: HTMLElement, types: string[]): void {
  for (const type of types) {
    // `composed` so a control inside an open shadow root still notifies the web
    // component that owns it — without it the change stops at the boundary.
    element.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }
}

/**
 * Select `approvedLabel` on a native `<select>`.
 *
 * Native controls need no menu: setting the index and firing input/change IS
 * the user-equivalent interaction, and React reads it the same way.
 */
async function fillNativeSelect(
  element: HTMLSelectElement,
  approvedLabel: string
): Promise<Omit<TransactionResult, "states" | "adapter">> {
  const wanted = normalize(approvedLabel);
  const matches = Array.from(element.options).filter(
    (option) => normalize(option.textContent ?? "") === wanted && !option.disabled
  );
  if (matches.length === 0) return { ok: false, reason: "option_not_found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous_option" };

  element.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter) setter.call(element, matches[0].value);
  else element.value = matches[0].value;
  dispatch(element, ["input", "change"]);
  dispatch(element, ["blur"]);

  await delay(SETTLE_MS);
  const displayed = displayedValue(element);
  const backing = element.value;
  if (normalize(displayed) !== wanted) {
    return { ok: false, reason: "selected_value_not_persisted", displayed, backing };
  }
  if (backing !== matches[0].value) {
    return { ok: false, reason: "backing_value_mismatch", displayed, backing };
  }
  if (validationFailed(element)) {
    return { ok: false, reason: "validation_failed", displayed, backing };
  }
  return { ok: true, reason: "verified", displayed, backing };
}

/** Find the menu a combobox opened, preferring one it explicitly owns. */
function controlledIds(element: HTMLElement): string[] {
  return [element.getAttribute("aria-controls"), element.getAttribute("aria-owns")]
    .flatMap((value) => (value ?? "").split(/\s+/))
    .filter(Boolean);
}

/** Every menu currently on screen, portaled or inline. */
function visibleMenus(doc: Document): HTMLElement[] {
  return deepQueryAll<HTMLElement>(doc, '[role="listbox"],[role="menu"]').filter(isVisible);
}

/**
 * Is this menu unambiguously THIS control's?
 *
 * The live TikTok defect behind the blank sponsorship answer: the two legal
 * questions are separate controls that portal their menus into the same place.
 * After the authorization menu was used, a menu node was still mounted; the
 * sponsorship transaction then found exactly one visible listbox and adopted it
 * unconditionally, because "exactly one" was treated as proof of ownership.
 *
 * Ownership now means an explicit ARIA relationship or DOM containment.
 * Anything else is treated as someone else's menu and dismissed rather than
 * borrowed.
 */
function ownsMenu(element: HTMLElement, menu: HTMLElement): boolean {
  if (controlledIds(element).some((id) => element.ownerDocument.getElementById(id) === menu)) return true;
  if (element.contains(menu)) return true;
  const container = element.closest("[data-jobpilot-control],fieldset,[role='group']");
  return Boolean(container && container.contains(menu) && container.contains(element));
}

/**
 * Close menus this control does not own, without choosing anything.
 *
 * Escape then a neutral click — never Enter or Space, either of which could
 * submit the surrounding form.
 */
export async function dismissForeignMenus(element: HTMLElement): Promise<number> {
  const doc = element.ownerDocument;
  const foreign = visibleMenus(doc).filter((menu) => !ownsMenu(element, menu));
  if (foreign.length === 0) return 0;
  try {
    doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    await delay(60);
    if (visibleMenus(doc).some((menu) => !ownsMenu(element, menu))) {
      doc.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      doc.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await delay(60);
    }
  } catch {
    /* best-effort: a menu left open is untidy, never unsafe */
  }
  return foreign.length;
}

/**
 * A menu the page rendered with NO ARIA roles at all.
 *
 * Plenty of design systems ship a portaled `<div class="…-dropdown"><ul><li>Yes`
 * with neither `role="listbox"` nor `role="option"`. Every role-based lookup
 * above returns nothing for those, and the transaction then reported
 * `menu_not_opened` for a menu that was plainly on screen.
 *
 * Deliberately bounded rather than a document-wide sweep, because this runs
 * inside the open loop: only the page's own top-level portal containers (a
 * floating menu is appended to `<body>`, or to a portal root that is a direct
 * child of it) and the trigger's own row are examined. A body child that
 * CONTAINS the trigger is the application itself and is skipped.
 */
function findRoleLessMenu(trigger: HTMLElement, exclude: ReadonlySet<HTMLElement>): HTMLElement | null {
  const doc = trigger.ownerDocument;
  const roots: HTMLElement[] = [];
  for (const child of Array.from(doc.body?.children ?? [])) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.contains(trigger) || child.id === "jobpilot-assisted-apply") continue;
    roots.push(child);
  }
  const row = trigger.closest<HTMLElement>("[data-jobpilot-control],fieldset,[role='group'],li,div");
  if (row) roots.push(row);

  const found: HTMLElement[] = [];
  for (const root of roots) collectOptionLists(root, trigger, found);
  const triggerBox = trigger.getBoundingClientRect();
  const candidates = found.filter((node) => !exclude.has(node) && isAnchoredTo(triggerBox, node));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => distanceTo(triggerBox, a) - distanceTo(triggerBox, b))[0];
}

/**
 * Is this list positioned as THIS control's menu?
 *
 * The decisive guard on the role-less path. Without ARIA there is no declared
 * relationship, so position is the evidence: a dropdown is drawn touching its
 * trigger. A list somewhere else on the page — a nav overlay, a cookie banner —
 * fails this and is never clicked, whatever its class name says.
 */
function isAnchoredTo(triggerBox: DOMRect, node: HTMLElement): boolean {
  const box = node.getBoundingClientRect();
  const horizontalGap = Math.max(triggerBox.left - box.right, box.left - triggerBox.right, 0);
  const verticalGap = Math.max(triggerBox.top - box.bottom, box.top - triggerBox.bottom, 0);
  return horizontalGap <= 48 && verticalGap <= 24;
}

function distanceTo(triggerBox: DOMRect, node: HTMLElement): number {
  const box = node.getBoundingClientRect();
  return Math.abs(box.left - triggerBox.left) + Math.abs(box.top - triggerBox.bottom);
}

function collectOptionLists(root: HTMLElement, trigger: HTMLElement, out: HTMLElement[], depth = 0): void {
  if (depth > 6 || out.length >= 8 || !isVisible(root)) return;
  if (!root.contains(trigger) && isOptionShaped(root)) {
    out.push(root);
    return;
  }
  for (const child of Array.from(root.children)) {
    if (child instanceof HTMLElement) collectOptionLists(child, trigger, out, depth + 1);
  }
}

/** Naming a component is not proof, but a `…-dropdown` never means prose. */
const MENU_SHAPED_SELECTOR = [
  "ul", "ol", "menu",
  '[class*="dropdown" i]', '[class*="menu" i]', '[class*="popup" i]',
  '[class*="popover" i]', '[class*="listbox" i]', '[class*="option" i]',
  '[class*="select" i]'
].join(",");

/**
 * Does this element hold a short list of choices rather than page content?
 *
 * Two independent signals are required, because "an element with a few
 * text-bearing children" describes most of a page: the element must present
 * itself as a floating menu (positioned out of flow, or a list/menu-named
 * component), AND its children must read as choices.
 */
function isOptionShaped(node: HTMLElement): boolean {
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  const floating = style?.position === "absolute" || style?.position === "fixed";
  if (!floating && !node.matches(MENU_SHAPED_SELECTOR)) return false;
  const options = optionNodes(node);
  if (options.length > 60) return false;
  // Two or more choices, or a container that names itself a menu. One
  // text-bearing child of an unnamed floating box is a tooltip, not an answer.
  if (options.length < 2 && !node.matches(MENU_SHAPED_SELECTOR)) return false;
  if (options.length === 0) return false;
  return options.every((option) => (option.textContent ?? "").trim().length <= 120);
}

function findMenu(
  element: HTMLElement,
  exclude: ReadonlySet<HTMLElement> = new Set(),
  includeRoleLess = false
): HTMLElement | null {
  const doc = element.ownerDocument;
  // Resolved across ancestor shadow roots, and accepted WITHOUT requiring a
  // listbox role: the trigger itself declared this element as the popup it
  // controls, which is a stronger statement than any role attribute. A design
  // system that ships `aria-controls` but no `role="listbox"` on the menu is
  // common, and requiring the role meant the menu could never be found at all.
  for (const id of controlledIds(element)) {
    const owned = scopedElementById(element, id);
    if (owned && isVisible(owned)) return owned;
  }
  const local = element.querySelector<HTMLElement>('[role="listbox"],[role="menu"]');
  if (local && isVisible(local)) return local;
  // Portal menus are attached elsewhere in the document, so a subtree search
  // would miss them; look for any visible listbox instead — but never one that
  // was already open before this control was touched. That menu belongs to
  // whichever control opened it, and adopting it is how the second legal
  // dropdown ended up reading the first one's options.
  const visible = visibleMenus(doc).filter((node) => !exclude.has(node));
  if (visible.length === 1) return visible[0];
  if (visible.length > 1) {
    const triggerBox = element.getBoundingClientRect();
    return visible.sort((a, b) => {
      const ab = a.getBoundingClientRect();
      const bb = b.getBoundingClientRect();
      return Math.abs(ab.left - triggerBox.left) + Math.abs(ab.top - triggerBox.bottom)
        - Math.abs(bb.left - triggerBox.left) - Math.abs(bb.top - triggerBox.bottom);
    })[0];
  }
  // Last resort: options rendered with no listbox container around them. The
  // exclusion set applies HERE TOO — this fallback used to ignore it, so a menu
  // the caller had explicitly ruled out (the previous legal question's, still
  // mounted) came back through the side door and its options were clicked. That
  // answered the wrong question.
  const looseOption = Array.from(doc.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => {
    if (!isVisible(option)) return false;
    const container = option.closest<HTMLElement>('[role="listbox"],[role="menu"]') ?? option.parentElement;
    return !(container && exclude.has(container));
  });
  if (looseOption) {
    const container = looseOption.closest<HTMLElement>('[role="listbox"],[role="menu"]') ?? looseOption.parentElement;
    if (container && !exclude.has(container)) return container;
  }
  // Only after every role-based lookup has failed, and only when the caller
  // asked for it: this walk is bounded but still costs more than the queries
  // above, so it never runs inside the mutation-observer hot path.
  return includeRoleLess ? findRoleLessMenu(element, exclude) : null;
}

async function waitForMenu(
  element: HTMLElement,
  timeoutMs = MENU_TIMEOUT_MS,
  exclude: ReadonlySet<HTMLElement> = new Set()
): Promise<HTMLElement | null> {
  const immediate = findMenu(element, exclude);
  if (immediate) return immediate;
  const observed = await new Promise<HTMLElement | null>((resolve) => {
    let settled = false;
    const finish = (menu: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(menu);
    };
    const observer = new MutationObserver(() => {
      const menu = findMenu(element, exclude);
      if (menu) finish(menu);
    });
    observer.observe(element.ownerDocument.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "aria-controls", "aria-owns", "role"]
    });
    const timer = window.setTimeout(() => finish(findMenu(element, exclude)), timeoutMs);
  });
  // The role-based search has now had the whole window to succeed. What is left
  // is a menu that declares no roles at all.
  return observed ?? findMenu(element, exclude, true);
}

function triggerSummary(element: HTMLElement): string {
  return [
    element.tagName.toLowerCase(),
    element.getAttribute("role") ?? "",
    element.getAttribute("aria-haspopup") ?? "",
    element.id ? "has-id" : "no-id"
  ].join(":");
}

/** Find the actual interactive descendant, never assuming a decorative wrapper is clickable. */
export function locateChoiceTrigger(field: DiscoveredField): HTMLElement | null {
  const element = field.element;
  if (!element || !element.isConnected) return null;
  if (element instanceof HTMLSelectElement) return element;
  const selector = [
    'input[role="combobox"]',
    'button[aria-haspopup]',
    '[role="combobox"]',
    // A design system routinely declares the popup relationship on a plain
    // <div>. Restricting this to buttons meant such a trigger matched nothing
    // and the whole transaction ended in `control_not_found`.
    '[aria-haspopup]',
    '[aria-controls]',
    '[aria-expanded]',
    'button:not([type="submit"])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(",");
  const safeTrigger = (node: HTMLElement): boolean =>
    !(node instanceof HTMLButtonElement && node.type === "submit");
  if (element.matches(selector) && safeTrigger(element)) return element;
  const present = Array.from(element.querySelectorAll<HTMLElement>(selector)).filter(isVisible);
  const candidates = present.filter(safeTrigger);
  if (candidates.length === 1) return candidates[0];
  const combobox = candidates.find((node) => node.getAttribute("role") === "combobox");
  if (combobox) return combobox;
  // Ambiguity stays a refusal: two plausible triggers means we do not know
  // which control the answer belongs to.
  if (present.length > 0) return null;
  /**
   * Nothing inside refines it — so the element the caller discovered IS the
   * control.
   *
   * The live TikTok symptom: the application adapter identifies its trigger
   * from a deliberately wider set (a bare readonly `<input>`, an
   * `aria-haspopup` div) than this refinement knew, so a control the adapter
   * had positively located was then rejected here and every attempt ended in
   * `TIKTOK_LEGAL_CONTROL_NOT_FOUND` without a single click being tried.
   * Returning it costs nothing: the transaction still has to open a menu,
   * match the approved option, and verify the committed value.
   */
  return safeTrigger(element) ? element : null;
}

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function pointerSequence(element: HTMLElement, types: readonly string[] = FULL_POINTER_SEQUENCE): void {
  const box = element.getBoundingClientRect();
  const shared = {
    bubbles: true, cancelable: true, composed: true,
    clientX: box.left + box.width / 2, clientY: box.top + box.height / 2
  } as const;
  for (const type of types) {
    const event = type.startsWith("pointer")
      ? new PointerEvent(type, { ...shared, pointerId: 1, isPrimary: true })
      : new MouseEvent(type, shared);
    element.dispatchEvent(event);
  }
}

const FULL_POINTER_SEQUENCE = [
  "pointerover", "pointerenter", "mouseover", "mouseenter",
  "pointerdown", "mousedown", "pointerup", "mouseup", "click"
] as const;

/**
 * Press and release WITHOUT a trailing click.
 *
 * A widget that toggles its menu on `mousedown` — the behaviour of several
 * common design systems — is opened by the press and closed again by the click
 * that the full sequence sends immediately afterwards. That control could
 * therefore never be opened at all: the plain `.click()` attempt did nothing
 * because nothing listens for it, and the pointer attempt opened and shut the
 * menu inside one turn.
 */
const PRESS_ONLY_SEQUENCE = [
  "pointerover", "pointerenter", "mouseover", "mouseenter",
  "pointerdown", "mousedown", "pointerup", "mouseup"
] as const;

async function openCustomControl(element: HTMLElement, callerOpened = false): Promise<{
  menu: HTMLElement;
  strategy: NonNullable<TransactionResult["openStrategy"]>;
  /** Menus that belonged to another control when this one was opened. */
  stale: ReadonlySet<HTMLElement>;
} | null> {
  const doc = element.ownerDocument;
  const none: ReadonlySet<HTMLElement> = new Set();
  // A menu THIS control owns is genuinely already open and can be reused.
  const owned = visibleMenus(doc).find((menu) => ownsMenu(element, menu));
  if (owned) return { menu: owned, strategy: "already_open", stale: none };
  // The assisted action opened this control from the user's own click and
  // cleared other menus first, so an unowned menu on screen is this one's.
  if (callerOpened) {
    const justOpened = visibleMenus(doc)[0];
    if (justOpened) return { menu: justOpened, strategy: "already_open", stale: none };
  }

  // Anything else on screen belongs to another control. Close it, then treat
  // whatever survives as off-limits: adopting the previous dropdown's menu is
  // exactly how the second legal question was left blank.
  await dismissForeignMenus(element);
  const stale = new Set(visibleMenus(doc).filter((menu) => !ownsMenu(element, menu)));

  element.focus();
  element.click();
  let menu = await waitForMenu(element, OPEN_ATTEMPT_TIMEOUT_MS, stale);
  if (menu) return { menu, strategy: "click", stale };
  pointerSequence(element);
  menu = await waitForMenu(element, OPEN_ATTEMPT_TIMEOUT_MS, stale);
  if (menu) return { menu, strategy: "pointer", stale };
  // Ordered AFTER the full sequence deliberately: a control that opens on a
  // plain click or on the press-with-click pair is answered by the two
  // attempts above, so this one costs nothing on the common paths. It exists
  // for the widget the full sequence cannot open at all — one that opens on
  // the press and dismisses on the click that follows it.
  pointerSequence(element, PRESS_ONLY_SEQUENCE);
  menu = await waitForMenu(element, OPEN_ATTEMPT_TIMEOUT_MS, stale);
  if (menu) return { menu, strategy: "mouse", stale };
  const keys = ["Enter", " ", "ArrowDown", "Alt+ArrowDown"];
  for (const key of keys) {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key: key === "Alt+ArrowDown" ? "ArrowDown" : key,
      code: key === " " ? "Space" : key === "Alt+ArrowDown" ? "ArrowDown" : key,
      altKey: key === "Alt+ArrowDown", bubbles: true, cancelable: true
    }));
    element.dispatchEvent(new KeyboardEvent("keyup", {
      key: key === "Alt+ArrowDown" ? "ArrowDown" : key,
      altKey: key === "Alt+ArrowDown", bubbles: true, cancelable: true
    }));
    menu = await waitForMenu(element, OPEN_ATTEMPT_TIMEOUT_MS, stale);
    if (menu) return {
      menu,
      stale,
      strategy: key === "Enter"
        ? "enter"
        : key === " "
          ? "space"
          : key === "ArrowDown"
            ? "arrow_down"
            : "alt_arrow_down"
    };
  }
  return null;
}

/**
 * The options belonging to ONE menu.
 *
 * The fallback deliberately does NOT sweep the document. It used to: when the
 * chosen menu held no option descendants, every `[role="option"]` on the page
 * was collected instead — which, with two portaled legal dropdowns on screen,
 * mixed both questions' options into one candidate list. That makes "No" appear
 * twice (`ambiguous_option`) or, worse, selects the other question's option.
 *
 * When the menu itself is empty we look one level out, to the container that
 * holds this menu, and no further.
 */
function optionNodes(menu: HTMLElement): HTMLElement[] {
  const selector = '[role="option"],[role="menuitem"],li,[data-option]';
  const inMenu = deepQueryAll<HTMLElement>(menu, selector);
  const scoped = inMenu.length > 0
    ? inMenu
    // The menu has already been attributed to this control, so its own children
    // ARE its options — even when the widget declares no option role at all.
    // Requiring `role="option"` is why a visibly open Yes/No menu could read as
    // empty and the selection was reported as impossible.
    : roleLessOptions(menu);
  return scoped.filter((node) => isVisible(node) && node.getAttribute("aria-disabled") !== "true");
}

/**
 * Direct children of a resolved menu that carry their own text.
 *
 * A menu commonly wraps its list several levels deep
 * (`<div class="popup"><div class="inner"><ul>…`). Each level with exactly one
 * text-bearing child is a WRAPPER, not a choice, so descend through it — but
 * remember the last real level, because a menu offering a single option ends at
 * a leaf and must still report that option.
 */
function roleLessOptions(menu: HTMLElement): HTMLElement[] {
  const textBearing = (node: HTMLElement): HTMLElement[] =>
    Array.from(node.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement
      && !/^(hr|script|style|template)$/i.test(child.tagName)
      && (child.textContent ?? "").trim().length > 0
    );
  let current = menu;
  let deepest: HTMLElement[] = [];
  for (let depth = 0; depth < 5; depth += 1) {
    const children = textBearing(current);
    if (children.length === 0) break;
    deepest = children;
    if (children.length > 1) break;
    current = children[0];
  }
  return deepest;
}

function matchOption(nodes: HTMLElement[], answer: ChoiceAnswer): { node: HTMLElement | null; ambiguous: boolean } {
  const exact = nodes.filter((node) => normalize(node.textContent ?? "") === normalize(answer.displayAnswer));
  if (exact.length === 1) return { node: exact[0], ambiguous: false };
  if (exact.length > 1) return { node: null, ambiguous: true };
  if (typeof answer.typedAnswer !== "boolean") return { node: null, ambiguous: false };
  const wanted: Polarity = answer.typedAnswer ? "affirmative" : "negative";
  const matches = nodes.filter((node) => {
    const label = node.textContent ?? "";
    const value = node.getAttribute("data-value") ?? node.getAttribute("value") ?? "";
    return booleanPolarity(label) === wanted || booleanPolarity(value) === wanted;
  });
  return { node: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}

/**
 * Select `approvedLabel` on a custom (ARIA / React) control.
 *
 * Opened with a real pointer sequence, because a bare click is ignored by many
 * pointer-driven widgets, and verified after settling because a controlled
 * component can accept the click and then revert on re-render.
 */
async function fillCustomSelect(
  element: HTMLElement,
  answer: ChoiceAnswer,
  states: ChoiceTransactionState[],
  reacquire?: () => DiscoveredField | null,
  callerOpened = false
): Promise<TransactionResult> {
  states.push("OPEN_ATTEMPTED");
  let opened: Awaited<ReturnType<typeof openCustomControl>> = null;
  try {
    opened = await openCustomControl(element, callerOpened);
  } catch {
    opened = null;
  }
  if (!opened) return { ok: false, reason: "menu_not_opened", states, adapter: "custom_choice", trigger: triggerSummary(element), listboxFound: false };
  states.push("CONTROL_OPENED");
  // React may replace the trigger while opening. Reacquire before reading the
  // owned/portaled option container; final verification must never trust the
  // detached pre-open node.
  const afterOpen = reacquire ? locateChoiceTrigger(reacquire() ?? { element: undefined } as DiscoveredField) : element;
  if (!afterOpen || !afterOpen.isConnected) {
    return { ok: false, reason: "control_replaced", states, adapter: "custom_choice", listboxFound: true, openStrategy: opened.strategy };
  }
  // Re-find the menu with the SAME exclusion set the open used.
  //
  // The live TikTok defect: `openCustomControl` carefully refused to adopt a
  // menu the previous dropdown had left mounted, and this line then threw that
  // work away by re-querying with no exclusions — so a still-open first menu,
  // geometrically nearer than the new one, could be adopted after all. Options
  // were then read (and clicked) inside the WRONG question's menu.
  const reFound = findMenu(afterOpen, opened.stale);
  const menu = reFound && !opened.stale.has(reFound) ? reFound : opened.menu;
  const options = optionNodes(menu);
  const optionLabels = options.map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (options.length === 0) return { ok: false, reason: "option_container_missing", states, adapter: "custom_choice", trigger: triggerSummary(afterOpen), listboxFound: true, options: [], openStrategy: opened.strategy };
  states.push("OPTIONS_DISCOVERED");

  const matched = matchOption(options, answer);
  if (!matched.node) return { ok: false, reason: matched.ambiguous ? "ambiguous_option" : "option_not_found", states, adapter: "custom_choice", trigger: triggerSummary(afterOpen), listboxFound: true, options: optionLabels, openStrategy: opened.strategy };
  states.push("OPTION_MATCHED");
  const option = matched.node;
  try {
    option.scrollIntoView({ block: "nearest" });
    option.focus();
    // The full sequence, WITH coordinates and hover: a menu that tracks the
    // active item through `mouseover` commits whatever it last highlighted, so
    // a bare press on an option it never considered hovered could select
    // nothing at all. Exactly one click is sent — a second would toggle a
    // multi-select option back off.
    pointerSequence(option);
  } catch {
    return { ok: false, reason: "interaction_failed", states, adapter: "custom_choice", trigger: triggerSummary(afterOpen), listboxFound: true, options: optionLabels, matchedOption: "[present]", openStrategy: opened.strategy };
  }
  states.push("OPTION_SELECTED");

  // Let the menu close and the framework commit (or revert) the change.
  await delay(SETTLE_MS);
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await delay(SETTLE_MS);

  const current = reacquire ? locateChoiceTrigger(reacquire() ?? { element: undefined } as DiscoveredField) : element;
  if (!current || !current.isConnected) return { ok: false, reason: "control_replaced", states, adapter: "custom_choice", listboxFound: true, options: optionLabels, matchedOption: "[present]", openStrategy: opened.strategy };
  states.push("COMMIT_OBSERVED");
  const displayed = displayedValue(current);
  // Not a raw string equality. A real trigger carries a caret glyph, a clear
  // affordance or a visually hidden label alongside the value, and comparing
  // the whole textContent is what made a control that plainly displayed "Yes"
  // report "could not keep this selection". The comparison below still rejects
  // the opposite answer outright — see committedValueMatches.
  if (!committedValueMatches(displayed, answer.displayAnswer, answer.typedAnswer, optionLabels)) {
    return { ok: false, reason: "selected_value_not_persisted", displayed, states, adapter: "custom_choice", trigger: triggerSummary(current), listboxFound: true, options: optionLabels, matchedOption: "[present]", verificationSource: "display", openStrategy: opened.strategy };
  }

  const hidden = backingInput(current);
  const backing = hidden?.value ?? "";
  if (hidden && !backingRepresentsAnswer(backing, displayed, answer.displayAnswer, answer.typedAnswer, optionLabels)) {
    // The widget shows one thing and would submit another — never acceptable.
    return { ok: false, reason: "backing_value_mismatch", displayed, backing, states, adapter: "custom_choice", trigger: triggerSummary(current), listboxFound: true, options: optionLabels, matchedOption: "[present]", verificationSource: "display+hidden_input", openStrategy: opened.strategy };
  }

  if (validationFailed(current)) {
    return { ok: false, reason: "validation_failed", displayed, backing, states, adapter: "custom_choice", trigger: triggerSummary(current), listboxFound: true, options: optionLabels, matchedOption: "[present]", verificationSource: hidden ? "display+hidden_input" : "display", openStrategy: opened.strategy };
  }

  states.push("VERIFIED", "FILLED");
  return { ok: true, reason: "verified", displayed, backing, states, adapter: "custom_choice", trigger: triggerSummary(current), listboxFound: true, options: optionLabels, matchedOption: "[present]", verificationSource: hidden ? "display+hidden_input" : "display", openStrategy: opened.strategy };
}

/**
 * Run the full transaction for one field.
 *
 * `approvedLabel` must come from the backend's `selected_option_ref`; this
 * function has no opinion about which option is correct and will never pick one
 * on its own.
 */
export async function selectApprovedOption(
  field: DiscoveredField,
  approvedLabel: string,
  answer: Omit<ChoiceAnswer, "displayAnswer"> = {},
  options: ChoiceTransactionOptions = {}
): Promise<TransactionResult> {
  const states: ChoiceTransactionState[] = ["DISCOVERED", "RESOLVER_REQUESTED", "SEMANTICALLY_RESOLVED", "QUEUED_FOR_ACTUATION"];
  const element = locateChoiceTrigger(field);
  if (!element) return { ok: false, reason: "control_not_found", states, adapter: "custom_choice" };
  states.push("CONTROL_LOCATED");
  const adapter = element instanceof HTMLSelectElement ? "native_select" : "custom_choice";
  if (!isVisible(element)) return { ok: false, reason: "control_replaced", states, adapter, trigger: triggerSummary(element) };
  if (!isEnabled(element)) return { ok: false, reason: "control_disabled", states, adapter, trigger: triggerSummary(element) };

  element.scrollIntoView({ block: "center", behavior: "auto" });
  await delay(50);
  await settleLayout();
  if (isCovered(element) && !options.callerOpened) {
    // The live cause of a blank second legal answer: the FIRST dropdown's menu
    // was still mounted over the second control, so the transaction failed
    // before it ever tried to open anything. A menu this control does not own
    // is not an obstacle to report — it is one to close.
    await dismissForeignMenus(element);
    await settleLayout();
    if (isCovered(element)) {
      return { ok: false, reason: "control_covered", states, adapter, trigger: triggerSummary(element) };
    }
  }

  // Already showing the approved value: nothing to do, and re-selecting could
  // toggle a control off. This is what makes retry idempotent — and, on a
  // re-run over a control the user already answered correctly, what keeps a
  // decorated trigger from being re-actuated needlessly.
  //
  // Skipped entirely when a menu is open on this control: the caller opened it
  // in order to CHOOSE, and "what the control displays" is not a settled answer
  // while its options are on screen.
  const menuAlreadyOpen = options.callerOpened
    || visibleMenus(element.ownerDocument).some((menu) => ownsMenu(element, menu));
  if (!menuAlreadyOpen && committedValueMatches(displayedValue(element), approvedLabel, answer.typedAnswer)) {
    const displayed = displayedValue(element);
    const hidden = backingInput(element);
    const backing = element instanceof HTMLSelectElement ? element.value : hidden?.value ?? "";
    if (hidden && !backingRepresentsAnswer(backing, displayed, approvedLabel, answer.typedAnswer)) {
      return { ok: false, reason: "backing_value_mismatch", displayed, backing, states, adapter, trigger: triggerSummary(element) };
    }
    if (validationFailed(element)) {
      return { ok: false, reason: "validation_failed", displayed, backing, states, adapter, trigger: triggerSummary(element) };
    }
    states.push("COMMIT_OBSERVED", "VERIFIED", "FILLED");
    return { ok: true, reason: "verified", displayed, backing, states, adapter, trigger: triggerSummary(element), verificationSource: hidden ? "display+hidden_input" : "display" };
  }

  try {
    if (element instanceof HTMLSelectElement) {
      states.push("OPEN_ATTEMPTED", "CONTROL_OPENED", "OPTIONS_DISCOVERED", "OPTION_MATCHED");
      const result = await fillNativeSelect(element, approvedLabel);
      if (result.ok) states.push("OPTION_SELECTED", "COMMIT_OBSERVED", "VERIFIED", "FILLED");
      return { ...result, states, adapter, trigger: triggerSummary(element), listboxFound: true, options: Array.from(element.options).map((item) => item.textContent ?? ""), matchedOption: result.ok ? "[present]" : undefined, verificationSource: "native_select" };
    }
    return await fillCustomSelect(element, { ...answer, displayAnswer: approvedLabel }, states, options.reacquire, options.callerOpened);
  } catch {
    return { ok: false, reason: "interaction_failed", states, adapter, trigger: triggerSummary(element) };
  }
}


// --------------------------------------------------------------------------- //
// Closed-menu enumeration
// --------------------------------------------------------------------------- //
export type EnumerationFailure =
  | "enumeration_control_missing"
  | "enumeration_control_disabled"
  | "enumeration_control_covered"
  | "enumeration_menu_not_opened"
  | "enumeration_option_container_missing"
  | "enumeration_no_visible_options"
  | "enumeration_value_changed"
  | "enumeration_control_replaced"
  | "enumeration_timeout"
  | "genuine_user_gesture_required";

export interface EnumerationResult {
  ok: boolean;
  options: string[];
  reason: EnumerationFailure | "enumerated";
}

/**
 * Read a custom dropdown's options WITHOUT choosing one.
 *
 * A control whose menu is built on open reports no options while closed, so it
 * was being dropped from the batch entirely — the backend never saw it, and the
 * user's saved answer could not reach it. This opens the menu, reads the
 * labels, closes it again, and proves the control's own value is unchanged.
 *
 * It never selects, never presses Enter or Space (either could submit the
 * surrounding form), and gives up rather than retrying when the page ignores
 * synthetic input.
 */
export async function enumerateOptions(field: DiscoveredField): Promise<EnumerationResult> {
  // The same trigger the transaction will actuate. Reading the options from a
  // decorative wrapper while the fill drives a nested control is how the two
  // could disagree about what the menu offers.
  const element = locateChoiceTrigger(field) ?? field.element;
  if (!element || !element.isConnected) {
    return { ok: false, options: [], reason: "enumeration_control_missing" };
  }
  if (!isEnabled(element)) {
    return { ok: false, options: [], reason: "enumeration_control_disabled" };
  }

  element.scrollIntoView({ block: "center", behavior: "auto" });
  await delay(50);
  if (!element.isConnected) {
    return { ok: false, options: [], reason: "enumeration_control_replaced" };
  }
  if (isCovered(element)) {
    return { ok: false, options: [], reason: "enumeration_control_covered" };
  }

  // Remember what the control shows, so we can prove enumeration was read-only.
  const before = normalize(displayedValue(element));

  // The ordinary sequence first, then a press with no trailing click. A widget
  // that toggles on `mousedown` is opened and immediately closed again by one
  // uninterrupted press-plus-click, which is why a menu that opens for a real
  // user was reported here as having no options at all.
  let menu: HTMLElement | null = null;
  try {
    element.focus();
    pointerSequence(element);
    menu = await waitForMenu(element);
    if (!menu) {
      pointerSequence(element, PRESS_ONLY_SEQUENCE);
      menu = await waitForMenu(element, OPEN_ATTEMPT_TIMEOUT_MS);
    }
  } catch {
    return { ok: false, options: [], reason: "enumeration_menu_not_opened" };
  }

  if (!menu) {
    // The page ignored a synthetic open. Retrying the same events would just
    // fail again, so this becomes an honest request for one real click.
    return { ok: false, options: [], reason: "genuine_user_gesture_required" };
  }

  // The same extraction the fill uses, so a menu whose options carry no ARIA
  // role cannot be enumerated as empty and then selected from successfully (or
  // the reverse).
  const options = optionNodes(menu)
    .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((label) => label.length > 0);

  await closeMenu(element, menu);

  if (options.length === 0) {
    return { ok: false, options: [], reason: "enumeration_option_container_missing" };
  }

  await delay(SETTLE_MS);
  if (!element.isConnected) {
    return { ok: false, options: [], reason: "enumeration_control_replaced" };
  }
  // Reading options must never have answered the question.
  if (normalize(displayedValue(element)) !== before) {
    return { ok: false, options: [], reason: "enumeration_value_changed" };
  }

  return { ok: true, options, reason: "enumerated" };
}

/**
 * Close an open menu without choosing anything.
 *
 * Escape first (the ARIA-standard dismissal, and it cannot activate a submit
 * control), then a click on a neutral part of the page. Never Enter or Space.
 */
async function closeMenu(element: HTMLElement, menu: HTMLElement): Promise<void> {
  try {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
    );
    await delay(60);
    if (isVisible(menu)) {
      const doc = element.ownerDocument;
      doc.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      doc.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await delay(60);
    }
  } catch {
    /* best-effort: a menu left open is untidy, never unsafe */
  }
}

/** Stable identity for an option set, so a changed menu invalidates a result. */
export function optionSetHash(options: string[]): string {
  return options.map((label) => label.replace(/\s+/g, " ").trim().toLowerCase()).join("\u0001");
}
