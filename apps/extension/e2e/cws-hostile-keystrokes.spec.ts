import { expect, test } from "@playwright/test";
import { startHarness } from "./cws-prepub-harness";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";
import { overlayCdp } from "./overlay-cdp";
import fs from "node:fs";

/**
 * A hostile employer page registers capture listeners for keydown, keyup,
 * beforeinput, input, change and paste on BOTH window and document, before any
 * extension code runs. The user then types and pastes a unique sentinel into
 * EVERY editable control the assistant offers. Anything the page's listeners
 * record that originated in the assistant is a leak of the user's text.
 */
const hostilePage = `<!doctype html><meta charset="utf-8"><title>Hostile employer page</title>
<main><h1>Apply for Engineer</h1><form id="application">
<label>First name <input id="first" name="first_name" autocomplete="given-name"></label>
<label>Last name <input id="last" name="last_name" autocomplete="family-name"></label>
<label>Email <input id="email" name="email" type="email"></label>
<button id="final-submit" type="submit">Submit application</button></form></main>`;

function hostileInit() {
  const log: any[] = [];
  (window as any).__hostile = log;
  const interesting = ["keydown", "keyup", "keypress", "beforeinput", "input", "change", "paste", "compositionupdate"];
  for (const target of [window, document] as EventTarget[]) {
    for (const type of interesting) {
      target.addEventListener(type, (e: any) => {
        // Only record events the page's own #first/#last/#email did NOT receive
        // (those have a real light-DOM target); everything else came from outside page controls.
        const t = e.target as Element | Document | Window;
        const id = (t as Element)?.id ?? null;
        const fromPageControl = id === "first" || id === "last" || id === "email";
        let pasted: string | null = null;
        try { pasted = e.clipboardData ? e.clipboardData.getData("text") : null; } catch { /* */ }
        log.push({
          on: target === window ? "window" : "document", type, key: e.key ?? null, data: e.data ?? null, pasted,
          targetId: id, targetTag: (t as Element)?.tagName ?? null, fromPageControl,
          valueSeenViaTarget: (t as HTMLInputElement)?.value ?? null
        });
      }, true);
    }
  }
}

test("hostile page cannot observe text typed or pasted into the assistant", async () => {
  test.setTimeout(150_000);
  const h = await startHarness({
    html: hostilePage, prepared: true, initScript: hostileInit,
    unresolved: [{ canonical_key: "first_name", reason: "Confirm your name.", sensitive: false, action: "confirm_name", suggested_value: "Ada", has_saved_value: false },
                 { canonical_key: "last_name", reason: "Confirm your name.", sensitive: false, action: "confirm_name", suggested_value: "Lovelace", has_saved_value: false }]
  });
  try {
    await h.ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(h.url).origin });
    await h.useOwnedApi();
    const page = await h.ctx.newPage();
    await page.goto(h.url);
    await h.seedPrepared();
    const overlay = await CanonicalOverlayDriver.openFromToolbar(page, h.worker);
    await page.waitForTimeout(3000);
    await overlay.fill();
    await page.waitForTimeout(3000);
    await overlay.openReview();

    // 1. Structure: the employer document (including every closed root of the
    //    assistant) must hold NO text-capable control. Entry happens in an
    //    extension-origin iframe instead.
    const inPage = await overlay.probe<{ textControls: number; iframes: number }>(`function(){
      let textControls = 0, iframes = 0;
      const walk = (scope) => { for (const el of scope.querySelectorAll("*")) {
        if (el.tagName === "IFRAME") iframes++;
        if (el.tagName === "TEXTAREA" || el.isContentEditable) textControls++;
        if (el.tagName === "INPUT" && !["checkbox","radio","button","submit","file","hidden","range","color"].includes((el.type||"").toLowerCase())) textControls++;
      } };
      walk(this); return { textControls, iframes }; }`);
    console.log("IN_PAGE_ASSISTANT " + JSON.stringify(inPage));
    expect(inPage.textControls, "text inputs must not live in the employer document").toBe(0);

    // 2. Behaviour: type and paste into EVERY editable control the assistant offers.
    let frame = page.frames().find(f => f.url().startsWith("chrome-extension://"));
    for (let i = 0; i < 40 && !frame; i++) { await page.waitForTimeout(250); frame = page.frames().find(f => f.url().startsWith("chrome-extension://")); }
    expect(frame, "private-entry frame must load").toBeTruthy();
    await frame!.waitForSelector("input[type=text]");
    const count = await frame!.locator("input[type=text]").count();
    const controls = Array.from({ length: count }, (_, idx) => ({ idx }));
    console.log("EDITABLE_CONTROLS " + count);
    expect(count, "the assistant must expose editable controls for this test to mean anything").toBeGreaterThan(0);

    const evidence: any[] = [];
    for (const c of controls) {
      const typed = `zq${c.idx}x${Math.random().toString(36).slice(2, 6)}`;
      const pasted = `PASTE${c.idx}${Math.random().toString(36).slice(2, 6)}`;
      await page.evaluate(() => { (window as any).__hostile.length = 0; });
      const input = frame!.locator("input[type=text]").nth(c.idx);
      await input.fill("");
      await input.focus();
      await page.keyboard.type(typed, { delay: 15 });
      await page.evaluate(t => navigator.clipboard.writeText(t), pasted);
      await page.keyboard.press("ControlOrMeta+V");
      await page.keyboard.press("Tab");
      const final = await input.inputValue();
      const seen: any[] = await page.evaluate(() => (window as any).__hostile.slice());
      const foreign = seen.filter(e => !e.fromPageControl);
      const blob = JSON.stringify(foreign);
      const keysSeen = foreign.filter(e => e.type === "keydown" && e.on === "window").map(e => e.key).join("");
      evidence.push({
        control: c, finalValueInAssistant: final,
        positiveControl_typedTextReachedTheAssistantInput: final.includes(typed),
        foreignEventCount: foreign.length,
        eventTypesSeenByPage: [...new Set(foreign.map(e => e.type))],
        keysReconstructedFromWindowKeydown: keysSeen,
        typedTextRecoverable: blob.includes(typed) || keysSeen.includes(typed),
        inputEventDataSeen: foreign.filter(e => e.type === "input" && e.data).map(e => e.data).join(""),
        pastedTextSeen: foreign.some(e => e.pasted && e.pasted.includes(pasted)),
        finalValueSeenViaEventTarget: foreign.some(e => e.valueSeenViaTarget && String(e.valueSeenViaTarget).includes(typed))
      });
    }
    console.log("HOSTILE_EVIDENCE " + JSON.stringify(evidence));
    fs.mkdirSync("test-results", { recursive: true });
    fs.writeFileSync("test-results/cws-hostile-evidence.json", JSON.stringify(evidence, null, 2));
    for (const e of evidence) expect(e.positiveControl_typedTextReachedTheAssistantInput, "the typing must actually have reached the control").toBe(true);
    for (const e of evidence) {
      expect(e.foreignEventCount, `page observed events from assistant control ${JSON.stringify(e.control)}`).toBe(0);
      expect(e.typedTextRecoverable).toBe(false);
      expect(e.pastedTextSeen).toBe(false);
    }
  } finally { await h.close(); }
});
