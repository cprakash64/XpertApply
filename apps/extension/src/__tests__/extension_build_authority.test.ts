// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertApprovedExtensionBuild, approvedGrantedBuild, createXa13InstrumentedBuild } from "../../e2e/extension-build-authority";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("release launch path provenance", () => {
  it("accepts exact approved builds and a creator-owned immutable XA13 derivative", () => {
    expect(()=>assertApprovedExtensionBuild(approvedGrantedBuild)).not.toThrow();
    for(const [name,owner] of [["dist","xa15-bridge-origins.spec.ts"],["dist-granted-handoff","session-handoff.spec.ts"],["dist-granted-3c2","zz-3c2-frame-discovery.spec.ts"],["dist-granted-3c2granted","zz-3c2-frame-discovery.spec.ts"]]) {
      const fixture=path.join(path.dirname(approvedGrantedBuild),name);const created=!existsSync(fixture);
      try {if(created)cpSync(approvedGrantedBuild,fixture,{recursive:true});expect(()=>assertApprovedExtensionBuild(fixture,owner)).not.toThrow();expect(()=>assertApprovedExtensionBuild(fixture,"unrelated.spec.ts")).toThrow("different spec");}
      finally{if(created)rmSync(fixture,{recursive:true,force:true});}
    }
    const derivative=createXa13InstrumentedBuild(approvedGrantedBuild,"http://127.0.0.1:12345");
    try {expect(()=>assertApprovedExtensionBuild(derivative.path,"xa13-dormancy-gate.spec.ts")).not.toThrow();writeFileSync(path.join(derivative.path,"forged.js"),"changed");expect(()=>assertApprovedExtensionBuild(derivative.path,"xa13-dormancy-gate.spec.ts")).toThrow("changed after registration");}finally{derivative.dispose();}
  });
  it("rejects arbitrary siblings, same basenames elsewhere, copied temp builds, traversal and symlink escape", () => {
    const temp=mkdtempSync(path.join(tmpdir(),"xa13-provenance-negative-"));
    const derivative=createXa13InstrumentedBuild(approvedGrantedBuild,"http://127.0.0.1:12345");
    try {
      for(const name of ["sibling",path.basename(derivative.path),"dist-e2e-granted"]){const p=path.join(temp,name);mkdirSync(p);expect(()=>assertApprovedExtensionBuild(p)).toThrow();}
      const arbitrary=path.join(temp,"arbitrary-copy");cpSync(approvedGrantedBuild,arbitrary,{recursive:true});expect(()=>assertApprovedExtensionBuild(arbitrary)).toThrow();
      expect(()=>createXa13InstrumentedBuild(arbitrary,"http://127.0.0.1:12345")).toThrow();
      expect(()=>assertApprovedExtensionBuild(temp+"/../"+path.basename(temp)+"/sibling")).toThrow("without traversal");
      const link=path.join(temp,"symlink");symlinkSync(derivative.path,link);expect(()=>assertApprovedExtensionBuild(link)).toThrow("symlink");
    }finally{derivative.dispose();rmSync(temp,{recursive:true,force:true});}
  });
});
