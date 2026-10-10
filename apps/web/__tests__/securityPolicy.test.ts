import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
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
  it("keeps the proxy as sole CSP authority and suppresses the powered-by header", async () => {
    expect(config.poweredByHeader).toBe(false);
    expect(await config.headers()).toEqual([]);
    // The static observation helper remains strict, but this qualification
    // config deliberately does not install a second Report-Only policy.
    expect(reportOnlyHeaders()).toEqual([{ source: CSP_PAGE_SOURCE,
      headers: [{ key: CSP_HEADER, value: reportOnlyPolicy() }] }]);
    expect(CSP_HEADER).toBe("Content-Security-Policy-Report-Only");
    expect(config).not.toHaveProperty("experimental");
    expect(config).not.toHaveProperty("cacheComponents");
  });

  it("enforces one nonce CSP and rejects caller-supplied authority", () => {
    const request = () => new NextRequest("https://xpertapply.com/login", { headers: {
      "x-nonce": "caller-supplied", "content-security-policy": "default-src *",
      "content-security-policy-report-only": "default-src *"
    } });
    const response = proxy(request());
    const policy = response.headers.get("Content-Security-Policy")!;
    const directives = Object.fromEntries(policy.split("; ").map(d => {
      const [name, ...values] = d.split(" "); return [name, values];
    }));
    const nonce = response.headers.get("x-middleware-request-x-nonce")!;
    expect(Buffer.from(nonce, "base64").length).toBe(16);
    expect(Buffer.from(nonce, "base64").toString("base64")).toBe(nonce);
    expect(nonce).not.toBe("caller-supplied");
    expect(directives["script-src"]).toEqual(["'self'", `'nonce-${nonce}'`]);
    expect(directives["style-src"]).toEqual(["'self'", "'sha256-Wwucq8eX2r0YFymkQhDXm5hN0+FfSvI3s4JSSaqa4iw='"]);
    expect(directives["connect-src"]).toEqual(["'self'", "https://api.xpertapply.com"]);
    for (const key of ["frame-src", "frame-ancestors", "object-src"]) expect(directives[key]).toEqual(["'none'"]);
    expect(policy).not.toMatch(/unsafe-eval|strict-dynamic|report-uri|report-to|\*/);
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    expect(directives["style-src"]).not.toContain("'unsafe-inline'");
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    expect(response.headers.get("x-middleware-request-content-security-policy-report-only")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(proxy(request()).headers.get("x-middleware-request-x-nonce")).not.toBe(nonce);
    expect(proxy(new NextRequest("https://xpertapply.com/_next/static/test.js")).headers.get("Cache-Control")).toBeNull();
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
