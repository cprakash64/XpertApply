/**
 * Builds the injectable adapter bundle before the real-browser specs run.
 *
 * e2e/bundle/ is gitignored, so without this a clean checkout fails on a
 * missing harness.js rather than on anything to do with the code under test.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export default function globalSetup(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cwd = path.resolve(here, "..");
  execFileSync(process.execPath, [path.join(here, "build-harness.mjs")], { cwd, stdio: "inherit" });
  // Stage 3C: the specs that drive the real extension against a loopback
  // fixture need the post-grant state, which install no longer provides.
  execFileSync(process.execPath, [path.join(here, "build-granted.mjs")], { cwd, stdio: "inherit" });
  process.env.XA_E2E_DIST ??= path.join(cwd, "dist-e2e-granted");
}
