import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * What the Chrome Web Store package may contain, checked on the production
 * dist/. These back the Dashboard answers (remote code, permissions) and keep
 * test-only code out of the shipped bytes. Skipped, loudly, when dist/ is absent
 * (npm run verify builds it first).
 */
const dist = path.resolve(__dirname, "..", "..", "dist");
const built = existsSync(path.join(dist, "manifest.json"));
const files = built ? readdirSync(dist).filter((f) => /\.(js|html)$/.test(f)) : [];
const text = (f: string) => readFileSync(path.join(dist, f), "utf8");

describe.skipIf(!built)("production package", () => {
  it("contains no e2e/test hook", () => {
    for (const f of files) expect(text(f), f).not.toContain("__xaToolbarClick");
  });

  it("loads and runs no remote code", () => {
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      const src = text(f);
      expect(src, `${f} eval`).not.toMatch(/\beval\s*\(/);
      expect(src, `${f} Function constructor`).not.toMatch(/\bnew Function\s*\(/);
      expect(src, `${f} importScripts`).not.toMatch(/\bimportScripts\s*\(/);
      expect(src, `${f} remote import`).not.toMatch(/\bimport\s*\(\s*[`"']https?:/);
      expect(src, `${f} remote script element`).not.toMatch(/\.src\s*=\s*[`"']https?:/);
    }
    for (const f of files.filter((x) => x.endsWith(".html"))) {
      expect(text(f), f).not.toMatch(/<script[^>]+src=["']https?:/i);
    }
    const manifest = JSON.parse(text("manifest.json"));
    expect(manifest.content_security_policy).toBeUndefined();
  });

  it("ships exactly the audited permission and surface set", () => {
    const manifest = JSON.parse(text("manifest.json"));
    expect(manifest.permissions).toEqual(["activeTab", "sidePanel", "storage", "scripting", "tabs"]);
    expect(manifest.host_permissions).toEqual(["https://api.xpertapply.com/*", "https://xpertapply.com/*", "https://www.xpertapply.com/*"]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
    expect(manifest.action.default_popup).toBeUndefined();
    expect(manifest.side_panel).toEqual({ default_path: "sidepanel.html" });
    expect(manifest.web_accessible_resources).toEqual([
      { resources: ["fieldentry.html", "fieldentry.js"], matches: ["https://*/*"], use_dynamic_url: true }
    ]);
  });
});
