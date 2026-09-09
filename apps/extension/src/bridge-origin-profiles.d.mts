export function assertProductionBridgeOrigins(origins: readonly string[]): void;
export function bridgeOriginsForProfile(profile: "production" | "development" | "e2e"): string[];
export function bridgeMatchPatternsForProfile(profile: "production" | "development" | "e2e"): string[];
