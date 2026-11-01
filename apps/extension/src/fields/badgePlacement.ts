/**
 * Pure geometry for field-status badges.
 *
 * A badge is only ever worth showing where it covers nothing the applicant needs: not the control it annotates, not any other
 * control or open menu, not a question label, not another badge, not the assistant. When no such spot exists the answer is
 * `null` and the caller reports the review state somewhere else (the assistant) instead of drawing over the employer's form.
 */

export interface Box { left: number; top: number; right: number; bottom: number }

export const BADGE_GAP = 6;
export const VIEWPORT_MARGIN = 4;

/** Do two boxes overlap once each is grown by `pad`? Touching edges do not overlap with pad 0. */
export function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
}

export interface PlacementInput {
  target: Box;
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Everything a badge must not cover: controls, labels, open menus, the assistant. */
  obstacles: readonly Box[];
  /** Badges already placed in this pass. */
  placed: readonly Box[];
}

/** First clear spot beside, above or below the control, or null. Never clamps onto the control or an obstacle. */
export function chooseBadgePlacement(input: PlacementInput): { left: number; top: number } | null {
  const { target, size, viewport, obstacles, placed } = input;
  const { width, height } = size;
  const midY = (target.top + target.bottom) / 2 - height / 2;
  const candidates = [
    { left: target.right + BADGE_GAP, top: target.top },
    { left: target.right + BADGE_GAP, top: midY },
    { left: target.left - BADGE_GAP - width, top: target.top },
    { left: target.left - BADGE_GAP - width, top: midY },
    { left: target.right - width, top: target.top - height - BADGE_GAP },
    { left: target.left, top: target.top - height - BADGE_GAP },
    { left: target.left, top: target.bottom + BADGE_GAP },
    { left: target.right - width, top: target.bottom + BADGE_GAP }
  ];
  for (const candidate of candidates) {
    const box: Box = { left: candidate.left, top: candidate.top, right: candidate.left + width, bottom: candidate.top + height };
    if (box.left < VIEWPORT_MARGIN || box.top < VIEWPORT_MARGIN
      || box.right > viewport.width - VIEWPORT_MARGIN || box.bottom > viewport.height - VIEWPORT_MARGIN) continue;
    if (boxesOverlap(box, target, 2)) continue;
    if (obstacles.some((obstacle) => boxesOverlap(box, obstacle, 2))) continue;
    if (placed.some((other) => boxesOverlap(box, other, 4))) continue;
    return { left: candidate.left, top: candidate.top };
  }
  return null;
}
