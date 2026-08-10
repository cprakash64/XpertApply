/**
 * Product branding, at the two places Chrome and the user actually read it:
 * the manifest (store listing, extensions page, toolbar tooltip) and the side
 * panel's own markup.
 *
 * Internal identifiers are deliberately NOT covered here. `JOBPILOT_WEB_ORIGINS`,
 * `isApprovedJobPilotOrigin`, `clearJobPilotFields` and friends keep their names
 * for backwards compatibility — renaming them would be a namespace migration, not
 * a rebrand, and nothing a user sees depends on them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";
import { JOBPILOT_WEB_ORIGINS, isApprovedJobPilotOrigin } from "../config";
import { classifyEnvironment } from "../runtimeIdentity";

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf-8");

describe("extension branding", () => {
  it("presents EZJobFind to Chrome", () => {
    expect(manifest.name).toBe("EZJobFind — Assisted Apply");
    expect(manifest.short_name).toBe("EZJobFind");
    expect(manifest.action.default_title).toBe("Open EZJobFind Assisted Apply");
    expect(manifest.description).toContain("EZJobFind");
    expect(manifest.description).not.toMatch(/JobPilot/i);
  });

  it("leaves no retired product name in Chrome-facing manifest strings", () => {
    for (const value of [manifest.name, manifest.short_name, manifest.description, manifest.action.default_title]) {
      expect(value).not.toMatch(/JobPilot/i);
    }
  });

  it("titles and labels the side panel as EZJobFind", () => {
    const html = read("src/ui/sidepanel.html");
    expect(html).toContain("<title>EZJobFind Assisted Apply</title>");
    expect(html).toContain("<h1>EZJobFind — Assisted Apply</h1>");
    // Every visible string in the panel — the JobPilot spelling only survives
    // in code identifiers, and there are none in this file.
    expect(html).not.toMatch(/JobPilot/i);
  });
});

describe("production origins", () => {
  it("trusts the new production domain without dropping the previous one", () => {
    expect(isApprovedJobPilotOrigin("https://ezjobfind.com")).toBe(true);
    expect(isApprovedJobPilotOrigin("https://www.ezjobfind.com")).toBe(true);
    // Installed extensions must keep working against the older deployment.
    expect(isApprovedJobPilotOrigin("https://app.jobpilot.ai")).toBe(true);
    expect(isApprovedJobPilotOrigin("http://localhost:3000")).toBe(true);
  });

  it("still rejects look-alike origins", () => {
    for (const origin of [
      "https://ezjobfind.com.evil.example",
      "https://notezjobfind.com",
      "http://ezjobfind.com",
      "https://ezjobfind.com:8443"
    ]) {
      expect(isApprovedJobPilotOrigin(origin), origin).toBe(false);
    }
  });

  it("classifies the new domain as production", () => {
    expect(classifyEnvironment("https://ezjobfind.com")).toBe("production");
    expect(classifyEnvironment("https://api.ezjobfind.com")).toBe("production");
    expect(classifyEnvironment("https://app.jobpilot.ai")).toBe("production");
    expect(classifyEnvironment("https://staging.ezjobfind.com")).toBe("staging");
    expect(classifyEnvironment("http://localhost:8000")).toBe("local");
  });

  it("keeps the manifest content scripts aligned with the trusted origins", () => {
    const bridgeScript = manifest.content_scripts.find((entry) =>
      entry.matches.includes("http://localhost:3000/*")
    );
    expect(bridgeScript).toBeTruthy();
    for (const origin of JOBPILOT_WEB_ORIGINS) {
      expect(bridgeScript?.matches, origin).toContain(`${origin}/*`);
    }
  });
});
