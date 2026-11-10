import { describe, expect, it } from "vitest";
import { atsJobIdentity, urlsMatchForHandoff } from "../url";

const L1 = "https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111/apply";
const L2 = "https://jobs.lever.co/acme/22222222-2222-2222-2222-222222222222/apply";

describe("EXT-LIVE-08 hosted-ATS identity: a shared employer slug or hostname is not the same application", () => {
  it("Lever", () => {
    expect(urlsMatchForHandoff(L1, L2)).toBe(false);                 // the P0: same company, different job
    expect(urlsMatchForHandoff(L1, L1)).toBe(true);
    expect(urlsMatchForHandoff(L1.replace("/apply", ""), L1)).toBe(true);
    expect(urlsMatchForHandoff(L1, "https://jobs.lever.co/acme")).toBe(false);   // board index names no job
    expect(atsJobIdentity(L1)).toBe(atsJobIdentity(L1.toUpperCase().replace("HTTPS", "https")));
  });
  it("Ashby", () => {
    const a = "https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/application";
    const b = "https://jobs.ashbyhq.com/acme/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/application";
    expect(urlsMatchForHandoff(a, b)).toBe(false);
    expect(urlsMatchForHandoff(a, a.replace("/application", ""))).toBe(true);
  });
  it("Greenhouse (path id and gh_jid)", () => {
    expect(urlsMatchForHandoff("https://job-boards.greenhouse.io/acme/jobs/4001", "https://job-boards.greenhouse.io/acme/jobs/4002")).toBe(false);
    expect(urlsMatchForHandoff("https://job-boards.greenhouse.io/acme/jobs/4001", "https://job-boards.greenhouse.io/acme/jobs/4001")).toBe(true);
    expect(urlsMatchForHandoff("https://boards.greenhouse.io/embed/job_app?for=acme&token=4001", "https://boards.greenhouse.io/embed/job_app?for=acme&token=4002")).toBe(false);
  });
  it("Workday: the posting segment is identity, locale and apply steps are not", () => {
    const a = "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Phoenix/Engineer_JR1/apply/applyManually";
    expect(urlsMatchForHandoff(a, "https://acme.wd5.myworkdayjobs.com/Careers/job/Phoenix/Engineer_JR1/apply")).toBe(true);
    expect(urlsMatchForHandoff(a, "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Phoenix/Engineer_JR2/apply")).toBe(false);
    expect(urlsMatchForHandoff(a, "https://acme.wd5.myworkdayjobs.com/en-US/Careers")).toBe(false);
  });
});
