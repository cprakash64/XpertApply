import { describe, expect, it } from "vitest";
import { highlight } from "../fields/fill";
import { fieldStatusPresentationForTest } from "../fields/statusPresentation";

let priorTarget: HTMLInputElement | null = null;

describe("status presentation test-environment lifecycle", () => {
  it("leaves a live presentation and scheduled positioning callback for harness cleanup", () => {
    priorTarget = document.createElement("input");
    document.body.append(priorTarget);
    highlight(priorTarget, "review");
    window.dispatchEvent(new Event("resize"));

    expect(fieldStatusPresentationForTest(priorTarget)).not.toBeNull();
  });

  it("starts the next test with the prior environment-owned singleton disposed", () => {
    expect(priorTarget).not.toBeNull();
    expect(fieldStatusPresentationForTest(priorTarget!)).toBeNull();
  });
});
