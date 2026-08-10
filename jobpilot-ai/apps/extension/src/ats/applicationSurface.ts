/**
 * Application-surface activation.
 *
 * Some career pages do not render the application at all until the user reveals
 * it. On the live Airbnb page the "Role overview" tab is selected on load, the
 * Greenhouse iframe does not exist yet, and the application only appears after
 * activating a control whose accessible name is "Switch to application form"
 * (visible text: "Apply Now").
 *
 * Autofill previously ran, found no application in the top document, and stored
 * a terminal failure — before the application had any chance to exist.
 *
 * This module finds a control that merely REVEALS the application. The user has
 * already asked to "Open and autofill application", so revealing it is within
 * what they requested. Everything that could transmit data, authenticate, or
 * commit the application is excluded by name, and the reason a control was
 * judged safe is recorded so the decision is auditable.
 */

export interface ActivationCandidate {
  element: HTMLElement;
  /** Why this control was considered a safe application-surface control. */
  reason: string;
  /** Higher wins. */
  score: number;
}

/**
 * Controls that must NEVER be activated automatically.
 *
 * Checked before any positive rule, and matched against the accessible name,
 * the visible text and the control's own attributes — a control only has to
 * look like one of these once to be excluded permanently.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /^(?!submit interest\b).*\bsubmit(?: application)?\b/i, // final commit, not "Submit interest"
  /\bquick apply\b/i,                  // "Quick Apply with MyGreenhouse" — sends data
  /\bmygreenhouse\b/i,
  /\bsign\s*(in|up)\b/i,
  /\blog\s*(in|out)\b/i,
  /\bcontinue with\b/i,                // OAuth buttons
  /\bautofill with\b/i,                // third-party autofill integrations
  /\bupload\b/i,
  /\battach\b/i,
  /\bsend\b/i,
  /\bagree\b/i,
  /\baccept\b/i,
  /\bconsent\b/i,
  /\bdelete\b/i,
  /\bwithdraw\b/i,
  // Cookie/consent and marketing controls. Activating any of these is either a
  // consent decision that is the user's to make, or simply not an application.
  /\bcookie/i,
  /\ball cookies\b/i,
  /\bsubscribe\b/i,
  /\bnewsletter\b/i,
  /\bjob alert/i,
  /\bsave (this )?job\b/i,
  /\bshare\b/i,
  /\brefer (?:a |your )?friend\b/i,
  /\bsimilar jobs?\b/i,
  /\bview application history\b/i,
  // "Apply filters" / "Apply changes" on a search UI.
  /\bapply\s+(filters?|changes)\b/i,
  // Someone else's job — "Apply to other roles", "Apply for other positions".
  /\bapply (to|for) (another|other|similar|more)\b/i,
  // Past tense: a status chip, not an action.
  /^applied\b/i
];

/**
 * Accessible names that legitimately mean "open the application for THIS job".
 *
 * Ordered by how specific each phrase is. A phrase that names the job ("apply
 * to this job", "apply for this position") is far less likely to be a header or
 * marketing control than a bare "apply", so it scores higher and wins when a
 * page offers both.
 */
const APPLY_PHRASES: { pattern: RegExp; score: number; reason: string; specific: boolean }[] = [
  // `specific: true` phrases name the application itself, so they stand on their
  // own. Generic ones ("apply", "apply now") are ambiguous — they appear on
  // marketing pages and site headers just as often — and are additionally
  // required to sit in the job's own content or behave like navigation.
  { pattern: /^apply (to|for) this (job|role|position|opening)\b/, score: 72, reason: "job_specific_apply_cta", specific: true },
  { pattern: /^apply (to|for) (this )?(role|position|opening)\b/, score: 70, reason: "job_specific_apply_cta", specific: true },
  { pattern: /^(start|begin) (your |the )?application\b/, score: 70, reason: "start_application_cta", specific: true },
  { pattern: /^continue (your |the )?application\b/, score: 70, reason: "continue_application_cta", specific: true },
  { pattern: /^i(?:'|’| a)m interested\b/, score: 74, reason: "interest_application_cta", specific: true },
  { pattern: /^submit interest\b/, score: 72, reason: "submit_interest_cta", specific: true },
  { pattern: /^apply externally\b/, score: 72, reason: "external_apply_cta", specific: true },
  { pattern: /^join us\b/, score: 68, reason: "join_us_cta", specific: false },
  { pattern: /^apply now\b/, score: 62, reason: "apply_now_cta", specific: false },
  { pattern: /^apply\b/, score: 55, reason: "apply_cta", specific: false }
];

/** Containers whose contents are the job itself rather than site chrome. */
const MAIN_CONTENT_SELECTOR = "main,[role='main'],article,[class*='job-detail' i],[class*='job-content' i],[id*='job-detail' i],[data-testid*='job-detail' i]";
/** Site chrome. An Apply control here is a shortcut, not the job's own CTA. */
const CHROME_SELECTOR = "header,nav,footer,[role='banner'],[role='navigation'],[role='contentinfo']";

/** Accessible name for a control, using the same precedence the AT would. */
export function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();
  return (el.textContent ?? "").trim();
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isVisible(el: HTMLElement): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
  return true;
}

/** True when ANY text associated with this control is forbidden. */
export function isForbiddenControl(el: Element): boolean {
  const haystack = [
    accessibleName(el),
    el.textContent ?? "",
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("name") ?? "",
    el.id
  ].join(" ");
  return FORBIDDEN_PATTERNS.some((re) => re.test(haystack));
}

/**
 * Find controls that reveal the application, best first.
 *
 * Deliberately conservative: a control is NOT eligible merely because it
 * contains the word "Apply" ("Apply filters", "Apply for other roles",
 * "Applied" …). It must either say explicitly that it switches to the
 * application form, or be a tab named Application, or be an Apply control that
 * additionally behaves like navigation (a tab, or a control pointing at an
 * application anchor).
 */
const CONTROL_SELECTOR = 'button,[role="tab"],[role="button"],a[href]';

/**
 * Collect controls including those inside OPEN shadow roots.
 *
 * `querySelectorAll` stops at a shadow boundary, so a CTA rendered by a web
 * component is invisible to a plain scan — the extension would report "no safe
 * application-surface control" on a page where the button is plainly visible.
 * Closed shadow roots remain unreachable by design; those fall through to the
 * user-gesture path.
 */
function collectControls(root: ParentNode, depth = 0): HTMLElement[] {
  const found = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));
  // Bounded: deeply nested component trees are common, unbounded recursion on a
  // hostile page is not something to invite.
  if (depth >= 5) return found;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const shadow = element.shadowRoot;
    if (shadow) found.push(...collectControls(shadow, depth + 1));
  }
  return found;
}

export function findActivationCandidates(root: ParentNode = document): ActivationCandidate[] {
  const candidates: ActivationCandidate[] = [];
  const controls = collectControls(root);

  for (const el of controls) {
    if (!isVisible(el)) continue;
    // JobPilot's own UI is never page content.
    if (el.closest("#jobpilot-assisted-apply")) continue;
    if (isForbiddenControl(el)) continue;

    const name = normalize(accessibleName(el));
    const description = normalize(el.getAttribute("aria-description") ?? "");
    const role = (el.getAttribute("role") || "").toLowerCase();

    // 1. Strongest: the control states that it switches to the application form.
    //    This is exactly the live Airbnb control ("Switch to application form",
    //    rendered as "Apply Now").
    if (/switch to (the )?application( form)?/.test(name) || /switch to (the )?application( form)?/.test(description)) {
      candidates.push({ element: el, reason: "accessible_name_switches_to_application_form", score: 100 });
      continue;
    }

    // 2. A tab literally named "Application" inside a tablist.
    if (role === "tab" && /^application\b/.test(name)) {
      candidates.push({ element: el, reason: "tab_named_application", score: 80 });
      continue;
    }

    // 3. An approved application phrase.
    //
    // Previously this required BOTH an exact `^apply( now)?$` name AND
    // navigation-like markup, which is why a listing page whose only CTA reads
    // "Apply to this job" produced no candidate at all: the extension sat in
    // "Detecting fields" until it timed out. The phrase list now covers the
    // real wording employers use, and placement — not markup shape — decides
    // between competing controls.
    const phrase = APPLY_PHRASES.find((entry) => entry.pattern.test(name));
    if (!phrase) continue;

    const inMainContent = el.closest(MAIN_CONTENT_SELECTOR) !== null;
    const inChrome = el.closest(CHROME_SELECTOR) !== null;
    const navigational =
      role === "tab" ||
      el.hasAttribute("aria-controls") ||
      (el.getAttribute("href") ?? "").startsWith("#") ||
      el.closest('[role="tablist"]') !== null;

    // A bare "Apply" in site chrome is a header shortcut that may well lead to
    // a different job (or a careers index). Never activate one.
    if (inChrome && !inMainContent) {
      continue;
    }

    // A generic phrase needs corroboration: either it lives in the job's own
    // content, or it behaves like navigation. Without one of those, "Apply Now"
    // could be any marketing button on the page.
    if (!phrase.specific && !inMainContent && !navigational) {
      continue;
    }

    let score = phrase.score;
    let reason = phrase.reason;
    if (inMainContent) {
      score += 10;
      reason = `${reason}_in_main_content`;
    } else if (navigational) {
      // Preserves the original taxonomy for the tablist/anchor case.
      reason = "apply_control_in_tablist_or_anchor";
    }
    if (navigational) {
      // Navigation semantics are strong corroboration for otherwise generic
      // wording (a bare Apply tab/aria-controls relationship).
      score += 10;
    }
    candidates.push({ element: el, reason, score });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Choose the single control to activate.
 *
 * Returns null when the page offers no unambiguous surface control, and when
 * two equally-strong candidates disagree — guessing between them could take the
 * user somewhere they did not ask to go.
 */
export function selectActivationControl(root: ParentNode = document): ActivationCandidate | null {
  const candidates = findActivationCandidates(root);
  if (candidates.length === 0) return null;
  const best = candidates[0];
  // Below this threshold the evidence is too weak for automatic activation;
  // callers may still expose a user-assisted Open application action.
  if (best.score < 65) return null;
  const tied = candidates.filter((candidate) => candidate.score === best.score);
  if (tied.length === 1) return best;

  // A tie is only a real ambiguity when the tied controls would take the user
  // to DIFFERENT places. A job page that renders the same "Apply to this job"
  // button twice — top and bottom of the description, or a duplicate in a
  // sticky bar that also sits inside the main content — is the common case, and
  // treating it as ambiguous returned null, left the page classified as
  // "form still loading", and produced a 30-second poll ending in "the
  // application form did not render in time". That is a bug, not caution.
  //
  // So: compare what the tied controls actually resolve to. Same destination
  // (or, with no destination, the same accessible name) means there is nothing
  // to guess between — take the first in document order. Genuinely different
  // destinations remain ambiguous and still return null.
  const identities = tied.map((candidate) => tiedIdentity(candidate.element));
  const allSame = identities.every((identity) => identity === identities[0]);
  return allSame ? best : null;
}

/**
 * What a tied candidate would DO, for equivalence comparison only.
 *
 * Prefers the resolved navigation target; falls back to the accessible name for
 * controls with no URL (two identical script-driven buttons are equivalent for
 * our purposes — either one opens the same application).
 */
function tiedIdentity(element: HTMLElement): string {
  const anchor =
    element instanceof HTMLAnchorElement && element.hasAttribute("href")
      ? element
      : element.closest("a[href]");
  const href = anchor?.getAttribute("href")?.trim();
  if (href) {
    try {
      return `url:${new URL(href, element.ownerDocument.location?.href ?? "https://invalid.test").toString()}`;
    } catch {
      return `url:${href}`;
    }
  }
  for (const attribute of ["data-url", "data-href", "data-link"]) {
    const value = element.getAttribute(attribute)?.trim();
    if (value) return `url:${value}`;
  }
  return `name:${normalize(accessibleName(element))}`;
}
