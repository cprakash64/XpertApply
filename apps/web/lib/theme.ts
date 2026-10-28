/**
 * Theme preference: "light", "dark" or "system" (follow the OS).
 *
 * The stored choice lives in localStorage under one key. `public/theme-init.js`
 * resolves it to `data-theme` ("light" | "dark") on <html> before first paint;
 * this module does the same thing after that, for changes made while the page is
 * open. Every read and write is guarded: storage can throw in a private window.
 */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "xa-theme";
const QUERY = "(prefers-color-scheme: dark)";

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage unavailable: follow the OS */
  }
  return "system";
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveTheme(preference));
  root.setAttribute("data-theme-pref", preference);
}

export function storeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* the choice still applies for this page view */
  }
}

const CHANGE_EVENT = "xa-theme-change";

/** Re-applies the stored choice when the OS preference or another tab changes it. */
export function watchTheme(onChange?: () => void): () => void {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
  const sync = () => {
    applyThemePreference(readThemePreference());
    onChange?.();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) sync();
  };
  media?.addEventListener("change", sync);
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, sync);
  return () => {
    media?.removeEventListener("change", sync);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, sync);
  };
}

/** Stores, applies and announces a choice (so every mounted control updates). */
export function setThemePreference(preference: ThemePreference): void {
  storeThemePreference(preference);
  applyThemePreference(preference);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
