/** Test-only: dist/ plus the loopback fixture origins pre-granted, i.e. the
 * state Chrome is in after a user grants them. Never shipped. */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const out = path.resolve("dist-e2e-granted");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync("dist", out, { recursive: true });
const file = path.join(out, "manifest.json");
const manifest = JSON.parse(readFileSync(file, "utf8"));
manifest.host_permissions = [...manifest.host_permissions, "http://localhost/*", "http://127.0.0.1/*"];
writeFileSync(file, JSON.stringify(manifest, null, 2));
console.log("granted e2e build -> dist-e2e-granted");
