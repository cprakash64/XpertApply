import { expect, type Page, type Worker } from "@playwright/test";
import { overlayCdp } from "./overlay-cdp";

/**
 * Test-only toolbar-equivalent launch, matching e4oc-r3-overlay's native authority path.
 *
 * The overlay and widget roots are CLOSED, so everything below goes through
 * overlay-cdp.ts (DevTools Protocol). Playwright locators and `page.evaluate`
 * cannot see inside them, by design.
 */
export class CanonicalOverlayDriver {
  constructor(private readonly page: Page) {}
  static async openFromToolbar(page: Page, worker: Worker) {
    const driver = new CanonicalOverlayDriver(page);
    expect(await driver.hostCount(), "passive bootstrap must not open UI").toBe(0);
    await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      if (tab?.id == null) throw new Error("Employer tab not found");
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["overlayBootstrap.js"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["content.js"] });
      const response = await chrome.tabs.sendMessage(tab.id, { type: "XPERTAPPLY_SHOW_APPLICATION_OVERLAY" }, { frameId: 0 });
      if (!response?.ok) throw new Error("Native toolbar SHOW rejected");
    }, page.url());
    await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    return driver;
  }
  hostCount() { return this.page.locator("#xpertapply-assistant-overlay-v1").count(); }
  async status() { return overlayCdp(this.page).innerText("#stage"); }
  async error() { return overlayCdp(this.page).innerText("#errors"); }
  async fill() { await overlayCdp(this.page).click("#fill"); }
  async clear() { await overlayCdp(this.page).click("#clear"); }

  async probe<T>(fn: string, ...args: unknown[]): Promise<T> { return this.call<T>(fn, ...args); }
  async inspectLayout() {
    return overlayCdp(this.page).evaluate((root) => {
      const box = root.querySelector<HTMLElement>("[data-overlay-panel]")!;
      const body = root.querySelector<HTMLElement>(".body")!;
      const rect = (el: HTMLElement) => { const r=el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}; };
      return { viewport:{width:innerWidth,height:innerHeight}, box:rect(box), body:{...rect(body),scrollHeight:body.scrollHeight,clientHeight:body.clientHeight}, horizontalOverflow:box.scrollWidth>box.clientWidth||body.scrollWidth>body.clientWidth||box.getBoundingClientRect().left<0||box.getBoundingClientRect().right>innerWidth, name:root.getElementById(box.getAttribute("aria-labelledby")!)!.textContent, panelLive:box.getAttribute("aria-live"), liveRole:root.querySelector(".status")!.getAttribute("role"), live:root.querySelector(".status")!.getAttribute("aria-live") };
    });
  }
  static async attach(page: Page) {
    const driver = new CanonicalOverlayDriver(page);
    await expect(page.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1);
    return driver;
  }
  /** Runs `fn` with the review widget's own CLOSED root, nested inside the overlay's, as `this`. */
  private async call<T>(fn: string, ...args: unknown[]): Promise<T> {
    return overlayCdp(this.page).call<T>(fn, args, "widget");
  }
  async summary() {
    return overlayCdp(this.page).evaluate((root) => {
      const number = (id: string) => Number(root.getElementById(id)!.textContent);
      return { title: root.getElementById("stage")!.textContent!, filled: number("filled"), discovered: number("discovered"), review: number("review"), skipped: number("skipped") };
    });
  }
  /** Internal current workflow ledger, distinct from canonical visible counters. */
  async ledgerCounts() {
    return this.call<{counts:string}>(`function(){return {counts:this.querySelector('.counts-row')?.textContent||''}}`);
  }
  /** Reveal the review panel, exactly as the user's click does. */
  async openReview(): Promise<void> {
    await this.call(`function(){
      const toggle = this.querySelector(".review-toggle");
      if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
      return true;
    }`);
  }

  /** Every action-item card the authoritative review list is showing. */
  async actionItems(): Promise<
    { fieldKey: string; title: string; buttons: string[]; source: string | null; status: string | null }[]
  > {
    return this.call(`function(){
      return Array.from(this.querySelectorAll("[data-action-item]")).map((card) => ({
        fieldKey: card.getAttribute("data-action-item"),
        title: (card.querySelector(".q") || {}).textContent || "",
        buttons: Array.from(card.querySelectorAll("button")).map((b) => b.getAttribute("data-act") || b.getAttribute("data-choice")),
        source: card.querySelector("[data-source]") ? card.querySelector("[data-source]").textContent : null,
        status: card.querySelector("[data-status]") && !card.querySelector("[data-status]").hidden
          ? card.querySelector("[data-status]").textContent : null
      }));
    }`);
  }

  /** Click a card's action button (`answer` | `jump` | `defer`). */
  async clickAction(fieldKey: string, act: string): Promise<boolean> {
    return this.call(
      `function(key, act){
        const card = this.querySelector('[data-action-item="' + key + '"]');
        if (!card) return false;
        const button = card.querySelector('[data-act="' + act + '"]');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }`,
      fieldKey,
      act
    );
  }

  /** What the Yes/No/Cancel block offers, and whether anything is preselected. */
  async choiceState(fieldKey: string): Promise<{
    present: boolean;
    choices: string[];
    notes: string[];
    preselected: number;
    valueControls: number;
  }> {
    return this.call(
      `function(key){
        const block = this.querySelector('[data-choice-block="' + key + '"]');
        if (!block) return { present: false, choices: [], notes: [], preselected: 0, valueControls: 0 };
        return {
          present: true,
          choices: Array.from(block.querySelectorAll("[data-choice]")).map((b) => b.getAttribute("data-choice")),
          notes: Array.from(block.querySelectorAll(".note")).map((n) => n.textContent),
          // Nothing may arrive already chosen, by any mechanism.
          preselected: block.querySelectorAll("input:checked,[selected],[aria-pressed='true'],.selected").length,
          valueControls: block.querySelectorAll("input,select,textarea").length
        };
      }`,
      fieldKey
    );
  }

  async chooseAnswer(fieldKey: string, choice: "yes" | "no" | "cancel"): Promise<boolean> {
    return this.call(
      `function(key, choice){
        const block = this.querySelector('[data-choice-block="' + key + '"]');
        if (!block) return false;
        const button = block.querySelector('[data-choice="' + choice + '"]');
        if (!button) return false;
        button.click();
        return true;
      }`,
      fieldKey,
      choice
    );
  }

  /** Send a raw keyboard event from inside the widget, to prove containment. */
  async pressKeyInside(fieldKey: string, key: string): Promise<boolean> {
    return this.call(
      `function(fieldKey, key){
        const card = this.querySelector('[data-action-item="' + fieldKey + '"]');
        const target = (card && card.querySelector("button")) || this.querySelector("button");
        if (!target) return false;
        target.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true, composed: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { key: key, bubbles: true, composed: true }));
        return true;
      }`,
      fieldKey,
      key
    );
  }

}
