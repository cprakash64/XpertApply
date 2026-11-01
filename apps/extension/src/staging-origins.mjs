/**
 * STAGING endpoints. Imported only by the build (build.mjs, bridge-origin-profiles.mjs) and tests; the runtime reads
 * them solely through build-time `define` values, so a production bundle never contains these strings.
 */
export const STAGING_WEB_ORIGIN = "https://staging.xpertapply.com";
export const STAGING_API_ORIGIN = "https://api-staging.xpertapply.com";
export const STAGING_BRIDGE_ORIGINS = Object.freeze([STAGING_WEB_ORIGIN]);

export function assertStagingBridgeOrigins(origins) {
  if (origins.length !== 1 || origins[0] !== STAGING_WEB_ORIGIN) {
    throw new Error(`Unsafe staging bridge origins: ${origins.join(", ")}`);
  }
}
