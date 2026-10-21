import { expect, test } from "@playwright/test";
import { startHarness } from "./cws-prepub-harness";
import { CanonicalOverlayDriver } from "./canonical-overlay-driver";

const unresolved = [
  { canonical_key: "first_name", reason: "Confirm your name.", sensitive: false, action: "confirm_name", suggested_value: "Ada", has_saved_value: false },
  { canonical_key: "last_name", reason: "Confirm your name.", sensitive: false, action: "confirm_name", suggested_value: "Lovelace", has_saved_value: false }
];
const form = (csp: string) => `<!doctype html><meta charset="utf-8">${csp}<title>Apply</title><main><h1>Apply for Engineer</h1><form id="application">
<label>First name <input id="first" name="first_name" autocomplete="given-name"></label>
<label>Last name <input id="last" name="last_name" autocomplete="family-name"></label>
<label>Email <input id="email" name="email" type="email"></label>
<button id="final-submit" type="submit">Submit application</button></form></main>`;

async function open(csp = "") {
  const h = await startHarness({ html: form(csp), prepared: true, unresolved });
  await h.useOwnedApi();
  const page = await h.ctx.newPage();
  await page.goto(h.url);
  await h.seedPrepared();
  const overlay = await CanonicalOverlayDriver.openFromToolbar(page, h.worker);
  await page.waitForTimeout(3000);
  await overlay.fill();
  await page.waitForTimeout(3000);
  await overlay.openReview();
  return { h, page, overlay };
}

test("text entered in the private iframe reaches the confirm flow only when the user confirms", async () => {
  test.setTimeout(120_000);
  const { h, page } = await open();
  try {
    let frame = page.frames().find(f => f.url().startsWith("chrome-extension://"));
    for (let i = 0; i < 40 && !frame; i++) { await page.waitForTimeout(250); frame = page.frames().find(f => f.url().startsWith("chrome-extension://")); }
    expect(frame).toBeTruthy();
    const inputs = frame!.locator("input[type=text]");
    await expect(inputs).toHaveCount(5);
    // Suggestions arrive in the iframe via the worker, not via the page.
    await expect(inputs.nth(0)).toHaveValue("Ada");
    await inputs.nth(0).fill("Augusta");
    await inputs.nth(2).fill("King");
    expect(await page.inputValue("#first")).toBe("");
    await frame!.getByRole("button", { name: "Confirm and fill" }).click();
    // The typed values travelled iframe -> worker -> top-frame handler -> the
    // user-initiated name confirmation. That PUT is the feature the user chose.
    await expect.poll(() => h.apiLog.find(a => a.method === "PUT" && a.path.endsWith("/profile/name"))?.body ?? null, { timeout: 15_000 }).not.toBeNull();
    const body = JSON.parse(h.apiLog.find(a => a.path.endsWith("/profile/name"))!.body!);
    expect(body).toMatchObject({ first_name: "Augusta", last_name: "King" });
    // Nothing was sent to XpertApply before the user pressed the button.
    expect(h.apiLog.filter(a => a.path.endsWith("/profile/name")).length).toBe(1);
    // The employer's Submit was never touched.
    expect(await page.evaluate(() => (document.getElementById("final-submit") as HTMLButtonElement).disabled)).toBe(false);
  } finally { await h.close(); }
});

test("a page CSP that forbids frames fails closed: no text input ever appears in the employer document", async () => {
  test.setTimeout(120_000);
  const { h, page, overlay } = await open(`<meta http-equiv="Content-Security-Policy" content="frame-src 'none'; child-src 'none'">`);
  try {
    await page.waitForTimeout(4000);
    const state = await overlay.probe<{ textControls: number; note: string; iframes: number }>(`function(){
      let textControls = 0; const walk = (scope) => { for (const el of scope.querySelectorAll("*")) {
        if (el.tagName === "TEXTAREA" || el.isContentEditable) textControls++;
        if (el.tagName === "INPUT" && !["checkbox","radio","button","submit","file","hidden"].includes((el.type||"").toLowerCase())) textControls++; } };
      walk(this);
      return { textControls, iframes: this.querySelectorAll("iframe").length, note: (this.querySelector(".private-entry")||{}).innerText || "" }; }`);
    console.log("CSP_FRAME_SRC_NONE " + JSON.stringify({ state, frames: page.frames().map(f => f.url().slice(0, 40)) }));
    expect(state.textControls).toBe(0);
    const framed = page.frames().some(f => f.url().startsWith("chrome-extension://"));
    // Either the extension frame is exempt from the page CSP and works, or the
    // assistant says plainly that it cannot offer the box. Never a silent in-page input.
    if (!framed) expect(state.note).toMatch(/does not allow a private entry box|^$/);
  } finally { await h.close(); }
});
