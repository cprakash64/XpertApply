/**
 * First-use disclosure for the toolbar (activeTab) path.
 *
 * The marker is a bare version number: it records WHICH wording the user
 * accepted, never anything about a page. Raising TOOLBAR_DISCLOSURE_VERSION
 * after a material wording change makes every earlier acceptance stale, so the
 * revised disclosure is shown again before the page is read.
 */
export const TOOLBAR_DISCLOSURE_VERSION = 1;
export const TOOLBAR_DISCLOSURE_KEY = "toolbarDisclosureAcceptedVersion";

export async function toolbarDisclosureAccepted(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(TOOLBAR_DISCLOSURE_KEY);
    const accepted = stored[TOOLBAR_DISCLOSURE_KEY];
    return typeof accepted === "number" && accepted >= TOOLBAR_DISCLOSURE_VERSION;
  } catch {
    // Unreadable means unaccepted: the page is not read without a recorded yes.
    return false;
  }
}

export async function recordToolbarDisclosureAccepted(): Promise<void> {
  await chrome.storage.local.set({ [TOOLBAR_DISCLOSURE_KEY]: TOOLBAR_DISCLOSURE_VERSION });
}
