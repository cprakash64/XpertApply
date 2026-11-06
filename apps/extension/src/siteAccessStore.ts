/**
 * What XpertApply remembers about site access, so Chrome is not asked again for something the person
 * already answered (EXT-LIVE-01).
 *
 * Three small records, none of which holds page content, a URL path or an account identifier:
 *
 *  - offered      (storage.session) which tab+origin already got Chrome's passive "wants access" request. It
 *                 used to be an in-memory Set, so every MV3 service-worker suspension (about 30 s idle)
 *                 forgot it and the request was raised again.
 *  - suppressed   (storage.local)   origins the person declined or revoked. A suppressed origin is never
 *                 re-requested passively; only the person's own click on the toolbar button or on an
 *                 Allow control clears it.
 *  - onboarding   (storage.local)   whether the first-run "enable automatic assistance" choice was made.
 *
 * Chrome's permissions API stays the single source of truth for what is GRANTED. This file never records
 * a grant.
 */
type Area = Pick<chrome.storage.StorageArea, "get" | "set">;

export const OFFERED_KEY = "xaSiteAccessOffered";
export const SUPPRESSED_KEY = "xaSiteAccessSuppressed";
export const ONBOARDING_KEY = "xaAtsOnboarding";

const MAX_OFFERED = 400;
const MAX_SUPPRESSED = 200;

export type SuppressionReason = "declined" | "revoked";
export type OnboardingStatus = "enabled" | "declined" | "skipped";
export interface OnboardingRecord { status: OnboardingStatus; at: number }

const local = (): Area => chrome.storage.local;
const session = (): Area => chrome.storage.session ?? chrome.storage.local;

export async function wasOffered(key: string, area: Area = session()): Promise<boolean> {
  const stored = (await area.get(OFFERED_KEY))[OFFERED_KEY];
  return Array.isArray(stored) && stored.includes(key);
}

export async function markOffered(key: string, area: Area = session()): Promise<void> {
  const stored = (await area.get(OFFERED_KEY))[OFFERED_KEY];
  const list = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
  if (list.includes(key)) return;
  await area.set({ [OFFERED_KEY]: [...list, key].slice(-MAX_OFFERED) });
}

export async function forgetOffered(prefix: string, area: Area = session()): Promise<void> {
  const stored = (await area.get(OFFERED_KEY))[OFFERED_KEY];
  if (!Array.isArray(stored)) return;
  await area.set({ [OFFERED_KEY]: stored.filter((item) => typeof item === "string" && !item.startsWith(prefix)) });
}

async function readSuppressed(area: Area): Promise<Record<string, { reason: SuppressionReason; at: number }>> {
  const stored = (await area.get(SUPPRESSED_KEY))[SUPPRESSED_KEY];
  return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, { reason: SuppressionReason; at: number }>) } : {};
}

export async function suppressedReason(pattern: string, area: Area = local()): Promise<SuppressionReason | null> {
  return (await readSuppressed(area))[pattern]?.reason ?? null;
}

export async function suppress(pattern: string, reason: SuppressionReason, now = Date.now(), area: Area = local()): Promise<void> {
  const map = await readSuppressed(area);
  map[pattern] = { reason, at: now };
  const keep = Object.entries(map).sort((a, b) => a[1].at - b[1].at).slice(-MAX_SUPPRESSED);
  await area.set({ [SUPPRESSED_KEY]: Object.fromEntries(keep) });
}

export async function clearSuppression(pattern: string, area: Area = local()): Promise<void> {
  const map = await readSuppressed(area);
  if (!(pattern in map)) return;
  delete map[pattern];
  await area.set({ [SUPPRESSED_KEY]: map });
}

export async function getOnboarding(area: Area = local()): Promise<OnboardingRecord | null> {
  const stored = (await area.get(ONBOARDING_KEY))[ONBOARDING_KEY] as Partial<OnboardingRecord> | undefined;
  return stored && (stored.status === "enabled" || stored.status === "declined" || stored.status === "skipped") && typeof stored.at === "number"
    ? { status: stored.status, at: stored.at } : null;
}

export async function setOnboarding(status: OnboardingStatus, now = Date.now(), area: Area = local()): Promise<void> {
  await area.set({ [ONBOARDING_KEY]: { status, at: now } });
}
