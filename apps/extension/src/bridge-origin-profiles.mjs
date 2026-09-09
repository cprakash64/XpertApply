import { PRODUCTION_BRIDGE_ORIGINS } from "./bridge-origins.mjs";
import { DEVELOPMENT_BRIDGE_ORIGINS } from "./development-bridge-origins.mjs";

export function assertProductionBridgeOrigins(origins) {
  const expected = ["https://xpertapply.com", "https://www.xpertapply.com"];
  if (origins.length !== expected.length || origins.some((origin, index) => origin !== expected[index])) {
    throw new Error(`Unsafe production bridge origins: ${origins.join(", ")}`);
  }
}

export function bridgeOriginsForProfile(profile) {
  assertProductionBridgeOrigins(PRODUCTION_BRIDGE_ORIGINS);
  if (profile === "production") return [...PRODUCTION_BRIDGE_ORIGINS];
  if (profile === "development" || profile === "e2e") {
    return [...PRODUCTION_BRIDGE_ORIGINS, ...DEVELOPMENT_BRIDGE_ORIGINS];
  }
  throw new Error(`Unsupported extension build profile: ${profile}`);
}

export function bridgeMatchPatternsForProfile(profile) {
  return bridgeOriginsForProfile(profile).map((origin) => `${origin}/*`);
}
