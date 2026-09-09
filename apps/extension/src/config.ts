/** Extension configuration. The API base can be overridden via extension
 * storage for staging/production without rebuilding. */
import {
  PRODUCTION_BRIDGE_ORIGINS
} from "./bridge-origins.mjs";

declare const __XPERTAPPLY_BRIDGE_ORIGINS__: readonly string[];

// export const DEFAULT_API_BASE = "http://localhost:8000";
export const DEFAULT_API_BASE = "https://api.xpertapply.com";

export async function getApiBase(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get("apiBase");
    return typeof stored.apiBase === "string" && stored.apiBase ? stored.apiBase : DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
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
