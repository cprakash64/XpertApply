import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve(process.cwd(), "src/ui/sidepanel.ts"), "utf8");
const assistant = readFileSync(resolve(process.cwd(), "src/ui/applicationAssistant.ts"), "utf8");
const html = readFileSync(resolve(process.cwd(), "src/ui/sidepanel.html"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "manifest.json"), "utf8"));
const toolbar = readFileSync(resolve(process.cwd(), "src/toolbarOverlay.ts"), "utf8");
const overlayBootstrap = readFileSync(resolve(process.cwd(), "src/content/overlayBootstrap.ts"), "utf8");
const contentBootstrap = readFileSync(resolve(process.cwd(), "src/content/bootstrap.ts"), "utf8");
const background = readFileSync(resolve(process.cwd(), "src/background.ts"), "utf8");

describe("site-access privacy disclosure", () => {
  it("explains page/form reading and possible service transfer before the permission click", () => {
    const renderedText = assistant.slice(assistant.indexOf("function renderSiteAccess"), assistant.indexOf("function renderDiagnostics"));
    expect(renderedText).toContain("read relevant application-page and form information");
    expect(renderedText).toContain("may be sent to XpertApply's service");
    expect(renderedText).toContain("site_access_denied");
    expect(html.indexOf('id="siteAccessText"')).toBeLessThan(html.indexOf('id="grantSiteAccess"'));
    expect(panel).toContain("requestSiteAccess: (pattern) => chrome.permissions.request({ origins: [pattern] })");
    expect(assistant).not.toContain("chrome.permissions.request");
  });

  it("keeps site access optional without adding webNavigation or blanket install-time hosts", () => {
    expect(manifest.permissions).toEqual(["activeTab", "sidePanel", "storage", "scripting", "tabs"]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
    expect(manifest.host_permissions).toEqual(["https://api.xpertapply.com/*", "https://xpertapply.com/*", "https://www.xpertapply.com/*"]);
    expect(manifest.permissions).not.toContain("webNavigation");
  });

  it("keeps toolbar opening exact-tab and limits passive work to read-only canonical discovery", () => {
    expect(toolbar).not.toContain("tabs.query");
    expect(toolbar).not.toContain("currentWindow");
    expect(toolbar).not.toContain("boundJobTabId");
    expect(toolbar).not.toContain("windows.create");
    expect(toolbar).not.toContain("permissions.request");
    expect(overlayBootstrap).not.toContain("permissions.request");
    expect(overlayBootstrap).not.toContain("discoverAndFill");
    expect(overlayBootstrap).not.toContain("runAutofill");
    expect(toolbar).toContain('files: ["content.js"]');
    expect(contentBootstrap).toContain("async function discoverForToolbar()");
    const toolbarDiscoveryStart = contentBootstrap.indexOf("async function discoverForToolbar()");
    const toolbarDiscovery = contentBootstrap.slice(
      toolbarDiscoveryStart,
      contentBootstrap.indexOf("\n}\n\n/**\n * Observe only", toolbarDiscoveryStart) + 2
    );
    expect(toolbarDiscovery).toContain("discoverQuestionFields(root)");
    expect(toolbarDiscovery).toContain("AUTOFILL_PROGRESS");
    expect(toolbarDiscovery).not.toContain("fillField(");
    expect(toolbarDiscovery).not.toContain("discoverAndFill(");
    expect(toolbarDiscovery).not.toContain("requestSubmit");
    expect(background).not.toContain("openPanelOnActionClick: true");
    expect(background).toContain("installToolbarOverlayAction()");
  });

  it("confines current-window authority to the Side Panel bootstrap", () => {
    expect(assistant).not.toContain("tabs.query");
    expect(assistant).not.toContain("currentWindow");
    expect(panel).toContain("chrome.tabs.query({ active: true, currentWindow: true })");
    expect(panel.match(/currentWindow/g)).toHaveLength(1);
  });
});
