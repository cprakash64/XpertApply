import type { LaunchViewState } from "./messages";

export interface PermissionFlowDeps {
  workflowTabIds(): Promise<number[]>;
  getView(tabId: number): Promise<LaunchViewState | null>;
  patchView(tabId: number, patch: Partial<LaunchViewState>): Promise<unknown>;
  /** Re-checks Chrome, records the result and resumes the workflow (applySiteAccessResult). */
  applySiteAccessResult(tabId: number, pattern: string, granted: boolean): Promise<unknown>;
}

/**
 * Chrome says origins were granted or revoked, whichever UI did it (its host-access prompt, the
 * extensions menu, the side panel). A grant resumes every workflow tab that was waiting on exactly
 * that origin; a revocation puts a granted tab back to "access required" so nothing keeps acting on
 * a page Chrome no longer lets us read. Tabs on other origins, and tabs already in the target state,
 * are left alone, so a repeated event never repeats work.
 */
export function createPermissionsChangedHandler(deps: PermissionFlowDeps) {
  return async function permissionsChanged(origins: readonly string[], granted: boolean): Promise<void> {
    if (origins.length === 0) return;
    for (const tabId of await deps.workflowTabIds()) {
      const view = await deps.getView(tabId);
      const pattern = view?.siteAccessPattern;
      if (!view || !pattern || !origins.includes(pattern)) continue;
      if (granted && view.siteAccess !== "site_access_granted") {
        await deps.applySiteAccessResult(tabId, pattern, true).catch(() => undefined);
      } else if (!granted && view.siteAccess === "site_access_granted") {
        await deps.patchView(tabId, { siteAccess: "site_access_required" }).catch(() => undefined);
      }
    }
  };
}
