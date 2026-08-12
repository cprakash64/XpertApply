/**
 * DOM traversal that does not stop at an open shadow boundary.
 *
 * The live failure this exists to fix
 * ----------------------------------
 * ServiceNow's application is SmartRecruiters "Easy Apply", served from
 * `jobs.smartrecruiters.com/oneclick-ui/...`. Every applicant control on that
 * page is a Lit web component (`spl-input`, `spl-textarea`, `spl-autocomplete`,
 * `spl-phone-field`, `spl-dropzone`) whose real `<input>` lives inside an OPEN
 * shadow root:
 *
 *     <spl-input id="first-name-input" label="First name" required>
 *       #shadow-root (open)
 *         <label for="first-name-input">First name *</label>
 *         <input id="first-name-input" autocomplete="given-name" aria-required="true">
 *
 * `document.querySelectorAll("input,textarea,select")` returns ZERO on that
 * page, and `document.body.innerText` contains no field labels at all. Every
 * layer of XpertApply that asked the document a question therefore answered
 * "there is no application here":
 *
 *   • field discovery found no controls;
 *   • the form-root resolver scored every candidate at 0 fields;
 *   • readiness evidence saw 0 applicant controls and no name/email labels;
 *   • the frame probe reported no application labels.
 *
 * The 20-second readiness wait then expired and, because ONE unrelated
 * `about:blank` iframe (the LinkedIn `@linkedin/xdoor-sdk` tracking frame, whose
 * `contentDocument` is null) counted as "an unreadable frame", the failure was
 * reported as
 *
 *     "XpertApply could not reach the embedded application form."
 *
 * That sentence named a cross-origin frame problem that does not exist. The
 * application was in the same document the whole time, one shadow boundary away.
 *
 * What this module guarantees
 * ---------------------------
 * `querySelectorAll`, `closest`, `getElementById` and `textContent` all stop at
 * a shadow boundary by design. Every helper here is the shadow-piercing
 * equivalent, and they are the ONLY way the rest of the extension is allowed to
 * ask "what controls are on this page?".
 *
 * Closed shadow roots stay unreachable — `element.shadowRoot` is null for them
 * and no API changes that. They are reported as a limitation (see
 * `deepQueryAll`'s `truncated` sibling `collectRoots`) rather than silently
 * treated as empty.
 *
 * Budgets, not unbounded recursion: a hostile or merely enormous page (the
 * SmartRecruiters phone-country picker alone mounts ~245 option components, each
 * with its own nested shadow roots) must never turn a rescan into a hang.
 */

/** How deep to follow nested shadow roots. SmartRecruiters needs 3; 12 is slack. */
export const MAX_SHADOW_DEPTH = 12;
/** Upper bound on hosts inspected per traversal. Exceeded => partial result. */
export const MAX_SHADOW_HOSTS = 6_000;

export interface RootCollection {
  /** The starting root plus every reachable open shadow root, in tree order. */
  roots: ParentNode[];
  /** Open shadow hosts found. */
  hostCount: number;
  /** True when a budget stopped the walk before it finished. */
  truncated: boolean;
}

function shadowRootOf(element: Element): ShadowRoot | null {
  try {
    // A page can define a getter that throws; a hostile one must not break a scan.
    return (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
  } catch {
    return null;
  }
}

/**
 * The starting root plus every OPEN shadow root reachable from it.
 *
 * Breadth-first by depth so the shallowest (and most likely relevant) trees are
 * collected first when a budget cuts the walk short.
 */
export function collectRoots(
  root: ParentNode,
  maxDepth = MAX_SHADOW_DEPTH,
  maxHosts = MAX_SHADOW_HOSTS
): RootCollection {
  const roots: ParentNode[] = [root];
  let hostCount = 0;
  let truncated = false;
  let frontier: ParentNode[] = [root];

  // The root's OWN shadow root counts. `element.querySelectorAll("*")` returns
  // light descendants only, so starting the walk from the element itself found
  // the shadow roots of its children but never its own — and every deep query
  // rooted AT a component host (`deepQuery(splInput, "input")`) came back empty.
  // That is the common case: the host is exactly the element callers hold.
  const ownShadow = root instanceof Element ? shadowRootOf(root) : null;
  if (ownShadow) {
    hostCount += 1;
    roots.push(ownShadow);
    frontier.push(ownShadow);
  }

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: ParentNode[] = [];
    for (const current of frontier) {
      let elements: Element[];
      try {
        elements = Array.from(current.querySelectorAll("*"));
      } catch {
        continue;
      }
      for (const element of elements) {
        const shadow = shadowRootOf(element);
        if (!shadow) continue;
        hostCount += 1;
        if (hostCount > maxHosts) {
          truncated = true;
          return { roots, hostCount, truncated };
        }
        roots.push(shadow);
        next.push(shadow);
      }
    }
    frontier = next;
    if (frontier.length > 0 && depth === maxDepth - 1) truncated = true;
  }

  return { roots, hostCount, truncated };
}

/**
 * `querySelectorAll` across the light DOM and every open shadow root.
 *
 * Results are de-duplicated (a slotted element is reachable from more than one
 * root) and ordered by root, shallowest first.
 */
export function deepQueryAll<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
  maxDepth = MAX_SHADOW_DEPTH
): T[] {
  const { roots } = collectRoots(root, maxDepth);
  if (roots.length === 1) {
    // The overwhelmingly common case: no shadow DOM at all. Take the native path
    // so an ordinary ATS page pays nothing for this.
    try {
      return Array.from(root.querySelectorAll<T>(selector));
    } catch {
      return [];
    }
  }
  const seen = new Set<Element>();
  const out: T[] = [];
  for (const current of roots) {
    let matches: T[];
    try {
      matches = Array.from(current.querySelectorAll<T>(selector));
    } catch {
      continue;
    }
    for (const match of matches) {
      if (seen.has(match)) continue;
      seen.add(match);
      out.push(match);
    }
  }
  return out;
}

/** First match across the light DOM and every open shadow root, or null. */
export function deepQuery<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
  maxDepth = MAX_SHADOW_DEPTH
): T | null {
  return deepQueryAll<T>(root, selector, maxDepth)[0] ?? null;
}

/** The node tree this element belongs to: its shadow root, or its document. */
export function rootNodeOf(element: Node): Document | ShadowRoot {
  try {
    const root = element.getRootNode();
    if (root instanceof ShadowRoot || root instanceof Document) return root;
  } catch {
    /* fall through */
  }
  return element.ownerDocument ?? document;
}

/**
 * The element's parent, crossing OUT of a shadow root to its host.
 *
 * `parentElement` is null on a shadow root's top-level child, which silently
 * ended every ancestor walk (visibility, section heading, required markers) one
 * step inside the component instead of at the page.
 */
export function deepParentElement(element: Element): HTMLElement | null {
  const parent = element.parentElement;
  if (parent) return parent;
  const root = rootNodeOf(element);
  return root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
}

/**
 * `closest`, continuing through shadow hosts.
 *
 * Native `closest` stops at the shadow root, so an input inside `spl-input`
 * could never see that it sits inside `<nav>` (exclusion), inside a `<fieldset>`
 * (legend labelling), or inside the resolved application root.
 */
export function deepClosest<T extends Element = HTMLElement>(
  element: Element,
  selector: string
): T | null {
  let node: Element | null = element;
  let hops = 0;
  while (node && hops < MAX_SHADOW_DEPTH + 1) {
    let found: T | null = null;
    try {
      found = node.closest<T>(selector);
    } catch {
      return null;
    }
    if (found) return found;
    const root = rootNodeOf(node);
    node = root instanceof ShadowRoot ? root.host : null;
    hops += 1;
  }
  return null;
}

/**
 * Does `container` contain `element`, counting shadow boundaries as containment?
 *
 * `Node.contains` returns false for a control inside a descendant's shadow root,
 * which would make "is this field inside the application root?" answer no for
 * every SmartRecruiters control.
 */
export function deepContains(container: Node, element: Node): boolean {
  if (container === element) return true;
  let node: Node | null = element;
  let hops = 0;
  while (node && hops < MAX_SHADOW_DEPTH + 2) {
    try {
      if (container.contains(node)) return true;
    } catch {
      return false;
    }
    const root = rootNodeOf(node);
    node = root instanceof ShadowRoot ? root.host : null;
    hops += 1;
  }
  return false;
}

/**
 * `getElementById` scoped to the element's OWN tree first.
 *
 * `label[for=…]` / `aria-labelledby` / `aria-controls` reference ids that are
 * scoped to the shadow root, not the document — SmartRecruiters reuses
 * `first-name-input` as both the host id and the inner input id, and only the
 * shadow-scoped lookup finds the right label.
 */
export function scopedElementById(element: Element, id: string): HTMLElement | null {
  if (!id) return null;
  for (const root of ownAndAncestorRoots(element)) {
    const found = (root as Document | ShadowRoot).getElementById?.(id) ?? null;
    if (found) return found as HTMLElement;
  }
  return element.ownerDocument?.getElementById(id) ?? null;
}

/** `querySelector` scoped to the element's own tree, then its ancestors', then the document. */
export function scopedQuery<T extends Element = HTMLElement>(
  element: Element,
  selector: string
): T | null {
  for (const root of ownAndAncestorRoots(element)) {
    try {
      const found = (root as ParentNode).querySelector<T>(selector);
      if (found) return found;
    } catch {
      return null;
    }
  }
  try {
    return element.ownerDocument?.querySelector<T>(selector) ?? null;
  } catch {
    return null;
  }
}

/**
 * The element's own tree and every shadow root ABOVE it, innermost first.
 *
 * The ancestor roots are the part that was missing, and it is not an edge case:
 * a composed component keeps its popup in ITS shadow root while the input that
 * declares `aria-controls` lives one root deeper. SmartRecruiters' City field is
 * exactly that —
 *
 *     <spl-autocomplete>                     ← owns #menu-… (the listbox)
 *       #shadow-root
 *         <spl-input>                        ← owns the <input aria-controls="menu-…">
 *           #shadow-root
 *             <input role="combobox" aria-controls="menu-…">
 *
 * — so resolving the id in the input's own root and then the document skipped
 * the one tree that actually holds the menu, and the City suggestions could
 * never be read.
 */
function ownAndAncestorRoots(element: Element): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [];
  let node: Element | null = element;
  for (let hops = 0; node && hops <= MAX_SHADOW_DEPTH; hops += 1) {
    const root = rootNodeOf(node);
    roots.push(root);
    if (!(root instanceof ShadowRoot)) break;
    node = root.host;
  }
  return roots;
}

/**
 * Text of a subtree INCLUDING open shadow content.
 *
 * `textContent`/`innerText` skip shadow roots entirely, which is why the live
 * SmartRecruiters page reported no "first name", no "email" and no "phone" — the
 * exact labels the application-evidence rules look for.
 */
export function deepTextContent(root: ParentNode, capChars = 40_000): string {
  const { roots } = collectRoots(root);
  const parts: string[] = [];
  let length = 0;
  for (const current of roots) {
    for (const text of visibleTextOf(current)) {
      parts.push(text);
      length += text.length + 1;
      if (length >= capChars) return parts.join(" ").slice(0, capChars);
    }
  }
  return parts.join(" ").slice(0, capChars);
}

/** Tags whose contents are source code or inert markup, never page text. */
const NON_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);

/**
 * Text nodes of one tree, skipping script and style source.
 *
 * `textContent` on a document (or on `<html>`) returns every inline script's
 * SOURCE first. With a length cap, that source alone can fill the whole budget —
 * so a search for a value that is plainly rendered on the page finds nothing.
 * That is not hypothetical: it made a saved record verify as missing on a page
 * carrying one large inline script.
 */
function visibleTextOf(root: ParentNode): string[] {
  const doc = (root as Element).ownerDocument ?? (root as Document);
  const out: string[] = [];
  let walker: TreeWalker;
  try {
    walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node) {
        const parent = node.parentElement;
        if (parent && NON_TEXT_TAGS.has(parent.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
  } catch {
    return [];
  }
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (text) out.push(text);
  }
  return out;
}

/** How many open shadow hosts this subtree contains. Diagnostics only. */
export function openShadowHostCount(root: ParentNode): number {
  return collectRoots(root).hostCount;
}

/**
 * The accessible name of a control, continuing into its component host.
 *
 * A web-component button renders a real `<button>` inside its shadow root and
 * projects its label through a `<slot>`. The inner button therefore has an
 * EMPTY `textContent` and no `aria-label` — every name-based rule ("is this the
 * Add control?", "is this the Save control?", "is this forbidden?") saw nothing
 * and skipped it. SmartRecruiters' section controls are exactly this shape:
 *
 *     <spl-button aria-label="Save experience entry"><span>Save</span></spl-button>
 *       #shadow-root (open)
 *         <button><slot></slot></button>
 *
 * So the name is resolved on the element first and then, only if still empty,
 * on the hosts above it. Walking up stops at the first host that names itself,
 * which keeps a control from borrowing a distant ancestor's label.
 */
export function deepAccessibleName(element: Element): string {
  const own = ownAccessibleName(element);
  if (own) return own;
  let node: Element | null = element;
  for (let hops = 0; hops < 4; hops += 1) {
    const root = rootNodeOf(node);
    if (!(root instanceof ShadowRoot)) return "";
    node = root.host;
    const hosted = ownAccessibleName(node);
    if (hosted) return hosted;
  }
  return "";
}

function ownAccessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => scopedElementById(element, id)?.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  }
  const label = element.getAttribute("aria-label");
  if (label?.trim()) return label.trim();
  const title = element.getAttribute("title");
  if (title?.trim()) return title.trim();
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The nearest heading ABOVE this element, crossing shadow boundaries.
 *
 * The question it answers is "which section of the page is this control in?",
 * for controls whose own markup says nothing. Two SmartRecruiters file inputs
 * are byte-identical — same id, same `accept` list — and only the heading above
 * them ("Easy Apply" vs "Resume") distinguishes the resume-parsing dropzone
 * from the actual resume attachment.
 */
export function nearestHeadingText(
  element: Element,
  selector = "h1,h2,h3,h4,h5,h6,legend,[role=heading]"
): string {
  let node: Element | null = element;
  for (let hops = 0; node && hops < MAX_SHADOW_DEPTH; hops += 1) {
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.matches(selector)) {
        const text = (sibling.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) return text;
      }
      // A heading wrapped in its own container is still this section's heading.
      const nested = sibling.querySelector(selector);
      const nestedText = (nested?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (nestedText) return nestedText;
    }
    node = deepParentElement(node);
  }
  return "";
}
