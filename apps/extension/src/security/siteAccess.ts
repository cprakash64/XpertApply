/**
 * Chrome host access, as a thing XpertApply asks for rather than a thing it
 * has.
 *
 * The finding this exists to fix (XA-06)
 * --------------------------------------
 * The extension shipped a wildcard `https` host permission and a content
 * script matching every `https` page in every frame. Installing it therefore granted
 * XpertApply the ability to read and script every website the user visits,
 * before they had asked it to do anything. The dormancy gate (Stage 3A) meant
 * the script did not ACT on unrelated pages — but the authority was real,
 * present from the moment of install, and a bug anywhere in that gate exposed
 * every site at once.
 *
 * The model now
 * -------------
 * Installing grants nothing about employer sites. A specific origin is
 * requested only when the user has started a workflow that needs it, and only
 * that origin. Chrome's own permission check then enforces the boundary: with
 * no grant, `scripting.executeScript` cannot inject and the content script is
 * not present at all — a stronger guarantee than a script that is present and
 * declines to act.
 *
 * Two constraints from the platform shape everything here:
 *
 *   • `chrome.permissions.request()` must run inside a user gesture and cannot
 *     run in a service worker. The side panel is the one XpertApply surface
 *     that is an extension page AND has a user gesture, so it is where the
 *     request happens; the worker only ever CHECKS.
 *
 *   • `activeTab` is revoked on cross-origin navigation, and an assisted apply
 *     deliberately crosses origins (employer → ATS → login → form). It cannot
 *     carry a workflow, so optional origin grants do.
 */

/** Schemes an application can legitimately live on. */
const WEB_SCHEMES = new Set(["https:", "http:"]);

/** Loopback hosts, the only ones allowed to be plain http. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The narrowest Chrome match pattern that covers exactly one origin.
 *
 * Deliberately NOT a domain wildcard: `jobs.example.com` yields
 * `https://jobs.example.com/*`, never `https://*.example.com/*`. A workflow
 * that genuinely needs a sibling subdomain asks for that subdomain when it
 * reaches it, which is one more prompt and a great deal less authority.
 *
 * Returns null — meaning "do not ask for anything" — for every input that is
 * not a plain web origin: `javascript:`, `data:`, `file:`, `chrome:`,
 * `chrome-extension:`, a URL carrying credentials, a non-loopback http URL, or
 * anything unparseable.
 */
export function originPatternFor(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!WEB_SCHEMES.has(url.protocol)) return null;
  // Credentials in a URL are a phishing shape and have no place in a permission
  // pattern; Chrome would reject the pattern anyway.
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  // A wildcard smuggled through a hostname must never reach a match pattern.
  if (host.includes("*")) return null;
  if (url.protocol === "http:" && !LOOPBACK.has(host)) return null;
  // Chrome match patterns do not carry a port; the origin's host is the unit.
  return `${url.protocol}//${host}/*`;
}

/** Human-readable origin for the side panel's prompt. Never a full URL — a
 * path can carry an application id or an e-mail in a query string. */
export function displayOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return WEB_SCHEMES.has(url.protocol) ? url.host : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// Access state
// --------------------------------------------------------------------------- //

/**
 * Where a workflow stands with respect to Chrome host access.
 *
 * Explicit rather than a boolean because "we have not asked yet", "the user
 * said no" and "this origin cannot be asked for at all" need different
 * handling, and collapsing them is how a permission loop or a silent stall
 * gets built.
 */
export type SiteAccessState =
  /** No workflow is running; nothing is needed. */
  | "no_workflow"
  /** The workflow needs this origin and does not have it. */
  | "site_access_required"
  /** Chrome has granted this origin. */
  | "site_access_granted"
  /** The user declined. The workflow stops rather than re-asking. */
  | "site_access_denied"
  /** The URL is not something a permission can be requested for. */
  | "site_access_unavailable";

export interface SiteAccessNeed {
  state: SiteAccessState;
  /** Match pattern to request, when one can be formed. */
  pattern: string | null;
  /** Host shown to the user. */
  origin: string | null;
  /** Which part of the workflow needs it — the top-level page or one frame. */
  scope: "page" | "frame";
}

export const NO_ACCESS_NEEDED: SiteAccessNeed = {
  state: "no_workflow",
  pattern: null,
  origin: null,
  scope: "page"
};

/**
 * Decide what a URL needs, given whether Chrome already grants it.
 *
 * Pure so the decision can be tested without a browser; the caller supplies the
 * result of `chrome.permissions.contains`.
 */
export function siteAccessNeedFor(
  url: string | null | undefined,
  hasPermission: boolean,
  scope: "page" | "frame" = "page"
): SiteAccessNeed {
  const pattern = originPatternFor(url);
  if (!pattern) {
    return { state: "site_access_unavailable", pattern: null, origin: displayOrigin(url), scope };
  }
  return {
    state: hasPermission ? "site_access_granted" : "site_access_required",
    pattern,
    origin: displayOrigin(url),
    scope
  };
}
