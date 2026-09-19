import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve(process.cwd(), "src/ui/sidepanel.ts"), "utf8");
const html = readFileSync(resolve(process.cwd(), "src/ui/sidepanel.html"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "manifest.json"), "utf8"));

describe("site-access privacy disclosure", () => {
  it("explains page/form reading and possible service transfer before the permission click", () => {
    const renderedText = panel.slice(panel.indexOf("function renderSiteAccess"), panel.indexOf("function renderDiagnostics"));
    expect(renderedText).toContain("read relevant application-page and form information");
    expect(renderedText).toContain("may be sent to XpertApply's service");
    expect(renderedText).toContain("site_access_denied");
    expect(html.indexOf('id="siteAccessText"')).toBeLessThan(html.indexOf('id="grantSiteAccess"'));
    expect(panel.indexOf("function renderSiteAccess")).toBeLessThan(panel.indexOf("chrome.permissions.request({ origins: [pattern] })"));
  });

  it("keeps site access optional without adding webNavigation or blanket install-time hosts", () => {
    expect(manifest.permissions).toEqual(["sidePanel", "storage", "scripting", "tabs"]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
    expect(manifest.host_permissions).toEqual(["https://api.xpertapply.com/*", "https://xpertapply.com/*", "https://www.xpertapply.com/*"]);
    expect(manifest.permissions).not.toContain("webNavigation");
  });
});
