import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const productionDirectory = path.join(root, "dist");
const packageFile = path.join(root, "xpertapply-extension.zip");

// Remove the previous release before attempting the build. If the child build
// fails, no stale archive remains that could be mistaken for this invocation's
// output.
rmSync(packageFile, { force: true });

// Set both compatibility variables explicitly as well as the authoritative
// command-line profile. A stale parent shell cannot redirect or weaken the
// artifact selected by the official package command.
execFileSync(process.execPath, ["build.mjs", "--profile", "production"], {
  cwd: root,
  env: {
    ...process.env,
    XPERTAPPLY_EXTENSION_BUILD_PROFILE: "production",
    XPERTAPPLY_EXTENSION_OUTDIR: "dist"
  },
  stdio: "inherit"
});

// The generated release artifact is now always created from the fresh build.
execFileSync("zip", ["-qr", packageFile, ".", "-x", "*.map"], {
  cwd: productionDirectory,
  stdio: "inherit"
});
console.log("Packaged apps/extension/xpertapply-extension.zip");
