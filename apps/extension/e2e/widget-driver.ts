import type { CDPSession, Page } from "@playwright/test";

/**
 * Drive the REAL review widget in the built dist.
 *
 * The widget deliberately uses `attachShadow({ mode: "closed" })` so employer
 * page scripts cannot reach into it, and the content script exposes nothing to
 * the page. Neither of those may be relaxed for testing.
 *
 * So the tests reach it the way the browser's own tooling does: over the Chrome
 * DevTools Protocol, which can pierce a closed shadow root from OUTSIDE the
 * page. Nothing is injected, no production selector becomes page-visible, and
 * the extension ships exactly the same bytes it would in production.
 */
export class WidgetDriver {
  private constructor(private readonly cdp: CDPSession) {}

  static async attach(page: Page): Promise<WidgetDriver> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    const driver = new WidgetDriver(cdp);
    // Fail here rather than on the first assertion if the widget is absent.
    await driver.rootObjectId();
    return driver;
  }

  /**
   * The CURRENT shadow root, resolved fresh every time.
   *
   * A cached handle is not safe: the content script replaces the whole widget
   * host when it reconnects, and a stale root keeps answering — with the panel as
   * it looked at some earlier moment. That is a test that silently reads the
   * past, which is worse than one that fails.
   */
  private async rootObjectId(): Promise<string> {
    const { root } = await this.cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "#jobpilot-assisted-apply"
    });
    if (!nodeId) throw new Error("widget host not present");
    const { node } = await this.cdp.send("DOM.describeNode", { nodeId, pierce: true });
    const shadow = node.shadowRoots?.[0];
    if (!shadow?.backendNodeId) throw new Error("widget shadow root not reachable");
    const { object } = await this.cdp.send("DOM.resolveNode", {
      backendNodeId: shadow.backendNodeId
    });
    if (!object.objectId) throw new Error("widget shadow root not resolvable");
    return object.objectId;
  }

  /** Run `fn` with the shadow root as `this`. */
  private async call<T>(fn: string, ...args: unknown[]): Promise<T> {
    const { result, exceptionDetails } = await this.cdp.send("Runtime.callFunctionOn", {
      objectId: await this.rootObjectId(),
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value as T;
  }

  /** Test-only DevTools inspection/stress; never exposed to employer scripts. */
  async probe<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.call<T>(fn, ...args);
  }

  /** Browser geometry/semantics of the closed production shadow root. */
  async inspectLayout(): Promise<any> {
    return this.call(`function(){
      const box = this.querySelector('.box'), body = this.querySelector('.body');
      const action = this.querySelector('[data-a="complete"]');
      const rect = el => { const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}; };
      const a=rect(action), b=rect(box), sc=rect(body);
      const heading=this.getElementById(box.getAttribute('aria-labelledby'));
      return { viewport:{width:innerWidth,height:innerHeight}, box:b, body:{...sc,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,overflow:getComputedStyle(body).overflowY},action:a,
        actionVisible:a.top>=Math.max(0,b.top)&&a.bottom<=Math.min(innerHeight,b.bottom,body.contains(action)?sc.bottom:innerHeight),
        horizontalOverflow:box.scrollWidth>box.clientWidth||body.scrollWidth>body.clientWidth||b.left<0||b.right>innerWidth,
        name:box.getAttribute('aria-label')||heading?.textContent||null,panelLive:box.getAttribute('aria-live'),
        live:Array.from(this.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).map(el=>({tag:el.tagName,role:el.getAttribute('role'),live:el.getAttribute('aria-live'),atomic:el.getAttribute('aria-atomic'),className:el.className}))
      };
    }`);
  }

  /** Reveal the review panel, exactly as the user's click does. */
  async openReview(): Promise<void> {
    await this.call(`function(){
      const toggle = this.querySelector(".review-toggle");
      if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
      return true;
    }`);
  }

  /** User-visible status text from the production widget's closed shadow root. */
  async message(): Promise<string> {
    return this.call(`function(){ return (this.querySelector(".message") || {}).textContent || ""; }`);
  }

  /** Activate the production Clear button inside the closed shadow root. */
  async clearFilledFields(): Promise<void> {
    await this.call(`function(){ this.querySelector('[data-a="clear"]').click(); return true; }`);
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

  /** The widget's own summary line, for reconciling with the employer page. */
  async summary(): Promise<{ title: string; message: string; count: string; counts: string }> {
    return this.call(`function(){
      const text = (sel) => { const el = this.querySelector(sel); return el ? el.textContent.trim() : ""; };
      return {
        title: text(".title"),
        message: text(".message"),
        count: text(".count"),
        counts: text(".counts-row")
      };
    }`);
  }
}
