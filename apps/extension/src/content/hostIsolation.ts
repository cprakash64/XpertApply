/**
 * Keeping the employer page's CSS out of XpertApply's own surfaces.
 *
 * Each surface is a closed shadow root under a `div` the page can see. Selectors in the page cannot reach INTO the shadow tree, but they
 * do match the host `div` itself, and anything inheritable that they set there (`line-height`, `letter-spacing`, `text-transform`,
 * `white-space`, `text-align`, `font-size`…) flows straight in. `:host{all:initial}` does not help: a page rule outranks a `:host` rule
 * in the cascade. Reproduced in a real Chromium (XA-EXT-PANEL-05): `div{line-height:1;letter-spacing:.3em;white-space:nowrap}` turned
 * the assistant into overlapping, clipped, letter-spaced text.
 *
 * Two layers, both beyond the page's reach:
 *  - `isolateHost` writes the host's own geometry and inheritance as INLINE `!important` declarations, which beat any stylesheet rule,
 *    important or not;
 *  - `ISOLATED_TEXT_BASE` is applied with `all:initial` on the first element INSIDE the shadow root, so whatever the host inherited is
 *    discarded there and every text property restarts from a known value.
 */

/** Resets every inheritable text property to a known value. Use on the first element inside a shadow root. */
export function isolatedTextBase(options: { fontFamily: string; fontSize: string; lineHeight: string; color: string }): string {
  return `all:initial;display:block;box-sizing:border-box;color:${options.color};font-family:${options.fontFamily};font-size:${options.fontSize};`
    + `font-weight:400;font-style:normal;font-variant:normal;line-height:${options.lineHeight};letter-spacing:normal;word-spacing:normal;`
    + "text-transform:none;text-align:left;text-indent:0;text-shadow:none;text-decoration:none;white-space:normal;direction:ltr;"
    + "writing-mode:horizontal-tb;hyphens:manual;tab-size:8;visibility:visible;opacity:1;cursor:auto;color-scheme:light;";
}

/** Pins the host element's geometry and inheritance with inline `!important`, out of reach of page stylesheets. */
export function isolateHost(host: HTMLElement, options: { zIndex: number }): void {
  const set = (property: string, value: string): void => host.style.setProperty(property, value, "important");
  set("all", "initial");
  set("display", "block");
  set("position", "fixed");
  set("inset", "0");
  set("z-index", String(options.zIndex));
  set("pointer-events", "none");
  set("margin", "0");
  set("padding", "0");
  set("border", "0");
  set("transform", "none");
  set("filter", "none");
  set("zoom", "1");
  set("opacity", "1");
  set("visibility", "visible");
  set("overflow", "visible");
  set("contain", "none");
  set("isolation", "auto");
}
