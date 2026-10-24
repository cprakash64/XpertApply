/**
 * Extension-owned per-field status presentation.
 *
 * Employer controls are positioning anchors only. Logical status, labels, and
 * decoration DOM stay in this isolated-world module and a closed shadow root.
 * One shared observer/listener set services every marker; records hold targets
 * through WeakRef so detached controls are not retained.
 */

import { OVERLAY_LAYOUT_EVENT, STATUS_SUPPRESSED_EVENT, overlayAvoidanceRect } from "../content/applicationOverlay";
import { deepQueryAll } from "../dom/deepDom";
import { chooseBadgePlacement, type Box } from "./badgePlacement";


export type PresentedFieldStatus = "verified" | "generated" | "review" | "invalid";

interface StatusDefinition {
  icon: string;
  label: string;
  color: string;
}

interface DecorationRecord {
  target: WeakRef<HTMLElement>;
  badge: HTMLElement;
  status: PresentedFieldStatus;
  /** Measured while displayed, once per text change. Until then (`sized` false) it is a guess. */
  size: { width: number; height: number };
  sized: boolean;
}

const STATUS: Record<PresentedFieldStatus, StatusDefinition> = {
  verified: { icon: "✓", label: "Verified", color: "#176b46" },
  generated: { icon: "✦", label: "Suggested — review", color: "#255f8f" },
  review: { icon: "!", label: "Needs review", color: "#7a5200" },
  invalid: { icon: "×", label: "Invalid — action required", color: "#a33f2d" }
};

const LAYER_CSS = `
  :host{all:initial;position:fixed;inset:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147482999}
  .status{position:fixed;left:0;top:0;display:flex;align-items:center;gap:4px;max-width:180px;
    padding:3px 7px;border:2px solid currentColor;border-radius:999px;background:#fff;color:var(--status-color);
    box-shadow:0 2px 7px rgba(0,0,0,.16);font:600 11px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    white-space:nowrap;pointer-events:none;user-select:none}
  .status[hidden]{display:none}
  .icon{font-size:13px;line-height:1;font-weight:800}
  @media (forced-colors: active){.status{forced-color-adjust:auto;background:Canvas;color:CanvasText;border-color:CanvasText;box-shadow:none}}
`;

let recordsByTarget = new WeakMap<HTMLElement, DecorationRecord>();
const records = new Set<DecorationRecord>();
let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let ownerWindow: Window | null = null;
let ownerDocument: Document | null = null;
let generation = 0;
let scheduled: { id: number; kind: "animation-frame" | "timeout"; owner: Window; generation: number } | null = null;

function ensureLayer(): ShadowRoot | null {
  if (host?.isConnected && root) return root;
  if (host || root) resetLayer();
  try {
    host = document.createElement("div");
    ownerDocument = document;
    ownerWindow = document.defaultView ?? window;
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${LAYER_CSS}</style>`;
    (document.documentElement || document.body)?.append(host);
    installSharedTracking();
    return root;
  } catch {
    resetLayer();
    return null;
  }
}

function installSharedTracking(): void {
  const view = ownerWindow;
  const doc = ownerDocument;
  if (!view || !doc) return;
  view.addEventListener("resize", schedulePosition, { passive: true });
  doc.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
  if (typeof ResizeObserver !== "undefined") resizeObserver = new ResizeObserver(schedulePosition);
  if (typeof MutationObserver !== "undefined" && doc.documentElement) {
    mutationObserver = new MutationObserver(() => { layerElements = null; schedulePosition(); });
    mutationObserver.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      // aria-expanded: a dropdown opening is the moment a menu starts covering places a badge was fine a moment ago.
      attributeFilter: ["class", "style", "hidden", "aria-expanded"]
    });
  }
  // The assistant opens, minimizes and resizes inside its own shadow root, which none of the observers above can see.
  doc.addEventListener(OVERLAY_LAYOUT_EVENT, schedulePosition);
}

function schedulePosition(): void {
  if (scheduled || !ownerWindow || !host) return;
  const view = ownerWindow;
  const scheduledGeneration = generation;
  const run = (): void => {
    scheduled = null;
    if (generation !== scheduledGeneration || ownerWindow !== view || !host) return;
    positionAll();
  };
  if (typeof view.requestAnimationFrame === "function") {
    const id = view.requestAnimationFrame(run);
    scheduled = { id, kind: "animation-frame", owner: view, generation: scheduledGeneration };
  } else {
    const id = view.setTimeout(run, 0);
    scheduled = { id, kind: "timeout", owner: view, generation: scheduledGeneration };
  }
}

let suppressedCount = 0;
export function suppressedFieldStatusCount(): number { return suppressedCount; }

/** Everything on the employer page a badge must not cover. Read once per layout pass. */
const OBSTACLE_SELECTOR = [
  "input", "select", "textarea", "button", "a[href]", "label", "legend", "h1", "h2", "h3", "h4", "h5", "h6",
  '[role="combobox"]', '[role="listbox"]', '[role="option"]', '[role="menu"]', '[role="menuitem"]', '[role="dialog"]',
  '[role="tooltip"]', '[role="textbox"]', '[role="radio"]', '[role="checkbox"]', '[aria-modal="true"]',
  '[class*="-menu"]', '[class*="__menu"]'
].join(",");
const TEXT_OBSTACLE = /^(LABEL|LEGEND|H[1-6])$/;
const MAX_OBSTACLES = 1500;

/**
 * Fixed and sticky elements (a sticky application header, a cookie bar, a modal backdrop) paint over whatever scrolls beneath them,
 * wherever the page happens to be scrolled. Which elements those are changes only when the DOM does, not on scroll, so the set is
 * found once per DOM change instead of once per frame.
 */
const MAX_LAYER_SCAN = 6000;
let layerElements: WeakRef<HTMLElement>[] | null = null;

function overlayingElements(doc: Document): HTMLElement[] {
  const view = doc.defaultView;
  if (!view) return [];
  if (!layerElements) {
    layerElements = [];
    const all = doc.querySelectorAll<HTMLElement>("body *");
    for (let i = 0; i < all.length && i < MAX_LAYER_SCAN; i++) {
      const element = all[i];
      if (host && (element === host || host.contains(element))) continue;
      const position = view.getComputedStyle(element).position;
      if (position === "fixed" || position === "sticky") layerElements.push(new WeakRef(element));
    }
  }
  return layerElements.map((ref) => ref.deref()).filter((element): element is HTMLElement => Boolean(element?.isConnected));
}

function collectObstacles(doc: Document): { boxes: Box[]; layers: Array<{ element: HTMLElement; box: Box }> } {
  const view = doc.defaultView;
  if (!view) return { boxes: [], layers: [] };
  const out: Box[] = [];
  const layers: Array<{ element: HTMLElement; box: Box }> = [];
  const width = view.innerWidth, height = view.innerHeight;
  for (const layer of overlayingElements(doc)) {
    const r = layer.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > width || r.top > height) continue;
    layers.push({ element: layer, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
  }
  const elements = deepQueryAll<HTMLElement>(doc, OBSTACLE_SELECTOR);
  for (const element of elements.slice(0, MAX_OBSTACLES)) {
    if (host && (element === host || host.contains(element))) continue;
    let rects: DOMRectList | DOMRect[];
    if (TEXT_OBSTACLE.test(element.tagName) && typeof doc.createRange === "function") {
      // A label's box is usually as wide as the form; only the text itself is something a badge could hide.
      const range = doc.createRange();
      range.selectNodeContents(element);
      rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [element.getBoundingClientRect()];
    } else {
      rects = [element.getBoundingClientRect()];
    }
    for (const r of rects) {
      if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > width || r.top > height) continue;
      out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return { boxes: out, layers };
}

function positionAll(): void {
  const live: Array<{ record: DecorationRecord; target: HTMLElement }> = [];
  for (const record of [...records]) {
    const target = record.target.deref();
    if (!target?.isConnected) {
      if (target) {
        resizeObserver?.unobserve(target);
        recordsByTarget.delete(target);
      }
      record.badge.remove();
      records.delete(record);
      continue;
    }
    live.push({ record, target });
  }
  if (records.size === 0) {
    resetLayer();
    return;
  }
  // A badge can only be measured while it is displayed. Show the unmeasured ones, take every measurement in one layout, and let the
  // decisions below hide again whatever has no place (nothing paints in between).
  for (const { record } of live) if (!record.sized) record.badge.hidden = false;
  for (const { record } of live) {
    if (record.sized) continue;
    const rect = record.badge.getBoundingClientRect();
    if (rect.width > 0) record.size = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    record.sized = true;
  }
  // Read everything first, write after: one layout, however many badges there are.
  const doc = ownerDocument ?? document;
  const avoid = overlayAvoidanceRect(doc);
  const { boxes: obstacles, layers } = collectObstacles(doc);
  if (avoid) obstacles.push({ left: avoid.left, top: avoid.top, right: avoid.right, bottom: avoid.bottom });
  const measured = live.map(({ record, target }) => {
    const anchor = anchorFor(target);
    const visible = visibleRect(anchor);
    return { record, target, anchor, visible: visible && isOccluded(anchor, visible, doc) ? null : visible };
  })
    // Reading order, so which badge wins a contested spot never depends on the order fields were filled in.
    .sort((a, b) => (a.visible?.top ?? 0) - (b.visible?.top ?? 0) || (a.visible?.left ?? 0) - (b.visible?.left ?? 0));
  const placed: Box[] = [];
  const decisions: Array<{ record: DecorationRecord; at: { left: number; top: number } | null }> = [];
  let suppressed = 0;
  for (const { record, anchor, visible } of measured) {
    // Hidden, scrolled out of its container, or wholly under the assistant: nothing anyone can see to annotate, so nothing is withheld.
    // A field the assistant only partly covers is still annotated, on the side the assistant does not cover.
    if (!visible || (avoid && boxInside(visible, avoid))) {
      decisions.push({ record, at: null });
      continue;
    }
    const at = chooseBadgePlacement({
      target: visible,
      size: record.size,
      viewport: { width: doc.defaultView?.innerWidth ?? innerWidth, height: doc.defaultView?.innerHeight ?? innerHeight },
      // A fixed or sticky ancestor of the field is where the field lives, not something over it.
      obstacles: [...obstacles, ...layers.filter((layer) => !layer.element.contains(anchor)).map((layer) => layer.box)],
      placed
    });
    if (at) placed.push({ left: at.left, top: at.top, right: at.left + record.size.width, bottom: at.top + record.size.height });
    else suppressed += 1;
    decisions.push({ record, at });
  }
  for (const { record, at } of decisions) {
    record.badge.hidden = at === null;
    if (at) record.badge.style.transform = `translate(${Math.round(at.left)}px, ${Math.round(at.top)}px)`;
  }
  if (suppressed !== suppressedCount) {
    suppressedCount = suppressed;
    doc.dispatchEvent(new CustomEvent(STATUS_SUPPRESSED_EVENT, { detail: { count: suppressed } }));
  }
}

/**
 * What a person sees as "the field". A custom dropdown's focusable input (React Select's) is a few pixels wide inside a much larger
 * control, and an input hidden for custom styling has no box at all; annotating those by their own rect puts the badge on top of the
 * visible control. Anchor to the visible control instead.
 */
function anchorFor(target: HTMLElement): HTMLElement {
  const own = target.getBoundingClientRect();
  const comboLike = (target.getAttribute("role") || "").toLowerCase() === "combobox" || target.hasAttribute("aria-autocomplete");
  if (!comboLike && own.width >= 24 && own.height >= 12) return target;
  const wrapper = target.closest<HTMLElement>('[class*="-control"],[class*="__control"],[role="combobox"]');
  if (wrapper && wrapper !== target) return wrapper;
  if (own.width < 8 || own.height < 8) {
    const label = target.closest<HTMLElement>("label");
    if (label) return label;
  }
  return target;
}

/** Is something other than the field (a sticky header, a modal backdrop) painted over its middle? Then there is nothing to annotate. */
function isOccluded(anchor: HTMLElement, visible: Box, doc: Document): boolean {
  if (typeof doc.elementFromPoint !== "function") return false;
  const hit = doc.elementFromPoint((visible.left + visible.right) / 2, (visible.top + visible.bottom) / 2);
  if (!hit || hit === anchor) return false;
  return !(anchor.contains(hit) || hit.contains(anchor) || (host !== null && host.contains(hit)));
}

const boxInside = (inner: Box, outer: DOMRect): boolean => inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;

/** The part of `element` a person can actually see: its box clipped by every scrolling or clipping ancestor and the viewport. */
function visibleRect(element: HTMLElement): { left: number; top: number; right: number; bottom: number } | null {
  const own = element.getBoundingClientRect();
  let left = Math.max(own.left, 0), top = Math.max(own.top, 0);
  let right = Math.min(own.right, innerWidth), bottom = Math.min(own.bottom, innerHeight);
  const view = element.ownerDocument.defaultView;
  for (let node = element.parentElement; node && view; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === "contents") continue;
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
      const r = node.getBoundingClientRect();
      left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
    }
  }
  return right - left > 1 && bottom - top > 1 ? { left, top, right, bottom } : null;
}

function render(record: DecorationRecord): void {
  const definition = STATUS[record.status];
  record.badge.style.setProperty("--status-color", definition.color);
  record.badge.setAttribute("aria-label", `XpertApply field status: ${definition.label}`);
  record.badge.innerHTML = `<span class="icon" aria-hidden="true"></span><span class="label"></span>`;
  record.badge.querySelector<HTMLElement>(".icon")!.textContent = definition.icon;
  record.badge.querySelector<HTMLElement>(".label")!.textContent = definition.label;
  record.sized = false;
}

export function presentFieldStatus(target: HTMLElement, status: PresentedFieldStatus): void {
  const layer = ensureLayer();
  if (!layer) return;
  let record = recordsByTarget.get(target);
  if (!record) {
    const badge = document.createElement("div");
    badge.className = "status";
    // Static semantics avoid creating one implicit live region per field. The
    // existing widget owns announcements; these notes provide a programmatic,
    // non-color equivalent without worsening XA-16.
    badge.setAttribute("role", "note");
    // Shown only once a layout pass has found it a spot that covers nothing.
    badge.hidden = true;
    record = { target: new WeakRef(target), badge, status, size: { width: 120, height: 22 }, sized: false };
    recordsByTarget.set(target, record);
    records.add(record);
    layer.append(badge);
    resizeObserver?.observe(target);
  } else {
    record.status = status;
  }
  render(record);
  schedulePosition();
}

export function removeFieldStatus(target: HTMLElement): void {
  const record = recordsByTarget.get(target);
  if (!record) return;
  resizeObserver?.unobserve(target);
  record.badge.remove();
  records.delete(record);
  recordsByTarget.delete(target);
  if (records.size === 0) resetLayer();
}

function resetLayer(): void {
  generation += 1;
  layerElements = null;
  const pending = scheduled;
  scheduled = null;
  if (pending) {
    if (pending.kind === "animation-frame") pending.owner.cancelAnimationFrame(pending.id);
    else pending.owner.clearTimeout(pending.id);
  }
  ownerWindow?.removeEventListener("resize", schedulePosition);
  ownerDocument?.removeEventListener("scroll", schedulePosition, true);
  ownerDocument?.removeEventListener(OVERLAY_LAYOUT_EVENT, schedulePosition);
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  resizeObserver = null;
  mutationObserver = null;
  host?.remove();
  for (const record of records) record.badge.remove();
  records.clear();
  recordsByTarget = new WeakMap<HTMLElement, DecorationRecord>();
  const doc = ownerDocument;
  host = null;
  root = null;
  ownerWindow = null;
  ownerDocument = null;
  if (suppressedCount !== 0) {
    suppressedCount = 0;
    doc?.dispatchEvent(new CustomEvent(STATUS_SUPPRESSED_EVENT, { detail: { count: 0 } }));
  }
}

/** Explicitly end this module's presentation lifecycle. Safe to call more than once. */
export function resetFieldStatusPresentation(): void {
  resetLayer();
}

/** Isolated diagnostics for unit tests; never bridged to page JavaScript. */
export function fieldStatusPresentationForTest(target: HTMLElement): {
  status: PresentedFieldStatus;
  text: string;
  role: string | null;
  ariaLabel: string | null;
  hidden: boolean;
  transform: string;
} | null {
  const record = recordsByTarget.get(target);
  return record ? {
    status: record.status,
    text: record.badge.textContent ?? "",
    role: record.badge.getAttribute("role"),
    ariaLabel: record.badge.getAttribute("aria-label"),
    hidden: record.badge.hidden !== false,
    transform: record.badge.style.transform
  } : null;
}

export function fieldStatusPresentationCssForTest(): string {
  return LAYER_CSS;
}
