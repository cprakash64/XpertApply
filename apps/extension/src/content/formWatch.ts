/**
 * Cheap, bounded signals for "has an application form appeared yet?" (EXT-LIVE-01).
 *
 * The previous watcher counted EVERY debounced DOM mutation as one of twelve looks. On a busy single-page
 * application (animations, chat widgets, analytics) the twelve were gone within about half a minute, before
 * the applicant had even opened the form, and then nothing ever looked again. A look now costs a message to
 * the worker and a frame probe, so it is spent only when the page plausibly contains a form; mutations that
 * add no form controls cost one capped selector query and no budget.
 *
 * Nothing here reads a value, a label or any page text. It counts controls.
 */
export const FORM_WATCH = {
  /** Minimum quiet gap between looks. */
  gapMs: 2_000,
  /** Looks that actually reach the worker, per navigation. */
  maxLooks: 20,
  /** Wall-clock window for one navigation. */
  windowMs: 5 * 60_000
} as const;

const CONTROL_SELECTOR = [
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=search])",
  "textarea",
  "select",
  "[role=combobox]"
].join(",");

/** Controls counted, capped so a huge document cannot make a look expensive. */
const SCAN_CAP = 60;

export function countFormControls(doc: Document): number {
  let count = 0;
  for (const el of Array.from(doc.querySelectorAll(CONTROL_SELECTOR))) {
    if (el.closest("[hidden],[aria-hidden=true]")) continue;
    count += 1;
    if (count >= SCAN_CAP) break;
  }
  return count;
}

/** A form worth sending to the worker for judgement: several controls, or a résumé upload. */
export function plausibleApplicationForm(doc: Document): boolean {
  return countFormControls(doc) >= 3 || doc.querySelector("input[type=file]") !== null;
}

export interface WatchBudget {
  /** Called when a look is about to be sent. Returns false when the budget is spent. */
  spend(now: number): boolean;
  /** A real navigation restores the full budget. */
  reset(now: number): void;
  exhausted(now: number): boolean;
}

export function createWatchBudget(limits: { maxLooks: number; windowMs: number } = FORM_WATCH): WatchBudget {
  let looks = 0;
  let start = 0;
  let started = false;
  const begin = (now: number) => { if (!started) { started = true; start = now; } };
  return {
    spend(now) {
      begin(now);
      if (looks >= limits.maxLooks || now - start > limits.windowMs) return false;
      looks += 1;
      return true;
    },
    reset(now) { looks = 0; start = now; started = true; },
    exhausted(now) { begin(now); return looks >= limits.maxLooks || now - start > limits.windowMs; }
  };
}

/**
 * Calls `onNavigate` for a same-document route change (pushState/replaceState/back/forward/hash). Uses the
 * Navigation API where Chrome has it (it sees pushState from the page's own world) and popstate/hashchange
 * as well. Returns a disposer.
 */
export function watchRouteChanges(win: Window, onNavigate: () => void): () => void {
  const nav = (win as unknown as { navigation?: EventTarget }).navigation;
  const handler = () => onNavigate();
  nav?.addEventListener("navigatesuccess", handler);
  win.addEventListener("popstate", handler);
  win.addEventListener("hashchange", handler);
  return () => {
    nav?.removeEventListener("navigatesuccess", handler);
    win.removeEventListener("popstate", handler);
    win.removeEventListener("hashchange", handler);
  };
}
