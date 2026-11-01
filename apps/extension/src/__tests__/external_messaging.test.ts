import { describe, expect, it } from "vitest";
import { isApprovedExternalWebSender } from "../security/externalMessaging";

function sender(origin: string, overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    origin,
    url: `${origin}/login`,
    frameId: 0,
    tab: { id: 7, url: `${origin}/login` },
    ...overrides
  } as chrome.runtime.MessageSender;
}

describe("browser-attributed external Web sender", () => {
  it.each(["https://xpertapply.com", "https://www.xpertapply.com"])(
    "accepts exact production origin %s",
    (origin) => expect(isApprovedExternalWebSender(sender(origin), false)).toBe(true)
  );

  it("permits exact loopback origins only for unpacked development builds", () => {
    expect(isApprovedExternalWebSender(sender("http://localhost:3000"), true)).toBe(true);
    expect(isApprovedExternalWebSender(sender("http://localhost:3001"), true)).toBe(true);
    expect(isApprovedExternalWebSender(sender("http://127.0.0.1:3000"), true)).toBe(true);
    expect(isApprovedExternalWebSender(sender("http://localhost:3000"), false)).toBe(false);
  });

  it.each([
    "https://xpertapply.com.evil.test",
    "https://app.jobpilot.ai",
    "https://ezjobfind.com",
    "https://employer.example.test",
    "https://job-boards.greenhouse.io"
  ])("rejects non-allowlisted origin %s", (origin) => {
    expect(isApprovedExternalWebSender(sender(origin), true)).toBe(false);
  });

  it("negative control: trusting only the existence of sender.origin admits a hostile origin", () => {
    const hostile = sender("https://employer.example.test");
    const weakenedOriginCheck = (candidate: chrome.runtime.MessageSender) => Boolean(candidate.origin);
    expect(weakenedOriginCheck(hostile)).toBe(true);
    expect(isApprovedExternalWebSender(hostile, true)).toBe(false);
  });

  it("rejects inconsistent or non-top-level Chrome sender metadata", () => {
    const valid = sender("https://xpertapply.com");
    expect(isApprovedExternalWebSender({ ...valid, url: "https://evil.test/" }, false)).toBe(false);
    expect(isApprovedExternalWebSender({ ...valid, frameId: 1 }, false)).toBe(false);
    expect(isApprovedExternalWebSender({ ...valid, id: "abcdefghijklmnopabcdefghijklmnop" }, false)).toBe(false);
    expect(isApprovedExternalWebSender({ ...valid, tab: undefined }, false)).toBe(false);
    expect(isApprovedExternalWebSender({ ...valid, origin: undefined }, false)).toBe(false);
  });
});
