/**
 * Where the signed-in user's access token lives in the browser.
 *
 * The VALUE is deliberately not the product's current name.
 *
 * `jobpilot_token` is the key every existing session was written under, and
 * localStorage is not migrated by a deploy: the moment the running app reads a
 * different key, every already-signed-in user is silently signed out and lands
 * on the login screen with no explanation. A cosmetic rename is not worth that,
 * and the string is invisible to users — it appears only in devtools.
 *
 * The key was previously repeated as a literal in six modules, which is what
 * made it feel like a rename target. It is a single exported constant now, so
 * the compatibility decision is stated once, here, and cannot drift.
 *
 * If it ever does need to change, do it as a migration and not a rename: read
 * the new key, fall back to the legacy key, and write the new one back.
 */
export const AUTH_TOKEN_STORAGE_KEY = "jobpilot_token";

/** The stored access token, or null on the server and when signed out. */
export function readAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
}
