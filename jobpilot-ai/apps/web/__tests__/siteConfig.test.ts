/**
 * Public deployment configuration.
 *
 * `chromeExtensionUrl` is the interesting one: its value becomes an outbound
 * link shown to every visitor, so a typo'd, hostile, or half-filled
 * NEXT_PUBLIC_CHROME_EXTENSION_URL must degrade to "not configured" rather than
 * redirect anyone off-product.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_NAME, chromeExtensionUrl, siteUrl } from "../lib/siteConfig";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("product identity", () => {
  it("spells the brand exactly one way", () => {
    expect(PRODUCT_NAME).toBe("EZJobFind");
  });
});

describe("siteUrl", () => {
  it("defaults to the production domain", () => {
    expect(siteUrl()).toBe("https://ezjobfind.com");
  });

  it("uses a configured origin and strips the trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.ezjobfind.com/");
    expect(siteUrl()).toBe("https://staging.ezjobfind.com");
  });

  it("treats an empty or unparseable value as unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "   ");
    expect(siteUrl()).toBe("https://ezjobfind.com");

    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url");
    expect(siteUrl()).toBe("https://ezjobfind.com");
  });
});

describe("chromeExtensionUrl", () => {
  it("is null until a listing is configured", () => {
    expect(chromeExtensionUrl()).toBeNull();

    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", "");
    expect(chromeExtensionUrl()).toBeNull();
  });

  it("accepts a Chrome Web Store listing", () => {
    const url = "https://chromewebstore.google.com/detail/ezjobfind/abcdefghijklmnopabcdefghijklmnop";
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", url);
    expect(chromeExtensionUrl()).toBe(url);
  });

  it("accepts the legacy store host", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_CHROME_EXTENSION_URL",
      "https://chrome.google.com/webstore/detail/ezjobfind/abcdefghijklmnop"
    );
    expect(chromeExtensionUrl()).toContain("chrome.google.com");
  });

  it("rejects anything that is not a Chrome Web Store listing", () => {
    for (const value of [
      "https://example.com/install",
      "http://chromewebstore.google.com/detail/x", // not https
      "https://chromewebstore.google.com", // bare origin, not a listing
      "https://chromewebstore.google.com.evil.example/detail/x",
      "javascript:alert(1)",
      "//chromewebstore.google.com/detail/x"
    ]) {
      vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", value);
      expect(chromeExtensionUrl(), value).toBeNull();
    }
  });
});
