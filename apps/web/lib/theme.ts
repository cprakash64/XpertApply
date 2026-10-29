/**
 * Theme preference: "light", "dark" or "system" (follow the OS).
 *
 * The stored choice lives in localStorage under one key and belongs to the
 * signed-in application. With no stored choice the app is light; "system" is an
 * explicit, stored choice like the others. The public website (homepage, pricing,
 * login, signup, info and auth pages) is ALWAYS light: `data-theme` on <html> is resolved from
 * the route first and the preference second, and the stored choice is never
 * rewritten by visiting a public page.
 *
 * `public/theme-init.js` does this resolution before first paint; this module
 * does the same after that, on route changes and on OS or cross-tab changes. The
 * two share one rule (the list below), kept in step by a unit test. Every read
 * and write is guarded: storage can throw in a private window.
 */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "xa-theme";

/**
 * The signed-in application. Only these routes follow the saved theme; every
 * other path is public and light. A new top-level app route must be added here
 * AND to public/theme-init.js (a test compares them).
 */
export const THEMED_ROUTE_PREFIXES = [
  "/dashboard",
  "/jobs",
  "/matches",
  "/tracker",
  "/profile",
  "/resume",
  "/cover-letter",
  "/application-answers",
  "/demographics",
  "/settings",
  "/design-system-specimen"
] as const;

export function isThemedPath(pathname: string): boolean {
  return THEMED_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** The theme a path renders in: light on public routes, the preference in the app. */
export function themeForPath(pathname: string, preference: ThemePreference): "light" | "dark" {
  return isThemedPath(pathname) ? resolveTheme(preference) : "light";
}
const QUERY = "(prefers-color-scheme: dark)";

/**
 * The approved appearance is light: with no stored choice (a new user, or storage
 * that is unavailable) the app is light. "system" is an explicit, stored choice.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "light";

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    /* storage unavailable: the default applies */
  }
  return DEFAULT_THEME_PREFERENCE;
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyThemePreference(
  preference: ThemePreference,
  pathname: string = window.location.pathname
): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", themeForPath(pathname, preference));
  root.setAttribute("data-theme-pref", preference);
}

export function storeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
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
