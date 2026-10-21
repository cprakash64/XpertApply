import { describe, expect, it } from "vitest";
import { LEGACY_PRESENCE_PING, PAGE_SOURCE_EXT, PAGE_SOURCE_WEB, parsePageMessage } from "../messages";

/**
 * The deployed site still detects the extension with JOBPILOT_PING. That reply is
 * presence metadata only; nothing the page puts in the ping may be kept or acted on.
 */
describe("legacy presence handshake", () => {
  it("accepts a web-sourced ping and keeps nothing from it", () => {
    const parsed = parsePageMessage({ source: PAGE_SOURCE_WEB, type: LEGACY_PRESENCE_PING, apiBase: "https://evil.example", extra: { a: 1 } });
    expect(parsed).toEqual({ source: PAGE_SOURCE_WEB, type: LEGACY_PRESENCE_PING });
    expect(JSON.stringify(parsed)).not.toContain("evil");
  });

  it("refuses a ping that claims to come from the extension", () => {
    expect(parsePageMessage({ source: PAGE_SOURCE_EXT, type: LEGACY_PRESENCE_PING })).toBeNull();
  });

  it.each([null, undefined, 7, "x", [], { type: LEGACY_PRESENCE_PING }, { source: "other", type: LEGACY_PRESENCE_PING }])(
    "ignores malformed input %#", (raw) => { expect(parsePageMessage(raw)).toBeNull(); });
});
