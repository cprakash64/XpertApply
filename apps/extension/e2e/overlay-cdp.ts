import type { CDPSession, Page } from "@playwright/test";

/**
 * Reach the production overlay over the DevTools Protocol.
 *
 * The overlay and the review widget inside it attach CLOSED shadow roots so a
 * script on the employer page cannot read them or click inside them (see
 * widget-driver.ts: "Neither of those may be relaxed for testing"). A closed root
 * is invisible to `page.evaluate`, to `host.shadowRoot`, and to Playwright's own
 * locators, which pierce open roots only. CDP can see it from outside the page, so
 * nothing is injected and the extension ships exactly the bytes it runs under test.
 *
 * Every call resolves the CURRENT root again. The content script replaces the host
 * on reconnect, and a cached handle would keep answering with an earlier moment's
 * state, which is a test that quietly reads the past.
 */
const HOST = "#xpertapply-assistant-overlay-v1";
const FACADE = "[data-overlay-workflow-facade]";

export type OverlayScope = "overlay" | "widget";

const drivers = new WeakMap<Page, OverlayCdp>();

export class OverlayCdp {
  private cdp?: CDPSession;
  private constructor(private readonly page: Page) {}

  /** One driver (one CDP session) per page. */
  static for(page: Page): OverlayCdp {
    let driver = drivers.get(page);
    if (!driver) { driver = new OverlayCdp(page); drivers.set(page, driver); }
    return driver;
  }

  private async session(): Promise<CDPSession> {
    if (!this.cdp) {
      this.cdp = await this.page.context().newCDPSession(this.page);
      await this.cdp.send("DOM.enable");
      await this.cdp.send("Runtime.enable");
    }
    return this.cdp;
  }

  /** The host element lives in the page's light DOM, so a plain locator finds it. */
  hostCount(): Promise<number> { return this.page.locator(HOST).count(); }

  private async rootObjectId(scope: OverlayScope): Promise<string> {
    const cdp = await this.session();
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: HOST });
    if (!nodeId) throw new Error("overlay host not present");
    const { node } = await cdp.send("DOM.describeNode", { nodeId, pierce: true });
    const overlayRoot = node.shadowRoots?.[0];
    if (!overlayRoot?.backendNodeId) throw new Error("overlay shadow root not reachable over CDP");
    const { object: overlayObject } = await cdp.send("DOM.resolveNode", { backendNodeId: overlayRoot.backendNodeId });
    if (!overlayObject.objectId) throw new Error("overlay shadow root not resolvable");
    if (scope === "overlay") return overlayObject.objectId;

    // The widget surface is a second host, with its own closed root, nested inside the overlay's.
    const { result: facade, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: overlayObject.objectId,
      functionDeclaration: `function(){ return this.querySelector(${JSON.stringify(FACADE)}); }`
    });
    if (exceptionDetails || !facade.objectId) throw new Error("widget surface absent");
    const { node: facadeNode } = await cdp.send("DOM.describeNode", { objectId: facade.objectId, pierce: true });
    const widgetRoot = facadeNode.shadowRoots?.[0];
    if (!widgetRoot?.backendNodeId) throw new Error("widget shadow root not reachable over CDP");
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: widgetRoot.backendNodeId });
    if (!object.objectId) throw new Error("widget shadow root not resolvable");
    return object.objectId;
  }

  /** Run a function declaration with the closed root as `this`. */
  async call<T>(fn: string, args: unknown[] = [], scope: OverlayScope = "overlay"): Promise<T> {
    const cdp = await this.session();
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: await this.rootObjectId(scope),
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as T;
  }

  /** Like `page.evaluate`, but `fn` receives the closed ShadowRoot as its first argument. */
  evaluate<A extends unknown[], R>(
    fn: (root: ShadowRoot, ...args: A) => R | Promise<R>, ...args: A
  ): Promise<R> {
    return this.call<R>(`function(...a){ return (${fn.toString()})(this, ...a); }`, args, "overlay");
  }

  /** Same, against the review widget's own closed root nested inside the overlay. */
  evaluateWidget<A extends unknown[], R>(
    fn: (root: ShadowRoot, ...args: A) => R | Promise<R>, ...args: A
  ): Promise<R> {
    return this.call<R>(`function(...a){ return (${fn.toString()})(this, ...a); }`, args, "widget");
  }

  /**
   * Poll until `fn(root)` is truthy, like `page.waitForFunction` did. The host and its
   * root are briefly absent while the content script replaces them, so a failed read
   * is retried until the deadline instead of being treated as an error.
   */
  async waitFor(fn: (root: ShadowRoot) => unknown, options: { timeout?: number; interval?: number } = {}): Promise<void> {
    const { timeout = 30_000, interval = 100 } = options;
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    for (;;) {
      try {
        // `fn` is serialised into the page as source text, so it must not close over anything outside
        // itself; wrapping it in another arrow here would leave `fn` undefined in the page.
        if (await this.call<boolean>(`function(){ return Boolean((${fn.toString()})(this)); }`)) return;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() > deadline) {
        throw new Error(`overlay condition not met within ${timeout} ms${lastError ? ` (last error: ${String(lastError)})` : ""}`);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  // ---- Locator-shaped reads. Poll them with expect.poll(); they never auto-wait. -----------------
  text(selector: string): Promise<string | null> {
    return this.evaluate((root, sel) => root.querySelector(sel)?.textContent ?? null, selector);
  }
  innerText(selector: string): Promise<string> {
    return this.evaluate((root, sel) => (root.querySelector<HTMLElement>(sel)?.innerText) ?? "", selector);
  }
  attr(selector: string, name: string): Promise<string | null> {
    return this.evaluate((root, sel, attribute) => root.querySelector(sel)?.getAttribute(attribute) ?? null, selector, name);
  }
  count(selector: string): Promise<number> {
    return this.evaluate((root, sel) => root.querySelectorAll(sel).length, selector);
  }
  isDisabled(selector: string): Promise<boolean> {
    return this.evaluate((root, sel) => (root.querySelector<HTMLButtonElement>(sel)?.disabled) === true, selector);
  }
  isEnabled(selector: string): Promise<boolean> {
    return this.evaluate((root, sel) => {
      const el = root.querySelector<HTMLButtonElement>(sel);
      return Boolean(el) && el!.disabled === false;
    }, selector);
  }
  /** Rendered and not hidden by the `hidden` attribute, display, or visibility. */
  isVisible(selector: string): Promise<boolean> {
    return this.evaluate((root, sel) => {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el || el.hidden) return false;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    }, selector);
  }
  /** Entirely inside the viewport, as Playwright's toBeInViewport() means it. */
  inViewport(selector: string): Promise<boolean> {
    return this.evaluate((root, sel) => {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.top >= 0 && box.left >= 0
        && box.bottom <= innerHeight && box.right <= innerWidth;
    }, selector);
  }
  computed(selector: string, properties: string[]): Promise<Record<string, string>> {
    return this.evaluate((root, sel, props) => {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) return {};
      const style = getComputedStyle(el);
      return Object.fromEntries(props.map((name) => [name, style.getPropertyValue(name)]));
    }, selector, properties);
  }

  // ---- Actions ----------------------------------------------------------------------------------
  async scrollIntoView(selector: string): Promise<void> {
    await this.evaluate((root, sel) => { root.querySelector<HTMLElement>(sel)?.scrollIntoView({ block: "center", inline: "center" }); }, selector);
  }
  async focus(selector: string): Promise<void> {
    await this.evaluate((root, sel) => { root.querySelector<HTMLElement>(sel)?.focus(); }, selector);
  }
  activeElementId(): Promise<string | null> {
    return this.evaluate((root) => (root.activeElement as HTMLElement | null)?.id || null);
  }

  /** A synthetic click: what `button.click()` did in the old page.evaluate calls. */
  async clickSynthetic(selector: string): Promise<void> {
    const found = await this.evaluate((root, sel) => {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) return false;
      el.click();
      return true;
    }, selector);
    if (!found) throw new Error(`overlay control not found: ${selector}`);
  }

  /**
   * A TRUSTED click: real mouse events at the control's centre, so `isTrusted` is
   * true and the page gets a genuine user activation (needed for confirm() and for
   * permissions.request). Waits for the control to exist and be enabled, scrolls it
   * into view first, and fails loudly otherwise, as Playwright's click() does.
   */
  async click(selector: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let point: { x: number; y: number } | null = null;
    while (Date.now() < deadline) {
      point = await this.evaluate((root, sel) => {
        const el = root.querySelector<HTMLButtonElement>(sel);
        if (!el || el.hidden || el.disabled) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null;
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }, selector);
      if (point) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!point) throw new Error(`overlay control not clickable within ${timeoutMs} ms: ${selector}`);
    const cdp = await this.session();
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  }
}

/** Shorthand used by the specs. */
export const overlayCdp = (page: Page): OverlayCdp => OverlayCdp.for(page);
