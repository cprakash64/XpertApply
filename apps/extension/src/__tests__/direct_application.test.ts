import { describe, expect, it } from "vitest";
import {
  buildDirectPending,
  canonicalDirectUrl,
  directDraftStillMatches,
  judgeApplicationEvidence
} from "../direct/directApplication";

const probe = (labels: string[], rootConfident = true) => ({ rootConfident, applicationLabelsFound: labels });

describe("which pages are applications", () => {
  it("accepts a real custom-careers application (the Waymo form)", () => {
    expect(judgeApplicationEvidence(probe(["first_name", "last_name", "email", "phone", "resume", "cover_letter", "linkedin", "work_authorization"])))
      .toEqual({ eligible: true });
  });

  it.each([
    ["a newsletter signup", ["email"]],
    ["a login form", ["email"]],
    ["a search box", []],
    ["account settings that mention a phone", ["email", "phone"]],
    ["a contact form with a name and e-mail but nothing application-specific", ["first_name", "last_name", "email"]]
  ])("rejects %s", (_name, labels) => {
    expect(judgeApplicationEvidence(probe(labels)).eligible).toBe(false);
  });

  it("rejects a job description that merely names the fields in prose (no confident application root)", () => {
    expect(judgeApplicationEvidence(probe(["first_name", "email", "resume", "submit_application"], false)))
      .toEqual({ eligible: false, reason: "NO_APPLICATION_ROOT" });
  });

  it("rejects missing evidence", () => {
    expect(judgeApplicationEvidence(null).eligible).toBe(false);
  });
});

describe("a direct draft's identity", () => {
  const url = (href: string) => new URL(href);
  const pending = () => buildDirectPending({
    tabId: 4, sessionId: 12, userId: 7, url: url("https://careers.withwaymo.com/jobs/machine-learning-engineer?gh_src=abc#form"),
    atsType: null, now: 1000, ttlMs: 5000, requestId: "r", protocolVersion: 3
  });

  it("is tab-bound, owner-bound, tokenless and free of query strings", () => {
    const p = pending();
    expect(p).toMatchObject({ source: "direct", targetTabId: 4, directUserId: 7, launchToken: "", handoffToken: "" });
    expect(p.applicationUrl).toBe("https://careers.withwaymo.com/jobs/machine-learning-engineer");
    expect(canonicalDirectUrl(url("https://x.example.com/a/b/?token=secret"))).toBe("https://x.example.com/a/b");
  });

  it.each([
    ["the same posting", "https://careers.withwaymo.com/jobs/machine-learning-engineer", true],
    ["its /apply continuation", "https://careers.withwaymo.com/jobs/machine-learning-engineer/apply", true],
    ["a tracking query or SPA step", "https://careers.withwaymo.com/jobs/machine-learning-engineer?step=2", true],
    ["a different posting at the same employer", "https://careers.withwaymo.com/jobs/hardware-technician", false],
    ["another origin entirely", "https://careers.evil.example/jobs/machine-learning-engineer", false]
  ])("%s", (_name, href, expected) => {
    expect(directDraftStillMatches(pending(), url(href))).toBe(expected);
  });

  it("never matches a website launch", () => {
    expect(directDraftStillMatches({ ...pending(), source: undefined }, url("https://careers.withwaymo.com/jobs/machine-learning-engineer"))).toBe(false);
  });
});
