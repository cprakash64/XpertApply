import { MSG } from "./messages";
import { toolbarDisclosureAccepted } from "./toolbarDisclosure";
import { originPatternFor } from "./security/siteAccess";
import { providerForUrl } from "./ats/providers";
import { grantPatternFor } from "./siteGrants";

export const TOOLBAR_OVERLAY_BUNDLE = "overlayBootstrap.js";

export function toolbarTarget(tab: chrome.tabs.Tab): { tabId: number; url: URL } | null {
  if (!Number.isInteger(tab.id) || tab.id == null || tab.id < 0 || !tab.url) return null;
  try {
    const url = new URL(tab.url);
    return url.protocol === "https:" || url.protocol === "http:" ? { tabId: tab.id, url } : null;
  } catch {
    return null;
  }
}

/** Explicit action-click path only. activeTab authorizes bootstrap injection;
 * it does not alter persistent exact-origin permission state.
 *
 * Only the static bootstrap is injected here. The workflow engine (content.js)
 * is what reads the page, so it is injected by continueToolbarOverlay, which
 * runs only after the user has accepted the first-use disclosure. */
export async function showToolbarOverlay(tab: chrome.tabs.Tab): Promise<boolean> {
  const target = toolbarTarget(tab);
  if (!target) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: target.tabId, frameIds: [0] },
      files: [TOOLBAR_OVERLAY_BUNDLE]
    });
    if (!(await toolbarDisclosureAccepted())) {
      await chrome.tabs.sendMessage(target.tabId, { type: MSG.SHOW_TOOLBAR_DISCLOSURE }, { frameId: 0 });
      return true;
    }
    return await continueToolbarOverlay(target.tabId);
  } catch {
    return false;
  }
}

/** Load the workflow engine and mount the assistant. Callers must already hold
 * a recorded disclosure acceptance. */
export async function continueToolbarOverlay(tabId: number): Promise<boolean> {
  try {
    // The overlay is only a presentation surface. Load the same qualified
    // workflow engine used by prepared launches after the toolbar marker is in
    // place; bootstrap.ts sees that marker and performs read-only discovery,
    // never form mutation, until the user explicitly asks to fill.
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["content.js"]
    });
    await chrome.tabs.sendMessage(tabId, { type: MSG.SHOW_APPLICATION_OVERLAY }, { frameId: 0 });
    return true;
  } catch {
    return false;
  }
}

/** How Chrome answered a gesture-bound request for one exact origin. */
export type OriginRequestOutcome = "granted" | "denied" | "no_gesture" | "unavailable" | "not_requested";

/**
 * Ask Chrome, with its own consent dialog, for exactly the origin of `url`.
 *
 * chrome.permissions.request needs the user's gesture, and an await between the click and the call
 * ends it, so this must be the first thing a click handler does and it must not await first. It
 * resolves without any dialog when the origin is already granted.
 *
 * The three failures are kept apart because they need different answers: the user said no ("denied":
 * say so and offer to ask again), the click's gesture did not reach this call ("no_gesture": fall back
 * to Chrome's own toolbar access request), or the API is missing ("unavailable"). Folding them into
 * one `false` is what left a custom careers domain looping on "Allow" with no dialog ever shown.
 *
 * An exact https host is requested, except for the four supported ATSs (Greenhouse, Lever, Ashby, Workday),
 * where the one grant covers that ATS's own subdomains so the person is not asked again for the next
 * company (siteGrants.ts). Never any other wildcard, never a scheme other than https. The URL is Chrome's
 * own record of the tab, not anything a page supplied.
 */
export function requestOriginInGesture(
  url: string | null | undefined,
  api: Pick<typeof chrome.permissions, "request"> | undefined = typeof chrome === "undefined" ? undefined : chrome.permissions
): Promise<OriginRequestOutcome> {
  const pattern = url ? originPatternFor(url) : null;
  if (!pattern || !/^https:\/\/[a-z0-9][a-z0-9.-]*\/\*$/.test(pattern)) return Promise.resolve("not_requested");
  if (typeof api?.request !== "function") return Promise.resolve("unavailable");
  try {
    return api.request({ origins: [grantPatternFor(pattern)] }).then(
      (granted) => (granted ? "granted" : "denied"),
      (error: unknown) => (/user gesture/i.test(String((error as { message?: string } | null)?.message ?? error)) ? "no_gesture" : "unavailable")
    );
  } catch (error) {
    return Promise.resolve(/user gesture/i.test(String((error as { message?: string } | null)?.message ?? error)) ? "no_gesture" : "unavailable");
  }
}

/**
 * The toolbar click and prepared launches ask only for a KNOWN ATS host. A page that is not one is
 * covered by activeTab for the moment, and the persistent grant is asked for later, from the
 * assistant's own Allow button (see requestOriginInGesture), where the user can see which site it is.
 */
export function requestAtsOriginInGesture(url: string | null | undefined): Promise<boolean> {
  const provider = providerForUrl(url);
  if (!provider || provider.support === "unsupported") return Promise.resolve(false);
  return requestOriginInGesture(url).then((outcome) => outcome === "granted");
}

export function installToolbarOverlayAction(): void {
  chrome.action?.onClicked?.addListener((tab) => {
    // First statement, no await before it: the click is the gesture Chrome's grant dialog needs.
    const asked = requestAtsOriginInGesture(tab.url);
    // Granted, declined or dismissed, the assistant still opens through activeTab; the grant, when it
    // lands, makes the next visit automatic.
    void asked.then(() => showToolbarOverlay(tab));
  });
}

export function disableSidePanelToolbarOpen(): void {
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => undefined);
}
