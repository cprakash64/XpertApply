/**
 * First-party Web origins that may run the page-to-extension launch bridge.
 *
 * Production and development are deliberately separate. The production list
 * is also used to generate the shipped manifest; loopback is added only by an
 * explicit development/E2E build profile.
 */
export const PRODUCTION_BRIDGE_ORIGINS = Object.freeze([
  "https://xpertapply.com",
  "https://www.xpertapply.com"
]);
