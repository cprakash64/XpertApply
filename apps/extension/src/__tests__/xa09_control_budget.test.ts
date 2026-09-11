import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApplicationRoot } from "../ats/formRoot";
import { awaitApplicationReadiness } from "../content/applicationReadiness";
import { discoverAll } from "../fields/discovery";
import { inspectControlBudget, MAX_APPLICATION_CONTROLS } from "../fields/controlBudget";

function appendControls(root: ParentNode, count: number, offset = 0): void {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index += 1) {
    const input = document.createElement("input");
    input.id = `field-${offset + index}`;
    input.name = `field-${offset + index}`;
    if (index === 0 && offset === 0) {
      input.name = "first_name";
      input.autocomplete = "given-name";
    }
    if (index === 1 && offset === 0) {
      input.name = "last_name";
      input.autocomplete = "family-name";
    }
    if (index === 2 && offset === 0) {
      input.name = "email";
      input.type = "email";
    }
    if (index === 3 && offset === 0) {
      input.name = "phone";
      input.type = "tel";
    }
    fragment.append(input);
  }
  root.appendChild(fragment);
}

describe("XA-09 application control budget", () => {
  beforeEach(() => {
    document.body.innerHTML = "<main><h1>Apply for this job</h1><form id='application'><button type='submit'>Submit application</button></form></main>";
  });

  afterEach(() => vi.restoreAllMocks());

  it("accepts the exact boundary and rejects the first control above it", () => {
    const form = document.querySelector("form")!;
    appendControls(form, MAX_APPLICATION_CONTROLS);
    expect(inspectControlBudget(document)).toEqual({
      count: MAX_APPLICATION_CONTROLS,
      limit: MAX_APPLICATION_CONTROLS,
      exceeded: false
    });

    appendControls(form, 1, MAX_APPLICATION_CONTROLS);
    expect(inspectControlBudget(document)).toEqual({
      count: MAX_APPLICATION_CONTROLS + 1,
      limit: MAX_APPLICATION_CONTROLS,
      exceeded: true
    });
  });

  it("refuses root resolution and direct discovery without returning a partial success", () => {
    appendControls(document.querySelector("form")!, MAX_APPLICATION_CONTROLS + 1);

    const first = resolveApplicationRoot(document);
    const second = resolveApplicationRoot(document);
    expect(first).toMatchObject({
      root: null,
      confident: false,
      reason: "APPLICATION_FORM_TOO_LARGE",
      controlCount: MAX_APPLICATION_CONTROLS + 1,
      controlBudget: MAX_APPLICATION_CONTROLS
    });
    expect(second.reason).toBe("APPLICATION_FORM_TOO_LARGE");
    expect(discoverAll(document)).toMatchObject({
      fields: [],
      excluded: [],
      tooLarge: true,
      controlCount: MAX_APPLICATION_CONTROLS + 1,
      controlBudget: MAX_APPLICATION_CONTROLS
    });
  });

  it("counts actionable controls across open shadow roots", () => {
    const form = document.querySelector("form")!;
    appendControls(form, 501);
    const host = document.createElement("section");
    form.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    appendControls(shadow, 500, 501);

    expect(inspectControlBudget(document)).toMatchObject({ count: 1_001, exceeded: true });
    expect(resolveApplicationRoot(document).reason).toBe("APPLICATION_FORM_TOO_LARGE");
  });

  it("ends readiness immediately with the named recoverable failure", async () => {
    appendControls(document.querySelector("form")!, MAX_APPLICATION_CONTROLS + 1);
    const scheduled = vi.spyOn(window, "setTimeout");

    const result = await awaitApplicationReadiness({ doc: document, timeoutMs: 20_000, quietMs: 0 });
    expect(result).toMatchObject({
      ready: false,
      failureCode: "APPLICATION_FORM_TOO_LARGE",
      root: { reason: "APPLICATION_FORM_TOO_LARGE" }
    });
    // "Immediate" is an algorithmic property, not a host-scheduler deadline:
    // the refusal must return before installing either the quiet-window timer
    // or the 20-second readiness deadline. This remains deterministic even
    // when Vitest runs many JSDOM files concurrently on a loaded host.
    expect(scheduled).not.toHaveBeenCalled();
  });
});
