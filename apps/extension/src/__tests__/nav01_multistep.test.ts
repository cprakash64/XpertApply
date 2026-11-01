import { describe, expect, it } from "vitest";
import { authorizeFrameForLaunch, currentTopFrameUrl, type SenderContext } from "../security/senderTrust";
import { urlsMatchForHandoff } from "../url";
import type { PendingLaunch } from "../messages";

const sender = (frameUrl: string, tabUrl: string | null): SenderContext => ({
  tabId: 1, frameId: 0, isTopFrame: true, frameUrl: new URL(frameUrl), frameOrigin: new URL(frameUrl), tabUrl
});
const launch = { applicationUrl: "https://careers.example.test/jobs/ml-engineer-scenes?gh_jid=5357" } as unknown as PendingLaunch;

describe("XA-EXT-NAV-01 same-document navigation", () => {
  it("uses the tab's current URL when it is on the sender's own origin", () => {
    const s = sender("https://careers.example.test/jobs/ml-engineer-scenes?gh_jid=5357", "https://careers.example.test/apply/5357");
    expect(currentTopFrameUrl(s)?.pathname).toBe("/apply/5357");
  });
  it("never trusts a tab URL on a different origin than the sender", () => {
    const s = sender("https://careers.example.test/x", "https://evil.example.net/jobs/ml-engineer-scenes");
    expect(currentTopFrameUrl(s)?.origin).toBe("https://careers.example.test");
  });
  it("authorises the top frame after a pushState hop to the same job, and refuses a different job", () => {
    const hop = sender("https://careers.example.test/jobs/ml-engineer-scenes?gh_jid=5357", "https://careers.example.test/jobs/ml-engineer-scenes/apply?gh_jid=5357");
    expect(authorizeFrameForLaunch(hop, launch).ok).toBe(true);
    const other = sender("https://careers.example.test/jobs/ml-engineer-scenes?gh_jid=5357", "https://careers.example.test/jobs/ml-engineer-scenes/apply?gh_jid=9999");
    expect(authorizeFrameForLaunch(other, launch).ok).toBe(false);
  });
});

describe("XA-EXT-NAV-01 job identity", () => {
  const a = "https://careers.example.test/jobs/software-engineer-planning";
  it("does not equate two jobs that only share a generic title word", () => {
    expect(urlsMatchForHandoff(a, "https://careers.example.test/jobs/software-engineer-perception/apply")).toBe(false);
  });
  it("accepts the apply sub-path of the same job", () => {
    expect(urlsMatchForHandoff(a, `${a}/apply`)).toBe(true);
  });
  it("trusts an explicit job id over path similarity", () => {
    expect(urlsMatchForHandoff(`${a}?gh_jid=1111`, `${a}/apply?gh_jid=2222`)).toBe(false);
    expect(urlsMatchForHandoff(`${a}?gh_jid=1111`, "https://careers.example.test/apply/1111?gh_jid=1111")).toBe(true);
  });
});
