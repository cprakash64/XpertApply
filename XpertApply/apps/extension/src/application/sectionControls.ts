/**
 * Associating a "+ Add" control with the section it belongs to.
 *
 * A long application page has many Add controls whose visible text is
 * identical. Choosing one by text alone is how an internship ends up in the
 * awards list, or how an unrelated "Add attachment" gets clicked. So the
 * control is always resolved through its SECTION: find the heading, take the
 * container that heading governs, and use only Add controls inside it.
 *
 * Nothing here clicks anything. It answers "which element, and is it safe?",
 * which keeps the decision unit-testable without a browser.
 */

import {
  deepAccessibleName,
  deepContains,
  deepParentElement,
  deepQuery,
  deepQueryAll,
  deepTextContent,
  scopedElementById
} from "../dom/deepDom";
import type { SectionEnum } from "./sectionData";

export interface SectionMatch {
  section: SectionEnum;
  heading: HTMLElement;
  container: HTMLElement;
  /** How the container was derived, for diagnostics. */
  reason: "aria_controls" | "labelledby" | "heading_ancestor" | "heading_siblings";
}

/**
 * Heading text that identifies each section. Anchored so "Project Experience"
 * cannot be matched by a paragraph that merely mentions projects.
 */
const SECTION_HEADINGS: { section: SectionEnum; patterns: RegExp[] }[] = [
  // Ordered most specific first: "Project Experience" and "Internship
  // Experience" must never be classified as the general work-experience
  // section, which is why those patterns are tested before it.
  { section: "internship_experience", patterns: [/^internship experience$/i, /^internships?$/i, /^internship\/co-?op experience$/i] },
  { section: "project_experience", patterns: [/^project experience$/i, /^projects?$/i] },
  { section: "work_samples", patterns: [/^work samples?$/i, /^portfolio$/i] },
  { section: "honors_awards", patterns: [/^honou?rs and awards$/i, /^honou?rs? ?& ?awards$/i, /^awards?$/i] },
  { section: "language_skills", patterns: [/^language skills?$/i, /^languages?$/i] },
  { section: "self_introduction", patterns: [/^self[- ]introduction$/i, /^about (me|yourself)$/i, /^personal statement$/i] },
  { section: "sns", patterns: [/^sns$/i, /^social (media|networks?|links?)$/i, /^social ?networking ?services?$/i] },
  // The two sections nearly every application has. Their absence here is why a
  // fully-populated Experience and Education history was never offered to
  // SmartRecruiters, TikTok, or anything else: the engine could not name them.
  {
    section: "work_experience",
    patterns: [
      /^(work|professional|relevant|employment)?\s*experience$/i,
      /^employment( history)?$/i,
      /^work history$/i,
      /^career history$/i
    ]
  },
  {
    section: "education",
    patterns: [
      /^education$/i,
      /^education (and|&) training$/i,
      /^academic (background|history|qualifications)$/i,
      /^educational background$/i
    ]
  }
];

const HEADING_SELECTOR = [
  "h1", "h2", "h3", "h4", "h5", "h6", "legend", "[role=heading]",
  // Design systems label their section titles rather than using heading tags.
  '[data-test*="section-title" i]',
  '[data-testid*="section-title" i]',
  '[class*="section-title" i]',
  '[class*="section-heading" i]'
].join(",");

/**
 * Custom elements that ARE a section title.
 *
 * SmartRecruiters renders every section title as
 * `<spl-typography-title data-test="section-title">Experience</spl-typography-title>`
 * — not a heading tag, no `role="heading"`. With only the standard selector,
 * `findSections` returned nothing at all on the live page and neither Experience
 * nor Education could be expanded.
 */
const CUSTOM_TITLE_TAG = /(^|-)(title|heading|header|headline)s?$/;

/**
 * Heading candidates, with a bounded fallback for web-component titles.
 *
 * The sweep runs ONLY when no standard heading names a section we know, so an
 * ordinary ATS page never pays for it.
 */
function headingCandidates(root: ParentNode): HTMLElement[] {
  const standard = deepQueryAll<HTMLElement>(root, HEADING_SELECTOR);
  if (standard.some((element) => classifySectionHeading(headingText(element)) !== null)) return standard;
  const custom = deepQueryAll<HTMLElement>(root, "*").filter(
    (element) => CUSTOM_TITLE_TAG.test(element.localName) && element.childElementCount === 0
  );
  return custom.length > 0 ? [...standard, ...custom] : standard;
}

/** Text of an element without its nested controls' labels. */
function headingText(element: Element): string {
  const own = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  // A heading rendered through a web component projects its text into a slot,
  // so `textContent` on the host is empty and only a deep read finds it.
  return own || deepTextContent(element, 200).replace(/\s+/g, " ").trim();
}

/** An attribute from this element or the component host above it. */
function hostAttribute(element: Element, name: string): string {
  let node: Element | null = element;
  for (let hops = 0; node && hops < 4; hops += 1) {
    const value = node.getAttribute(name);
    if (value?.trim()) return value;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return "";
}

export function classifySectionHeading(text: string): SectionEnum | null {
  const normalized = text.replace(/[*:•]+\s*$/, "").trim();
  for (const entry of SECTION_HEADINGS) {
    if (entry.patterns.some((pattern) => pattern.test(normalized))) return entry.section;
  }
  return null;
}

/**
 * Find every section we know how to fill.
 *
 * Container resolution, most reliable first:
 *  1. the heading's `aria-controls` target
 *  2. an element that points back at the heading via `aria-labelledby`
 *  3. the nearest section-like ancestor that contains no OTHER known heading
 *  4. the heading's following siblings, up to the next known heading
 *
 * Step 3's "contains no other known heading" check is what stops a wrapper that
 * holds every section from being treated as one section.
 */
export function findSections(root: ParentNode = document): SectionMatch[] {
  // Shadow-piercing: a section heading rendered by a web component is invisible
  // to a light-DOM query, and so is its Add control.
  const headings = headingCandidates(root);
  // Scanned ONCE and reused for every container walk below. Re-deriving it per
  // ancestor level turned one page scan into dozens on a web-component page.
  const known = headings.filter((element) => classifySectionHeading(headingText(element)) !== null);
  const matches: SectionMatch[] = [];

  for (const heading of headings) {
    const section = classifySectionHeading(headingText(heading));
    if (!section) continue;

    const controls = heading.getAttribute("aria-controls");
    if (controls) {
      const target = scopedElementById(heading, controls);
      if (target) {
        matches.push({ section, heading, container: target, reason: "aria_controls" });
        continue;
      }
    }

    if (heading.id) {
      const labelled = deepQuery<HTMLElement>(root, `[aria-labelledby~="${cssEscape(heading.id)}"]`);
      if (labelled) {
        matches.push({ section, heading, container: labelled, reason: "labelledby" });
        continue;
      }
    }

    const ancestor = nearestExclusiveAncestor(heading, known);
    if (ancestor) {
      matches.push({ section, heading, container: ancestor, reason: "heading_ancestor" });
      continue;
    }

    matches.push({
      section,
      heading,
      container: syntheticSiblingContainer(heading),
      reason: "heading_siblings"
    });
  }

  return matches;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Walk up from the heading to the largest container that still governs only
 * THIS heading. Stops as soon as another known section heading is inside.
 */
function nearestExclusiveAncestor(heading: HTMLElement, known: HTMLElement[]): HTMLElement | null {
  let current: HTMLElement | null = deepParentElement(heading);
  let best: HTMLElement | null = null;
  let depth = 0;
  while (current && depth < 8) {
    // `<body>`/`<html>` are the page, not a section. A page with exactly one
    // recognised heading would otherwise climb all the way to the document and
    // treat every control on it — and every word of text — as this section's.
    if (isPageRoot(current)) break;
    const inside = known.filter((candidate) => deepContains(current!, candidate));
    if (inside.length !== 1 || inside[0] !== heading) break;
    best = current;
    current = deepParentElement(current);
    depth += 1;
  }
  return best;
}

function isPageRoot(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  return tag === "BODY" || tag === "HTML";
}

/**
 * Fallback for flat DOM: a detached wrapper holding the heading's following
 * siblings up to the next known heading. Never inserted into the page — it only
 * scopes queries.
 */
function syntheticSiblingContainer(heading: HTMLElement): HTMLElement {
  const wrapper = heading.ownerDocument.createElement("div");
  let sibling = heading.nextElementSibling;
  while (sibling) {
    const isHeading = (sibling.matches(HEADING_SELECTOR) || CUSTOM_TITLE_TAG.test(sibling.localName))
      && classifySectionHeading(headingText(sibling)) !== null;
    if (isHeading) break;
    wrapper.appendChild(sibling.cloneNode(false));
    // Keep a live reference so callers can still interact with the real node.
    (wrapper.lastElementChild as HTMLElement & { __live?: Element }).__live = sibling;
    sibling = sibling.nextElementSibling;
  }
  return wrapper;
}

// --------------------------------------------------------------------------- //
// Add controls
// --------------------------------------------------------------------------- //
const ADD_PATTERNS = [/^\+?\s*add\b/i, /^add (another|more|entry|item)\b/i, /^\+$/];

/**
 * Controls that must never be activated while filling a section, whatever
 * their position. Checked against the accessible name AND the element's own
 * attributes, so a styled icon button cannot slip through on empty text.
 */
const FORBIDDEN_CONTROL_PATTERNS = [
  /\bsubmit\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bclear\b/i,
  /\bwithdraw\b/i,
  /\bcancel application\b/i,
  /\bsign\s*(in|up)\b/i,
  /\bagree\b/i,
  /\bconsent\b/i,
  /\baccept\b/i,
  /\badd another application\b/i
];

/**
 * The control's name, continuing into its component host.
 *
 * A `<spl-button aria-label="Add experience entry">` renders an empty
 * `<button><slot></slot></button>` in its shadow root: the inner button — the
 * element a deep query finds — has no name of its own, so every name-based rule
 * silently skipped it and no section could ever be expanded.
 */
function accessibleName(element: Element): string {
  return deepAccessibleName(element);
}

export function isForbiddenControl(element: Element): boolean {
  const haystack = [
    accessibleName(element),
    hostAttribute(element, "data-test"),
    hostAttribute(element, "aria-label"),
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("title") ?? "",
    element.getAttribute("name") ?? "",
    element.getAttribute("data-testid") ?? "",
    element.id
  ].join(" ");
  return FORBIDDEN_CONTROL_PATTERNS.some((pattern) => pattern.test(haystack));
}

function isInteractable(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
  return true;
}

/**
 * The Add control for one section, or null.
 *
 * Scoped to the section's own container, so the section enum is decided BEFORE
 * any element is considered — the association never runs the other way round.
 * Returns null on ambiguity rather than picking one.
 */
export function findAddControl(match: SectionMatch): HTMLElement | null {
  const scope = match.container;
  const candidates = dedupeByHost(
    deepQueryAll<HTMLElement>(scope, 'button,[role="button"],a[href],[data-action="add"]')
  ).filter((element) => {
    if (!isInteractable(element)) return false;
    if (isForbiddenControl(element)) return false;
    const name = accessibleName(element);
    return ADD_PATTERNS.some((pattern) => pattern.test(name));
  });

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    // Prefer one that names the section ("Add project"); otherwise refuse.
    const named = candidates.filter((element) =>
      new RegExp(match.section.split("_")[0], "i").test(accessibleName(element))
    );
    if (named.length === 1) return named[0];
    return null;
  }
  return candidates[0];
}

/** Guard for the caller: confirm the resolved control really sits in the
 * section it claims, immediately before activating it. */
export function controlBelongsToSection(control: HTMLElement, match: SectionMatch): boolean {
  if (isForbiddenControl(control)) return false;
  return deepContains(match.container, control);
}

/**
 * Collapse a component and its inner implementation button to ONE candidate.
 *
 * A deep query returns both `<spl-button>`'s host (when it matches a selector)
 * and the real `<button>` inside its shadow root. Two candidates for one control
 * reads as ambiguity, and `findAddControl` refuses to guess on ambiguity — so
 * the section would never expand. The innermost element is kept, because that is
 * the one that actually handles the click.
 */
function dedupeByHost(elements: HTMLElement[]): HTMLElement[] {
  return elements.filter((element) => !elements.some((other) => other !== element && deepContains(element, other)));
}
