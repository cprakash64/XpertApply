/** Test-only: dist/ plus the loopback fixture origins pre-granted, i.e. the
 * state Chrome is in after a user grants them. Never shipped. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const out = path.resolve("dist-e2e-granted");
execFileSync(process.execPath, ["build.mjs", "--profile", "e2e"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    XPERTAPPLY_EXTENSION_OUTDIR: "dist-e2e-granted"
  },
  stdio: "inherit"
});
const file = path.join(out, "manifest.json");
const manifest = JSON.parse(readFileSync(file, "utf8"));
// Real ATS hostnames, granted as Chrome would after the user approves each one, so the persistent
// registration path runs for them. Specs serve them from loopback (host-resolver MAP + local TLS).
// Test-build only. www.tesla.com / careers.acme-corp.example / jobs.smartrecruiters.com are OWNED fixtures served under those hostnames
// (EXT-LIVE-09); the production manifest never lists them.
const ATS_FIXTURE_HOSTS = ["job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "acme.wd5.myworkdayjobs.com", "careers.withwaymo.com", "www.tesla.com", "careers.acme-corp.example", "jobs.smartrecruiters.com"];
manifest.host_permissions = [...manifest.host_permissions, "http://localhost/*", "http://127.0.0.1/*", ...ATS_FIXTURE_HOSTS.map((host) => `https://${host}/*`)];
manifest.externally_connectable = {
  ...manifest.externally_connectable,
  matches: [
    ...(manifest.externally_connectable?.matches ?? []),
    "http://localhost/*",
    "http://127.0.0.1/*"
  ]
};
manifest.web_accessible_resources = manifest.web_accessible_resources.map((entry) => ({
  ...entry,
  matches: [...entry.matches, "http://localhost/*", "http://127.0.0.1/*"]
}));
writeFileSync(file, JSON.stringify(manifest, null, 2));
console.log("granted e2e build -> dist-e2e-granted");
