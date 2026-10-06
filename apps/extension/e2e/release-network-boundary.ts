import { assertApprovedExtensionBuild } from "./extension-build-authority";
import { chromium, test, type BrowserContext } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";

/** All synthetic browsers deny unmatched DNS. Explicit Stage3C loopback
 * mappings and Playwright-fulfilled origin/permission negatives still work.
 * This module is loaded by normal config in the runner and each worker. */
const installed = Symbol.for("xpertapply.e2e.networkBoundary");
const owner = chromium as typeof chromium & { [installed]?: boolean };
const expectedDist = path.resolve("dist-e2e-granted");
const local = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

function confinedArgs(args: string[] = []): string[] {
  const existing = args.find(arg => arg.startsWith("--host-resolver-rules="));
  const rules = existing?.slice("--host-resolver-rules=".length) ?? "";
  for (const rule of rules.split(",").filter(Boolean)) {
    assert.match(rule.trim(), /^MAP \S+ 127\.0\.0\.1:\d+$/, "Only owned loopback DNS mappings are allowed");
  }
  return [...args.filter(arg => !arg.startsWith("--host-resolver-rules=")),
    `--host-resolver-rules=${rules ? rules + "," : ""}MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE 127.0.0.1`];
}

function audit(context: BrowserContext): BrowserContext {
  const observations: Promise<void>[] = [];
  const external: {origin: string; path: string; address: string}[] = [];
  let loopbackResponses = 0;
  let fulfilledResponses = 0;
  context.on("response", response => {
    const url = new URL(response.url());
    if (!["http:", "https:"].includes(url.protocol)) return;
    observations.push((async () => {
      const address = await response.serverAddr();
      if (!address) { fulfilledResponses++; return; }
      if (local(address.ipAddress)) { loopbackResponses++; return; }
      external.push({origin:url.origin,path:url.pathname,address:address.ipAddress});
    })());
  });
  const close = context.close.bind(context);
  context.close = async options => {
    const observed = await Promise.allSettled(observations);
    await close(options);
    console.log("RELEASE_NETWORK " + JSON.stringify({loopbackResponses,fulfilledResponses,external}));
    assert(observed.every(row => row.status === "fulfilled"), "Network destination observation failed");
    assert.deepEqual(external, [], "Synthetic browser transmitted external traffic");
  };
  return context;
}

if (!owner[installed]) {
  owner[installed] = true;
  const persistent = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = async (profile, options = {}) => {
    assert.equal(process.env.XA_E2E_DIST, expectedDist, "Normal setup must select the exact granted bundle");
    const args = confinedArgs(options.args);
    const load = args.find(arg => arg.startsWith("--load-extension="))?.split("=").slice(1).join("=");
    const only = args.find(arg => arg.startsWith("--disable-extensions-except="))?.split("=").slice(1).join("=");
    assert(load && load === only, "Extension load arguments must agree");
    // Permission-specific negative specs deliberately use subset/production
    // manifests; ordinary specs must load the normal setup's granted build.
    assertApprovedExtensionBuild(load, path.basename(test.info().file));
    assert(!options.proxy, "Synthetic browsers cannot use an external proxy");
    console.log("RELEASE_LAUNCH " + JSON.stringify({skipBuild:process.env.XA_E2E_SKIP_BUILD ?? null,effectiveDist:process.env.XA_E2E_DIST,load,only,dns:args.find(arg=>arg.startsWith("--host-resolver-rules="))}));
    return audit(await persistent(profile, {...options,args}));
  };
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (options = {}) => {
    assert(!options.proxy, "Synthetic browsers cannot use an external proxy");
    const browser = await launch({...options,args:confinedArgs(options.args)});
    const create = browser.newContext.bind(browser);
    browser.newContext = async options => audit(await create(options));
    return browser;
  };
}
