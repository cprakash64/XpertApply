import { describe, expect, it } from "vitest";
// The config/helper execute as native ESM outside the app's TypeScript graph.
const configPath = "../next.config.mjs";
const policyPath = "../lib/securityPolicy.mjs";
type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };
const config = (await import(configPath)).default as { poweredByHeader: boolean; headers(): Promise<HeaderRule[]> };
const { CSP_HEADER, CSP_PAGE_SOURCE, reportOnlyHeaders, reportOnlyPolicy, serializePolicy } = await import(policyPath) as {
  CSP_HEADER: string;
  CSP_PAGE_SOURCE: string;
  reportOnlyHeaders(): HeaderRule[];
  reportOnlyPolicy(): string;
  serializePolicy(directives: Array<[string, string[]]>): string;
};

describe("static-safe CSP observation", () => {
  it("uses only Report-Only and suppresses the powered-by header", async () => {
    expect(config.poweredByHeader).toBe(false);
    expect(await config.headers()).toEqual(reportOnlyHeaders());
    expect(CSP_HEADER).toBe("Content-Security-Policy-Report-Only");
    expect(config).not.toHaveProperty("experimental");
    expect(config).not.toHaveProperty("cacheComponents");
  });

  it("serializes an ordered strict production candidate without broad script/connect sources", () => {
    const policy = reportOnlyPolicy();
    const entries = policy.split("; ").map(d => d.split(" "));
    const directives = Object.fromEntries(entries.map(([name, ...values]) => [name, values]));
    expect(entries.map(([name]) => name)).toEqual([
      "default-src", "script-src", "style-src", "style-src-attr", "img-src", "font-src",
      "connect-src", "frame-src", "frame-ancestors", "object-src", "base-uri", "form-action", "upgrade-insecure-requests"
    ]);
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["style-src"]).toEqual(["'self'"]);
    expect(directives["style-src-attr"]).toEqual(["'unsafe-inline'"]);
    expect(directives["connect-src"]).toEqual(["'self'", "https://api.xpertapply.com"]);
    expect(directives["img-src"]).toEqual(["'self'", "https://api.xpertapply.com", "data:", "blob:"]);
    expect(directives["font-src"]).toEqual(["'self'"]);
    for (const key of ["frame-src", "frame-ancestors", "object-src"]) expect(directives[key]).toEqual(["'none'"]);
    for (const key of ["default-src", "base-uri", "form-action"]) expect(directives[key]).toEqual(["'self'"]);
    expect(policy).not.toMatch(/unsafe-eval|nonce-|strict-dynamic|report-uri|report-to|[\r\n]|\*/);
    expect(policy).not.toContain("accounts.google.com");
  });

  it("rejects duplicate directives and injected directive/source values", () => {
    expect(() => serializePolicy([["script-src", ["'self'"]], ["script-src", []]])).toThrow();
    expect(() => serializePolicy([["script-src\nX-Test", []]])).toThrow();
    for (const value of ["https://safe.example\r\nX-Test:value", "'self';script-src", "", "two tokens"]) {
      expect(() => serializePolicy([["script-src", [value]]])).toThrow();
    }
  });

  it("matches HTML page paths and excludes static/API assets without request rendering", () => {
    const match = new RegExp(`^${CSP_PAGE_SOURCE}$`);
    for (const path of ["/", "/privacy", "/login", "/auth/google/callback", "/dashboard", "/missing-page"]) expect(match.test(path), path).toBe(true);
    for (const path of ["/_next/static/a.js", "/_next/image", "/api/test", "/brand/logo.png", "/favicon.ico", "/asset.css"]) expect(match.test(path), path).toBe(false);
    expect(reportOnlyPolicy()).not.toMatch(/nonce-|localhost/);
  });
});
