import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";
import packageJson from "../../package.json";
import {
  EXTENSION_BUILD_OUTPUTS,
  resolveExtensionBuild
} from "../build-profile.mjs";
import {
  assertProductionBridgeOrigins,
  bridgeMatchPatternsForProfile,
  bridgeOriginsForProfile
} from "../bridge-origin-profiles.mjs";
import { DEVELOPMENT_BRIDGE_ORIGINS } from "../development-bridge-origins.mjs";
import { isApprovedJobPilotOrigin, XPERTAPPLY_PRODUCTION_WEB_ORIGINS } from "../config";

describe("XA-15 · production bridge origins", () => {
  const REMOVED_LEGACY_ORIGINS = [
    "https://app.jobpilot.ai",
    "https://ezjobfind.com",
    "https://www.ezjobfind.com"
  ];

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost",
    "http://127.0.0.1",
    "http://[::1]:3000",
    "http://0.0.0.0:3000"
  ])("rejects loopback/development origin %s in production runtime", (origin) => {
    expect(isApprovedJobPilotOrigin(origin)).toBe(false);
  });

  it("keeps only xpertapply.com and www as canonical current Web origins", () => {
    expect(XPERTAPPLY_PRODUCTION_WEB_ORIGINS).toEqual([
      "https://xpertapply.com",
      "https://www.xpertapply.com"
    ]);
    expect(isApprovedJobPilotOrigin("https://api.xpertapply.com")).toBe(false);
  });

  it.each(REMOVED_LEGACY_ORIGINS)("rejects removed legacy bridge origin %s", (origin) => {
    expect(bridgeOriginsForProfile("production")).not.toContain(origin);
    expect(isApprovedJobPilotOrigin(origin)).toBe(false);
    expect(manifest.content_scripts[0]?.matches).not.toContain(`${origin}/*`);
    expect(manifest.host_permissions).not.toContain(`${origin}/*`);
  });

  it("keeps the source manifest production-safe", () => {
    const serialized = JSON.stringify({
      content_scripts: manifest.content_scripts,
      host_permissions: manifest.host_permissions,
      optional_host_permissions: manifest.optional_host_permissions,
      externally_connectable: manifest.externally_connectable
    });
    expect(serialized).not.toMatch(/localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/);
    expect(serialized).not.toMatch(/app\.jobpilot\.ai|(?:www\.)?ezjobfind\.com/);
  });

  it("adds exact loopback bridge origins only for explicit development/E2E profiles", () => {
    const production = bridgeOriginsForProfile("production");
    const development = bridgeOriginsForProfile("development");
    const e2eMatches = bridgeMatchPatternsForProfile("e2e");
    for (const origin of DEVELOPMENT_BRIDGE_ORIGINS) {
      expect(production).not.toContain(origin);
      expect(development).toContain(origin);
      expect(e2eMatches).toContain(`${origin}/*`);
    }
  });

  it("fails closed for an unknown profile", () => {
    expect(() => bridgeOriginsForProfile("preview" as "production")).toThrow(
      "Unsupported extension build profile"
    );
  });

  it("fixes one output directory per profile", () => {
    expect(EXTENSION_BUILD_OUTPUTS).toEqual({
      production: "dist",
      development: "dist-development",
      e2e: "dist-e2e-granted"
    });
    expect(resolveExtensionBuild({ argv: ["--profile", "production"] })).toEqual({
      profile: "production",
      outdir: "dist"
    });
    expect(resolveExtensionBuild({ argv: ["--profile", "development"] })).toEqual({
      profile: "development",
      outdir: "dist-development"
    });
  });

  it("lets official command-line selection defeat a stale profile environment", () => {
    expect(resolveExtensionBuild({
      argv: ["--profile", "production"],
      env: { XPERTAPPLY_EXTENSION_BUILD_PROFILE: "development" }
    })).toEqual({ profile: "production", outdir: "dist" });
  });

  it("fails closed for an invalid profile/output pairing", () => {
    expect(() => resolveExtensionBuild({
      argv: ["--profile", "development"],
      env: { XPERTAPPLY_EXTENSION_OUTDIR: "dist" }
    })).toThrow("Invalid extension build profile/output pairing");
    expect(() => resolveExtensionBuild({
      argv: ["--profile", "e2e"],
      env: { XPERTAPPLY_EXTENSION_OUTDIR: "dist" }
    })).toThrow("Invalid extension build profile/output pairing");
  });

  it("keeps official build and package scripts explicitly production-safe", () => {
    expect(packageJson.scripts.build).toBe("node build.mjs --profile production");
    expect(packageJson.scripts["build:dev"]).toBe("node build.mjs --profile development");
    expect(packageJson.scripts.package).toBe("node package.mjs");
  });

  it("negative controls detect the retired trust and output-contamination models", () => {
    const vulnerableOrigins = [...bridgeOriginsForProfile("production"), REMOVED_LEGACY_ORIGINS[1]];
    expect(() => assertProductionBridgeOrigins(vulnerableOrigins)).toThrow(
      "Unsafe production bridge origins"
    );
    expect(bridgeOriginsForProfile("production")).not.toContain("https://ezjobfind.com");
    expect(() => resolveExtensionBuild({
      env: {
        XPERTAPPLY_EXTENSION_BUILD_PROFILE: "development",
        XPERTAPPLY_EXTENSION_OUTDIR: "dist"
      }
    })).toThrow("Invalid extension build profile/output pairing");
  });
});
