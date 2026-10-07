/**
 * Public deployment configuration.
 *
 * `chromeExtensionUrl` is the interesting one: its value becomes an outbound
 * link shown to every visitor, so a typo'd, hostile, or half-filled
 * NEXT_PUBLIC_CHROME_EXTENSION_URL must degrade to "not configured" rather than
 * redirect anyone off-product.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND, PRODUCT_NAME, chromeExtensionId, chromeExtensionUrl, siteUrl } from "../lib/siteConfig";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("product identity", () => {
  it("spells the brand exactly one way", () => {
    expect(PRODUCT_NAME).toBe("XpertApply");
    expect(BRAND.name).toBe("XpertApply");
    expect(PRODUCT_NAME).toBe(BRAND.name);
  });

  it("carries the tagline and domain alongside the name", () => {
    // Everything brand-shaped lives in one object, so a future rename is one
    // edit rather than a repository-wide search.
    expect(BRAND.tagline).toBe("Your AI Job Application Copilot");
    expect(BRAND.domain).toBe("xpertapply.com");
  });

  it("carries no retired product name", () => {
    expect(JSON.stringify(BRAND)).not.toMatch(/EZJobFind|JobPilot/i);
  });
});

describe("siteUrl", () => {
  it("defaults to the production domain", () => {
    expect(siteUrl()).toBe("https://xpertapply.com");
  });

  it("uses a configured origin and strips the trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.xpertapply.com/");
    expect(siteUrl()).toBe("https://staging.xpertapply.com");
  });

  it("treats an empty or unparseable value as unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "   ");
    expect(siteUrl()).toBe("https://xpertapply.com");

    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url");
    expect(siteUrl()).toBe("https://xpertapply.com");
  });
});

describe("chromeExtensionUrl", () => {
  it("is null until a listing is configured", () => {
    expect(chromeExtensionUrl()).toBeNull();

    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", "");
    expect(chromeExtensionUrl()).toBeNull();
  });

  it("accepts a Chrome Web Store listing", () => {
    const url = "https://chromewebstore.google.com/detail/xpertapply/abcdefghijklmnopabcdefghijklmnop";
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", url);
    expect(chromeExtensionUrl()).toBe(url);
  });

  it("rejects the legacy store host", () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", "https://chrome.google.com/webstore/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(chromeExtensionUrl()).toBeNull();
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

describe("chromeExtensionId", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";

  it("accepts an explicit stable public extension ID", () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", id);
    expect(chromeExtensionId()).toBe(id);
  });

  it("does not infer runtime routing from the separate Web Store install URL", () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", `https://chromewebstore.google.com/detail/xpertapply/${id}`);
    expect(chromeExtensionId()).toBeNull();
  });

  it("rejects malformed or non-Chrome extension IDs", () => {
    for (const value of ["", "too-short", "zbcdefghijklmnopabcdefghijklmnop", `${id}/extra`]) {
      vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", value);
      expect(chromeExtensionId(), value).toBeNull();
    }
  });
});


describe("draft Store routing configuration", () => {
  const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const url = `https://chromewebstore.google.com/detail/example-slug/${id}`;

  it("keeps a known ID usable with no public URL and never infers it from a URL", () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", id);
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", "");
    expect(chromeExtensionId()).toBe(id);
    expect(chromeExtensionUrl()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", "");
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", url);
    expect(chromeExtensionId()).toBeNull();
    expect(chromeExtensionUrl()).toBe(url);
  });

  it("accepts matching identity independently of slug, query or fragment", () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", id);
    for (const value of [url, url.replace("example-slug", "another-slug"), `${url}?id=${other}#${other}`, `https://chromewebstore.google.com/detail/${id}`]) {
      vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", value);
      expect(chromeExtensionUrl()).toBe(value);
    }
  });

  it("rejects a different item while retaining the explicit runtime routing ID", () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", id);
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", url.replace(id, other));
    expect(chromeExtensionUrl()).toBeNull();
    expect(chromeExtensionId()).toBe(id);
  });

  it("rejects a configured malformed ID even with a valid listing URL", () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", "not-an-id");
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", url);
    expect(chromeExtensionId()).toBeNull();
    expect(chromeExtensionUrl()).toBeNull();
  });

  it.each([
    "not a url", "http://chromewebstore.google.com/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://example.com/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://chromewebstore.google.com/", "https://chromewebstore.google.com/detail/example",
    "https://chromewebstore.google.com/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://chromewebstore.google.com/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaq",
    "https://chromewebstore.google.com/detail/example/xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://chromewebstore.google.com/detail/example/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "https://chromewebstore.google.com/detail/example/%61aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://chromewebstore.google.com/detail/../detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://chromewebstore.google.com/detail/%2e%2e/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://chromewebstore.google.com/detail/example?item=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://chromewebstore.google.com/detail/example#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://chromewebstore.google.com/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/extra",
    "https://user@chromewebstore.google.com/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://chromewebstore.google.com:444/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ])("fails closed for ambiguous or invalid listing %s", (value) => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", id);
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", value);
    expect(chromeExtensionUrl()).toBeNull();
  });
});


describe("exact configured Store ID contract", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const url = `https://chromewebstore.google.com/detail/example/${id}`;

  it("accepts the original canonical ID with URL truly unset or matching", () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", id);
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", undefined);
    expect(chromeExtensionId()).toBe(id);
    expect(chromeExtensionUrl()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", url);
    expect(chromeExtensionUrl()).toBe(url);
  });

  it.each([
    id.toUpperCase(), ` ${id}`, `${id} `, `${id}\n`, `\t${id}`, "   ",
    id.slice(1), `${id}a`, `q${id.slice(1)}`, `%61${id.slice(1)}`,
    `ａ${id.slice(1)}`
  ])("rejects non-canonical original ID %j without repairing it", (value) => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", value);
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", undefined);
    expect(chromeExtensionId()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", url);
    expect(chromeExtensionUrl()).toBeNull();
  });

  it("rejects uppercase and different lowercase URL item IDs", () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", id);
    for (const item of [id.toUpperCase(), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]) {
      vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", url.replace(id, item));
      expect(chromeExtensionUrl()).toBeNull();
      expect(chromeExtensionId()).toBe(id);
    }
  });
});
