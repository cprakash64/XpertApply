/**
 * Where XpertApply may open its assistant by itself.
 *
 * Opening is only ever offered on an origin Chrome has granted and on a recognised application
 * page. This list is the user's off switch: an origin on it never opens the assistant
 * automatically, whatever else is true. It stores origins only.
 */
export const DISABLED_ORIGINS_KEY = "xaAutoOpenDisabledOrigins";

type Area = Pick<chrome.storage.StorageArea, "get" | "set">;

async function read(area: Area): Promise<string[]> {
  const stored = await area.get(DISABLED_ORIGINS_KEY);
  const value = stored[DISABLED_ORIGINS_KEY];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function isAutoOpenDisabled(origin: string, area: Area = chrome.storage.local): Promise<boolean> {
  return (await read(area)).includes(origin);
}

export async function setAutoOpenDisabled(origin: string, disabled: boolean, area: Area = chrome.storage.local): Promise<void> {
  const current = (await read(area)).filter((item) => item !== origin);
  await area.set({ [DISABLED_ORIGINS_KEY]: disabled ? [...current, origin].slice(-200) : current });
}
