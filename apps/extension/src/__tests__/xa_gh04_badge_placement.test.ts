import { afterEach, describe, expect, it } from "vitest";
import { boxesOverlap, chooseBadgePlacement, type Box } from "../fields/badgePlacement";
import { fieldStatusPresentationCssForTest } from "../fields/statusPresentation";
import { fillField, restoreFillAuthority, withdrawFillAuthority } from "../fields/fill";
import { uploadFileToInput } from "../fields/upload";
import type { DiscoveredField } from "../types";

const VIEWPORT = { width: 1366, height: 768 };
const SIZE = { width: 120, height: 22 };
const box = (left: number, top: number, w: number, h: number): Box => ({ left, top, right: left + w, bottom: top + h });

describe("XA-EXT-GREENHOUSE-04 badge placement", () => {
  it("places beside a control when the side is clear, and never over the control", () => {
    const target = box(300, 200, 400, 40);
    const at = chooseBadgePlacement({ target, size: SIZE, viewport: VIEWPORT, obstacles: [target], placed: [] })!;
    expect(at).not.toBeNull();
    const placed = box(at.left, at.top, SIZE.width, SIZE.height);
    expect(boxesOverlap(placed, target, 0)).toBe(false);
  });

  it("refuses spots that cover a question label, an open menu option or another badge", () => {
    const target = box(300, 200, 400, 40);
    const label = box(300, 170, 380, 18); // the question text sits directly above the control
    const menu = box(300, 242, 400, 160); // the open dropdown list below it
    const sideObstacle = box(706, 190, 140, 60); // the right-hand side is taken too
    const other = box(180, 200, 120, 22);
    const at = chooseBadgePlacement({ target, size: SIZE, viewport: VIEWPORT, obstacles: [target, label, menu, sideObstacle], placed: [other] });
    if (at) {
      const placed = box(at.left, at.top, SIZE.width, SIZE.height);
      for (const blocked of [target, label, menu, sideObstacle, other]) expect(boxesOverlap(placed, blocked, 0)).toBe(false);
    }
  });

  it("returns null, rather than covering something, when no spot is clear", () => {
    const target = box(10, 200, 1340, 40); // a full-width control
    const everything = [target, box(0, 160, 1366, 36), box(0, 244, 1366, 36), box(0, 0, 8, 768), box(1358, 0, 8, 768)];
    expect(chooseBadgePlacement({ target, size: SIZE, viewport: VIEWPORT, obstacles: everything, placed: [] })).toBeNull();
  });

  it("never positions outside the viewport instead of clamping onto the control", () => {
    const target = box(1250, 5, 100, 40);
    const at = chooseBadgePlacement({ target, size: SIZE, viewport: VIEWPORT, obstacles: [target], placed: [] });
    if (at) {
      expect(at.left).toBeGreaterThanOrEqual(4);
      expect(at.top).toBeGreaterThanOrEqual(4);
      expect(at.left + SIZE.width).toBeLessThanOrEqual(VIEWPORT.width - 4);
    }
  });

  it("two controls never receive the same coordinate", () => {
    const a = box(300, 200, 400, 40), b = box(300, 214, 400, 40);
    const first = chooseBadgePlacement({ target: a, size: SIZE, viewport: VIEWPORT, obstacles: [a, b], placed: [] })!;
    const firstBox = box(first.left, first.top, SIZE.width, SIZE.height);
    const second = chooseBadgePlacement({ target: b, size: SIZE, viewport: VIEWPORT, obstacles: [a, b], placed: [firstBox] });
    if (second) expect(boxesOverlap(box(second.left, second.top, SIZE.width, SIZE.height), firstBox, 0)).toBe(false);
  });
});

describe("XA-EXT-GREENHOUSE-04 write authority", () => {
  afterEach(() => { restoreFillAuthority(); document.body.innerHTML = ""; });

  it("refuses every write once authorization is withdrawn, and writes again once a new session restores it", async () => {
    document.body.innerHTML = '<label for="e">Email</label><input id="e" value="">';
    const input = document.getElementById("e") as HTMLInputElement;
    const field = { uid: "e", control: "text", element: input } as unknown as DiscoveredField;
    withdrawFillAuthority();
    const refused = await fillField(field, "riley@example.test");
    expect(refused).toMatchObject({ status: "skipped", reason: "authorization withdrawn" });
    expect(input.value).toBe("");
    restoreFillAuthority();
    expect((await fillField(field, "riley@example.test")).status).toBe("filled");
    expect(input.value).toBe("riley@example.test");
  });

  it("refuses document uploads while withdrawn", () => {
    document.body.innerHTML = '<input id="f" type="file">';
    withdrawFillAuthority();
    const out = uploadFileToInput(document.getElementById("f") as HTMLInputElement, new File(["x"], "r.pdf", { type: "application/pdf" }));
    expect(out).toEqual({ status: "error", reason: "authorization withdrawn" });
  });
});

describe("XA-EXT-GREENHOUSE-04 hidden badges stay hidden", () => {
  // Greenhouse root cause: `.status{display:flex}` overrode the `hidden` attribute, so every badge the layout "hid" stayed painted at
  // its last position (or at 0,0 when it had never been placed), stacked over the employer's header and over each other.
  it("lets the hidden attribute win over the badge's own display rule", () => {
    expect(fieldStatusPresentationCssForTest()).toMatch(/\.status\[hidden\]\s*\{\s*display:\s*none/);
  });
});
