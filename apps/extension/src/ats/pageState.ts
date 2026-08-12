/**
 * What kind of page is the extension actually looking at?
 *
 * The retry loop used to ask only one question — "are there form controls yet?"
 * — and answered "not yet" on every page that was not an application form. A
 * job LISTING page, an employer LOGIN page, and an application that is genuinely
 * still rendering are three different situations with three different correct
 * responses, and treating all of them as "keep polling" is what produced
 * "Detecting fields (attempt 11)" on a page that was never going to grow a form.
 *
 * This module classifies the page so the caller can act on the answer instead of
 * retrying blindly. It is pure: it reads the DOM and returns a verdict, and it
 * never clicks, fills, or navigates.
 */

import { resolveApplicationForm } from "./base";
import { selectActivationControl, type ActivationCandidate } from "./applicationSurface";

/**
 * The application-navigation state machine.
 *
 * Progression is roughly linear, but not enforced here — a redirect can move
 * from `filling` straight back to `employer_auth_required`, and the caller has
 * to cope with that rather than assume a happy path.
 */
export type NavigationState =
  | "listing_page"
  | "apply_cta_detected"
  | "opening_application"
  | "employer_auth_required"
  | "application_form_loading"
  | "application_form_ready"
  | "filling"
  | "review_required"
  | "submission_confirmed"
  | "failed";

export interface PageClassification {
  state: NavigationState;
  /** The safe Apply control, only when `state === "apply_cta_detected"`. */
  candidate: ActivationCandidate | null;
  /** Machine reason code for logs and the side panel. Never free text. */
  reason: string;
  /** True when an overlay (cookie/consent) is covering the page. */
  obstructed: boolean;
}

/**
 * Is the element rendered at all?
 *
 * Deliberately style-based rather than geometry-based. `getBoundingClientRect`
 * and `offsetParent` report zero in any environment without a layout engine, so
 * a geometry test silently classifies every element as hidden there — including
 * in this project's own DOM tests.
 */
function isRendered(el: HTMLElement, doc: Document): boolean {
  const style = doc.defaultView?.getComputedStyle(el);
  if (!style) return true;
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

/** Password inputs are the single strongest signal of an authentication page. */
function passwordFields(doc: Document): HTMLInputElement[] {
  return Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(
    (input) => isRendered(input, doc)
  );
}

const AUTH_PHRASES = [
  /\bsign in\b/i,
  /\blog ?in\b/i,
  /\bcreate (an )?account\b/i,
  /\bsign up\b/i,
  /\bforgot (your )?password\b/i,
  /\bwelcome back\b/i
];

/**
 * Is this an employer authentication screen?
 *
 * A visible password field is necessary but not sufficient: an application form
 * can legitimately contain an account-creation password (Workday does exactly
 * this). So we additionally require that the page does NOT look like a real
 * application — otherwise every Workday application would be classified as a
 * login page and autofill would pause forever.
 */
export function isEmployerAuthPage(doc: Document): boolean {
  const passwords = passwordFields(doc);
  if (passwords.length === 0) return false;

  const form = resolveApplicationForm(doc);
  if (form.confident) return false;

  // A login screen is small. Counting the visible controls separates it from a
  // long application that happens to include a password.
  const controls = doc.querySelectorAll(
    'input:not([type=hidden]):not([type=submit]),textarea,select'
  );
  if (controls.length > 8) return false;

  const text = (doc.body?.textContent ?? "").slice(0, 4000);
  return AUTH_PHRASES.some((pattern) => pattern.test(text));
}

/**
 * Is a consent/cookie overlay covering the page?
 *
 * Reported, never acted on automatically: accepting cookies is the user's
 * decision. Knowing about it lets the caller explain a stalled page instead of
 * retrying against an overlay forever.
 */
export function hasConsentOverlay(doc: Document): boolean {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>(
      '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i],[role="dialog"]'
    )
  );
  return candidates.some((element) => {
    if (!isRendered(element, doc)) return false;
    const style = doc.defaultView?.getComputedStyle(element);
    // An overlay is defined by being pinned over the page, not by its measured
    // size — size is unavailable without a layout engine, and a banner's
    // dimensions vary hugely between sites anyway.
    if (style?.position !== "fixed" && style?.position !== "sticky") return false;
    // Require actual consent wording so an unrelated sticky header (or any
    // role="dialog") is not mistaken for a cookie banner.
    const haystack = `${element.id} ${element.className} ${element.getAttribute("aria-label") ?? ""} ${
      (element.textContent ?? "").slice(0, 500)
    }`;
    return /cookie|consent|gdpr|privacy/i.test(haystack);
  });
}

/**
 * Find a consent control that declines or dismisses WITHOUT consenting.
 *
 * Deliberately one-sided: there is no "accept" branch anywhere in this codebase.
 * Returns null when the banner only offers consent-heavy options, which the
 * caller surfaces to the user rather than resolving on their behalf.
 */
export function findSafeConsentDismissal(doc: Document): HTMLElement | null {
  const SAFE = [
    /\breject all\b/i,
    /\breject non-essential\b/i,
    /\bdecline all\b/i,
    /\bdecline\b/i,
    /\bonly (necessary|essential)\b/i,
    /\b(necessary|essential) (cookies )?only\b/i,
    /\bcontinue without accepting\b/i
  ];
  const controls = Array.from(doc.querySelectorAll<HTMLElement>('button,[role="button"],a[href]'));
  return (
    controls.find((element) => {
      // A control the user cannot see is not an option we can take on their
      // behalf: "clicking" it would silently do nothing and we would report a
      // dismissal that never happened.
      if (!isRendered(element, doc)) return false;
      const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
      if (!label) return false;
      // "Accept all" must never match, including via a stray "reject" nearby.
      if (/\baccept\b|\ballow all\b|\bagree\b/i.test(label)) return false;
      return SAFE.some((pattern) => pattern.test(label));
    }) ?? null
  );
}

/**
 * Is the CTA actually covered by something else at its own centre point?
 *
 * Real hit-testing rather than "is there a banner somewhere": a cookie bar
 * pinned to the bottom of the page usually does NOT cover an Apply button in
 * the middle of the job description, and dismissing it in that case would be an
 * unnecessary interaction with a consent UI.
 */
export function isCtaObstructed(element: HTMLElement, doc: Document): boolean {
  const box = element.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return false;
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  // Outside the viewport there is nothing to hit-test against; the caller
  // scrolls the element into view before asking.
  const view = doc.defaultView;
  if (!view) return false;
  if (x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) return false;

  const topmost = doc.elementFromPoint(x, y);
  if (!topmost) return false;
  return !(topmost === element || element.contains(topmost) || topmost.contains(element));
}

/**
 * Stable identity for "this CTA on this page", used to guarantee one automatic
 * activation. Contains no entered values and no user data — a URL, a role hint,
 * and the control's own accessible name.
 */
export function ctaFingerprint(element: HTMLElement, url: string): string {
  const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 60);
  const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
  return `${url.split("#")[0]}|${role}|${name}`;
}

export type ActivationOutcome = {
  ok: boolean;
  /** How the click was ultimately delivered. */
  method: "pointer_sequence" | "element_click" | "none";
  reason: string;
};

/**
 * Activate a CTA the way a user does.
 *
 * `HTMLElement.click()` dispatches a bare `click` event with no preceding
 * pointer events. Plenty of employer pages — React and pointer-driven ones
 * especially — only treat an interaction as real when it arrives as a full
 * pointer/mouse sequence, and silently ignore the synthetic click. That is a
 * genuine cause of "nothing happened" with no exception thrown, so the pointer
 * sequence is the PRIMARY strategy and `.click()` is only the fallback.
 *
 * Both strategies are dispatched at most once, in one pass. This never loops.
 */
export function activateApplyCta(element: HTMLElement, doc: Document): ActivationOutcome {
  const view = doc.defaultView;
  if (!view) return { ok: false, method: "none", reason: "NO_VIEW" };

  const style = view.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return { ok: false, method: "none", reason: "NOT_VISIBLE" };
  }
  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
    return { ok: false, method: "none", reason: "DISABLED" };
  }

  const box = element.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;

  try {
    element.focus?.();
  } catch {
    /* focus is best-effort */
  }

  const shared = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y } as const;
  let method: ActivationOutcome["method"] = "pointer_sequence";
  try {
    // A full sequence, in the order a real pointer produces it.
    element.dispatchEvent(new PointerEvent("pointerover", { ...shared, pointerId: 1, isPrimary: true }));
    element.dispatchEvent(new PointerEvent("pointerdown", { ...shared, pointerId: 1, isPrimary: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mousedown", { ...shared, button: 0 }));
    element.dispatchEvent(new PointerEvent("pointerup", { ...shared, pointerId: 1, isPrimary: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...shared, button: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...shared, button: 0 }));
  } catch {
    // PointerEvent is unavailable in some embedded engines; the plain click
    // below is still a real activation.
    method = "element_click";
    try {
      element.click();
    } catch (error) {
      return { ok: false, method: "none", reason: `DISPATCH_FAILED_${String(error).slice(0, 20)}` };
    }
  }

  return { ok: true, method, reason: "DISPATCHED" };
}

/**
 * Classify the page. The caller uses the returned state to decide whether to
 * discover fields, click an Apply CTA, pause for authentication, or stop.
 */
export function classifyPage(doc: Document): PageClassification {
  const obstructed = hasConsentOverlay(doc);

  if (isEmployerAuthPage(doc)) {
    return { state: "employer_auth_required", candidate: null, reason: "PASSWORD_FIELD_WITHOUT_APPLICATION", obstructed };
  }

  const form = resolveApplicationForm(doc);
  if (form.confident) {
    return { state: "application_form_ready", candidate: null, reason: "APPLICATION_ROOT_RESOLVED", obstructed };
  }
  if (form.reason === "APPLICATION_FORM_AMBIGUOUS") {
    return { state: "failed", candidate: null, reason: "APPLICATION_FORM_AMBIGUOUS", obstructed };
  }

  const candidate = selectActivationControl(doc);
  if (candidate) {
    return { state: "apply_cta_detected", candidate, reason: candidate.reason, obstructed };
  }

  // No application, and nothing safe to click. If the page has form controls at
  // all it may still be rendering; otherwise it is a listing we cannot advance.
  const controls = doc.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=true]');
  return controls.length > 0
    ? { state: "application_form_loading", candidate: null, reason: "CONTROLS_PRESENT_ROOT_UNRESOLVED", obstructed }
    : { state: "listing_page", candidate: null, reason: "NO_APPLICATION_AND_NO_SAFE_CTA", obstructed };
}
