/** Test-only: the STAGING profile build, plus the loopback-served ATS fixture origins pre-granted, i.e. the state Chrome is
 * in after a user allows those sites. Everything else (name, trusted website, API, key) is exactly the staging build's.
 * Never shipped. */
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
execFileSync(process.execPath, ["build.mjs", "--profile", "staging"], { cwd: process.cwd(), stdio: "inherit" });
rmSync("dist-staging-granted", { recursive: true, force: true });
cpSync("dist-staging", "dist-staging-granted", { recursive: true });
const file = "dist-staging-granted/manifest.json";
const manifest = JSON.parse(readFileSync(file, "utf8"));
const HOSTS = ["job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "careers.withwaymo.com"];
manifest.host_permissions = [...manifest.host_permissions, ...HOSTS.map((host) => `https://${host}/*`)];
writeFileSync(file, JSON.stringify(manifest, null, 2));
console.log("staging granted test build -> dist-staging-granted");
