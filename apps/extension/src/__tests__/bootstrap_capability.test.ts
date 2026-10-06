import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const required = ["classify","candidates","selected","destination","validateDestination","activate","ctaFingerprint","ctaObstructed","applicationEvidence","awaitDestinationReadiness","configureDropdownTiming","fillRepeatable","frameRemedy","tiktokDiscover","tiktokActuate","committedValueMatches","discover","probeFrame"];
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); delete (window as any).JobPilotHarness; });
describe("ordinary-page bootstrap capability", () => {
  it("loads bootstrap without Chrome and fails closed for required runtime", async () => {
    vi.stubGlobal("chrome", undefined);
    delete (globalThis as any).chrome;
    const bootstrap = await import("../content/bootstrap");
    expect(() => bootstrap.requireWorkflowRuntime()).toThrow("EXTENSION_RUNTIME_UNAVAILABLE");
    expect((window as any).__jobpilotContentInstance).toBeUndefined();
  });
  it.each([false,true])("publishes pure harness exports without using page Chrome (fake=%s)", async fake => {
    const sendMessage=vi.fn();const getManifest=vi.fn();
    vi.stubGlobal("chrome",fake?{runtime:{id:"page-forged-id",sendMessage,getManifest}}:undefined);
    execFileSync(process.execPath,["e2e/build-harness.mjs"]);
    window.eval(fs.readFileSync("e2e/bundle/harness.js","utf8"));
    const harness=(window as any).JobPilotHarness;
    for (const method of required) expect(typeof harness[method],method).toBe("function");
    document.body.innerHTML='<main><h1>Careers</h1></main>';
    harness.classify();harness.candidates();harness.discover();
    expect(sendMessage).not.toHaveBeenCalled();expect(getManifest).not.toHaveBeenCalled();
    expect((window as any).__jobpilotContentInstance).toBeUndefined();
  });
  it("keeps content scripts isolated and does not expose bootstrap through the harness", () => {
    const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
    for (const content of manifest.content_scripts) expect(content.world??"ISOLATED").toBe("ISOLATED");
    expect(fs.readFileSync("src/e2e-harness.ts","utf8")).not.toContain('from "./content/bootstrap"');
  });
});
