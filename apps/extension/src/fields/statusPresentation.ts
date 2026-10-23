/**
 * Extension-owned per-field status presentation.
 *
 * Employer controls are positioning anchors only. Logical status, labels, and
 * decoration DOM stay in this isolated-world module and a closed shadow root.
 * One shared observer/listener set services every marker; records hold targets
 * through WeakRef so detached controls are not retained.
 */

import { OVERLAY_LAYOUT_EVENT, overlayAvoidanceRect } from "../content/applicationOverlay";

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
    mutationObserver = new MutationObserver(schedulePosition);
    mutationObserver.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"]
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

function positionAll(): void {
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
    position(record, target);
  }
  if (records.size === 0) resetLayer();
}

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

const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: DOMRect, pad = 6): boolean =>
  a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

function position(record: DecorationRecord, target: HTMLElement): void {
  const visible = visibleRect(target);
  const avoid = overlayAvoidanceRect(target.ownerDocument);
  // Hidden, scrolled out of its container, or sitting under the assistant: there is nothing to annotate that anyone can see.
  if (!visible || (avoid && overlaps(visible, avoid, 0))) {
    record.badge.hidden = true;
    return;
  }
  record.badge.hidden = false;
  const badgeRect = record.badge.getBoundingClientRect();
  const width = badgeRect.width || 120;
  const height = badgeRect.height || 22;
  const place = (left: number, top: number) => ({
    left: Math.max(4, Math.min(left, innerWidth - width - 4)),
    top: Math.max(4, Math.min(top, innerHeight - height - 4))
  });
  const candidates = [
    place(visible.right + 6, visible.top),                       // beside the control
    place(visible.right - width, visible.top - height - 4),      // above its right edge
    place(visible.left, visible.top - height - 4),               // above its left edge
    place(visible.left, visible.bottom + 4)                      // below it
  ];
  const chosen = candidates.find((c) => {
    const box = { left: c.left, top: c.top, right: c.left + width, bottom: c.top + height };
    return !(avoid && overlaps(box, avoid)) && !(box.left < visible.right && box.right > visible.left && box.top < visible.bottom && box.bottom > visible.top);
  });
  if (!chosen) {
    record.badge.hidden = true;                                   // no clear spot: say nothing rather than cover something
    return;
  }
  record.badge.style.transform = `translate(${Math.round(chosen.left)}px, ${Math.round(chosen.top)}px)`;
}

function render(record: DecorationRecord): void {
  const definition = STATUS[record.status];
  record.badge.style.setProperty("--status-color", definition.color);
  record.badge.setAttribute("aria-label", `XpertApply field status: ${definition.label}`);
  record.badge.innerHTML = `<span class="icon" aria-hidden="true"></span><span class="label"></span>`;
  record.badge.querySelector<HTMLElement>(".icon")!.textContent = definition.icon;
  record.badge.querySelector<HTMLElement>(".label")!.textContent = definition.label;
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
    record = { target: new WeakRef(target), badge, status };
    recordsByTarget.set(target, record);
    records.add(record);
    layer.append(badge);
    resizeObserver?.observe(target);
  } else {
    record.status = status;
  }
  render(record);
  position(record, target);
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
  host = null;
  root = null;
  ownerWindow = null;
  ownerDocument = null;
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
