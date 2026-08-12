import type { DiscoveredField, FieldControl } from "../types";
import {
  booleanPolarity,
  dismissForeignMenus,
  displayedValue,
  locateChoiceTrigger,
  selectApprovedOption,
  type TransactionFailure,
  type TransactionResult
} from "../content/dropdownTransaction";

export type TikTokLegalKind = "authorization" | "sponsorship_now_or_future";

export const TIKTOK_LEGAL_IDENTITIES: Record<TikTokLegalKind, string> = {
  authorization: "tiktok:work_authorization:authorization",
  sponsorship_now_or_future: "tiktok:work_authorization:sponsorship_now_or_future"
};

const DEFINITIONS: ReadonlyArray<{
  kind: TikTokLegalKind;
  canonicalKey: "work_authorization_us" | "sponsorship_required_now_or_future";
  aliases: readonly string[];
}> = [
  {
    kind: "authorization",
    canonicalKey: "work_authorization_us",
    aliases: [
      "are you legally authorized to work in the us without restriction",
      "are you legally authorized to work in the united states without restriction",
      "are you authorized to work in the us",
      "are you authorized to work in the united states"
    ]
  },
  {
    kind: "sponsorship_now_or_future",
    canonicalKey: "sponsorship_required_now_or_future",
    aliases: [
      "will you now or in the future require visa sponsorship or a visa transfer",
      "will you now or in the future require sponsorship",
      "do you currently or will you in the future require sponsorship",
      "will you require employer sponsorship or a visa transfer"
    ]
  }
];

/**
 * Stable activation failures.
 *
 * Every one of these names a DIFFERENT cause, because the live failure we are
 * fixing collapsed all of them into `TIKTOK_ADAPTER_NOT_ACTIVATED` — which told
 * us nothing about the fact that the real application host was never on the
 * allowlist in the first place.
 */
export type TikTokActivationFailureCode =
  | "TIKTOK_HOST_NOT_SUPPORTED"
  | "TIKTOK_CONTENT_SCRIPT_NOT_INJECTED"
  | "TIKTOK_APPLICATION_SURFACE_NOT_FOUND"
  | "TIKTOK_WORK_AUTHORIZATION_SECTION_NOT_FOUND"
  | "TIKTOK_AUTHORIZATION_ROW_NOT_FOUND"
  | "TIKTOK_SPONSORSHIP_ROW_NOT_FOUND"
  | "TIKTOK_ADAPTER_NOT_ACTIVATED";

export type TikTokSlotFailureCode =
  | "TIKTOK_LEGAL_CONTROL_NOT_FOUND"
  | "TIKTOK_AUTHORIZATION_ROW_NOT_FOUND"
  | "TIKTOK_SPONSORSHIP_ROW_NOT_FOUND";

export interface TikTokLegalSlot {
  identity: string;
  kind: TikTokLegalKind;
  canonicalKey: "work_authorization_us" | "sponsorship_required_now_or_future";
  rowFound: boolean;
  triggerFound: boolean;
  row: HTMLElement | null;
  trigger: HTMLElement | null;
  field: DiscoveredField | null;
  failureCode: TikTokSlotFailureCode | null;
}

export interface TikTokAdapterTrace {
  adapterName: "tiktok_application";
  adapterActivated: boolean;
  activationReason: string;
  /** Approved hostname, or "not-supported" when the host is off the allowlist.
   * Never an arbitrary third-party hostname. */
  hostname: string;
  /** Path with locale prefixes and identifiers replaced by placeholders. */
  pathShape: string;
  hostAllowed: boolean;
  contentScriptAllowed: boolean;
  applicationSurfaceFound: boolean;
  activationFailureCode: TikTokActivationFailureCode | null;
  /** Which strategy located the Work Authorization section. */
  sectionSource: "heading" | "question_labels" | null;
  currentUrl: string;
  domGeneration: number;
  urlMatch: boolean;
  applicationPageFound: boolean;
  workAuthorizationSectionFound: boolean;
  authorizationQuestionFound: boolean;
  sponsorshipQuestionFound: boolean;
  authorizationTriggerFound: boolean;
  sponsorshipTriggerFound: boolean;
  authorizationInventoryInserted: boolean;
  sponsorshipInventoryInserted: boolean;
  authorizationActuatorReached: boolean;
  sponsorshipActuatorReached: boolean;
  finalVerificationUsedTikTokAdapter: boolean;
  /** Same fact under the name the adapter-health contract uses. */
  finalVerificationUsedAdapter: boolean;
  authorizationRowFound: boolean;
  sponsorshipRowFound: boolean;
  authorizationTriggerSummary: string | null;
  sponsorshipTriggerSummary: string | null;
  distinctFieldIdentities: boolean;
  identities: string[];
}

export interface TikTokInventory {
  active: boolean;
  slots: TikTokLegalSlot[];
  trace: TikTokAdapterTrace;
}

export interface TikTokCommittedVerification {
  verified: boolean;
  displayPresent: boolean;
  backingPresent: boolean;
  verificationSource: string | null;
  displayedPolarity: "affirmative" | "negative" | "unknown";
  backingPolarity: "affirmative" | "negative" | "unknown";
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function directText(element: HTMLElement): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ");
}

function rendered(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

/**
 * Approved TikTok Careers application hosts.
 *
 * The live blocker: the real authenticated application is served from
 * `lifeattiktok.com/resume/<application-id>/apply`, and this allowlist
 * contained only `careers.tiktok.com`. The adapter therefore never activated on
 * the one host that actually renders the Work Authorization questions.
 *
 * Deliberately an explicit allowlist and NOT `*.tiktok.com`: consumer TikTok
 * pages must never be treated as an application surface.
 */
export const TIKTOK_APPLICATION_HOSTS: readonly string[] = [
  "lifeattiktok.com",
  "careers.tiktok.com"
];

/**
 * Is this an approved TikTok Careers application origin?
 *
 * Matching is exact-host or dot-anchored suffix, never substring, so
 * `careers.tiktok.com.evil.test` and `notlifeattiktok.com` both fail. HTTPS is
 * required: an application form served over plaintext is not one we act on.
 */
export function tikTokHostAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    // A trailing dot is a fully-qualified form of the same host.
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return TIKTOK_APPLICATION_HOSTS.some(
      (approved) => host === approved || host.endsWith(`.${approved}`)
    );
  } catch {
    return false;
  }
}

/**
 * Retained name for the host gate.
 *
 * Activation is deliberately NOT one rigid route regex any more: locale
 * prefixes, query parameters, hashes, SPA routes, `/resume/<id>/apply` and
 * extra path segments are all legitimate application URLs, and gating on a
 * single path shape is what made the adapter disappear on the live host.
 */
export function matchesTikTokApplicationUrl(url: string): boolean {
  return tikTokHostAllowed(url);
}

/**
 * May the content script run here at all?
 *
 * The manifest declaratively injects into every https origin, so on an approved
 * host this is true whenever this code is executing. It is reported separately
 * so a future manifest narrowing produces `TIKTOK_CONTENT_SCRIPT_NOT_INJECTED`
 * instead of a misleading "adapter not activated".
 */
function contentScriptAllowedFor(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Approved hostname, or a placeholder. Never echoes an unapproved host. */
function redactedHostname(url: string): string {
  if (!tikTokHostAllowed(url)) return "not-supported";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "not-supported";
  }
}

/**
 * Normalized path shape for diagnostics: `/resume/<id>/apply`.
 *
 * Identifiers are replaced so an application id never lands in a pasted bug
 * report, while the SHAPE — which is what tells us whether the route changed —
 * survives.
 */
function redactedPathShape(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean).map((segment) => {
      if (/^[a-z]{2}([-_][a-z]{2,4})?$/i.test(segment)) return "<locale>";
      if (/^\d+$/.test(segment)) return "<id>";
      if (/\d/.test(segment) && segment.length >= 8) return "<id>";
      return segment.toLowerCase().slice(0, 32);
    });
    return `/${segments.join("/")}`;
  } catch {
    return "<invalid-url>";
  }
}

/**
 * Origin plus the SHAPED path.
 *
 * The raw pathname carried the application id (`/resume/7412…/apply`) straight
 * into a diagnostic blob users are asked to paste into bug reports. The shape is
 * what has diagnostic value; the id never was.
 */
function redactedOriginPath(url: string): string {
  try {
    return `${new URL(url).origin}${redactedPathShape(url)}`;
  } catch {
    return "invalid-url";
  }
}

function definitionForText(text: string) {
  const normalized = normalize(text);
  return DEFINITIONS.find((definition) => definition.aliases.some((alias) => normalized === alias)) ?? null;
}

export function isTikTokLegalQuestionText(text: string): boolean {
  return Boolean(definitionForText(text));
}

function containsDefinition(element: HTMLElement, kind: TikTokLegalKind): boolean {
  const text = normalize(element.innerText || element.textContent || "");
  const definition = DEFINITIONS.find((item) => item.kind === kind)!;
  return definition.aliases.some((alias) => text.includes(alias));
}

function containsBothQuestions(element: HTMLElement): boolean {
  return containsDefinition(element, "authorization") && containsDefinition(element, "sponsorship_now_or_future");
}

function elementRoot(root: ParentNode): HTMLElement | null {
  return root instanceof HTMLElement ? root : (root as Document).body ?? null;
}

/**
 * Locate the Work Authorization section.
 *
 * Strategy 1 (`heading`) is the normal case: a visible "Work Authorization"
 * heading whose nearest ancestor also holds one of the legal questions.
 *
 * Strategy 2 (`question_labels`) is the safety net. The required invariant is
 * "if both question labels are visible, both identities are in the inventory",
 * and hanging that on one heading string would break the moment TikTok renames
 * it. When a legal question is plainly on the page but no heading matched, the
 * smallest ancestor containing the questions is the section.
 */
function findSection(root: ParentNode): { section: HTMLElement; source: "heading" | "question_labels" } | null {
  const headings = Array.from(root.querySelectorAll<HTMLElement>(
    'h1,h2,h3,h4,h5,h6,legend,[role="heading"],div,span'
  )).filter((element) => rendered(element) && normalize(directText(element) || element.getAttribute("aria-label") || "") === "work authorization");
  for (const heading of headings) {
    let candidate: HTMLElement | null = heading.parentElement;
    while (candidate && candidate !== root && candidate !== candidate.ownerDocument.body) {
      if (containsDefinition(candidate, "authorization") || containsDefinition(candidate, "sponsorship_now_or_future")) {
        return { section: candidate, source: "heading" };
      }
      candidate = candidate.parentElement;
    }
  }

  const host = elementRoot(root);
  if (host && (containsDefinition(host, "authorization") || containsDefinition(host, "sponsorship_now_or_future"))) {
    // Narrow to the smallest descendant that still holds every question we can
    // see, so the section stays as tight as the heading strategy would make it.
    let current: HTMLElement = host;
    for (;;) {
      const next = Array.from(current.children).find(
        (child): child is HTMLElement =>
          child instanceof HTMLElement
          && rendered(child)
          && questionKindsIn(child).length === questionKindsIn(current).length
      );
      if (!next) break;
      current = next;
    }
    return { section: current, source: "question_labels" };
  }
  return null;
}

function questionKindsIn(element: HTMLElement): TikTokLegalKind[] {
  return DEFINITIONS.filter((definition) => containsDefinition(element, definition.kind)).map((item) => item.kind);
}

/**
 * The node that carries the question text.
 *
 * Exact match on the element's OWN text first (so a wrapper holding both
 * questions never wins). A normalized containment pass follows, because a live
 * label routinely carries a required marker or trailing punctuation that the
 * alias list does not spell out — and returning null there would silently drop
 * a required legal field.
 */
function findQuestionNode(section: HTMLElement, kind: TikTokLegalKind): HTMLElement | null {
  const aliases = DEFINITIONS.find((item) => item.kind === kind)!.aliases;
  const visible = Array.from(section.querySelectorAll<HTMLElement>("label,legend,p,span,div"))
    .filter((element) => rendered(element));
  const smallestFirst = (a: HTMLElement, b: HTMLElement) =>
    a.querySelectorAll("*").length - b.querySelectorAll("*").length;

  const exact = visible.filter((element) =>
    aliases.includes(normalize(directText(element) || element.getAttribute("aria-label") || ""))
  );
  if (exact.length > 0) return exact.sort(smallestFirst)[0];

  const contained = visible.filter((element) => {
    const own = normalize(directText(element) || element.getAttribute("aria-label") || "");
    if (!own) return false;
    // Only this question — a node whose own text spans both is a wrapper.
    if (aliases.every((alias) => !own.includes(alias))) return false;
    return !DEFINITIONS.filter((item) => item.kind !== kind)
      .some((other) => other.aliases.some((alias) => own.includes(alias)));
  });
  return contained.sort(smallestFirst)[0] ?? null;
}

const TRIGGER_SELECTOR = [
  "select",
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
  'button:not([type="submit"])',
  '[role="combobox"]',
  '[aria-haspopup]',
  '[aria-controls]',
  '[aria-expanded]',
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function triggerScore(element: HTMLElement): number {
  if (element instanceof HTMLSelectElement) return 100;
  if (element.getAttribute("role") === "combobox") return 95;
  if (element.getAttribute("aria-haspopup") === "listbox") return 90;
  if (element.hasAttribute("aria-controls") || element.hasAttribute("aria-expanded")) return 80;
  if (element instanceof HTMLButtonElement) return 70;
  if (element instanceof HTMLInputElement) return 65;
  if (element.hasAttribute("tabindex")) return 50;
  return 0;
}

function candidateTriggers(container: HTMLElement, question: HTMLElement): HTMLElement[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(TRIGGER_SELECTOR));
  if (container.matches(TRIGGER_SELECTOR)) nodes.unshift(container);
  return Array.from(new Set(nodes)).filter((element) => {
    if (!rendered(element) || element.closest("#jobpilot-assisted-apply")) return false;
    if (element instanceof HTMLButtonElement && element.type === "submit") return false;
    if (isTikTokLegalQuestionText(element.innerText || element.textContent || "") && element !== question) return false;
    return true;
  });
}

function closestByGeometry(candidates: HTMLElement[], question: HTMLElement): HTMLElement {
  const questionBox = question.getBoundingClientRect();
  return [...candidates].sort((left, right) => {
    const scoreDelta = triggerScore(right) - triggerScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    const distance = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return Math.abs(box.top - questionBox.bottom) + Math.abs(box.left - questionBox.left);
    };
    return distance(left) - distance(right);
  })[0];
}

function locateRowAndTrigger(
  section: HTMLElement,
  question: HTMLElement
): { row: HTMLElement; trigger: HTMLElement | null } {
  let current: HTMLElement | null = question;
  let fallback = question;
  while (current && current !== section) {
    if (containsBothQuestions(current)) break;
    fallback = current;
    const local = candidateTriggers(current, question);
    if (local.length > 0) return { row: current, trigger: closestByGeometry(local, question) };

    // TikTok can align the clickable trigger as the next cell rather than nest
    // it below the question label. Inspect only nearby siblings owned by this
    // row; never climb into a container holding both legal questions.
    for (const sibling of [current.nextElementSibling, current.previousElementSibling]) {
      if (!(sibling instanceof HTMLElement) || containsBothQuestions(sibling)) continue;
      const aligned = candidateTriggers(sibling, question);
      if (aligned.length > 0) return { row: current.parentElement ?? current, trigger: closestByGeometry(aligned, question) };
    }
    current = current.parentElement;
  }
  return { row: fallback, trigger: null };
}

function controlType(trigger: HTMLElement | null): FieldControl {
  if (trigger instanceof HTMLSelectElement) return "select";
  if (trigger instanceof HTMLInputElement) return trigger.getAttribute("role") === "combobox" ? "combobox" : "text";
  if (trigger?.getAttribute("role") === "listbox") return "listbox";
  return "combobox";
}

function optionsOf(trigger: HTMLElement | null): string[] {
  if (trigger instanceof HTMLSelectElement) {
    return Array.from(trigger.options).map((option) => option.textContent?.trim() ?? "").filter(Boolean);
  }
  return (trigger?.getAttribute("data-options") ?? "").split("|").map((item) => item.trim()).filter(Boolean);
}

function makeField(
  identity: string,
  question: HTMLElement,
  row: HTMLElement,
  trigger: HTMLElement | null,
  step: number
): DiscoveredField {
  const label = (directText(question) || question.getAttribute("aria-label") || question.textContent || "").replace(/\s+/g, " ").trim();
  return {
    uid: identity,
    frameId: window.top === window ? "top" : "frame",
    control: controlType(trigger),
    inputType: trigger instanceof HTMLInputElement ? trigger.type : "",
    name: trigger instanceof HTMLInputElement || trigger instanceof HTMLSelectElement ? trigger.name : "",
    id: trigger?.id ?? "",
    autocomplete: trigger?.getAttribute("autocomplete") ?? "",
    placeholder: trigger?.getAttribute("placeholder") ?? "",
    ariaLabel: trigger?.getAttribute("aria-label") ?? label,
    label,
    labelSource: "tiktok_application_adapter",
    normalizedLabel: normalize(label),
    nearbyText: normalize(row.innerText || row.textContent || ""),
    sectionHeading: "Work Authorization",
    required: true,
    disabled: trigger instanceof HTMLInputElement || trigger instanceof HTMLSelectElement || trigger instanceof HTMLButtonElement
      ? trigger.disabled
      : trigger?.getAttribute("aria-disabled") === "true",
    visible: true,
    multiple: trigger instanceof HTMLSelectElement ? trigger.multiple : trigger?.getAttribute("aria-multiselectable") === "true",
    custom: !(trigger instanceof HTMLSelectElement),
    existingValue: trigger ? displayedValue(trigger) : "",
    options: optionsOf(trigger),
    validationMessage: trigger instanceof HTMLInputElement || trigger instanceof HTMLSelectElement ? trigger.validationMessage : "",
    step,
    element: trigger ?? undefined
  };
}

function summarizeTrigger(trigger: HTMLElement | null): string | null {
  if (!trigger) return null;
  return [
    trigger.tagName.toLowerCase(),
    trigger.getAttribute("role") ?? "none",
    trigger.hasAttribute("aria-controls") ? "controls" : "no-controls",
    trigger.hasAttribute("aria-expanded") ? "expanded-state" : "no-expanded-state",
    trigger.hasAttribute("tabindex") ? "focusable" : "native-focus"
  ].join(":");
}

export function discoverTikTokApplication(
  url: string,
  root: ParentNode = document,
  step = 0
): TikTokInventory {
  const hostAllowed = tikTokHostAllowed(url);
  const contentScriptAllowed = contentScriptAllowedFor(url);
  // Always inspect the supplied application root. Gating section discovery on
  // one historical path regex caused the live adapter to vanish completely:
  // no authoritative entries and, worse, no technical issue.
  const located = findSection(root);
  const section = located?.section ?? null;
  const host = elementRoot(root);
  const applicationSurfaceFound = Boolean(
    (host && host.matches("form,[role='form']"))
    || root.querySelector("form,[role='form']")
    || root.querySelector("input:not([type='hidden']),select,textarea,[role='combobox'],[role='listbox']")
  );
  const slots: TikTokLegalSlot[] = [];

  for (const definition of DEFINITIONS) {
    const identity = TIKTOK_LEGAL_IDENTITIES[definition.kind];
    const question = section ? findQuestionNode(section, definition.kind) : null;
    const row = section && question ? locateRowAndTrigger(section, question) : null;
    const missingRowCode: TikTokSlotFailureCode = definition.kind === "authorization"
      ? "TIKTOK_AUTHORIZATION_ROW_NOT_FOUND"
      : "TIKTOK_SPONSORSHIP_ROW_NOT_FOUND";
    slots.push({
      identity,
      kind: definition.kind,
      canonicalKey: definition.canonicalKey,
      rowFound: Boolean(question),
      triggerFound: Boolean(row?.trigger),
      row: row?.row ?? null,
      trigger: row?.trigger ?? null,
      field: question && row ? makeField(identity, question, row.row, row.trigger, step) : null,
      failureCode: !question
        ? (section ? missingRowCode : null)
        : row?.trigger
          ? null
          : "TIKTOK_LEGAL_CONTROL_NOT_FOUND"
    });
  }

  // One broad ancestor must never become both legal controls.
  if (slots[0]?.trigger && slots[0].trigger === slots[1]?.trigger) {
    for (const slot of slots) {
      slot.trigger = null;
      slot.triggerFound = false;
      slot.failureCode = "TIKTOK_LEGAL_CONTROL_NOT_FOUND";
      if (slot.field) slot.field.element = undefined;
    }
  }

  // Activation requires HTTPS, an approved host, a visible application surface,
  // a visible Work Authorization section, and at least ONE recognized legal
  // question label. It deliberately does NOT require both rows: a page showing
  // only one of them must still produce that one authoritative identity plus a
  // named technical issue for the other, never a silent zero.
  const recognizedQuestions = slots.filter((slot) => slot.rowFound).length;
  const activationFailureCode: TikTokActivationFailureCode | null =
    !hostAllowed ? "TIKTOK_HOST_NOT_SUPPORTED"
    : !contentScriptAllowed ? "TIKTOK_CONTENT_SCRIPT_NOT_INJECTED"
    : !applicationSurfaceFound ? "TIKTOK_APPLICATION_SURFACE_NOT_FOUND"
    : !section ? "TIKTOK_WORK_AUTHORIZATION_SECTION_NOT_FOUND"
    : recognizedQuestions === 0 ? "TIKTOK_AUTHORIZATION_ROW_NOT_FOUND"
    : null;
  const active = activationFailureCode === null;
  const activationReason = active
    ? "approved_tiktok_careers_origin_and_visible_work_authorization_section"
    : activationFailureCode;
  return {
    active,
    slots,
    trace: {
      adapterName: "tiktok_application",
      adapterActivated: active,
      activationReason,
      hostname: redactedHostname(url),
      pathShape: redactedPathShape(url),
      hostAllowed,
      contentScriptAllowed,
      applicationSurfaceFound,
      activationFailureCode,
      sectionSource: located?.source ?? null,
      currentUrl: redactedOriginPath(url),
      domGeneration: step,
      urlMatch: hostAllowed,
      applicationPageFound: applicationSurfaceFound,
      workAuthorizationSectionFound: Boolean(section),
      authorizationQuestionFound: Boolean(slots[0]?.rowFound),
      sponsorshipQuestionFound: Boolean(slots[1]?.rowFound),
      authorizationTriggerFound: Boolean(slots[0]?.triggerFound),
      sponsorshipTriggerFound: Boolean(slots[1]?.triggerFound),
      authorizationInventoryInserted: active && Boolean(slots[0]?.field),
      sponsorshipInventoryInserted: active && Boolean(slots[1]?.field),
      authorizationActuatorReached: false,
      sponsorshipActuatorReached: false,
      finalVerificationUsedTikTokAdapter: false,
      finalVerificationUsedAdapter: false,
      authorizationRowFound: Boolean(slots[0]?.rowFound),
      sponsorshipRowFound: Boolean(slots[1]?.rowFound),
      authorizationTriggerSummary: summarizeTrigger(slots[0]?.trigger ?? null),
      sponsorshipTriggerSummary: summarizeTrigger(slots[1]?.trigger ?? null),
      distinctFieldIdentities: new Set(slots.map((slot) => slot.identity)).size === 2
        && (!slots[0]?.trigger || !slots[1]?.trigger || slots[0].trigger !== slots[1].trigger),
      identities: slots.map((slot) => slot.identity)
    }
  };
}

export function mergeTikTokLegalFields(
  genericFields: DiscoveredField[],
  inventory: TikTokInventory
): DiscoveredField[] {
  if (!inventory.active) return genericFields;
  const adapterElements = new Set(inventory.slots.map((slot) => slot.trigger).filter(Boolean));
  const adapterRows = inventory.slots.map((slot) => slot.row).filter((row): row is HTMLElement => Boolean(row));
  const retained = genericFields.filter((field) =>
    !adapterElements.has(field.element ?? null)
    && !isTikTokLegalQuestionText(`${field.label} ${field.ariaLabel}`)
    && !(
      field.element
      && adapterRows.some((row) => row.contains(field.element!) || field.element!.contains(row))
      && (containsDefinition(field.element, "authorization") || containsDefinition(field.element, "sponsorship_now_or_future"))
    )
  );
  return [...retained, ...inventory.slots.flatMap((slot) => slot.field ? [slot.field] : [])];
}

function backingCandidates(slot: TikTokLegalSlot): string[] {
  if (!slot.row) return [];
  const values: string[] = [];
  for (const input of slot.row.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select")) {
    if (input instanceof HTMLInputElement && ["checkbox", "radio"].includes(input.type) && !input.checked) continue;
    if (input.value.trim()) values.push(input.value.trim());
    if (input instanceof HTMLSelectElement && input.selectedOptions[0]?.textContent) {
      values.push(input.selectedOptions[0].textContent.trim());
    }
  }
  for (const selected of slot.row.querySelectorAll<HTMLElement>('[aria-selected="true"]')) {
    if (selected.textContent?.trim()) values.push(selected.textContent.trim());
  }
  return values;
}

export function verifyTikTokCommitted(
  slot: TikTokLegalSlot,
  expected: boolean | null | undefined
): TikTokCommittedVerification {
  const trigger = slot.trigger ?? (slot.field ? locateChoiceTrigger(slot.field) : null);
  const displayed = trigger ? displayedValue(trigger).replace(/\s+/g, " ").trim() : "";
  const displayedPolarity = booleanPolarity(displayed);
  const backing = backingCandidates(slot);
  const backingPolarities = backing.map(booleanPolarity).filter((item) => item !== "unknown");
  const backingPolarity = backingPolarities.length === 1
    ? backingPolarities[0]
    : backingPolarities.length > 1 && backingPolarities.every((item) => item === backingPolarities[0])
      ? backingPolarities[0]
      : "unknown";
  if (typeof expected !== "boolean") {
    return {
      verified: false,
      displayPresent: displayedPolarity !== "unknown",
      backingPresent: backing.length > 0,
      verificationSource: null,
      displayedPolarity,
      backingPolarity
    };
  }
  const wanted = expected ? "affirmative" : "negative";
  const displayMatches = displayedPolarity === wanted;
  const backingMatches = backingPolarity === wanted;
  const contradiction = (displayedPolarity !== "unknown" && displayedPolarity !== wanted)
    || (backingPolarity !== "unknown" && backingPolarity !== wanted);
  const verified = !contradiction && (displayMatches || backingMatches);
  return {
    verified,
    displayPresent: displayedPolarity !== "unknown",
    backingPresent: backing.length > 0,
    verificationSource: verified
      ? displayMatches && backingMatches ? "display+backing" : displayMatches ? "display" : "backing"
      : null,
    displayedPolarity,
    backingPolarity
  };
}

export function tikTokFailureCode(reason: TransactionFailure | "verified" | string): string {
  if (reason === "control_not_found" || reason === "control_replaced") return "TIKTOK_LEGAL_CONTROL_NOT_FOUND";
  if (reason === "menu_not_opened") return "LISTBOX_NOT_OPENED";
  if (reason === "option_container_missing" || reason === "option_not_found" || reason === "ambiguous_option") return "OPTION_NOT_FOUND";
  if (reason === "interaction_failed" || reason === "selected_value_not_persisted") return "CONTROL_VALUE_DID_NOT_COMMIT";
  return "CONTROL_VALUE_DID_NOT_COMMIT";
}

export async function actuateTikTokLegalField(
  url: string,
  identity: string,
  approvedDisplay: string,
  typedAnswer: boolean,
  root: ParentNode = document,
  assisted = false
): Promise<TransactionResult> {
  const reacquire = () => discoverTikTokApplication(url, root).slots.find((slot) => slot.identity === identity)?.field ?? null;
  const initial = discoverTikTokApplication(url, root).slots.find((slot) => slot.identity === identity);
  if (!initial?.field || !initial.trigger) {
    return {
      ok: false,
      reason: "control_not_found",
      states: ["DISCOVERED", "RESOLVER_REQUESTED", "SEMANTICALLY_RESOLVED", "QUEUED_FOR_ACTUATION"],
      adapter: "custom_choice"
    };
  }
  if (assisted) {
    initial.trigger.scrollIntoView({ block: "center", behavior: "auto" });
    initial.trigger.style.outline = "3px solid #5b5ce2";
    initial.trigger.style.outlineOffset = "3px";
    initial.trigger.focus();
    // Close anything the OTHER legal question left open first. The two TikTok
    // dropdowns portal into the same place, so a menu still mounted from the
    // first question would sit over this trigger — the live cause of the second
    // (sponsorship) answer staying blank — and would then be mistaken for this
    // control's own menu once we click.
    await dismissForeignMenus(initial.trigger);
    // Called synchronously from the widget click handler so TikTok receives the
    // user's activation. The generic transaction detects an already-open menu.
    initial.trigger.click();
  }
  return selectApprovedOption(initial.field, approvedDisplay, {
    canonicalKey: initial.canonicalKey,
    typedAnswer
  }, { reacquire, callerOpened: assisted });
}

export const TikTokApplicationAdapter = {
  id: "tiktok_application",
  discover: discoverTikTokApplication,
  actuate: actuateTikTokLegalField,
  verify: verifyTikTokCommitted
} as const;
