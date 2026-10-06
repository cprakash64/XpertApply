import assert from "node:assert/strict";
import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
export const approvedGrantedBuild = path.join(extensionRoot, "dist-e2e-granted");
const permissionFixtures = new Map([["dist", "xa15-bridge-origins.spec.ts"], ["dist-granted-handoff", "session-handoff.spec.ts"], ["dist-granted-3c2", "zz-3c2-frame-discovery.spec.ts"], ["dist-granted-3c2granted", "zz-3c2-frame-discovery.spec.ts"]].map(([name, owner]) => [path.join(extensionRoot, name), owner]));
const derivatives = new Map<string, {source: string; digest: string}>();

function canonical(input: string): string {
  assert.equal(input, path.resolve(input), "Extension path must be canonical, without traversal");
  assert.equal(realpathSync(input), input, "Extension path cannot traverse a symlink");
  return input;
}
function digest(directory: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name); const stat = lstatSync(file);
      assert(!stat.isSymbolicLink(), "Extension derivative cannot contain symlinks");
      if (stat.isDirectory()) visit(file);
      else { assert(stat.isFile(), "Extension derivative contains non-file data"); hash.update(JSON.stringify([path.relative(directory, file), stat.size])); hash.update(readFileSync(file)); }
    }
  };
  visit(directory); return hash.digest("hex");
}
export function assertApprovedExtensionBuild(input: string, fixtureSpec?: string): void {
  const exact = canonical(input);
  if (exact === canonical(approvedGrantedBuild)) return;
  if (permissionFixtures.has(exact)) { assert.equal(fixtureSpec, permissionFixtures.get(exact), "Permission fixture belongs to a different spec"); return; }
  const record = derivatives.get(exact);
  assert(record, "Unregistered extension fixture build");
  assert.equal(fixtureSpec, "xa13-dormancy-gate.spec.ts", "Owned derivative belongs to XA13");
  assert.equal(record.source, canonical(approvedGrantedBuild), "Derivative source must be approved");
  assert.equal(digest(exact), record.digest, "Owned derivative changed after registration");
}

/** This creator alone registers derivatives: it owns allocation/copy and the
 * exact XA13 instrumentation. There is no arbitrary-path registration API. */
export function createXa13InstrumentedBuild(source: string, origin: string): {path: string; dispose(): void} {
  assert.equal(canonical(source), canonical(approvedGrantedBuild), "XA13 must derive from the approved granted build");
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/, "XA13 requires an owned loopback fixture");
  const copy = mkdtempSync(path.join(realpathSync(tmpdir()), "xa13-dist-"));
  try {
    cpSync(source, copy, {recursive:true});
    const manifestPath = path.join(copy, "manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), `${origin}/*`])];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const contentPath = path.join(copy, "content.js"); let content = readFileSync(contentPath, "utf8");
    const needle = "function probeFrame(doc = document) {";
    assert.equal(content.split(needle).length, 2, "XA13 probe instrumentation must match exactly once");
    content = content.replace(needle, `${needle}\n    globalThis.__xa13ProbeCount = (globalThis.__xa13ProbeCount || 0) + 1;`);
    writeFileSync(contentPath, content); const exact = canonical(copy);
    derivatives.set(exact, {source:canonical(source),digest:digest(exact)});
    return {path:exact,dispose(){derivatives.delete(exact);rmSync(exact,{recursive:true,force:true});}};
  } catch (error) { rmSync(copy,{recursive:true,force:true}); throw error; }
}
