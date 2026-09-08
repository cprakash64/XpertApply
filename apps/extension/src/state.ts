/**
 * Runtime launch metadata, view progress, and sensitive session packages use
 * chrome.storage.session. They survive ordinary MV3 worker suspension without
 * becoming durable browser-restart authority. Chrome host grants persist
 * separately and are re-reconciled against a fresh workflow/frame inventory.
 *
 * Everything is keyed by the exact employer tab id, so a launch is never
 * associated by "active tab" and the user switching tabs cannot cross wires.
 */

import type { ApplicationSessionData } from "./types";
import type { LaunchViewState, PendingLaunch } from "./messages";

const PENDING_KEY = "pendingLaunches";
const PACKAGE_KEY = "sessionPackages";
const VIEW_KEY = "viewStates";

/**
 * One service-worker lifetime owns one monotonic account-authority epoch.
 * Promises cannot survive worker destruction, while persisted workflow state is
 * defensively purged on browser startup.  Within a worker lifetime every write
 * is serialized here, so advancing the epoch synchronously makes queued stale
 * work fail before it can mutate storage.
 */
export type AuthorityGeneration = number;
let authorityGeneration: AuthorityGeneration = 0;
let mutationTail: Promise<void> = Promise.resolve();
const endedSessionIds = new Set<number>();

export class StaleAuthorityError extends Error {
  constructor() {
    super("STALE_AUTHORITY_GENERATION");
  }
}

export function captureAuthorityGeneration(): AuthorityGeneration {
  return authorityGeneration;
}

export function advanceAuthorityGeneration(): AuthorityGeneration {
  authorityGeneration += 1;
  // Session ids belong to an account authority generation. A replacement
  // account may legitimately receive the same numeric id from the backend.
  endedSessionIds.clear();
  return authorityGeneration;
}

export function endSessionAuthority(sessionId: number): void {
  endedSessionIds.add(sessionId);
}

export function isSessionAuthorityActive(sessionId: number): boolean {
  return !endedSessionIds.has(sessionId);
}

function assertSessionAuthority(sessionId: number | null): void {
  if (sessionId !== null && !isSessionAuthorityActive(sessionId)) throw new StaleAuthorityError();
}

export function isAuthorityGenerationCurrent(generation: AuthorityGeneration): boolean {
  return generation === authorityGeneration;
}

export async function withAuthorityMutation<T>(
  generation: AuthorityGeneration,
  mutation: () => Promise<T>
): Promise<T> {
  let release!: () => void;
  const previous = mutationTail;
  mutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    if (!isAuthorityGenerationCurrent(generation)) throw new StaleAuthorityError();
    return await mutation();
  } finally {
    release();
  }
}

export interface SessionPackage {
  sessionToken: string;
  session: ApplicationSessionData;
  cachedAt: number;
}

type Map<T> = Record<string, T>;

function workflowStorage(): chrome.storage.StorageArea {
  // Tab bindings, progress, frame-derived status and the active handoff are
  // runtime authority, not user authority. storage.session survives ordinary
  // MV3 worker suspension but Chrome clears it when the browser/extension
  // runtime is restarted. The local fallback exists only for older test/dev
  // environments that do not implement storage.session.
  return chrome.storage.session ?? chrome.storage.local;
}

async function getMap<T>(key: string): Promise<Map<T>> {
  try {
    const store = await workflowStorage().get(key);
    const value = store[key];
    return value && typeof value === "object" ? (value as Map<T>) : {};
  } catch {
    return {};
  }
}

function packageStorage(): chrome.storage.StorageArea {
  // storage.session is present on supported MV3 Chrome. The fallback keeps the
  // test harness and older development browsers usable; production Chrome uses
  // session-only memory for password-bearing packages.
  return chrome.storage.session ?? chrome.storage.local;
}

async function getPackageMap(): Promise<Map<SessionPackage>> {
  try {
    const store = await packageStorage().get(PACKAGE_KEY);
    const value = store[PACKAGE_KEY];
    return value && typeof value === "object" ? value as Map<SessionPackage> : {};
  } catch {
    return {};
  }
}

const ACTIVE_KEY = "activeAssistedApplyHandoffV1";

/** A handoff persisted by an older/incompatible build of the extension can be
 * missing fields the current code assumes are always present (this key
 * literally has "V1" in it from a prior schema generation). Rather than let a
 * malformed record crash downstream matching/rendering code, treat it as
 * absent — the caller sees "no handoff" (HANDOFF_NOT_FOUND) instead of a
 * thrown error, and the stale record is dropped the next time cleanup runs. */
export function isValidHandoffShape(value: unknown): value is PendingLaunch {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PendingLaunch>;
  return (
    typeof v.applicationId === "string" &&
    typeof v.officialUrl === "string" &&
    typeof v.launchToken === "string" &&
    typeof v.sessionId === "number" &&
    typeof v.expiresAt === "number" &&
    typeof v.protocolVersion === "number"
  );
}

export async function putActive(launch: PendingLaunch, generation = captureAuthorityGeneration()): Promise<void> {
  await withAuthorityMutation(generation, () => {
    assertSessionAuthority(launch.sessionId);
    return workflowStorage().set({ [ACTIVE_KEY]: launch });
  });
}

export async function getActive(): Promise<PendingLaunch | null> {
  const store = await workflowStorage().get(ACTIVE_KEY);
  const value = store[ACTIVE_KEY];
  return isValidHandoffShape(value) ? value : null;
}

export async function findPendingByApplication(applicationId: string): Promise<{ tabId: number; launch: PendingLaunch } | null> {
  const map = await getMap<PendingLaunch>(PENDING_KEY);
  for (const [tabId, launch] of Object.entries(map)) {
    if (launch.applicationId === applicationId) return { tabId: Number(tabId), launch };
  }
  return null;
}

// --- PendingLaunch ---------------------------------------------------------- //
export async function putPending(tabId: number, launch: PendingLaunch, generation = captureAuthorityGeneration()): Promise<void> {
  await withAuthorityMutation(generation, async () => {
    assertSessionAuthority(launch.sessionId);
    const map = await getMap<PendingLaunch>(PENDING_KEY);
    const next = { ...launch, targetTabId: tabId };
    map[String(tabId)] = next;
    const active = await getActive();
    const update: Record<string, unknown> = { [PENDING_KEY]: map };
    if (!active || active.requestId === launch.requestId) update[ACTIVE_KEY] = next;
    await workflowStorage().set(update);
  });
}

export async function getPending(tabId: number): Promise<PendingLaunch | null> {
  const map = await getMap<PendingLaunch>(PENDING_KEY);
  const value = map[String(tabId)];
  return isValidHandoffShape(value) ? value : null;
}

/** A launch created before its tab id was known (found by requestId). */
export async function findPendingByRequest(requestId: string): Promise<{ tabId: number; launch: PendingLaunch } | null> {
  const map = await getMap<PendingLaunch>(PENDING_KEY);
  for (const [tabId, launch] of Object.entries(map)) {
    if (launch.requestId === requestId) return { tabId: Number(tabId), launch };
  }
  return null;
}

export async function updatePending(tabId: number, patch: Partial<PendingLaunch>, generation = captureAuthorityGeneration()): Promise<void> {
  await withAuthorityMutation(generation, async () => {
    const map = await getMap<PendingLaunch>(PENDING_KEY);
    const existing = map[String(tabId)];
    if (!existing) return;
    assertSessionAuthority(existing.sessionId);
    const next = { ...existing, ...patch };
    map[String(tabId)] = next;
    const active = await getActive();
    const update: Record<string, unknown> = { [PENDING_KEY]: map };
    if (!active || active.requestId === next.requestId) update[ACTIVE_KEY] = next;
    await workflowStorage().set(update);
  });
}

// --- SessionPackage (cached to survive the single-use launch token) --------- //
/**
 * Find an existing package for the SAME application session, on any tab.
 *
 * The session token is a property of the SESSION, not of a tab — caching it per
 * tab id was the design error behind the live "lost the application connection"
 * failure. The launch token that mints it is single-use, so any tab that binds
 * itself without inheriting the package (the getActive() self-bind path in
 * handleContentReady) would re-exchange a spent token and get a 401, which the
 * widget then reported as a lost/invalid session on a perfectly healthy one.
 *
 * Reusing the session-scoped package makes that second exchange unnecessary.
 */
export async function findPackageForSession(sessionId: number): Promise<SessionPackage | null> {
  const map = await getPackageMap();
  for (const pkg of Object.values(map)) {
    if (pkg?.session?.sessionId === sessionId) return pkg;
  }
  return null;
}

export async function putPackage(tabId: number, pkg: SessionPackage, generation = captureAuthorityGeneration()): Promise<void> {
  await withAuthorityMutation(generation, async () => {
    assertSessionAuthority(pkg.session.sessionId);
    const map = await getPackageMap();
    map[String(tabId)] = pkg;
    await packageStorage().set({ [PACKAGE_KEY]: map });
  });
}

export async function getPackage(tabId: number): Promise<SessionPackage | null> {
  const map = await getPackageMap();
  return map[String(tabId)] ?? null;
}

export async function findPackageBySession(sessionId: number): Promise<SessionPackage | null> {
  const map = await getPackageMap();
  return Object.values(map).find((pkg) => pkg.session.sessionId === sessionId) ?? null;
}

// --- View state (what the side panel renders) ------------------------------- //
export async function putView(tabId: number, view: LaunchViewState, generation = captureAuthorityGeneration()): Promise<void> {
  await withAuthorityMutation(generation, async () => {
    assertSessionAuthority(view.sessionId);
    const map = await getMap<LaunchViewState>(VIEW_KEY);
    map[String(tabId)] = { ...view, tabId, updatedAt: Date.now() };
    await workflowStorage().set({ [VIEW_KEY]: map });
  });
}

export async function getView(tabId: number): Promise<LaunchViewState | null> {
  const map = await getMap<LaunchViewState>(VIEW_KEY);
  return map[String(tabId)] ?? null;
}

export async function patchView(tabId: number, patch: Partial<LaunchViewState>, generation = captureAuthorityGeneration()): Promise<LaunchViewState | null> {
  return withAuthorityMutation(generation, async () => {
    const map = await getMap<LaunchViewState>(VIEW_KEY);
    const existing = map[String(tabId)];
    if (!existing) return null;
    assertSessionAuthority(existing.sessionId);
    const next = { ...existing, ...patch, tabId, updatedAt: Date.now() };
    map[String(tabId)] = next;
    await workflowStorage().set({ [VIEW_KEY]: map });
    return next;
  });
}

export function initialView(tabId: number, launch: PendingLaunch, company: string | null, jobTitle: string | null): LaunchViewState {
  return {
    tabId,
    requestId: launch.requestId,
    sessionId: launch.sessionId,
    state: launch.state,
    company,
    jobTitle,
    atsId: launch.atsType,
    atsDisplayName: null,
    limited: false,
    fieldsDiscovered: 0,
    filled: 0,
    skipped: 0,
    reviewRequired: 0,
    resumeStatus: "pending",
    coverStatus: "pending",
    reachedFinalStep: false,
    contentReady: false,
    packageLoaded: false,
    running: false,
    failureCode: null,
    failureMessage: null,
    failureRecoverable: null,
    siteAccess: "no_workflow",
    siteAccessPattern: null,
    siteAccessOrigin: null,
    siteAccessScope: "page",
    siteAccessFramePathShape: null,
    updatedAt: Date.now()
  };
}

// --- Cleanup ---------------------------------------------------------------- //
/** Exact application tabs that may still contain XpertApply-owned form state. */
export async function workflowTabIds(): Promise<number[]> {
  const [pending, views, packages] = await Promise.all([
    getMap<PendingLaunch>(PENDING_KEY),
    getMap<LaunchViewState>(VIEW_KEY),
    getPackageMap()
  ]);
  const ids = new Set([...Object.keys(pending), ...Object.keys(views), ...Object.keys(packages)]);
  return [...ids]
    .map(Number)
    .filter((tabId) => Number.isInteger(tabId) && tabId >= 0);
}

/** Remove every workflow binding and token-bearing package for the web account. */
export async function clearAllWorkflowState(generation = captureAuthorityGeneration()): Promise<void> {
  await withAuthorityMutation(generation, async () => {
    const workflow = workflowStorage();
    await workflow.remove(ACTIVE_KEY);
    await workflow.remove(PENDING_KEY);
    await workflow.remove(VIEW_KEY);
    if (packageStorage() !== workflow) await packageStorage().remove(PACKAGE_KEY);
    else await workflow.remove(PACKAGE_KEY);
  });
}

/** Remove one completed application session without disturbing other tabs. */
export async function clearWorkflowSession(sessionId: number, generation = captureAuthorityGeneration()): Promise<number[]> {
  return withAuthorityMutation(generation, async () => {
    const [pending, views, packages, active] = await Promise.all([
      getMap<PendingLaunch>(PENDING_KEY),
      getMap<LaunchViewState>(VIEW_KEY),
      getPackageMap(),
      getActive()
    ]);
    const tabIds = new Set<number>();
    for (const [tabId, launch] of Object.entries(pending)) {
      if (launch.sessionId !== sessionId) continue;
      tabIds.add(Number(tabId));
      delete pending[tabId];
    }
    for (const [tabId, view] of Object.entries(views)) {
      if (view.sessionId !== sessionId) continue;
      tabIds.add(Number(tabId));
      delete views[tabId];
    }
    for (const [tabId, pkg] of Object.entries(packages)) {
      if (pkg.session.sessionId !== sessionId) continue;
      tabIds.add(Number(tabId));
      delete packages[tabId];
    }
    await workflowStorage().set({ [PENDING_KEY]: pending, [VIEW_KEY]: views });
    await packageStorage().set({ [PACKAGE_KEY]: packages });
    if (active?.sessionId === sessionId) await workflowStorage().remove(ACTIVE_KEY);
    return [...tabIds].filter((tabId) => Number.isInteger(tabId) && tabId >= 0);
  });
}

export async function clearTab(tabId: number, generation = captureAuthorityGeneration()): Promise<void> {
  await withAuthorityMutation(generation, async () => {
    for (const key of [PENDING_KEY, VIEW_KEY]) {
      const map = await getMap<unknown>(key);
      if (String(tabId) in map) {
        delete map[String(tabId)];
        await workflowStorage().set({ [key]: map });
      }
    }
    const packages = await getPackageMap();
    if (String(tabId) in packages) {
      delete packages[String(tabId)];
      await packageStorage().set({ [PACKAGE_KEY]: packages });
    }
  });
}

export async function cleanupExpired(now = Date.now()): Promise<void> {
  const generation = captureAuthorityGeneration();
  await withAuthorityMutation(generation, async () => {
    const pending = await getMap<PendingLaunch>(PENDING_KEY);
    const expiredTabs = Object.entries(pending).filter(([, launch]) => launch.expiresAt <= now).map(([tabId]) => tabId);
    for (const tabId of expiredTabs) delete pending[tabId];
    if (expiredTabs.length) {
      await workflowStorage().set({ [PENDING_KEY]: pending });
      const views = await getMap<unknown>(VIEW_KEY);
      for (const tabId of expiredTabs) delete views[tabId];
      await workflowStorage().set({ [VIEW_KEY]: views });
      const packages = await getPackageMap();
      for (const tabId of expiredTabs) delete packages[tabId];
      await packageStorage().set({ [PACKAGE_KEY]: packages });
    }
    const active = await getActive();
    if (active && active.expiresAt <= now) await workflowStorage().remove(ACTIVE_KEY);
  });
}

export const STORAGE_KEYS = { PENDING_KEY, PACKAGE_KEY, VIEW_KEY, ACTIVE_KEY };
