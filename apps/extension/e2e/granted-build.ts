/**
 * A test-only extension build with specific origins already granted.
 *
 * Stage 3C removed install-time authority over employer/application sites, so a
 * spec that exercises what the extension does ON such a site has to put Chrome
 * into the state a user grant produces. Playwright cannot click Chrome's native
 * permission dialog — the request from an extension page never resolves under
 * automation, and from the service worker it throws "must be called during a
 * user gesture" — so the grant is expressed the only other way Chrome accepts
 * it: as a required host permission in a copy of the build.
 *
 * The copy differs from `dist/` in exactly those origins and nothing else. The
 * shipped manifest is what `zz-3c-siteaccess.spec.ts` asserts against.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function buildWithGrantedOrigins(origins: string[], tag: string): string {
  const source = process.env.XA_E2E_DIST ?? path.resolve(here, "..", "dist");
  const out = path.resolve(here, "..", `dist-granted-${tag}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(source, out, { recursive: true });
  const file = path.join(out, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.host_permissions = [...new Set([...manifest.host_permissions, ...origins])];
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  return out;
}

export function removeGrantedBuild(tag: string): void {
  rmSync(path.resolve(here, "..", `dist-granted-${tag}`), { recursive: true, force: true });
}
