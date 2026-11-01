import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import manifest from "../../manifest.json";
import { createExtensionAuth } from "../auth/extensionAuth";
import { bridgeMatchPatternsForProfile, bridgeOriginsForProfile } from "../bridge-origin-profiles.mjs";
import { EXTENSION_BUILD_OUTPUTS, resolveExtensionBuild } from "../build-profile.mjs";
import { resolveApiBase, resolveWebBase } from "../config";
import { manifestForProfile } from "../staging-manifest.mjs";
import { STAGING_API_ORIGIN, STAGING_WEB_ORIGIN } from "../staging-origins.mjs";
import {
  STAGING_EXTENSION_ID,
  STAGING_EXTENSION_PUBLIC_KEY,
  extensionIdFromPublicKey
} from "../staging-extension-key.mjs";

const extensionRoot = path.resolve(__dirname, "..", "..");
const PRODUCTION_HOSTS = ["api.xpertapply.com", "//xpertapply.com", "www.xpertapply.com"];
const generate = (profile: string) => manifestForProfile(manifest, profile, `0.3.0 (test; ${profile})`);
const text = (value: unknown) => JSON.stringify(value);

describe("staging build profile: selection", () => {
  it("has its own output folder and leaves the other profiles' outputs alone", () => {
    expect(EXTENSION_BUILD_OUTPUTS).toEqual({
      production: "dist", development: "dist-development", e2e: "dist-e2e-granted", staging: "dist-staging"
    });
    expect(resolveExtensionBuild({ argv: ["--profile", "staging"], env: {} })).toEqual({ profile: "staging", outdir: "dist-staging" });
    expect(resolveExtensionBuild({ argv: [], env: {} }).profile).toBe("production");
    for (const profile of ["production", "development", "e2e"]) {
      expect(resolveExtensionBuild({ argv: ["--profile", profile], env: {} }).outdir).toBe(EXTENSION_BUILD_OUTPUTS[profile as "production"]);
    }
  });

  it("cannot be pointed at another profile's folder", () => {
    expect(() => resolveExtensionBuild({ argv: ["--profile", "staging"], env: { XPERTAPPLY_EXTENSION_OUTDIR: "dist" } })).toThrow();
    expect(() => resolveExtensionBuild({ argv: ["--profile", "production"], env: { XPERTAPPLY_EXTENSION_OUTDIR: "dist-staging" } })).toThrow();
    expect(() => resolveExtensionBuild({ argv: ["--profile", "stagingg"], env: {} })).toThrow();
  });

  it("trusts exactly the staging website: no production origin, no loopback", () => {
    expect(bridgeOriginsForProfile("staging")).toEqual([STAGING_WEB_ORIGIN]);
    expect(bridgeMatchPatternsForProfile("staging")).toEqual([`${STAGING_WEB_ORIGIN}/*`]);
    for (const other of ["https://xpertapply.com", "https://www.xpertapply.com", "http://localhost:3000", "http://127.0.0.1:3000"]) {
      expect(bridgeOriginsForProfile("staging")).not.toContain(other);
    }
    // and production never learns about staging
    expect(text(bridgeOriginsForProfile("production"))).not.toContain("staging");
  });
});

describe("staging manifest", () => {
  const staging = generate("staging");

  it("has its own name and hosts, REPLACING (not extending) production's", () => {
    expect(staging.name).toBe("XpertApply (STAGING)");
    expect(staging.host_permissions).toEqual([`${STAGING_API_ORIGIN}/*`, `${STAGING_WEB_ORIGIN}/*`]);
    expect(staging.externally_connectable.matches).toEqual([`${STAGING_WEB_ORIGIN}/*`]);
    expect(staging.content_scripts[0].matches).toEqual([`${STAGING_WEB_ORIGIN}/*`]);
    for (const production of PRODUCTION_HOSTS) expect(text(staging)).not.toContain(production);
    expect(text(staging)).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("keeps every permission the product already has, and adds no broad access", () => {
    expect(staging.permissions).toEqual(manifest.permissions);
    expect(staging.optional_host_permissions).toEqual(manifest.optional_host_permissions);
    expect(staging.web_accessible_resources).toEqual(manifest.web_accessible_resources);
    expect(staging.background).toEqual(manifest.background);
    expect(staging.version).toBe(manifest.version);
    expect(staging.host_permissions).toHaveLength(2);
    expect(text(staging.host_permissions)).not.toMatch(/\*:\/\/\*|<all_urls>|https:\/\/\*\//);
    expect(staging.permissions).toContain("identity");
  });

  it("production, development and e2e manifests keep their hosts, permissions and have no key or staging endpoint", () => {
    for (const profile of ["production", "development", "e2e"]) {
      const generated = generate(profile);
      expect(generated.permissions).toEqual(manifest.permissions);
      expect(generated.host_permissions).toEqual(manifest.host_permissions);
      expect(generated.externally_connectable).toEqual(manifest.externally_connectable);
      expect(generated.name).toBe(manifest.name);
      expect("key" in generated).toBe(false);
      expect(text(generated)).not.toContain("staging");
    }
    expect("key" in manifest).toBe(false);
    expect(generate("production").content_scripts[0].matches).toEqual(["https://xpertapply.com/*", "https://www.xpertapply.com/*"]);
    expect(generate("development").content_scripts[0].matches).toEqual(expect.arrayContaining(["http://localhost:3000/*"]));
  });
});

describe("staging extension identity", () => {
  it("derives the pinned id from the published public key", () => {
    expect(extensionIdFromPublicKey(STAGING_EXTENSION_PUBLIC_KEY)).toBe(STAGING_EXTENSION_ID);
    expect(STAGING_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(generate("staging").key).toBe(STAGING_EXTENSION_PUBLIC_KEY);
  });

  it("is a real 2048-bit RSA public key (what Chrome expects in `key`), and public only", () => {
    const key = createPublicKey({ key: Buffer.from(STAGING_EXTENSION_PUBLIC_KEY, "base64"), format: "der", type: "spki" });
    expect(key.asymmetricKeyType).toBe("rsa");
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(STAGING_EXTENSION_PUBLIC_KEY).not.toMatch(/PRIVATE|-----/);
  });

  it("differs from every other build: only staging carries a key, so production/store ids can never collide with it", () => {
    for (const profile of ["production", "development", "e2e"]) expect("key" in generate(profile)).toBe(false);
  });

  it("ships no private key material anywhere in the extension sources", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith("dist") || name === "test-results" || name === ".git") continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs|json|md|html|js)$/.test(name) && /-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(readFileSync(full, "utf8"))) hits.push(full);
      }
    };
    walk(extensionRoot);
    expect(hits).toEqual([]);
  });
});

describe("staging cannot fall back to production or be redirected", () => {
  const strict = [STAGING_API_ORIGIN];
  it.each([
    ["nothing stored", undefined],
    ["the production API", "https://api.xpertapply.com"],
    ["an attacker host", "https://evil.example"],
    ["a lookalike", "https://api-staging.xpertapply.com.evil.example"],
    ["a path on the staging host", `${STAGING_API_ORIGIN}/steal`],
    ["plain http", "http://api-staging.xpertapply.com"],
    ["a loopback server", "http://127.0.0.1:8000"],
    ["not a url", "not a url"],
    ["a non-string", { toString: () => STAGING_API_ORIGIN }]
  ])("a staging build ignores a stored apiBase of: %s", (_name, stored) => {
    expect(resolveApiBase(stored, strict, STAGING_API_ORIGIN)).toBe(STAGING_API_ORIGIN);
  });

  it("accepts the staging origin itself (with or without a trailing slash)", () => {
    expect(resolveApiBase(STAGING_API_ORIGIN, strict, STAGING_API_ORIGIN)).toBe(STAGING_API_ORIGIN);
    expect(resolveApiBase(`${STAGING_API_ORIGIN}/`, strict, STAGING_API_ORIGIN)).toBe(STAGING_API_ORIGIN);
  });

  it("leaves the legacy (production/development/e2e) override behaviour exactly as it was", () => {
    expect(resolveApiBase("http://localhost:8000", null, "https://api.xpertapply.com")).toBe("http://localhost:8000");
    expect(resolveApiBase(undefined, null, "https://api.xpertapply.com")).toBe("https://api.xpertapply.com");
  });

  it.each(["https://xpertapply.com", "https://www.xpertapply.com", "https://evil.example", "http://localhost:3000", "https://staging.xpertapply.com.evil.example", 5, null])(
    "a staging build's sign-in window ignores a webBase override of %s",
    (stored) => {
      expect(resolveWebBase(stored, [STAGING_WEB_ORIGIN])).toBe(STAGING_WEB_ORIGIN);
    }
  );

  it("still honours a webBase override that is one of the build's own trusted origins", () => {
    expect(resolveWebBase("https://www.xpertapply.com", ["https://xpertapply.com", "https://www.xpertapply.com"])).toBe("https://www.xpertapply.com");
  });
});

describe("staging external-sender trust", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  const sender = (origin: string) => ({ tab: { id: 3 }, frameId: 0, origin, url: `${origin}/jobs` }) as unknown as chrome.runtime.MessageSender;

  it("a staging build accepts only the staging website, even when unpacked", async () => {
    vi.stubGlobal("__XPERTAPPLY_PROFILE__", "staging");
    vi.stubGlobal("__XPERTAPPLY_BRIDGE_ORIGINS__", [STAGING_WEB_ORIGIN]);
    vi.resetModules();
    const { isApprovedExternalWebSender } = await import("../security/externalMessaging");
    expect(isApprovedExternalWebSender(sender(STAGING_WEB_ORIGIN), true)).toBe(true);
    for (const origin of ["https://xpertapply.com", "https://www.xpertapply.com", "http://localhost:3000", "https://evil.example"]) {
      expect(isApprovedExternalWebSender(sender(origin), true)).toBe(false);
    }
  });

  it("production behaviour is unchanged: production origins accepted, staging rejected", async () => {
    vi.resetModules();
    const { isApprovedExternalWebSender } = await import("../security/externalMessaging");
    expect(isApprovedExternalWebSender(sender("https://xpertapply.com"), false)).toBe(true);
    expect(isApprovedExternalWebSender(sender(STAGING_WEB_ORIGIN), true)).toBe(false);
  });
});

describe("the PKCE redirect uses the staging id", () => {
  // What chrome.identity.getRedirectURL("xpertapply") returns for an extension: https://<id>.chromiumapp.org/xpertapply
  const redirect = `https://${STAGING_EXTENSION_ID}.chromiumapp.org/xpertapply`;

  it("matches the backend's redirect rule (read from the API source, not copied)", () => {
    const source = readFileSync(path.resolve(extensionRoot, "..", "api", "app", "routes", "extension.py"), "utf8");
    const rule = /_REDIRECT_RE = re\.compile\(r"(.+)"\)/.exec(source)?.[1];
    expect(rule).toBeTruthy();
    expect(new RegExp(rule!).test(redirect)).toBe(true);
    expect(new RegExp(rule!).test(`https://${STAGING_EXTENSION_ID}.chromiumapp.org.evil.example/xpertapply`)).toBe(false);
  });

  it("is what the worker sends to the staging website and the token endpoint", async () => {
    const launched: string[] = [];
    const posted: Array<{ path: string; body: Record<string, string> }> = [];
    const store: Record<string, unknown> = {};
    const auth = createExtensionAuth({
      storage: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
        remove: async (key: string) => { delete store[key]; }
      } as never,
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        posted.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 1800, user: { id: 1, email: "u@e.test" } }), { status: 200 });
      }) as typeof fetch,
      apiBase: async () => STAGING_API_ORIGIN,
      webBase: async () => resolveWebBase("https://xpertapply.com", [STAGING_WEB_ORIGIN]),
      redirectUrl: () => redirect,
      launchWebAuthFlow: async ({ url }) => { launched.push(url); return `${redirect}?code=c&state=${new URL(url).searchParams.get("state")}`; },
      now: () => 0,
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n))
    });
    await auth.connect();
    const url = new URL(launched[0]);
    expect(url.origin + url.pathname).toBe(`${STAGING_WEB_ORIGIN}/extension/connect`);   // never production, even with a hostile webBase
    expect(url.searchParams.get("redirect_uri")).toBe(redirect);
    expect(posted[0].body.redirect_uri).toBe(redirect);
  });
});

describe("built bundles", () => {
  const stagingDist = path.join(extensionRoot, "dist-staging");
  beforeAll(() => {
    execFileSync(process.execPath, ["build.mjs", "--profile", "staging"], { cwd: extensionRoot, stdio: "pipe" });
  }, 120_000);

  const bundleText = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");

  it("the staging build on disk has the staging manifest and bakes in the staging endpoints", () => {
    const built = JSON.parse(readFileSync(path.join(stagingDist, "manifest.json"), "utf8"));
    expect(built.name).toBe("XpertApply (STAGING)");
    expect(built.host_permissions).toEqual([`${STAGING_API_ORIGIN}/*`, `${STAGING_WEB_ORIGIN}/*`]);
    expect(built.key).toBe(STAGING_EXTENSION_PUBLIC_KEY);
    expect(built.version_name).toMatch(/; staging\)$/);
    for (const production of PRODUCTION_HOSTS) expect(text(built)).not.toContain(production);
    const code = bundleText(stagingDist);
    expect(code).toContain(STAGING_API_ORIGIN);
    expect(code).toContain(STAGING_WEB_ORIGIN);
    expect(code).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });

  it("the production build contains no staging endpoint, key or name", () => {
    const productionDist = path.join(extensionRoot, "dist");
    if (!existsSync(path.join(productionDist, "manifest.json"))) {
      throw new Error("dist/manifest.json is missing; run `npm run build` before `npm test` (as generated_manifest.test does).");
    }
    const built = JSON.parse(readFileSync(path.join(productionDist, "manifest.json"), "utf8"));
    expect("key" in built).toBe(false);
    expect(built.name).toBe(manifest.name);
    expect(text(built)).not.toContain("staging");
    const code = bundleText(productionDist);
    for (const needle of ["api-staging.xpertapply.com", "staging.xpertapply.com", "XpertApply (STAGING)", STAGING_EXTENSION_PUBLIC_KEY]) {
      expect(code, needle).not.toContain(needle);
    }
  });
});
