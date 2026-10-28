/* TEMP PROBE — can a granted optional host permission be seeded into the profile? */
import { chromium, test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

test.setTimeout(120_000);
test("seed probe", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xa-seed-"));
  const args = [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`];

  // Pass 1: let Chrome create the profile and register the extension.
  let ctx = await chromium.launchPersistentContext(dir, { channel: "chromium", args, serviceWorkers: "allow" });
  let worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20_000 }));
  const id = new URL(worker.url()).host;
  await ctx.close();

  const prefsPath = path.join(dir, "Default", "Preferences");
  console.log("SEED prefs exists=" + existsSync(prefsPath) + " id=" + id);
  const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
  const entry = prefs?.extensions?.settings?.[id];
  console.log("SEED entry keys=" + (entry ? Object.keys(entry).join(",") : "MISSING"));
  if (entry) {
    entry.granted_permissions = entry.granted_permissions ?? {};
    const hosts: string[] = entry.granted_permissions.explicit_host ?? [];
    entry.granted_permissions.explicit_host = [...new Set([...hosts, "http://localhost/*", "http://127.0.0.1/*"])];
    entry.granted_permissions.scriptable_host = entry.granted_permissions.scriptable_host ?? [];
    writeFileSync(prefsPath, JSON.stringify(prefs));
    console.log("SEED wrote explicit_host=" + JSON.stringify(entry.granted_permissions.explicit_host));
  }

  // Pass 2: does Chrome honour it?
  ctx = await chromium.launchPersistentContext(dir, { channel: "chromium", args, serviceWorkers: "allow" });
  worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20_000 }));
  const after = await worker.evaluate(async () => chrome.permissions.getAll());
  console.log("SEED after " + JSON.stringify(after));
  const has = await worker.evaluate(async () =>
    chrome.permissions.contains({ origins: ["http://localhost/*"] }));
  console.log("SEED contains(http://localhost/*) = " + has);
  await ctx.close();
  expect(true).toBe(true);
});
