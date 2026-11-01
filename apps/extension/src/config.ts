/** Extension configuration. The API base can be overridden via extension
 * storage for staging/production without rebuilding. */
import {
  PRODUCTION_BRIDGE_ORIGINS
} from "./bridge-origins.mjs";

declare const __XPERTAPPLY_BRIDGE_ORIGINS__: readonly string[];

declare const __XPERTAPPLY_PROFILE__: string | undefined;
declare const __XPERTAPPLY_DEFAULT_API_BASE__: string | undefined;
declare const __XPERTAPPLY_STRICT_API_ORIGINS__: readonly string[] | null | undefined;

/** Which build this is. Unit tests and any unbundled use read as "production", the historical default. */
export const BUILD_PROFILE = typeof __XPERTAPPLY_PROFILE__ !== "undefined" ? __XPERTAPPLY_PROFILE__ : "production";

// export const DEFAULT_API_BASE = "http://localhost:8000";
/** The API this build talks to unless told otherwise. Staging bakes in the staging API: it never defaults to production. */
export const DEFAULT_API_BASE = typeof __XPERTAPPLY_DEFAULT_API_BASE__ !== "undefined"
  ? __XPERTAPPLY_DEFAULT_API_BASE__
  : "https://api.xpertapply.com";

/** When non-null (staging), the ONLY API origins this build will send a credential to. null keeps the legacy behaviour. */
const STRICT_API_ORIGINS: readonly string[] | null = typeof __XPERTAPPLY_STRICT_API_ORIGINS__ !== "undefined"
  ? __XPERTAPPLY_STRICT_API_ORIGINS__
  : null;

/**
 * Pure policy for the stored `apiBase` override. A strict build (staging) accepts a stored value only when its exact
 * origin is on the build's list, so a stray or injected value can neither redirect tokens to another host nor quietly
 * point staging at production. Everything else, the value is ignored and the baked-in default applies.
 */
export function resolveApiBase(stored: unknown, strictOrigins: readonly string[] | null, fallback: string): string {
  if (typeof stored !== "string" || !stored) return fallback;
  if (strictOrigins === null) return stored;
  try {
    const url = new URL(stored);
    return url.origin === stored.replace(/\/+$/, "") && strictOrigins.includes(url.origin) ? url.origin : fallback;
  } catch {
    return fallback;
  }
}

export async function getApiBase(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get("apiBase");
    return resolveApiBase(stored.apiBase, STRICT_API_ORIGINS, DEFAULT_API_BASE);
  } catch {
    return DEFAULT_API_BASE;
  }
}

/** The website the sign-in window opens: a stored override counts only if it is one of this build's trusted origins. */
export function resolveWebBase(stored: unknown, trustedOrigins: readonly string[]): string {
  return typeof stored === "string" && trustedOrigins.includes(stored) ? stored : trustedOrigins[0];
}

/** Origins allowed to hand a launch token to the extension. Kept in sync with
 * the manifest `content_scripts`, `host_permissions`, and `externally_connectable`
 * so the XpertApply-origin role only activates on trusted first-party origins.
 * The constant name is likewise unchanged — it is an internal identifier, not a
 * user-visible string, and renaming it would churn every call site for nothing. */
export const JOBPILOT_WEB_ORIGINS = typeof __XPERTAPPLY_BRIDGE_ORIGINS__ !== "undefined"
  ? [...__XPERTAPPLY_BRIDGE_ORIGINS__]
  : [...PRODUCTION_BRIDGE_ORIGINS];

/** Canonical current production Web origins. The API origin is not a Web app. */
export const XPERTAPPLY_PRODUCTION_WEB_ORIGINS = [...PRODUCTION_BRIDGE_ORIGINS];
export function isApprovedJobPilotOrigin(origin: string): boolean {
  return JOBPILOT_WEB_ORIGINS.includes(origin);
}

import type { Capability } from "./messages";

/** What this build advertises in the detection handshake. */
export const EXTENSION_CAPABILITIES: Capability[] = [
  "fill",
  "upload",
  "results",
  "ashby",
  "greenhouse",
  "lever",
  "workday",
  "generic"
];
