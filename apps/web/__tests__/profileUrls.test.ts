import { describe, expect, it } from "vitest";
import {
  isValidOptionalUrl,
  normalizeOptionalProfileUrl
} from "@/lib/profileUrls";

describe("profile URL normalization parity", () => {
  it.each([
    ["cpandey.com", "https://cpandey.com/"],
    [" github.com/cprakash ", "https://github.com/cprakash"],
    ["https://example.com/foo", "https://example.com/foo"],
    ["http://example.com", "http://example.com/"],
    ["", ""],
    ["   ", ""]
  ])("normalizes %j to %j", (raw, canonical) => {
    expect(normalizeOptionalProfileUrl(raw)).toBe(canonical);
    expect(isValidOptionalUrl(raw)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/a",
    "ftp://example.com",
    "://broken",
    "not a url",
    "singleword"
  ])("does not transform unsafe or malformed input %j into an HTTP URL", (raw) => {
    expect(normalizeOptionalProfileUrl(raw)).toBe(raw);
    expect(isValidOptionalUrl(raw)).toBe(false);
  });
});
