import { afterEach, describe, expect, it, vi } from "vitest";
import { clearJobPilotFields, fillField, highlight, removeHighlight } from "../fields/fill";
import { discoverFields } from "../fields/discovery";
import {
  fieldStatusPresentationCssForTest,
  fieldStatusPresentationForTest,
  resetFieldStatusPresentation
} from "../fields/statusPresentation";

const targets: HTMLElement[] = [];

function target(id: string, style = ""): HTMLInputElement {
  const input = document.createElement("input");
  input.id = id;
  input.className = "employer-field";
  input.setAttribute("style", style);
  input.getBoundingClientRect = vi.fn(() => ({
    x: 20,
    y: 30,
    top: 30,
    left: 20,
    right: 220,
    bottom: 70,
    width: 200,
    height: 40,
    toJSON: () => ({})
  } as DOMRect));
  document.body.append(input);
  targets.push(input);
  return input;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  for (const element of targets.splice(0)) removeHighlight(element);
  resetFieldStatusPresentation();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("XA-17 extension-owned status presentation", () => {
  it("presents every status with icon and text without mutating employer controls", () => {
    const states = [
      ["verified", "✓Verified", "Verified"],
      ["review", "!Needs review", "Needs review"],
      ["invalid", "×Invalid — action required", "Invalid — action required"],
      ["generated", "✦Suggested — review", "Suggested — review"]
    ] as const;

    for (const [status, text, label] of states) {
      const input = target(status, "outline: 3px dotted rgb(12, 34, 56); border: 4px solid purple; box-shadow: 1px 2px 3px black;");
      const before = input.getAttribute("style");
      highlight(input, status);
      expect(fieldStatusPresentationForTest(input)).toMatchObject({
        status,
        text,
        role: "note",
        ariaLabel: `XpertApply field status: ${label}`
      });
      expect(input.getAttribute("style")).toBe(before);
      expect(input.className).toBe("employer-field");
      expect(Array.from(input.attributes).map((attribute) => attribute.name).sort()).toEqual(["class", "id", "style"]);
    }
  });

  it("preserves employer outline, border, box-shadow, background, and class through fill and Clear", async () => {
    document.body.innerHTML = `<form><label for="name">Name</label></form>`;
    const input = target(
      "name",
      "outline: 3px dotted rgb(12, 34, 56); border: 4px solid purple; box-shadow: 1px 2px 3px black; background: linen;"
    );
    document.querySelector("form")!.append(input);
    const beforeStyle = input.getAttribute("style");
    const beforeClass = input.className;
    input.value = "KEEP-ME-PRIVATE";
    const field = discoverFields(document.querySelector("form")!).find((candidate) => candidate.id === "name")!;

    expect((await fillField(field, "REPLACED", { force: true, status: "review" })).status).toBe("filled");
    expect(input.getAttribute("style")).toBe(beforeStyle);
    expect(input.className).toBe(beforeClass);
    expect(fieldStatusPresentationForTest(input)?.text).toContain("Needs review");

    expect(await clearJobPilotFields(document)).toEqual({ cleared: 1, failed: 0 });
    expect(input.value).toBe("KEEP-ME-PRIVATE");
    expect(input.getAttribute("style")).toBe(beforeStyle);
    expect(input.className).toBe(beforeClass);
    expect(fieldStatusPresentationForTest(input)).toBeNull();
  });

  it("tracks shared scroll and resize updates without intercepting pointer input", async () => {
    const input = target("moving");
    let left = 20;
    input.getBoundingClientRect = vi.fn(() => ({
      x: left,
      y: 30,
      top: 30,
      left,
      right: left + 200,
      bottom: 70,
      width: 200,
      height: 40,
      toJSON: () => ({})
    } as DOMRect));
    highlight(input, "verified");
    const first = fieldStatusPresentationForTest(input)?.transform;

    left = 120;
    document.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(fieldStatusPresentationForTest(input)?.transform).not.toBe(first);
    expect(fieldStatusPresentationCssForTest()).toContain("pointer-events:none");
  });

  it("removes a decoration when its employer control is detached", async () => {
    const input = target("detached");
    highlight(input, "invalid");
    expect(fieldStatusPresentationForTest(input)).not.toBeNull();
    input.remove();
    await settle();
    expect(fieldStatusPresentationForTest(input)).toBeNull();
  });

  it("retains non-color semantics in forced colors and grayscale", () => {
    const css = fieldStatusPresentationCssForTest();
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("color:CanvasText");
    expect(css).toContain("border-color:CanvasText");

    const review = target("review-gray");
    const verified = target("verified-gray");
    highlight(review, "review");
    highlight(verified, "verified");
    expect(fieldStatusPresentationForTest(review)?.text).toBe("!Needs review");
    expect(fieldStatusPresentationForTest(verified)?.text).toBe("✓Verified");
  });

  it("negative controls detect both legacy status disclosure and destructive outline removal", () => {
    const verified = target("legacy-verified");
    const review = target("legacy-review");
    verified.style.outline = "2px solid rgb(47, 143, 91)";
    review.style.outline = "2px solid rgb(224, 167, 47)";
    const privacyInvariant = () => expect(
      new Set([verified.style.outline, review.style.outline]).size
    ).toBe(1);
    expect(privacyInvariant).toThrow();

    const styled = target("legacy-clear", "outline: 3px dotted rgb(12, 34, 56);");
    const original = styled.style.outline;
    styled.style.outline = "2px solid rgb(47, 143, 91)";
    styled.style.outline = "";
    const restorationInvariant = () => expect(styled.style.outline).toBe(original);
    expect(restorationInvariant).toThrow();

    verified.style.outline = "";
    review.style.outline = "";
    styled.style.outline = original;
    expect(styled.style.outline).toBe(original);
  });

  it("cancels pending positioning when the status layer is reset", () => {
    vi.useFakeTimers();
    const input = target("pending-reset");
    highlight(input, "verified");
    window.dispatchEvent(new Event("resize"));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    resetFieldStatusPresentation();
    resetFieldStatusPresentation();

    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(fieldStatusPresentationForTest(input)).toBeNull();
  });

  it("a reset presentation callback cannot mutate its replacement", () => {
    vi.useFakeTimers();
    const first = target("first-instance");
    highlight(first, "review");
    window.dispatchEvent(new Event("resize"));
    resetFieldStatusPresentation();

    const replacement = target("replacement-instance");
    const rect = replacement.getBoundingClientRect as ReturnType<typeof vi.fn>;
    highlight(replacement, "verified");
    const callsAfterRender = rect.mock.calls.length;
    vi.runAllTimers();

    expect(rect).toHaveBeenCalledTimes(callsAfterRender);
    expect(fieldStatusPresentationForTest(replacement)?.status).toBe("verified");
  });

  it("leaves no callback that can outlive environment cleanup", () => {
    vi.useFakeTimers();
    const input = target("environment-teardown");
    highlight(input, "invalid");
    document.dispatchEvent(new Event("scroll"));
    resetFieldStatusPresentation();
    document.body.innerHTML = "";

    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.runAllTimers()).not.toThrow();
  });
});
