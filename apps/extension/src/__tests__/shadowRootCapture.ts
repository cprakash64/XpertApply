/**
 * Test-only access to CLOSED shadow roots.
 *
 * The overlay and the review widget attach `{ mode: "closed" }` roots so a script
 * on the employer page cannot read them or click inside them. That is the
 * behaviour under test, so these helpers never force a mode: they only record,
 * for every root attached while installed, which host it belongs to. A test reads
 * a root through `rootOf(host)` the way the DevTools Protocol does from outside
 * the page, while `host.shadowRoot` stays `null` exactly as it does for the page.
 */
const roots = new WeakMap<Element, ShadowRoot>();
let original: typeof Element.prototype.attachShadow | null = null;

export function installShadowRootCapture(): void {
  if (original) return;
  original = Element.prototype.attachShadow;
  const attach = original;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = attach.call(this, init);
    roots.set(this, root);
    return root;
  };
}

export function restoreShadowRootCapture(): void {
  if (!original) return;
  Element.prototype.attachShadow = original;
  original = null;
}

/** The shadow root of `host` regardless of its mode, or null if none was captured. */
export function rootOf(host: Element | null | undefined): ShadowRoot | null {
  return host ? roots.get(host) ?? null : null;
}
