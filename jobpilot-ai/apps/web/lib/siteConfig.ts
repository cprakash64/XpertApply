/**
 * Public product identity and deployment configuration.
 *
 * Everything here is read from `NEXT_PUBLIC_*` values so a deployment can point
 * the product at its own domain and its own Chrome Web Store listing without a
 * code change. Next.js inlines `process.env.NEXT_PUBLIC_*` at build time, so the
 * reads deliberately live inside functions: a module-level constant would be
 * frozen at import time in tests, and the literal substitution works the same
 * either way in a real build.
 *
 * The product NAME is a constant rather than configuration — it is the brand,
 * not a deployment detail — but it lives here so there is exactly one place that
 * spells it.
 */

/** The user-facing product name. Spelled exactly this way everywhere. */
export const PRODUCT_NAME = "EZJobFind";

/** Canonical production origin, used when nothing is configured. */
const DEFAULT_SITE_URL = "https://ezjobfind.com";

/**
 * Hosts a configured extension URL is allowed to point at.
 *
 * The install CTA is a link we hand to every visitor, so it is not enough for
 * the value to merely parse: a typo'd or hostile `NEXT_PUBLIC_CHROME_EXTENSION_URL`
 * would turn the landing page into a redirect to somewhere else entirely. Only
 * the official Chrome Web Store origins are accepted; anything else is treated
 * as "not configured yet" and the CTA falls back to its unavailable state.
 */
const CHROME_WEB_STORE_HOSTS = new Set(["chromewebstore.google.com", "chrome.google.com"]);

/** Strip a trailing slash so callers can concatenate paths safely. */
function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The public origin this deployment is served from — the canonical URL for
 * metadata, OpenGraph images, and anywhere an absolute link is required.
 */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return DEFAULT_SITE_URL;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_SITE_URL;
    return normalizeOrigin(url.origin + url.pathname);
  } catch {
    return DEFAULT_SITE_URL;
  }
}

/**
 * The published Chrome Web Store listing, or `null` when this deployment has
 * not been given one.
 *
 * `null` is a first-class state, not an error: the extension may not be
 * published yet, and sending people to a fabricated store ID would be a dead
 * link. Callers render an explicit "coming soon" affordance instead. Once the
 * real listing URL is placed in production configuration, the same code starts
 * linking to it with no edit.
 */
export function chromeExtensionUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:") return null;
    if (!CHROME_WEB_STORE_HOSTS.has(url.hostname.toLowerCase())) return null;
    // A bare store origin is not a listing.
    if (url.pathname === "/" || url.pathname === "") return null;
    return url.toString();
  } catch {
    return null;
  }
}
