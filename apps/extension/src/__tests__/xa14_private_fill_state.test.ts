import { describe, expect, it } from "vitest";
import { discoverFields } from "../fields/discovery";
import { clearJobPilotFields, fillField, highlight, isJobPilotFilled } from "../fields/fill";

function discovered(id: string) {
  const form = document.querySelector("form")!;
  const field = discoverFields(form).find((candidate) => candidate.id === id);
  if (!field) throw new Error(`missing field ${id}`);
  return field;
}

function privateMarkerNames(): string[] {
  return Array.from(document.querySelectorAll("*")).flatMap((element) =>
    Array.from(element.attributes)
      .map((attribute) => attribute.name)
      .filter((name) => name.startsWith("data-jobpilot-") || name.startsWith("data-xpertapply-"))
  );
}

async function flushMutations(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("XA-14 extension-private fill state", () => {
  it("keeps ownership, status, and the first restoration snapshot out of employer DOM", async () => {
    document.body.innerHTML = `<form><label for="name">Name</label><input id="name" value="KEEP-ME-PRIVATE"></form>`;
    const input = document.querySelector<HTMLInputElement>("#name")!;
    const observed: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const name = record.attributeName ?? "";
        if (name.startsWith("data-jobpilot-") || name.startsWith("data-xpertapply-")) observed.push(name);
      }
    });
    observer.observe(document.documentElement, { subtree: true, attributes: true });

    expect((await fillField(discovered("name"), "FIRST", { force: true, status: "review" })).status).toBe("filled");
    expect((await fillField(discovered("name"), "SECOND", { force: true, status: "verified" })).status).toBe("filled");
    await flushMutations();

    expect(isJobPilotFilled(input)).toBe(true);
    expect(privateMarkerNames()).toEqual([]);
    expect(observed).toEqual([]);
    expect(await clearJobPilotFields(document)).toEqual({ cleared: 1, failed: 0 });
    expect(input.value).toBe("KEEP-ME-PRIVATE");
    expect(isJobPilotFilled(input)).toBe(false);
    observer.disconnect();
  });

  it("detects the legacy DOM-attribute regression in its negative control", async () => {
    document.body.innerHTML = `<div id="control"></div>`;
    const control = document.querySelector<HTMLElement>("#control")!;
    const observed: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) if (record.attributeName) observed.push(record.attributeName);
    });
    observer.observe(document.documentElement, { subtree: true, attributes: true });
    control.setAttribute("data-jobpilot-original", "KEEP-ME-PRIVATE");
    await flushMutations();
    expect(control.getAttribute("data-jobpilot-original")).toBe("KEEP-ME-PRIVATE");
    expect(observed).toContain("data-jobpilot-original");
    control.removeAttribute("data-jobpilot-original");
    observer.disconnect();
    expect(privateMarkerNames()).toEqual([]);
  });

  it("does not make a highlight-only field Clear-owned", async () => {
    document.body.innerHTML = `<form><label for="note">Note</label><input id="note" value="user text"></form>`;
    const input = document.querySelector<HTMLInputElement>("#note")!;
    highlight(input, "review");
    expect(isJobPilotFilled(input)).toBe(false);
    expect(await clearJobPilotFields(document)).toEqual({ cleared: 0, failed: 0 });
    expect(input.value).toBe("user text");
    expect(privateMarkerNames()).toEqual([]);
  });

  it("restores the first contenteditable snapshot after repeated forced fills", async () => {
    document.body.innerHTML = `<form><label id="bio-label">Bio</label><div id="bio" role="textbox" aria-labelledby="bio-label" contenteditable="true">ORIGINAL</div></form>`;
    const editable = document.querySelector<HTMLElement>("#bio")!;
    await fillField(discovered("bio"), "FIRST", { force: true });
    await fillField(discovered("bio"), "SECOND", { force: true });
    expect(await clearJobPilotFields(document)).toEqual({ cleared: 1, failed: 0 });
    expect(editable.textContent).toBe("ORIGINAL");
    expect(privateMarkerNames()).toEqual([]);
  });
});
