/** Test-only: dist-e2e-granted with the state Chrome is in after the person accepts the ONE onboarding prompt
 * (the four supported-ATS group patterns) and nothing per-host for those ATSs. careers.withwaymo.com stays an
 * exact grant, as a custom employer domain would be. Never shipped. */
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const src = path.resolve("dist-e2e-granted");
const out = path.resolve("dist-ats-group-granted");
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
const file = path.join(out, "manifest.json");
const manifest = JSON.parse(readFileSync(file, "utf8"));
const exactAts = ["job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "acme.wd5.myworkdayjobs.com"].map((h) => `https://${h}/*`);
manifest.host_permissions = [
  ...manifest.host_permissions.filter((p) => !exactAts.includes(p)),
  "https://*.greenhouse.io/*", "https://*.lever.co/*", "https://*.ashbyhq.com/*", "https://*.myworkdayjobs.com/*"
];
writeFileSync(file, JSON.stringify(manifest, null, 2));
console.log("ats-group granted e2e build -> dist-ats-group-granted");
