import type { Viewport } from "next";

/**
 * Viewport for the public website, which is always light.
 *
 * `colorScheme: "light"` tells the browser to paint its own canvas, scrollbars
 * and form controls light from the very first frame, so a dark-OS visitor never
 * sees a dark flash before the stylesheet arrives (no script needed). The theme
 * colour matches the white page, so mobile browser chrome does too. The signed-in
 * app keeps the root layout's two-scheme viewport.
 */
export const publicViewport: Viewport = {
  colorScheme: "light",
  themeColor: "#ffffff"
};
