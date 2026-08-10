/**
 * The ONE dropdown fill path. Automatic autofill and the user's own choice in
 * the JobPilot widget both call `fillDropdown` — there is no separate simplified
 * widget path.
 *
 * Guarantees:
 *   • only one dropdown is open per frame at a time (global mutex/queue);
 *   • a click attempt is never success — every selection is verified by reading
 *     real DOM state, with one reopen + keyboard retry before failing;
 *   • a placeholder ("Select…") never counts as a value;
 *   • the first option is NEVER chosen as a fallback.
 */

import {
  aliasMatches,
  binaryAnswerMatches,
  companyCareersSourceMatches,
  closestGpaOption,
  dialCodeMatches,
  gpaOptionMatches,
  graduationYearOptionMatches,
  locationOptionMatches,
  normalizeForMatch,
  phoneCountryOptionMatches,
  singletonPrivacyAcknowledgementMatches,
  singletonRequiredAffirmationMatches
} from "../aliases";
import type { DiscoveredField } from "../../types";
import { deepQuery } from "../../dom/deepDom";
import { delay, focus, isElementVisible, key, TIMING, waitFor } from "./dom";
import { focusTarget } from "./adapters/custom";
import { selectAdapter } from "./registry";
import type {
  AnswerSource,
  DropdownAdapter,
  DropdownEvent,
  DropdownFillResult,
  DropdownOption,
  DropdownReason
} from "./types";

export * from "./types";
export { selectAdapter, isDropdownField, DROPDOWN_ADAPTERS } from "./registry";
export { isBlankValue } from "./dom";

// --------------------------------------------------------------------------- //
// Per-frame mutex: never drive two dropdowns concurrently.
// --------------------------------------------------------------------------- //
let queue: Promise<unknown> = Promise.resolve();

export function withDropdownLock<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // Keep the chain alive even if a task rejects.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// --------------------------------------------------------------------------- //
// Diagnostics recorder (no answer values — labels/counts/codes only)
// --------------------------------------------------------------------------- //
/** Per-field event trail from the most recent attempt, for "Copy diagnostics".
 * Structural codes and counts ONLY — never the user's answer. */
const eventLog = new Map<string, DropdownEvent[]>();

export function dropdownEventLog(): Record<string, DropdownEvent[]> {
  return Object.fromEntries(eventLog);
}

export function clearDropdownEventLog(): void {
  eventLog.clear();
}

class Recorder {
  readonly events: DropdownEvent[] = [];
  constructor(private readonly uid: string) {}
  add(event: DropdownEvent["event"], detail?: DropdownEvent["detail"]): void {
    this.events.push({ event, uid: this.uid, detail });
  }
}

export interface DropdownFillOptions {
  /** Requested answer(s). Multi-select is an ARRAY, never comma-joined text. */
  values: string[];
  /** Optional query that reveals remote/search-only options. */
  searchValue?: string;
  matchMode?: "graduation_year" | "gpa";
  /** Open the control purely to READ its options — an explicit user action in
   * the review widget. Never set during an autofill run: opening a menu we
   * cannot answer leaves the employer page visibly disturbed, which is exactly
   * how the live Airbnb page ended up with every dropdown open and blank. */
  allowProbe?: boolean;
  answerSource?: AnswerSource;
  /** Hook so the caller (widget) can hide an overlay covering the control. */
  beforeInteract?: () => void | Promise<void>;
  afterInteract?: () => void | Promise<void>;
}

/**
 * Drive one dropdown to a verified selection. Returns the option labels the
 * control actually offers even on failure, so the widget can present real
 * choices to the user.
 */
export async function fillDropdown(field: DiscoveredField, options: DropdownFillOptions): Promise<DropdownFillResult> {
  return withDropdownLock(() => fillDropdownUnlocked(field, options));
}

async function fillDropdownUnlocked(field: DiscoveredField, opts: DropdownFillOptions): Promise<DropdownFillResult> {
  const rec = new Recorder(field.uid);
  eventLog.set(field.uid, rec.events); // live reference: grows as the attempt runs
  rec.add("FIELD_DISCOVERED", { control: field.control, required: field.required });

  const adapter = selectAdapter(field);
  if (!adapter) {
    return fail(rec, "DROPDOWN_OPEN_FAILED", [], []);
  }
  rec.add("DROPDOWN_ADAPTER_SELECTED", { adapter: adapter.id });

  const wanted = opts.values.map((v) => v.trim()).filter(Boolean);
  if (wanted.length === 0) {
    // INVARIANT: never touch a control we have no answer for.
    //
    // This used to probe — open the menu to collect its real options for the
    // review widget. On the live Airbnb/Greenhouse page that left every
    // unanswered dropdown visibly opened and still reading "Select…", which is
    // precisely the reported symptom ("dropdowns open but no option is
    // selected"). Probing is now opt-in and belongs to an explicit user action,
    // never to an autofill run.
    if (!opts.allowProbe) {
      rec.add("SKIPPED_NO_TARGET");
      return {
        ok: false,
        reason: "SKIPPED_NO_TARGET",
        adapterId: adapter.id,
        // Read-only: readSelection never opens the control.
        selected: adapter.readSelection(field),
        options: [],
        events: rec.events
      };
    }
    const probe = await probeOptions(field, adapter, rec, opts);
    return {
      ok: false,
      reason: "ANSWER_MISSING",
      adapterId: adapter.id,
      selected: adapter.readSelection(field),
      options: probe,
      events: rec.events
    };
  }

  await opts.beforeInteract?.();
  try {
    const result = await attemptFill(field, adapter, wanted, rec, opts);
    return result;
  } finally {
    await adapter.close(field).catch(() => undefined);
    await opts.afterInteract?.();
  }
}

async function attemptFill(
  field: DiscoveredField,
  adapter: DropdownAdapter,
  wanted: string[],
  rec: Recorder,
  opts: DropdownFillOptions
): Promise<DropdownFillResult> {
  let availableLabels: string[] = [];

  // Two passes: the second reopens the control and uses the keyboard path.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const useKeyboard = attempt === 1;
    rec.add("DROPDOWN_OPEN_ATTEMPT", { attempt: attempt + 1, keyboard: useKeyboard });

    let opened = await adapter.open(field);
    let available: DropdownOption[] = [];
    if (!opened.ok) {
      // A remote autocomplete has nothing to open until it has a query: no
      // pointer or keyboard sequence produces a menu, because the menu is built
      // from search results. Typing IS the open gesture for these controls, and
      // requiring a menu first is why every location and company picker
      // reported DROPDOWN_OPEN_FAILED on a control that works perfectly by hand.
      const searched = await openBySearching(field, adapter, wanted[0], opts, rec);
      if (searched) {
        available = searched;
        opened = { ok: true, listbox: null };
      } else {
        const freeText = await commitFreeText(field, adapter, wanted[0], rec);
        if (freeText) {
          rec.add("SELECTION_VERIFIED", { adapter: adapter.id, freeText: true });
          return {
            ok: true, adapterId: adapter.id, answerSource: opts.answerSource,
            selected: adapter.readSelection(field), options: [], events: rec.events
          };
        }
        if (attempt === 1) return fail(rec, opened.reason ?? "DROPDOWN_OPEN_FAILED", [], availableLabels, adapter.id);
        continue;
      }
    }
    rec.add("DROPDOWN_OPENED", { adapter: adapter.id });

    if (available.length === 0) available = await adapter.getOptions(field, opened.listbox);
    // A remote autocomplete opens an EMPTY listbox and renders results only
    // after a query — and it matches a NAME, not the whole stored value. Typing
    // "Phoenix, Arizona, United States" into a city picker returns nothing,
    // which is exactly how a saved location produced "no options" and left the
    // required City field blank. So the queries are tried shortest-specific
    // last: the caller's term, the value itself, then its leading token.
    if (available.length === 0) {
      for (const query of searchQueries(opts.searchValue, wanted[0])) {
        typeSearch(field, adapter, query);
        available = await adapter.getOptions(field, opened.listbox);
        if (available.length > 0) {
          rec.add("OPTIONS_AFTER_SEARCH", { queryLength: query.length });
          break;
        }
      }
    }
    if (available.length === 0) {
      // A free-text combobox legitimately offers no list. `aria-autocomplete`
      // of "both" or "inline" means typed text IS a valid value — the control
      // suggests, it does not constrain. SmartRecruiters' Title and Company
      // fields are exactly this: no menu ever appears, and the component keeps
      // whatever is typed. Treating them as list-only controls is why an
      // Experience row opened and then stayed completely empty.
      const freeText = await commitFreeText(field, adapter, wanted[0], rec);
      if (freeText) {
        rec.add("SELECTION_VERIFIED", { adapter: adapter.id, freeText: true });
        return {
          ok: true,
          adapterId: adapter.id,
          answerSource: opts.answerSource,
          selected: adapter.readSelection(field),
          options: [],
          events: rec.events
        };
      }
      rec.add("OPTIONS_NOT_FOUND");
      if (attempt === 1) {
        return fail(rec, opened.listbox ? "OPTIONS_NOT_FOUND" : "LISTBOX_NOT_FOUND", [], availableLabels, adapter.id);
      }
      continue;
    }
    availableLabels = available.map((o) => o.label);
    rec.add("OPTIONS_DISCOVERED", { count: available.length });
    if (opts.answerSource) rec.add("ANSWER_SOURCE", { source: opts.answerSource });

    // ---- select every requested value (multi-select selects one at a time) --
    const verified: string[] = [];
    let lastFailure: DropdownReason | null = null;

    for (const value of wanted) {
      // Re-open + re-collect between selections: a multi-select menu often
      // closes after each pick, and options re-render.
      if (verified.length > 0) {
        const reopened = await adapter.open(field);
        if (!reopened.ok) {
          lastFailure = reopened.reason ?? "DROPDOWN_OPEN_FAILED";
          break;
        }
        available = await adapter.getOptions(field, reopened.listbox);
      }

      let option = matchOption(available, value, opts.matchMode);

      // Searchable control: type to reveal a filtered option. The same ladder
      // applies — a picker that holds "Phoenix, Arizona, United States" will
      // only surface it for the query "Phoenix".
      if (!option) {
        for (const query of searchQueries(opts.searchValue, value)) {
          typeSearch(field, adapter, query);
          available = await adapter.getOptions(field, null);
          option = matchOption(available, value, opts.matchMode);
          if (option) break;
        }
      }
      // The picker offered suggestions, but none of them IS the stored value.
      // Three live SmartRecruiters cases, in order of preference.
      if (!option) {
        // 1. The list constrains the answer and offers the value's own head:
        //    stored "Machine Learning Engineer, Contract", offered "Machine
        //    Learning Engineer". Accepted only when exactly one option stands
        //    in that relationship, so this can never become a guess between
        //    "Veotrex" and "Veotrex Labs".
        option = nearestUniqueOption(available, value);
        if (option) rec.add("OPTION_MATCHED", { adapter: adapter.id, narrowed: true });
      }
      if (!option) {
        // 2. The remote search returned exactly ONE record for this query, and
        //    it plainly refers to what was asked for. On a lookup that stores a
        //    record rather than text, choosing it is the only way the value
        //    ever reaches the employer — typing alone leaves the field blank
        //    with "Value is required" beneath it.
        option = onlySearchResultFor(available, value);
        if (option) rec.add("OPTION_MATCHED", { adapter: adapter.id, soleResult: true });
      }
      if (!option) {
        // 2. The control suggests but does not constrain, so the exact stored
        //    value is a legitimate answer. Previously this was only ever tried
        //    when the menu was EMPTY — so a suggestion list with no exact match
        //    ended the attempt, `close()` sent Escape, and the employer's field
        //    was left blank with the typed text discarded. That is the reported
        //    "it writes it, then the search box opens and it goes empty".
        if (await commitFreeText(field, adapter, value, rec)) {
          verified.push(value);
          continue;
        }
        lastFailure = "OPTION_NOT_AVAILABLE";
        continue;
      }
      rec.add("OPTION_MATCHED", { adapter: adapter.id });

      const selected = useKeyboard
        ? await selectViaKeyboard(field, adapter, option)
        : await adapter.select(field, option);
      if (!selected.ok) {
        lastFailure = selected.reason ?? "DROPDOWN_SELECTION_FAILED";
        continue;
      }
      rec.add("OPTION_CLICKED");

      // THE critical step: a click attempt is not success.
      if (await adapter.verify(field, option)) {
        rec.add("SELECTION_VERIFIED");
        verified.push(option.label);
      } else if (value === "__jobpilot_company_careers_page__") {
        // Workday source pickers are hierarchical. Clicking "Career Website"
        // can open a second menu rather than commit a value. Only continue when
        // that submenu exposes an explicit company/careers-site leaf — never a
        // first-item fallback.
        await delay(80);
        const nested = await adapter.getOptions(field, null);
        const leaf = nested.find((candidate) =>
          candidate.element !== option.element &&
          !candidate.disabled &&
          isElementVisible(candidate.element) &&
          /^(?:company (?:website|careers?(?: page| site)?)|career website|company career site)$/i.test(candidate.label.trim())
        );
        if (leaf) {
          const leafSelected = await adapter.select(field, leaf);
          if (leafSelected.ok && await adapter.verify(field, leaf)) {
            rec.add("SELECTION_VERIFIED");
            verified.push(leaf.label);
          } else {
            lastFailure = "DROPDOWN_VERIFICATION_FAILED";
          }
        } else {
          lastFailure = "DROPDOWN_VERIFICATION_FAILED";
        }
      } else {
        lastFailure = "DROPDOWN_VERIFICATION_FAILED";
      }
    }

    if (verified.length === wanted.length) {
      return {
        ok: true,
        adapterId: adapter.id,
        answerSource: opts.answerSource,
        selected: adapter.readSelection(field),
        options: availableLabels,
        events: rec.events
      };
    }
    if (attempt === 1) {
      return fail(rec, lastFailure ?? "DROPDOWN_SELECTION_FAILED", adapter.readSelection(field), availableLabels, adapter.id);
    }
    // Fall through to the keyboard retry pass.
    await adapter.close(field).catch(() => undefined);
    await delay(80);
  }

  return fail(rec, "DROPDOWN_SELECTION_FAILED", adapter.readSelection(field), availableLabels, adapter.id);
}

/** Open just to read the real option labels (used when we have no answer). */
async function probeOptions(
  field: DiscoveredField,
  adapter: DropdownAdapter,
  rec: Recorder,
  opts: DropdownFillOptions
): Promise<string[]> {
  await opts.beforeInteract?.();
  try {
    const opened = await adapter.open(field);
    if (!opened.ok) {
      rec.add(opened.reason ?? "DROPDOWN_OPEN_FAILED");
      return field.options ?? [];
    }
    const available = await adapter.getOptions(field, opened.listbox);
    rec.add("OPTIONS_DISCOVERED", { count: available.length });
    return available.map((o) => o.label);
  } finally {
    await adapter.close(field).catch(() => undefined);
    await opts.afterInteract?.();
  }
}

/** Keyboard selection: move to the exact option and commit with Enter. Enter is
 * NEVER pressed unless the exact expected option is present. */
async function selectViaKeyboard(field: DiscoveredField, adapter: DropdownAdapter, option: DropdownOption) {
  const input = focusTarget(field);
  focus(input);
  // Walk the list to the target so the component's own highlight logic runs.
  for (let i = 0; i < 40; i += 1) {
    if (option.element.getAttribute("aria-selected") === "true" || isActiveDescendant(input, option.element)) break;
    key(input, "ArrowDown");
    await delay(TIMING.keyboardStepMs);
  }
  key(input, "Enter");
  // A searchable combobox's INPUT contains the query text before any option is
  // committed. `readSelection().length > 0` therefore mistakes "Tempe" for a
  // selected "Tempe, AZ". Verify the exact expected option instead.
  if (await adapter.verify(field, option)) return { ok: true } as const;
  // Fall back to a direct press on the option element.
  return adapter.select(field, option);
}

function isActiveDescendant(control: HTMLElement, option: HTMLElement): boolean {
  const id = control.getAttribute("aria-activedescendant");
  return Boolean(id && option.id && id === option.id);
}

function typeSearch(field: DiscoveredField, adapter: DropdownAdapter, text: string): void {
  const typed = (adapter as DropdownAdapter & { typeSearch?: (f: DiscoveredField, t: string) => void }).typeSearch;
  if (typed) typed(field, text);
}

/** Exact normalized match first, then the CONTROLLED alias table. Never a broad
 * fuzzy match, and never "just take the first option". */
function matchOption(
  options: DropdownOption[],
  value: string,
  matchMode?: "graduation_year" | "gpa"
): DropdownOption | null {
  const usable = options.filter((o) => !o.disabled && isElementVisible(o.element));
  const substantive = usable.filter((o) => !/^(?:select|choose|please select)(?:\s+an?\s+option)?(?:\.{3}|…)?$/i.test(o.label.trim()));
  const target = normalizeForMatch(value);
  return (
    usable.find((o) => o.normalizedLabel === target) ??
    (matchMode === "graduation_year"
      ? substantive.find((o) => graduationYearOptionMatches(o.label, value))
      : undefined) ??
    (matchMode === "gpa"
      ? substantive.find((o) => gpaOptionMatches(o.label, value)) ?? closestGpaOption(substantive, value)
      : undefined) ??
    substantive.find((o) => companyCareersSourceMatches(o.label, value)) ??
    substantive.find((o) => singletonPrivacyAcknowledgementMatches(o.label, value, substantive.map((item) => item.label))) ??
    substantive.find((o) => singletonRequiredAffirmationMatches(o.label, value, substantive.map((item) => item.label))) ??
    usable.find((o) => aliasMatches(o.label, value)) ??
    // Explicit binary facts may be rendered as a verbose sentence by the ATS
    // (`authorized_us` -> "Yes, I am currently legally authorized…").
    usable.find((o) => binaryAnswerMatches(o.label, value)) ??
    usable.find((o) => locationOptionMatches(o.label, value)) ??
    usable.find((o) => phoneCountryOptionMatches(o.label, value)) ??
    // Dial codes only ("+1" -> "United States (+1)"); see dialCodeMatches.
    usable.find((o) => dialCodeMatches(o.label, value)) ??
    null
  );
}

/**
 * Open a search-driven control by giving it something to search for.
 *
 * Returns the options it produced, or null when no query yields any. The chosen
 * option is still matched against the full value later — the query only decides
 * what the control fetches, never what is selected.
 */
async function openBySearching(
  field: DiscoveredField,
  adapter: DropdownAdapter,
  value: string,
  opts: DropdownFillOptions,
  rec: Recorder
): Promise<DropdownOption[] | null> {
  const typed = (adapter as DropdownAdapter & { typeSearch?: unknown }).typeSearch;
  if (typeof typed !== "function") return null;
  for (const query of searchQueries(opts.searchValue, value)) {
    typeSearch(field, adapter, query);
    const options = await adapter.getOptions(field, null);
    if (options.length > 0) {
      rec.add("OPTIONS_AFTER_SEARCH", { queryLength: query.length });
      return options;
    }
  }
  return null;
}

/**
 * Is this control one that ACCEPTS typed text as its value?
 *
 * `aria-autocomplete="both"`/`"inline"` says so explicitly: the widget completes
 * as you type, and the typed string is the value. `"list"` means the value must
 * come from the list, so free text is never committed there — that distinction
 * is what keeps a location field from storing an unrecognised place name.
 */
function acceptsFreeText(field: DiscoveredField): boolean {
  const element = field.element as HTMLElement | undefined;
  if (!element) return false;
  // Shadow-piercing: the `aria-autocomplete` that decides this lives on the real
  // control, which a web-component wrapper keeps in its shadow root.
  const input = element.tagName.toLowerCase() === "input"
    ? element
    : deepQuery<HTMLElement>(element, 'input:not([type="hidden"])');
  if (!input) return false;
  const mode = (input.getAttribute("aria-autocomplete") ?? element.getAttribute("aria-autocomplete") ?? "").toLowerCase();
  return mode === "both" || mode === "inline";
}

/**
 * Type a value into a free-text combobox and prove the control kept it.
 *
 * Verification is the whole point: the text is only a fill if the widget's own
 * state reflects it after settling, which is what separates this from typing
 * into a list-constrained control and hoping.
 */
async function commitFreeText(
  field: DiscoveredField,
  adapter: DropdownAdapter,
  value: string,
  rec: Recorder
): Promise<boolean> {
  if (!acceptsFreeText(field)) return false;
  typeSearch(field, adapter, value);
  const kept = await waitFor(() => {
    const selection = adapter.readSelection(field);
    return selection.some((item) => normalizeForMatch(item) === normalizeForMatch(value)) ? true : null;
  }, TIMING.verifyMs);
  if (!kept) return false;
  // Holding the text is not the same as accepting it. A lookup that requires a
  // picked record keeps whatever is typed and then marks itself invalid — the
  // live Institution field showed "Arizona State University" above a red "Value
  // is required". Reporting that as filled would be a false success on a
  // required field, which is worse than the failure it replaces.
  //
  // Judged only after the component has settled: several of these controls flip
  // to invalid on every keystroke and clear it once their own validation runs,
  // so an immediate read would condemn a value the control was about to accept.
  await delay(TIMING.pollStepMs * 4);
  if (controlRejectedValue(field)) {
    rec.add("FREE_TEXT_REJECTED");
    return false;
  }
  rec.add("FREE_TEXT_COMMITTED");
  return true;
}

/** Has the employer's control marked the value it is holding as unacceptable? */
function controlRejectedValue(field: DiscoveredField): boolean {
  const element = field.element as HTMLElement | undefined;
  if (!element) return true;
  const invalid = (node: HTMLElement | null): boolean =>
    Boolean(node && (node.getAttribute("aria-invalid") === "true"
      || (node as HTMLInputElement).validationMessage));
  if (invalid(element)) return true;
  return invalid(deepQuery<HTMLElement>(element, '[aria-invalid="true"],input:not([type="hidden"])'));
}

/**
 * The one option the stored value plainly refers to.
 *
 * A constrained picker often carries the canonical head of a longer stored
 * value ("Machine Learning Engineer" for "Machine Learning Engineer,
 * Contract"). Matching on a word boundary keeps "Veo" from claiming "Veotrex",
 * and returning only a UNIQUE match keeps this from choosing between "Veotrex"
 * and "Veotrex Labs" — ambiguity stays a failure the user resolves.
 */
/**
 * The single record a remote lookup returned for this query.
 *
 * A search picker stores a RECORD, not text: "Arizona State University" typed
 * into Institution is nothing until its own entry is chosen, which is why the
 * field read "Value is required" under text that was plainly there.
 *
 * Still not a blind "take the first row". It applies only when the search came
 * back with exactly one usable suggestion AND that suggestion is the same thing
 * said with more or fewer words — every significant word of one appears in the
 * other. A shared leading word is nowhere near enough: "Arizona State
 * University" and "Arizona Western College" share "Arizona" and are different
 * schools, and committing the wrong one is worse than leaving the field for the
 * user.
 */
export function onlySearchResultFor(options: DropdownOption[], value: string): DropdownOption | null {
  const usable = options.filter((option) => !option.disabled && isElementVisible(option.element));
  if (usable.length !== 1) return null;
  const words = (text: string): string[] =>
    normalizeForMatch(text).split(/\s+/).filter((word) => word.length >= 2);
  const wanted = words(value);
  const offered = words(usable[0].label);
  if (wanted.length === 0 || offered.length === 0) return null;
  const covers = (outer: string[], inner: string[]): boolean => {
    const set = new Set(outer);
    return inner.every((word) => set.has(word));
  };
  return covers(offered, wanted) || covers(wanted, offered) ? usable[0] : null;
}

export function nearestUniqueOption(options: DropdownOption[], value: string): DropdownOption | null {
  const target = normalizeForMatch(value);
  if (target.length < 3) return null;
  const boundary = (longer: string, shorter: string): boolean =>
    shorter.length >= 3 && longer.startsWith(shorter) && /[\s,(/-]/.test(longer.charAt(shorter.length));
  const matches = options.filter((option) => {
    if (option.disabled || !isElementVisible(option.element)) return false;
    const label = option.normalizedLabel;
    return boundary(target, label) || boundary(label, target);
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Queries to try against a searchable control, most specific first.
 *
 * Deliberately ordered: the caller's explicit term wins, then the exact stored
 * value, and only then its leading comma-separated token. Nothing shorter is
 * ever tried — a two-character prefix would match many wrong places, and the
 * chosen OPTION is still matched against the full value, never against the
 * query.
 */
export function searchQueries(searchValue: string | undefined, value: string): string[] {
  const out: string[] = [];
  const push = (candidate: string | undefined): void => {
    const trimmed = (candidate ?? "").trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  push(searchValue);
  push(value);
  const head = value.split(",")[0]?.trim();
  if (head && head.length >= 3 && head !== value) push(head);
  return out;
}

function fail(
  rec: Recorder,
  reason: DropdownReason,
  selected: string[],
  options: string[],
  adapterId?: string
): DropdownFillResult {
  rec.add(reason);
  return { ok: false, reason, adapterId, selected, options, events: rec.events };
}
